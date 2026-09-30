// Transitions and fades (S01 §13): the transition registry, handle math (TRN-003) and the resolution of a
// sequence's transitions into what the renderers draw: per-clip handles (extra content before the in-point
// and after the out-point), per-clip opacity ramps, and per-track mattes (the black of a dip to black).
// Pure and shared by the command handlers, the render snapshot, the Remotion composition and the native
// export, so the three agree frame for frame.
import { clipEnd, clipsOnTrack } from './derive/index.ts';
import { isBoundedContent } from './registry/kinds.ts';
import type { RGBA } from './schema/common.ts';
import type { ProjectDocument } from './schema/document.ts';
import type { Clip, Sequence, Transition } from './schema/sequence.ts';
import { flicksPerFrame, type Rational } from './time.ts';

export const CROSS_DISSOLVE = 'jasper.cross-dissolve';
export const DIP_TO_BLACK = 'jasper.dip-to-black';
export const CONSTANT_GAIN = 'jasper.constant-gain';
export const CONSTANT_POWER = 'jasper.constant-power';

export type TransitionSpec = {
	id: string;
	version: number;
	label: string;
	appliesTo: 'video' | 'audio';
	description: string;
};

/** Transitions this build renders (unknown ids in a document are preserved and not rendered, S01:FX-022). */
export const TRANSITION_SPECS: readonly TransitionSpec[] = [
	{
		id: CROSS_DISSOLVE,
		version: 1,
		label: 'Cross Dissolve',
		appliesTo: 'video',
		description:
			'The incoming clip fades in over the outgoing one; at a single clip edge it is a fade from/to transparent.',
	},
	{
		id: DIP_TO_BLACK,
		version: 1,
		label: 'Dip to Black',
		appliesTo: 'video',
		description:
			'The outgoing clip fades to black, then the incoming clip fades in from black; at a single clip edge it is a fade from/to black.',
	},
	{
		id: CONSTANT_GAIN,
		version: 1,
		label: 'Constant Gain',
		appliesTo: 'audio',
		description: 'Linear audio fade at one clip edge (fade in at the head, fade out at the tail).',
	},
	{
		id: CONSTANT_POWER,
		version: 1,
		label: 'Constant Power',
		appliesTo: 'audio',
		description: 'Equal-power (quarter sine) audio fade at one clip edge.',
	},
];

export function transitionSpec(effectId: string): TransitionSpec | null {
	return TRANSITION_SPECS.find((s) => s.id === effectId) ?? null;
}

const EPS = 1e-6;
/** Kinds whose picture does not depend on content time: they have handles on both sides (TRN-003). */
const STATIC_KINDS = new Set(['still', 'solid', 'text']);

/**
 * Content available beyond a clip's edges, in sequence frames (S01:TRN-003, CLP-005): `head` before the
 * in-point, `tail` after the out-point. Stills, solids and text always have handles; bounded media has what
 * the file holds; other generators cannot show content before content time 0.
 */
export function clipHandles(
	doc: Pick<ProjectDocument, 'media'>,
	seq: Pick<Sequence, 'settings'>,
	c: Clip,
): { head: number; tail: number } {
	if (STATIC_KINDS.has(c.kind)) return { head: Number.POSITIVE_INFINITY, tail: Number.POSITIVE_INFINITY };
	const step = flicksPerFrame(seq.settings.frameRate as Rational) * c.speed.rate;
	const mediaId = (c as { mediaId?: string }).mediaId;
	const dur = mediaId ? (doc.media[mediaId]?.probe.durationFlicks ?? null) : null;
	const before = Math.max(0, Math.floor(c.sourceIn / step + EPS));
	const after =
		isBoundedContent(c) && dur !== null
			? Math.max(0, Math.floor((dur - c.sourceIn) / step + EPS) - c.duration)
			: Number.POSITIVE_INFINITY;
	return c.speed.reverse ? { head: after, tail: before } : { head: before, tail: after };
}

