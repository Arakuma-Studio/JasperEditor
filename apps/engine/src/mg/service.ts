// Motion-graphics service (ARCHITECTURE §10.2, S04 §15): capability, template catalog, cached
// renders (<appdir>/mg/<renderKey>/), mg-render jobs and the master provider for native export.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import type { EngineJob, MgRenderSpec, MgTemplateCatalogEntry, MgTemplatesResponse } from '@jasper/api';
import { ENV } from '@jasper/config';
import {
	isAnimeTemplate,
	type MgRational,
	type MgRegistry,
	type MgSpecInput,
	mgRegistry,
	mgRenderKeyMaterial,
	resolveSpecParams,
	specFromClip,
} from '@jasper/mg-templates';
import type { RenderVisualClip } from '@jasper/project';
import {
	type MgBinaryResolution,
	type MgProbe,
	probeMgBinary,
	type ResolveMgOptions,
	resolveMgBinary,
} from './binary.ts';
import { type MgQuality, MgRenderError, renderPoster, runMgPipe } from './render.ts';
import { isAnimeTemplateClip } from './templates.ts';

/** CPU slots of one mg-render job (ARCHITECTURE §9.3); also the renderer/encoder thread count. */
const MG_RENDER_SLOTS = 4;
const MG_FILES = ['master.mov', 'preview.webm', 'poster.png'] as const;
const KEY_RE = /^[0-9a-f]{40}$/;

export type MgCapability = { fframes: 'ready' | 'unavailable'; fframesReason?: string };

export type MgRenderResultPaths = { key: string; dir: string; master: string; preview: string | null };

type MgJobRecord = {
	job: EngineJob;
	key: string;
	quality: MgQuality;
	spec: MgSpecInput;
	abort: AbortController;
	done: Promise<EngineJob>;
	resolveDone: (job: EngineJob) => void;
};

export type MgServiceOptions = {
	/** `<appdir>/mg` (ARCHITECTURE §4.3). */
	mgDir: string;
	env?: Record<string, string | undefined>;
	/**
	 * ffmpeg/ffprobe resolved by the engine (D-13 order: env → packaged resources → PATH); default:
	 * `JASPER_FFMPEG`/`JASPER_FFPROBE` or the names on PATH.
	 */
	tools?: { ffmpeg: string | null; ffprobe: string | null };
	resolve?: ResolveMgOptions;
	registry?: MgRegistry;
	/** Job event sink (`job.created|updated|finished`); wired to the engine broadcaster when present. */
	emit?: (type: 'job.created' | 'job.updated' | 'job.finished', job: EngineJob) => void;
	/** Concurrent mg-render jobs (default: cores / MG_RENDER_SLOTS, at least 1). */
	concurrency?: number;
	now?: () => Date;
};

export type MgService = ReturnType<typeof createMgService>;

