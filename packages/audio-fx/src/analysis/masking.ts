// Masking solver (spec 12 §2.4, P4-R1; wp-note "Phase 4 → WP4.1a"): clip gains for placed sound effects so each one
// clears the bed (dialogue, music, ambience: everything that is not SFX) by a target lift in its dominant octave
// band, under ordered constraints that are re-verified after the last step. Pure, deterministic, never throws.
//
//   target     dominant bands D = the strongest octave band of the sound plus the second strongest when its energy
//              share is ≥ 10 %; lift = level(sound in D) + gain − level(bed in D); the gain that reaches the weight's
//              target lift (hero +5, support +3.5, ambient +2 dB), never below the event's base (default) gain,
//              plus the user's offset
//   1 clamp        gain ∈ [−30, +12] dB
//   2 bed-cap      sound peak (max momentary, LUFS) + gain − local bed peak ≤ +10 LU hero / +6 LU support, ambient;
//                  the bed reference is never under programme −12 LU (a silent bed would otherwise mute the sound)
//   3 hero-shadow  a support within 0.15 s of a hero: gain × 0.6 (−4.44 dB)
//   4 consistency  repeats within the group median ±2 dB: disjoint groups, by soundId when it repeats, else by type
//                  and weight
//   5 dialogue     during speech, lift in each of the 1, 2 and 4 kHz bands ≤ +1 dB
//   6 headroom     sound true peak + gain ≤ the ceiling (default −1 dBTP, pre-master); unmeasured peak: no boost;
//                  then the SUMMED true peak of the measured events playing at once (each clique of overlapping
//                  windows: Σ 10^(tp/20) ≤ 10^(ceiling/20), an upper bound of the true peak of their sum) — a clique
//                  over it is lowered together by the same dB (members an earlier step holds at their floor keep it,
//                  the others take the rest; `overlap-headroom`)
//
// Overlapping sound effects (spec 12 §2.4 "hero vs support"; wp-note "WP6.5b"): a sound effect of a LOWER weight that
// plays under an event is part of that event's bed for the target lift (ambient → support → hero: an ambience masks the
// supports and heroes over it, a support masks a hero), its power spread evenly over its own window and counted by the
// share of the event's window it covers. Peers (the same weight) do not mask each other — two equal sounds cannot
// each clear the other by a positive lift — and the layers of one cue (`cueKey`) are one designed sound. A hero does
// not mask its supports: step 3 keeps them under it on purpose. The bed cap and the dialogue guard stay against the
// bed (the non-SFX mix and the speech in it). The gains depend on each other through the masking, so the solve is
// repeated with the lower sounds at the previous solve's gains until no gain moves more than MASKING_TOLERANCE_DB
// (at most MAX_MASKING_ITERATIONS more passes; the masking only raises targets, so the passes rise monotonically and
// converge; W_UNCONVERGED otherwise). The summed-true-peak cut comes after the fixed point (it only lowers gains).
//
// Steps 1, 2, 3, 5 and 6 narrow a per-event interval [lo, hi] of allowed gains and move the gain into it. A step whose
// bound does not meet the interval left by the earlier steps loses: the earlier (safety) constraint is kept and the
// event reports `conflict:<earlier>/<later>`. Consistency is a relation, not a bound: it is settled at step 4 and
// again after step 6 around each group's median (a group lowered together by steps 5–6 stays consistent; a member
// pushed out of the window goes back to it, reporting the step-5/6 bound it breaks; a member that steps 1–3 hold
// under the window leaves the median and reports that conflict). After step 6 every constraint is checked on the
// final gain (rounded to
// 0.01 dB, which may miss a bound by at most 0.005 dB when the allowed interval holds no 0.01 dB step); a violation
// without a reported conflict is a W_UNRESOLVED warning (the tests require none).
import { BAND_FLOOR_DB, OCTAVE_BAND_CENTRES_HZ } from './bands.ts';

/**
 * A lift this large means the bed under the sound is at the measurement floor (nothing plays under it): the reason
 * says so instead of quoting a lift over silence ("+86.7 dB", Phase 4 verification real run).
 */
export const SILENT_BED_LIFT_DB = 60;

// ── constants (sources and reasoning: wp-note "Phase 4 → WP4.1a masking solver") ─────────────────────────────────

export type SolverWeight = 'hero' | 'support' | 'ambient';
export const SOLVER_WEIGHTS: readonly SolverWeight[] = /* @__PURE__ */ Object.freeze([
	'hero',
	'support',
	'ambient',
]);
/** Target lift of the dominant band over the bed, by weight (dB; spec 12 §2.4). */
export const TARGET_LIFT_DB: Readonly<Record<SolverWeight, number>> = /* @__PURE__ */ Object.freeze({
	hero: 5,
	support: 3.5,
	ambient: 2,
});
/** Constraint 1: gain range (dB). */
export const SOLVER_GAIN_MIN_DB = -30;
export const SOLVER_GAIN_MAX_DB = 12;
/** Constraint 2: most a sound's peak loudness may exceed the local bed peak, by weight (LU). */
export const BED_CAP_LU: Readonly<Record<SolverWeight, number>> = /* @__PURE__ */ Object.freeze({
	hero: 10,
	support: 6,
	ambient: 6,
});
/** Constraint 2: the bed reference is never under the programme loudness plus this (LU). */
export const QUIET_BED_OFFSET_LU = -12;
/** Programme (delivery integrated) loudness when the caller gives none: web, −14 LUFS. */
export const DEFAULT_PROGRAM_LUFS = -14;
/** Constraint 3: a support this close (seconds, gap between the windows) to a hero is shadowed… */
export const HERO_SHADOW_SEC = 0.15;
/** …by this amplitude factor (−4.437 dB). */
export const HERO_SHADOW_FACTOR = 0.6;
export const HERO_SHADOW_DB = /* @__PURE__ */ Math.log10(HERO_SHADOW_FACTOR) * 20;
/** Constraint 4: repeats stay within the group median ± this (dB). */
export const CONSISTENCY_DB = 2;
/** Constraint 5: most lift over the bed in a speech band during dialogue (dB). */
export const DIALOGUE_LIFT_DB = 1;
/** Constraint 5: the speech bands (octave centres, Hz): 1, 2 and 4 kHz, i.e. ≈ 0.7 … 5.7 kHz. */
export const DIALOGUE_BANDS_HZ: readonly number[] = /* @__PURE__ */ Object.freeze([1000, 2000, 4000]);
/** Constraint 6: default true-peak ceiling of one event after its gain (dBTP, pre-master). */
export const DEFAULT_TRUE_PEAK_CEILING_DB = -1;
/** A second band is dominant when it carries at least this share of the sound's band energy. */
export const DOMINANT_SHARE = 0.1;
/** Output gains and reported levels are rounded to this step (dB). */
export const SOLVER_STEP_DB = 0.01;
/** Masking passes after the first solve (overlapping sound effects; the solve stops earlier once it converges). */
export const MAX_MASKING_ITERATIONS = 32;
/** The masking fixed point is reached when no gain moved more than this between two passes (dB). */
export const MASKING_TOLERANCE_DB = 1e-4;
/** Passes of the summed-true-peak cut (each pass satisfies every clique it sees; the next one only checks). */
const OVERLAP_PASSES = 4;

/** The ordered constraints. */
export const SOLVER_CONSTRAINTS = /* @__PURE__ */ Object.freeze([
	'clamp',
	'bed-cap',
	'hero-shadow',
	'consistency',
	'dialogue',
	'headroom',
] as const);
export type SolverConstraint = (typeof SOLVER_CONSTRAINTS)[number];
/**
 * Why an event's gain is not simply its target: a constraint that moved it, `conflict:<kept>/<lost>` when two
 * constraints could not both hold (the earlier one is kept), `overlap-headroom` when the summed true peak of the
 * sounds overlapping it lowered it (step 6, with `headroom`), `user-offset` when the user's offset took the lift under
 * the target, `silent-sound` when the sound has no band energy (it keeps its base gain).
 */
