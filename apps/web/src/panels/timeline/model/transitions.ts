// Timeline transitions (S10 §2–§4): a per-track sorted index of the drawn transitions with their spans,
// px geometry and hit-testing (TUI-001…004, TUI-010), the pure edge/body drag → `transition.update`
// mapping (TUI-012/013) and drop resolution with handle availability (TUI-021/022). DOM-free.
import {
	type Clip,
	clipHandles,
	clipsAtEditPoint,
	clipsOnTrack,
	DIP_TO_BLACK,
	fitTransitionDuration,
	type MediaAsset,
	type Sequence,
	type Transition,
	type TransitionSpec,
	transitionSpan,
	transitionSpec,
} from '@jasper/project';
import type { TrackRow } from './layout.ts';
import { frameToX, type Viewport } from './viewport.ts';

type Alignment = Transition['alignment'];
type MediaRecord = Readonly<Record<string, MediaAsset>>;

const endOf = (c: { start: number; duration: number }) => c.start + c.duration;

/** A transition as drawn: its span in sequence frames and what limits it. */
export type TransitionGeom = {
	t: Transition;
	spec: TransitionSpec | null;
	trackId: string;
	/** Edit point (two-sided) or the clip edge (one-sided). */
	cut: number;
	start: number;
	end: number;
	/** Effective (rendered) duration; 0 when nothing fits any more (drawn as a 1-frame marker). */
	duration: number;
	/** `in` = fade at a clip head (incoming only), `out` = at a clip tail, null = between two clips. */
	oneSided: 'in' | 'out' | null;
	outgoing: Clip | null;
	incoming: Clip | null;
	/** Media available after the outgoing clip's out-point / before the incoming clip's in-point (frames). */
	handles: { tail: number; head: number };
	/** TUI-003: the span reaches the end of the available media on that side. */
	capStart: boolean;
	capEnd: boolean;
	/** The render skips it (no room any more, or an unknown effect). */
	broken: boolean;
};

export type TransitionIndex = ReadonlyMap<string, readonly TransitionGeom[]>;

/** Media used beyond the cut on each side by a span (dip to black: only up to its middle). */
function handleUse(
	effectId: string,
	cut: number,
	start: number,
	end: number,
): { tail: number; head: number } {
	if (effectId === DIP_TO_BLACK) {
		const mid = start + Math.ceil((end - start) / 2);
		return { tail: Math.max(0, mid - cut), head: Math.max(0, cut - mid) };
	}
	return { tail: Math.max(0, end - cut), head: Math.max(0, cut - start) };
}

/** Geometry of one transition in a sequence (null when its clips are gone or not adjacent). */
export function transitionGeom(seq: Sequence, media: MediaRecord, t: Transition): TransitionGeom | null {
	const outgoing = t.outgoingClipId ? (seq.clips[t.outgoingClipId] ?? null) : null;
	const incoming = t.incomingClipId ? (seq.clips[t.incomingClipId] ?? null) : null;
	if (!outgoing && !incoming) return null;
	if ((t.outgoingClipId && !outgoing) || (t.incomingClipId && !incoming)) return null;
	if (outgoing && incoming && endOf(outgoing) !== incoming.start) return null;
	const doc = { media } as never;
	const tail = outgoing ? clipHandles(doc, seq, outgoing).tail : 0;
	const head = incoming ? clipHandles(doc, seq, incoming).head : 0;
	const spec = transitionSpec(t.effectId);
	const oneSided = outgoing && incoming ? null : incoming ? 'in' : 'out';
	const cut = incoming ? incoming.start : endOf(outgoing!);
	const duration = fitTransitionDuration({
		effectId: t.effectId,
		wanted: t.duration,
		alignment: t.alignment,
		outgoing: outgoing ? { duration: outgoing.duration, tail } : null,
		incoming: incoming ? { duration: incoming.duration, head } : null,
	});
	const d = Math.max(1, duration);
	const span = spanOf(cut, d, t.alignment, oneSided);
	const used = oneSided ? { tail: 0, head: 0 } : handleUse(t.effectId, cut, span.start, span.end);
	return {
		t,
		spec,
		trackId: t.trackId,
		cut,
		start: span.start,
		end: span.end,
		duration,
		oneSided,
		outgoing,
		incoming,
		handles: { tail, head },
		capStart: !oneSided && used.head > 0 && used.head >= head,
		capEnd: !oneSided && used.tail > 0 && used.tail >= tail,
		broken: duration === 0 || !spec,
	};
}

