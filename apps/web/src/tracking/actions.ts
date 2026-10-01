// Tracking actions (S09:TRU-001, TRK-010, TRK-024): add/remove trackers, run a `track` engine job from the plan
// built by `planTrack`, follow it (engine events + polling), commit its result as ONE "Track" transaction
// (tracker.setSamples + re-apply to linked targets over the re-tracked span), stop it, apply and unlink.
import {
	type EngineJob,
	type EventEnvelope,
	TRACKING_PROGRESS_EVENT,
	TrackProgressSchema,
	type TrackResult,
	TrackResultSchema,
} from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	type Clip,
	type ClipTracker,
	type Command,
	findTracker,
	layerTimeAt,
	type ProjectDocument,
	planTrack,
	plateMapAt,
	type Rational,
	type Sequence,
	samplesEnd,
	samplesFromTrackResult,
	sequenceFramesOfContent,
	type TrackMode,
	trackedTargets,
	trackLayerOf,
	type VideoClip,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { toast } from '@jasper/ui';
import { mediaKeyOf } from '../import/assets.ts';
import {
	defaultQuadIn,
	geometryCentre,
	progressGeometry,
	TRAIL_LENGTH,
	visibleMediaRect,
} from './geometry.ts';
import { optionsOf, patchRunning, setActiveTracker, setError, trackingStore } from './store.ts';

/** The subset of the engine client the tracking actions use (tests pass a fake). */
export type TrackingEngine = Pick<EngineClient, 'call' | 'getJob' | 'cancelJob'>;

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const POLL_MS = 400;

export const TRACK_MODE_LABEL: Record<TrackMode, string> = {
	forward: 'Track Forward',
	backward: 'Track Backward',
	both: 'Track Both Directions',
	'from-here': 'Track from Here',
	'from-here-backward': 'Track Backward from Here',
	'step-forward': 'Step Forward',
	'step-back': 'Step Back',
};

// ------------------------------------------------------------------ document helpers

export function activeSeq(session: EditorSession): Sequence | null {
	const s = session.getState();
	return s.activeSequenceId ? (s.document.sequences[s.activeSequenceId] ?? null) : null;
}

/** The single selected video clip (the plate candidate), or null. */
export function selectedVideoClip(session: EditorSession): VideoClip | null {
	const seq = activeSeq(session);
	if (!seq) return null;
	const ids = session.getState().selection.timeline.clips;
	const clips = ids.map((id) => seq.clips[id]).filter((c): c is Clip => !!c && c.kind === 'video');
	return clips.length === 1 ? (clips[0] as VideoClip) : null;
}

/** The tracker UI commands act on: the active tracker when its clip is selected, else the selected clip's first. */
export function currentTracker(session: EditorSession): { clip: VideoClip; tracker: ClipTracker } | null {
	const clip = selectedVideoClip(session);
	if (!clip?.trackers?.length) return null;
	const active = trackingStore.getState().activeTrackerId;
	const tracker = clip.trackers.find((t) => t.id === active) ?? clip.trackers[0]!;
	return { clip, tracker };
}

/** Sequence frame `frame` clamped into a clip. */
function inClip(clip: Pick<Clip, 'start' | 'duration'>, frame: number): number {
	return Math.min(clip.start + clip.duration - 1, Math.max(clip.start, frame));
}

/** Content time of a clip at a sequence frame (clamped into the clip), integer flicks. */
export function contentTimeAt(doc: ProjectDocument, seq: Sequence, clip: Clip, frame: number): number {
	return layerTimeAt(trackLayerOf(doc, seq, clip), inClip(clip, frame), seq.settings.frameRate as Rational);
}

/** Clips a tracker can drive: visual clips with Motion on tracks above the plate that overlap it in time. */
export function applyCandidates(seq: Sequence, plate: Clip): Clip[] {
	const plateTrack = seq.videoTracks.findIndex((t) => t.id === plate.trackId);
	if (plateTrack < 0) return [];
	const above = new Set(seq.videoTracks.slice(plateTrack + 1).map((t) => t.id));
	return Object.values(seq.clips)
		.filter(
			(c) =>
				above.has(c.trackId) &&
				'transform' in c &&
				c.start < plate.start + plate.duration &&
				c.start + c.duration > plate.start,
		)
		.sort((a, b) => {
			const ta = seq.videoTracks.findIndex((t) => t.id === a.trackId);
			const tb = seq.videoTracks.findIndex((t) => t.id === b.trackId);
			return ta - tb || a.start - b.start;
		});
}

