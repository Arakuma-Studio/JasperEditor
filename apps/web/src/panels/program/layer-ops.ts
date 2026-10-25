// Layer operations of the Program monitor's right-click menu (S03:XF-050, wp-clipboard-2): Fit to Frame / Fill
// Frame / Set to Native (100%) (XF-051: scale for the visible rect after crop, rotation-aware bounds, the visible
// rect centred), Anchor ▸ presets (XF-037/038: the anchor moves to a point of the visible rect, the image stays),
// Arrange ▸ (moves the layer to a higher or lower video track at the same time, S02:TL-266/486 track creation)
// and the project item behind a clip (Reveal in Project). Pure functions over the committed document: the
// commands in `commands/layer.ts` turn them into one transaction each.
import {
	applyMatrix,
	type Clip,
	type Crop,
	contentTimeAt,
	cropWindow,
	evaluate,
	intrinsicBoxOf,
	type LayerTransformValues,
	layerMatrix,
	type ProjectDocument,
	type Rect,
	type Sequence,
	visibleRect,
} from '@jasper/project';
import { hasTransform, type TransformPatch, transformAt, type Vec2 } from './edits.ts';
import { MAX_SCALE, MIN_SCALE } from './transform-math.ts';

export type LayerState = {
	values: LayerTransformValues;
	box: { width: number; height: number };
	crop: Crop | null;
	/** The frame the values were read at (the playhead clamped into the clip). */
	frame: number;
};

/** The playhead clamped into a clip's range (monitor edits key at a frame of the clip). */
function frameInClip(clip: Pick<Clip, 'start' | 'duration'>, frame: number): number {
	return Math.max(clip.start, Math.min(clip.start + clip.duration - 1, frame));
}

/** Motion, intrinsic box and crop of a visual clip at a sequence frame, or null without Motion. */
export function layerStateAt(
	doc: Pick<ProjectDocument, 'media' | 'synthetics'>,
	seq: Sequence,
	clip: Clip,
	frame: number,
): LayerState | null {
	if (!hasTransform(clip)) return null;
	const f = frameInClip(clip, frame);
	const values = transformAt(seq, clip, f);
	const box = intrinsicBoxOf({ doc, seq, clip });
	const t = contentTimeAt(clip, f, seq.settings.frameRate);
	// crop-order: the window the crops leave visible where they sit in the stack (flips after a crop mirror it).
	const stack = (
		(clip as { effects?: { effectId: string; enabled: boolean; params: Record<string, never> }[] }).effects ??
		[]
	).map((e) => ({
		effectId: e.effectId,
		enabled: e.enabled,
		params:
			e.effectId === 'jasper.crop'
				? Object.fromEntries(
						Object.entries(e.params).map(([k, a]) => [
							k,
							Number(evaluate(a as Parameters<typeof evaluate>[0], t)) || 0,
						]),
					)
				: {},
	}));
	return { values, box, crop: cropWindow(stack), frame: f };
}

export type FitMode = 'fit' | 'fill' | 'native';

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/**
 * XF-051: the Motion patch that fits (whole visible rect inside the frame) or fills (frame covered) the frame,
 * or sets 100% (Set to Native: scale only, about the anchor). Fit/Fill use the rotated bounds of the visible
 * rect and centre it. Null when the visible rect is empty.
 */
export function fitPatch(
	s: LayerState,
	frame: { width: number; height: number },
	mode: FitMode,
): TransformPatch | null {
	if (mode === 'native') return { scale: 100, scaleWidth: 100 };
	const rect = visibleRect(s.box, s.crop ?? undefined);
	if (rect.width <= 0 || rect.height <= 0) return null;
	const th = (s.values.rotation * Math.PI) / 180;
	const c = Math.abs(Math.cos(th));
	const n = Math.abs(Math.sin(th));
	const bw = rect.width * c + rect.height * n;
	const bh = rect.width * n + rect.height * c;
	const k =
		mode === 'fit'
			? Math.min(frame.width / bw, frame.height / bh)
			: Math.max(frame.width / bw, frame.height / bh);
	const scale = clampScale(round4(k * 100));
	const next: LayerTransformValues = { ...s.values, scale, scaleWidth: scale, position: [0, 0] };
	const centre = applyMatrix(layerMatrix(next), [rect.x + rect.width / 2, rect.y + rect.height / 2]);
	return {
		scale,
		scaleWidth: scale,
		position: [round4(frame.width / 2 - centre[0]), round4(frame.height / 2 - centre[1])],
	};
}

export type AnchorPoint =
	| 'top-left'
	| 'top'
	| 'top-right'
	| 'left'
	| 'center'
	| 'right'
	| 'bottom-left'
	| 'bottom'
	| 'bottom-right';

/** The 9-point grid of XF-038, centre first (menu order: Anchor to Center, then the grid by rows). */
export const ANCHOR_POINTS: readonly { id: AnchorPoint; label: string; at: Vec2 }[] = [
	{ id: 'center', label: 'Center', at: [0.5, 0.5] },
	{ id: 'top-left', label: 'Top Left', at: [0, 0] },
	{ id: 'top', label: 'Top', at: [0.5, 0] },
	{ id: 'top-right', label: 'Top Right', at: [1, 0] },
	{ id: 'left', label: 'Left', at: [0, 0.5] },
	{ id: 'right', label: 'Right', at: [1, 0.5] },
	{ id: 'bottom-left', label: 'Bottom Left', at: [0, 1] },
	{ id: 'bottom', label: 'Bottom', at: [0.5, 1] },
	{ id: 'bottom-right', label: 'Bottom Right', at: [1, 1] },
];

/**
 * XF-038: moves the anchor to a point of the visible rect without moving the image: A' = q, P' = M(q) (the
 * sequence point where q is drawn now). Null when it is already there.
 */
