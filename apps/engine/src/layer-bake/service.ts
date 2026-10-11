// Layer bake service (M2, S11 §6, LBK-003…005/010/020…026): plans and renders the cached alpha masters of DOM
// layers (text, shapes, anime templates) and their graded variants.
//
//   <appdir>/cache/layers/<key>/
//     master.mov    ProRes 4444 yuva444p10le, straight alpha, BT.709 — the drawn span (non-static layers)
//     still.png     one straight-alpha PNG (static layers, LBK-004; single frames of stills, LBK-025)
//     graded/       graded entries: the bake + the clip's colour runs (lut3d) (+ the fades of a still) as straight-
//                   alpha PNG frames `000000.png …` — Remotion path (LBK-010), served as `graded.png?n=<frame>`
//     preview.webm  graded entries: VP9 alpha at half size — the Program preview of a graded DOM layer
//     meta.json     {key, recipe, rect, frames, …, lastUsedAt}; GC removes entries unused for 14 days (LBK-021)
//
// Renders run in `layer-bake` jobs (child jobs of the export/still, 0 CPU slots of their own: their Remotion pages are
// a share of the export's page budget, LBK-022) through `RemotionService.renderAlphaMaster` / `renderStill`; the bakes
// of one export run side by side (`extension.ts`, `remotion/page-pool.ts`), optionally in one shared render browser
// per export, and a bake already being rendered for another export (or another clip) is joined, not rendered twice.
// Every render is logged for licence reporting (LBK-026).
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineJob } from '@jasper/api';
import {
	contentTimeAt,
	interpretMediaHandle,
	type MediaAsset,
	type MediaHandle,
	mediaDecodeHints,
	type RenderSnapshot,
	type RenderTransition,
	type RenderVisualClip,
	resolveLayerProps,
	transitionSpec,
} from '@jasper/project';
import { quoteFilterPath } from '../color/extension.ts';
import { colorRunFilters, fadeFilters, SWS_FLAGS } from '../export/native.ts';
import type { NativeExtension } from '../export/native-ext.ts';
import { mediaKeyOf, type PlannedExport } from '../export/planner.ts';
import { importsArtifactsOf, withImportsUrls } from '../imports/extension.ts';
import type { JobContext } from '../jobs/types.ts';
import { JobError } from '../jobs/types.ts';
import type { MediaRecord } from '../media/registry.ts';
import { REMOTION_VERSION, type SharedRenderBrowser } from '../remotion/service.ts';
import { Ffmpeg, sec } from '../tools/ffmpeg.ts';
import { atomicWriteJson, readJsonOrNull } from '../tools/fs.ts';
import { binaryNames } from '../tools/lgpl.ts';
import type { CoreServices } from '../tools/services.ts';
import {
	type BakeEnvironment,
	expressionKeyPart,
	FileHashCache,
	KEY_RE,
	type KeyFont,
	type KeyMaterial,
	type KeyMedia,
	keyOf,
	LAYER_BAKE_VERSION,
	normalisedClip,
	templateRenderVersion,
} from './key.ts';
import {
	type BakeVariant,
	bakeClip,
	bakeDoc,
	clipFonts,
	cropRect,
	drawnSpan,
	hasColorEffects,
	isColorEffect,
	isStaticLayer,
	type Rect,
	referencedMediaIds,
	variantFrames,
} from './layer.ts';

/**
 * Version of the graded entries' recipe (bumped when graded pixels change for the same inputs). 2: graded stills
 * carry the transition fades; the Remotion-path master is a PNG frame sequence (alpha honoured).
 */
const GRADE_VERSION = 2;
/** Directory of a graded entry's PNG frames (Remotion path). */
const GRADED_FRAMES_DIR = 'graded';
/** File name of graded frame `n`. */
const gradedFrameName = (n: number) => `${String(n).padStart(6, '0')}.png`;
/** Border alpha (0…255) above which a cropped bake counts as clipped and is rendered full frame instead. */
const RECT_CLIP_ALPHA = 2;

/**
 * Engine-relative URL of a cache file (served by `GET /mg/layers/:key/:file`, signable for renders). `graded.png`
 * is the graded frame sequence: one signed URL for the entry, the frame chosen by `n` (`&n=<frame>`).
 */
export const layerFileUrl = (key: string, file: string) => `/mg/layers/${key}/${file}`;
const LAYER_FILES: ReadonlySet<string> = new Set(['master.mov', 'still.png', 'graded.png', 'preview.webm']);

export type LayerMeta = {
	kind: 'layer';
	key: string;
	recipe: BakeVariant['recipe'] | 'graded';
	/** The region the files cover (null = the whole frame); may differ from the planned rect (clip fallback). */
	rect: Rect | null;
	/** Frames of the render (span; 1 for stills). */
	frames: number;
	width: number;
	height: number;
	clipName: string;
	createdAt: string;
	lastUsedAt: string;
	/** Graded entries: the ungraded bake they were made from. */
	source?: string;
	material: unknown;
};

/** A planned bake of one clip (S11:LBK-003/004): its key, render document and what the override needs. */
export type BakePlan = {
	clipId: string;
	clipName: string;
	key: string;
	variant: BakeVariant;
	/** Planned crop (LBK-005); the cache may record a full-frame fallback. */
	rect: Rect | null;
	/** Render document (signed URLs) of the cropped clip, and of the uncropped clip when `rect` is set. */
	doc: RenderSnapshot;
	fullDoc: RenderSnapshot | null;
	frames: number;
	/** Sequence frame shown by the bake's frame 0 (the span start; the frame itself for single frames). */
	startFrame: number;
	/** The clip has colour effects that ffmpeg applies (LBK-010). */
	colorRuns: boolean;
	material: KeyMaterial;
	/**
	 * wave1c: the bake of a GPU transition's span (`clipId` = the transition id): the render draws the track's sides
	 * and the transition stage (no layer filter).
	 */
	span?: boolean;
};

/** A graded entry (Remotion path / preview, LBK-010): bake + colour runs. */
export type GradePlan = {
	key: string;
	source: { key: string; recipe: BakeVariant['recipe'] };
	/**
	 * ffmpeg filters over the bake's frames (`n` counts from its frame 0): the colour runs, then — for a static
	 * still — the transition fades (masters and single frames have them baked in).
	 */
	filters: string[];
	frames: number;
	fps: { num: number; den: number };
	material: KeyMaterial;
};

export type BakeResult = {
	key: string;
	path: string;
	still: boolean;
	rect: Rect | null;
	frames: number;
	width: number;
	height: number;
};

/**
 * `concurrency` = the Remotion pages granted to this bake (a share of the parent's page budget); `browserGroup` = the
 * parent job whose shared render browser the bake uses (absent / closed: a browser of its own).
 */