function fail(message: string, trackerId?: string): never {
	if (trackerId) setError(trackerId, message);
	throw new Error(message);
}

function run(session: EditorSession, label: string, commands: Command[]) {
	const r = session.apply({ label, origin: 'user', commands });
	if (!r.ok) throw new Error(r.errors.map((e) => e.message).join('; '));
	return r;
}

// ------------------------------------------------------------------ add / remove / update

/**
 * Adds a tracker to `clipId` at the playhead (clamped into the clip). Planar trackers get a quad centred on the
 * part of the plate that is visible in the frame; point trackers its centre. Returns the new tracker id.
 */
export function addTracker(session: EditorSession, clipId: string, kind: 'planar' | 'point'): string {
	const seq = activeSeq(session);
	const clip = seq?.clips[clipId];
	if (!seq || !clip || clip.kind !== 'video') throw new Error('Select a video clip to track');
	const doc = session.getState().document;
	const frame = inClip(clip, session.transport.getState().frame);
	const layer = trackLayerOf(doc, seq, clip);
	const t = contentTimeAt(doc, seq, clip, frame);
	const map = plateMapAt(layer, t);
	const rect = visibleMediaRect(map, layer.box, { width: seq.settings.width, height: seq.settings.height });
	const geometry =
		kind === 'planar'
			? { corners: defaultQuadIn(rect) }
			: { point: [Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2)] };
	const r = run(session, kind === 'planar' ? 'Add Planar Tracker' : 'Add Point Tracker', [
		{ type: 'tracker.add', clipId, kind, at: { sequenceFrame: frame }, ...geometry } as Command,
	]);
	const id = (r.results[0] as { trackerId: string }).trackerId;
	setActiveTracker(id);
	return id;
}

export function removeTracker(session: EditorSession, trackerId: string): void {
	run(session, 'Remove Tracker', [{ type: 'tracker.remove', trackerIds: [trackerId] } as Command]);
	if (trackingStore.getState().activeTrackerId === trackerId) setActiveTracker(null);
	setError(trackerId, null);
}

// ------------------------------------------------------------------ running a track

/** Mode for a partial re-track: every mode but a full `both` merges over the re-tracked span when samples exist. */
export async function startTrack(
	session: EditorSession,
	engine: TrackingEngine,
	trackerId: string,
	mode: TrackMode,
): Promise<string | null> {
	if (trackingStore.getState().running[trackerId]) return null;
	setError(trackerId, null);
	const doc = session.getState().document;
	const loc = findTracker(doc, trackerId);
	if (!loc) return fail('The tracker no longer exists', trackerId);
	const seq = doc.sequences[loc.sequenceId]!;
	const at = contentTimeAt(doc, seq, loc.clip, session.transport.getState().frame);
	const opts = optionsOf(trackerId, loc.tracker.kind);
	let plan: ReturnType<typeof planTrack>;
	try {
		plan = planTrack(doc, trackerId, { mode, at, quality: opts.quality });
	} catch (e) {
		return fail((e as Error).message, trackerId);
	}
	const mediaKey = mediaKeyOf(doc.media[plan.mediaId]);
	if (!mediaKey) return fail('The plate’s media is not in the engine store (import it first)', trackerId);
	trackingStore.setState((s) => ({
		running: {
			...s.running,
			[trackerId]: { jobId: null, mode, plan, mediaKey, startedAt: Date.now(), progress: null, trail: [] },
		},
	}));
	const body = {
		...plan.request,
		mediaKey,
		trackerId,
		projectId: session.projectId,
		...(loc.tracker.kind === 'planar'
			? {
					options: {
						features: opts.surroundings ? ('surroundings' as const) : ('inside' as const),
						refineEdges: opts.refineEdges,
					},
				}
			: {}),
	};
	let job: EngineJob;
	try {
		job = (await engine.call('trackingTrack', { body })) as EngineJob;
	} catch (e) {
		patchRunning(trackerId, null);
		const code = (e as { code?: string }).code;
		return fail(
			code === 'NOT_IMPLEMENTED'
				? 'Tracking is not available in this engine yet'
				: `Could not start tracking: ${(e as Error).message}`,
			trackerId,
		);
	}
	if (!trackingStore.getState().running[trackerId]) {
		// Stopped before the engine answered.
		void engine.cancelJob(job.id).catch(() => undefined);
		return null;
	}
	patchRunning(trackerId, { jobId: job.id });
	if (TERMINAL.has(job.state)) await finishTrack(session, engine, trackerId, job);
	else pollJob(session, engine, trackerId, job.id);
	return job.id;
}

