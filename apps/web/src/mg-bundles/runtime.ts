// Composition clips in the editor (M2, S08:MGC-013/020…025, MGU-003/004): the per-session runtime behind the
// Composition layer's preview (cached VP9-alpha previews requested after 2 s without props changes, at once for
// clips with colour effects), live-host budget and status, master cache state (timeline ✓ badge, Properties
// status), "Render master now", and the `mgBundle.rebuilt` relink (a system transaction: no History entry).
import type { EngineJob, MgPrerenderRequest, MgPrerenderResult, TypedEvent } from '@jasper/api';
import {
	type CompositionPreview,
	type CompositionPreviewRuntime,
	compositionFramesAt,
	hasPixelEffects,
	setCompositionPreviewRuntime,
} from '@jasper/compositions';
import type { EngineClient } from '@jasper/engine-client';
import {
	buildRenderSnapshot,
	canonicalJson,
	compositionClipRenderRange,
	compositionRenderKeyMaterial,
	type ProjectDocument,
	type Rational,
	type RenderCompositionSource,
	type RenderVisualClip,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { mediaKeyOf } from '../import/assets.ts';

/** Live frame hosts mounted at once (S08:MGC-024). */
const MAX_LIVE_HOSTS = 4;
/** Props must be stable this long before a preview pre-render is requested (MGC-023). */
const PREVIEW_IDLE_MS = 2000;

type HostStatus = { state: 'loading' | 'rendering' | 'ready' | 'error'; message?: string };
type RenderStatus = {
	state: 'none' | 'scheduled' | 'queued' | 'rendering' | 'ready' | 'failed';
	progress?: number;
	error?: string;
	jobId?: string;
	result?: MgPrerenderResult;
};
export type ClipMgStatus = { host: HostStatus | null; preview: RenderStatus; master: RenderStatus };

const NONE: RenderStatus = { state: 'none' };

type EngineLink = {
	client: EngineClient;
	subscribe(listener: (e: TypedEvent | null) => void): () => void;
};

const fpsNum = (r: Rational) => r.num / r.den;

/** Composition clips of a sequence as the render snapshot sees them (effective props, handles). */
function compositionClips(
	doc: ProjectDocument,
	sequenceId: string,
): { clip: RenderVisualClip; src: RenderCompositionSource }[] {
	if (!doc.sequences[sequenceId]) return [];
	const hasComp = Object.values(doc.sequences[sequenceId]!.clips).some((c) => c.kind === 'composition');
	if (!hasComp) return [];
	const snap = buildRenderSnapshot(doc, sequenceId, { resolveMedia: () => null, resolveFont: () => null });
	const out: { clip: RenderVisualClip; src: RenderCompositionSource }[] = [];
	for (const clip of snap.videoTracks.flatMap((t) => t.clips))
		if ('composition' in clip.source) out.push({ clip, src: clip.source.composition });
	return out;
}

/** Preview request of a clip: the whole composition at the sequence rate, at the clip's canvas (MGC-023). */
function previewRequest(
	src: RenderCompositionSource,
	fps: Rational,
	projectId?: string,
): MgPrerenderRequest | null {
	if (!src.info || !src.bundle?.key) return null;
	return {
		...(projectId ? { projectId } : {}),
		mediaKey: src.bundle.key,
		compositionId: src.compositionId,
		props: src.props,
		width: src.canvas.width,
		height: src.canvas.height,
		fps: { num: fps.num, den: fps.den },
		startFrame: 0,
		durationFrames: compositionFramesAt(src.info, fpsNum(fps)),
		quality: 'preview',
	};
}

/** Master request of a clip: its drawn span incl. transition handles (what the native export renders). */
function masterRequest(
	clip: RenderVisualClip,
	src: RenderCompositionSource,
	fps: Rational,
	projectId?: string,
): MgPrerenderRequest | null {
	if (!src.info || !src.bundle?.key) return null;
	const total = compositionFramesAt(src.info, fpsNum(fps));
	const range = compositionClipRenderRange(clip, fps, total);
	return {
		...(projectId ? { projectId } : {}),
		mediaKey: src.bundle.key,
		compositionId: src.compositionId,
		props: src.props,
		width: src.canvas.width,
		height: src.canvas.height,
		fps: { num: fps.num, den: fps.den },
		startFrame: range.startFrame,
		durationFrames: range.durationFrames,
		quality: 'master',
	};
}

/** Stable identity of a request (without quality/project). */
function requestKey(req: MgPrerenderRequest): string {
	const { quality: _q, projectId: _p, ...rest } = req;
	return canonicalJson(rest);
}

/** The engine's render key (sha256 → 40 hex) of a request, for cache lookups (MGC-031). */
async function renderKeyOf(req: MgPrerenderRequest, bundleHash: string): Promise<string> {
	const material = compositionRenderKeyMaterial({ ...req, bundleHash });
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, 40);
}