const cache = new WeakMap<object, { clips: object; media: object; index: TransitionIndex }>();
// Prefix maxima retain transitions that start much earlier but overlap the query. Metadata belongs
// to the immutable sorted list, so unrelated edits reuse it and replaced indexes can be collected.
const maxEnds = new WeakMap<readonly TransitionGeom[], Float64Array>();

/** Conservative inclusive candidate bounds; exact geometry checks remain with each caller. */
function candidateBounds(list: readonly TransitionGeom[], start: number, end: number): [number, number] {
	const ends = maxEnds.get(list);
	// Preserve the public API for caller-supplied maps, whose lists need not be indexed or sorted.
	if (!ends || !Number.isFinite(start) || !Number.isFinite(end)) return [0, list.length];
	let lo = 0;
	let hi = list.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (ends[mid]! < start) lo = mid + 1;
		else hi = mid;
	}
	const first = lo;
	hi = list.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (list[mid]!.start <= end) lo = mid + 1;
		else hi = mid;
	}
	return [first, lo];
}

/**
 * Per-track transitions sorted by start (TUI-004), cached on the identity of the sequence's transitions
 * record (plus clips and media, which move and limit the spans). Structural sharing keeps it stable
 * between unrelated edits and across playhead frames.
 */
export function transitionIndex(seq: Sequence, media: MediaRecord): TransitionIndex {
	const hit = cache.get(seq.transitions);
	if (hit && hit.clips === seq.clips && hit.media === media) return hit.index;
	const index = new Map<string, TransitionGeom[]>();
	for (const t of Object.values(seq.transitions)) {
		const g = transitionGeom(seq, media, t);
		if (!g) continue;
		const list = index.get(g.trackId) ?? [];
		list.push(g);
		index.set(g.trackId, list);
	}
	for (const list of index.values()) {
		list.sort((a, b) => a.start - b.start || a.end - b.end);
		const ends = new Float64Array(list.length);
		let max = Number.NEGATIVE_INFINITY;
		for (let i = 0; i < list.length; i++) {
			max = Math.max(max, list[i]!.end);
			ends[i] = max;
		}
		maxEnds.set(list, ends);
	}
	cache.set(seq.transitions, { clips: seq.clips, media, index });
	return index;
}

/** Transitions of a track that intersect `[f0, f1)`. */
export function transitionsInRange(
	index: TransitionIndex,
	trackId: string,
	f0: number,
	f1: number,
): TransitionGeom[] {
	const list = index.get(trackId);
	if (!list) return [];
	const [first, last] = candidateBounds(list, f0, f1);
	const out: TransitionGeom[] = [];
	for (let i = first; i < last; i++) {
		const g = list[i]!;
		if (g.end > f0 && g.start < f1) out.push(g);
	}
	return out;
}

// ---------------------------------------------------------------- px geometry and hit-testing

/** Minimum hit width so 1–2 px transitions at low zoom stay selectable (S10 §8 test 1). */
const MIN_HIT_PX = 3;
/** TUI-010: edge zones at both ends of the transition rect. */
const EDGE_ZONE_PX = 4;
/** Name strip of a clip body (ClipView NAME_STRIP_PX); transitions sit below it. */
const NAME_STRIP = 14;

/** Vertical extent inside a track row: the clip body minus the name strip, inset 2 px (TUI-001/010). */
export function transitionBand(rowHeight: number): { top: number; height: number } {
	const top = rowHeight >= 30 ? NAME_STRIP : 2;
	return { top, height: Math.max(4, rowHeight - 1 - 2 - top) };
}

type TransitionRect = { x: number; w: number; top: number; height: number };