export type SolverLimit =
	| SolverConstraint
	| 'overlap-headroom'
	| 'user-offset'
	| 'silent-sound'
	| `conflict:${SolverConstraint}/${SolverConstraint}`;

export interface SolverEvent {
	clipId: string;
	/** Library sound id: events with the same one are repeats (constraint 4). */
	soundId: string;
	/** Sound type (`hit`, `whoosh`, …): events of one type and weight are repeats too (constraint 4). */
	type: string;
	weight: SolverWeight;
	/** Timeline window of the sound's activity (seconds). */
	startSec: number;
	endSec: number;
	/** Octave bands 125 Hz … 8 kHz of the sound at 0 dB clip gain over its window (`bandLevels`, dB). */
	soundBandsDb: number[];
	/** The sound's peak loudness at 0 dB clip gain: its max momentary loudness (LUFS); null when unmeasured. */
	soundPeakLu: number | null;
	/** The sound's true peak at 0 dB clip gain (dBTP); null when unmeasured (the solver then never boosts). */
	truePeakDb: number | null;
	/** Octave bands of the bed over the same window (dB); −Infinity / missing = silence. */
	bedBandsDb: number[];
	/** Local peak loudness of the bed (`bedLocalPeakLu`, LUFS); null / −Infinity = silence. */
	bedLocalPeakLu: number | null;
	/** The event overlaps speech (constraint 5). */
	speechOverlap: boolean;
	/** The gain the sound has now (its default insert level): the solver only raises it to reach the lift. */
	baseGainDb: number;
	/** The user's offset added to the solved gain (e.g. a fill's ±1 dB variation). */
	userOffsetDb?: number;
	/**
	 * The cue (or clip group) the sound belongs to: the layers of one cue are one designed sound and do not mask each
	 * other. Absent / empty: its own.
	 */
	cueKey?: string;
}

export interface SolverOptions {
	/** Constraint 6 ceiling (dBTP), default {@link DEFAULT_TRUE_PEAK_CEILING_DB}. */
	truePeakCeilingDb?: number;
	/** Programme loudness (the delivery's integrated target, LUFS), default {@link DEFAULT_PROGRAM_LUFS}. */
	programLufs?: number;
	/**
	 * Overlapping sound effects of a lower weight count in an event's bed (default true). `false`: every event against
	 * the bed alone (the WP4.1a model). The summed-true-peak check applies either way.
	 */
	sfxMasking?: boolean;
}

export interface SolverEventResult {
	clipId: string;
	/** The solved clip gain (dB, 0.01 dB steps). */
	gainDb: number;
	targetLiftDb: number;
	/** Lift of the dominant bands over the bed at the solved gain (dB); null for a silent sound. */
	achievedLiftDb: number | null;
	/** Centres (Hz) of the dominant bands, strongest first; empty for a silent sound. */
	dominantBands: number[];
	limitedBy: SolverLimit[];
	/** Human summary, e.g. "−3.2 dB, limited by dialogue". */
	reason: string;
	/** Sound peak over the bed reference at the solved gain (LU); null when the peak is unmeasured. */
	peakOverBedLu: number | null;
	/** True peak at the solved gain (dBTP); null when unmeasured. */
	truePeakDb: number | null;
	/** Largest lift in a speech band (1–4 kHz) at the solved gain (dB); null unless the event overlaps speech. */
	speechBandLiftDb: number | null;
	/**
	 * How much the lower-weight sound effects under it raise its bed in the dominant bands at the solved gains (dB;
	 * `achievedLiftDb` is over that masked bed); 0 when none, null for a silent sound.
	 */
	sfxMaskingDb: number | null;
	/** Clip ids of those sound effects (at most 32, earliest first). */
	maskedBy: string[];
	/**
	 * Summed true peak (dBTP, Σ of amplitudes: an upper bound) of it and the measured sounds playing with it, at its
	 * worst moment, at the solved gains; its own true peak when alone; null when its true peak is unmeasured.
	 */
	overlapTruePeakDb: number | null;
}

export type SolverWarningCode =
	| 'W_INVALID_INPUT'
	| 'W_SANITISED'
	| 'W_DUPLICATE_CLIP'
	| 'W_SILENT_SOUND'
	| 'W_UNMEASURED'
	| 'W_CONFLICT'
	| 'W_DIALOGUE_BAND'
	| 'W_UNCONVERGED'
	| 'W_UNRESOLVED';

export interface SolverWarning {
	code: SolverWarningCode;
	clipId?: string;
	message: string;
}

