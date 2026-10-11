// 3D Camera Tracker actions (three-d): Track Camera (apply + analyse), the `camtrack` engine job followed by polling
// and committed as one "Solve Camera" step, cancel, Delete Track Points (then solve again, as After Effects does),
// Set Ground Plane and Origin, Create Camera / Text / Solid and Camera, Remove.
import type { CamTrackResult, EngineJob } from '@jasper/api';
import { TERMINAL_JOB_STATES } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	type Command,
	cameraTrackerInputs,
	cameraTrackerSolveBody,
	findCameraTracker,
	type ProjectDocument,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { toast } from '@jasper/ui';
import { errorText, pollActiveJob } from '../../processing/engine-jobs.ts';
import { camtrackUi } from './store.ts';

/** The subset of the engine client the tracker uses (tests pass a fake). */
export type CamTrackEngine = Pick<EngineClient, 'call' | 'getJob' | 'cancelJob'>;

let currentEngine: CamTrackEngine | null = null;
/** The engine client of the tracker UI (set by the mounted overlay / section: menu items have no engine context). */
export function setCamTrackEngine(e: CamTrackEngine | null): void {
	currentEngine = e;
}
export function camtrackEngine(): CamTrackEngine | null {
	return currentEngine;
}

const POLL_MS = 500;

function apply(session: EditorSession, label: string, commands: Command[]) {
	const r = session.apply({ label, origin: 'user', commands });
	if (!r.ok) toast({ kind: 'error', title: `${label} failed`, detail: r.errors[0]?.message ?? '' });
	return r;
}

const trackerOf = (doc: ProjectDocument, clipId: string) => findCameraTracker(doc, clipId)?.tracker ?? null;

/** Animation ▸ Track Camera: applies the tracker to the clip (when it has none) and starts the analysis. */
export async function trackCamera(
	session: EditorSession,
	engine: CamTrackEngine,
	clipId: string,
): Promise<void> {
	if (!trackerOf(session.getState().document, clipId)) {
		const r = apply(session, 'Track Camera', [{ type: 'cameraTracker.add', clipId }]);
		if (!r.ok) return;
	}
	await analyze(session, engine, clipId);
}

/** Starts (or restarts) the analysis and solve of a clip's tracker. */
export async function analyze(
	session: EditorSession,
	engine: CamTrackEngine,
	clipId: string,
): Promise<string | null> {
	const prev = camtrackUi.get().running[clipId];
	if (prev?.jobId) void engine.cancelJob(prev.jobId).catch(() => undefined);
	camtrackUi.setError(clipId, null);
	let body: ReturnType<typeof cameraTrackerSolveBody>;
	try {
		body = cameraTrackerSolveBody(session.getState().document, clipId);
	} catch (e) {
		camtrackUi.setError(clipId, (e as Error).message);
		return null;
	}
	const { inputs, ...request } = body;
	camtrackUi.patchRunning(clipId, {
		jobId: null,
		inputs,
		progress: 0,
		stage: 'Starting',
		startedAt: Date.now(),
	});
	let job: EngineJob;
	try {
		job = (await engine.call('camtrackSolve', {
			body: { ...request, projectId: session.projectId },
		})) as EngineJob;
	} catch (e) {
		camtrackUi.patchRunning(clipId, null);
		camtrackUi.setError(clipId, `Could not start: ${(e as Error).message}`);
		return null;
	}
	if (camtrackUi.get().running[clipId]?.inputs !== inputs) {
		void engine.cancelJob(job.id).catch(() => undefined);
		return null;
	}
	camtrackUi.patchRunning(clipId, { jobId: job.id });
	if (TERMINAL_JOB_STATES.has(job.state)) finish(session, clipId, job);
	else poll(session, engine, clipId, job.id);
	return job.id;
}