function transitionRect(g: TransitionGeom, v: Viewport, rowHeight: number): TransitionRect {
	const x = frameToX(v, g.start);
	const w = (g.end - g.start) * v.pxPerFrame;
	return { x, w, ...transitionBand(rowHeight) };
}

/** Edges that resize: centred → both; at-cut and fades → only the edge away from the cut (TUI-012). */
export function resizableEdges(g: TransitionGeom): { start: boolean; end: boolean } {
	if (g.oneSided === 'in') return { start: false, end: true };
	if (g.oneSided === 'out') return { start: true, end: false };
	if (g.t.alignment === 'start-at-cut') return { start: false, end: true };
	if (g.t.alignment === 'end-at-cut') return { start: true, end: false };
	return { start: true, end: true };
}

type TransitionZone = 'start' | 'end' | 'body';
export type TransitionHit = { geom: TransitionGeom; zone: TransitionZone };

/**
 * TUI-010 hit priority inside a row: transition edge → transition body (the caller falls back to clip
 * edges and bodies). `x` is clip-area px, `yInRow` px from the row top.
 */
export function hitTransition(
	index: TransitionIndex,
	row: TrackRow,
	v: Viewport,
	x: number,
	yInRow: number,
): TransitionHit | null {
	const list = index.get(row.trackId);
	if (!list?.length) return null;
	const band = transitionBand(row.height);
	if (yInRow < band.top || yInRow >= band.top + band.height) return null;
	let best: TransitionHit | null = null;
	let bestDist = Number.POSITIVE_INFINITY;
	// Edges extend 2 px; tiny bodies extend at most MIN_HIT_PX / 2. The extra pixel
	// keeps candidate bounds conservative at floating-point frame/pixel boundaries.
	const frame = v.scrollFrame + x / v.pxPerFrame;
	const reach = (Math.max(2, MIN_HIT_PX / 2) + 1) / v.pxPerFrame;
	const [first, last] = candidateBounds(list, frame - reach, frame + reach);
	for (let i = first; i < last; i++) {
		const g = list[i]!;
		const r = transitionRect(g, v, row.height);
		const pad = Math.max(0, (MIN_HIT_PX - r.w) / 2);
		const edgesOk = resizableEdges(g);
		const zone = r.w >= 12 ? EDGE_ZONE_PX : r.w >= 6 ? 2 : 0;
		const x0 = r.x - pad;
		const x1 = r.x + r.w + pad;
		// Edge zones reach 2 px outside the rect so a thin transition's edge stays grabbable.
		if (zone > 0 && edgesOk.start && x >= r.x - 2 && x < r.x + zone) {
			const d = Math.abs(x - r.x);
			if (d < bestDist) {
				best = { geom: g, zone: 'start' };
				bestDist = d;
			}
			continue;
		}
		if (zone > 0 && edgesOk.end && x > r.x + r.w - zone && x <= r.x + r.w + 2) {
			const d = Math.abs(x - (r.x + r.w));
			if (d < bestDist) {
				best = { geom: g, zone: 'end' };
				bestDist = d;
			}
			continue;
		}
		if (x >= x0 && x <= x1) {
			const d = Math.abs(x - (r.x + r.w / 2)) + 1000; // edges win over bodies
			if (d < bestDist) {
				best = { geom: g, zone: 'body' };
				bestDist = d;
			}
		}
	}
	return best;
}

// ---------------------------------------------------------------- gestures (TUI-012/013)

type EdgeDragResult = { duration: number; alignment: Alignment };

/**
 * Edge drag → requested duration and alignment (before `fitTransitionDuration`, which the handler
 * applies). `frame` is the (snapped) boundary frame under the pointer. Centred transitions resize
 * symmetrically; with Alt the other edge stays put and the transition becomes start-/end-at-cut once
 * the dragged edge reaches the cut (otherwise it stays symmetric).
 */
