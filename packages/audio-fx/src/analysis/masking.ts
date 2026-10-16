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
//   6 headroom     sound true peak + gain ≤ the ceiling (default −1 dBTP, pre-master); unmeasured peak: no boost
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
 * constraints could not both hold (the earlier one is kept), `user-offset` when the user's offset took the lift under
 * the target, `silent-sound` when the sound has no band energy (it keeps its base gain).
 */
export type SolverLimit =
	| SolverConstraint
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
}

export interface SolverOptions {
	/** Constraint 6 ceiling (dBTP), default {@link DEFAULT_TRUE_PEAK_CEILING_DB}. */
	truePeakCeilingDb?: number;
	/** Programme loudness (the delivery's integrated target, LUFS), default {@link DEFAULT_PROGRAM_LUFS}. */
	programLufs?: number;
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
}

export type SolverWarningCode =
	| 'W_INVALID_INPUT'
	| 'W_SANITISED'
	| 'W_DUPLICATE_CLIP'
	| 'W_SILENT_SOUND'
	| 'W_UNMEASURED'
	| 'W_CONFLICT'
	| 'W_DIALOGUE_BAND'
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
function shadowed(states: State[]): Set<number> {
	const heroes = states
		.map((s, i) => ({ s: s.ev.start, e: s.ev.end, i }))
		.filter((h) => states[h.i]!.ev.weight === 'hero')
		.sort((a, b) => a.s - b.s || a.i - b.i);
	const out = new Set<number>();
	if (heroes.length === 0) return out;
	// prefix maximum of hero ends, by start
	const maxEnd: number[] = [];
	for (let k = 0; k < heroes.length; k++) maxEnd.push(Math.max(k ? maxEnd[k - 1]! : -Infinity, heroes[k]!.e));
	states.forEach((st, i) => {
		if (st.ev.weight !== 'support') return;
		// heroes starting no later than end + 0.15 whose end is no earlier than start − 0.15
		const limit = st.ev.end + HERO_SHADOW_SEC + EPS;
		let lo = 0;
		let hi = heroes.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (heroes[mid]!.s <= limit) lo = mid + 1;
			else hi = mid;
		}
		if (lo > 0 && maxEnd[lo - 1]! >= st.ev.start - HERO_SHADOW_SEC - EPS) out.add(i);
	});
	return out;
}

/**
 * Repeat groups (constraint 4), disjoint, of ≥ 2 event indices in first-occurrence order: events whose sound id
 * occurs more than once are grouped by sound id; the others by type and weight (an empty id or type groups nothing).
 */