export function createMgService(opts: MgServiceOptions) {
	const env = opts.env ?? process.env;
	const registry = opts.registry ?? mgRegistry;
	const now = opts.now ?? (() => new Date());
	const concurrency = opts.concurrency ?? Math.max(1, Math.floor(availableParallelism() / MG_RENDER_SLOTS));
	// Master = prores_ks (native FFmpeg, LGPL); preview = libvpx-vp9 with alpha (BSD). No GPL encoder.
	const tools = {
		ffmpeg: opts.tools?.ffmpeg || env[ENV.FFMPEG] || 'ffmpeg',
		ffprobe: opts.tools?.ffprobe || env[ENV.FFPROBE] || 'ffprobe',
	};
	let resolution: MgBinaryResolution = { path: null, reason: 'not probed yet', tried: [] };
	let probe: MgProbe = { status: 'unavailable', reason: 'not probed yet', binary: null };
	const jobs = new Map<string, MgJobRecord>();
	const byDedupe = new Map<string, MgJobRecord>();
	const queue: MgJobRecord[] = [];
	let running = 0;

	function capability(): MgCapability {
		return probe.status === 'ready'
			? { fframes: 'ready' }
			: { fframes: 'unavailable', fframesReason: probe.reason };
	}

	/** Resolves and probes the binary (startup; call again after `pnpm mg:build`). */
	async function refresh(): Promise<MgProbe> {
		resolution = resolveMgBinary({ env, ...opts.resolve });
		probe = await probeMgBinary(resolution);
		return probe;
	}

	function rendererVersion(): string {
		return probe.status === 'ready' ? probe.version.renderer : 'unavailable';
	}

	function tsEntry(d: ReturnType<MgRegistry['catalogJson']>[number]): MgTemplateCatalogEntry {
		return { ...d, native: false };
	}

	/** `GET /api/motion-graphics/templates`: from the binary when ready, else the TS catalog. */
	function templates(): MgTemplatesResponse {
		const ts = registry.catalogJson();
		if (probe.status !== 'ready') {
			return {
				templates: ts.map(tsEntry),
				renderer: { status: 'unavailable', reason: probe.reason },
			};
		}
		const native: MgTemplateCatalogEntry[] = probe.templates.map((t) => {
			const twin = ts.find((d) => d.id === t.id && d.version === t.version);
			return {
				id: t.id,
				version: t.version,
				name: t.name,
				category: t.category,
				paramsSchema: t.paramsSchema,
				defaults: t.defaults,
				introFrames: t.introFrames,
				outroFrames: t.outroFrames,
				defaultDurationSeconds: t.defaultDurationSeconds,
				...(twin?.description ? { description: twin.description } : {}),
				canvases: t.canvases,
				native: true,
			};
		});
		const nativeKeys = new Set(native.map((t) => `${t.id}@${t.version}`));
		return {
			templates: [...native, ...ts.filter((d) => !nativeKeys.has(`${d.id}@${d.version}`)).map(tsEntry)],
			renderer: { status: 'ready', version: probe.version.version },
		};
	}

	/**
	 * S11:ATP-008: anime templates are drawn by Remotion (baked by the layer-bake extension), never by jasper-mg.
	 * Throws MgRenderError('INVALID_SPEC', …, {code: 'ANIME_TEMPLATE'}) for them.
	 */
	function refuseAnime(spec: Pick<MgRenderSpec, 'template'>): void {
		const def = registry.getDefinition(spec.template.id, spec.template.version);
		if (def && isAnimeTemplate(def))
			throw new MgRenderError(
				'INVALID_SPEC',
				`${def.id}@${def.version} is an anime template: it is drawn by Remotion (previews, Remotion exports) and baked for native exports, not rendered by the fframes renderer`,
				{ code: 'ANIME_TEMPLATE' },
			);
	}

	/** Validates the template and params against the TS catalog (mirror of the Rust structs). */
	function validateSpec(spec: MgRenderSpec | MgSpecInput): MgSpecInput {
		refuseAnime(spec);
		const def = registry.getDefinition(spec.template.id, spec.template.version);
		if (!def)
			throw new MgRenderError(
				'INVALID_SPEC',
				`Unknown template ${spec.template.id}@${spec.template.version}`,
				{
					code: 'TEMPLATE_NOT_FOUND',
				},
			);
		const parsed = def.paramsSchema.safeParse(spec.params);
		if (!parsed.success)
			throw new MgRenderError(
				'INVALID_SPEC',
				`Invalid params for ${def.id}@${def.version}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
			);
		return {
			...spec,
			params: parsed.data as Record<string, unknown>,
			sourceInFrames: spec.sourceInFrames ?? 0,
		};
	}

	function renderKey(spec: MgSpecInput): string {
		const resolved = resolveSpecParams(spec, registry);
		return createHash('sha256')
			.update(mgRenderKeyMaterial(resolved, rendererVersion()))
			.digest('hex')
			.slice(0, 40);
	}

	function resultFor(key: string, quality: MgQuality) {
		return { key, url: `/mg/${key}/${quality === 'preview' ? 'preview.webm' : 'master.mov'}` };
	}

	function dirFor(key: string): string {
		return join(opts.mgDir, key);
	}

	/** Cached, verified artifacts for a key (null when the master is missing). */
	function cached(key: string): MgRenderResultPaths | null {
		if (!KEY_RE.test(key)) return null;
		const dir = dirFor(key);
		const metaPath = join(dir, 'meta.json');
		if (!existsSync(metaPath) || !existsSync(join(dir, 'master.mov'))) return null;
		try {
			const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { verified?: boolean };
			if (!meta.verified) return null;
		} catch {
			return null;
		}
		const preview = join(dir, 'preview.webm');
		return { key, dir, master: join(dir, 'master.mov'), preview: existsSync(preview) ? preview : null };
	}

	/** Absolute path of a cached file for `GET /mg/:key/:file` (null = not found / not allowed). */
	function fileFor(key: string, file: string): string | null {
		if (!KEY_RE.test(key) || !(MG_FILES as readonly string[]).includes(file)) return null;
		const p = join(dirFor(key), file);
		return existsSync(p) ? p : null;
	}

	function emit(type: 'job.created' | 'job.updated' | 'job.finished', rec: MgJobRecord) {
		try {
			opts.emit?.(type, { ...rec.job });
		} catch {
			// event sinks never break renders
		}
	}

	/** Terminal transition: emits job.finished and settles the job's `done` promise. */
	function finish(rec: MgJobRecord) {
		emit('job.finished', rec);
		lastUpdate.delete(rec.job.id);
		if (rec.job.dedupeKey && byDedupe.get(rec.job.dedupeKey) === rec) byDedupe.delete(rec.job.dedupeKey);
		rec.resolveDone({ ...rec.job });
		if (jobs.size > 500) {
			for (const [id, r] of jobs) {
				if (jobs.size <= 400) break;
				if (r.job.state !== 'queued' && r.job.state !== 'running' && r.job.state !== 'cancelling')
					jobs.delete(id);
			}
		}
	}

	const lastUpdate = new Map<string, number>();
	function update(rec: MgJobRecord, patch: Partial<EngineJob>, throttle = false) {
		Object.assign(rec.job, patch);
		const t = Date.now();
		if (throttle && t - (lastUpdate.get(rec.job.id) ?? 0) < 250) return; // ≤ 4/s/job (§9.2)
		lastUpdate.set(rec.job.id, t);
		emit('job.updated', rec);
	}

	async function execute(rec: MgJobRecord): Promise<void> {
		const { key, spec, quality } = rec;
		if (probe.status !== 'ready') throw new MgRenderError('BINARY_MISSING', probe.reason);
		const mgBinary = probe.binary;
		const hit = cached(key);
		if (hit && (quality === 'master' || hit.preview)) return;
		const tmp = join(opts.mgDir, key, `.tmp-${rec.job.id}`);
		mkdirSync(tmp, { recursive: true });
		try {
			const outputs = {
				master: join(tmp, 'master.mov'),
				...(quality === 'preview' ? { preview: join(tmp, 'preview.webm') } : {}),
			};
			update(rec, { stage: 'Rendering motion graphics' });
			await runMgPipe({
				tools: { mg: mgBinary, ...tools },
				spec,
				outputs,
				threads: MG_RENDER_SLOTS,
				signal: rec.abort.signal,
				onProgress: (f) => update(rec, { progress: Math.min(0.95, f * 0.95) }, true),
			});
			update(rec, { stage: 'Verifying', progress: 0.96 });
			const poster = join(tmp, 'poster.png');
			await renderPoster(mgBinary, spec, Math.floor(spec.durationFrames / 2), poster).catch(() => {});
			const dir = dirFor(key);
			for (const f of MG_FILES) {
				if (existsSync(join(tmp, f))) renameSync(join(tmp, f), join(dir, f));
			}
			writeFileSync(
				join(dir, 'meta.json'),
				`${JSON.stringify(
					{
						key,
						verified: true,
						frames: spec.durationFrames,
						spec,
						renderer: rendererVersion(),
						createdAt: now().toISOString(),
					},
					null,
					2,
				)}\n`,
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}

	function pump() {
		while (running < concurrency && queue.length > 0) {
			const rec = queue.shift()!;
			if (rec.job.state !== 'queued') continue;
			running++;
			update(rec, { state: 'running', startedAt: now().toISOString(), progress: 0 });
			execute(rec)
				.then(() => {
					update(rec, {
						state: 'succeeded',
						progress: 1,
						stage: undefined,
						finishedAt: now().toISOString(),
						result: resultFor(rec.key, rec.quality),
					});
				})
				.catch((e: unknown) => {
					const err = e instanceof MgRenderError ? e : new MgRenderError('RENDER_FAILED', String(e));
					const cancelled = err.code === 'JOB_CANCELLED' || rec.abort.signal.aborted;
					update(rec, {
						state: cancelled ? 'cancelled' : 'failed',
						finishedAt: now().toISOString(),
						stage: undefined,
						...(cancelled
							? {}
							: { error: { code: err.code, message: err.message, retryable: err.code === 'RENDER_FAILED' } }),
					});
				})
				.finally(() => {
					running--;
					finish(rec);
					pump();
				});
		}
	}

	/**
	 * Queues (or joins) an mg-render job. Cache hits complete immediately (content-addressed,
	 * S04:CA-001). Throws MgRenderError('INVALID_SPEC' | 'BINARY_MISSING').
	 */
	function requestRender(
		input: MgRenderSpec | MgSpecInput,
		quality: MgQuality,
		meta: { projectId?: string; origin?: EngineJob['origin']; parentId?: string } = {},
	): { job: EngineJob; done: Promise<EngineJob>; joined: boolean } {
		refuseAnime(input);
		if (probe.status !== 'ready') throw new MgRenderError('BINARY_MISSING', probe.reason);
		const spec = validateSpec(input);
		const key = renderKey(spec);
		const dedupeKey = `mg:${key}:${quality}`;
		const existing = byDedupe.get(dedupeKey);
		if (existing) return { job: { ...existing.job }, done: existing.done, joined: true };
		const id = `job_mg_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
		let resolveDone!: (j: EngineJob) => void;
		const done = new Promise<EngineJob>((r) => {
			resolveDone = r;
		});
		const rec: MgJobRecord = {
			job: {
				id,
				kind: 'mg-render',
				title: `Motion graphic ${spec.template.id}@${spec.template.version} (${quality})`,
				origin: meta.origin ?? { type: 'user' },
				...(meta.projectId ? { projectId: meta.projectId } : {}),
				...(meta.parentId ? { parentId: meta.parentId } : {}),
				state: 'queued',
				progress: 0,
				createdAt: now().toISOString(),
				priority: quality === 'preview' ? 'interactive' : 'user',
				cpuSlots: MG_RENDER_SLOTS,
				dedupeKey,
			},
			key,
			quality,
			spec,
			abort: new AbortController(),
			done,
			resolveDone,
		};
		jobs.set(id, rec);
		emit('job.created', rec);
		const hit = cached(key);
		if (hit && (quality === 'master' || hit.preview)) {
			const t = now().toISOString();
			Object.assign(rec.job, {
				state: 'succeeded',
				progress: 1,
				startedAt: t,
				finishedAt: t,
				result: resultFor(key, quality),
			});
			finish(rec);
			return { job: { ...rec.job }, done, joined: false };
		}
		byDedupe.set(dedupeKey, rec);
		queue.push(rec);
		pump();
		return { job: { ...rec.job }, done, joined: false };
	}

	function cancel(id: string): EngineJob | null {
		const rec = jobs.get(id);
		if (!rec) return null;
		if (rec.job.state === 'queued') {
			const i = queue.indexOf(rec);
			if (i >= 0) queue.splice(i, 1);
			Object.assign(rec.job, { state: 'cancelled', finishedAt: now().toISOString() });
			finish(rec);
		} else if (rec.job.state === 'running') {
			update(rec, { state: 'cancelling' });
			rec.abort.abort();
		}
		return { ...rec.job };
	}

	/** Re-queues a failed/cancelled render with the same spec and quality (`POST /api/jobs/:id/retry`). */
	function retry(id: string): EngineJob | null {
		const rec = jobs.get(id);
		if (!rec) return null;
		const j = rec.job;
		const ok = j.state === 'cancelled' || (j.state === 'failed' && j.error?.retryable !== false);
		if (!ok) return null;
		return requestRender(rec.spec, rec.quality, {
			...(j.projectId ? { projectId: j.projectId } : {}),
			...(j.parentId ? { parentId: j.parentId } : {}),
			origin: j.origin,
		}).job;
	}

	/** Cancels every queued/running render and waits for them to settle (engine shutdown). */
	async function shutdown(): Promise<void> {
		const active = [...jobs.values()].filter((r) =>
			['queued', 'running', 'cancelling'].includes(r.job.state),
		);
		for (const r of active) cancel(r.job.id);
		await Promise.all(active.map((r) => r.done));
	}

	/**
	 * Renders (or reuses) the master of a spec; null when fframes is unavailable, the render fails or
	 * `signal` aborts (a job this call started is then cancelled; a joined job keeps running).
	 */
	async function masterFor(
		spec: MgSpecInput,
		meta: { projectId?: string; parentId?: string; signal?: AbortSignal } = {},
	) {
		if (probe.status !== 'ready' || meta.signal?.aborted) return null;
		try {
			const { signal, ...jobMeta } = meta;
			const {
				job: started,
				done,
				joined,
			} = requestRender(spec, 'master', {
				...jobMeta,
				origin: { type: 'system' },
			});
			let onAbort: (() => void) | undefined;
			const aborted = new Promise<null>((resolve) => {
				onAbort = () => {
					if (!joined) cancel(started.id);
					resolve(null);
				};
				signal?.addEventListener('abort', onAbort, { once: true });
			});
			const job = await Promise.race([done, aborted]).finally(() => {
				if (onAbort) signal?.removeEventListener('abort', onAbort);
			});
			if (job?.state !== 'succeeded') return null;
			return cached(renderKey(validateSpec(spec)))?.master ?? null;
		} catch {
			return null;
		}
	}

	/**
	 * Hook for the WP-2F native export planner: the ProRes 4444 master of a motion-graphic clip,
	 * rendered on demand; null means "not available, plan this range with Remotion".
	 */
	async function mgMasterProvider(
		clip: Pick<RenderVisualClip, 'source' | 'duration' | 'sourceIn'>,
		ctx: { fps: MgRational; projectId?: string; parentId?: string; signal?: AbortSignal },
	): Promise<string | null> {
		// S11:ATP-008: anime templates have no jasper-mg master (layer-bake bakes them; null = Remotion path).
		if (isAnimeTemplateClip(clip, registry)) return null;
		const spec = specFromClip(clip, ctx.fps, registry);
		if (!spec) return null;
		return masterFor(spec, ctx);
	}

	/**
	 * M3 (wp-m3-cachegc, S04:CA-012): the `mg/<key>` render key of a motion-graphic clip (master and preview share it),
	 * or null (anime template, not an mg clip, invalid params). Lets the cache keep the renders saved projects use.
	 */
	function clipRenderKey(clip: Pick<RenderVisualClip, 'source' | 'duration' | 'sourceIn'>, fps: MgRational) {
		if (isAnimeTemplateClip(clip, registry)) return null;
		const spec = specFromClip(clip, fps, registry);
		if (!spec) return null;
		try {
			return renderKey(validateSpec(spec));
		} catch {
			return null;
		}
	}

	return {
		clipRenderKey,
		refresh,
		capability,
		probe: () => probe,
		resolution: () => resolution,
		templates,
		refuseAnime,
		validateSpec,
		renderKey,
		cached,
		fileFor,
		requestRender,
		cancel,
		retry,
		shutdown,
		getJob: (id: string) => {
			const rec = jobs.get(id);
			return rec ? { ...rec.job } : null;
		},
		listJobs: () => [...jobs.values()].map((r) => ({ ...r.job })),
		masterFor,
		mgMasterProvider,
	};
}
