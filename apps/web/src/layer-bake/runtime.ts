// Graded previews of DOM layers in the editor (M2, S11:LBK-010 — FIX-002; owner wp-m2-layer-bake). Text, shapes and
// anime templates have no colour stage in the browser: when such a layer has colour effects, this runtime asks the
// engine for a graded VP9-alpha preview (`POST /api/layer-bake/preview`) 2 s after the layer last changed
// (S08:MGC-023 pattern) and hands it to the compositions' baked-layer wrapper (`setBakedLayerRuntime`), which plays
// it instead of the ungraded DOM layer. Until it exists the layer shows ungraded with a "Grade pending" chip.
// Previews are matched to the layer by an identity of everything that changes its pixels except its position in
// time (moving a clip keeps its preview; editing text, grade or Motion asks for a new one).
import type { EngineJob, LayerBakePreviewResult, TypedEvent } from '@jasper/api';
import {
	type BakedLayerPreview,
	type BakedLayerRuntime,
	hasDomColorEffects,
	setBakedLayerRuntime,
} from '@jasper/compositions';
import type { EngineClient } from '@jasper/engine-client';
import {
	buildRenderSnapshot,
	canonicalJson,
	type ProjectDocument,
	type RenderVisualClip,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { exportEnvelope } from '../export/settings.ts';

/** The layer must be unchanged this long before a preview is requested (S11:LBK-010). */
const PREVIEW_IDLE_MS = 2000;

export type EngineLink = {
	client: EngineClient;
	subscribe(listener: (e: TypedEvent | null) => void): () => void;
};

/** Clip ids seed some layers (S11:ANM-007): those keep the id in their identity. */
function seedBearing(c: RenderVisualClip): boolean {
	if (c.kind === 'motion-graphic') return true;
	const src = c.source as { animation?: { in?: unknown; out?: unknown } };
	return !!src.animation && !!(src.animation.in || src.animation.out);
}

/** `{mediaId}` references inside a value (LUT assets of the grade). */
function mediaRefs(v: unknown, out: Set<string>): Set<string> {
	if (!v || typeof v !== 'object') return out;
	if (Array.isArray(v)) {
		for (const x of v) mediaRefs(x, out);
		return out;
	}
	const o = v as Record<string, unknown>;
	if (typeof o.mediaId === 'string' && o.mediaId) out.add(o.mediaId);
	for (const x of Object.values(o)) mediaRefs(x, out);
	return out;
}

/**
 * Identity of a layer's graded preview: the clip with its times relative to its first drawn frame (handles and
 * fades included), without name/track, the clip id only when it seeds the drawing, plus the sequence frame and
 * the fingerprints of the LUT assets it references.
 */
function layerIdentity(
	clip: RenderVisualClip,
	seq: { width: number; height: number; fps: { num: number; den: number } },
	media: ProjectDocument['media'],
): string {
	const spanStart = clip.start - (clip.headHandle ?? 0);
	const { clipId, name: _n, trackId: _t, start, fades, baked: _b, ...rest } = clip;
	const luts = [...mediaRefs(clip.effects, new Set())]
		.sort()
		.map((id) => [id, media[id]?.fingerprint ?? null]);
	return canonicalJson({
		...rest,
		clipId: seedBearing(clip) ? clipId : 'clip',
		start: start - spanStart,
		...(fades ? { fades: fades.map((f) => ({ ...f, start: f.start - spanStart })) } : {}),
		seq: { w: seq.width, h: seq.height, fps: [seq.fps.num, seq.fps.den] },
		luts,
	});
}

export class LayerBakeRuntime implements BakedLayerRuntime {
	private ver = 0;
	private readonly listeners = new Set<() => void>();
	/** identity → ready preview. */
	private readonly previews = new Map<string, BakedLayerPreview>();
	/** Identities already submitted, including failed requests (not automatically retried). */
	private readonly requested = new Set<string>();
	/** job id → identity. */
	private readonly jobs = new Map<string, string>();
	private readonly recentJobs = new Map<string, EngineJob>();
	/** clipId → pending timer for an identity. */
	private readonly scheduled = new Map<string, { identity: string; timer: ReturnType<typeof setTimeout> }>();
	private readonly identities = new WeakMap<RenderVisualClip, string>();
	private readonly offs: (() => void)[] = [];
	private scanTimer: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;

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

	// ------------------------------------------------------------------ BakedLayerRuntime

	subscribe = (cb: () => void): (() => void) => {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	};
	version = (): number => this.ver;

	private notify(): void {
		this.ver++;
		for (const l of [...this.listeners]) l();
	}

	private identityOf(clip: RenderVisualClip): string | null {
		const cached = this.identities.get(clip);
		if (cached) return cached;
		const s = this.session.store.getState();
		const seq = s.activeSequenceId ? s.document.sequences[s.activeSequenceId] : undefined;
		if (!seq) return null;
		const id = layerIdentity(
			clip,
			{ width: seq.settings.width, height: seq.settings.height, fps: seq.settings.frameRate },
			s.document.media,
		);
		this.identities.set(clip, id);
		return id;
	}

	previewFor(clip: RenderVisualClip): BakedLayerPreview | null {
		if (this.previews.size === 0) return null;
		const id = this.identityOf(clip);
		return id ? (this.previews.get(id) ?? null) : null;
	}

	// ------------------------------------------------------------------ scanning

	private scanSoon(ms = 150): void {
		if (this.disposed) return;
		if (this.scanTimer) clearTimeout(this.scanTimer);
		this.scanTimer = setTimeout(() => {
			this.scanTimer = null;
			this.scan();
		}, ms);
	}

	/** Graded DOM layers of the active sequence → schedules a preview for every identity not known yet. */
	private scan(): void {
		if (this.disposed) return;
		const s = this.session.store.getState();
		const seqId = s.activeSequenceId;
		const seq = seqId ? s.document.sequences[seqId] : undefined;
		if (!seqId || !seq) return;
		const hasDom = Object.values(seq.clips).some(
			(c) => c.kind === 'text' || c.kind === 'shape' || c.kind === 'motion-graphic',
		);
		if (!hasDom) return;
		const snap = buildRenderSnapshot(s.document, seqId, {
			resolveMedia: () => null,
			resolveFont: () => null,
		});
		const seen = new Set<string>();
		for (const clip of snap.videoTracks.flatMap((t) => t.clips)) {
			if (!hasDomColorEffects(clip)) continue;
			seen.add(clip.clipId);
			const id = this.identityOf(clip);
			if (!id || this.requested.has(id)) {
				const pending = this.scheduled.get(clip.clipId);
				if (pending && pending.identity !== id) {
					clearTimeout(pending.timer);
					this.scheduled.delete(clip.clipId);
				}
				continue;
			}
			this.schedule(seqId, clip.clipId, id);
		}
		for (const [clipId, p] of this.scheduled)
			if (!seen.has(clipId)) {
				clearTimeout(p.timer);
				this.scheduled.delete(clipId);
			}
	}

	private schedule(sequenceId: string, clipId: string, identity: string): void {
		const existing = this.scheduled.get(clipId);
		if (existing?.identity === identity) return;
		if (existing) clearTimeout(existing.timer);
		const timer = setTimeout(() => {
			this.scheduled.delete(clipId);
			void this.submit(sequenceId, clipId, identity);
		}, PREVIEW_IDLE_MS);
		this.scheduled.set(clipId, { identity, timer });
	}

	// ------------------------------------------------------------------ jobs

	/** Identity of a clip in a document (null: the clip is no longer a graded DOM layer of that sequence). */
	private identityIn(doc: ProjectDocument, sequenceId: string, clipId: string): string | null {
		const seq = doc.sequences[sequenceId];
		if (!seq?.clips[clipId]) return null;
		const snap = buildRenderSnapshot(doc, sequenceId, { resolveMedia: () => null, resolveFont: () => null });
		const clip = snap.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === clipId);
		if (!clip || !hasDomColorEffects(clip)) return null;
		return layerIdentity(
			clip,
			{ width: seq.settings.width, height: seq.settings.height, fps: seq.settings.frameRate },
			doc.media,
		);
	}

	private async submit(sequenceId: string, clipId: string, identity: string): Promise<void> {
		if (this.disposed) return;
		// The engine renders the document sent now: the preview is stored under the identity of the clip in that very
		// document. When the layer changed since it was scheduled (the rescan may still be pending), schedule anew.
		const doc = this.session.getCommitted();
		const revision = this.session.revision;
		if (this.identityIn(doc, sequenceId, clipId) !== identity) {
			this.scanSoon(0);
			return;
		}
		this.requested.add(identity);
		try {
			const job = await this.engine.client.call('layerBakePreview', {
				body: {
					...(this.session.projectId ? { projectId: this.session.projectId } : {}),
					sequenceId,
					clipId,
					envelope: exportEnvelope(doc, revision),
				},
			});
			this.jobs.set(job.id, identity);
			const newer = this.recentJobs.get(job.id);
			this.onJob(newer && (newer.finishedAt || !job.finishedAt) ? newer : job);
		} catch {
			this.notify();
		}
	}

	private onEvent(e: TypedEvent): void {
		if (e.type !== 'job.created' && e.type !== 'job.updated' && e.type !== 'job.finished') return;
		if (e.payload.kind !== 'layer-bake') return;
		// Events can overtake the HTTP response of the submit: remember the latest state of every bake job.
		this.recentJobs.set(e.payload.id, e.payload);
		if (this.recentJobs.size > 200) this.recentJobs.delete(this.recentJobs.keys().next().value!);
		this.onJob(e.payload);
	}

	private onJob(job: EngineJob): void {
		const identity = this.jobs.get(job.id);
		if (!identity) return;
		if (job.state === 'succeeded') {
			this.jobs.delete(job.id);
			const r = job.result as LayerBakePreviewResult | undefined;
			if (!r?.previewUrl) {
				this.notify();
				return;
			}
			// Warm the HTTP cache first so the layer switches without a gap.
			void fetch(r.previewUrl)
				.then((res) => res.arrayBuffer())
				.catch(() => undefined)
				.finally(() => {
					this.previews.set(identity, { url: r.previewUrl, rect: r.rect });
					this.notify();
				});
			return;
		}
		if (job.state === 'failed' || job.state === 'cancelled' || job.state === 'interrupted') {
			this.jobs.delete(job.id);
		}
		this.notify();
	}
}

// ---------------------------------------------------------------- one runtime per open session

let current: LayerBakeRuntime | null = null;
const facadeListeners = new Set<() => void>();

/** The runtime installed for the baked-layer wrapper: delegates to the current session's runtime. */
const facade: BakedLayerRuntime = {
	previewFor: (clip) => current?.previewFor(clip) ?? null,
	subscribe: (cb) => {
		facadeListeners.add(cb);
		const off = current?.subscribe(cb);
		return () => {
			facadeListeners.delete(cb);
			off?.();
		};
	},
	version: () => (current ? current.version() : -1),
};

/** Attaches (idempotently) the runtime of `session`; returns it. */
export function ensureLayerBakeRuntime(session: EditorSession, engine: EngineLink): LayerBakeRuntime {
	if (current?.session === session) return current;
	current?.dispose();
	current = new LayerBakeRuntime(session, engine);
	setBakedLayerRuntime(facade);
	for (const cb of facadeListeners) {
		current.subscribe(cb);
		cb();
	}
	return current;
}
