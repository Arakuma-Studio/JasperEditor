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
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineJob } from '@jasper/api';
import { emojiKey } from '@jasper/mg-templates';
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
import { colorRunFilters, fadeFilters, SWS_FLAGS } from '../export/native.ts';
import type { NativeExtension } from '../export/native-ext.ts';
import { mediaKeyOf, type PlannedExport } from '../export/planner.ts';
import { encodePngAsync } from '../export/synthetic.ts';
import { importsArtifactsOf, withImportsUrls } from '../imports/extension.ts';
import type { JobContext } from '../jobs/types.ts';
import { JobError } from '../jobs/types.ts';
import type { MediaRecord } from '../media/registry.ts';
import { REMOTION_VERSION, type SharedRenderBrowser } from '../remotion/service.ts';
import { Ffmpeg, sec } from '../tools/ffmpeg.ts';
import { filterPath } from '../tools/filter-text.ts';
import { atomicWriteJson, readJsonOrNull } from '../tools/fs.ts';
import { binaryNames } from '../tools/lgpl.ts';
import type { CoreServices } from '../tools/services.ts';
import {
	type BakeEnvironment,
	bakeGrid,
	expressionKeyPart,
	FileHashCache,
	KEY_RE,
	type KeyEmoji,
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
	clipEmoji,
	clipFonts,
	clipImages,
	cropRect,
	drawnSpan,
	hasColorEffects,
	isColorEffect,
	isStaticLayer,
	layerStill,
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
/** Sheet stills encoded and written at the same time (zlib runs in the libuv pool). */
const STORES_IN_FLIGHT = 4;
/** `lastUsedAt` is rewritten at most this often per entry (the GC removes entries unused for 14 days). */
const MARK_USED_EVERY_MS = 3_600_000;
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
	/**
	 * spec 13 AS-070: a `layer-still` whose picture touches its border (the layer draws past its content bleed): the
	 * layer is baked as a master instead.
	 */
	clipped?: boolean;
	/** spec 13 AS-070: the layer region the stored layer still covers (layer px; trimmed to its pixels). */
	picture?: Rect;
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
	/** spec 13 AS-070 (`layer-still`): the layer region the still covers (layer px, see `layerStill`). */
	picture?: { x: number; y: number; w: number; h: number };
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
	/** spec 13 AS-070: the `layer-still` touches its border (bake the layer as a master instead). */
	clipped?: boolean;
	/** spec 13 AS-070: the layer region the file covers (layer px), when it differs from the plan's. */
	picture?: Rect;
};

/**
 * `concurrency` = the Remotion pages granted to this bake (a share of the parent's page budget); `browserGroup` = the
 * parent job whose shared render browser the bake uses (absent / closed: a browser of its own).
 */
export type LayerBakeJobInput =
	| { op: 'bake'; bake: BakePlan; concurrency?: number; browserGroup?: string }
	/** spec 13 AS-071: still bakes (`still`, `layer-still`) rendered together as the frames of one sheet render. */
	| { op: 'sheet'; bakes: BakePlan[]; concurrency?: number; browserGroup?: string }
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
	/**
	 * The bake's frames are captured (its pages are idle while it is stitched and checked), or it is rendered by another
	 * caller: the export may start other bakes on the pages it granted (`PageGrant.release`).
	 */
	onRendered?(): void;
};

/**
 * How the bakes of one export are run (S11:LBK-022). `maxInFlight`: bakes at the same time (null = automatic:
 * `min(page budget, MAX_RENDERS_IN_FLIGHT)`; 1 = one after the other, each with the whole budget, as before).
 * `sharedBrowser`: the bakes of an export render in shared browsers instead of one each. `pagesPerBrowser`: pages
 * one shared browser serves before the next bake opens another (wp-note export-performance "Layer bake"): a render
 * browser captures every page's frames through its one browser process and one GPU process, which ran at ≈ 90 % of
 * a core each with 8 pages while the pages idled (≈ 4.4 frames/s per page).
 */
export type BakeParallelism = {
	maxInFlight: number | null;
	sharedBrowser: boolean;
	pagesPerBrowser: number;
	/** Remotion pages of an export's bakes (null = the export's Remotion concurrency). */
	pages?: number | null;
};

/**
 * Pages of one shared render browser (default of `BakeParallelism.pagesPerBrowser`): a two-page bake renders in a
 * browser of its own (renders sharing a browser of four pages measured ≈ 20 % slower).
 */
export const PAGES_PER_BROWSER = 2;
/**
 * Shared render browsers of one export at most (each costs a browser and a GPU process, and Remotion's launcher adds
 * process signal listeners per browser: Node warns past ten).
 */
const MAX_BROWSERS = 8;

/**
 * Defaults; `JASPER_LAYER_BAKE_PARALLEL` (bakes in flight), `JASPER_LAYER_BAKE_SHARED_BROWSER` (0/1) and
 * `JASPER_LAYER_BAKE_PAGES_PER_BROWSER` override.
 */