export interface SolverResult {
	/** clipId → solved gain (dB). With duplicate clip ids the last event wins (and a warning says so). */
	gains: Record<string, number>;
	/** One entry per input event, in input order. */
	events: SolverEventResult[];
	warnings: SolverWarning[];
	/** Solve passes run (1 without overlapping maskers) and whether the masking reached its fixed point. */
	stats: { iterations: number; converged: boolean };
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────

const BANDS = 7; // OCTAVE_BAND_CENTRES_HZ.length
const DIALOGUE_BAND_INDICES = /* @__PURE__ */ DIALOGUE_BANDS_HZ.map((hz) =>
	OCTAVE_BAND_CENTRES_HZ.indexOf(hz),
);
/** Highest level accepted in a band or loudness field (dB); more is treated as invalid. */
const LEVEL_CEILING_DB = 200;
const BIT = /* @__PURE__ */ Object.fromEntries(SOLVER_CONSTRAINTS.map((c, i) => [c, 1 << i])) as Record<
	SolverConstraint,
	number
>;
const USER_OFFSET_BIT = 1 << 6;
const SILENT_BIT = 1 << 7;
const OVERLAP_BIT = 1 << 8;
/** Tolerance of the bound comparisons (dB). */
const EPS = 1e-9;

/** 10^(dB/10): energy of a level. */
const energy = (db: number): number => Math.exp(db * 0.230_258_509_299_404_6);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Round to the solver step, never −0. */
const q = (x: number): number => {
	const r = Math.round(x / SOLVER_STEP_DB) / (1 / SOLVER_STEP_DB);
	return r === 0 ? 0 : r;
};
const fmtDb = (x: number): string => {
	const v = Math.round(x * 10) / 10;
	if (v === 0) return '0';
	return `${v < 0 ? '−' : '+'}${Math.abs(v)}`;
};

type Clean = {
	clipId: string;
	soundId: string;
	type: string;
	weight: SolverWeight;
	start: number;
	end: number;
	sound: number[];
	bed: number[];
	soundPeak: number | null;
	truePeak: number | null;
	bedPeak: number | null;
	speech: boolean;
	base: number;
	offset: number;
	/** Dominant band indices, their combined level in the sound and in the bed (dB). */
	dom: number[];
	soundDom: number;
	bedDom: number;
	/** min over the speech bands of (bed − sound), dB. */
	speechRoom: number;
	cueKey: string;
};

type Raw = Record<string, unknown>;

function readStr(e: Raw, k: string, fallback: string, notes: string[]): string {
	const v = e[k];
	if (typeof v === 'string') return v;
	if (v !== undefined && v !== null) notes.push(`${k} is not a string`);
	return fallback;
}

function readBands(e: Raw, k: string, notes: string[]): number[] {
	const v = e[k];
	const arr = Array.isArray(v) ? (v as unknown[]) : null;
	if (!arr) notes.push(`${k} is not an array`);
	else if (arr.length !== BANDS) notes.push(`${k} has ${arr.length} bands, not ${BANDS}`);
	const out = new Array<number>(BANDS);
	for (let i = 0; i < BANDS; i++) {
		const x = arr ? arr[i] : undefined;
		if (typeof x === 'number' && Number.isFinite(x) && x <= LEVEL_CEILING_DB)
			out[i] = Math.max(BAND_FLOOR_DB, x);
		else {
			// −Infinity (silence) and a missing band are the floor quietly; NaN / +Infinity are reported
			if (x !== Number.NEGATIVE_INFINITY && x !== undefined) notes.push(`${k}[${i}] is not a finite level`);
			out[i] = BAND_FLOOR_DB;
		}
	}
	return out;
}

/** A level field: the number, or null for null / undefined / −Infinity (unmeasured, silence); others reported. */
function readLevel(e: Raw, k: string, notes: string[]): number | null {
	const v = e[k];
	if (isNum(v) && v <= LEVEL_CEILING_DB) return v;
	if (v === null || v === undefined || v === Number.NEGATIVE_INFINITY) return null;
	notes.push(`${k} is not a finite level`);
	return null;
}

function readNum(e: Raw, k: string, fallback: number, optional: boolean, notes: string[]): number {
	const v = e[k];
	if (isNum(v)) return v;
	if (!(optional && v === undefined)) notes.push(`${k} is not a finite number`);
	return fallback;
}

/** Sanitise one event; `notes` collects what was replaced. */
function clean(raw: unknown, index: number, notes: string[]): Clean {
	const e = (raw && typeof raw === 'object' ? raw : {}) as Raw;
	if (raw === null || typeof raw !== 'object') notes.push('not an object');
	let weight = e.weight as SolverWeight;
	if (!SOLVER_WEIGHTS.includes(weight)) {
		notes.push('weight is not hero, support or ambient (support used)');
		weight = 'support';
	}
	let start = readNum(e, 'startSec', 0, false, notes);
	let end = readNum(e, 'endSec', start, false, notes);
	if (end < start) {
		notes.push('endSec is before startSec (swapped)');
		[start, end] = [end, start];
	}
	if (typeof e.speechOverlap !== 'boolean' && e.speechOverlap !== undefined)
		notes.push('speechOverlap is not a boolean');
	const base = Math.max(-1000, Math.min(1000, readNum(e, 'baseGainDb', 0, false, notes)));
	const offset = Math.max(-1000, Math.min(1000, readNum(e, 'userOffsetDb', 0, true, notes)));
	const clipId = readStr(e, 'clipId', `#${index}`, notes);
	const cueKey = readStr(e, 'cueKey', '', notes);
	const soundId = readStr(e, 'soundId', '', notes);
	const type = readStr(e, 'type', '', notes);
	const sound = readBands(e, 'soundBandsDb', notes);
	const bed = readBands(e, 'bedBandsDb', notes);
	const soundPeak = readLevel(e, 'soundPeakLu', notes);
	const truePeak = readLevel(e, 'truePeakDb', notes);
	const bedPeak = readLevel(e, 'bedLocalPeakLu', notes);
	const dom = dominant(sound);
	// constraint 5 bound: 1 + min over the speech bands of (bed − sound)
	let speechRoom = Number.POSITIVE_INFINITY;
	for (const b of DIALOGUE_BAND_INDICES) speechRoom = Math.min(speechRoom, bed[b]! - sound[b]!);
	return {
		clipId,
		soundId,
		type,
		weight,
		start,
		end,
		sound,
		bed,
		soundPeak,
		truePeak,
		bedPeak,
		speech: e.speechOverlap === true,
		base,
		offset,
		dom,
		soundDom: dom.length ? levelIn(sound, dom) : BAND_FLOOR_DB,
		bedDom: dom.length ? levelIn(bed, dom) : BAND_FLOOR_DB,
		speechRoom,
		cueKey,
	};
}

/** Dominant band indices: the strongest, plus the second when its energy share is ≥ {@link DOMINANT_SHARE}. */
function dominant(bands: number[]): number[] {
	let total = 0;
	let i1 = -1;
	let i2 = -1;
	for (let i = 0; i < bands.length; i++) {
		const b = bands[i]!;
		if (!(b > BAND_FLOOR_DB)) continue;
		total += energy(b);
		if (i1 < 0 || b > bands[i1]!) {
			i2 = i1;
			i1 = i;
		} else if (i2 < 0 || b > bands[i2]!) i2 = i;
	}
	if (i1 < 0 || !(total > 0)) return [];
	if (i2 >= 0 && energy(bands[i2]!) / total >= DOMINANT_SHARE) return [i1, i2];
	return [i1];
}

/** Combined level (dB) of the bands `idx` of `bands`. */
function levelIn(bands: number[], idx: number[]): number {
	let e = 0;
	for (const i of idx) e += energy(bands[i]!);
	return e > 0 ? Math.max(BAND_FLOOR_DB, 10 * Math.log10(e)) : BAND_FLOOR_DB;
}

const median = (xs: number[]): number => {
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

type State = {
	ev: Clean;
	g: number;
	lo: number;
	loBy: SolverConstraint;
	hi: number;
	hiBy: SolverConstraint;
	/** Bit i: constraint i moved the gain; {@link USER_OFFSET_BIT}, {@link SILENT_BIT}. */
	limited: number;
	conflicts: [SolverConstraint, SolverConstraint][];
	/** The bound step 3 set (+Infinity when not shadowed; the re-verification checks it). */
	shadowHi: number;
	/** The interval left by steps 1–3 (consistency may not leave it: those constraints come first). */
	hi3: number;
	hi3By: SolverConstraint;
	/** The bounds of steps 5 and 6 (consistency may break them, reporting the conflict). */
	dialogueHi: number;
	headroomHi: number;
	/** Index of the repeat group (constraint 4), −1 for none; whether the member takes part in its median. */
	group: number;
	inGroup: boolean;
};

function conflict(st: State, kept: SolverConstraint, lost: SolverConstraint): void {
	for (const [a, b] of st.conflicts) if (a === kept && b === lost) return;
	st.conflicts.push([kept, lost]);
}

/** Step `by` allows gains ≤ `bound`. */
function upper(st: State, by: SolverConstraint, bound: number): void {
	if (bound >= st.lo - EPS) {
		if (bound < st.hi) {
			st.hi = Math.max(st.lo, bound);
			st.hiBy = by;
		}
		if (st.g > st.hi + EPS) {
			st.g = st.hi;
			st.limited |= BIT[by];
		}
		return;
	}
	// the bound is under what an earlier step requires: the earlier one is kept
	conflict(st, st.loBy, by);
	if (st.g > st.lo + EPS) st.limited |= BIT[by];
	st.g = st.lo;
	st.hi = st.lo;
	// the gain is held at the floor because THIS constraint wants it lower: it is what a later step (consistency)
	// loses to, not the floor (which only stopped it going further down)
	st.hiBy = by;
}

/** Indices of the support events within {@link HERO_SHADOW_SEC} of a hero (gap between the windows). */
function shadowed(evs: Clean[]): Set<number> {
	const heroes = evs
		.map((s, i) => ({ s: s.start, e: s.end, i }))
		.filter((h) => evs[h.i]!.weight === 'hero')
		.sort((a, b) => a.s - b.s || a.i - b.i);
	const out = new Set<number>();
	if (heroes.length === 0) return out;
	// prefix maximum of hero ends, by start
	const maxEnd: number[] = [];
	for (let k = 0; k < heroes.length; k++) maxEnd.push(Math.max(k ? maxEnd[k - 1]! : -Infinity, heroes[k]!.e));
	evs.forEach((ev, i) => {
		if (ev.weight !== 'support') return;
		// heroes starting no later than end + 0.15 whose end is no earlier than start − 0.15
		const limit = ev.end + HERO_SHADOW_SEC + EPS;
		let lo = 0;
		let hi = heroes.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (heroes[mid]!.s <= limit) lo = mid + 1;
			else hi = mid;
		}
		if (lo > 0 && maxEnd[lo - 1]! >= ev.start - HERO_SHADOW_SEC - EPS) out.add(i);
	});
	return out;
}

/**
 * Repeat groups (constraint 4), disjoint, of ≥ 2 event indices in first-occurrence order: events whose sound id
 * occurs more than once are grouped by sound id; the others by type and weight (an empty id or type groups nothing).
 */
function repeatGroups(evs: Clean[]): number[][] {
	const idCount = new Map<string, number>();
	for (const s of evs) if (s.soundId) idCount.set(s.soundId, (idCount.get(s.soundId) ?? 0) + 1);
	const map = new Map<string, number[]>();
	for (let i = 0; i < evs.length; i++) {
		const { soundId, type, weight } = evs[i]!;
		const k =
			soundId && (idCount.get(soundId) ?? 0) >= 2
				? `s\u0000${soundId}`
				: type
					? `t\u0000${type}\u0000${weight}`
					: '';
		if (k === '') continue;
		const g = map.get(k);
		if (g) g.push(i);
		else map.set(k, [i]);
	}
	const out: number[][] = [];
	for (const g of map.values()) if (g.length >= 2) out.push(g);
	return out;
}

/**
 * Constraint 4 for one repeat group. The median is taken over the members that can reach the window: a member
 * whose steps 1–3 cap is under median − 2 is left out (and the median recomputed) — at step 4 it is raised to that
 * cap, after the last step it reports `conflict:<cap>/consistency`. The others are clamped into median ± 2; after
 * the last step (`final`) a raise over a step 5 / 6 bound reports `conflict:consistency/<step>`. Clamping every
 * member into a window centred on the median keeps the median, so one settle is enough.
 */
let medianScratch = new Float64Array(64);

/** Median gain of the members of `grp` still in the group (`inGroup`); allocation-free (it runs every pass). */
function groupMedianOf(states: State[], grp: number[]): number {
	if (medianScratch.length < grp.length) medianScratch = new Float64Array(grp.length * 2);
	let n = 0;
	for (const i of grp) if (states[i]!.inGroup) medianScratch[n++] = states[i]!.g;
	const s = medianScratch.subarray(0, n).sort();
	const m = n >> 1;
	return n % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function settleGroup(states: State[], grp: number[], final: boolean): void {
	for (const i of grp) states[i]!.inGroup = true;
	let m = groupMedianOf(states, grp);
	for (;;) {
		let dropped = false;
		for (const i of grp) {
			const st = states[i]!;
			if (st.inGroup && st.hi3 < m - CONSISTENCY_DB - EPS) {
				st.inGroup = false;
				dropped = true;
			}
		}
		if (!dropped) break;
		// never empty: the member with the largest gain g ≥ m has hi3 ≥ g ≥ m
		m = groupMedianOf(states, grp);
	}
	for (const i of grp) {
		const st = states[i]!;
		if (!st.inGroup) {
			if (final) conflict(st, st.hi3By, 'consistency');
			else if (st.g < st.hi3 - EPS) {
				st.g = st.hi3;
				st.limited |= BIT.consistency;
			}
			continue;
		}
		if (st.g > m + CONSISTENCY_DB + EPS) {
			st.g = m + CONSISTENCY_DB;
			st.limited |= BIT.consistency;
		} else if (st.g < m - CONSISTENCY_DB - EPS) {
			const t = m - CONSISTENCY_DB;
			if (final) {
				if (t > st.dialogueHi + EPS) conflict(st, 'consistency', 'dialogue');
				if (t > st.headroomHi + EPS) conflict(st, 'consistency', 'headroom');
			}
			st.g = t;
			st.limited |= BIT.consistency;
		}
		st.lo = Math.min(st.lo, st.g);
		st.hi = Math.max(st.hi, st.g);
	}
}

// ── overlapping sound effects ────────────────────────────────────────────────────────────────────────────────────

const WEIGHT_RANK: Readonly<Record<SolverWeight, number>> = { ambient: 0, support: 1, hero: 2 };

/** Indices sorted by start, end, clip id, input index (the canonical order every sum below runs in). */
function canonicalOrder(evs: Clean[]): number[] {
	return evs
		.map((_, i) => i)
		.sort((a, b) => {
			const x = evs[a]!;
			const y = evs[b]!;
			return (
				x.start - y.start ||
				x.end - y.end ||
				(x.clipId < y.clipId ? -1 : x.clipId > y.clipId ? 1 : 0) ||
				a - b
			);
		});
}

/** `m` is part of `t`'s bed: a lower weight, both audible, not layers of one cue. */
const masks = (m: Clean, t: Clean): boolean =>
	WEIGHT_RANK[m.weight] < WEIGHT_RANK[t.weight] &&
	m.dom.length > 0 &&
	t.dom.length > 0 &&
	!(t.cueKey !== '' && t.cueKey === m.cueKey);

/** Per event: its maskers (event indices, canonical order) and the share of its window each covers. */
type Maskers = { j: number[]; share: number[] }[];

/** The maskers of every event, or null when nothing masks anything. One sweep over the canonical order. */
function maskerLists(evs: Clean[], order: number[]): Maskers | null {
	const out: Maskers = evs.map(() => ({ j: [], share: [] }));
	let any = false;
	for (let p = 0; p < order.length; p++) {
		const a = order[p]!;
		const ea = evs[a]!;
		const la = ea.end - ea.start;
		if (!(la > 0)) continue;
		for (let k = p + 1; k < order.length; k++) {
			const b = order[k]!;
			const eb = evs[b]!;
			if (!(eb.start < ea.end)) break;
			const lb = eb.end - eb.start;
			if (!(lb > 0)) continue;
			const ov = Math.min(ea.end, eb.end) - eb.start; // eb.start ≥ ea.start
			if (!(ov > 0)) continue;
			if (masks(eb, ea)) {
				out[a]!.j.push(b);
				out[a]!.share.push(Math.min(1, ov / la));
				any = true;
			}
			if (masks(ea, eb)) {
				out[b]!.j.push(a);
				out[b]!.share.push(Math.min(1, ov / lb));
				any = true;
			}
		}
	}
	// each list is in canonical order already: maskers before an event were added while the sweep stood on them
	// (in order), the ones after it while it stood on the event (in order)
	return any ? out : null;
}

/** Band energies of every sound and bed (row i·7 + band), computed once. */
type BandEnergy = { sound: Float64Array; bed: Float64Array };

function bandEnergy(evs: Clean[]): BandEnergy {
	const sound = new Float64Array(evs.length * BANDS);
	const bed = new Float64Array(evs.length * BANDS);
	for (let i = 0; i < evs.length; i++)
		for (let b = 0; b < BANDS; b++) {
			sound[i * BANDS + b] = energy(evs[i]!.sound[b]!);
			bed[i * BANDS + b] = energy(evs[i]!.bed[b]!);
		}
	return { sound, bed };
}

/** Each event's bed in its dominant bands with its maskers at `gains` (dB) into `out`; the measured bed when none. */
function maskedBedDom(
	evs: Clean[],
	lists: Maskers,
	be: BandEnergy,
	gains: ArrayLike<number>,
	out: Float64Array,
	scratch: Float64Array,
): Float64Array {
	for (let j = 0; j < evs.length; j++) scratch[j] = energy(gains[j]!);
	for (let i = 0; i < evs.length; i++) {
		const ev = evs[i]!;
		const l = lists[i]!;
		const n = l.j.length;
		if (n === 0 || ev.dom.length === 0) {
			out[i] = ev.bedDom;
			continue;
		}
		let e = 0;
		for (const b of ev.dom) {
			let x = be.bed[i * BANDS + b]!;
			for (let k = 0; k < n; k++) {
				const j = l.j[k]!;
				x += be.sound[j * BANDS + b]! * scratch[j]! * l.share[k]!;
			}
			e += x;
		}
		out[i] = e > 0 ? Math.max(BAND_FLOOR_DB, 10 * Math.log10(e)) : BAND_FLOOR_DB;
	}
	return out;
}

/**
 * The cliques of measured events that play at once: at each distinct start, the events active there (start ≤ t <
 * end, or an instant event at t), in canonical order. Calls `visit(members)` per distinct start.
 */
function eachClique(evs: Clean[], order: number[], visit: (members: number[]) => void): void {
	const active: number[] = [];
	let p = 0;
	while (p < order.length) {
		const t = evs[order[p]!]!.start;
		let w = 0;
		for (let k = 0; k < active.length; k++) {
			const e = evs[active[k]!]!;
			if (e.end > t || (e.end === e.start && e.start === t)) active[w++] = active[k]!;
		}
		active.length = w;
		while (p < order.length && evs[order[p]!]!.start === t) active.push(order[p++]!);
		// insertion keeps the canonical order (starts ascend; ties pushed in order)
		visit(active);
	}
}

/** 10^(dB/20). */
const amp = (db: number): number => Math.exp(db * 0.115_129_254_649_702_3);

/**
 * Step 6, summed: every clique of overlapping measured events whose summed true peak (Σ 10^(tp/20)) is over the
 * ceiling is lowered by one dB amount for all its members; a member an earlier step holds at its floor keeps it (the
 * others take the rest); when the held members alone are over, the others go to their floors and the held ones
 * report `conflict:<floor>/headroom`. An event in several cliques takes the largest cut. Deterministic.
 * `holdRepeats` (the pass after the last consistency settle): members of a repeat group are held where they are — the
 * settle may have raised one back over the summed ceiling, and lowering it alone could break the ±2 dB window again —
 * so the other sounds of the clique absorb the cut, and only what they cannot absorb is a reported
 * `conflict:consistency/headroom` (consistency comes first in the spec order).
 */
function overlapHeadroom(states: State[], order: number[], ceiling: number, holdRepeats: boolean): void {
	const cAmp = amp(ceiling);
	const evs = states.map((s) => s.ev);
	const held = (st: State) => holdRepeats && st.group >= 0 && st.inGroup;
	const floorOf = (st: State): number => (held(st) ? st.g : st.lo);
	const floorBy = (st: State): SolverConstraint => (held(st) ? 'consistency' : st.loBy);
	const measured = order.filter((i) => evs[i]!.truePeak !== null);
	for (let pass = 0; pass < OVERLAP_PASSES; pass++) {
		const cut = new Float64Array(states.length);
		const atFloor = new Set<number>();
		let over = false;
		eachClique(evs, measured, (members) => {
			if (members.length < 2) return; // alone: per-event headroom already holds it
			const a = members.map((i) => amp(evs[i]!.truePeak! + states[i]!.g));
			let sum = 0;
			for (const x of a) sum += x;
			if (!(sum > cAmp * (1 + 1e-12))) return;
			over = true;
			// water-filling: members at (or pushed to) their floor are fixed at it
			const fixed = members.map((i) => states[i]!.g <= floorOf(states[i]!) + EPS);
			for (let guard = 0; guard <= members.length; guard++) {
				let sf = 0;
				let sr = 0;
				members.forEach((i, k) => {
					if (fixed[k]) sf += amp(evs[i]!.truePeak! + Math.min(states[i]!.g, floorOf(states[i]!)));
					else sr += a[k]!;
				});
				if (sr === 0 || sf >= cAmp) {
					members.forEach((i, k) => {
						const st = states[i]!;
						cut[i] = Math.max(cut[i]!, st.g - floorOf(st));
						if (fixed[k] && st.g <= floorOf(st) + EPS) atFloor.add(i);
					});
					return;
				}
				const d = 20 * Math.log10(sr / (cAmp - sf));
				let moved = false;
				members.forEach((i, k) => {
					if (!fixed[k] && states[i]!.g - d < floorOf(states[i]!) - EPS) {
						fixed[k] = true;
						moved = true;
					}
				});
				if (moved) continue;
				members.forEach((i, k) => {
					const st = states[i]!;
					cut[i] = Math.max(cut[i]!, fixed[k] ? Math.max(0, st.g - floorOf(st)) : d);
				});
				return;
			}
		});
		if (!over) return;
		for (let i = 0; i < states.length; i++) {
			const st = states[i]!;
			if (atFloor.has(i)) conflict(st, floorBy(st), 'headroom');
			if (!(cut[i]! > EPS)) continue;
			const bound = Math.max(floorOf(st), st.g - cut[i]!);
			st.headroomHi = Math.min(st.headroomHi, bound);
			const before = st.g;
			upper(st, 'headroom', bound);
			if (st.g < before - EPS) st.limited |= OVERLAP_BIT;
		}
	}
}

// ── solver ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** What every pass shares: the options and what only depends on the windows, weights and ids. */
type Ctx = {
	ceiling: number;
	quietBed: number;
	shadow: Set<number>;
	groups: number[][];
	/** Repeat group of each event, −1 for none. */
	groupOf: Int32Array;
};

const newState = (ev: Clean): State => ({
	ev,
	g: 0,
	lo: Number.NEGATIVE_INFINITY,
	loBy: 'clamp',
	hi: Number.POSITIVE_INFINITY,
	hiBy: 'clamp',
	limited: 0,
	conflicts: [],
	shadowHi: Number.POSITIVE_INFINITY,
	hi3: Number.POSITIVE_INFINITY,
	hi3By: 'clamp',
	dialogueHi: Number.POSITIVE_INFINITY,
	headroomHi: Number.POSITIVE_INFINITY,
	group: -1,
	inGroup: false,
});

/**
 * Steps 1–6 (per-event headroom) and the settle of step 4 after them, with each event's bed in its dominant bands,
 * for the events `todo` (every event when null) and the repeat groups `groupsTodo` (every group when null; a group's
 * members must all be in `todo`). The states of `todo` are reset first, so a pass never sees the previous one; the
 * others are left as the previous pass made them (their inputs did not change: the same result).
 */
function runSteps(
	states: State[],
	ctx: Ctx,
	bedDom: ArrayLike<number> | null,
	todo: readonly number[] | null = null,
	groupsTodo: readonly number[] | null = null,
): void {
	const n = todo ? todo.length : states.length;
	const at = (k: number): State => states[todo ? todo[k]! : k]!;
	for (let k = 0; k < n; k++) {
		const i = todo ? todo[k]! : k;
		const st = states[i]!;
		const ev = st.ev;
		st.lo = Number.NEGATIVE_INFINITY;
		st.loBy = 'clamp';
		st.hi = Number.POSITIVE_INFINITY;
		st.hiBy = 'clamp';
		st.limited = 0;
		if (st.conflicts.length) st.conflicts = [];
		st.shadowHi = Number.POSITIVE_INFINITY;
		st.hi3 = Number.POSITIVE_INFINITY;
		st.hi3By = 'clamp';
		st.dialogueHi = Number.POSITIVE_INFINITY;
		st.headroomHi = Number.POSITIVE_INFINITY;
		st.group = ctx.groupOf[i]!;
		st.inGroup = false;
		// ── target ─────────────────────────────────────────────────────────────────────────────────────────────────
		if (ev.dom.length === 0) {
			st.g = ev.base + ev.offset;
			st.limited |= SILENT_BIT;
		} else {
			const need = (bedDom ? bedDom[i]! : ev.bedDom) + TARGET_LIFT_DB[ev.weight] - ev.soundDom;
			st.g = Math.max(ev.base, need) + ev.offset;
		}

		// ── 1 clamp ────────────────────────────────────────────────────────────────────────────────────────────────
		st.lo = SOLVER_GAIN_MIN_DB;
		st.hi = SOLVER_GAIN_MAX_DB;
		const g = Math.min(SOLVER_GAIN_MAX_DB, Math.max(SOLVER_GAIN_MIN_DB, st.g));
		if (Math.abs(g - st.g) > EPS) st.limited |= BIT.clamp;
		st.g = g;

		// ── 2 bed cap ──────────────────────────────────────────────────────────────────────────────────────────────
		if (ev.soundPeak !== null)
			upper(st, 'bed-cap', bedRef(ev, ctx.quietBed) + BED_CAP_LU[ev.weight] - ev.soundPeak);

		// ── 3 hero shadow ──────────────────────────────────────────────────────────────────────────────────────────
		if (ctx.shadow.has(i)) {
			const bound = st.g + HERO_SHADOW_DB;
			upper(st, 'hero-shadow', bound);
			st.shadowHi = bound;
		}
		st.hi3 = st.hi;
		st.hi3By = st.hiBy;
	}

	// ── 4 consistency: repeats (same sound, else same type and weight) within the median ± 2 dB ─────────────────
	// Steps 1–3 come first: a member whose steps 1–3 cap is under its group's window cannot join it; it goes as high
	// as that cap allows and is left out of the median (the conflict is reported after the last step). The window is
	// not a fixed bound for steps 5 and 6: the relation is settled again around the group's median after them.
	const ng = groupsTodo ? groupsTodo.length : ctx.groups.length;
	for (let k = 0; k < ng; k++) settleGroup(states, ctx.groups[groupsTodo ? groupsTodo[k]! : k]!, false);

	for (let k = 0; k < n; k++) {
		const st = at(k);
		const { ev } = st;
		// ── 5 dialogue guard ───────────────────────────────────────────────────────────────────────────────────────
		if (ev.speech) {
			st.dialogueHi = DIALOGUE_LIFT_DB + ev.speechRoom;
			upper(st, 'dialogue', st.dialogueHi);
		}
		// ── 6 headroom (per event) ─────────────────────────────────────────────────────────────────────────────────
		st.headroomHi = ev.truePeak === null ? 0 : ctx.ceiling - ev.truePeak;
		upper(st, 'headroom', st.headroomHi);
	}

	// ── re-verify 4 against the steps after it ──────────────────────────────────────────────────────────────────
	// Steps 5 and 6 only lower gains. Around each group's (new) median, a member left above median + 2 comes down
	// (nothing breaks), one left under median − 2 goes back up to it — over a step 5 / 6 bound only as a reported
	// conflict, since consistency comes first.
	for (let k = 0; k < ng; k++) settleGroup(states, ctx.groups[groupsTodo ? groupsTodo[k]! : k]!, true);
}

const bedRef = (ev: Clean, quietBed: number): number => Math.max(ev.bedPeak ?? Number.NEGATIVE_INFINITY, quietBed);

const speechLift = (ev: Clean, g: number): number => {
	let m = Number.NEGATIVE_INFINITY;
	for (const b of DIALOGUE_BAND_INDICES) m = Math.max(m, ev.sound[b]! + g - ev.bed[b]!);
	return m;
};

/**
 * Solve the clip gains of placed sound effects against their bed (spec 12 §2.4). Deterministic; never throws:
 * invalid fields are sanitised (W_SANITISED / W_INVALID_INPUT), an empty input gives an empty result.
 */
export function solveSfxGains(events: SolverEvent[], opts: SolverOptions = {}): SolverResult {
	const warnings: SolverWarning[] = [];
	const o = opts && typeof opts === 'object' ? opts : {};
	const ceiling =
		isNum(o.truePeakCeilingDb) && Math.abs(o.truePeakCeilingDb) <= LEVEL_CEILING_DB
			? o.truePeakCeilingDb
			: DEFAULT_TRUE_PEAK_CEILING_DB;
	const program =
		isNum(o.programLufs) && Math.abs(o.programLufs) <= LEVEL_CEILING_DB
			? o.programLufs
			: DEFAULT_PROGRAM_LUFS;
	if (o.truePeakCeilingDb !== undefined && ceiling !== o.truePeakCeilingDb)
		warnings.push({
			code: 'W_INVALID_INPUT',
			message: `truePeakCeilingDb is not a finite level; ${ceiling} dBTP used`,
		});
	if (o.programLufs !== undefined && program !== o.programLufs)
		warnings.push({
			code: 'W_INVALID_INPUT',
			message: `programLufs is not a finite level; ${program} LUFS used`,
		});
	if (o.sfxMasking !== undefined && typeof o.sfxMasking !== 'boolean')
		warnings.push({ code: 'W_INVALID_INPUT', message: 'sfxMasking is not a boolean; true used' });
	if (!Array.isArray(events)) {
		if (events !== undefined && events !== null)
			warnings.push({ code: 'W_INVALID_INPUT', message: 'events is not an array; nothing solved' });
		return { gains: {}, events: [], warnings, stats: { iterations: 0, converged: true } };
	}
	const quietBed = program + QUIET_BED_OFFSET_LU;

	// ── sanitise (once) ──────────────────────────────────────────────────────────────────────────────────────────
	const evs: Clean[] = events.map((raw, i) => {
		const notes: string[] = [];
		const ev = clean(raw, i, notes);
		if (notes.length)
			warnings.push({ code: 'W_SANITISED', clipId: ev.clipId, message: `${ev.clipId}: ${notes.join('; ')}` });
		if (ev.dom.length === 0)
			warnings.push({
				code: 'W_SILENT_SOUND',
				clipId: ev.clipId,
				message: `${ev.clipId}: the sound has no energy in 125 Hz … 8 kHz; it keeps its base gain`,
			});
		if (ev.soundPeak === null || ev.truePeak === null)
			warnings.push({
				code: 'W_UNMEASURED',
				clipId: ev.clipId,
				message: `${ev.clipId}: ${ev.soundPeak === null ? 'no peak loudness (bed cap not applied)' : ''}${
					ev.soundPeak === null && ev.truePeak === null ? '; ' : ''
				}${ev.truePeak === null ? 'no true peak (never boosted)' : ''}`,
			});
		return ev;
	});
	// every sum over several events runs in this order, so the input order never changes a result
	const order = canonicalOrder(evs);
	const seen = new Set<string>();
	for (const ev of evs) {
		if (seen.has(ev.clipId))
			warnings.push({
				code: 'W_DUPLICATE_CLIP',
				clipId: ev.clipId,
				message: `${ev.clipId} appears more than once; gains keeps the last`,
			});
		seen.add(ev.clipId);
	}
	dialogueBandWarnings(evs, warnings);

	// ── steps 1–6, repeated to the masking fixed point ───────────────────────────────────────────────────────────
	const groups = repeatGroups(evs);
	const groupOf = new Int32Array(evs.length).fill(-1);
	groups.forEach((grp, gi) => {
		for (const i of grp) groupOf[i] = gi;
	});
	const ctx: Ctx = { ceiling, quietBed, shadow: shadowed(evs), groups, groupOf };
	const lists = o.sfxMasking === false ? null : maskerLists(evs, order);
	const states = evs.map(newState);
	runSteps(states, ctx, null);
	let iterations = 1;
	let converged = true;
	const be = lists ? bandEnergy(evs) : null;
	if (lists && be) {
		converged = false;
		const n = evs.length;
		const prev = new Float64Array(n);
		const bedDom = new Float64Array(n);
		const lastBed = Float64Array.from(evs, (ev) => ev.bedDom);
		const scratch = new Float64Array(n);
		const groupDirty = new Uint8Array(ctx.groups.length);
		for (let i = 0; i < n; i++) prev[i] = states[i]!.g;
		for (let k = 0; k < MAX_MASKING_ITERATIONS; k++) {
			maskedBedDom(evs, lists, be, prev, bedDom, scratch);
			// only the events whose bed moved (and their repeat groups) are solved again: the others' inputs are the
			// same, so is their result
			const todo: number[] = [];
			const groupsTodo: number[] = [];
			groupDirty.fill(0);
			for (let i = 0; i < n; i++)
				if (bedDom[i] !== lastBed[i]) {
					const gi = ctx.groupOf[i]!;
					if (gi < 0) todo.push(i);
					else if (!groupDirty[gi]) {
						groupDirty[gi] = 1;
						groupsTodo.push(gi);
					}
				}
			for (const gi of groupsTodo) for (const i of ctx.groups[gi]!) todo.push(i);
			lastBed.set(bedDom);
			if (todo.length === 0) {
				converged = true;
				break;
			}
			runSteps(states, ctx, bedDom, todo, groupsTodo);
			iterations++;
			let d = 0;
			for (let i = 0; i < n; i++) {
				const g = states[i]!.g;
				d = Math.max(d, Math.abs(g - prev[i]!));
				prev[i] = g;
			}
			if (d <= MASKING_TOLERANCE_DB) {
				converged = true;
				break;
			}
		}
		if (!converged)
			warnings.push({
				code: 'W_UNCONVERGED',
				message: `the masking between overlapping sound effects did not settle in ${MAX_MASKING_ITERATIONS} passes; the last pass is used (every constraint still holds)`,
			});
	}

	// ── 6 headroom, summed over overlapping sounds; then consistency settled once more ──────────────────────────
	overlapHeadroom(states, order, ceiling, false);
	for (const grp of ctx.groups) settleGroup(states, grp, true);
	if (ctx.groups.length) overlapHeadroom(states, order, ceiling, true);

	// ── quantise, re-verify, report ──────────────────────────────────────────────────────────────────────────────
	const finalGain = (st: State): number => {
		// round to the step, staying inside the interval when the step allows it
		let g = q(st.g);
		if (g > st.hi + EPS && q(g - SOLVER_STEP_DB) >= st.lo - EPS) g = q(g - SOLVER_STEP_DB);
		else if (g < st.lo - EPS && q(g + SOLVER_STEP_DB) <= st.hi + EPS) g = q(g + SOLVER_STEP_DB);
		return g;
	};
	const finals = states.map(finalGain);
	const groupMedian = ctx.groups.map((grp) => {
		const active = grp.filter((i) => states[i]!.inGroup);
		return median(active.map((i) => finals[i]!));
	});
	const masked =
		lists && be
			? maskedBedDom(evs, lists, be, finals, new Float64Array(evs.length), new Float64Array(evs.length))
			: null;
	// the summed true peak at the final gains: each event's worst clique; cliques over the ceiling must be explained
	const overlapTp = new Float64Array(evs.length).fill(Number.NEGATIVE_INFINITY);
	const tol = SOLVER_STEP_DB / 2 + 1e-9;
	const unresolvedOverlap: number[] = [];
	eachClique(
		evs,
		order.filter((i) => evs[i]!.truePeak !== null),
		(members) => {
			let sum = 0;
			for (const i of members) sum += amp(evs[i]!.truePeak! + finals[i]!);
			const db = 20 * Math.log10(sum);
			for (const i of members) overlapTp[i] = Math.max(overlapTp[i]!, db);
			if (members.length > 1 && db > ceiling + tol) {
				const explained = members.some((i) => states[i]!.conflicts.some(([, lost]) => lost === 'headroom'));
				if (!explained) {
					let loud = members[0]!;
					for (const i of members)
						if (evs[i]!.truePeak! + finals[i]! > evs[loud]!.truePeak! + finals[loud]!) loud = i;
					if (!unresolvedOverlap.includes(loud)) unresolvedOverlap.push(loud);
				}
			}
		},
	);
	const gains: Record<string, number> = {};
	const results: SolverEventResult[] = states.map((st, si) => {
		const { ev } = st;
		const g = finals[si]!;
		// an interval narrower than the step may hold no step: rounding may then miss a bound by half a step
		const violated: SolverConstraint[] = [];
		if (g < SOLVER_GAIN_MIN_DB - tol || g > SOLVER_GAIN_MAX_DB + tol) violated.push('clamp');
		if (ev.soundPeak !== null && ev.soundPeak + g - bedRef(ev, quietBed) > BED_CAP_LU[ev.weight] + tol)
			violated.push('bed-cap');
		if (g > st.shadowHi + tol) violated.push('hero-shadow');
		if (st.group >= 0 && Math.abs(g - groupMedian[st.group]!) > CONSISTENCY_DB + 2 * tol)
			violated.push('consistency');
		if (st.group >= 0 && !st.inGroup && !st.conflicts.some(([, lost]) => lost === 'consistency'))
			violated.push('consistency');
		if (ev.speech && speechLift(ev, g) > DIALOGUE_LIFT_DB + tol) violated.push('dialogue');
		if (g > st.headroomHi + tol) violated.push('headroom');
		for (const c of violated) {
			const explained = st.conflicts.some(([, lost]) => lost === c);
			if (!explained)
				warnings.push({
					code: 'W_UNRESOLVED',
					clipId: ev.clipId,
					message: `${ev.clipId}: ${c} does not hold after the last step and no conflict explains it`,
				});
		}
		if (unresolvedOverlap.includes(si))
			warnings.push({
				code: 'W_UNRESOLVED',
				clipId: ev.clipId,
				message: `${ev.clipId}: headroom does not hold after the last step (summed true peak of the sounds overlapping it ${fmtDb(overlapTp[si]!)} dBTP) and no conflict explains it`,
			});
		for (const [kept, lost] of st.conflicts)
			warnings.push({
				code: 'W_CONFLICT',
				clipId: ev.clipId,
				message: `${ev.clipId}: ${lost} could not hold without breaking ${kept}; ${kept} was kept`,
			});

		const { dom } = ev;
		const target = TARGET_LIFT_DB[ev.weight];
		const bedDom = masked ? masked[si]! : ev.bedDom;
		const achieved = dom.length ? ev.soundDom + g - bedDom : null;
		if (
			achieved !== null &&
			ev.offset < 0 &&
			achieved < target - 0.005 &&
			st.limited === 0 &&
			!st.conflicts.length
		)
			st.limited |= USER_OFFSET_BIT;
		const limitedBy = limits(st.limited, st.conflicts);
		const maskedBy: string[] = [];
		if (lists)
			for (const j of lists[si]!.j) {
				const id = evs[j]!.clipId;
				if (maskedBy.length >= 32) break;
				if (!maskedBy.includes(id)) maskedBy.push(id);
			}
		const sfxMaskingDb = dom.length ? q(bedDom - ev.bedDom) : null;
		// an own data property even for the id "__proto__" (an assignment would set the prototype)
		if (ev.clipId === '__proto__')
			Object.defineProperty(gains, ev.clipId, {
				value: g,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		else gains[ev.clipId] = g;
		return {
			clipId: ev.clipId,
			gainDb: g,
			targetLiftDb: target,
			achievedLiftDb: achieved === null ? null : q(achieved),
			dominantBands: dom.map((b) => OCTAVE_BAND_CENTRES_HZ[b]!),
			limitedBy,
			reason: reasonText(g, limitedBy, achieved, target, st.conflicts, sfxMaskingDb ?? 0, maskedBy.length),
			peakOverBedLu: ev.soundPeak === null ? null : q(ev.soundPeak + g - bedRef(ev, quietBed)),
			truePeakDb: ev.truePeak === null ? null : q(ev.truePeak + g),
			speechBandLiftDb: ev.speech ? q(speechLift(ev, g)) : null,
			sfxMaskingDb,
			maskedBy,
			overlapTruePeakDb: ev.truePeak === null ? null : q(overlapTp[si]!),
		};
	});
	return { gains, events: results, warnings, stats: { iterations, converged } };
}

/** W_DIALOGUE_BAND: an event under speech whose dominant band is in 1–4 kHz, naming the types clear of it here. */
function dialogueBandWarnings(evs: Clean[], warnings: SolverWarning[]): void {
	const inSpeechBands = (dom: number[]): boolean => {
		for (const b of dom) if (DIALOGUE_BAND_INDICES.includes(b)) return true;
		return false;
	};
	// types whose every event has its dominant band outside 1–4 kHz (the dialogue advice)
	const typeInSpeech = new Map<string, boolean>();
	for (const ev of evs) {
		if (!ev.type || ev.dom.length === 0) continue;
		typeInSpeech.set(ev.type, (typeInSpeech.get(ev.type) ?? false) || inSpeechBands(ev.dom));
	}
	let clearTypes: string | null = null;
	for (const ev of evs) {
		if (!ev.speech || !inSpeechBands(ev.dom)) continue;
		if (clearTypes === null)
			clearTypes = [...typeInSpeech]
				.filter(([, inSpeech]) => !inSpeech)
				.map(([t]) => t)
				.sort()
				.join(', ');
		// only the dominant bands that ARE in the speech octaves ("8000 Hz, 4000 Hz is in 1–4 kHz" misled)
		const bands = ev.dom
			.filter((b) => DIALOGUE_BAND_INDICES.includes(b))
			.map((b) => `${OCTAVE_BAND_CENTRES_HZ[b]} Hz`)
			.join(', ');
		warnings.push({
			code: 'W_DIALOGUE_BAND',
			clipId: ev.clipId,
			message: `${ev.clipId}: during speech its dominant band (${bands}) is in 1–4 kHz; prefer a type whose dominant band is outside 1–4 kHz${
				clearTypes ? ` (here: ${clearTypes})` : ''
			}`,
		});
	}
}

/** Limits in a fixed order: constraints in solver order, then conflicts (in the order they arose), then the others. */
function limits(bits: number, conflicts: [SolverConstraint, SolverConstraint][]): SolverLimit[] {
	const out: SolverLimit[] = [];
	for (let i = 0; i < SOLVER_CONSTRAINTS.length; i++) if (bits & (1 << i)) out.push(SOLVER_CONSTRAINTS[i]!);
	if (bits & OVERLAP_BIT) out.push('overlap-headroom');
	for (const [kept, lost] of conflicts) out.push(`conflict:${kept}/${lost}`);
	if (bits & USER_OFFSET_BIT) out.push('user-offset');
	if (bits & SILENT_BIT) out.push('silent-sound');
	return out;
}

function reasonText(
	g: number,
	limits: SolverLimit[],
	achieved: number | null,
	target: number,
	conflicts: [SolverConstraint, SolverConstraint][],
	maskingDb = 0,
	maskers = 0,
): string {
	const head = `${fmtDb(g)} dB`;
	const plain = limits.filter((l) => !l.startsWith('conflict:'));
	const parts: string[] = [];
	if (plain.includes('silent-sound')) parts.push('silent sound, base gain kept');
	const by = plain
		.filter((l) => l !== 'silent-sound')
		.map((l) => (l === 'overlap-headroom' ? 'the summed true peak of the sounds overlapping it' : l));
	if (by.length) parts.push(`limited by ${by.join(', ')}`);
	for (const [kept, lost] of conflicts) parts.push(`conflict: ${kept} kept over ${lost}`);
	if (parts.length === 0 && achieved !== null)
		parts.push(
			achieved >= SILENT_BED_LIFT_DB
				? 'nothing plays under it in the bed, default level kept'
				: achieved > target + 0.05
					? `default level already clears the bed by ${fmtDb(achieved)} dB`
					: `target lift ${fmtDb(target)} dB reached`,
		);
	// the bed it clears includes lower sound effects under it
	if (maskers > 0 && maskingDb >= 0.05)
		parts.push(`over the bed and ${maskers} sound effect${maskers === 1 ? '' : 's'} under it (+${fmtDb(maskingDb).replace('+', '')} dB)`);
	return parts.length ? `${head}, ${parts.join('; ')}` : head;
}

/** What a sound effect measures like at a given clip gain, with the solver's own definitions (Sound Check, spec 12 §2.6). */
export interface SfxGainEvaluation {
	clipId: string;
	weight: SolverWeight;
	gainDb: number;
	/** The weight's target lift (dB). */
	targetLiftDb: number;
	/** Lift of the dominant bands over the bed at `gainDb` (dB, 0.01 steps); null for a silent sound. */
	liftDb: number | null;
	/** Centres (Hz) of the dominant bands, strongest first. */
	dominantBands: number[];
	/** Sound peak over the solver's bed reference (local bed peak, never under programme −12 LU); null unmeasured. */
	peakOverBedLu: number | null;
	/** The weight's bed cap (LU). */
	bedCapLu: number;
	truePeakDb: number | null;
	/** Largest lift in a speech band at `gainDb`; null unless the event overlaps speech. */
	speechBandLiftDb: number | null;
}

/**
 * Evaluates one event at a clip gain with exactly the solver's definitions (dominant bands, lift, bed reference, speech
 * bands): Sound Check's MASKED and OVERLOAD findings use it so they agree with what `solveSfxGains` aims at. Pure;
 * never throws (the event is sanitised like the solver's input; a non-finite gain counts as 0 dB).
 */
export function evaluateSfxGain(
	event: SolverEvent,
	gainDb: number,
	opts: SolverOptions = {},
): SfxGainEvaluation {
	const o = opts && typeof opts === 'object' ? opts : {};
	const program =
		isNum(o.programLufs) && Math.abs(o.programLufs) <= LEVEL_CEILING_DB
			? o.programLufs
			: DEFAULT_PROGRAM_LUFS;
	const ev = clean(event, 0, []);
	const g = isNum(gainDb) ? Math.max(-1000, Math.min(1000, gainDb)) : 0;
	const ref = Math.max(ev.bedPeak ?? Number.NEGATIVE_INFINITY, program + QUIET_BED_OFFSET_LU);
	let speech = Number.NEGATIVE_INFINITY;
	for (const b of DIALOGUE_BAND_INDICES) speech = Math.max(speech, ev.sound[b]! + g - ev.bed[b]!);
	return {
		clipId: ev.clipId,
		weight: ev.weight,
		gainDb: q(g),
		targetLiftDb: TARGET_LIFT_DB[ev.weight],
		liftDb: ev.dom.length ? q(ev.soundDom + g - ev.bedDom) : null,
		dominantBands: ev.dom.map((b) => OCTAVE_BAND_CENTRES_HZ[b]!),
		peakOverBedLu: ev.soundPeak === null ? null : q(ev.soundPeak + g - ref),
		bedCapLu: BED_CAP_LU[ev.weight],
		truePeakDb: ev.truePeak === null ? null : q(ev.truePeak + g),
		speechBandLiftDb: ev.speech ? q(speech) : null,
	};
}
