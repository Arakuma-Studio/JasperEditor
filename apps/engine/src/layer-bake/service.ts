// Layer bake service (M2, S11 §6, LBK-003…005/010/020…026): plans and renders the cached alpha masters of DOM
// layers (text, shapes, anime templates) and their graded variants.
//
//   <appdir>/cache/layers/<key>/
//     master.mov    ProRes 4444 yuva444p10le, straight alpha, BT.709 — the drawn span (non-static layers)
//     still.png     one straight-alpha PNG (static layers, LBK-004; single frames of stills, LBK-025)
//     graded.mov    graded entries: the bake + the clip's colour runs (lut3d) — Remotion path (LBK-010)
//     preview.webm  graded entries: VP9 alpha at half size — the Program preview of a graded DOM layer
//     meta.json     {key, recipe, rect, frames, …, lastUsedAt}; GC removes entries unused for 14 days (LBK-021)
//
// Renders run in `layer-bake` jobs (child jobs of the export/still, 0 CPU slots, LBK-022) through
// `RemotionService.renderAlphaMaster` / `renderStill`; every render is logged for licence reporting (LBK-026).
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineJob } from '@jasper/api';
import {
	contentTimeAt,
	type MediaHandle,
	mediaDecodeHints,
	type RenderSnapshot,
	type RenderVisualClip,
	resolveLayerProps,
} from '@jasper/project';
import { quoteFilterPath } from '../color/extension.ts';
import { colorRunFilters, SWS_FLAGS } from '../export/native.ts';
import type { NativeExtension } from '../export/native-ext.ts';
import { mediaKeyOf, type PlannedExport } from '../export/planner.ts';
import type { JobContext } from '../jobs/types.ts';
import { JobError } from '../jobs/types.ts';
import { REMOTION_VERSION } from '../remotion/service.ts';
import { Ffmpeg, sec } from '../tools/ffmpeg.ts';
import { atomicWriteJson, readJsonOrNull } from '../tools/fs.ts';
import { binaryNames } from '../tools/lgpl.ts';
import type { CoreServices } from '../tools/services.ts';
import {
	type BakeEnvironment,
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

/** Entries unused for this long are removed by the GC pass (S11:LBK-021). */
export const LAYER_CACHE_TTL_MS = 14 * 24 * 3600 * 1000;
/** Border alpha (0…255) above which a cropped bake counts as clipped and is rendered full frame instead. */
export const RECT_CLIP_ALPHA = 2;

/** Engine-relative URL of a cache file (served by `GET /mg/layers/:key/:file`, signable for renders). */
export const layerFileUrl = (key: string, file: string) => `/mg/layers/${key}/${file}`;
export const LAYER_FILES: ReadonlySet<string> = new Set([
	'master.mov',
	'still.png',
	'graded.mov',
	'preview.webm',
]);

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
};