export function edgeDrag(
	g: Pick<TransitionGeom, 'cut' | 'start' | 'end' | 'oneSided'> & { t: Pick<Transition, 'alignment'> },
	edge: 'start' | 'end',
	frame: number,
	alt: boolean,
): EdgeDragResult {
	const { cut } = g;
	const a = g.t.alignment;
	if (g.oneSided === 'in') return { duration: Math.max(1, frame - g.start), alignment: a };
	if (g.oneSided === 'out') return { duration: Math.max(1, g.end - frame), alignment: a };
	if (a === 'start-at-cut') return { duration: Math.max(1, frame - cut), alignment: a };
	if (a === 'end-at-cut') return { duration: Math.max(1, cut - frame), alignment: a };
	// centre
	if (alt) {
		if (edge === 'start' && frame >= cut)
			return { duration: Math.max(1, g.end - cut), alignment: 'start-at-cut' };
		if (edge === 'end' && frame <= cut)
			return { duration: Math.max(1, cut - g.start), alignment: 'end-at-cut' };
	}
	// transitionSpan centre: start = cut − ⌊d/2⌋, end = cut + ⌈d/2⌉.
	const half = edge === 'end' ? frame - cut : cut - frame;
	return { duration: Math.max(1, 2 * half), alignment: 'center' };
}

/**
 * Body drag (two-sided only): the rect follows the pointer and the alignment snaps to the nearest of
 * end-at-cut / centre / start-at-cut (the pointer crossing a third of the span switches).
 */
export function bodyDragAlignment(
	g: Pick<TransitionGeom, 'cut' | 'start' | 'end'>,
	deltaFrames: number,
): Alignment {
	const d = g.end - g.start;
	const centre = (g.start + g.end) / 2 + deltaFrames;
	const options: [Alignment, number][] = [
		['end-at-cut', g.cut - d / 2],
		['center', g.cut],
		['start-at-cut', g.cut + d / 2],
	];
	let best = options[1]!;
	for (const o of options) if (Math.abs(centre - o[1]) < Math.abs(centre - best[1]) - 1e-9) best = o;
	return best[0];
}

/** Span of a would-be transition (fades sit inside the clip at its edge). */
function spanOf(
	cut: number,
	duration: number,
	alignment: Alignment,
	oneSided: 'in' | 'out' | null,
): { start: number; end: number } {
	if (oneSided === 'in') return { start: cut, end: cut + duration };
	if (oneSided === 'out') return { start: cut - duration, end: cut };
	return transitionSpan(cut, duration, alignment);
}

// ---------------------------------------------------------------- drop resolution (TUI-021…024)

/** ±px band around an edit point where the drop targets the cut itself. */
const DROP_BAND_PX = 12;

type HandleFeedback = {
	/** Requested span (default duration) and what fits (`fitTransitionDuration`). */
	wanted: { start: number; end: number };
	fitted: { start: number; end: number } | null;
	/** Available media beyond the cut on each side as frame ranges (drawn as light bands). */
	bands: { start: number; end: number }[];
	/** Parts of the requested span without media (hatched red). */
	missing: { start: number; end: number }[];
	fittedDuration: number;
	wantedDuration: number;
};

export type DropTarget =
	| {
			kind: 'add';
			trackId: string;
			cut: number;
			alignment: Alignment;
			oneSided: 'in' | 'out' | null;
			outgoing: Clip | null;
			incoming: Clip | null;
			feedback: HandleFeedback;
			/** Why nothing fits (N = 0), as the model's E_OUT_OF_MEDIA message. */
			refused: string | null;
	  }
	| { kind: 'replace'; transition: Transition; refused: string | null };

