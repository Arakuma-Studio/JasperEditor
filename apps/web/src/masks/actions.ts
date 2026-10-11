// Mask actions of the web app (wp masks): create (ellipse / 4-point polygon / pen), select, delete, track (engine job
// with progress and cancel → Mask Path keys in one History entry), auto-trace. Document edits go through the
// session's command API; long work through the engine client.
import type { EngineJob, MaskTraceResponse, TrackResult } from '@jasper/api';
import { TERMINAL_JOB_STATES } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	type Clip,
	type CommandInput,
	contentTimeAt,
	findMask,
	type MaskShape,
	type MaskTrackMethod,
	type MaskTrackMode,
	maskKeysFromTrack,
	type ProjectDocument,
	planMaskTrack,
	type Sequence,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { toast } from '@jasper/ui';
import { mediaKeyOf } from '../import/assets.ts';
import { errorText, pollActiveJob } from '../processing/engine-jobs.ts';
import { type MaskOwner, maskUi } from './store.ts';

export type MaskEngine = Pick<EngineClient, 'call' | 'getJob' | 'cancelJob'>;

const POLL_MS = 250;

function apply(session: EditorSession, label: string, commands: CommandInput[]) {
	const r = session.apply({ label, origin: 'user', commands });
	if (!r.ok) toast({ kind: 'error', title: label, detail: r.errors.map((e) => e.message).join('; ') });
	return r;
}

/** Content time of a clip at a sequence frame (clamped into the clip). */
export function clipTimeAt(seq: Sequence, clip: Clip, frame: number): number {
	const f = Math.min(clip.start + clip.duration - 1, Math.max(clip.start, frame));
	return Math.round(contentTimeAt(clip, f, seq.settings.frameRate));
}

/** Creates a mask with a tool's default shape (ellipse / 4-point polygon) and selects it. */
export function createMask(
	session: EditorSession,
	owner: MaskOwner,
	shape: Exclude<MaskShape, 'bezier'>,
): string | null {
	const r = apply(session, 'Create Mask', [
		{
			type: 'mask.add',
			...(owner.effectId ? { effectId: owner.effectId } : { clipId: owner.clipId }),
			shape,
			ref: '$mask',
		} satisfies CommandInput,
	]);
	if (!r.ok) return null;
	const id = r.refs.$mask!;
	maskUi.set({ selected: { maskId: id, clipId: owner.clipId }, vertices: [], pen: null });
	return id;
}

/** Arms the pen tool: the next clicks on the Program monitor draw a free-form mask on `owner`. */
export function startPen(owner: MaskOwner): void {
	maskUi.set({ pen: { ...owner, maskId: null }, selected: null, vertices: [] });
}

export function stopPen(): void {
	maskUi.set({ pen: null });
}

export function deleteMasks(session: EditorSession, maskIds: string[]): void {
	if (maskIds.length === 0) return;
	apply(session, maskIds.length > 1 ? 'Delete Masks' : 'Delete Mask', [
		{ type: 'mask.remove', maskIds } satisfies CommandInput,
	]);
	const sel = maskUi.get().selected;
	if (sel && maskIds.includes(sel.maskId)) maskUi.select(null);
}

function setRun(maskId: string, patch: Partial<import('./store.ts').MaskTrackRun> | null) {
	maskUi.set((s) => {
		const tracking = { ...s.tracking };
		if (patch === null) delete tracking[maskId];
		else tracking[maskId] = { ...tracking[maskId]!, ...patch };
		return { tracking };
	});
}

/**
 * Tracks a mask from the playhead (Premiere: Track Selected Mask Backward / Backward One Frame / Forward One Frame /
 * Forward). The job's progress shows in the mask's row (and the Jobs panel); stopping keeps nothing.
 */