export type LayerBakeJobInput =
	| { op: 'bake'; bake: BakePlan; concurrency?: number; browserGroup?: string }
	| {
			op: 'grade';
			bake: BakePlan;
			grade: GradePlan;
			outputs: ('graded' | 'preview')[];
			concurrency?: number;
			browserGroup?: string;
	  };

/** What `ensureBake` / `ensureGraded` need from the export/still that asks (S11:LBK-022). */
export type EnsureMeta = {
	parentId: string;
	projectId?: string;
	signal: AbortSignal;
	/** Remotion pages of this bake. */
	concurrency?: number;
	/** Render in the shared browser of this group (`browserSession`). */
	browserGroup?: string;
	/** Progress of the bake (0…1), also when it is shared with another export. */
	onProgress?(p: number): void;
};

/**
 * How the bakes of one export are run (S11:LBK-022). `maxInFlight`: bakes at the same time (null = automatic:
 * `min(page budget, MAX_RENDERS_IN_FLIGHT)`; 1 = one after the other, each with the whole budget, as before).
 * `sharedBrowser`: the bakes of an export render in one browser instead of one each.
 */
export type BakeParallelism = { maxInFlight: number | null; sharedBrowser: boolean };

/** Defaults; `JASPER_LAYER_BAKE_PARALLEL` (bakes in flight) and `JASPER_LAYER_BAKE_SHARED_BROWSER` (0/1) override. */
export function bakeParallelismFromEnv(env: Record<string, string | undefined>): BakeParallelism {
	const n = Number(env.JASPER_LAYER_BAKE_PARALLEL);
	const shared = env.JASPER_LAYER_BAKE_SHARED_BROWSER;
	return {
		maxInFlight: Number.isInteger(n) && n >= 1 ? n : null,
		sharedBrowser: shared !== '0',
	};
}

/** Progress poll of a running child job (the parent aggregates it). */
const PROGRESS_POLL_MS = 250;

export type LayerBakePreviewResult = {
	key: string;
	sourceKey: string;
	previewUrl: string;
	/** Sequence frame shown by the preview's frame 0 at the time of the request (the clip's span start). */
	startFrame: number;
	durationFrames: number;
	rect: Rect | null;
	width: number;
	height: number;
};

type LayerBakeOptions = {
	core: CoreServices;
	log?(msg: string): void;
	now?: () => Date;
	parallelism?: Partial<BakeParallelism>;
};

/** A bake or graded entry being rendered by a child job (joined by every other caller that needs it). */
type InFlight = { jobId: string; done: Promise<void> };

const GL_PROBE_TIMEOUT_MS = 60_000;

export class LayerBakeService {
	readonly dir: string;
	private readonly hashes = new FileHashCache();
	private readonly now: () => Date;
	private offCache: (() => void) | null = null;
	private bytes = 0;
	private bytesPending: Promise<void> | null = null;
	/** Keys read by running jobs (lease count): the GC never removes them (S11:LBK-021). */
	private readonly leases = new Map<string, number>();
	/** Entries the GC is removing right now: lookups wait for the removal and miss. */
	private readonly removing = new Map<string, Promise<void>>();
	/** Entries rendered right now, by key: a second caller joins the running child job (S11:LBK-022 dedupe). */
	private readonly inflight = new Map<string, InFlight>();
	/** Shared render browsers by group (the export/still job id), opened on first use. */
	private readonly sessions = new Map<
		string,
		{ refs: number; browser: Promise<SharedRenderBrowser | null> | null }
	>();
	/**
	 * Bakes rendered / reused / joined (rendered for another caller at the same time) since start.
	 */
	readonly stats = { rendered: 0, reused: 0, joined: 0 };
	/** How the bakes of an export run. */
	parallelism: BakeParallelism;

	constructor(private readonly o: LayerBakeOptions) {
		this.dir = join(o.core.config.paths.cacheDir, 'layers');
		this.now = o.now ?? (() => new Date());
		this.parallelism = { ...bakeParallelismFromEnv({}), ...o.parallelism };
	}

	private get core(): CoreServices {
		return this.o.core;
	}

	/** Every registered native extension (the graded variants ask the colour extension for its filters). */
	extensions(): readonly NativeExtension[] {
		return this.core.exports.nativeExtensions.all();
	}

	/** Why bakes cannot run here (null = they can). `needs-browser-download` counts as ready. */
	unavailableReason(): string | null {
		const r = this.core.remotion;
		if (!r.binaries.allowed)
			return r.binaries.message ?? 'Remotion rendering is disabled (no LGPL FFmpeg binaries directory)';
		if (r.state() === 'unavailable') return 'The Remotion renderer is not available on this engine';
		return null;
	}

	capability(): { state: 'ready' | 'unavailable'; reason?: string; cacheBytes: number } {
		const reason = this.unavailableReason();
		void this.refreshBytes();
		return reason
			? { state: 'unavailable', reason, cacheBytes: this.bytes }
			: { state: 'ready', cacheBytes: this.bytes };
	}

	/** Recomputes the cache size in the background (at most one walk at a time). */
	refreshBytes(): Promise<void> {
		this.bytesPending ??= (async () => {
			let total = 0;
			for (const name of await readdir(this.dir).catch(() => [] as string[])) {
				if (!KEY_RE.test(name)) continue;
				for (const f of await readdir(join(this.dir, name)).catch(() => [] as string[])) {
					const p = join(this.dir, name, f);
					const files =
						f === GRADED_FRAMES_DIR
							? (await readdir(p).catch(() => [] as string[])).map((g) => join(p, g))
							: [p];
					for (const file of files)
						total += await stat(file)
							.then((s) => s.size)
							.catch(() => 0);
				}
			}
			this.bytes = total;
		})().finally(() => {
			this.bytesPending = null;
		});
		return this.bytesPending;
	}

	registerRunners(): void {
		this.core.queue.registerRunner('layer-bake', (ctx) => this.run(ctx));
	}

