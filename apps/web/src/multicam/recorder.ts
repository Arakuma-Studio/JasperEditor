// Live multi-camera switching (wp-multicam). While the sequence plays, camera keys (1–9, Ctrl+1–9) and clicks on a
// grid cell record cuts into one session gesture: each press re-applies `multicam.record` with every cut of the
// pass to the document as it was when the pass began, so the timeline shows the cuts live, and stopping playback
// commits the pass as ONE undo step ("Record Multi-Camera"). Stopped, a press switches the clip at the playhead
// (Select Camera N) or cuts to the camera from the playhead on (Cut to Camera N).
import {
	type MulticamAngle,
	multicamSourceOf,
	type Sequence,
	shownAngles,
	type TransactionResult,
} from '@jasper/project';
import type { EditorSession, Gesture } from '@jasper/session';
import { gridLayout, multicamClipAt } from './logic.ts';
import { multicamRecorderStore, multicamViewStore } from './state.ts';

type Toast = (kind: 'info' | 'warning', message: string, detail?: string) => void;

const gestures = new WeakMap<EditorSession, Gesture>();
const installed = new WeakSet<EditorSession>();

/** Commits the pass when playback stops (installed once per session by the Program monitor). */
export function installMulticamRecorder(session: EditorSession): () => void {
	if (installed.has(session)) return () => {};
	installed.add(session);
	let wasPlaying = session.transport.getState().playing;
	const off = session.transport.subscribe((s) => {
		if (wasPlaying && !s.playing) stopRecording(session);
		wasPlaying = s.playing;
	});
	return () => {
		off();
		installed.delete(session);
		stopRecording(session);
	};
}

/** Ends a pass: commits its gesture (one History entry). Returns the committed result, if any. */
export function stopRecording(session: EditorSession): TransactionResult | null {
	const g = gestures.get(session);
	gestures.delete(session);
	const had = multicamRecorderStore.getState().recording;
	multicamRecorderStore.setState({ recording: false, sequenceId: null, trackId: null, cuts: [] });
	if (!g || !had || !g.active) return null;
	return g.commit();
}

function activeSequence(session: EditorSession): Sequence | null {
	const id = session.getState().activeSequenceId;
	return id ? (session.getCommitted().sequences[id] ?? null) : null;
}

/** The angle a camera number picks: page-relative among the shown cameras when `pageRelative`. */
export function angleForCamera(
	doc: { sequences: Record<string, Sequence> },
	sourceId: string,
	n: number,
	pageRelative: boolean,
): MulticamAngle | null {
	const mc = multicamSourceOf(doc.sequences[sourceId]);
	if (!mc) return null;
	const shown = shownAngles(mc);
	const v = multicamViewStore.getState();
	const first = pageRelative ? gridLayout(shown.length, v.layout, v.page).first : 0;
	return shown[first + n - 1] ?? null;
}

/**
 * A camera key or grid click. `mode`: `select` (keys 1–9, clicks) or `cutTo` (Ctrl+1–9). `n` is 1-based on the
 * grid page shown. Returns false when there is nothing to switch.
 */
export function pressCamera(
	session: EditorSession,
	n: number,
	mode: 'select' | 'cutTo',
	toast: Toast,
	opts: { pageRelative?: boolean; angleId?: string } = {},
): boolean {
	if (session.getState().readOnly) return false;
	const seq = activeSequence(session);
	if (!seq) return false;
	const view = multicamViewStore.getState();
	const t = session.transport.getState();
	const rec = multicamRecorderStore.getState();
	const at = multicamClipAt(seq, t.frame, view.topDown);
	if (!at) {
		toast('info', 'No multi-camera clip at the playhead');
		return false;
	}
	const doc = session.getCommitted();
	const angle = opts.angleId
		? (multicamSourceOf(doc.sequences[at.clip.sequenceId])?.angles.find((a) => a.id === opts.angleId) ?? null)
		: angleForCamera(doc, at.clip.sequenceId, n, opts.pageRelative ?? true);
	if (!angle) {
		toast('info', `There is no camera ${n}`);
		return false;
	}
	const audio = view.audioFollowsVideo;
	if (t.playing) {
		let g = gestures.get(session);
		if (!g || !g.active || !rec.recording || rec.sequenceId !== seq.id) {
			try {
				g = session.beginGesture('Record Multi-Camera');
			} catch (e) {
				toast('warning', 'Cannot record while another edit is in progress', (e as Error).message);
				return false;
			}
			gestures.set(session, g);
			multicamRecorderStore.setState({ recording: true, sequenceId: seq.id, trackId: at.trackId, cuts: [] });
		}
		const state = multicamRecorderStore.getState();
		const cuts = [...state.cuts, { at: t.frame, angle: angle.id }];
		const r = g.update([
			{
				type: 'multicam.record',
				sequenceId: seq.id,
				track: state.trackId ?? at.trackId,
				cuts,
				audio,
			} as never,
		]);
		if (!r.ok) {
			toast('warning', 'Multi-camera cut not recorded', r.errors[0]?.message);
			return false;
		}
		multicamRecorderStore.setState({ cuts });
		return true;
	}
	const r = session.apply({
		label: mode === 'select' ? 'Switch Multi-Camera Angle' : 'Cut to Camera',
		origin: 'user',
		sequenceId: seq.id,
		commands: [
			(mode === 'select'
				? {
						type: 'multicam.switchAngle',
						sequenceId: seq.id,
						at: t.frame,
						angle: angle.id,
						track: at.trackId,
						audio,
					}
				: {
						type: 'multicam.record',
						sequenceId: seq.id,
						cuts: [{ at: t.frame, angle: angle.id }],
						track: at.trackId,
						audio,
					}) as never,
		],
	});
	if (!r.ok) {
		toast('warning', 'Multi-camera switch failed', r.errors[0]?.message);
		return false;
	}
	return true;
}