/** Polls the job until it ends (fallback when the event stream is not connected or not mounted). */
function pollJob(session: EditorSession, engine: TrackingEngine, trackerId: string, jobId: string): void {
	const tick = async () => {
		const r = trackingStore.getState().running[trackerId];
		if (!r || r.jobId !== jobId || r.finishing) return;
		try {
			const job = await engine.getJob(jobId);
			if (TERMINAL.has(job.state)) {
				await finishTrack(session, engine, trackerId, job);
				return;
			}
		} catch {
			// transient engine error: keep polling
		}
		setTimeout(tick, POLL_MS);
	};
	setTimeout(tick, POLL_MS);
}

/** Feeds an engine event envelope to the tracking state (progress geometry, job end). */
export function handleEngineEvent(session: EditorSession, engine: TrackingEngine, raw: EventEnvelope): void {
	if (raw.type === TRACKING_PROGRESS_EVENT) {
		const p = TrackProgressSchema.safeParse(raw.payload);
		if (!p.success) return;
		const running = trackingStore.getState().running;
		const trackerId =
			p.data.trackerId && running[p.data.trackerId]
				? p.data.trackerId
				: Object.keys(running).find((id) => running[id]!.jobId === p.data.jobId);
		if (!trackerId) return;
		const r = running[trackerId]!;
		if (r.jobId && r.jobId !== p.data.jobId) return;
		const c = geometryCentre(progressGeometry(p.data.data));
		const trail = c ? [...r.trail, c].slice(-TRAIL_LENGTH) : r.trail;
		patchRunning(trackerId, {
			progress: {
				frame: p.data.frame,
				data: p.data.data,
				confidence: p.data.confidence,
				done: p.data.done,
				total: p.data.total,
			},
			trail,
		});
		followPlayhead(session, trackerId, p.data.frame);
		return;
	}
	if (raw.type === 'job.finished' || raw.type === 'job.updated') {
		const job = raw.payload as EngineJob | undefined;
		if (!job?.id || !TERMINAL.has(job.state)) return;
		const running = trackingStore.getState().running;
		const trackerId = Object.keys(running).find((id) => running[id]!.jobId === job.id);
		if (trackerId) void finishTrack(session, engine, trackerId, job);
	}
}

/** Moves the playhead to the sequence frame showing the source frame being tracked (the overlay follows it). */
function followPlayhead(session: EditorSession, trackerId: string, sourceFrame: number): void {
	const doc = session.getState().document;
	const loc = findTracker(doc, trackerId);
	const r = trackingStore.getState().running[trackerId];
	if (!loc || !r) return;
	const seq = doc.sequences[loc.sequenceId]!;
	const span = sequenceFramesOfContent(
		loc.clip,
		seq.settings.frameRate as Rational,
		sourceFrame * r.plan.step,
		sourceFrame * r.plan.step,
	);
	if (!span) return;
	const transport = session.transport;
	if (transport.getState().playing) return;
	if (transport.getState().frame !== span.start) transport.seek(span.start);
}

/** Fetches the finished job and commits its result (one "Track" history entry), or reports the failure. */
async function finishTrack(
	session: EditorSession,
	engine: TrackingEngine,
	trackerId: string,
	job: EngineJob,
): Promise<void> {
	const r = trackingStore.getState().running[trackerId];
	if (!r || r.finishing || (r.jobId && r.jobId !== job.id)) return;
	patchRunning(trackerId, { finishing: true });
	try {
		if (job.state === 'cancelled') return;
		if (job.state === 'failed') {
			const msg = job.error?.message ?? 'Tracking failed';
			setError(trackerId, msg);
			toast({ kind: 'error', title: 'Tracking failed', detail: msg, dedupeKey: `track-${trackerId}` });
			return;
		}
		let full = job;
		if (full.result === undefined) full = await engine.getJob(job.id);
		const parsed = TrackResultSchema.safeParse(full.result);
		if (!parsed.success) {
			setError(trackerId, 'The engine returned an invalid tracking result');
			return;
		}
		commitTrackResult(session, trackerId, r.plan, parsed.data);
	} catch (e) {
		setError(trackerId, (e as Error).message);
		toast({ kind: 'error', title: 'Could not store the track', detail: (e as Error).message });
	} finally {
		patchRunning(trackerId, null);
	}
}