function repeatGroups(states: State[]): number[][] {
	const idCount = new Map<string, number>();
	for (const s of states) if (s.ev.soundId) idCount.set(s.ev.soundId, (idCount.get(s.ev.soundId) ?? 0) + 1);
	const map = new Map<string, number[]>();
	for (let i = 0; i < states.length; i++) {
		const { soundId, type, weight } = states[i]!.ev;
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
function settleGroup(states: State[], grp: number[], final: boolean): void {
	let active = grp;
	let m = median(active.map((i) => states[i]!.g));
	for (;;) {
		const keep = active.filter((i) => states[i]!.hi3 >= m - CONSISTENCY_DB - EPS);
		if (keep.length === active.length) break;
		active = keep; // never empty: the member with the largest gain g ≥ m has hi3 ≥ g ≥ m
		m = median(active.map((i) => states[i]!.g));
	}
	for (const i of grp) states[i]!.inGroup = false;
	for (const i of active) states[i]!.inGroup = true;
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

// ── solver ───────────────────────────────────────────────────────────────────────────────────────────────────────

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
	if (!Array.isArray(events)) {
		if (events !== undefined && events !== null)
			warnings.push({ code: 'W_INVALID_INPUT', message: 'events is not an array; nothing solved' });
		return { gains: {}, events: [], warnings };
	}
	const quietBed = program + QUIET_BED_OFFSET_LU;

	// ── target ───────────────────────────────────────────────────────────────────────────────────────────────────
	const states: State[] = events.map((raw, i) => {
		const notes: string[] = [];
		const ev = clean(raw, i, notes);
		if (notes.length)
			warnings.push({ code: 'W_SANITISED', clipId: ev.clipId, message: `${ev.clipId}: ${notes.join('; ')}` });
		const st: State = {
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
		};
		if (ev.dom.length === 0) {
			st.g = ev.base + ev.offset;
			st.limited |= SILENT_BIT;
			warnings.push({
				code: 'W_SILENT_SOUND',
				clipId: ev.clipId,
				message: `${ev.clipId}: the sound has no energy in 125 Hz … 8 kHz; it keeps its base gain`,
			});
		} else {
			const need = ev.bedDom + TARGET_LIFT_DB[ev.weight] - ev.soundDom;
			st.g = Math.max(ev.base, need) + ev.offset;
		}
		if (ev.soundPeak === null || ev.truePeak === null)
			warnings.push({
				code: 'W_UNMEASURED',
				clipId: ev.clipId,
				message: `${ev.clipId}: ${ev.soundPeak === null ? 'no peak loudness (bed cap not applied)' : ''}${
					ev.soundPeak === null && ev.truePeak === null ? '; ' : ''
				}${ev.truePeak === null ? 'no true peak (never boosted)' : ''}`,
			});
		return st;
	});
	const seen = new Set<string>();
	for (const st of states) {
		if (seen.has(st.ev.clipId))
			warnings.push({
				code: 'W_DUPLICATE_CLIP',
				clipId: st.ev.clipId,
				message: `${st.ev.clipId} appears more than once; gains keeps the last`,
			});
		seen.add(st.ev.clipId);
	}

	// ── 1 clamp ──────────────────────────────────────────────────────────────────────────────────────────────────
	for (const st of states) {
		st.lo = SOLVER_GAIN_MIN_DB;
		st.hi = SOLVER_GAIN_MAX_DB;
		const g = Math.min(SOLVER_GAIN_MAX_DB, Math.max(SOLVER_GAIN_MIN_DB, st.g));
		if (Math.abs(g - st.g) > EPS) st.limited |= BIT.clamp;
		st.g = g;
	}

	// ── 2 bed cap ────────────────────────────────────────────────────────────────────────────────────────────────
	const bedRef = (ev: Clean): number => Math.max(ev.bedPeak ?? Number.NEGATIVE_INFINITY, quietBed);
	for (const st of states) {
		const { ev } = st;
		if (ev.soundPeak === null) continue;
		upper(st, 'bed-cap', bedRef(ev) + BED_CAP_LU[ev.weight] - ev.soundPeak);
	}

	// ── 3 hero shadow ────────────────────────────────────────────────────────────────────────────────────────────
	for (const i of shadowed(states)) {
		const st = states[i]!;
		const bound = st.g + HERO_SHADOW_DB;
		upper(st, 'hero-shadow', bound);
		st.shadowHi = bound;
	}

	// ── 4 consistency: repeats (same sound, else same type and weight) within the median ± 2 dB ─────────────────
	// Steps 1–3 come first: a member whose steps 1–3 cap is under its group's window cannot join it; it goes as high
	// as that cap allows and is left out of the median (the conflict is reported after the last step). The window is
	// not a fixed bound for steps 5 and 6: the relation is settled again around the group's median after them.
	const groupsList = repeatGroups(states);
	for (const st of states) {
		st.hi3 = st.hi;
		st.hi3By = st.hiBy;
	}
	groupsList.forEach((grp, gi) => {
		for (const i of grp) states[i]!.group = gi;
		settleGroup(states, grp, false);
	});

	// ── 5 dialogue guard ─────────────────────────────────────────────────────────────────────────────────────────
	const speechLift = (ev: Clean, g: number): number => {
		let m = Number.NEGATIVE_INFINITY;
		for (const b of DIALOGUE_BAND_INDICES) m = Math.max(m, ev.sound[b]! + g - ev.bed[b]!);
		return m;
	};
	const inSpeechBands = (dom: number[]): boolean => {
		for (const b of dom) if (DIALOGUE_BAND_INDICES.includes(b)) return true;
		return false;
	};
	// types whose every event has its dominant band outside 1–4 kHz (the dialogue advice)
	const typeInSpeech = new Map<string, boolean>();
	for (const st of states) {
		const { ev } = st;
		if (!ev.type || ev.dom.length === 0) continue;
		typeInSpeech.set(ev.type, (typeInSpeech.get(ev.type) ?? false) || inSpeechBands(ev.dom));
	}
	let clearTypes: string | null = null;
	for (const st of states) {
		const { ev } = st;
		if (!ev.speech) continue;
		st.dialogueHi = DIALOGUE_LIFT_DB + ev.speechRoom;
		upper(st, 'dialogue', st.dialogueHi);
		if (inSpeechBands(ev.dom)) {
			if (clearTypes === null)
				clearTypes = [...typeInSpeech]
					.filter(([, inSpeech]) => !inSpeech)
					.map(([t]) => t)
					.sort()
					.join(', ');
			const bands = ev.dom.map((b) => `${OCTAVE_BAND_CENTRES_HZ[b]} Hz`).join(', ');
			warnings.push({
				code: 'W_DIALOGUE_BAND',
				clipId: ev.clipId,
				message: `${ev.clipId}: during speech its dominant band (${bands}) is in 1–4 kHz; prefer a type whose dominant band is outside 1–4 kHz${
					clearTypes ? ` (here: ${clearTypes})` : ''
				}`,
			});
		}
	}

	// ── 6 headroom ───────────────────────────────────────────────────────────────────────────────────────────────
	for (const st of states) {
		const { ev } = st;
		st.headroomHi = ev.truePeak === null ? 0 : ceiling - ev.truePeak;
		upper(st, 'headroom', st.headroomHi);
	}

	// ── re-verify 4 against the steps after it ──────────────────────────────────────────────────────────────────
	// Steps 5 and 6 only lower gains. Around each group's (new) median, a member left above median + 2 comes down
	// (nothing breaks), one left under median − 2 goes back up to it — over a step 5 / 6 bound only as a reported
	// conflict, since consistency comes first.
	for (const grp of groupsList) settleGroup(states, grp, true);

	// ── quantise, re-verify, report ──────────────────────────────────────────────────────────────────────────────
	const finalGain = (st: State): number => {
		// round to the step, staying inside the interval when the step allows it
		let g = q(st.g);
		if (g > st.hi + EPS && q(g - SOLVER_STEP_DB) >= st.lo - EPS) g = q(g - SOLVER_STEP_DB);
		else if (g < st.lo - EPS && q(g + SOLVER_STEP_DB) <= st.hi + EPS) g = q(g + SOLVER_STEP_DB);
		return g;
	};
	const finals = states.map(finalGain);
	const groupMedian = groupsList.map((grp) => {
		const active = grp.filter((i) => states[i]!.inGroup);
		return median(active.map((i) => finals[i]!));
	});
	const gains: Record<string, number> = {};
	const results: SolverEventResult[] = states.map((st, si) => {
		const { ev } = st;
		const g = finals[si]!;
		// an interval narrower than the step may hold no step: rounding may then miss a bound by half a step
		const tol = SOLVER_STEP_DB / 2 + 1e-9;
		const violated: SolverConstraint[] = [];
		if (g < SOLVER_GAIN_MIN_DB - tol || g > SOLVER_GAIN_MAX_DB + tol) violated.push('clamp');
		if (ev.soundPeak !== null && ev.soundPeak + g - bedRef(ev) > BED_CAP_LU[ev.weight] + tol)
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
		for (const [kept, lost] of st.conflicts)
			warnings.push({
				code: 'W_CONFLICT',
				clipId: ev.clipId,
				message: `${ev.clipId}: ${lost} could not hold without breaking ${kept}; ${kept} was kept`,
			});

		const { dom } = ev;
		const target = TARGET_LIFT_DB[ev.weight];
		const achieved = dom.length ? ev.soundDom + g - ev.bedDom : null;
		if (
			achieved !== null &&
			ev.offset < 0 &&
			achieved < target - 0.005 &&
			st.limited === 0 &&
			!st.conflicts.length
		)
			st.limited |= USER_OFFSET_BIT;
		const limitedBy = limits(st.limited, st.conflicts);
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
			reason: reasonText(g, limitedBy, achieved, target, st.conflicts),
			peakOverBedLu: ev.soundPeak === null ? null : q(ev.soundPeak + g - bedRef(ev)),
			truePeakDb: ev.truePeak === null ? null : q(ev.truePeak + g),
			speechBandLiftDb: ev.speech ? q(speechLift(ev, g)) : null,
		};
	});
	return { gains, events: results, warnings };
}

/** Limits in a fixed order: constraints in solver order, then conflicts (in the order they arose), then the others. */
function limits(bits: number, conflicts: [SolverConstraint, SolverConstraint][]): SolverLimit[] {
	const out: SolverLimit[] = [];
	for (let i = 0; i < SOLVER_CONSTRAINTS.length; i++) if (bits & (1 << i)) out.push(SOLVER_CONSTRAINTS[i]!);
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
): string {
	const head = `${fmtDb(g)} dB`;
	const plain = limits.filter((l) => !l.startsWith('conflict:'));
	const parts: string[] = [];
	if (plain.includes('silent-sound')) parts.push('silent sound, base gain kept');
	const by = plain.filter((l) => l !== 'silent-sound');
	if (by.length) parts.push(`limited by ${by.join(', ')}`);
	for (const [kept, lost] of conflicts) parts.push(`conflict: ${kept} kept over ${lost}`);
	if (parts.length === 0 && achieved !== null)
		parts.push(
			achieved > target + 0.05
				? `default level already clears the bed by ${fmtDb(achieved)} dB`
				: `target lift ${fmtDb(target)} dB reached`,
		);
	return parts.length ? `${head}, ${parts.join('; ')}` : head;
}