function poll(session: EditorSession, engine: CamTrackEngine, clipId: string, jobId: string): void {
	void pollActiveJob(engine, jobId, {
		intervalMs: POLL_MS,
		isActive: () => camtrackUi.get().running[clipId]?.jobId === jobId,
		onUpdate(job) {
			camtrackUi.patchRunning(clipId, {
				progress: job.progress ?? 0,
				stage: job.stage ?? (job.state === 'queued' ? 'Queued' : 'Analyzing'),
			});
		},
	})
		.then((job) => job && finish(session, clipId, job))
		.catch((error) => {
			camtrackUi.patchRunning(clipId, null);
			camtrackUi.setError(clipId, errorText(error));
		});
}

function finish(session: EditorSession, clipId: string, job: EngineJob): void {
	const running = camtrackUi.get().running[clipId];
	camtrackUi.patchRunning(clipId, null);
	if (job.state === 'cancelled') return;
	if (job.state !== 'succeeded') {
		camtrackUi.setError(clipId, job.error?.message ?? `The analysis ${job.state}`);
		return;
	}
	const res = job.result as CamTrackResult;
	const t = trackerOf(session.getState().document, clipId);
	if (!t) return;
	if (running && cameraTrackerInputs(t) !== running.inputs) {
		camtrackUi.setError(clipId, 'The settings changed during the analysis: solve again');
		return;
	}
	const { clipId: _c, trackerId: _t, mediaKey: _m, rate: _r, tracks: _n, ...solve } = res;
	const r = apply(session, 'Solve Camera', [{ type: 'cameraTracker.setResult', clipId, solve }]);
	if (r.ok) camtrackUi.clearSelection();
}

export async function cancelAnalysis(engine: CamTrackEngine, clipId: string): Promise<void> {
	const r = camtrackUi.get().running[clipId];
	camtrackUi.patchRunning(clipId, null);
	if (r?.jobId) await engine.cancelJob(r.jobId).catch(() => undefined);
}

export function updateTracker(
	session: EditorSession,
	clipId: string,
	patch: Omit<Extract<Command, { type: 'cameraTracker.settings' }>, 'type' | 'clipId'>,
): boolean {
	return apply(session, '3D Camera Tracker Settings', [{ type: 'cameraTracker.settings', clipId, ...patch }])
		.ok;
}

/** Delete Selected Points, then solve again without them. */
export function deletePoints(
	session: EditorSession,
	engine: CamTrackEngine | null,
	clipId: string,
	ids: number[],
): void {
	if (!ids.length) return;
	if (
		!apply(session, 'Delete Track Points', [{ type: 'cameraTracker.deletePoints', clipId, pointIds: ids }]).ok
	)
		return;
	camtrackUi.clearSelection();
	if (engine) void analyze(session, engine, clipId);
}

export function setGround(session: EditorSession, clipId: string, ids: number[], frame?: number): void {
	apply(session, 'Set Ground Plane and Origin', [
		{ type: 'cameraTracker.setGround', clipId, pointIds: ids, ...(frame !== undefined ? { frame } : {}) },
	]);
}

export function createFromTracker(
	session: EditorSession,
	clipId: string,
	layer: 'none' | 'text' | 'solid',
	ids: number[],
	frame?: number,
): void {
	const label =
		layer === 'text'
			? 'Create Text and Camera'
			: layer === 'solid'
				? 'Create Solid and Camera'
				: 'Create Camera';
	const r = apply(session, label, [
		{
			type: 'cameraTracker.create',
			clipId,
			layer,
			...(layer !== 'none' ? { pointIds: ids } : {}),
			...(frame !== undefined ? { frame } : {}),
		},
	]);
	if (r.ok) camtrackUi.clearSelection();
}

export function removeTracker(session: EditorSession, engine: CamTrackEngine | null, clipId: string): void {
	if (engine) void cancelAnalysis(engine, clipId);
	if (apply(session, 'Remove 3D Camera Tracker', [{ type: 'cameraTracker.remove', clipId }]).ok)
		camtrackUi.clearSelection();
}