/**
 * Commits a track result as ONE transaction "Track": `tracker.setSamples` (merged per the plan) and, for every
 * clip that follows this tracker, `tracker.apply` over the sequence frames the new samples cover (TRK-024).
 */
export function commitTrackResult(
	session: EditorSession,
	trackerId: string,
	plan: { step: number; merge: 'replace' | 'span' },
	result: TrackResult,
): void {
	const doc = session.getState().document;
	const loc = findTracker(doc, trackerId);
	if (!loc) throw new Error('The tracker was removed while tracking');
	const samples = samplesFromTrackResult(result, plan.step);
	const commands: Command[] = [
		{ type: 'tracker.setSamples', trackerId, samples, method: result.method, merge: plan.merge } as Command,
	];
	const seq = doc.sequences[loc.sequenceId]!;
	const frames = sequenceFramesOfContent(
		loc.clip,
		seq.settings.frameRate as Rational,
		samples.start,
		samplesEnd(samples),
	);
	if (frames) {
		for (const t of trackedTargets(doc, trackerId)) {
			const target = doc.sequences[t.sequenceId]?.clips[t.clipId];
			if (!target) continue;
			const start = Math.max(frames.start, target.start, loc.clip.start);
			const end = Math.min(frames.end, target.start + target.duration, loc.clip.start + loc.clip.duration);
			if (end <= start) continue;
			commands.push({
				type: 'tracker.apply',
				trackerId,
				targetClipId: t.clipId,
				mode: t.mode,
				...(t.mode === 'transform' ? { components: animatedComponents(target) } : {}),
				range: { start, end },
			} as Command);
		}
	}
	run(session, 'Track', commands);
	setActiveTracker(trackerId);
}

/** Motion components a transform-mode target already follows (the animated ones; all three when none). */
function animatedComponents(target: Clip): ('position' | 'scale' | 'rotation')[] {
	const tr = (target as { transform?: Record<string, { keyframes?: unknown[] }> }).transform;
	const list = (['position', 'scale', 'rotation'] as const).filter(
		(k) => (tr?.[k]?.keyframes?.length ?? 0) > 0,
	);
	return list.length ? [...list] : ['position', 'scale', 'rotation'];
}

/** Cancels the running job of a tracker (no samples are committed). */
export async function stopTrack(engine: TrackingEngine, trackerId: string): Promise<void> {
	const r = trackingStore.getState().running[trackerId];
	if (!r) return;
	patchRunning(trackerId, null);
	if (r.jobId) await engine.cancelJob(r.jobId).catch(() => undefined);
}

// ------------------------------------------------------------------ apply / unlink

export type ApplyMode = 'corner-pin' | 'position' | 'position-scale-rotation';

function applyCommand(trackerId: string, targetClipId: string, mode: ApplyMode): Command {
	return (
		mode === 'corner-pin'
			? { type: 'tracker.apply', trackerId, targetClipId, mode: 'corner-pin' }
			: {
					type: 'tracker.apply',
					trackerId,
					targetClipId,
					mode: 'transform',
					components: mode === 'position' ? ['position'] : ['position', 'scale', 'rotation'],
				}
	) as Command;
}

/** Bakes the tracker onto the target (one history entry "Apply Tracking"). */
export function applyTracking(
	session: EditorSession,
	trackerId: string,
	targetClipId: string,
	mode: ApplyMode,
): void {
	run(session, 'Apply Tracking', [applyCommand(trackerId, targetClipId, mode)]);
}

/** Re-applies the tracker that drives `targetClipId` with its recorded mode over the overlap. */
export function reapplyTracking(session: EditorSession, targetClipId: string): void {
	const seq = activeSeq(session);
	const target = seq?.clips[targetClipId] as
		| (Clip & { trackedBy?: { trackerId: string; mode: string } })
		| undefined;
	const tb = target?.trackedBy;
	if (!target || !tb) throw new Error('This clip does not follow a tracker');
	run(session, 'Apply Tracking', [
		{
			type: 'tracker.apply',
			trackerId: tb.trackerId,
			targetClipId,
			mode: tb.mode,
			...(tb.mode === 'transform' ? { components: animatedComponents(target) } : {}),
		} as Command,
	]);
}

/** Drops the target's link to its tracker; its keyframes stay (the keyframes are the truth, TRK-005). */
export function unlinkTracking(session: EditorSession, targetClipId: string): void {
	run(session, 'Unlink Tracking', [{ type: 'tracker.unlink', clipIds: [targetClipId] } as Command]);
}