export function bakeParallelismFromEnv(env: Record<string, string | undefined>): BakeParallelism {
	const n = Number(env.JASPER_LAYER_BAKE_PARALLEL);
	const shared = env.JASPER_LAYER_BAKE_SHARED_BROWSER;
	const per = Number(env.JASPER_LAYER_BAKE_PAGES_PER_BROWSER);
	const pages = Number(env.JASPER_LAYER_BAKE_PAGES);
	return {
		maxInFlight: Number.isInteger(n) && n >= 1 ? n : null,
		sharedBrowser: shared !== '0',
		pagesPerBrowser: Number.isInteger(per) && per >= 1 ? per : PAGES_PER_BROWSER,
		pages: Number.isInteger(pages) && pages >= 1 ? pages : null,
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

/** One shared render browser of a group and the pages of the renders using it now. */
type BrowserSlot = { browser: Promise<SharedRenderBrowser | null>; pages: number };

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
	/** `EnsureMeta.onRendered` of the child jobs rendering for a caller, by child job id. */
	private readonly renderedHooks = new Map<string, () => void>();
	/** Shared render browsers by group (the export/still job id), opened when the bakes need them. */
	private readonly sessions = new Map<string, { refs: number; browsers: BrowserSlot[] }>();
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

	/** Where the still of `key` is (or will be) stored. */
	stillFile(key: string): string {
		return join(this.entryDir(key), 'still.png');
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
		return {
			key,
			path,
			still,
			rect: meta.rect,
			frames: meta.frames,
			width: meta.width,
			height: meta.height,
			...(meta.clipped ? { clipped: true } : {}),
			...(meta.picture ? { picture: meta.picture } : {}),
		};
	}

	private async markUsed(key: string, meta: LayerMeta): Promise<void> {
		this.core.cache.touch(this.entryDir(key));
		// The GC keeps entries used in the last 14 days: a use within the hour need not rewrite the meta (an export of
		// 1 000 cached subtitles otherwise wrote 1 000 files before its composite).
		const last = Date.parse(meta.lastUsedAt);
		if (Number.isFinite(last) && this.now().getTime() - last < MARK_USED_EVERY_MS) return;
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
		return out.sort(
			(a, b) =>
				`${a.family}|${a.weight}|${a.style}`.localeCompare(`${b.family}|${b.weight}|${b.style}`) ||
				// subset files of one face (social-comment §7.8)
				(a.fileSha256 ?? '').localeCompare(b.fileSha256 ?? ''),
		);
	}

	/** Signed absolute URLs of an emoji or image table (headless renders cannot send the session cookie). */
	private signedEmoji(emoji: Record<string, string> | undefined): Record<string, string> | undefined {
		if (!emoji) return undefined;
		const out: Record<string, string> = {};
		for (const [k, url] of Object.entries(emoji))
			out[k] = url.startsWith('/') ? this.core.signer.signUrl(this.core.origin(), url) : url;
		return out;
	}

	/** social-comment §7.8: key part of the remote images the clips draw (manifest id + pinned hash). */
	private keyImages(clips: readonly RenderVisualClip[]): { id: string; sha256: string | null }[] | undefined {
		const ids = new Set<string>();
		for (const c of clips)
			for (const id of ('mg' in c.source ? c.source.mg.assets?.images : undefined) ?? []) ids.add(id);
		if (ids.size === 0) return undefined;
		return [...ids].sort().map((id) => ({ id, sha256: this.core.remoteAssets.image(id)?.sha256 ?? null }));
	}

	/** social-comment §7.8: key part of the template emoji the clips draw (pack id + version, image hashes). */
	private async keyEmoji(clips: readonly RenderVisualClip[]): Promise<KeyEmoji[] | undefined> {
		const byPack = new Map<string, Set<string>>();
		for (const c of clips) {
			const assets = 'mg' in c.source ? c.source.mg.assets : undefined;
			for (const { pack, graphemes } of assets?.emoji ?? []) {
				const set = byPack.get(pack) ?? new Set<string>();
				for (const g of graphemes) set.add(g);
				byPack.set(pack, set);
			}
		}
		if (byPack.size === 0) return undefined;
		const remote = this.core.remoteAssets;
		const out: KeyEmoji[] = [];
		for (const [pack, set] of [...byPack].sort(([a], [b]) => a.localeCompare(b))) {
			const files: KeyEmoji['files'] = [];
			for (const g of set) files.push({ key: emojiKey(g), sha256: await remote.emojiHash(pack, g) });
			files.sort((a, b) => a.key.localeCompare(b.key));
			out.push({ pack, version: remote.pack(pack)?.version ?? null, files });
		}
		return out;
	}

	/**
	 * Plans the bake of `clip` (a DOM layer of `planned.snapshot`). `frame` = a single sequence frame (stills):
	 * a static layer still uses its whole-span still; a non-static one its cached master when present, else a
	 * one-frame bake. `stripColor`: colour effects are left to ffmpeg (always, LBK-010).
	 */
	async planBake(
		planned: Pick<PlannedExport, 'document' | 'media' | 'snapshot'>,
		clip: RenderVisualClip,
		o: { env: BakeEnvironment; frame?: number | null; master?: boolean; grow?: boolean },
	): Promise<BakePlan> {
		const asBaked = bakeClip(clip, { variant: { recipe: 'master' }, stripColor: true });
		const isStatic = isStaticLayer(asBaked);
		const span = drawnSpan(clip);
		// spec 13 AS-070: static content whose picture moves → one still of the layer region (native motion), unless
		// that still was found clipped (`master`).
		if (!isStatic && !o.master && layerStill(clip)) {
			if (!o.grow) {
				const ls = await this.plan(planned, clip, { recipe: 'layer-still' }, o.env);
				// The cache entry's meta only (a read, not a use: `ensureSheet` marks it used).
				if (!(await this.meta(ls.key))?.clipped) return ls;
			}
			// Clipped at its border: the region grown by the box size, then a master.
			const grown = await this.plan(planned, clip, { recipe: 'layer-still', grow: true }, o.env);
			if (!(await this.meta(grown.key))?.clipped) return grown;
		}
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
		// spec 13 AS-070: a layer-still's frame is its layer region (the clip translated into it by `bakeClip`).
		const picture = variant.recipe === 'layer-still' ? layerStill(clip, undefined, !!variant.grow) : null;
		if (variant.recipe === 'layer-still' && !picture)
			throw new JobError('LAYER_BAKE_FAILED', `"${clip.name}" cannot be baked as a layer still`, false);
		const rect = picture
			? { x: 0, y: 0, w: picture.w, h: picture.h }
			: cropRect(
					clip,
					{ f0, f1 },
					{ width: seq.width, height: seq.height, fps: seq.fps },
					undefined,
					bakeGrid(seq.width, env.scale),
				);
		const shiftedClip =
			rect && !picture ? bakeClip(clip, { variant, stripColor: true, shift: rect }) : unshifted;
		const fonts = clipFonts(unshifted, snap.fonts);
		const mediaIds = referencedMediaIds([unshifted.source, unshifted.effects]);
		const media: RenderSnapshot['media'] = {};
		for (const id of mediaIds) media[id] = this.signedHandle(planned, id);
		const signedFonts = fonts.map((f) => ({
			...f,
			url: f.url.startsWith('/') ? this.core.signer.signUrl(this.core.origin(), f.url) : f.url,
		}));
		const emoji = this.signedEmoji(clipEmoji(unshifted, snap.emoji));
		const images = this.signedEmoji(clipImages(unshifted, snap.images));
		const keyEmoji = await this.keyEmoji([unshifted]);
		const keyImages = this.keyImages([unshifted]);
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
			...(keyEmoji ? { emoji: keyEmoji } : {}),
			...(keyImages ? { images: keyImages } : {}),
			bundleId: env.bundleId,
			animejs: env.animejs,
			remotion: env.remotion,
			browser: env.browser,
			gl: env.gl,
			still: variant.recipe !== 'master',
			rect,
			...(picture ? { picture } : {}),
			...(clip.kind === 'motion-graphic' ? { renderVersion: templateRenderVersion(clip) } : {}),
			...(() => {
				const e = expressionKeyPart(clip, snap.expressions);
				// The clip's sequence position matters too (`time` is sequence time).
				return e ? { expressions: `${e}:${clip.start}` } : {};
			})(),
			graded: false,
			// output-size.ts: masters render at the output size
			...(variant.recipe === 'master' && env.scale && env.scale !== 1 ? { scale: env.scale } : {}),
		};
		const docOf = (c: RenderVisualClip, r: Rect | null) =>
			bakeDoc(snap, this.signedRotos(c), {
				variant,
				rect: r,
				media,
				fonts: signedFonts,
				...(emoji ? { emoji } : {}),
				...(images ? { images } : {}),
			});
		return {
			clipId: clip.clipId,
			clipName: clip.name,
			key: keyOf(material),
			variant,
			rect,
			doc: docOf(shiftedClip, rect),
			fullDoc: rect && !picture ? docOf(unshifted, null) : null,
			...(picture ? { picture } : {}),
			frames,
			startFrame: f0,
			colorRuns: hasColorEffects(clip),
			material,
		};
	}

	/**
	 * spec 13 AS-073 — plans ONE master for a run of baked layers of track `trackId` that follow each other (shaken
	 * subtitles the kernel cannot draw: S_Shake with motion blur, RGB split or wrap): the clips, shifted so the run
	 * starts at frame 0, drawn together on a transparent frame for `[start, end)` — one render and one composite input
	 * instead of one each. The key holds the clips (ids included: shaders seed by clip id), not the run's position.
	 */
	async planRun(
		planned: Pick<PlannedExport, 'document' | 'media' | 'snapshot'>,
		trackId: string,
		run: readonly RenderVisualClip[],
		o: { env: BakeEnvironment },
	): Promise<BakePlan> {
		const snap = planned.snapshot;
		const seq = snap.settings;
		const start = Math.min(...run.map((c) => drawnSpan(c).start));
		const end = Math.max(...run.map((c) => drawnSpan(c).end));
		const clips = run.map((c): RenderVisualClip => {
			const effects = c.effects.filter((fx) => fx.enabled);
			return {
				...c,
				effects,
				start: c.start - start,
				...(c.fades?.length ? { fades: c.fades.map((f) => ({ ...f, start: f.start - start })) } : {}),
			};
		});
		const frames = end - start;
		const fonts = [...new Set(clips.flatMap((c) => clipFonts(c, snap.fonts)))];
		const mediaIds = referencedMediaIds(clips.map((c) => [c.source, c.effects]));
		const media: RenderSnapshot['media'] = {};
		for (const id of mediaIds) media[id] = this.signedHandle(planned, id);
		const signedFonts = fonts.map((f) => ({
			...f,
			url: f.url.startsWith('/') ? this.core.signer.signUrl(this.core.origin(), f.url) : f.url,
		}));
		const material: KeyMaterial = {
			v: LAYER_BAKE_VERSION,
			recipe: 'master',
			clip: { run: clips.map(({ name: _n, trackId: _t, ...c }) => c) },
			span: frames,
			width: seq.width,
			height: seq.height,
			fps: { num: seq.fps.num, den: seq.fps.den },
			fonts: await this.keyFonts(fonts),
			media: this.keyMedia(planned, mediaIds),
			bundleId: o.env.bundleId,
			animejs: o.env.animejs,
			remotion: o.env.remotion,
			browser: o.env.browser,
			gl: o.env.gl,
			still: false,
			rect: null,
			graded: false,
			...(o.env.scale && o.env.scale !== 1 ? { scale: o.env.scale } : {}),
		};
		const doc: RenderSnapshot = {
			version: 1,
			sequenceId: snap.sequenceId,
			settings: { ...seq, backgroundColor: [0, 0, 0, 0] },
			range: { start: 0, end: frames },
			durationFrames: frames,
			videoTracks: [{ trackId, clips: clips.map((c) => this.signedRotos(c)) }],
			audioClips: [],
			media,
			fonts: signedFonts,
			master: { volumeDb: { value: 0, keyframes: [] } },
			warnings: [],
			...(snap.expressions ? { expressions: snap.expressions } : {}),
		};
		return {
			clipId: `run:${run[0]!.clipId}`,
			clipName: `${run.length} layers from "${run[0]!.name}"`,
			key: keyOf(material),
			variant: { recipe: 'master' },
			rect: null,
			doc,
			fullDoc: null,
			frames,
			startFrame: start,
			colorRuns: false,
			material,
			// Draws every clip of its document (no layer filter), like a transition span.
			span: true,
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
		const spanEmoji = this.signedEmoji(
			sides.reduce<Record<string, string> | undefined>((acc, c) => {
				const e = clipEmoji(c, snap.emoji);
				return e ? { ...(acc ?? {}), ...e } : acc;
			}, undefined),
		);
		const spanKeyEmoji = await this.keyEmoji(sides);
		const spanImages = this.signedEmoji(
			sides.reduce<Record<string, string> | undefined>((acc, c) => {
				const e = clipImages(c, snap.images);
				return e ? { ...(acc ?? {}), ...e } : acc;
			}, undefined),
		);
		const spanKeyImages = this.keyImages(sides);
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
			...(spanKeyEmoji ? { emoji: spanKeyEmoji } : {}),
			...(spanKeyImages ? { images: spanKeyImages } : {}),
			bundleId: o.env.bundleId,
			animejs: o.env.animejs,
			remotion: o.env.remotion,
			browser: o.env.browser,
			gl: o.env.gl,
			still: single,
			rect: null,
			graded: false,
			...(!single && o.env.scale && o.env.scale !== 1 ? { scale: o.env.scale } : {}),
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
			...(spanEmoji ? { emoji: spanEmoji } : {}),
			...(spanImages ? { images: spanImages } : {}),
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

	/**
	 * spec 13 AS-071: the bakes of still plans (`still`, `layer-still`), the missing ones rendered together in ONE
	 * child job as the frames of one sheet render (one browser page set and bundle load for all of them, instead of one
	 * render each: textperf measured ≈ 3.4 s fixed cost per still render, ≈ 0.1 s per frame of a sheet). Keys already
	 * cached are reused; keys another caller is rendering are joined (`ensureBake`). Results by key.
	 */
	async ensureSheet(plans: readonly BakePlan[], meta: EnsureMeta): Promise<Map<string, BakeResult>> {
		const out = new Map<string, BakeResult>();
		this.leaseUntilDone(
			plans.map((p) => p.key),
			meta.parentId,
		);
		const missing: BakePlan[] = [];
		const joined: BakePlan[] = [];
		for (const p of plans) {
			if (out.has(p.key) || missing.some((m) => m.key === p.key)) continue;
			const hit = await this.lookup(p.key);
			if (hit) {
				this.stats.reused++;
				out.set(p.key, hit);
			} else if (this.inflight.has(p.key)) joined.push(p);
			else missing.push(p);
		}
		if (meta.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
		if (missing.length === 1) joined.push(missing.pop()!);
		if (missing.length > 0) {
			const input: LayerBakeJobInput = { op: 'sheet', bakes: missing, ...this.childOptions(meta) };
			const job = this.submitChild(input, missing[0]!, meta);
			const entry: InFlight = { jobId: job.id, done: this.childDone(job.id, missing[0]!) };
			entry.done.catch(() => undefined);
			for (const p of missing) this.inflight.set(p.key, entry);
			if (meta.onRendered) this.renderedHooks.set(job.id, meta.onRendered);
			try {
				await this.follow(entry, meta, () => this.core.queue.cancel(job.id));
			} finally {
				this.renderedHooks.delete(job.id);
				for (const p of missing) if (this.inflight.get(p.key) === entry) this.inflight.delete(p.key);
			}
			for (const p of missing) {
				const r = await this.lookup(p.key);
				if (!r) throw new JobError('LAYER_BAKE_FAILED', `The bake of "${p.clipName}" is missing`, true);
				out.set(p.key, r);
			}
		}
		for (const p of joined) out.set(p.key, await this.ensureBake(p, meta));
		return out;
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
				// rendered by another caller: this caller's pages stay idle
				meta.onRendered?.();
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
			if (meta.onRendered) this.renderedHooks.set(job.id, meta.onRendered);
			try {
				await this.follow(entry, meta, () => this.core.queue.cancel(job.id));
			} finally {
				this.renderedHooks.delete(job.id);
				if (this.inflight.get(key) === entry) this.inflight.delete(key);
			}
			return after();
		}
	}

	private submitChild(input: LayerBakeJobInput, plan: BakePlan, meta: EnsureMeta): EngineJob {
		const key = input.op === 'grade' ? input.grade.key : plan.key;
		return this.core.queue.submit({
			kind: 'layer-bake',
			title:
				input.op === 'sheet'
					? `Bake graphics – ${input.bakes.length} stills`
					: `${input.op === 'grade' ? 'Grade graphics' : 'Bake graphics'} – ${plan.clipName}`,
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

	/** Child job `jobId` has captured its frames: its caller may use the pages it granted (`EnsureMeta.onRendered`). */
	private framesCaptured(jobId: string): void {
		const hook = this.renderedHooks.get(jobId);
		if (!hook) return;
		this.renderedHooks.delete(jobId);
		hook();
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
	 * Opens a shared render browser session for the bakes of `group` (the export/still job id): its browsers are
	 * launched as the bakes of the group need them (`acquireBrowser`) and closed by the returned release (once every
	 * holder released it). Bakes of a group without a session open a browser of their own.
	 */
	browserSession(group: string): () => Promise<void> {
		const s = this.sessions.get(group) ?? { refs: 0, browsers: [] };
		s.refs++;
		this.sessions.set(group, s);
		let released = false;
		return async () => {
			if (released) return;
			released = true;
			s.refs--;
			if (s.refs > 0) return;
			if (this.sessions.get(group) === s) this.sessions.delete(group);
			await Promise.all(
				s.browsers.map(async (slot) => {
					const b = await slot.browser.catch(() => null);
					await b?.close();
				}),
			);
		};
	}

	/**
	 * A shared browser of `group` for a render of `pages` pages (null without a session): the least busy one, or a new
	 * one when that would serve more than `pagesPerBrowser` pages (at most MAX_BROWSERS). The browser resolves to null
	 * when it could not launch (the render then opens its own). `release` when the render ends.
	 */
	acquireBrowser(
		group: string | undefined,
		pages: number,
	): { browser: Promise<SharedRenderBrowser | null>; release(): void } | null {
		const s = group ? this.sessions.get(group) : undefined;
		if (!s) return null;
		const want = Math.max(1, Math.floor(pages));
		let slot = s.browsers.reduce<BrowserSlot | null>((a, b) => (!a || b.pages < a.pages ? b : a), null);
		if (
			!slot ||
			(slot.pages > 0 &&
				slot.pages + want > this.parallelism.pagesPerBrowser &&
				s.browsers.length < MAX_BROWSERS)
		) {
			const browser = this.core.remotion.openSharedBrowser().catch((e) => {
				this.o.log?.(`layer-bake: no shared render browser (${(e as Error).message}); one per bake`);
				return null;
			});
			slot = { browser, pages: 0 };
			s.browsers.push(slot);
		}
		const held = slot;
		held.pages += want;
		let released = false;
		return {
			browser: held.browser,
			release: () => {
				if (released) return;
				released = true;
				held.pages -= want;
			},
		};
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
		if (input.op === 'sheet') return this.runSheet(ctx, input);
		// The bake (and the graded entry) are written and read for the whole job.
		const release = this.lease(input.op === 'grade' ? [input.bake.key, input.grade.key] : [input.bake.key]);
		let lease: ReturnType<LayerBakeService['acquireBrowser']> = null;
		try {
			// A grade's source bake being rendered by another job right now: use that render.
			if (input.op === 'grade') await this.inflight.get(input.bake.key)?.done.catch(() => undefined);
			lease = this.acquireBrowser(input.browserGroup, input.concurrency ?? 1);
			const browser = (await lease?.browser) ?? null;
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
			lease?.release();
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
					// output-size.ts: at the export's output size
					...(plan.material.scale ? { scale: plan.material.scale } : {}),
					scratchDir: scratch,
					signal: ctx.signal,
					ffmpeg: ff,
					...(concurrency ? { concurrency } : {}),
					...(o.browser ? { browser: o.browser } : {}),
					log: ctx.log,
					onSpawn: ctx.trackChild,
					onProgress: (p) => {
						ctx.progress(p.progress * weight * 0.9, {
							stage: `Rendering ${p.renderedFrames}/${p.totalFrames} frames${concurrency ? ` (${concurrency} ${concurrency === 1 ? 'page' : 'pages'})` : ''}`,
						});
						if (p.renderedFrames >= p.totalFrames) this.framesCaptured(ctx.job.id);
					},
				});
			}
		};
		await render(plan.doc);
		this.framesCaptured(ctx.job.id);
		let rect = plan.rect;
		const seq = { width: plan.material.width, height: plan.material.height };
		// spec 13 AS-070: every edge of a layer-still is inside the layer's drawing: content there was cut.
		const clipped =
			!!plan.picture &&
			(await this.clippedAtBorder(
				ff,
				tmp,
				{ x: 1, y: 1, w: plan.picture.w, h: plan.picture.h },
				{ width: plan.picture.w + 2, height: plan.picture.h + 2 },
				ctx,
			));
		if (clipped)
			ctx.log(`layer-bake: ${plan.clipId} touches the layer-still border; baked larger, then as a master`);
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
			...(clipped ? { clipped: true } : {}),
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
			...(clipped ? { clipped: true } : {}),
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
		// One 1-px strip per inner edge: its largest alpha over all frames (signalstats YMAX of the alpha plane). The
		// strips are split from one decode of the bake (a master's ProRes 4444 decode and RGBA conversion dominate: one
		// ffmpeg per strip decoded it up to four times).
		const strips = [
			top ? 'crop=iw:1:0:0' : null,
			bottom ? 'crop=iw:1:0:ih-1' : null,
			left ? 'crop=1:ih:0:0' : null,
			right ? 'crop=1:ih:iw-1:0' : null,
		].filter((s): s is string => s !== null);
		if (strips.length === 0) return false;
		const scratch = await ctx.scratchDir();
		const tag = Date.now().toString(36);
		const stats = strips.map((_, i) => join(scratch, `border-${i}-${tag}.txt`));
		const graph = [
			`[0:v]format=rgba,alphaextract,format=gray,split=${strips.length}${strips.map((_, i) => `[s${i}]`).join('')}`,
			...strips.map(
				(crop, i) =>
					`[s${i}]${crop},signalstats,metadata=mode=print:key=lavfi.signalstats.YMAX:file=${filterPath(stats[i]!)}[o${i}]`,
			),
		].join(';');
		try {
			await ff.run(
				[
					'-i',
					file,
					'-filter_complex',
					graph,
					...strips.flatMap((_, i) => ['-map', `[o${i}]`, '-f', 'null', '-']),
				],
				{ signal: ctx.signal, onSpawn: ctx.trackChild },
			);
			for (const f of stats) {
				const text = await readFile(f, 'utf8').catch(() => '');
				for (const m of text.matchAll(/YMAX=(\d+(?:\.\d+)?)/g))
					if (Number(m[1]) > RECT_CLIP_ALPHA) return true;
			}
			return false;
		} finally {
			for (const f of stats) await rm(f, { force: true });
		}
	}

	/** A `sheet` child job (spec 13 AS-071): its stills, then every still the sheet could not hold alone. */
	private async runSheet(
		ctx: JobContext,
		input: Extract<LayerBakeJobInput, { op: 'sheet' }>,
	): Promise<unknown> {
		const release = this.lease(input.bakes.map((b) => b.key));
		const lease = this.acquireBrowser(input.browserGroup, input.concurrency ?? 1);
		try {
			const browser = (await lease?.browser) ?? null;
			const sheet = await this.renderSheet(ctx, input.bakes, { concurrency: input.concurrency, browser });
			this.framesCaptured(ctx.job.id);
			const redo = sheet.redo;
			// Stills that drew past their crop are rendered alone (full frame when needed, LBK-005).
			for (const [i, plan] of redo.entries()) {
				if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
				ctx.progress(0.9 + (0.1 * i) / redo.length, { stage: `Re-rendering ${plan.clipName}` });
				await this.renderBake(ctx, plan, { concurrency: input.concurrency, weight: 0, browser });
			}
			ctx.progress(1, { stage: 'Baked' });
			return { stills: input.bakes.length, rerendered: redo.length, timing: sheet.timing };
		} catch (e) {
			if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
			if (e instanceof JobError) throw e;
			const msg = String((e as Error)?.message ?? e);
			throw new JobError(
				'LAYER_BAKE_FAILED',
				`Baking ${input.bakes.length} stills failed: ${msg.slice(0, 1200)}`,
				true,
			);
		} finally {
			lease?.release();
			release();
			void this.refreshBytes();
		}
	}

	/**
	 * spec 13 AS-071 — renders still plans as the frames of one document (frame i = plan i's one-frame clip, every
	 * clip translated into the top-left of a frame as large as the largest of them), decodes the PNG frames with one
	 * ffmpeg, crops each to its own size, checks its crop border like `clippedAtBorder` (sequence stills: the edges
	 * inside the frame; layer stills: every edge) and writes each cache entry. Returns the sequence stills that touched
	 * their crop border (re-rendered alone by the caller); a clipped layer still is stored with `clipped`.
	 */
	private async renderSheet(
		ctx: JobContext,
		plans: readonly BakePlan[],
		o: { concurrency: number | undefined; browser: SharedRenderBrowser | null },
	): Promise<{ redo: BakePlan[]; timing: { selectMs: number; renderMs: number; storeMs: number } }> {
		const reason = this.unavailableReason();
		if (reason)
			throw new JobError(
				'LAYER_BAKE_UNAVAILABLE',
				`Graphics layers need the Remotion renderer to bake: ${reason}`,
				false,
			);
		const sizeOf = (p: BakePlan) => ({ w: p.rect?.w ?? p.material.width, h: p.rect?.h ?? p.material.height });
		const W = Math.max(2, ...plans.map((p) => sizeOf(p).w));
		const H = Math.max(2, ...plans.map((p) => sizeOf(p).h));
		const first = plans[0]!.doc;
		const fonts = new Map<string, RenderSnapshot['fonts'][number]>();
		const media: RenderSnapshot['media'] = {};
		const clips: RenderVisualClip[] = [];
		for (const [i, p] of plans.entries()) {
			const c = p.doc.videoTracks[0]?.clips[0];
			if (!c) throw new JobError('LAYER_BAKE_FAILED', `The bake of "${p.clipName}" has no layer`, false);
			clips.push({ ...c, trackId: 'sheet', start: i, duration: 1 });
			for (const f of p.doc.fonts) fonts.set(`${f.family}|${f.weight}|${f.style}|${f.url}`, f);
			Object.assign(media, p.doc.media);
		}
		const doc: RenderSnapshot = {
			...first,
			settings: { ...first.settings, width: W, height: H, backgroundColor: [0, 0, 0, 0] },
			range: { start: 0, end: plans.length },
			durationFrames: plans.length,
			videoTracks: [{ trackId: 'sheet', clips }],
			audioClips: [],
			media,
			fonts: [...fonts.values()],
		};
		const scratch = await ctx.scratchDir();
		const dir = join(scratch, `sheet-${Date.now().toString(36)}`);
		await mkdir(dir, { recursive: true });
		ctx.progress(0, { stage: `Rendering 0/${plans.length} stills` });
		const rendered = await this.core.remotion.renderStillSheet({
			inputProps: {
				doc,
				options: {
					isPreview: false,
					useProxies: false,
					transparentBackground: true,
					layerFilter: clips.map((c) => c.clipId),
				},
			},
			outputDir: dir,
			signal: ctx.signal,
			...(o.concurrency ? { concurrency: o.concurrency } : {}),
			...(o.browser ? { browser: o.browser } : {}),
			log: ctx.log,
			onProgress: (p) =>
				ctx.progress((0.8 * p.renderedFrames) / p.totalFrames, {
					stage: `Rendering ${p.renderedFrames}/${p.totalFrames} stills`,
				}),
		});
		const t1 = performance.now();
		// `<frame>.png` → `%06d.png` (one image2 input).
		const files = (await readdir(dir)).filter((f) => /^\d+\.png$/.test(f));
		if (files.length !== plans.length)
			throw new JobError(
				'FRAME_COUNT_MISMATCH',
				`The sheet render wrote ${files.length} stills, expected ${plans.length}`,
				true,
			);
		for (const f of files)
			await rename(join(dir, f), join(dir, `s${gradedFrameName(Number.parseInt(f, 10))}`));
		ctx.progress(0.8, { stage: 'Cropping stills' });
		const redo: BakePlan[] = [];
		const frameBytes = W * H * 4;
		const ff = this.ffmpeg();
		const child = ff.spawnRaw(
			[
				'-f',
				'image2',
				'-framerate',
				'25',
				'-start_number',
				'0',
				'-i',
				join(dir, 's%06d.png'),
				'-frames:v',
				String(plans.length),
				'-f',
				'rawvideo',
				'-pix_fmt',
				'rgba',
				'pipe:1',
			],
			{ signal: ctx.signal, onSpawn: ctx.trackChild },
		);
		let stderr = '';
		child.stderr!.setEncoding('utf8').on('data', (c: string) => {
			stderr = (stderr + c).slice(-4000);
		});
		const closed = new Promise<void>((resolve, reject) => {
			child.on('error', reject);
			child.on('close', (code, sig) =>
				code === 0
					? resolve()
					: reject(
							new JobError(
								'TOOL_FAILED',
								`ffmpeg exited ${code ?? sig}: ${stderr.trim().slice(-1500)}`,
								true,
							),
						),
			);
		});
		closed.catch(() => undefined);
		let i = 0;
		// One frame buffer, filled chunk by chunk; `storeSheetStill` copies its still out of it before its first await,
		// so up to STORES_IN_FLIGHT stills are encoded and written side by side while the decode goes on.
		const frame = Buffer.allocUnsafe(frameBytes);
		let filled = 0;
		const stores = new Set<Promise<void>>();
		const store = async (plan: BakePlan) => {
			if (await this.storeSheetStill(plan, frame, W, ctx)) redo.push(plan);
		};
		for await (const chunk of child.stdout! as AsyncIterable<Buffer>) {
			let off = 0;
			while (off < chunk.length && i < plans.length) {
				const k = Math.min(frameBytes - filled, chunk.length - off);
				chunk.copy(frame, filled, off, off + k);
				filled += k;
				off += k;
				if (filled < frameBytes) continue;
				const p = store(plans[i]!);
				stores.add(p);
				p.finally(() => stores.delete(p)).catch(() => undefined);
				filled = 0;
				i++;
				ctx.progress(0.8 + (0.1 * i) / plans.length, { stage: `Cropping stills ${i}/${plans.length}` });
				if (stores.size >= STORES_IN_FLIGHT) await Promise.race(stores);
			}
		}
		await Promise.all(stores);
		await closed;
		if (i !== plans.length)
			throw new JobError(
				'FRAME_COUNT_MISMATCH',
				`The sheet decode gave ${i} stills, expected ${plans.length}`,
				true,
			);
		await rm(dir, { recursive: true, force: true });
		return {
			redo,
			timing: {
				selectMs: rendered.selectMs,
				renderMs: rendered.renderMs,
				storeMs: Math.round(performance.now() - t1),
			},
		};
	}

	/**
	 * One frame of a sheet (`W` px rows, RGBA): its plan's still cropped from the top-left, checked at its crop border
	 * and stored. True when a sequence still touched its border (to be rendered alone); a clipped layer still is
	 * stored with `clipped` (the layer is then baked as a master).
	 */
	private async storeSheetStill(plan: BakePlan, frame: Buffer, W: number, ctx: JobContext): Promise<boolean> {
		const w = plan.rect?.w ?? plan.material.width;
		const h = plan.rect?.h ?? plan.material.height;
		const px = new Uint8Array(w * h * 4);
		for (let y = 0; y < h; y++) px.set(frame.subarray(y * W * 4, y * W * 4 + w * 4), y * w * 4);
		const alphaAt = (x: number, y: number) => px[(y * w + x) * 4 + 3]!;
		const edge = (side: 'top' | 'bottom' | 'left' | 'right') => {
			if (side === 'top' || side === 'bottom') {
				const y = side === 'top' ? 0 : h - 1;
				for (let x = 0; x < w; x++) if (alphaAt(x, y) > RECT_CLIP_ALPHA) return true;
				return false;
			}
			const x = side === 'left' ? 0 : w - 1;
			for (let y = 0; y < h; y++) if (alphaAt(x, y) > RECT_CLIP_ALPHA) return true;
			return false;
		};
		let clipped = false;
		if (plan.picture) clipped = (['top', 'bottom', 'left', 'right'] as const).some(edge);
		else if (plan.rect && plan.fullDoc) {
			const r = plan.rect;
			const seq = { width: plan.material.width, height: plan.material.height };
			const inner = [
				r.y > 0 ? ('top' as const) : null,
				r.y + r.h < seq.height ? ('bottom' as const) : null,
				r.x > 0 ? ('left' as const) : null,
				r.x + r.w < seq.width ? ('right' as const) : null,
			].filter((s): s is 'top' | 'bottom' | 'left' | 'right' => s !== null);
			// Rendered alone, with the full-frame fallback of `renderBake`.
			if (inner.some(edge)) return true;
		}
		if (clipped)
			ctx.log(`layer-bake: ${plan.clipId} touches the layer-still border; baked larger, then as a master`);
		// spec 13 AS-070: a layer still is trimmed to its pixels (+ 2 transparent px, so the kernel's anti-aliased
		// picture edge and its clamp-to-edge samples only ever see transparency): the kernel draws, streams and
		// overlays only the glyphs, stroke and shadow, not the empty margin of the bleed estimate.
		let out: { px: Uint8Array; w: number; h: number } = { px, w, h };
		let picture: Rect | undefined;
		if (plan.picture && !clipped) {
			const t = alphaBounds(px, w, h);
			if (!t) {
				picture = { x: plan.picture.x, y: plan.picture.y, w: 2, h: 2 };
				out = { px: new Uint8Array(16), w: 2, h: 2 };
			} else {
				const x0 = Math.max(0, t.x0 - 2);
				const y0 = Math.max(0, t.y0 - 2);
				const x1 = Math.min(w, t.x1 + 2);
				const y1 = Math.min(h, t.y1 + 2);
				picture = { x: plan.picture.x + x0, y: plan.picture.y + y0, w: x1 - x0, h: y1 - y0 };
				out = { px: cropRgba(px, w, x0, y0, x1 - x0, y1 - y0), w: x1 - x0, h: y1 - y0 };
			}
		}
		const dir = this.entryDir(plan.key);
		await mkdir(dir, { recursive: true });
		const scratch = await ctx.scratchDir();
		const tmp = join(scratch, `sheet-${plan.key}.png`);
		await writeFile(tmp, await encodePngAsync(out.px, out.w, out.h));
		await rename(tmp, join(dir, 'still.png'));
		const t = this.now().toISOString();
		const meta: LayerMeta = {
			kind: 'layer',
			key: plan.key,
			recipe: plan.variant.recipe,
			rect: plan.rect,
			frames: plan.frames,
			width: out.w,
			height: out.h,
			clipName: plan.clipName,
			createdAt: t,
			lastUsedAt: t,
			...(clipped ? { clipped: true } : {}),
			...(picture ? { picture } : {}),
			material: plan.material,
		};
		await atomicWriteJson(join(dir, 'meta.json'), meta, true);
		this.stats.rendered++;
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

/** The bounding box `[x0, y0, x1, y1)` of the pixels of an RGBA image with alpha > 0, or null when it is empty. */
export function alphaBounds(
	px: Uint8Array,
	w: number,
	h: number,
): { x0: number; y0: number; x1: number; y1: number } | null {
	let x0 = w;
	let y0 = h;
	let x1 = -1;
	let y1 = -1;
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++)
			if (px[(y * w + x) * 4 + 3]! > 0) {
				if (x < x0) x0 = x;
				if (x > x1) x1 = x;
				if (y < y0) y0 = y;
				y1 = y;
			}
	return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** The `cw × ch` region at `(x, y)` of an RGBA image `w` px wide. */
export function cropRgba(
	px: Uint8Array,
	w: number,
	x: number,
	y: number,
	cw: number,
	ch: number,
): Uint8Array {
	const out = new Uint8Array(cw * ch * 4);
	for (let r = 0; r < ch; r++)
		out.set(px.subarray(((y + r) * w + x) * 4, ((y + r) * w + x + cw) * 4), r * cw * 4);
	return out;
}