/** A graded entry (Remotion path / preview, LBK-010): bake + colour runs. */
export type GradePlan = {
	key: string;
	source: { key: string; recipe: BakeVariant['recipe'] };
	/** ffmpeg filters of the colour runs over the bake's frames (`n` counts from its frame 0). */
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

export type LayerBakeJobInput =
	| { op: 'bake'; bake: BakePlan; concurrency?: number }
	| {
			op: 'grade';
			bake: BakePlan;
			grade: GradePlan;
			outputs: ('graded' | 'preview')[];
			concurrency?: number;
	  };

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

export type LayerBakeOptions = {
	core: CoreServices;
	log?(msg: string): void;
	now?: () => Date;
};

const GL_PROBE_TIMEOUT_MS = 60_000;

export class LayerBakeService {
	readonly dir: string;
	private readonly hashes = new FileHashCache();
	private readonly now: () => Date;
	private gcTimer: NodeJS.Timeout | null = null;
	private bytes = 0;
	private bytesPending: Promise<void> | null = null;
	/** Bakes rendered / reused since start (tests, logs). */
	readonly stats = { rendered: 0, reused: 0, graded: 0, clippedFallbacks: 0 };

	constructor(private readonly o: LayerBakeOptions) {
		this.dir = join(o.core.config.paths.cacheDir, 'layers');
		this.now = o.now ?? (() => new Date());
	}

	private get core(): CoreServices {
		return this.o.core;
	}

	/** Every registered native extension (the graded variants ask the colour extension for its filters). */
	extensions(): readonly NativeExtension[] {
		return this.core.exports.nativeExtensions.all();
	}

	// ------------------------------------------------------------------ capability (LBK-030, LBK-024)

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
				for (const f of await readdir(join(this.dir, name)).catch(() => [] as string[]))
					total += await stat(join(this.dir, name, f))
						.then((s) => s.size)
						.catch(() => 0);
			}
			this.bytes = total;
		})().finally(() => {
			this.bytesPending = null;
		});
		return this.bytesPending;
	}

	// ------------------------------------------------------------------ lifecycle

	registerRunners(): void {
		this.core.queue.registerRunner('layer-bake', (ctx) => this.run(ctx));
	}

	async start(): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		void this.gc().catch(() => undefined);
		this.gcTimer = setInterval(() => void this.gc().catch(() => undefined), 24 * 3600 * 1000);
		this.gcTimer.unref();
	}

	stop(): void {
		if (this.gcTimer) clearInterval(this.gcTimer);
		this.gcTimer = null;
	}

	/** Removes entries unused for `ttlMs` (default 14 days) and stale partial files. Returns the count removed. */
	async gc(ttlMs = LAYER_CACHE_TTL_MS): Promise<number> {
		let removed = 0;
		const now = this.now().getTime();
		for (const name of await readdir(this.dir).catch(() => [] as string[])) {
			const dir = join(this.dir, name);
			if (!KEY_RE.test(name)) continue;
			const meta = await readJsonOrNull<LayerMeta>(join(dir, 'meta.json'));
			const used = meta ? Date.parse(meta.lastUsedAt ?? meta.createdAt) : Number.NaN;
			const age = Number.isFinite(used)
				? now - used
				: now -
					(await stat(dir)
						.then((s) => s.mtimeMs)
						.catch(() => now));
			if (age > ttlMs) {
				await rm(dir, { recursive: true, force: true });
				removed++;
			}
		}
		if (removed) await this.refreshBytes();
		return removed;
	}

	// ------------------------------------------------------------------ cache

	private entryDir(key: string): string {
		return join(this.dir, key);
	}

	/** Absolute path of a cache file (validated key and file name), or null when missing. */
	filePath(key: string, file: string): string | null {
		if (!KEY_RE.test(key) || !LAYER_FILES.has(file)) return null;
		const p = join(this.entryDir(key), file);
		return existsSync(p) ? p : null;
	}

	async meta(key: string): Promise<LayerMeta | null> {
		if (!KEY_RE.test(key)) return null;
		const m = await readJsonOrNull<LayerMeta>(join(this.entryDir(key), 'meta.json'));
		return m?.kind === 'layer' ? m : null;
	}

	/** The cached bake of a key (files present), marked as used; null on a miss. */
	async lookup(key: string): Promise<BakeResult | null> {
		const meta = await this.meta(key);
		if (!meta || meta.recipe === 'graded') return null;
		const still = meta.recipe !== 'master';
		const path = this.filePath(key, still ? 'still.png' : 'master.mov');
		if (!path) return null;
		void this.markUsed(key, meta);
		return { key, path, still, rect: meta.rect, frames: meta.frames, width: meta.width, height: meta.height };
	}

	private async markUsed(key: string, meta: LayerMeta): Promise<void> {
		await atomicWriteJson(join(this.entryDir(key), 'meta.json'), {
			...meta,
			lastUsedAt: this.now().toISOString(),
		}).catch(() => undefined);
	}

	// ------------------------------------------------------------------ planning (LBK-003/004/005/020)

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

	/** Media handle with a signed engine URL (what the headless browser loads). */
	private signedHandle(planned: Pick<PlannedExport, 'document' | 'media'>, id: string): MediaHandle | null {
		const local = planned.media[id];
		const asset = planned.document.media[id];
		const key = asset ? mediaKeyOf(asset) : null;
		if (!local || !asset || !key) return null;
		const r = local.record;
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
			return {
				mediaId,
				fingerprint: local?.record.fingerprint ?? planned.document.media[mediaId]?.fingerprint ?? null,
				size: local?.record.sizeBytes ?? null,
				mtime: local ? Math.round(local.record.mtimeMs) : null,
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
		return out.sort((a, b) => canonicalSort(a, b));
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
		const colorRuns = hasColorEffects(clip);
		const asBaked = bakeClip(clip, { variant: { recipe: 'master' }, stripColor: true });
		const isStatic = isStaticLayer(asBaked);
		const span = drawnSpan(clip);
		const full = await this.plan(planned, clip, isStatic ? { recipe: 'still' } : { recipe: 'master' }, o.env);
		if (o.frame === undefined || o.frame === null || isStatic) return { ...full, colorRuns };
		if (await this.lookup(full.key)) return { ...full, colorRuns };
		const one = await this.plan(planned, clip, { recipe: 'frame', frame: o.frame - span.start }, o.env);
		return { ...one, colorRuns };
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
			graded: false,
		};
		const docOf = (c: RenderVisualClip, r: Rect | null) =>
			bakeDoc(snap, c, { variant, rect: r, media, fonts: signedFonts });
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
			colorRuns: false,
			material,
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
		const colorFx = clip.effects
			.filter((fx) => fx.enabled && isColorEffect(fx))
			.map(({ id: _id, ...fx }) => fx);
		const luts = this.keyMedia(planned, referencedMediaIds(colorFx));
		const material: KeyMaterial = {
			...bake.material,
			span: frames,
			// The grade's keyframes run in content time: the clip's timing relative to the graded frames matters.
			clip: {
				...bake.material.clip,
				gradeStart: clip.start - f0,
				sourceIn: clip.sourceIn,
				speed: clip.speed,
			},
			graded: { source: bake.key, effects: colorFx, luts },
		};
		return {
			key: keyOf(material),
			source: { key: bake.key, recipe: bake.variant.recipe },
			filters,
			frames,
			fps: { num: planned.snapshot.settings.fps.num, den: planned.snapshot.settings.fps.den },
			material,
		};
	}

	// ------------------------------------------------------------------ jobs (LBK-022)

	/**
	 * Returns the bake of `plan`, rendering it in a child job of `parentId` when not cached. `stage` gets the
	 * parent's stage text. Throws a JobError when the bake fails.
	 */
	async ensureBake(
		plan: BakePlan,
		meta: { parentId: string; projectId?: string; signal: AbortSignal; concurrency?: number },
	): Promise<BakeResult> {
		const hit = await this.lookup(plan.key);
		if (hit) {
			this.stats.reused++;
			return hit;
		}
		await this.runChild(
			{ op: 'bake', bake: plan, ...(meta.concurrency ? { concurrency: meta.concurrency } : {}) },
			plan,
			meta,
		);
		const done = await this.lookup(plan.key);
		if (!done) throw new JobError('LAYER_BAKE_FAILED', `The bake of "${plan.clipName}" is missing`, true);
		return done;
	}

	/** The graded master (`graded.mov`) of a planned grade, rendered in a child job when missing. */
	async ensureGraded(
		bake: BakePlan,
		grade: GradePlan,
		meta: { parentId: string; projectId?: string; signal: AbortSignal; concurrency?: number },
	): Promise<{ key: string; path: string; rect: Rect | null }> {
		const cached = this.filePath(grade.key, 'graded.mov');
		const m = cached ? await this.meta(grade.key) : null;
		if (cached && m) {
			void this.markUsed(grade.key, m);
			return { key: grade.key, path: cached, rect: m.rect };
		}
		await this.runChild(
			{
				op: 'grade',
				bake,
				grade,
				outputs: ['graded'],
				...(meta.concurrency ? { concurrency: meta.concurrency } : {}),
			},
			bake,
			meta,
		);
		const path = this.filePath(grade.key, 'graded.mov');
		const done = await this.meta(grade.key);
		if (!path || !done)
			throw new JobError('LAYER_BAKE_FAILED', `The graded master of "${bake.clipName}" is missing`, true);
		return { key: grade.key, path, rect: done.rect };
	}

	private async runChild(
		input: LayerBakeJobInput,
		plan: BakePlan,
		meta: { parentId: string; projectId?: string; signal: AbortSignal },
	): Promise<void> {
		const key = input.op === 'grade' ? input.grade.key : plan.key;
		const job = this.core.queue.submit({
			kind: 'layer-bake',
			title: `${input.op === 'grade' ? 'Grade graphics' : 'Bake graphics'} – ${plan.clipName}`,
			priority: 'user',
			cpuSlots: 0,
			minSlots: 0,
			origin: { type: 'system' },
			parentId: meta.parentId,
			...(meta.projectId ? { projectId: meta.projectId } : {}),
			dedupeKey: `layer-bake:${key}:${meta.parentId}`,
			input,
			stage: 'Queued',
		});
		const onAbort = () => this.core.queue.cancel(job.id);
		meta.signal.addEventListener('abort', onAbort, { once: true });
		try {
			const done = await this.core.queue.wait(job.id);
			if (meta.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
			if (done.state !== 'succeeded')
				throw new JobError(
					done.error?.code ?? 'LAYER_BAKE_FAILED',
					`Baking "${plan.clipName}" failed: ${done.error?.message ?? done.state}`,
					done.error?.retryable ?? true,
				);
		} finally {
			meta.signal.removeEventListener('abort', onAbort);
		}
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

	// ------------------------------------------------------------------ runner

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
		try {
			const bake = await this.renderBake(ctx, input.bake, input.concurrency, input.op === 'bake' ? 1 : 0.7);
			if (input.op === 'bake') return bake;
			const out = await this.renderGrade(ctx, input.bake, bake, input.grade, input.outputs);
			return out;
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
			void this.refreshBytes();
		}
	}

	private inputProps(doc: RenderSnapshot, clipId: string): Record<string, unknown> {
		return {
			doc,
			options: { isPreview: false, useProxies: false, transparentBackground: true, layerFilter: [clipId] },
		};
	}

	/** Renders a bake into its cache entry (no-op when cached). */
	private async renderBake(
		ctx: JobContext,
		plan: BakePlan,
		concurrency: number | undefined,
		weight: number,
	): Promise<BakeResult> {
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
					inputProps: this.inputProps(doc, plan.clipId),
					output: tmp,
					frame: 0,
					signal: ctx.signal,
					purpose: 'layer-bake',
				});
				ctx.progress(weight * 0.9, { stage: 'Rendering 1/1 frames' });
			} else {
				await this.core.remotion.renderAlphaMaster({
					inputProps: this.inputProps(doc, plan.clipId),
					output: tmp,
					scratchDir: scratch,
					signal: ctx.signal,
					ffmpeg: ff,
					...(concurrency ? { concurrency } : {}),
					onSpawn: ctx.trackChild,
					onProgress: (p) =>
						ctx.progress(p.progress * weight * 0.9, {
							stage: `Rendering ${p.renderedFrames}/${p.totalFrames} frames`,
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
			this.stats.clippedFallbacks++;
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
		if (outputs.includes('graded') && !this.filePath(grade.key, 'graded.mov')) {
			ctx.progress(0.75, { stage: 'Grading' });
			const tmp = join(scratch, 'graded.mov');
			await ff.run(
				[
					...input,
					'-map',
					'0:v:0',
					'-vf',
					[...base, 'format=rgba'].join(','),
					// Lossless RGBA (PNG frames in MOV): no YUV matrix/range for the Remotion compositor to interpret
					// (ProRes 4444 graded masters came out ±7 code values off on the Remotion path, tagged TV or full).
					'-c:v',
					'png',
					'-pix_fmt',
					'rgba',
					'-frames:v',
					String(grade.frames),
					'-an',
					'-f',
					'mov',
					tmp,
				],
				{ signal: ctx.signal, onSpawn: ctx.trackChild },
			);
			const n = await ff.countVideoFrames(tmp, { signal: ctx.signal });
			if (n !== grade.frames)
				throw new JobError(
					'FRAME_COUNT_MISMATCH',
					`The graded master has ${n} frames, expected ${grade.frames}`,
					true,
				);
			await rename(tmp, join(dir, 'graded.mov'));
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
		this.stats.graded++;
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
		return { key: grade.key, path: join(dir, 'graded.mov') };
	}
}

function canonicalSort(a: KeyFont, b: KeyFont): number {
	return `${a.family}|${a.weight}|${a.style}`.localeCompare(`${b.family}|${b.weight}|${b.style}`);
}