	async start(): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		// The cache registry keeps leased and in-flight entries. Lookups wait for its removals and then miss.
		this.offCache = this.core.cache.registerAdapter('layers', {
			busy: (key) => this.leases.has(key) || this.inflight.has(key),
			remove: (key, remove) => {
				const p = remove();
				const done = p
					.then(
						() => undefined,
						() => undefined,
					)
					.finally(() => this.removing.delete(key));
				this.removing.set(key, done);
				return p.finally(() => void this.refreshBytes());
			},
		});
	}

	stop(): void {
		this.offCache?.();
		this.offCache = null;
	}

	/**
	 * Holds cache entries against the GC while a job reads them (lease count per key); returns the release
	 * (idempotent). Take it before the lookup so that no removal can start in between.
	 */
	lease(keys: readonly string[]): () => void {
		for (const k of keys) this.leases.set(k, (this.leases.get(k) ?? 0) + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			for (const k of keys) {
				const n = (this.leases.get(k) ?? 1) - 1;
				if (n > 0) this.leases.set(k, n);
				else this.leases.delete(k);
			}
		};
	}

	/** Holds `keys` until job `jobId` (the export/still that reads them) has finished. */
	private leaseUntilDone(keys: readonly string[], jobId: string): void {
		const release = this.lease(keys);
		this.core.queue
			.wait(jobId)
			.catch(() => undefined)
			.finally(release);
	}

	private entryDir(key: string): string {
		return join(this.dir, key);
	}

	/**
	 * Absolute path of a cache file (validated key and file name), or null when missing. `graded.png` = frame `n` of
	 * the graded frame sequence.
	 */
	filePath(key: string, file: string, n = 0): string | null {
		if (!KEY_RE.test(key) || !LAYER_FILES.has(file)) return null;
		if (file === 'graded.png') {
			if (!Number.isInteger(n) || n < 0) return null;
			const f = join(this.entryDir(key), GRADED_FRAMES_DIR, gradedFrameName(n));
			return existsSync(f) ? f : null;
		}
		const p = join(this.entryDir(key), file);
		return existsSync(p) ? p : null;
	}

	/** The complete graded frame sequence of an entry (renamed into place as a whole), or null. */
	private gradedDir(key: string): string | null {
		const p = join(this.entryDir(key), GRADED_FRAMES_DIR);
		return KEY_RE.test(key) && existsSync(p) ? p : null;
	}

	async meta(key: string): Promise<LayerMeta | null> {
		if (!KEY_RE.test(key)) return null;
		const m = await readJsonOrNull<LayerMeta>(join(this.entryDir(key), 'meta.json'));
		return m?.kind === 'layer' ? m : null;
	}

	/**
	 * The cached bake of a key (files present), marked as used (awaited: the GC sees the new `lastUsedAt`); null on
	 * a miss. Waits for a GC removal of the entry in progress (then misses).
	 */
	async lookup(key: string): Promise<BakeResult | null> {
		await this.removing.get(key);
		const meta = await this.meta(key);
		if (!meta || meta.recipe === 'graded') return null;
		const still = meta.recipe !== 'master';
		const file = still ? 'still.png' : 'master.mov';
		if (!this.filePath(key, file)) return null;
		await this.markUsed(key, meta);
		const path = this.removing.has(key) ? null : this.filePath(key, file);
		if (!path) return null;
		return { key, path, still, rect: meta.rect, frames: meta.frames, width: meta.width, height: meta.height };
	}

	private async markUsed(key: string, meta: LayerMeta): Promise<void> {
		this.core.cache.touch(this.entryDir(key));
		await atomicWriteJson(join(this.entryDir(key), 'meta.json'), {
			...meta,
			lastUsedAt: this.now().toISOString(),
		}).catch(() => undefined);
	}

	/** Render environment (part of every key). Probes the render browser's GL once (it may launch Chrome). */
	async environment(): Promise<BakeEnvironment> {
		const r = this.core.remotion;
		const gl = await Promise.race([
			r.renderGl(),
			new Promise<string>((res) => setTimeout(() => res('unknown'), GL_PROBE_TIMEOUT_MS).unref()),
		]);
		return {
			bundleId: r.bundleId(),
			animejs: r.animejsVersion(),
			remotion: REMOTION_VERSION,
			browser: r.browserIdentity(),
			gl,
		};
	}

	/**
	 * parity (roto): the clip with signed absolute URLs of its object-matte sets (the headless browser loads them).
	 * Key material keeps the unsigned paths.
	 */
	private signedRotos(c: RenderVisualClip): RenderVisualClip {
		let out = c;
		if (c.rotos) {
			const rotos: NonNullable<RenderVisualClip['rotos']> = {};
			for (const [id, m] of Object.entries(c.rotos))
				rotos[id] = {
					...m,
					url: m.url?.startsWith('/') ? this.core.signer.signUrl(this.core.origin(), m.url) : m.url,
				};
			out = { ...out, rotos };
		}
		// Nested sequences draw their own clips (and object mattes) inside the bake.
		if ('nest' in c.source) {
			const n = c.source.nest;
			out = {
				...out,
				source: {
					nest: {
						...n,
						snapshot: {
							...n.snapshot,
							videoTracks: n.snapshot.videoTracks.map((t) => ({
								...t,
								clips: t.clips.map((x) => this.signedRotos(x)),
							})),
						},
					},
				},
			};
		}
		return out;
	}

	/** Media handle with a signed engine URL (what the headless browser loads). */
	private signedHandle(planned: Pick<PlannedExport, 'document' | 'media'>, id: string): MediaHandle | null {
		const local = planned.media[id];
		const asset = planned.document.media[id];
		const key = asset ? mediaKeyOf(asset) : null;
		if (!local || !asset || !key) return null;
		const r = local.record;
		// imports: interpreted size / pixels / time, Lottie and vector loaders, display pictures and masters prepared by
		// the `imports` extension for this export.
		const sign = (p: string) => this.core.signer.signUrl(this.core.origin(), p);
		return withImportsUrls(
			interpretMediaHandle(asset, this.rawSignedHandle(key, asset, r)),
			importsArtifactsOf(planned)?.get(id),
			sign,
		);
	}

	private rawSignedHandle(key: string, asset: MediaAsset, r: MediaRecord): MediaHandle {
		return {
			url: this.core.signer.signUrl(this.core.origin(), `/media/${encodeURIComponent(key)}`),
			proxyUrl: null,
			kind: asset.kind,
			width: r.display?.width ?? null,
			height: r.display?.height ?? null,
			durationFlicks: r.probe.durationFlicks,
			hasAudio: r.hasAudio,
			rotation: r.probe.rotationDegrees,
			...mediaDecodeHints(r.probe),
		};
	}

	private keyMedia(planned: Pick<PlannedExport, 'document' | 'media'>, ids: Iterable<string>): KeyMedia[] {
		return [...ids].sort().map((mediaId) => {
			const local = planned.media[mediaId];
			const asset = planned.document.media[mediaId];
			const interp =
				asset?.interpretation || asset?.vector
					? JSON.stringify({ i: asset.interpretation ?? null, p: asset.vector?.page ?? null })
					: null;
			return {
				mediaId,
				fingerprint: local?.record.fingerprint ?? asset?.fingerprint ?? null,
				size: local?.record.sizeBytes ?? null,
				mtime: local ? Math.round(local.record.mtimeMs) : null,
				...(interp ? { interp } : {}),
			};
		});
	}

	private async keyFonts(fonts: RenderSnapshot['fonts']): Promise<KeyFont[]> {
		const out: KeyFont[] = [];
		for (const f of fonts) {
			const file = f.url.startsWith('/fonts/')
				? this.core.fonts.filePath(f.url.slice('/fonts/'.length))
				: null;
			out.push({
				family: f.family,
				weight: f.weight,
				style: f.style,
				fileSha256: await this.hashes.hash(file),
			});
		}
		return out.sort((a, b) =>
			`${a.family}|${a.weight}|${a.style}`.localeCompare(`${b.family}|${b.weight}|${b.style}`),
		);
	}

	/**
	 * Plans the bake of `clip` (a DOM layer of `planned.snapshot`). `frame` = a single sequence frame (stills):
	 * a static layer still uses its whole-span still; a non-static one its cached master when present, else a
	 * one-frame bake. `stripColor`: colour effects are left to ffmpeg (always, LBK-010).
	 */
	async planBake(
		planned: Pick<PlannedExport, 'document' | 'media' | 'snapshot'>,
		clip: RenderVisualClip,
		o: { env: BakeEnvironment; frame?: number | null },
	): Promise<BakePlan> {
		const asBaked = bakeClip(clip, { variant: { recipe: 'master' }, stripColor: true });
		const isStatic = isStaticLayer(asBaked);
		const span = drawnSpan(clip);
		const full = await this.plan(planned, clip, isStatic ? { recipe: 'still' } : { recipe: 'master' }, o.env);
		if (o.frame === undefined || o.frame === null || isStatic) return full;
		if (await this.lookup(full.key)) return full;
		return this.plan(planned, clip, { recipe: 'frame', frame: o.frame - span.start }, o.env);
	}

	private async plan(
		planned: Pick<PlannedExport, 'document' | 'media' | 'snapshot'>,
		clip: RenderVisualClip,
		variant: BakeVariant,
		env: BakeEnvironment,
	): Promise<BakePlan> {
		const snap = planned.snapshot;
		const seq = snap.settings;
		const span = drawnSpan(clip);
		const frames = variantFrames(clip, variant);
		const f0 = variant.recipe === 'frame' ? span.start + variant.frame : span.start;
		const f1 = variant.recipe === 'master' ? span.end : f0 + 1;
		const unshifted = bakeClip(clip, { variant, stripColor: true });
		const rect = cropRect(clip, { f0, f1 }, { width: seq.width, height: seq.height, fps: seq.fps });
		const shiftedClip = rect ? bakeClip(clip, { variant, stripColor: true, shift: rect }) : unshifted;
		const fonts = clipFonts(unshifted, snap.fonts);
		const mediaIds = referencedMediaIds([unshifted.source, unshifted.effects]);
		const media: RenderSnapshot['media'] = {};
		for (const id of mediaIds) media[id] = this.signedHandle(planned, id);
		const signedFonts = fonts.map((f) => ({
			...f,
			url: f.url.startsWith('/') ? this.core.signer.signUrl(this.core.origin(), f.url) : f.url,
		}));
		const material: KeyMaterial = {
			v: LAYER_BAKE_VERSION,
			recipe: variant.recipe,
			...(variant.recipe === 'frame' ? { frame: variant.frame } : {}),
			clip: normalisedClip(unshifted),
			span: frames,
			width: seq.width,
			height: seq.height,
			fps: { num: seq.fps.num, den: seq.fps.den },
			fonts: await this.keyFonts(fonts),
			media: this.keyMedia(planned, mediaIds),
			bundleId: env.bundleId,
			animejs: env.animejs,
			remotion: env.remotion,
			browser: env.browser,
			gl: env.gl,
			still: variant.recipe !== 'master',
			rect,
			...(clip.kind === 'motion-graphic' ? { renderVersion: templateRenderVersion(clip) } : {}),
			...(() => {
				const e = expressionKeyPart(clip, snap.expressions);
				// The clip's sequence position matters too (`time` is sequence time).
				return e ? { expressions: `${e}:${clip.start}` } : {};
			})(),
			graded: false,
		};
		const docOf = (c: RenderVisualClip, r: Rect | null) =>
			bakeDoc(snap, this.signedRotos(c), { variant, rect: r, media, fonts: signedFonts });
		return {
			clipId: clip.clipId,
			clipName: clip.name,
			key: keyOf(material),
			variant,
			rect,
			doc: docOf(shiftedClip, rect),
			fullDoc: rect ? docOf(unshifted, null) : null,
			frames,
			startFrame: f0,
			colorRuns: hasColorEffects(clip),
			material,
		};
	}

	/**
	 * wave1c — plans the bake of a GPU transition's span: the sides A and B of track `trackId` (whole clips, handles,
	 * every enabled effect) and the transition stage, over `[t.start, t.start + t.duration)` on a transparent
	 * background — what the composition draws for that track there. Times are shifted so the span starts at frame 0
	 * (moving the cut keeps the render); `frame` = one sequence frame (stills).
	 */
	async planSpan(
		planned: Pick<PlannedExport, 'document' | 'media' | 'snapshot'>,
		trackId: string,
		t: RenderTransition,
		o: { env: BakeEnvironment; frame?: number | null },
	): Promise<BakePlan> {
		const snap = planned.snapshot;
		const seq = snap.settings;
		const track = snap.videoTracks.find((x) => x.trackId === trackId);
		if (!track)
			throw new JobError('LAYER_BAKE_FAILED', `Track ${trackId} of transition ${t.id} not found`, false);
		const sideIds = new Set([t.outgoingClipId, t.incomingClipId].filter((x): x is string => !!x));
		const shift = t.start;
		const sides = track.clips
			.filter((c) => sideIds.has(c.clipId))
			.map((c): RenderVisualClip => {
				const effects = c.effects.filter((fx) => fx.enabled);
				return {
					...c,
					effects,
					start: c.start - shift,
					...(c.fades?.length ? { fades: c.fades.map((f) => ({ ...f, start: f.start - shift })) } : {}),
				};
			});
		const shifted: RenderTransition = { ...t, start: 0 };
		const single = o.frame !== undefined && o.frame !== null;
		const variant: BakeVariant = single
			? { recipe: 'frame', frame: o.frame! - t.start }
			: { recipe: 'master' };
		const frames = single ? 1 : t.duration;
		const start = single ? o.frame! - t.start : 0;
		const fonts = sides.flatMap((c) => clipFonts(c, snap.fonts));
		const uniqueFonts = [...new Set(fonts)];
		const mediaIds = referencedMediaIds([sides.map((c) => [c.source, c.effects]), t.params]);
		const media: RenderSnapshot['media'] = {};
		for (const id of mediaIds) media[id] = this.signedHandle(planned, id);
		const signedFonts = uniqueFonts.map((f) => ({
			...f,
			url: f.url.startsWith('/') ? this.core.signer.signUrl(this.core.origin(), f.url) : f.url,
		}));
		const material: KeyMaterial = {
			v: LAYER_BAKE_VERSION,
			recipe: variant.recipe,
			...(single ? { frame: start } : {}),
			clip: { span: { transition: shifted, sides: sides.map(({ name: _n, ...c }) => c) } },
			span: frames,
			width: seq.width,
			height: seq.height,
			fps: { num: seq.fps.num, den: seq.fps.den },
			fonts: await this.keyFonts(uniqueFonts),
			media: this.keyMedia(planned, mediaIds),
			bundleId: o.env.bundleId,
			animejs: o.env.animejs,
			remotion: o.env.remotion,
			browser: o.env.browser,
			gl: o.env.gl,
			still: single,
			rect: null,
			graded: false,
		};
		const doc: RenderSnapshot = {
			version: 1,
			sequenceId: snap.sequenceId,
			settings: { ...seq, backgroundColor: [0, 0, 0, 0] },
			range: { start, end: start + frames },
			durationFrames: frames,
			videoTracks: [{ trackId, clips: sides.map((c) => this.signedRotos(c)), transitions: [shifted] }],
			audioClips: [],
			media,
			fonts: signedFonts,
			master: { volumeDb: { value: 0, keyframes: [] } },
			warnings: [],
		};
		return {
			clipId: t.id,
			clipName: `${transitionSpec(t.effectId)?.label ?? t.effectId} transition`,
			key: keyOf(material),
			variant,
			rect: null,
			doc,
			fullDoc: null,
			frames,
			startFrame: single ? o.frame! : t.start,
			colorRuns: false,
			material,
			span: true,
		};
	}

	/**
	 * Plans the graded entry of a bake (LBK-010): the clip's colour runs as ffmpeg filters over the bake's frames,
	 * produced by the extensions that realise colour effects (the colour extension's `prepare` + `effectFilter`,
	 * run on a one-clip export of the bake's frames).
	 */
	async planGrade(
		planned: PlannedExport,
		clip: RenderVisualClip,
		bake: BakePlan,
		ctx: {
			extensions: readonly NativeExtension[];
			signal: AbortSignal;
			scratchDir(): Promise<string>;
			log(t: string): void;
			jobId: string;
		},
	): Promise<GradePlan> {
		const span = drawnSpan(clip);
		const f0 = bake.startFrame;
		const frames = bake.variant.recipe === 'still' ? span.end - span.start : bake.frames;
		// A one-clip export over the frames of the graded output: the clip keeps its timing (content time), the
		// range is the graded span; windows are counted from its first frame.
		const range = { start: f0, end: f0 + frames };
		const local: PlannedExport = {
			...planned,
			range,
			snapshot: {
				...planned.snapshot,
				range,
				durationFrames: frames,
				videoTracks: [{ trackId: clip.trackId, clips: [clip] }],
				audioClips: [],
			},
		};
		const exts = ctx.extensions.filter((e) => e.id !== 'layer-bake' && e.effectFilter);
		const prepared = new Map<string, unknown>();
		for (const ext of exts) {
			if (!ext.prepare) continue;
			prepared.set(
				ext.id,
				await ext.prepare(local, {
					signal: ctx.signal,
					stage: () => undefined,
					scratchDir: ctx.scratchDir,
					log: ctx.log,
					jobId: ctx.jobId,
					extensions: exts,
					preparedSoFar: prepared,
				}),
			);
		}
		const props = resolveLayerProps(clip, contentTimeAt(clip, f0, planned.snapshot.settings.fps));
		const filters = colorRunFilters({
			clip,
			props,
			box: {
				width: bake.rect?.w ?? planned.snapshot.settings.width,
				height: bake.rect?.h ?? planned.snapshot.settings.height,
			},
			fps: planned.snapshot.settings.fps,
			f0,
			f1: f0 + frames,
			extensions: { list: exts, prepared },
		});
		// The graded picture is the whole placed layer, like the masters (S11:LBK-010): masters and single frames
		// carry the transition fades, a static still does not (the native builder fades it), so its graded span gets
		// them here — the Remotion path and the Program preview play graded files as they are.
		const fades = bake.variant.recipe === 'still' ? fadeFilters(clip.fades, f0) : [];
		const colorFx = clip.effects
			.filter((fx) => fx.enabled && isColorEffect(fx))
			.map(({ id: _id, ...fx }) => fx);
		const luts = this.keyMedia(planned, referencedMediaIds(colorFx));
		const material: KeyMaterial = {
			...bake.material,
			span: frames,
			// The grade's keyframes run in content time, and graded stills get the fades: the clip's real timing
			// relative to the graded frames matters (a still bake's clip is a one-frame clip without handles or fades;
			// reversed clips map frames to content time through their duration).
			clip: {
				...bake.material.clip,
				gradeStart: clip.start - f0,
				duration: clip.duration,
				headHandle: clip.headHandle ?? 0,
				tailHandle: clip.tailHandle ?? 0,
				fades: (clip.fades ?? []).map((f) => ({ ...f, start: f.start - f0 })),
				sourceIn: clip.sourceIn,
				speed: clip.speed,
			},
			graded: { v: GRADE_VERSION, source: bake.key, effects: colorFx, luts },
		};
		return {
			key: keyOf(material),
			source: { key: bake.key, recipe: bake.variant.recipe },
			filters: fades.length ? [...filters, ...fades, 'setpts=PTS-STARTPTS'] : filters,
			frames,
			fps: { num: planned.snapshot.settings.fps.num, den: planned.snapshot.settings.fps.den },
			material,
		};
	}

	/**
	 * Returns the bake of `plan`, rendering it in a child job of `parentId` when not cached. When another caller (another
	 * export, or another clip of this one) is rendering the same key right now, joins that render instead (and renders
	 * it itself when that render is cancelled). Throws a JobError when the bake fails.
	 */
	async ensureBake(plan: BakePlan, meta: EnsureMeta): Promise<BakeResult> {
		// The export reads the bake until it finishes: held against the GC from before the lookup.
		this.leaseUntilDone([plan.key], meta.parentId);
		const done = await this.ensureEntry(
			plan.key,
			async () => {
				const hit = await this.lookup(plan.key);
				if (hit) this.stats.reused++;
				return hit;
			},
			() => this.lookup(plan.key),
			{ op: 'bake', bake: plan, ...this.childOptions(meta) },
			plan,
			meta,
		);
		if (!done) throw new JobError('LAYER_BAKE_FAILED', `The bake of "${plan.clipName}" is missing`, true);
		return done;
	}

	/** The graded master (frame sequence, `graded/`) of a planned grade, rendered in a child job when missing. */
	async ensureGraded(
		bake: BakePlan,
		grade: GradePlan,
		meta: EnsureMeta,
	): Promise<{ key: string; path: string; rect: Rect | null }> {
		this.leaseUntilDone([grade.key, bake.key], meta.parentId);
		const cachedGrade = async () => {
			await this.removing.get(grade.key);
			const cached = this.gradedDir(grade.key);
			const m = cached ? await this.meta(grade.key) : null;
			if (!cached || !m) return null;
			await this.markUsed(grade.key, m);
			return this.gradedDir(grade.key) ? { key: grade.key, path: cached, rect: m.rect } : null;
		};
		const done = await this.ensureEntry(
			grade.key,
			cachedGrade,
			cachedGrade,
			{ op: 'grade', bake, grade, outputs: ['graded'], ...this.childOptions(meta) },
			bake,
			meta,
		);
		if (!done)
			throw new JobError('LAYER_BAKE_FAILED', `The graded master of "${bake.clipName}" is missing`, true);
		return done;
	}

	private childOptions(meta: EnsureMeta): { concurrency?: number; browserGroup?: string } {
		return {
			...(meta.concurrency ? { concurrency: meta.concurrency } : {}),
			...(meta.browserGroup ? { browserGroup: meta.browserGroup } : {}),
		};
	}

	/**
	 * Cache hit → it; else joins the render of `key` in flight, or renders it in a child job (registered in flight
	 * with no await between the check and the registration, so concurrent callers render a key once). `cached` is
	 * the first lookup (counts reuse), `after` the lookup once a render finished.
	 */
	private async ensureEntry<R>(
		key: string,
		cached: () => Promise<R | null>,
		after: () => Promise<R | null>,
		input: LayerBakeJobInput,
		plan: BakePlan,
		meta: EnsureMeta,
	): Promise<R | null> {
		let first = true;
		for (;;) {
			const hit = await (first ? cached() : after());
			first = false;
			if (hit) return hit;
			if (meta.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
			const running = this.inflight.get(key);
			if (running) {
				try {
					await this.follow(running, meta);
					this.stats.joined++;
				} catch (e) {
					if (meta.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
					// Its owner was cancelled (another export): render it here.
					if ((e as JobError)?.code !== 'JOB_CANCELLED') throw e;
					if (this.inflight.get(key) === running) this.inflight.delete(key);
				}
				continue;
			}
			const job = this.submitChild(input, plan, meta);
			const entry: InFlight = { jobId: job.id, done: this.childDone(job.id, plan) };
			entry.done.catch(() => undefined);
			this.inflight.set(key, entry);
			try {
				await this.follow(entry, meta, () => this.core.queue.cancel(job.id));
			} finally {
				if (this.inflight.get(key) === entry) this.inflight.delete(key);
			}
			return after();
		}
	}

	private submitChild(input: LayerBakeJobInput, plan: BakePlan, meta: EnsureMeta): EngineJob {
		const key = input.op === 'grade' ? input.grade.key : plan.key;
		return this.core.queue.submit({
			kind: 'layer-bake',
			title: `${input.op === 'grade' ? 'Grade graphics' : 'Bake graphics'} – ${plan.clipName}`,
			priority: 'user',
			// No slots of its own: its Remotion pages are a share of the page budget of the parent, which holds the
			// CPU slots (S11:LBK-022).
			cpuSlots: 0,
			minSlots: 0,
			origin: { type: 'system' },
			parentId: meta.parentId,
			...(meta.projectId ? { projectId: meta.projectId } : {}),
			dedupeKey: `layer-bake:${key}:${meta.parentId}`,
			input,
			stage: 'Queued',
		});
	}

	/** Settles when child `jobId` has finished: resolves on success, throws its error otherwise. */
	private async childDone(jobId: string, plan: BakePlan): Promise<void> {
		const done = await this.core.queue.wait(jobId);
		if (done.state === 'succeeded') return;
		if (done.state === 'cancelled') throw new JobError('JOB_CANCELLED', 'Cancelled');
		throw new JobError(
			done.error?.code ?? 'LAYER_BAKE_FAILED',
			`Baking "${plan.clipName}" failed: ${done.error?.message ?? done.state}`,
			done.error?.retryable ?? true,
		);
	}

	/**
	 * Waits for a render in flight, reporting its progress. `meta.signal` ends the wait: a caller that joined stops
	 * waiting at once; the owner (`cancel`) cancels the child job and waits for it to settle.
	 */
	private async follow(entry: InFlight, meta: EnsureMeta, cancel?: () => void): Promise<void> {
		const poll = meta.onProgress
			? setInterval(() => {
					const p = this.core.queue.get(entry.jobId)?.progress;
					if (typeof p === 'number') meta.onProgress?.(p);
				}, PROGRESS_POLL_MS)
			: null;
		poll?.unref();
		let onAbort: () => void = () => {};
		const aborted = new Promise<never>((_, reject) => {
			onAbort = () => {
				cancel?.();
				reject(new JobError('JOB_CANCELLED', 'Cancelled'));
			};
		});
		aborted.catch(() => undefined);
		if (meta.signal.aborted) onAbort();
		else meta.signal.addEventListener('abort', onAbort, { once: true });
		try {
			await (cancel ? entry.done : Promise.race([entry.done, aborted]));
			if (meta.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
			meta.onProgress?.(1);
		} finally {
			if (poll) clearInterval(poll);
			meta.signal.removeEventListener('abort', onAbort);
		}
	}

	/**
	 * Opens a shared render browser session for the bakes of `group` (the export/still job id): the browser is
	 * launched when the first bake of the group needs it and closed by the returned release (once every holder
	 * released it). Bakes of a group without a session open a browser of their own.
	 */
	browserSession(group: string): () => Promise<void> {
		const s = this.sessions.get(group) ?? { refs: 0, browser: null };
		s.refs++;
		this.sessions.set(group, s);
		let released = false;
		return async () => {
			if (released) return;
			released = true;
			s.refs--;
			if (s.refs > 0) return;
			if (this.sessions.get(group) === s) this.sessions.delete(group);
			const b = await s.browser?.catch(() => null);
			await b?.close();
		};
	}

	/** The shared browser of `group` (launched on first use), or null (no session, or it could not launch). */
	private sharedBrowser(group: string | undefined): Promise<SharedRenderBrowser | null> {
		const s = group ? this.sessions.get(group) : undefined;
		if (!s) return Promise.resolve(null);
		s.browser ??= this.core.remotion.openSharedBrowser().catch((e) => {
			this.o.log?.(`layer-bake: no shared render browser (${(e as Error).message}); one per bake`);
			return null;
		});
		return s.browser;
	}

	/** `POST /api/layer-bake/preview`: queues (or joins) the graded preview job of a clip. */
	submitPreview(
		bake: BakePlan,
		grade: GradePlan,
		meta: { projectId?: string; origin?: EngineJob['origin'] },
	): EngineJob {
		return this.core.queue.submit({
			kind: 'layer-bake',
			title: `Preview graphics – ${bake.clipName}`,
			priority: 'interactive',
			cpuSlots: 2,
			minSlots: 1,
			origin: meta.origin ?? { type: 'user' },
			...(meta.projectId ? { projectId: meta.projectId } : {}),
			dedupeKey: `layer-bake:preview:${grade.key}`,
			input: { op: 'grade', bake, grade, outputs: ['preview'] } satisfies LayerBakeJobInput,
			stage: 'Queued',
		});
	}

	/** ffmpeg of the LGPL binaries directory when there is one (D-13), else the engine's. */
	private ffmpeg(): Ffmpeg {
		const dir = this.core.remotion.binariesDirectory;
		if (dir) {
			const n = binaryNames();
			const ff = join(dir, n.ffmpeg);
			const fp = join(dir, n.ffprobe);
			if (existsSync(ff) && existsSync(fp)) return new Ffmpeg({ ffmpeg: ff, ffprobe: fp });
		}
		return this.core.ffmpeg;
	}

	private async run(ctx: JobContext): Promise<unknown> {
		const input = ctx.input as LayerBakeJobInput;
		// The bake (and the graded entry) are written and read for the whole job.
		const release = this.lease(input.op === 'grade' ? [input.bake.key, input.grade.key] : [input.bake.key]);
		try {
			// A grade's source bake being rendered by another job right now: use that render.
			if (input.op === 'grade') await this.inflight.get(input.bake.key)?.done.catch(() => undefined);
			const browser = await this.sharedBrowser(input.browserGroup);
			const bake = await this.renderBake(ctx, input.bake, {
				concurrency: input.concurrency,
				weight: input.op === 'bake' ? 1 : 0.7,
				browser,
			});
			if (input.op === 'bake') return bake;
			return await this.renderGrade(ctx, input.bake, bake, input.grade, input.outputs);
		} catch (e) {
			if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
			if (e instanceof JobError) throw e;
			const msg = String((e as Error)?.message ?? e);
			throw new JobError(
				'LAYER_BAKE_FAILED',
				`Baking "${input.bake.clipName}" failed: ${msg.slice(0, 1200)}`,
				true,
			);
		} finally {
			release();
			void this.refreshBytes();
		}
	}

	private inputProps(doc: RenderSnapshot, plan: BakePlan): Record<string, unknown> {
		return {
			doc,
			options: {
				isPreview: false,
				useProxies: false,
				transparentBackground: true,
				// A span bake draws the whole (two-clip) track with its transition stage.
				...(plan.span ? {} : { layerFilter: [plan.clipId] }),
			},
		};
	}

	/** Renders a bake into its cache entry (no-op when cached). */
	private async renderBake(
		ctx: JobContext,
		plan: BakePlan,
		o: { concurrency: number | undefined; weight: number; browser: SharedRenderBrowser | null },
	): Promise<BakeResult> {
		const { concurrency, weight } = o;
		const hit = await this.lookup(plan.key);
		if (hit) return hit;
		const reason = this.unavailableReason();
		if (reason)
			throw new JobError(
				'LAYER_BAKE_UNAVAILABLE',
				`Graphics layers need the Remotion renderer to bake: ${reason}`,
				false,
			);
		const ff = this.ffmpeg();
		const scratch = await ctx.scratchDir();
		const dir = this.entryDir(plan.key);
		await mkdir(dir, { recursive: true });
		const still = plan.variant.recipe !== 'master';
		const file = still ? 'still.png' : 'master.mov';
		const tmp = join(scratch, `bake-${file}`);
		const render = async (doc: RenderSnapshot) => {
			if (still) {
				ctx.progress(0, { stage: 'Rendering 0/1 frames' });
				await this.core.remotion.renderStill({
					inputProps: this.inputProps(doc, plan),
					output: tmp,
					frame: 0,
					signal: ctx.signal,
					purpose: 'layer-bake',
					...(o.browser ? { browser: o.browser } : {}),
				});
				ctx.progress(weight * 0.9, { stage: 'Rendering 1/1 frames' });
			} else {
				await this.core.remotion.renderAlphaMaster({
					inputProps: this.inputProps(doc, plan),
					output: tmp,
					scratchDir: scratch,
					signal: ctx.signal,
					ffmpeg: ff,
					...(concurrency ? { concurrency } : {}),
					...(o.browser ? { browser: o.browser } : {}),
					log: ctx.log,
					onSpawn: ctx.trackChild,
					onProgress: (p) =>
						ctx.progress(p.progress * weight * 0.9, {
							stage: `Rendering ${p.renderedFrames}/${p.totalFrames} frames${concurrency ? ` (${concurrency} ${concurrency === 1 ? 'page' : 'pages'})` : ''}`,
						}),
				});
			}
		};
		await render(plan.doc);
		let rect = plan.rect;
		const seq = { width: plan.material.width, height: plan.material.height };
		if (rect && plan.fullDoc && (await this.clippedAtBorder(ff, tmp, rect, seq, ctx))) {
			// The layer drew past the planned crop (LBK-005 safety net): render the whole frame instead.
			ctx.log(`layer-bake: ${plan.clipId} touches the crop border; re-rendering full frame`);
			rect = null;
			await render(plan.fullDoc);
		}
		await rename(tmp, join(dir, file));
		const t = this.now().toISOString();
		const meta: LayerMeta = {
			kind: 'layer',
			key: plan.key,
			recipe: plan.variant.recipe,
			rect,
			frames: plan.frames,
			width: rect?.w ?? plan.material.width,
			height: rect?.h ?? plan.material.height,
			clipName: plan.clipName,
			createdAt: t,
			lastUsedAt: t,
			material: plan.material,
		};
		await atomicWriteJson(join(dir, 'meta.json'), meta, true);
		this.stats.rendered++;
		ctx.progress(weight, { stage: 'Baked' });
		return {
			key: plan.key,
			path: join(dir, file),
			still,
			rect,
			frames: plan.frames,
			width: meta.width,
			height: meta.height,
		};
	}

	/**
	 * True when the bake has visible alpha on an edge of its crop rect that lies inside the frame (the layer was
	 * cut by the crop). Edges on the frame border are ignored (the full render clips there too).
	 */
	private async clippedAtBorder(
		ff: Ffmpeg,
		file: string,
		rect: Rect,
		seq: { width: number; height: number },
		ctx: JobContext,
	): Promise<boolean> {
		const left = rect.x > 0 ? 1 : 0;
		const top = rect.y > 0 ? 1 : 0;
		const right = rect.x + rect.w < seq.width ? 1 : 0;
		const bottom = rect.y + rect.h < seq.height ? 1 : 0;
		// One 1-px strip per inner edge: its largest alpha over all frames (signalstats YMAX of the alpha plane).
		const strips = [
			top ? 'crop=iw:1:0:0' : null,
			bottom ? 'crop=iw:1:0:ih-1' : null,
			left ? 'crop=1:ih:0:0' : null,
			right ? 'crop=1:ih:iw-1:0' : null,
		].filter((s): s is string => s !== null);
		const scratch = await ctx.scratchDir();
		for (const [i, crop] of strips.entries()) {
			const stats = join(scratch, `border-${i}-${Date.now().toString(36)}.txt`);
			const vf = [
				'format=rgba',
				'alphaextract',
				'format=gray',
				crop,
				'signalstats',
				`metadata=mode=print:key=lavfi.signalstats.YMAX:file=${quoteFilterPath(stats)}`,
			].join(',');
			await ff.run(['-i', file, '-vf', vf, '-f', 'null', '-'], {
				signal: ctx.signal,
				onSpawn: ctx.trackChild,
			});
			const text = await readFile(stats, 'utf8').catch(() => '');
			await rm(stats, { force: true });
			for (const m of text.matchAll(/YMAX=(\d+(?:\.\d+)?)/g)) if (Number(m[1]) > RECT_CLIP_ALPHA) return true;
		}
		return false;
	}

	/** Graded master and/or preview of a bake (LBK-010). */
	private async renderGrade(
		ctx: JobContext,
		plan: BakePlan,
		bake: BakeResult,
		grade: GradePlan,
		outputs: readonly ('graded' | 'preview')[],
	): Promise<LayerBakePreviewResult | { key: string; path: string }> {
		const dir = this.entryDir(grade.key);
		await mkdir(dir, { recursive: true });
		const ff = this.ffmpeg();
		const fps = `${grade.fps.num}/${grade.fps.den}`;
		const frameSec = grade.fps.den / grade.fps.num;
		const input = bake.still
			? ['-loop', '1', '-framerate', fps, '-t', sec((grade.frames + 2) * frameSec), '-i', bake.path]
			: ['-i', bake.path];
		const base = [
			`fps=${fps}`,
			`trim=end_frame=${grade.frames}`,
			'setpts=PTS-STARTPTS',
			'format=rgba',
			...grade.filters,
		];
		const scratch = await ctx.scratchDir();
		if (outputs.includes('graded') && !this.gradedDir(grade.key)) {
			ctx.progress(0.75, { stage: 'Grading' });
			const tmp = join(scratch, GRADED_FRAMES_DIR);
			await rm(tmp, { recursive: true, force: true });
			await mkdir(tmp, { recursive: true });
			await ff.run(
				[
					...input,
					'-map',
					'0:v:0',
					'-vf',
					[...base, 'format=rgba'].join(','),
					// Lossless straight-alpha RGBA PNG frames, played with <Img> by the compositions: the Remotion
					// compositor (OffthreadVideo) drops the alpha of RGBA video (PNG-in-MOV, qtrle) and converts YUVA
					// (ProRes 4444, VP9) up to 6/255 off; Chrome decodes PNGs exactly.
					'-c:v',
					'png',
					'-pix_fmt',
					'rgba',
					'-frames:v',
					String(grade.frames),
					'-an',
					// One file per frame at the sequence rate (the image muxer is variable-rate by default and would
					// drop frames sharing a timestamp).
					'-fps_mode',
					'cfr',
					'-r',
					fps,
					'-f',
					'image2',
					'-start_number',
					'0',
					join(tmp, '%06d.png'),
				],
				{ signal: ctx.signal, onSpawn: ctx.trackChild },
			);
			const n = (await readdir(tmp)).filter((f) => f.endsWith('.png')).length;
			if (n !== grade.frames)
				throw new JobError(
					'FRAME_COUNT_MISMATCH',
					`The graded master has ${n} frames, expected ${grade.frames}`,
					true,
				);
			// The sequence appears as a whole (no partial `graded/` in the cache).
			await rename(tmp, join(dir, GRADED_FRAMES_DIR));
		}
		if (outputs.includes('preview') && !this.filePath(grade.key, 'preview.webm')) {
			ctx.progress(0.75, { stage: 'Encoding preview' });
			const tmp = join(scratch, 'preview.webm');
			await ff.run(
				[
					...input,
					'-map',
					'0:v:0',
					'-vf',
					[
						...base,
						`scale=trunc(iw/4)*2:trunc(ih/4)*2:out_color_matrix=bt709:out_range=tv:${SWS_FLAGS}`,
						'format=yuva420p',
					].join(','),
					'-c:v',
					'libvpx-vp9',
					'-pix_fmt',
					'yuva420p',
					'-crf',
					'32',
					'-b:v',
					'0',
					'-row-mt',
					'1',
					'-deadline',
					'good',
					'-cpu-used',
					'4',
					'-auto-alt-ref',
					'0',
					'-colorspace',
					'bt709',
					'-color_primaries',
					'bt709',
					'-color_trc',
					'bt709',
					'-color_range',
					'tv',
					'-frames:v',
					String(grade.frames),
					'-an',
					'-f',
					'webm',
					tmp,
				],
				{ signal: ctx.signal, onSpawn: ctx.trackChild },
			);
			await rename(tmp, join(dir, 'preview.webm'));
		}
		const t = this.now().toISOString();
		const prev = await this.meta(grade.key);
		const meta: LayerMeta = {
			kind: 'layer',
			key: grade.key,
			recipe: 'graded',
			rect: bake.rect,
			frames: grade.frames,
			width: bake.width,
			height: bake.height,
			clipName: plan.clipName,
			createdAt: prev?.createdAt ?? t,
			lastUsedAt: t,
			source: bake.key,
			material: grade.material,
		};
		await atomicWriteJson(join(dir, 'meta.json'), meta, true);
		ctx.progress(1, { stage: 'Done' });
		if (outputs.includes('preview'))
			return {
				key: grade.key,
				sourceKey: bake.key,
				previewUrl: layerFileUrl(grade.key, 'preview.webm'),
				startFrame: 0,
				durationFrames: grade.frames,
				rect: bake.rect,
				width: bake.width,
				height: bake.height,
			};
		return { key: grade.key, path: join(dir, GRADED_FRAMES_DIR) };
	}
}
