// Roto actions (parity workstream `roto`): Roto Brush strokes / boxes as undoable commands, `roto` engine jobs
// (segment a frame, propagate, track faces) followed by polling and live `roto.progress` events and committed as one
// "Propagate Roto" / "Track Faces" step, cancel, apply / freeze / remove, Blur Faces, face keyframes and Convert to
// Masks (engine auto-trace → mask commands).
import {
	type EngineJob,
	type EventEnvelope,
	ROTO_PROGRESS_EVENT,
	RotoProgressSchema,
	type RotoSegmentResult,
	type RotoTraceResponse,
	TERMINAL_JOB_STATES,
} from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	type Clip,
	type ClipRoto,
	type Command,
	contentTimeAt,
	findRoto,
	mediaFrameAt,
	type ProjectDocument,
	type Rational,
	rotoMaskCommands,
	rotoResultOf,
	rotoSegmentBody,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { toast } from '@jasper/ui';
import { errorText, pollActiveJob } from '../processing/engine-jobs.ts';
import { rotoUi } from './store.ts';

/** The subset of the engine client the roto actions use (tests pass a fake). */
export type RotoEngine = Pick<EngineClient, 'call' | 'getJob' | 'cancelJob'>;

let currentEngine: RotoEngine | null = null;
/** The engine client the roto UI uses (set by the mounted overlay / section: menu items have no engine context). */
export function setRotoEngine(e: RotoEngine | null): void {
	currentEngine = e;
}
export function rotoEngine(): RotoEngine | null {
	return currentEngine;
}

const POLL_MS = 400;

function apply(session: EditorSession, label: string, commands: Command[]) {
	const r = session.apply({ label, origin: 'user', commands });
	if (!r.ok) toast({ kind: 'error', title: `${label} failed`, detail: r.errors[0]?.message ?? '' });
	return r;
}

/** The media frame a clip shows at a sequence frame (stills: 0). */
export function mediaFrameOfClip(doc: ProjectDocument, clip: Clip, seqFrame: number, rate: Rational): number {
	if (clip.kind === 'still') return 0;
	const seq = Object.values(doc.sequences).find((s) => s.clips[clip.id]);
	const fps = seq?.settings.frameRate ?? { num: 30, den: 1 };
	return mediaFrameAt(contentTimeAt(clip, seqFrame, fps as Rational), rate);
}

/** Rotos of a clip. */
export function rotosOf(clip: Clip | undefined | null): ClipRoto[] {
	return ((clip as { rotos?: ClipRoto[] } | null)?.rotos ?? []) as ClipRoto[];
}

export type StrokeInput = {
	kind: ClipRoto['strokes'][number]['kind'];
	radius: number;
	points: [number, number][];
};

/**
 * Adds a brush stroke at a sequence frame: to the active roto of the clip, or a new roto (+ an Object Matte effect)
 * when the clip has none selected. Returns the roto id.
 */
export function addStroke(
	session: EditorSession,
	clipId: string,
	seqFrame: number,
	stroke: StrokeInput,
): string | null {
	const doc = session.getState().document;
	const active = rotoUi.get().activeRotoId;
	const loc = active ? findRoto(doc, active) : null;
	const at = { sequenceFrame: seqFrame };
	if (loc && loc.clipId === clipId) {
		const r = apply(session, 'Roto Brush Stroke', [
			{ type: 'roto.addStrokes', rotoId: loc.roto.id, at, strokes: [stroke] },
		]);
		return r.ok ? loc.roto.id : null;
	}
	if (stroke.kind !== 'fg') {
		toast({
			kind: 'info',
			title: 'Paint over the object first',
			detail: 'A plain drag selects the object; Alt-drag removes from it.',
		});
		return null;
	}
	const r = apply(session, 'Roto Brush', [
		{ type: 'roto.add', clipId, at, strokes: [stroke], ref: '$roto' },
		{ type: 'roto.apply', rotoId: '$roto', effect: 'matte', params: { view: 'final' } },
	]);
	if (!r.ok) return null;
	const id = (r.results[0] as { rotoId: string }).rotoId;
	rotoUi.setActive(id);
	return id;
}

/** Sets (or clears) the box prompt of a roto at a sequence frame (a new roto when none is active on the clip). */
export function setBox(
	session: EditorSession,
	clipId: string,
	seqFrame: number,
	rect: [number, number, number, number],
): string | null {
	const doc = session.getState().document;
	const active = rotoUi.get().activeRotoId;
	const loc = active ? findRoto(doc, active) : null;
	const at = { sequenceFrame: seqFrame };
	if (loc && loc.clipId === clipId) {
		const r = apply(session, 'Roto Box', [{ type: 'roto.setBox', rotoId: loc.roto.id, at, rect }]);
		return r.ok ? loc.roto.id : null;
	}
	const r = apply(session, 'Roto Brush', [
		{ type: 'roto.add', clipId, at, box: rect, ref: '$roto' },
		{ type: 'roto.apply', rotoId: '$roto', effect: 'matte', params: { view: 'final' } },
	]);
	if (!r.ok) return null;
	const id = (r.results[0] as { rotoId: string }).rotoId;
	rotoUi.setActive(id);
	return id;
}

