// Transitions and fades (S01 §13): the transition registry, handle math (TRN-003) and the resolution of a
// sequence's transitions into what the renderers draw: per-clip handles (extra content before the in-point
// and after the out-point), per-clip opacity ramps, and per-track mattes (the black of a dip to black).
// Pure and shared by the command handlers, the render snapshot, the Remotion composition and the native
// export, so the three agree frame for frame.
// Wave-2 transition framework (docs/wp-notes/fx-transition-framework.md): `TRANSITION_SPECS` = the four built-ins
// (opacity ramps / mattes / audio gain, native ffmpeg export) + the GPU transition catalogue
// (`registry/transitions/*`, `FX_TRANSITIONS`). A GPU transition resolves to a `RenderTransition` of its track (the
// frame-space shader stage of the compositions) instead of ramps; both clips get the handles the span needs.
import { clipEnd, clipsOnTrack } from './derive/index.ts';
import type { ParamSpec } from './registry/effects.ts';
import { contentDurationFlicks, isBoundedContent } from './registry/kinds.ts';
import { FX_TRANSITIONS } from './registry/transitions/index.ts';
import type { GpuTransition, TrSideTrack } from './registry/transitions/shader.ts';
import type { Animatable, ParamValue, RGBA } from './schema/common.ts';
import type { ProjectDocument } from './schema/document.ts';
import type { Clip, Sequence, Transition } from './schema/sequence.ts';
import { FRAME_EPS, flicksPerFrame, type Rational } from './time.ts';

export const CROSS_DISSOLVE = 'jasper.cross-dissolve';
export const DIP_TO_BLACK = 'jasper.dip-to-black';
export const CONSTANT_GAIN = 'jasper.constant-gain';
export const CONSTANT_POWER = 'jasper.constant-power';

/**
 * A transition type (the transition registry, S01:TRN-001 `effectId`). Built-ins render as opacity ramps, mattes
 * and audio gain (native ffmpeg export); GPU transitions (`gpu`, `defineShaderTransition`) as a frame-space shader
 * stage over both clips (Remotion export).
 */
export type TransitionSpec = {
	id: string;
	version: number;
	label: string;
	appliesTo: 'video' | 'audio';
	description: string;
	/**
	 * Effects-panel folder under Video / Audio Transitions: Premiere's bins (3D Motion, Dissolve, Iris, Page Peel,
	 * Slide, Wipe, Zoom; Crossfade for audio) or "Sapphire Transitions" (`TRANSITION_BINS`).
	 */
	bin: string;
	/** Sub-folder inside `bin` (Sapphire: Dissolves / Wipes / Other). */
	subBin?: string;
	keywords?: readonly string[];
	/**
	 * Parameters (Effect Controls' Transition section, `transition.add/update {params}`, `param.set` on
	 * `["transition", id, name]`). Animatable ones take keyframes whose time is flicks from the span's first frame.
	 */
	params: readonly ParamSpec[];
	/** GPU realization (absent: a built-in rendered by the composition's ramps and the native builder). */
	gpu?: GpuTransition;
	capabilities: { preview: 'css' | 'webgl'; export: readonly ('native' | 'remotion')[] };
	/**
	 * Heavy in the preview (many taps per pixel, multi-pass blurs, iterative passes), as `EffectSpec.expensive`: Effect
	 * Controls marks the Transition section with the same dot as expensive effects; the agent schema exports it.
	 */
	expensive?: boolean;
	/** Params of an older `effectVersion` → this version's (as `EffectSpec.migrate`). */
	migrate?(fromVersion: number, params: Record<string, unknown>): Record<string, unknown>;
};

const BUILTIN = { preview: 'css', export: ['native', 'remotion'] } as const;