/** Handle availability of a transition of `wanted` frames at a cut (TUI-022). */
export function handleFeedback(input: {
	effectId: string;
	cut: number;
	alignment: Alignment;
	oneSided: 'in' | 'out' | null;
	outgoing: Clip | null;
	incoming: Clip | null;
	wanted: number;
	handles: { tail: number; head: number };
}): HandleFeedback {
	const { cut, alignment, oneSided, outgoing, incoming, effectId } = input;
	const fitted = fitTransitionDuration({
		effectId,
		wanted: input.wanted,
		alignment,
		outgoing: outgoing ? { duration: outgoing.duration, tail: input.handles.tail } : null,
		incoming: incoming ? { duration: incoming.duration, head: input.handles.head } : null,
	});
	const wanted = spanOf(cut, input.wanted, alignment, oneSided);
	const bands: { start: number; end: number }[] = [];
	const missing: { start: number; end: number }[] = [];
	if (!oneSided) {
		// Media reachable across the cut, up to the handle end (within the requested span's reach).
		const reachBefore = Math.max(0, cut - wanted.start);
		const reachAfter = Math.max(0, wanted.end - cut);
		const head = Math.min(input.handles.head, reachBefore);
		const tail = Math.min(input.handles.tail, reachAfter);
		if (head > 0) bands.push({ start: cut - head, end: cut });
		if (tail > 0) bands.push({ start: cut, end: cut + tail });
		const use = handleUse(effectId, cut, wanted.start, wanted.end);
		if (use.head > input.handles.head) missing.push({ start: cut - use.head, end: cut - input.handles.head });
		if (use.tail > input.handles.tail) missing.push({ start: cut + input.handles.tail, end: cut + use.tail });
	} else if (fitted < input.wanted) {
		// A fade longer than its clip.
		const f = spanOf(cut, fitted, alignment, oneSided);
		missing.push(
			oneSided === 'in' ? { start: f.end, end: wanted.end } : { start: wanted.start, end: f.start },
		);
	}
	return {
		wanted,
		fitted: fitted > 0 ? spanOf(cut, fitted, alignment, oneSided) : null,
		bands,
		missing,
		fittedDuration: fitted,
		wantedDuration: input.wanted,
	};
}

/** The model's E_OUT_OF_MEDIA explanation (handlers/transition.ts `noRoomMessage`). */
function noRoomMessage(alignment: Alignment, wanted: number, two: boolean): string {
	if (!two) return 'The clip is too short for this transition';
	const { start, end } = transitionSpan(0, wanted, alignment);
	return (
		`No media handles for a ${wanted}-frame ${alignment} transition: the outgoing clip needs ${Math.max(0, end)} ` +
		`frame(s) of media after its out-point and the incoming clip ${Math.max(0, -start)} before its in-point.`
	);
}

/**
 * Pointer → drop target on a track (TUI-021): near an edit point with two clips the ±12 px band is split
 * in thirds (left → end-at-cut, middle → centre, right → start-at-cut); near a free clip edge → a fade on
 * that edge; elsewhere on a clip → its nearer edge (over the incoming clip → start-at-cut, over the outgoing
 * one → end-at-cut). An existing transition under the pointer is replaced (TUI-023). Null = no target.
 */