/** Key the layer uses for `previewFor` (numeric fps: the layer only knows `fps` as a number). */
function layerPreviewKey(src: RenderCompositionSource, fps: number): string {
	return canonicalJson([src.bundle?.key, src.compositionId, src.props, src.canvas, Math.round(fps * 1e6)]);
}

export class MgRuntime implements CompositionPreviewRuntime {
	private ver = 0;
	private readonly listeners = new Set<() => void>();
	/** layer key → ready preview. */
	private readonly previews = new Map<string, CompositionPreview>();
	/** request key → status (previews and masters). */
	private readonly renders = new Map<string, RenderStatus>();
	/** job id → request key. */
	private readonly jobs = new Map<
		string,
		{ key: string; quality: 'preview' | 'master'; layerKey?: string }
	>();
	private readonly recentJobs = new Map<string, EngineJob>();
	private readonly scheduled = new Map<string, { key: string; timer: ReturnType<typeof setTimeout> }>();
	private readonly hosts = new Map<string, HostStatus>();
	/** clipId → current request keys. */
	private readonly clipKeys = new Map<string, { preview: string | null; master: string | null }>();
	private readonly masterLookups = new Set<string>();
	/** wp-m3-mgtext (S08:MGU-005): the clip whose texts are edited on canvas shows its live host. */
	private textEditing: string | null = null;
	private readonly offs: (() => void)[] = [];
	private disposed = false;
	private scanTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		readonly session: EditorSession,
		private readonly engine: EngineLink,
	) {
		this.offs.push(session.on('doc.changed', () => this.scanSoon()));
		this.offs.push(
			session.store.subscribe((s, p) => s.activeSequenceId !== p.activeSequenceId && this.scanSoon()),
		);
		this.offs.push(engine.subscribe((e) => e && this.onEvent(e)));
		this.scanSoon(0);
	}

	dispose(): void {
		this.disposed = true;
		for (const off of this.offs.splice(0)) off();
		for (const s of this.scheduled.values()) clearTimeout(s.timer);
		this.scheduled.clear();
		if (this.scanTimer) clearTimeout(this.scanTimer);
	}

	subscribe = (cb: () => void): (() => void) => {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	};
	version = (): number => this.ver;

	private notify(): void {
		this.ver++;
		for (const l of [...this.listeners]) l();
	}

	previewFor(clip: RenderVisualClip, src: RenderCompositionSource, fps: number): CompositionPreview | null {
		if (clip.clipId === this.textEditing) return null;
		return this.previews.get(layerPreviewKey(src, fps)) ?? null;
	}

	/**
	 * On-canvas text editing (wp-m3-mgtext, S08:MGU-005): the clip shows its live frame host (the page whose DOM
	 * the editor reads) instead of the cached preview until `null`.
	 */
	setTextEditing(clipId: string | null): void {
		if (this.textEditing === clipId) return;
		this.textEditing = clipId;
		// MGC-024 budget: a clip without a first-come slot takes the one of the holder farthest from the playhead.
		const hasSlot = !!clipId && this.mountedHosts.slice(0, MAX_LIVE_HOSTS).includes(clipId);
		this.evictedForEdit = clipId && !hasSlot ? this.farthestHolder(clipId) : null;
		this.notify();
	}

	/** Clips with a mounted composition layer, in mount order (MGC-024 is first-come). */
	private readonly mountedHosts: string[] = [];
	/** The clip that gave its live host up to the clip edited on canvas (wp-m3-mgtext). */
	private evictedForEdit: string | null = null;

	acquireHost(clipId: string): (() => void) | null {
		if (!this.mountedHosts.includes(clipId)) this.mountedHosts.push(clipId);
		this.notifySoon();
		return () => {
			const i = this.mountedHosts.indexOf(clipId);
			if (i >= 0) this.mountedHosts.splice(i, 1);
			this.hosts.delete(clipId);
			this.notifySoon();
		};
	}

	/**
	 * At most MAX_LIVE_HOSTS live hosts (MGC-024): first-come among the mounted clips, except that the clip edited
	 * on canvas always gets one — the mounted clip farthest from the playhead gives up its slot meanwhile.
	 */
	hostAllowed(clipId: string): boolean {
		const editing =
			this.textEditing && this.mountedHosts.includes(this.textEditing) ? this.textEditing : null;
		if (clipId === editing) return true;
		const others = this.mountedHosts.filter((id) => id !== editing && id !== this.evictedForEdit);
		const slots = editing ? MAX_LIVE_HOSTS - 1 : MAX_LIVE_HOSTS;
		return others.slice(0, slots).includes(clipId);
	}

	/** The mounted clip farthest from the playhead among the first-come holders (null when a slot is free). */
	private farthestHolder(except: string): string | null {
		const holders = this.mountedHosts.filter((id) => id !== except).slice(0, MAX_LIVE_HOSTS);
		if (holders.length < MAX_LIVE_HOSTS) return null;
		const s = this.session.store.getState();
		const seq = s.activeSequenceId ? s.document.sequences[s.activeSequenceId] : undefined;
		const f = this.session.transport.getState().frame;
		let best: string | null = null;
		let bestD = -1;
		for (const id of holders) {
			const c = seq?.clips[id];
			const d = c
				? f < c.start
					? c.start - f
					: f >= c.start + c.duration
						? f - (c.start + c.duration - 1)
						: 0
				: 1e12;
			if (d > bestD) {
				best = id;
				bestD = d;
			}
		}
		return best;
	}

	private notifyTimer: ReturnType<typeof setTimeout> | null = null;
	private notifySoon(): void {
		if (this.notifyTimer) return;
		this.notifyTimer = setTimeout(() => {
			this.notifyTimer = null;
			if (!this.disposed) this.notify();
		}, 0);
	}

	reportHost(clipId: string, status: HostStatus): void {
		const prev = this.hosts.get(clipId);
		if (prev?.state === status.state && prev.message === status.message) return;
		this.hosts.set(clipId, status);
		this.notify();
	}

	status(clipId: string): ClipMgStatus {
		const keys = this.clipKeys.get(clipId);
		return {
			host: this.hosts.get(clipId) ?? null,
			preview: (keys?.preview && this.renders.get(`preview:${keys.preview}`)) || NONE,
			master: (keys?.master && this.renders.get(`master:${keys.master}`)) || NONE,
		};
	}

	private scanSoon(ms = 150): void {
		if (this.disposed) return;
		if (this.scanTimer) clearTimeout(this.scanTimer);
		this.scanTimer = setTimeout(() => {
			this.scanTimer = null;
			this.scan();
		}, ms);
	}

	/** Recomputes every composition clip's requests; schedules previews and master cache lookups. */
	private scan(): void {
		if (this.disposed) return;
		const s = this.session.store.getState();
		const seqId = s.activeSequenceId;
		const doc = s.document;
		const seq = seqId ? doc.sequences[seqId] : undefined;
		if (!seqId || !seq) return;
		const fps = seq.settings.frameRate;
		const seen = new Set<string>();
		for (const { clip, src } of compositionClips(doc, seqId)) {
			seen.add(clip.clipId);
			const pre = previewRequest(src, fps, this.session.projectId);
			const mas = masterRequest(clip, src, fps, this.session.projectId);
			const pk = pre ? requestKey(pre) : null;
			const mk = mas ? requestKey(mas) : null;
			this.clipKeys.set(clip.clipId, { preview: pk, master: mk });
			if (pre && pk) this.schedulePreview(clip, src, fpsNum(fps), pre, pk);
			if (mas && mk && src.bundle) void this.lookupMaster(mas, mk, src.bundle.hash);
		}
		for (const id of [...this.clipKeys.keys()]) if (!seen.has(id)) this.clipKeys.delete(id);
		this.notify();
	}

	private schedulePreview(
		clip: RenderVisualClip,
		src: RenderCompositionSource,
		fps: number,
		req: MgPrerenderRequest,
		key: string,
	): void {
		const status = this.renders.get(`preview:${key}`);
		if (status && status.state !== 'none' && status.state !== 'failed') return;
		const existing = this.scheduled.get(clip.clipId);
		if (existing?.key === key) return;
		if (existing) {
			clearTimeout(existing.timer);
			if (this.renders.get(`preview:${existing.key}`)?.state === 'scheduled')
				this.renders.delete(`preview:${existing.key}`);
		}
		// Colour effects cannot read the live iframe: ask for the preview at once (MGC-025).
		const delay = hasPixelEffects(clip) ? 0 : PREVIEW_IDLE_MS;
		const layerKey = layerPreviewKey(src, fps);
		this.renders.set(`preview:${key}`, { state: 'scheduled' });
		const timer = setTimeout(() => {
			this.scheduled.delete(clip.clipId);
			void this.submit(req, key, layerKey);
		}, delay);
		this.scheduled.set(clip.clipId, { key, timer });
	}

	/** Checks the engine cache for the master of the current props (one request per key). */
	private async lookupMaster(req: MgPrerenderRequest, key: string, bundleHash: string): Promise<void> {
		if (this.renders.has(`master:${key}`) || this.masterLookups.has(key)) return;
		this.masterLookups.add(key);
		try {
			const renderKey = await renderKeyOf(req, bundleHash);
			const hit = await this.engine.client.call('mgBundlePrerenderGet', { params: { renderKey } });
			if (hit.masterUrl) this.renders.set(`master:${key}`, { state: 'ready', result: hit });
			else this.renders.set(`master:${key}`, NONE);
		} catch {
			this.renders.set(`master:${key}`, NONE);
		} finally {
			this.masterLookups.delete(key);
			this.notify();
		}
	}

	private async submit(req: MgPrerenderRequest, key: string, layerKey?: string): Promise<EngineJob | null> {
		const slot = `${req.quality}:${key}`;
		this.renders.set(slot, { state: 'queued' });
		this.notify();
		try {
			const job = await this.engine.client.call('mgBundlePrerender', { body: req });
			this.jobs.set(job.id, { key, quality: req.quality, ...(layerKey ? { layerKey } : {}) });
			const newer = this.recentJobs.get(job.id);
			this.onJob(newer && (newer.finishedAt || !job.finishedAt) ? newer : job);
			return job;
		} catch (e) {
			this.renders.set(slot, { state: 'failed', error: e instanceof Error ? e.message : String(e) });
			this.notify();
			return null;
		}
	}

	private onEvent(e: TypedEvent): void {
		if (e.type === 'job.created' || e.type === 'job.updated' || e.type === 'job.finished') {
			// Events can overtake the HTTP response of the submit: remember the latest state of every pre-render.
			if (e.payload.kind === 'mg-prerender') {
				this.recentJobs.set(e.payload.id, e.payload);
				if (this.recentJobs.size > 200) this.recentJobs.delete(this.recentJobs.keys().next().value!);
			}
			this.onJob(e.payload);
		} else if (e.type === 'mgBundle.rebuilt') this.onRebuilt(e.payload);
	}

	private onJob(job: EngineJob): void {
		const t = this.jobs.get(job.id);
		if (!t) return;
		const slot = `${t.quality}:${t.key}`;
		if (job.state === 'succeeded') {
			const result = job.result as MgPrerenderResult | undefined;
			this.jobs.delete(job.id);
			if (t.quality === 'preview' && result?.previewUrl && t.layerKey) {
				const layerKey = t.layerKey;
				// Warm the HTTP cache first so the layer switches without a visual jump (MGC-023).
				void fetch(result.previewUrl)
					.then((r) => r.arrayBuffer())
					.catch(() => undefined)
					.finally(() => {
						this.previews.set(layerKey, {
							url: result.previewUrl,
							startFrame: result.startFrame ?? 0,
							durationFrames: result.durationFrames ?? 1,
						});
						this.renders.set(slot, { state: 'ready', result });
						// A preview render of the full range does not make the master; masters report separately.
						this.notify();
					});
				return;
			}
			this.renders.set(slot, { state: 'ready', ...(result ? { result } : {}) });
		} else if (job.state === 'failed' || job.state === 'cancelled' || job.state === 'interrupted') {
			this.jobs.delete(job.id);
			this.renders.set(slot, { state: 'failed', error: job.error?.message ?? job.state, jobId: job.id });
		} else {
			this.renders.set(slot, {
				state: job.state === 'queued' ? 'queued' : 'rendering',
				progress: job.progress ?? 0,
				jobId: job.id,
			});
		}
		this.notify();
	}

	/** Relinks the asset of a rebuilt bundle (system transaction, no History entry, MGC-013). */
	private onRebuilt(ev: Extract<TypedEvent, { type: 'mgBundle.rebuilt' }>['payload']): void {
		const doc = this.session.getCommitted();
		const asset = Object.values(doc.media).find((m) => m.kind === 'mg-bundle' && mediaKeyOf(m) === ev.oldKey);
		if (!asset || this.session.getState().readOnly) return;
		const loc = asset.locators.find((l) => l.type === 'engine-store');
		const engineId = loc && loc.type === 'engine-store' ? loc.engineId : 'local';
		this.session.apply({
			label: 'Rebuild Remotion bundle',
			origin: 'system',
			commands: [
				{
					type: 'media.relink',
					mediaId: asset.id,
					locator: { type: 'engine-store', engineId, key: ev.newKey },
					fingerprint: `q1:${ev.mgBundle.bundleHash}`,
					mgBundle: ev.mgBundle,
					...(ev.sizeBytes !== undefined ? { sizeBytes: ev.sizeBytes } : {}),
				},
			] as never,
		});
	}

	/** "Render master now" (MGU-003): the master of the clip's drawn span with its current props. */
	async renderMaster(clipId: string): Promise<EngineJob | null> {
		const s = this.session.store.getState();
		const seqId = s.activeSequenceId;
		if (!seqId) return null;
		const found = compositionClips(s.document, seqId).find((x) => x.clip.clipId === clipId);
		const seq = s.document.sequences[seqId]!;
		if (!found) return null;
		const req = masterRequest(found.clip, found.src, seq.settings.frameRate, this.session.projectId);
		if (!req) return null;
		return this.submit(req, requestKey(req));
	}
}