export async function trackMask(
	session: EditorSession,
	engine: MaskEngine,
	maskId: string,
	mode: MaskTrackMode,
	method?: MaskTrackMethod,
): Promise<void> {
	if (maskUi.get().tracking[maskId]) return;
	const doc = session.getState().document;
	const loc = findMask(doc, maskId);
	if (!loc) return;
	const seq = doc.sequences[loc.sequenceId]!;
	let plan: ReturnType<typeof planMaskTrack>;
	try {
		plan = planMaskTrack(doc, maskId, {
			mode,
			at: clipTimeAt(seq, loc.clip, session.transport.getState().frame),
			...(method ? { method } : {}),
		});
	} catch (e) {
		toast({ kind: 'error', title: 'Cannot track the mask', detail: (e as Error).message });
		return;
	}
	const mediaKey = mediaKeyOf(doc.media[plan.mediaId]);
	if (!mediaKey) {
		toast({
			kind: 'error',
			title: 'Cannot track the mask',
			detail: 'The clip’s media is not in the engine store',
		});
		return;
	}
	const label = mode.startsWith('step') ? 'Track Mask (one frame)' : 'Track Mask';
	maskUi.set((s) => ({
		tracking: {
			...s.tracking,
			[maskId]: { jobId: null, maskId, direction: plan.request.direction, progress: 0, label },
		},
	}));
	let job: EngineJob;
	try {
		job = (await engine.call('trackingTrack', {
			body: { ...plan.request, mediaKey, projectId: session.projectId },
		})) as EngineJob;
	} catch (e) {
		setRun(maskId, null);
		toast({ kind: 'error', title: 'Could not start mask tracking', detail: (e as Error).message });
		return;
	}
	if (!maskUi.get().tracking[maskId]) {
		void engine.cancelJob(job.id).catch(() => undefined);
		return;
	}
	setRun(maskId, { jobId: job.id });
	if (!TERMINAL_JOB_STATES.has(job.state)) {
		const jobId = job.id;
		try {
			const finished = await pollActiveJob(engine, jobId, {
				intervalMs: POLL_MS,
				isActive: () => maskUi.get().tracking[maskId]?.jobId === jobId,
				onUpdate: (update) => setRun(maskId, { progress: update.progress ?? null }),
			});
			if (!finished) return;
			job = finished;
		} catch (error) {
			setRun(maskId, null);
			toast({ kind: 'error', title: 'Mask tracking failed', detail: errorText(error) });
			return;
		}
	}
	setRun(maskId, null);
	if (job.state !== 'succeeded') {
		if (job.state !== 'cancelled')
			toast({ kind: 'error', title: 'Mask tracking failed', detail: job.error?.message ?? 'unknown error' });
		return;
	}
	const { keys, lostAt } = maskKeysFromTrack(plan, job.result as TrackResult);
	if (keys.length > 0)
		apply(session, label, [
			{ type: 'mask.setPathKeys', maskId, keys, clearSpan: true } satisfies CommandInput,
		]);
	if (lostAt !== null)
		toast({
			kind: 'warning',
			title: 'Mask tracking stopped',
			detail: `Not enough detail inside the mask at source frame ${lostAt}; adjust the mask there and track again.`,
		});
	// The playhead follows the track to its last frame (as Premiere's tracker leaves it).
	const last = keys[plan.request.direction === 'forward' ? keys.length - 1 : 0];
	if (last && mode.startsWith('step')) {
		const F = 705_600_000 * (seq.settings.frameRate.den / seq.settings.frameRate.num);
		const i = Math.round((last.at.flicks - loc.clip.sourceIn) / (F * loc.clip.speed.rate));
		session.transport.seek(loc.clip.start + Math.max(0, Math.min(loc.clip.duration - 1, i)));
	}
}

export async function stopMaskTrack(engine: MaskEngine | null, maskId: string): Promise<void> {
	const run = maskUi.get().tracking[maskId];
	setRun(maskId, null);
	if (run?.jobId && engine) await engine.cancelJob(run.jobId).catch(() => undefined);
}

export type TraceOptions = {
	channel: 'alpha' | 'luma' | 'red' | 'green' | 'blue';
	threshold: number;
	invert: boolean;
	tolerance: number;
	minArea: number;
	cornerRoundness: number;
	feather: number;
};

export const DEFAULT_TRACE: TraceOptions = {
	channel: 'alpha',
	threshold: 0.5,
	invert: false,
	tolerance: 1,
	minArea: 10,
	cornerRoundness: 0.5,
	feather: 0,
};

/** Masks from the outlines of a media clip's picture at the playhead (After Effects' Auto-trace). */
export async function autoTrace(
	session: EditorSession,
	engine: MaskEngine,
	owner: MaskOwner,
	opts: TraceOptions,
): Promise<number> {
	const doc: ProjectDocument = session.getState().document;
	let seq: Sequence | undefined;
	let clip: Clip | undefined;
	for (const s of Object.values(doc.sequences))
		if (s.clips[owner.clipId]) {
			seq = s;
			clip = s.clips[owner.clipId];
		}
	if (!seq || !clip || !('mediaId' in clip))
		throw new Error('Auto-trace reads the picture of video and still clips');
	const asset = doc.media[clip.mediaId];
	const mediaKey = mediaKeyOf(asset);
	if (!mediaKey) throw new Error('The clip’s media is not in the engine store');
	const vs = asset?.probe.streams.find((s) => s.type === 'video');
	if (vs?.type !== 'video') throw new Error('The clip has no picture');
	const t = clipTimeAt(seq, clip, session.transport.getState().frame);
	const frame =
		clip.kind === 'video'
			? Math.max(0, Math.round((t / 705_600_000) * (vs.frameRate.num / vs.frameRate.den)))
			: 0;
	const swap = asset!.probe.rotationDegrees === 90 || asset!.probe.rotationDegrees === 270;
	const traced = (await engine.call('masksTrace', {
		body: {
			mediaKey,
			frame,
			width: swap ? vs.height : vs.width,
			height: swap ? vs.width : vs.height,
			channel: opts.channel,
			threshold: opts.threshold,
			invert: opts.invert,
			tolerance: opts.tolerance,
			minArea: opts.minArea,
			cornerRoundness: opts.cornerRoundness,
			maxPaths: 50,
		},
	})) as MaskTraceResponse;
	if (traced.paths.length === 0) return 0;
	apply(
		session,
		'Auto-trace',
		traced.paths.map(
			(p, i) =>
				({
					type: 'mask.add',
					...(owner.effectId ? { effectId: owner.effectId } : { clipId: owner.clipId }),
					shape: 'bezier',
					path: p.path,
					mode: p.depth % 2 === 1 ? 'subtract' : 'add',
					feather: opts.feather,
					name: `Traced (${i + 1})`,
				}) satisfies CommandInput,
		),
	);
	return traced.paths.length;
}