/** The built-in transitions (native ffmpeg path; their rendering is unchanged since M2). */
export const BUILTIN_TRANSITION_SPECS: readonly TransitionSpec[] = [
	{
		id: CROSS_DISSOLVE,
		version: 1,
		label: 'Cross Dissolve',
		appliesTo: 'video',
		description:
			'The incoming clip fades in over the outgoing one; at a single clip edge it is a fade from/to transparent.',
		bin: 'Dissolve',
		keywords: ['fade', 'mix', 'dissolve'],
		params: [],
		capabilities: BUILTIN,
	},
	{
		id: DIP_TO_BLACK,
		version: 1,
		label: 'Dip to Black',
		appliesTo: 'video',
		description:
			'The outgoing clip fades to black, then the incoming clip fades in from black; at a single clip edge it is a fade from/to black.',
		bin: 'Dissolve',
		keywords: ['fade', 'black', 'dip'],
		params: [],
		capabilities: BUILTIN,
	},
	{
		id: CONSTANT_GAIN,
		version: 1,
		label: 'Constant Gain',
		appliesTo: 'audio',
		description:
			'Linear audio crossfade between two clips (the amplitudes sum to 1); at a single clip edge a linear fade in or out.',
		bin: 'Crossfade',
		params: [],
		capabilities: BUILTIN,
	},
	{
		id: CONSTANT_POWER,
		version: 1,
		label: 'Constant Power',
		appliesTo: 'audio',
		description:
			'Equal-power (quarter sine) audio crossfade between two clips (no level dip or bump); at a single clip edge an equal-power fade.',
		bin: 'Crossfade',
		params: [],
		capabilities: BUILTIN,
	},
];

/** Transitions this build renders (unknown ids in a document are preserved and not rendered, S01:FX-022). */
export const TRANSITION_SPECS: readonly TransitionSpec[] = [...BUILTIN_TRANSITION_SPECS, ...FX_TRANSITIONS];

const BY_ID = new Map(TRANSITION_SPECS.map((s) => [s.id, s]));

export function transitionSpec(effectId: string): TransitionSpec | null {
	return BY_ID.get(effectId) ?? null;
}

/** The transition renders as a GPU shader stage (Remotion path) rather than ramps (native-capable). */
export function isGpuTransition(spec: Pick<TransitionSpec, 'gpu'> | null | undefined): boolean {
	return !!spec?.gpu;
}

/** A transition's params with every declared param present (stored value or default), unknown names dropped. */
export function transitionParamsOf(
	spec: Pick<TransitionSpec, 'params'>,
	params: Readonly<Record<string, Animatable<ParamValue>>>,
): Record<string, Animatable<ParamValue>> {
	const out: Record<string, Animatable<ParamValue>> = {};
	for (const p of spec.params) out[p.name] = params[p.name] ?? { value: p.default, keyframes: [] };
	return out;
}

/**
 * The project's default transition length for a medium, in frames (S10:TUI-032): video
 * `settings.defaultTransitionFrames`, audio `settings.defaultAudioTransitionFrames` (falls back to the video
 * length in projects that do not have it).
 */
export function defaultTransitionFrames(
	settings: Pick<ProjectDocument['settings'], 'defaultTransitionFrames' | 'defaultAudioTransitionFrames'>,
	medium: 'video' | 'audio',
): number {
	return medium === 'audio'
		? (settings.defaultAudioTransitionFrames ?? settings.defaultTransitionFrames)
		: settings.defaultTransitionFrames;
}

const EPS = FRAME_EPS;
/** Kinds whose picture does not depend on content time: they have handles on both sides (TRN-003). */
const STATIC_KINDS = new Set(['still', 'solid', 'text']);

/**
 * Content available beyond a clip's edges, in sequence frames (S01:TRN-003, CLP-005): `head` before the
 * in-point, `tail` after the out-point. Stills, solids and text always have handles; bounded media has what
 * the file holds; other generators cannot show content before content time 0.
 */