export function anchorPatch(s: LayerState, point: AnchorPoint): { anchor: Vec2; position: Vec2 } | null {
	const p = ANCHOR_POINTS.find((x) => x.id === point);
	if (!p) return null;
	const rect: Rect = visibleRect(s.box, s.crop ?? undefined);
	const q: Vec2 = [round4(rect.x + p.at[0] * rect.width), round4(rect.y + p.at[1] * rect.height)];
	if (q[0] === s.values.anchor[0] && q[1] === s.values.anchor[1]) return null;
	const m = applyMatrix(layerMatrix(s.values), q);
	return { anchor: q, position: [round4(m[0]), round4(m[1])] };
}

function round4(v: number): number {
	return Math.round(v * 10_000) / 10_000;
}

export type ArrangeOp = 'front' | 'forward' | 'backward' | 'back';

export const ARRANGE_LABELS: Record<ArrangeOp, string> = {
	front: 'Bring to Front',
	forward: 'Bring Forward',
	backward: 'Send Backward',
	back: 'Send to Back',
};

/** UI command id per Arrange operation, in menu order. */
export const ARRANGE_COMMANDS: readonly [string, ArrangeOp][] = [
	['arrange.bringToFront', 'front'],
	['arrange.bringForward', 'forward'],
	['arrange.sendBackward', 'backward'],
	['arrange.sendToBack', 'back'],
];

type ArrangePlan = {
	/** `clip.move` track offsets, in order (each computed against the moves before it). */
	moves: { clipId: string; deltaTracks: number }[];
	/** Why nothing (or not every clip) moved. */
	reason?: string;
	/** Video tracks the moves create above the top one. */
	newTracks: number;
};

type Placed = { id: string; track: number; start: number; end: number };

/**
 * Arrange ▸ for the given clips: a layer moves to another video track at the same time, never over other
 * content (the destination is free over the clip's range) and never onto a locked track.
 *   Bring Forward: above the nearest layer above it that overlaps it in time (first free track up);
 *   Bring to Front: right above the topmost overlapping layer;
 *   Send Backward: below the nearest overlapping layer beneath (first free track down);
 *   Send to Back: below the lowest overlapping layer.
 * Moving up past the top video track creates a track (S02:TL-266); nothing is created below V1, so a backward
 * move without a free track below is refused. Linked audio keeps its track (S02:TL-486).
 */
export function planArrange(seq: Sequence, clipIds: readonly string[], op: ArrangeOp): ArrangePlan {
	const tracks = seq.videoTracks;
	const index = new Map(tracks.map((t, i) => [t.id, i]));
	const placed: Placed[] = Object.values(seq.clips)
		.filter((c) => index.has(c.trackId))
		.map((c) => ({ id: c.id, track: index.get(c.trackId)!, start: c.start, end: c.start + c.duration }));
	const byId = new Map(placed.map((p) => [p.id, p]));
	let count = tracks.length;
	const locked = (j: number) => j < tracks.length && !!tracks[j]!.locked;
	const up = op === 'front' || op === 'forward';
	const movers = clipIds
		.map((id) => byId.get(id))
		.filter((p): p is Placed => !!p && hasTransform(seq.clips[p.id]) && !locked(p.track))
		.sort((a, b) => (up ? b.track - a.track : a.track - b.track));
	if (!movers.length) return { moves: [], newTracks: 0, reason: 'Select a layer on an unlocked video track' };

	const moves: ArrangePlan['moves'] = [];
	let reason: string | undefined;
	for (const m of movers) {
		const overlapping = (j: number) =>
			placed.some((p) => p.id !== m.id && p.track === j && p.start < m.end && m.start < p.end);
		const free = (j: number) => j >= 0 && !locked(j) && (j >= count || !overlapping(j));
		const layers = Array.from({ length: count }, (_, j) => j).filter((j) => j !== m.track && overlapping(j));
		const above = layers.filter((j) => j > m.track);
		const below = layers.filter((j) => j < m.track);
		let dest: number | null = null;
		if (up) {
			if (!above.length) {
				reason ??= 'Already in front of every layer at this time';
				continue;
			}
			const from = op === 'front' ? Math.max(...above) : Math.min(...above);
			for (let j = from + 1; dest === null; j++) if (free(j)) dest = j;
		} else {
			if (!below.length) {
				reason ??= 'Already behind every layer at this time';
				continue;
			}
			const from = op === 'back' ? Math.min(...below) : Math.max(...below);
			for (let j = from - 1; j >= 0 && dest === null; j--) if (free(j)) dest = j;
			if (dest === null) {
				reason ??= 'No free video track below: add a track or move the layers under it';
				continue;
			}
		}
		moves.push({ clipId: m.id, deltaTracks: dest! - m.track });
		m.track = dest!;
		count = Math.max(count, dest! + 1);
	}
	return {
		moves,
		newTracks: count - tracks.length,
		...(reason && moves.length < movers.length ? { reason } : {}),
	};
}

/** The project item a clip comes from (media, synthetic or nested sequence), or null. */
export function projectItemOf(doc: ProjectDocument, clip: Clip): string | null {
	const r = clip as { mediaId?: string; syntheticId?: string; sequenceId?: string };
	for (const it of Object.values(doc.items)) {
		if (r.mediaId && it.kind === 'media' && it.mediaId === r.mediaId) return it.id;
		if (r.syntheticId && it.kind === 'synthetic' && it.syntheticId === r.syntheticId) return it.id;
		if (
			r.sequenceId &&
			(clip.kind === 'nest-video' || clip.kind === 'nest-audio') &&
			it.kind === 'sequence' &&
			it.sequenceId === r.sequenceId
		)
			return it.id;
	}
	return null;
}
