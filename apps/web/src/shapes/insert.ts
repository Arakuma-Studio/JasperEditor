// Shape creation from the UI (S11:SHP-006, FIX-007, S03:XF-061): Graphics ▸ New Layer ▸ Rectangle / Ellipse and the
// Program monitor shape tools. One `clip.addShape` transaction = one undo step; the clip goes at the playhead on
// the targeted video track when it is free there, else the first free track or a new one (placed like text,
// XF-060), and becomes the selection.
import { type Command, DEFAULT_SHAPE_SECONDS, type ShapeType, type Vec2 } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { activeSequence, freeVideoTrack } from '../panels/program/edits.ts';

export const SHAPE_LABELS: Record<ShapeType, string> = { rect: 'Rectangle', ellipse: 'Ellipse' };

/** Adds a shape at `frame`; default size 400×400 at the frame centre. Returns the new clip id. */
export function addShapeAt(
	session: EditorSession,
	type: ShapeType,
	frame: number,
	box?: { center: Vec2; size: Vec2 },
): string | null {
	const seq = activeSequence(session);
	if (!seq) return null;
	const fps = seq.settings.frameRate.num / seq.settings.frameRate.den;
	const duration = Math.max(1, Math.round(DEFAULT_SHAPE_SECONDS * fps));
	const track = freeVideoTrack(seq, frame, duration, session.getState().views[seq.id]?.targeting.video);
	const r = session.apply({
		label: `New ${SHAPE_LABELS[type]}`,
		origin: 'user',
		sequenceId: seq.id,
		commands: [
			{
				type: 'clip.addShape',
				ref: '$shape',
				at: frame,
				duration,
				track,
				shape: { type, ...(box ? { size: box.size } : {}) },
				...(box ? { transform: { position: box.center } } : {}),
			} as Command,
		],
	});
	if (!r.ok) return null;
	const id = r.refs.$shape ?? null;
	if (id) session.select('timeline', [id], 'replace');
	return id;
}