let current: MgRuntime | null = null;
const facadeListeners = new Set<() => void>();

/** The runtime installed for the Composition layer: delegates to the current session's runtime. */
const facade: CompositionPreviewRuntime = {
	previewFor: (clip, src, fps) => current?.previewFor(clip, src, fps) ?? null,
	subscribe: (cb) => {
		facadeListeners.add(cb);
		const off = current?.subscribe(cb);
		return () => {
			facadeListeners.delete(cb);
			off?.();
		};
	},
	version: () => (current ? current.version() : -1),
	acquireHost: (clipId) => (current ? current.acquireHost(clipId) : () => undefined),
	hostAllowed: (clipId) => (current ? current.hostAllowed(clipId) : true),
	reportHost: (clipId, status) => current?.reportHost(clipId, status),
};

/** Attaches (idempotently) the runtime of `session`; returns it. */
export function ensureMgRuntime(session: EditorSession, engine: EngineLink): MgRuntime {
	if (current?.session === session) return current;
	current?.dispose();
	current = new MgRuntime(session, engine);
	setCompositionPreviewRuntime(facade);
	for (const cb of facadeListeners) {
		current.subscribe(cb);
		cb();
	}
	return current;
}

export function currentMgRuntime(): MgRuntime | null {
	return current;
}