export function clipHandles(
	doc: Pick<ProjectDocument, 'media'> & Partial<Pick<ProjectDocument, 'sequences'>>,
	seq: Pick<Sequence, 'settings'>,
	c: Clip,
): { head: number; tail: number } {
	// edit-structure: a held clip shows one frame whatever the content time.
	if (STATIC_KINDS.has(c.kind) || c.frameHold)
		return { head: Number.POSITIVE_INFINITY, tail: Number.POSITIVE_INFINITY };
	const step = flicksPerFrame(seq.settings.frameRate as Rational) * c.speed.rate;
	// Media duration, or the composition length for composition clips (S08:MGC-004).
	const dur = contentDurationFlicks(doc, c);
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
 * First sequence frame of a transition's span as stored (before render-time clamping to the handles), or null when
 * its clips are missing. Two-sided: `transitionSpan(cut, duration, alignment)`; a fade: inside its clip.
 */
export function transitionStartFrame(
	seq: Pick<Sequence, 'clips'>,
	t: Pick<Transition, 'outgoingClipId' | 'incomingClipId' | 'duration' | 'alignment'>,
): number | null {
	const out = t.outgoingClipId ? seq.clips[t.outgoingClipId] : undefined;
	const inc = t.incomingClipId ? seq.clips[t.incomingClipId] : undefined;
	if (inc && out) return transitionSpan(inc.start, t.duration, t.alignment).start;
	if (inc) return inc.start;
	if (out) return clipEnd(out) - Math.min(t.duration, out.duration);
	return null;
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
	/**
	 * edit-structure (freeze-frame handles, `Transition.freezeHandles`): handle frames the media does not have. The
	 * first `freezeHead` frames of the head handle show the earliest available frame (the one at sequence frame
	 * `start − headHandle + freezeHead`), the last `freezeTail` frames of the tail handle the latest one.
	 */
	freezeHead?: number;
	freezeTail?: number;
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

/**
 * A GPU transition of a track as the compositions draw it (wave-2 transition framework): the frame-space shader stage
 * over `[start, start + duration)` that replaces the outgoing ("A") and incoming ("B") clip on their track. Both
 * clips are drawn with the handles the span needs (no ramps); the stage composites them.
 */
export type RenderTransition = {
	id: string;
	effectId: string;
	effectVersion: number;
	/** First sequence frame of the span and its length in frames. */
	start: number;
	duration: number;
	/** Two-sided, or a fade at the head of B (`in`) / the tail of A (`out`). */
	sides: 'both' | 'in' | 'out';
	outgoingClipId: string | null;
	incomingClipId: string | null;
	/** Every declared param (stored or default); keyframe times are flicks from `start`. */
	params: Record<string, Animatable<ParamValue>>;
	/**
	 * The sides' trackers over the span (one geometry per span frame, sequence px; see `transitionSideTrack`), set by
	 * the render snapshot for sides whose clip has a tracker (S_MochaWhip follows the incoming clip's). Absent = none.
	 */
	tracks?: { out?: TrSideTrack; in?: TrSideTrack };
};

export type ResolvedTransitions = {
	/** clipId → handles and ramps (only clips touched by a rendered transition). */
	clips: Map<string, ClipTransitionRender>;
	/** trackId → mattes. */
	mattes: Map<string, RenderMatte[]>;
	/** trackId → GPU transition stages (sorted by start). */
	stages: Map<string, RenderTransition[]>;
	/** Transitions that are not rendered, with the reason (unknown effect, no room). */
	skipped: { transitionId: string; reason: string }[];
};

/**
 * What the video transitions of a sequence mean for rendering (S01 §13). Handles are clamped to what the
 * media holds at render time, so a transition whose clips were trimmed afterwards degrades to a shorter one
 * instead of showing missing frames.
 */
export function resolveVideoTransitions(
	doc: Pick<ProjectDocument, 'media' | 'synthetics'> & Partial<Pick<ProjectDocument, 'sequences'>>,
	seq: Sequence,
): ResolvedTransitions {
	const clips = new Map<string, ClipTransitionRender>();
	const mattes = new Map<string, RenderMatte[]>();
	const stages = new Map<string, RenderTransition[]>();
	const skipped: ResolvedTransitions['skipped'] = [];
	const entry = (id: string) => {
		let e = clips.get(id);
		if (!e) {
			e = { headHandle: 0, tailHandle: 0, fades: [] };
			clips.set(id, e);
		}
		return e;
	};
	const stage = (
		t: Transition,
		spec: TransitionSpec,
		start: number,
		duration: number,
		sides: RenderTransition['sides'],
	) => {
		if (duration <= 0) return;
		const list = stages.get(t.trackId) ?? [];
		list.push({
			id: t.id,
			effectId: t.effectId,
			effectVersion: t.effectVersion,
			start,
			duration,
			sides,
			outgoingClipId: sides === 'in' ? null : t.outgoingClipId,
			incomingClipId: sides === 'out' ? null : t.incomingClipId,
			params: transitionParamsOf(spec, t.params as Record<string, Animatable<ParamValue>>),
		});
		stages.set(t.trackId, list);
	};
	const matte = (t: Transition, start: number, duration: number) => {
		if (duration <= 0) return;
		const list = mattes.get(t.trackId) ?? [];
		list.push({ id: t.id, start, duration, color: BLACK });
		mattes.set(t.trackId, list);
	};
	const videoTracks = new Set(seq.videoTracks.map((t) => t.id));
	const frozenHandles: {
		a: ClipTransitionRender;
		b: ClipTransitionRender;
		avail: { head: number; tail: number };
	}[] = [];
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
		const gpu = isGpuTransition(spec);
		if (out && inc) {
			if (clipEnd(out) !== inc.start) continue; // not adjacent (INV-010); cleanup removes these
			const cut = inc.start;
			const avail = { tail: clipHandles(doc, seq, out).tail, head: clipHandles(doc, seq, inc).head };
			// Freeze-frame handles: the clips' lengths are the only limit; missing media repeats the edge frames.
			const freeze = t.freezeHandles === true;
			const d = fitTransitionDuration({
				effectId: t.effectId,
				wanted: t.duration,
				alignment: t.alignment,
				outgoing: { duration: out.duration, tail: freeze ? Number.POSITIVE_INFINITY : avail.tail },
				incoming: { duration: inc.duration, head: freeze ? Number.POSITIVE_INFINITY : avail.head },
			});
			if (d <= 0) {
				skipped.push({ transitionId: t.id, reason: 'no media handles for the transition' });
				continue;
			}
			const { start, end } = transitionSpan(cut, d, t.alignment);
			const a = entry(out.id);
			const b = entry(inc.id);
			if (freeze) {
				// Recorded after the handles are set below (see the end of this branch).
				frozenHandles.push({ a, b, avail });
			}
			if (gpu) {
				// Both clips are drawn over the whole span (handles); the shader stage composites them.
				a.tailHandle = Math.max(a.tailHandle, end - cut);
				b.headHandle = Math.max(b.headHandle, cut - start);
				stage(t, spec, start, d, 'both');
			} else if (dip) {
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
		} else if (inc && gpu) {
			// A GPU transition at a free head: from transparent to B, over B's own first frames.
			stage(t, spec, inc.start, Math.min(t.duration, inc.duration), 'in');
		} else if (out && gpu) {
			const d = Math.min(t.duration, out.duration);
			stage(t, spec, clipEnd(out) - d, d, 'out');
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
	// Freeze-frame handles: the part of each handle beyond the media (max over the clip's transitions).
	for (const { a, b, avail } of frozenHandles) {
		if (a.tailHandle > avail.tail) a.freezeTail = Math.max(a.freezeTail ?? 0, a.tailHandle - avail.tail);
		if (b.headHandle > avail.head) b.freezeHead = Math.max(b.freezeHead ?? 0, b.headHandle - avail.head);
	}
	for (const list of stages.values()) list.sort((x, y) => x.start - y.start || x.id.localeCompare(y.id));
	return { clips, mattes, stages, skipped };
}

/** Gain ramp of an audio clip edge: `in` at the head, `out` at the tail (S01:TRN-004). */
export type RenderAudioFade = {
	type: 'in' | 'out';
	/** Sequence frame where the ramp begins. */
	start: number;
	frames: number;
	curve: 'linear' | 'equal-power';
};

/** What the audio transitions of a sequence mean for one audio clip (S01:TRN-004, S10:TUI-052). */
export type AudioClipTransitionRender = {
	/** Frames of content played before the clip's start (incoming side of a crossfade). */
	headHandle: number;
	/** Frames of content played after the clip's end (outgoing side of a crossfade). */
	tailHandle: number;
	fades: RenderAudioFade[];
};

export type ResolvedAudioTransitions = {
	/** clipId → handles and gain ramps (only clips touched by a rendered audio transition). */
	clips: Map<string, AudioClipTransitionRender>;
	/** Crossfades that are not rendered, with the reason (no room in the media handles). */
	skipped: { transitionId: string; reason: string }[];
};

/**
 * What the audio transitions (constant gain / constant power) of a sequence mean for rendering. One-sided
 * ones are gain ramps over the clip's own first / last frames. A two-sided one (a crossfade, S10:TUI-052)
 * covers `transitionSpan(cut, d, alignment)` = [s, e): the outgoing clip plays `e − cut` frames into its tail
 * handle and fades out over [s, e), the incoming one starts `cut − s` frames early (head handle) and fades in
 * over the same span. Linear ramps keep the sum of the amplitudes at 1, equal-power (quarter sine / cosine)
 * ramps the sum of the powers. Handles are clamped to what the media holds at render time (as for video),
 * so a crossfade whose clips were trimmed afterwards degrades to a shorter one.
 */
export function resolveAudioTransitions(
	doc: Pick<ProjectDocument, 'media'>,
	seq: Sequence,
): ResolvedAudioTransitions {
	const clips = new Map<string, AudioClipTransitionRender>();
	const skipped: ResolvedAudioTransitions['skipped'] = [];
	const entry = (id: string) => {
		let e = clips.get(id);
		if (!e) {
			e = { headHandle: 0, tailHandle: 0, fades: [] };
			clips.set(id, e);
		}
		return e;
	};
	const audioTracks = new Set(seq.audioTracks.map((t) => t.id));
	for (const t of Object.values(seq.transitions)) {
		if (!audioTracks.has(t.trackId)) continue;
		const spec = transitionSpec(t.effectId);
		if (spec?.appliesTo !== 'audio') continue;
		const curve = t.effectId === CONSTANT_POWER ? 'equal-power' : 'linear';
		const o = t.outgoingClipId ? seq.clips[t.outgoingClipId] : undefined;
		const i = t.incomingClipId ? seq.clips[t.incomingClipId] : undefined;
		if (o && i) {
			if (!o.enabled || !i.enabled) continue;
			if (clipEnd(o) !== i.start) continue; // not adjacent (INV-010); cleanup removes these
			const cut = i.start;
			const d = fitTransitionDuration({
				effectId: t.effectId,
				wanted: t.duration,
				alignment: t.alignment,
				outgoing: { duration: o.duration, tail: clipHandles(doc, seq, o).tail },
				incoming: { duration: i.duration, head: clipHandles(doc, seq, i).head },
			});
			if (d <= 0) {
				skipped.push({ transitionId: t.id, reason: 'no media handles for the audio crossfade' });
				continue;
			}
			const { start, end } = transitionSpan(cut, d, t.alignment);
			const a = entry(o.id);
			const b = entry(i.id);
			a.tailHandle = Math.max(a.tailHandle, end - cut);
			b.headHandle = Math.max(b.headHandle, cut - start);
			a.fades.push({ type: 'out', start, frames: d, curve });
			b.fades.push({ type: 'in', start, frames: d, curve });
		} else if (i) {
			entry(i.id).fades.push({ type: 'in', start: i.start, frames: Math.min(t.duration, i.duration), curve });
		} else if (o) {
			const d = Math.min(t.duration, o.duration);
			entry(o.id).fades.push({ type: 'out', start: clipEnd(o) - d, frames: d, curve });
		}
	}
	return { clips, skipped };
}

/**
 * Audio fades per audio clip id (see `resolveAudioTransitions`, which also gives the handles a crossfade
 * plays). Without `doc` the media length is unknown: tail handles are then only limited by the clips.
 */
export function resolveAudioFades(
	seq: Sequence,
	doc: Pick<ProjectDocument, 'media'> = { media: {} },
): Map<string, RenderAudioFade[]> {
	const out = new Map<string, RenderAudioFade[]>();
	for (const [id, x] of resolveAudioTransitions(doc, seq).clips) if (x.fades.length) out.set(id, x.fades);
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