export function resolveTransitionDrop(input: {
	seq: Sequence;
	media: MediaRecord;
	trackId: string;
	trackKind: 'video' | 'audio';
	spec: TransitionSpec;
	v: Viewport;
	x: number;
	/** The transition under the pointer, if any (from `hitTransition`). */
	over: TransitionGeom | null;
	wanted: number;
}): DropTarget | null {
	const { seq, trackId, spec, v, x } = input;
	if (spec.appliesTo !== input.trackKind) return null;
	if (input.over) {
		const g = input.over;
		if (g.t.effectId === spec.id) return { kind: 'replace', transition: g.t, refused: null };
		const fits = fitTransitionDuration({
			effectId: spec.id,
			wanted: g.t.duration,
			alignment: g.t.alignment,
			outgoing: g.outgoing ? { duration: g.outgoing.duration, tail: g.handles.tail } : null,
			incoming: g.incoming ? { duration: g.incoming.duration, head: g.handles.head } : null,
		});
		return {
			kind: 'replace',
			transition: g.t,
			refused: fits > 0 ? null : noRoomMessage(g.t.alignment, g.t.duration, !g.oneSided),
		};
	}
	const clips = clipsOnTrack(seq, trackId);
	if (!clips.length) return null;
	const frame = v.scrollFrame + x / v.pxPerFrame;
	// Nearest edit point (clip edge) within the band.
	let cut: number | null = null;
	let bestPx = DROP_BAND_PX + 1;
	for (const c of clips) {
		for (const e of [c.start, endOf(c)]) {
			const d = Math.abs(frameToX(v, e) - x);
			if (d <= DROP_BAND_PX && d < bestPx) {
				bestPx = d;
				cut = e;
			}
		}
	}
	let alignment: Alignment = 'center';
	let outgoing: Clip | null = null;
	let incoming: Clip | null = null;
	if (cut !== null) {
		const at = clipsAtEditPoint(seq, trackId, cut);
		outgoing = at.outgoing;
		incoming = at.incoming;
		if (outgoing && incoming) {
			const dx = x - frameToX(v, cut);
			alignment = dx < -DROP_BAND_PX / 3 ? 'end-at-cut' : dx > DROP_BAND_PX / 3 ? 'start-at-cut' : 'center';
		}
	} else {
		const clip = clips.find((c) => c.start <= frame && frame < endOf(c));
		if (!clip) return null;
		const nearIn = frame - clip.start <= endOf(clip) - frame;
		cut = nearIn ? clip.start : endOf(clip);
		const at = clipsAtEditPoint(seq, trackId, cut);
		outgoing = at.outgoing;
		incoming = at.incoming;
		if (outgoing && incoming) alignment = nearIn ? 'start-at-cut' : 'end-at-cut';
	}
	const oneSided: 'in' | 'out' | null = outgoing && incoming ? null : incoming ? 'in' : 'out';
	if (oneSided) alignment = oneSided === 'in' ? 'start-at-cut' : 'end-at-cut';
	const doc = { media: input.media } as never;
	const handles = {
		tail: outgoing ? clipHandles(doc, seq, outgoing).tail : 0,
		head: incoming ? clipHandles(doc, seq, incoming).head : 0,
	};
	const feedback = handleFeedback({
		effectId: spec.id,
		cut,
		alignment,
		oneSided,
		outgoing,
		incoming,
		wanted: input.wanted,
		handles,
	});
	return {
		kind: 'add',
		trackId,
		cut,
		alignment,
		oneSided,
		outgoing,
		incoming,
		feedback,
		refused: feedback.fittedDuration > 0 ? null : noRoomMessage(alignment, input.wanted, !oneSided),
	};
}

/** The document command of a drop (one history entry "Add Transition" / "Replace Transition"). */
export function dropCommand(target: DropTarget, effectId: string): Record<string, unknown> {
	if (target.kind === 'replace')
		return { type: 'transition.update', transitionId: target.transition.id, effectId };
	if (target.oneSided)
		return {
			type: 'transition.add',
			clipId: (target.oneSided === 'in' ? target.incoming : target.outgoing)!.id,
			edge: target.oneSided,
			effectId,
			duration: target.feedback.wantedDuration,
		};
	return {
		type: 'transition.add',
		trackId: target.trackId,
		at: target.cut,
		effectId,
		alignment: target.alignment,
		duration: target.feedback.wantedDuration,
	};
}

// ---------------------------------------------------------------- Ctrl+D at the playhead (TUI-030)

/**
 * The edit point nearest `frame` on a track (within `[f0, f1]`), as a clip + edge usable by
 * `transition.applyDefault`: the incoming clip's head when a clip starts there, else the outgoing clip's
 * tail. Null when the track has no clip edge in range.
 */
export function nearestEditPoint(
	seq: Sequence,
	trackId: string,
	frame: number,
	range: { f0: number; f1: number } = { f0: Number.NEGATIVE_INFINITY, f1: Number.POSITIVE_INFINITY },
): { clip: Clip; edge: 'in' | 'out'; cut: number } | null {
	let best: { clip: Clip; edge: 'in' | 'out'; cut: number } | null = null;
	let bestD = Number.POSITIVE_INFINITY;
	let bestCut = Number.NaN;
	for (const c of clipsOnTrack(seq, trackId)) {
		for (const [edge, cut] of [
			['in', c.start],
			['out', endOf(c)],
		] as const) {
			if (cut < range.f0 || cut > range.f1) continue;
			const d = Math.abs(cut - frame);
			// Prefer the incoming clip at a shared cut (its head is the same edit point).
			if (d < bestD || (d === bestD && edge === 'in' && bestCut === cut)) {
				best = { clip: c, edge, cut };
				bestD = d;
				bestCut = cut;
			}
		}
	}
	return best;
}