/** The frame span `[start, end)` a transition of `duration` frames covers around the edit point `cut`. */
export function transitionSpan(
	cut: number,
	duration: number,
	alignment: Transition['alignment'],
): { start: number; end: number } {
	const start =
		alignment === 'start-at-cut' ? cut : alignment === 'end-at-cut' ? cut - duration : cut - (duration >> 1);
	return { start, end: start + duration };
}

/**
 * The longest duration ≤ `wanted` that fits a transition at an edit point: inside both clips (INV-010) and,
 * for a cross dissolve, inside the handles (the outgoing clip must have content up to the end of the span,
 * the incoming one from its start). A dip to black needs handles only for the part that reaches across the
 * cut. Returns 0 when nothing fits.
 */
export function fitTransitionDuration(input: {
	effectId: string;
	wanted: number;
	alignment: Transition['alignment'];
	outgoing: { duration: number; tail: number } | null;
	incoming: { duration: number; head: number } | null;
}): number {
	const { outgoing, incoming, alignment } = input;
	let d = Math.max(0, Math.floor(input.wanted));
	if (outgoing) d = Math.min(d, outgoing.duration);
	if (incoming) d = Math.min(d, incoming.duration);
	if (!outgoing || !incoming) return d; // a fade uses the clip's own frames only
	const fits = (n: number) => {
		const { start, end } = transitionSpan(0, n, alignment);
		if (input.effectId === DIP_TO_BLACK) {
			const mid = start + Math.ceil(n / 2);
			return Math.max(0, mid) <= outgoing.tail && Math.max(0, -mid) <= incoming.head;
		}
		return Math.max(0, end) <= outgoing.tail && Math.max(0, -start) <= incoming.head;
	};
	while (d > 0 && !fits(d)) d--;
	return d;
}

/**
 * Linear opacity ramp of a clip in sequence frames. `in`: 0 up to `start`, then `(f − start) / frames`, 1 from
 * `start + frames` on. `out`: 1 up to `start`, then `1 − (f − start) / frames`, 0 from `start + frames` on.
 * (The same definition as ffmpeg's `fade` filter, which the native export uses.)
 */
export type RenderFade = { type: 'in' | 'out'; start: number; frames: number };

/** A full-frame colour under a track's clips for a frame span (the black of a dip to black). */
export type RenderMatte = { id: string; start: number; duration: number; color: RGBA };

export type ClipTransitionRender = {
	/** Frames of content drawn before the clip's start (incoming side of a transition). */
	headHandle: number;
	/** Frames of content drawn after the clip's end (outgoing side). */
	tailHandle: number;
	fades: RenderFade[];
};

/** Opacity factor (0…1) of a set of ramps at a sequence frame. */
export function fadeFactor(fades: readonly RenderFade[] | undefined, frame: number): number {
	if (!fades || fades.length === 0) return 1;
	let k = 1;
	for (const f of fades) {
		const p = Math.min(1, Math.max(0, (frame - f.start) / f.frames));
		k *= f.type === 'in' ? p : 1 - p;
	}
	return k;
}

const BLACK: RGBA = [0, 0, 0, 1];

/** True when nothing below the clip can show through it (a cross dissolve may then keep it fully opaque). */
function isOpaque(doc: Pick<ProjectDocument, 'media' | 'synthetics'>, c: Clip): boolean {
	const r = c as { opacity?: { value: number; keyframes: unknown[] }; blendMode?: string };
	if (r.opacity && (r.opacity.value !== 100 || r.opacity.keyframes.length > 0)) return false;
	if (r.blendMode && r.blendMode !== 'normal') return false;
	if (c.kind === 'video' || c.kind === 'still') return doc.media[c.mediaId]?.probe.hasAlpha === false;
	if (c.kind === 'solid') {
		const syn = doc.synthetics[c.syntheticId];
		return syn?.kind === 'color-matte' && syn.color[3] === 1;
	}
	return false;
}