/** Starts a roto job (segment a frame / propagate / track faces) and commits its result when it ends. */
export async function runRoto(
	session: EditorSession,
	engine: RotoEngine,
	rotoId: string,
	direction: 'both' | 'forward' | 'backward' | 'frame',
	frame?: number,
): Promise<string | null> {
	const running = rotoUi.get().running[rotoId];
	if (running) {
		// A newer request replaces a running interactive one (strokes while segmenting).
		if (running.jobId) void engine.cancelJob(running.jobId).catch(() => undefined);
		rotoUi.patchRunning(rotoId, null);
	}
	rotoUi.setError(rotoId, null);
	const doc = session.getState().document;
	let body: ReturnType<typeof rotoSegmentBody>;
	try {
		body = rotoSegmentBody(doc, rotoId, direction, frame);
	} catch (e) {
		rotoUi.setError(rotoId, (e as Error).message);
		return null;
	}
	if (body.roto.kind === 'brush' && body.roto.base === null) {
		rotoUi.setError(rotoId, 'Paint over the object (or draw a box) first');
		return null;
	}
	rotoUi.patchRunning(rotoId, {
		jobId: null,
		direction,
		startedAt: Date.now(),
		done: 0,
		total: 0,
		frame: null,
	});
	let job: EngineJob;
	try {
		job = (await engine.call('rotoSegment', {
			body: { ...body, projectId: session.projectId },
		})) as EngineJob;
	} catch (e) {
		rotoUi.patchRunning(rotoId, null);
		const code =
			(e as { detail?: { code?: string }; code?: string }).detail?.code ?? (e as { code?: string }).code;
		rotoUi.setError(
			rotoId,
			code === 'FACE_MODEL_NOT_INSTALLED'
				? 'Face tracking needs the face model: install it in Preferences ▸ Roto & Face Tracking'
				: `Could not start: ${(e as Error).message}`,
		);
		return null;
	}
	if (!rotoUi.get().running[rotoId]) {
		void engine.cancelJob(job.id).catch(() => undefined);
		return null;
	}
	rotoUi.patchRunning(rotoId, { jobId: job.id });
	if (TERMINAL_JOB_STATES.has(job.state)) await finish(session, rotoId, job);
	else poll(session, engine, rotoId, job.id);
	return job.id;
}

function poll(session: EditorSession, engine: RotoEngine, rotoId: string, jobId: string): void {
	void pollActiveJob(engine, jobId, {
		intervalMs: POLL_MS,
		isActive() {
			const running = rotoUi.get().running[rotoId];
			return running?.jobId === jobId && !running.finishing;
		},
		onUpdate(job) {
			if (job.progress !== null && rotoUi.get().running[rotoId]?.total === 0)
				rotoUi.patchRunning(rotoId, { done: Math.round(job.progress * 100), total: 100 });
		},
	})
		.then((job) => job && finish(session, rotoId, job))
		.catch((error) => {
			rotoUi.patchRunning(rotoId, null);
			rotoUi.setError(rotoId, errorText(error));
		});
}

async function finish(session: EditorSession, rotoId: string, job: EngineJob): Promise<void> {
	const r = rotoUi.get().running[rotoId];
	if (!r || r.finishing || (r.jobId && r.jobId !== job.id)) return;
	rotoUi.patchRunning(rotoId, { finishing: true });
	try {
		if (job.state !== 'succeeded') {
			if (job.state !== 'cancelled')
				rotoUi.setError(rotoId, job.error?.message ?? `The roto job ${job.state}`);
			return;
		}
		const res = job.result as RotoSegmentResult;
		const loc = findRoto(session.getState().document, rotoId);
		if (!loc) return;
		if (loc.roto.frozen) {
			rotoUi.setError(rotoId, 'The roto was frozen while it was being computed; the result was not stored');
			return;
		}
		apply(session, loc.roto.kind === 'faces' ? 'Track Faces' : 'Propagate Roto', [
			{ type: 'roto.setResult', rotoId, result: rotoResultOf(res) },
		]);
	} finally {
		rotoUi.patchRunning(rotoId, null);
	}
}

export async function cancelRoto(engine: RotoEngine, rotoId: string): Promise<void> {
	const r = rotoUi.get().running[rotoId];
	rotoUi.patchRunning(rotoId, null);
	if (r?.jobId) await engine.cancelJob(r.jobId).catch(() => undefined);
}

