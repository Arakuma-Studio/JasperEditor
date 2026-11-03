import type { Vec2 } from '@jasper/project';
// Document edits issued by the monitors: transform writes (S03:PRP-020 through `param.set` with the
// playhead as `at`, so animated properties get a keyframe), nudges (XF-023) and text creation (XF-060).
import {
	type Clip,
	type Command,
	contentTimeAt,
	evaluate,
	kindCapabilities,
	type LayerTransformValues,
	type Sequence,
	type Transform,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';

export type { Vec2 } from '@jasper/project';

export function activeSequence(session: EditorSession): Sequence | null {
	const s = session.getState();
	const id = s.activeSequenceId;
	const doc = s.transient ?? s.document;
	return id ? (doc.sequences[id] ?? null) : null;
}

type VisualWithTransform = Clip & { transform: Transform; trackId: string };

export function hasTransform(c: Clip | undefined): c is VisualWithTransform {
	// Loose clip schemas preserve extension fields, which need not describe editable Motion.
	return !!c && c.kind !== 'captions' && !!kindCapabilities(c.kind)?.hasTransform;
}

/** Motion values of a clip evaluated at a sequence frame (content time, S01:KF-002). */
export function transformAt(seq: Sequence, clip: VisualWithTransform, frame: number): LayerTransformValues {
	const t = contentTimeAt(
		clip,
		Math.max(clip.start, Math.min(clip.start + clip.duration - 1, frame)),
		seq.settings.frameRate,
	);
	const tr = clip.transform;
	return {
		position: evaluate(tr.position, t),
		anchor: evaluate(tr.anchor, t),
		scale: evaluate(tr.scale, t),
		scaleWidth: evaluate(tr.scaleWidth, t),
		uniformScale: tr.uniformScale,
		rotation: evaluate(tr.rotation, t),
		flipH: tr.flipH,
		flipV: tr.flipV,
	};
}

/** Selected clips with Motion that are visible at `frame`, on unlocked tracks. */
function selectedTransformClips(session: EditorSession, frame: number): VisualWithTransform[] {
	const seq = activeSequence(session);
	if (!seq) return [];
	const locked = new Set(seq.videoTracks.filter((t) => t.locked).map((t) => t.id));
	const out: VisualWithTransform[] = [];
	for (const id of session.getState().selection.timeline.clips) {
		const c = seq.clips[id];
		if (!hasTransform(c) || locked.has(c.trackId)) continue;
		if (frame < c.start || frame >= c.start + c.duration) continue;
		out.push(c);
	}
	return out;
}

export type TransformPatch = Partial<
	Pick<LayerTransformValues, 'position' | 'anchor' | 'scale' | 'scaleWidth' | 'rotation' | 'uniformScale'>
>;

/**
 * `param.set` commands for a Motion patch at the playhead (S03:XF-024: animated properties get a
 * keyframe at the playhead; static ones change their value).
 */
export function transformCommands(
	clipId: string,
	patch: TransformPatch,
	frame: number,
	sequenceId?: string,
): Command[] {
	const at = { sequenceFrame: frame };
	const cmds: Command[] = [];
	if (patch.uniformScale !== undefined)
		cmds.push({
			type: 'param.set',
			target: ['clip', clipId, 'transform', 'uniformScale'],
			value: patch.uniformScale,
			sequenceId,
		} as Command);
	for (const key of ['position', 'anchor', 'scale', 'scaleWidth', 'rotation'] as const) {
		const v = patch[key];
		if (v === undefined) continue;
		cmds.push({
			type: 'param.set',
			target: ['clip', clipId, 'transform', key],
			value: v,
			at,
			sequenceId,
		} as Command);
	}
	return cmds;
}

export const NUDGE_SMALL = 1;
export const NUDGE_LARGE = 5;

/** Nudge the selected layers by (dx, dy) sequence px (XF-023); repeated nudges coalesce into one step. */
export function nudgeSelection(session: EditorSession, frame: number, dx: number, dy: number): boolean {
	const seq = activeSequence(session);
	if (!seq) return false;
	const clips = selectedTransformClips(session, frame);
	if (clips.length === 0) return false;
	const commands = clips.flatMap((c) => {
		const v = transformAt(seq, c, frame);
		return transformCommands(c.id, { position: [v.position[0] + dx, v.position[1] + dy] }, frame, seq.id);
	});
	const r = session.apply({
		label: 'Nudge',
		origin: 'user',
		commands,
		coalesceKey: `nudge:${clips.map((c) => c.id).join(',')}`,
	});
	return r.ok;
}

/** First video track free over [at, at+duration), else a new track label above the top (XF-060). */
export function freeVideoTrack(seq: Sequence, at: number, duration: number, preferred?: string[]): string {
	const busy = (trackId: string) =>
		Object.values(seq.clips).some(
			(c) => c.trackId === trackId && c.start < at + duration && c.start + c.duration > at,
		);
	const tracks = seq.videoTracks.filter((t) => !t.locked);
	for (const id of preferred ?? []) if (tracks.some((t) => t.id === id) && !busy(id)) return id;
	for (const t of tracks) if (!busy(t.id)) return t.id;
	return `V${seq.videoTracks.length + 1}`;
}

const DEFAULT_TEXT_SECONDS = 5;

/** Where a new text clip goes: at `frame`, for the default length, on a free video track (XF-060). */
export function textPlacement(
	session: EditorSession,
	frame: number,
): { sequenceId: string; at: number; duration: number; track: string } | null {
	const seq = activeSequence(session);
	if (!seq) return null;
	const fps = seq.settings.frameRate.num / seq.settings.frameRate.den;
	const duration = Math.max(1, Math.round(DEFAULT_TEXT_SECONDS * fps));
	const view = session.getState().views[seq.id];
	return {
		sequenceId: seq.id,
		at: frame,
		duration,
		track: freeVideoTrack(seq, frame, duration, view?.targeting.video),
	};
}

/** Graphics ▸ New Layer ▸ Text: a point-text clip at the playhead centered on `point`. */
export function addTextAt(session: EditorSession, point: Vec2, frame: number): string | null {
	const place = textPlacement(session, frame);
	if (!place) return null;
	const { sequenceId, at, duration, track } = place;
	const r = session.apply({
		label: 'Add Text',
		origin: 'user',
		sequenceId,
		commands: [
			{
				type: 'clip.addText',
				ref: '$text',
				at,
				duration,
				track,
				content: { text: 'Text' },
				transform: { position: [Math.round(point[0]), Math.round(point[1])] },
			} as Command,
		],
	});
	if (!r.ok) return null;
	const id = r.refs.$text ?? r.created.find((x) => x.startsWith('clp_')) ?? null;
	if (id) session.select('timeline', [id], 'replace');
	return id;
}