export type ResolvedTransitions = {
	/** clipId → handles and ramps (only clips touched by a rendered transition). */
	clips: Map<string, ClipTransitionRender>;
	/** trackId → mattes. */
	mattes: Map<string, RenderMatte[]>;
	/** Transitions that are not rendered, with the reason (unknown effect, no room). */
	skipped: { transitionId: string; reason: string }[];
};

/**
 * What the video transitions of a sequence mean for rendering (S01 §13). Handles are clamped to what the
 * media holds at render time, so a transition whose clips were trimmed afterwards degrades to a shorter one
 * instead of showing missing frames.
 */
export function resolveVideoTransitions(
	doc: Pick<ProjectDocument, 'media' | 'synthetics'>,
	seq: Sequence,
): ResolvedTransitions {
	const clips = new Map<string, ClipTransitionRender>();
	const mattes = new Map<string, RenderMatte[]>();
	const skipped: ResolvedTransitions['skipped'] = [];
	const entry = (id: string) => {
		let e = clips.get(id);
		if (!e) {
			e = { headHandle: 0, tailHandle: 0, fades: [] };
			clips.set(id, e);
		}
		return e;
	};
	const matte = (t: Transition, start: number, duration: number) => {
		if (duration <= 0) return;
		const list = mattes.get(t.trackId) ?? [];
		list.push({ id: t.id, start, duration, color: BLACK });
		mattes.set(t.trackId, list);
	};
	const videoTracks = new Set(seq.videoTracks.map((t) => t.id));
	for (const t of Object.values(seq.transitions)) {
		if (!videoTracks.has(t.trackId)) continue;
		const spec = transitionSpec(t.effectId);
		if (spec?.appliesTo !== 'video') {
			skipped.push({
				transitionId: t.id,
				reason: `transition ${t.effectId} is not supported by this version`,
			});
			continue;
		}
		const out = t.outgoingClipId ? seq.clips[t.outgoingClipId] : undefined;
		const inc = t.incomingClipId ? seq.clips[t.incomingClipId] : undefined;
		if ((!out && !inc) || (t.outgoingClipId && !out) || (t.incomingClipId && !inc)) continue;
		if ((out && !out.enabled) || (inc && !inc.enabled)) continue;
		const dip = t.effectId === DIP_TO_BLACK;
		if (out && inc) {
			if (clipEnd(out) !== inc.start) continue; // not adjacent (INV-010); cleanup removes these
			const cut = inc.start;
			const d = fitTransitionDuration({
				effectId: t.effectId,
				wanted: t.duration,
				alignment: t.alignment,
				outgoing: { duration: out.duration, tail: clipHandles(doc, seq, out).tail },
				incoming: { duration: inc.duration, head: clipHandles(doc, seq, inc).head },
			});
			if (d <= 0) {
				skipped.push({ transitionId: t.id, reason: 'no media handles for the transition' });
				continue;
			}
			const { start, end } = transitionSpan(cut, d, t.alignment);
			const a = entry(out.id);
			const b = entry(inc.id);
			if (dip) {
				// First half: the outgoing clip fades to black (black on its last frame); second half: the
				// incoming clip fades in. The matte hides the tracks below for the whole span.
				const mid = start + Math.ceil(d / 2);
				a.tailHandle = Math.max(a.tailHandle, mid - cut);
				b.headHandle = Math.max(b.headHandle, cut - mid);
				if (mid > start) a.fades.push({ type: 'out', start: start - 1, frames: mid - start });
				b.fades.push({ type: 'in', start: mid - 1, frames: end - mid + 1 });
				matte(t, start, d);
			} else {
				// The incoming clip fades in over the outgoing one: frame i of d shows (i + 1) / (d + 1) of it.
				// Opaque footage stays fully opaque underneath (an exact mix); anything with transparency
				// fades out at the same time.
				a.tailHandle = Math.max(a.tailHandle, end - cut);
				b.headHandle = Math.max(b.headHandle, cut - start);
				b.fades.push({ type: 'in', start: start - 1, frames: d + 1 });
				if (!(isOpaque(doc, out) && isOpaque(doc, inc)))
					a.fades.push({ type: 'out', start: start - 1, frames: d + 1 });
			}
		} else if (inc) {
			// Fade in at the clip's head: transparent (or black) on its first frame.
			const d = Math.min(t.duration, inc.duration);
			entry(inc.id).fades.push({ type: 'in', start: inc.start, frames: d });
			if (dip) matte(t, inc.start, d);
		} else if (out) {
			// Fade out at the clip's tail: transparent (or black) on its last frame.
			const d = Math.min(t.duration, out.duration);
			const end = clipEnd(out);
			entry(out.id).fades.push({ type: 'out', start: end - d - 1, frames: d });
			if (dip) matte(t, end - d, d);
		}
	}
	return { clips, mattes, skipped };
}