/** Feeds engine events (live progress) to the roto state. */
export function handleRotoEvent(raw: EventEnvelope): void {
	if (raw.type !== ROTO_PROGRESS_EVENT) return;
	const p = RotoProgressSchema.safeParse(raw.payload);
	if (!p.success) return;
	const running = rotoUi.get().running;
	const id =
		p.data.rotoId && running[p.data.rotoId]
			? p.data.rotoId
			: Object.keys(running).find((k) => running[k]!.jobId === p.data.jobId);
	if (!id) return;
	rotoUi.patchRunning(id, { done: p.data.done, total: p.data.total, frame: p.data.frame });
}

/** Track Faces (and Blur Faces): a faces roto over what the clip shows, then the face-tracking job. */
export async function trackFaces(
	session: EditorSession,
	engine: RotoEngine,
	clipId: string,
	blur: boolean,
): Promise<string | null> {
	const r = apply(session, blur ? 'Blur Faces' : 'Track Faces', [
		{ type: 'roto.add', clipId, kind: 'faces', ref: '$faces' },
		...(blur ? [{ type: 'roto.apply', rotoId: '$faces', effect: 'blur' }] : []),
	]);
	if (!r.ok) return null;
	const id = (r.results[0] as { rotoId: string }).rotoId;
	rotoUi.setActive(id);
	await runRoto(session, engine, id, 'both');
	return id;
}

export function applyEffect(session: EditorSession, rotoId: string, effect: 'matte' | 'blur'): void {
	apply(session, 'Apply Object Matte', [{ type: 'roto.apply', rotoId, effect }]);
}

export function freezeRoto(session: EditorSession, rotoId: string, frozen: boolean): void {
	apply(session, 'Freeze Roto', [{ type: 'roto.freeze', rotoId, frozen }]);
}

export function removeRoto(session: EditorSession, rotoId: string): void {
	const r = apply(session, 'Remove Roto', [{ type: 'roto.remove', rotoIds: [rotoId] }]);
	if (r.ok && rotoUi.get().activeRotoId === rotoId) rotoUi.setActive(null);
}

export function updateRoto(
	session: EditorSession,
	rotoId: string,
	patch: Omit<Extract<Command, { type: 'roto.update' }>, 'type' | 'rotoId'>,
	label = 'Roto Settings',
): void {
	apply(session, label, [{ type: 'roto.update', rotoId, ...patch }]);
}

/** Convert to Masks: the matte outline at the playhead (still) or over the computed frames (animated). */
export async function convertToMasks(
	session: EditorSession,
	engine: RotoEngine,
	rotoId: string,
	mode: 'still' | 'animated',
	seqFrame: number,
): Promise<void> {
	const doc = session.getState().document;
	const loc = findRoto(doc, rotoId);
	if (!loc?.roto.result) {
		toast({ kind: 'error', title: 'Propagate the roto first' });
		return;
	}
	const r = loc.roto;
	const res = r.result!;
	const clip = doc.sequences[loc.sequenceId]!.clips[loc.clipId]!;
	let frames: number[];
	if (mode === 'still') {
		const f = mediaFrameOfClip(doc, clip, seqFrame, r.rate);
		if (f < res.start || f > res.end) {
			toast({
				kind: 'error',
				title: 'No computed matte at the playhead',
				detail: `Frame ${f}; computed ${res.start}–${res.end}`,
			});
			return;
		}
		frames = [f];
	} else {
		frames = [];
		const step = Math.max(1, Math.ceil((res.end - res.start + 1) / 300));
		for (let f = res.start; f <= res.end; f += step) frames.push(f);
		if (frames[frames.length - 1] !== res.end) frames.push(res.end);
	}
	let traced: RotoTraceResponse;
	try {
		traced = (await engine.call('rotoTrace', { body: { key: res.key, frames } })) as RotoTraceResponse;
	} catch (e) {
		toast({ kind: 'error', title: 'Convert to Masks failed', detail: (e as Error).message });
		return;
	}
	const commands = rotoMaskCommands({
		clipId: loc.clipId,
		rate: r.rate,
		frames: traced.frames,
		mode,
		name: r.name,
	});
	if (!commands.length) {
		toast({ kind: 'info', title: 'The matte has no outline here' });
		return;
	}
	apply(session, 'Convert to Masks', commands);
}

/** A tracked face → planar tracker (+ transform keyframes on `targetClipId`). */
export function faceToTracker(
	session: EditorSession,
	rotoId: string,
	faceId: number,
	targetClipId?: string,
): void {
	apply(session, 'Track Face', [
		{ type: 'roto.faceTracker', rotoId, faceId, ...(targetClipId ? { targetClipId } : {}) },
	]);
}
