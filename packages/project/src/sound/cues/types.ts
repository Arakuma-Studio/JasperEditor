// Cue derivation types (spec 12 §2.2 "Derivation", P2-R3). Pure data; see ./derive.ts for the algorithm.

import type { MgTemplateRegistry } from '../../registry/mg.ts';
import { type CueAnchor, SOUND_DENSITIES, type SoundDensity } from '../../schema/sound.ts';
import type { SoundAlign, SoundTypeId, SoundWeight, VisualKind } from '../taxonomy.ts';
import type { VoiceActivity } from './dialogue.ts';

/** Where a cue's frame comes from: the stored cue's `CueAnchor` (spec 12 §2.2; `resolveCueAnchor` finds it again). */
export type DerivedCueAnchor = CueAnchor;

/**
 * The derivation sources (each individually selectable in Suggest Cues…). `scene`, `beat` and `pixel` need media
 * analysis and are computed by the engine (P6); it passes their cues in `DeriveCuesOptions.extraCues` so they are
 * merged, scored and budgeted with the rest.
 */
export const PROJECT_CUE_SOURCES = [
	'edits',
	'transitions',
	'keyframes',
	'text',
	'mg',
	'clipEdges',
	'camera3d',
	'markers',
] as const;
export const ENGINE_CUE_SOURCES = ['scene', 'beat', 'pixel'] as const;
export const CUE_DERIVE_SOURCES = [...PROJECT_CUE_SOURCES, ...ENGINE_CUE_SOURCES] as const;
export type CueDeriveSource = (typeof CUE_DERIVE_SOURCES)[number];
const SOURCE_SET: ReadonlySet<string> = new Set(CUE_DERIVE_SOURCES);
export function isCueDeriveSource(v: unknown): v is CueDeriveSource {
	return typeof v === 'string' && SOURCE_SET.has(v);
}

/** `SoundCue.kind` values a derived cue can have (visual events, plus `manual` for `sfx:` markers). */
export type DerivedCueKind = VisualKind | 'manual';

/** The densities of Suggest Cues (the stored settings' `SOUND_DENSITIES`). */
export const CUE_DENSITIES = SOUND_DENSITIES;
export type CueDensity = SoundDensity;

export type DerivedCue = {
	/**
	 * Stable key of the event (source + anchor, plus the unit of a pattern member): the same edit derives the same key
	 * every time, so a caller can match suggestions against cues it already stored. Not a document id.
	 */
	key: string;
	frame: number;
	kind: DerivedCueKind;
	weight: SoundWeight;
	/** Ranked suggestions, best first (may be empty for a marker naming no known type). */
	types: SoundTypeId[];
	align: SoundAlign;
	/** Static pan −60…60 (`pan:'auto'` = on-screen x mapped to ±60); absent = centre / not positional. */
	pan?: number;
	/** Whooshes: pan at `window.start` → at `window.end` (placement keyframes the pan, spec 12 §2.3). */
	panSweep?: { from: number; to: number };
	anchor: DerivedCueAnchor;
	/**
	 * Frames from where the anchor resolves to the cue (`snapToBeats` moved it onto a beat, ≤ 2); absent = on it.
	 * Stored as `SoundCue.anchorOffset`.
	 */
	anchorOffset?: number;
	/** Other events merged into this cue (within 2 frames); their description is also in `reason`. */
	also?: DerivedCueAnchor[];
	/** 0…1. */
	confidence: number;
	/** Human-readable why, e.g. "Scale 100→120 % ends (ease-out) on V2 'Logo'". */
	reason: string;
	/** Span of the visual event (frames, end exclusive): a transition, a move, a ramp. */
	window?: { start: number; end: number };
	/** `marker` for cues read from `sfx:` markers; everything else is `derived`. */
	source: 'derived' | 'marker';
	/** The derivation source (counts per source, selection). */
	from: CueDeriveSource;
	/** Pattern cues (typewriter keys, per-unit reveals) share a group id; a group counts as one cue in budgets. */
	group?: string;
	/** Score used by the budget (confidence × weight × size × novelty), 0…1. */
	score: number;
};

/** A cue computed elsewhere (engine sources: scene cuts, beats, pixel motion), merged and budgeted with the rest. */
export type ExtraCue = Omit<DerivedCue, 'score' | 'source' | 'key'> & {
	key?: string;
	source?: 'derived' | 'marker';
	/** 0…1 on-screen size of the event (default 1). */
	size?: number;
};