/** Gain ramp of an audio clip edge: `in` at the head, `out` at the tail (S01:TRN-004). */
export type RenderAudioFade = {
	type: 'in' | 'out';
	/** Sequence frame where the ramp begins. */
	start: number;
	frames: number;
	curve: 'linear' | 'equal-power';
};

/** Audio fades (one-sided constant gain / constant power transitions) per audio clip id. */
export function resolveAudioFades(seq: Sequence): Map<string, RenderAudioFade[]> {
	const out = new Map<string, RenderAudioFade[]>();
	const audioTracks = new Set(seq.audioTracks.map((t) => t.id));
	for (const t of Object.values(seq.transitions)) {
		if (!audioTracks.has(t.trackId)) continue;
		const spec = transitionSpec(t.effectId);
		if (spec?.appliesTo !== 'audio') continue;
		const curve = t.effectId === CONSTANT_POWER ? 'equal-power' : 'linear';
		const push = (id: string, f: RenderAudioFade) => out.set(id, [...(out.get(id) ?? []), f]);
		const o = t.outgoingClipId ? seq.clips[t.outgoingClipId] : undefined;
		const i = t.incomingClipId ? seq.clips[t.incomingClipId] : undefined;
		if (o && i) continue; // audio crossfades need handles on both clips: not rendered yet
		if (i) push(i.id, { type: 'in', start: i.start, frames: Math.min(t.duration, i.duration), curve });
		else if (o) {
			const d = Math.min(t.duration, o.duration);
			push(o.id, { type: 'out', start: clipEnd(o) - d, frames: d, curve });
		}
	}
	return out;
}

/** Gain factor (0…1) of audio fades at a (fractional) sequence frame. */
export function audioFadeGain(fades: readonly RenderAudioFade[] | undefined, frame: number): number {
	if (!fades || fades.length === 0) return 1;
	let k = 1;
	for (const f of fades) {
		const p = Math.min(1, Math.max(0, (frame - f.start) / f.frames));
		const x = f.type === 'in' ? p : 1 - p;
		k *= f.curve === 'equal-power' ? Math.sin((x * Math.PI) / 2) : x;
	}
	return k;
}

/** The transitions at a clip edge (`in` = head, `out` = tail). */
export function transitionAtEdge(seq: Sequence, clipId: string, edge: 'in' | 'out'): Transition | null {
	for (const t of Object.values(seq.transitions)) {
		if (edge === 'in' ? t.incomingClipId === clipId : t.outgoingClipId === clipId) return t;
	}
	return null;
}

/** Clips that meet at frame `at` on a track: the one ending there and the one starting there. */
export function clipsAtEditPoint(
	seq: Sequence,
	trackId: string,
	at: number,
): { outgoing: Clip | null; incoming: Clip | null } {
	let outgoing: Clip | null = null;
	let incoming: Clip | null = null;
	for (const c of clipsOnTrack(seq, trackId)) {
		if (clipEnd(c) === at) outgoing = c;
		if (c.start === at) incoming = c;
	}
	return { outgoing, incoming };
}
