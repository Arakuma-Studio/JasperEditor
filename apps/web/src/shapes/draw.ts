// Drawing-tool edits for vector shapes (wp shapes): Polygon / Star drags (centre → outer radius, the first point
// turned towards the pointer; Shift keeps it upright), rectangles / ellipses drawn into a selected vector shape, and
// the transactions they issue. Pure geometry + one transaction per drawing.
import type { ShapeItemInput, Vec2 } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { activeSequence } from '../panels/program/edits.ts';
import type { DrawnBox } from './geometry.ts';
import {
	addItemsToVector,
	addVectorClipAt,
	drawnGroup,
	selectedVectorClip,
	sequenceToContent,
} from './vector.ts';

export type DrawnStar = { center: Vec2; radius: number; rotation: number };

/** Polystar drag: centre at the press, radius = distance, rotation so the first point faces the pointer. */
export function dragStar(p0: Vec2, p1: Vec2, upright: boolean): DrawnStar {
	const dx = p1[0] - p0[0];
	const dy = p1[1] - p0[1];
	const radius = Math.round(Math.hypot(dx, dy) * 10) / 10;
	// Rotation 0 puts the first point straight up (−90° on screen).
	const rotation =
		upright || radius === 0 ? 0 : Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 90) * 10) / 10;
	return { center: [Math.round(p0[0]), Math.round(p0[1])], radius, rotation };
}

/** After Effects' tool defaults: 5 points; a star's inner radius is half the outer. */
export const POLYSTAR_DEFAULTS = { points: 5, innerRatio: 0.5 } as const;

/** Outline points (sequence px) previewing a polystar drag. */
export function polystarPreview(type: 'polygon' | 'star', s: DrawnStar): Vec2[] {
	const n = POLYSTAR_DEFAULTS.points;
	const count = type === 'star' ? n * 2 : n;
	const out: Vec2[] = [];
	for (let i = 0; i < count; i++) {
		const r = type === 'star' && i % 2 === 1 ? s.radius * POLYSTAR_DEFAULTS.innerRatio : s.radius;
		const a = -Math.PI / 2 + (s.rotation * Math.PI) / 180 + (2 * Math.PI * i) / count;
		out.push([s.center[0] + r * Math.cos(a), s.center[1] + r * Math.sin(a)]);
	}
	return out;
}

function polystarItem(
	type: 'polygon' | 'star',
	radius: number,
	rotation: number,
	position: Vec2 = [0, 0],
): ShapeItemInput {
	return {
		type: 'polystar',
		starType: type,
		points: POLYSTAR_DEFAULTS.points,
		position,
		rotation,
		outerRadius: radius,
		innerRadius: Math.round(radius * POLYSTAR_DEFAULTS.innerRatio * 10) / 10,
	};
}

/** Polygon / Star tool release: into the selected vector shape, or a new vector shape centred on the drag. */
export function addPolystar(
	session: EditorSession,
	type: 'polygon' | 'star',
	frame: number,
	s: DrawnStar,
): boolean {
	const label = type === 'star' ? 'Star' : 'Polygon';
	const target = selectedVectorClip(session, frame);
	if (target) {
		const seq = activeSequence(session);
		const c = seq ? sequenceToContent(seq, target, frame, s.center) : null;
		if (!c) return false;
		return (
			addItemsToVector(
				session,
				target.id,
				[drawnGroup(polystarItem(type, s.radius, s.rotation, c), label)],
				`Add ${label}`,
			).length > 0
		);
	}
	return !!addVectorClipAt(
		session,
		frame,
		[polystarItem(type, s.radius, s.rotation), { type: 'fill', color: [1, 1, 1, 1] }],
		`New ${label}`,
		s.center,
		label,
	);
}

/** Rectangle / Ellipse drawn with a vector shape selected: a new group in it (the box mapped into its content space). */
export function addBoxToVector(
	session: EditorSession,
	clipId: string,
	type: 'rect' | 'ellipse',
	frame: number,
	box: DrawnBox,
): boolean {
	const seq = activeSequence(session);
	const clip = seq?.clips[clipId];
	if (!seq || !clip || clip.kind !== 'shape') return false;
	const c = sequenceToContent(seq, clip, frame, box.center);
	// The box size in content px (the layer's scale divided out along each axis).
	const a = sequenceToContent(seq, clip, frame, [box.center[0] + box.size[0] / 2, box.center[1]]);
	const b = sequenceToContent(seq, clip, frame, [box.center[0], box.center[1] + box.size[1] / 2]);
	if (!c || !a || !b) return false;
	const size: Vec2 = [
		Math.round(2 * Math.hypot(a[0] - c[0], a[1] - c[1]) * 10) / 10,
		Math.round(2 * Math.hypot(b[0] - c[0], b[1] - c[1]) * 10) / 10,
	];
	const name = type === 'rect' ? 'Rectangle' : 'Ellipse';
	const item = { type, size, position: c };
	return addItemsToVector(session, clipId, [drawnGroup(item, name)], `Add ${name}`).length > 0;
}