export type DeriveCuesOptions = {
	/** Sequence frames `[start, end)`; default the whole sequence. */
	range?: { start: number; end: number };
	/** Sources to use; default every project source (engine sources only contribute through `extraCues`). */
	sources?: ReadonlySet<CueDeriveSource> | readonly CueDeriveSource[];
	density?: CueDensity;
	/** Smallest distance between two kept cues (pattern members excepted), frames. Default 0 (merging only). */
	minGapFrames?: number;
	/** At most this many cues are returned (pattern members count one each). */
	maxCues?: number;
	/**
	 * Where dialogue is heard (`dialogueSpans`: transcript words, else the voice activity of Essential Sound dialogue
	 * clips, else their whole spans): no `cut` cues, and derived heroes become support. Default true.
	 */
	respectDialogue?: boolean;
	/** Voice activity of dialogue clips measured by the engine (the cue route's `voiceActivity`); absent = whole clips. */
	voiceActivity?: VoiceActivity | null;
	/** Motion-graphic templates (intro/outro lengths); without it the `mg` source finds nothing. */
	mgTemplates?: MgTemplateRegistry;
	/**
	 * Cues of engine-only sources (scene, beat, pixel) to merge in. Scene and pixel `cut`s respect dialogue like edit
	 * points; pixel cues (a measurement of the rendered picture) give way to a project source describing the same event
	 * (inside its window, or within 3 frames of it).
	 */
	extraCues?: readonly ExtraCue[];
	/**
	 * Snap the kept cues of the kinds that tolerate it (move, transition, emphasis, reveal) to the nearest of these
	 * beat frames within 2 frames (`snapToBeats`); the beat cues in `extraCues` are used when absent.
	 */
	snapToBeats?: boolean;
	beatFrames?: readonly number[];
};

export type CueSourceStats = {
	/** Events found (before merging and budgets). */
	found: number;
	/** Cues of this source in the result (as the primary of a merged cue). */
	kept: number;
	/** Folded into a cue of another event within 2 frames. */
	merged: number;
	/** Dropped by the density budget (rate, gap, maxCues, minimum confidence). */
	droppedByBudget: number;
	/** `cut` events silenced because dialogue is heard there. */
	suppressedByDialogue: number;
};

export type DeriveCuesStats = {
	bySource: Record<CueDeriveSource, CueSourceStats>;
	/** Dropped cues by budget rule. */
	dropped: { rate: number; gap: number; maxCues: number; confidence: number; range: number };
	/** Heroes turned into support cues by the hero spacing (≤ 1 per 1.5/2/3 s, never two within 0.5 s). */
	heroesDemoted: number;
	/** Derived heroes made support because dialogue is heard at their frame (`respectDialogue`). */
	heroesUnderDialogue: number;
	/** Cues `snapToBeats` moved onto a beat. */
	snappedToBeat: number;
	found: number;
	kept: number;
};

export type DeriveCuesWarning = {
	code:
		| 'W_SEQUENCE_NOT_FOUND'
		| 'W_SOURCE_FAILED'
		| 'W_SAMPLING_TRUNCATED'
		| 'W_MG_REGISTRY_MISSING'
		| 'W_EXTRA_CUE_INVALID';
	message: string;
	source?: CueDeriveSource;
	clipId?: string;
};

export type CueSpeedCurve = {
	clipId: string;
	/** Sequence frame of `speed[0]`. */
	start: number;
	/**
	 * Motion speed per frame (screen diagonals per second, with scale and rotation folded in; spec 12 §2.2), 0 where
	 * the clip does not move or was not sampled.
	 */
	speed: Float32Array;
};

export type DeriveCuesResult = {
	cues: DerivedCue[];
	curves: CueSpeedCurve[];
	stats: DeriveCuesStats;
	warnings: DeriveCuesWarning[];
};

/** A raw event before scoring: every source produces these. */
export type CueCandidate = Omit<DerivedCue, 'score'> & {
	/** On-screen size 0…1 (area fraction, 1 for full-frame events). */
	size: number;
	/** Exempt from the minimum confidence, rate and gap budgets (explicit `sfx:` markers). */
	explicit?: boolean;
};
