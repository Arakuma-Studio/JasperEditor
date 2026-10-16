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
//   4 consistency  repeats (same soundId, then same type and weight) within the group median ±2 dB
//   5 dialogue     during speech, lift in each of the 1, 2 and 4 kHz bands ≤ +1 dB
//   6 headroom     sound true peak + gain ≤ the ceiling (default −1 dBTP, pre-master); unmeasured peak: no boost
//
// Each step narrows a per-event interval [lo, hi] of allowed gains and moves the gain into it. A step whose bound
// does not meet the interval left by the earlier steps loses: the earlier (safety) constraint is kept and the event
// reports `conflict:<earlier>/<later>`. After step 6 every constraint is checked again on the final gain (rounded to
// 0.01 dB, which may miss a bound by at most 0.005 dB when the allowed interval holds no 0.01 dB step); a violation
// without a reported conflict is a W_UNRESOLVED warning (the tests require none).
import { BAND_FLOOR_DB, OCTAVE_BAND_CENTRES_HZ, sumBandsDb } from './bands.ts';

// ── constants (sources and reasoning: wp-note "Phase 4 → WP4.1a masking solver") ─────────────────────────────────

export type SolverWeight = 'hero' | 'support' | 'ambient';
export const SOLVER_WEIGHTS: readonly SolverWeight[] = /* @__PURE__ */ Object.freeze(['hero', 'support', 'ambient']);
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
export const HERO_SHADOW_DB = 20 * Math.log10(HERO_SHADOW_FACTOR);
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

const BANDS = OCTAVE_BAND_CENTRES_HZ.length;
const DIALOGUE_BAND_INDICES = DIALOGUE_BANDS_HZ.map((hz) => OCTAVE_BAND_CENTRES_HZ.indexOf(hz));
/** Highest level accepted in a band or loudness field (dB); more is treated as invalid. */
const LEVEL_CEILING_DB = 200;
/** Tolerance of the bound comparisons (dB). */
const EPS = 1e-9;

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
};

/** Sanitise one event; `notes` collects what was replaced. */
function clean(raw: unknown, index: number, notes: string[]): Clean {
	const e = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	if (raw === null || typeof raw !== 'object') notes.push('not an object');
	const str = (k: string): string => {
		const v = e[k];
		if (typeof v === 'string') return v;
		if (v !== undefined && v !== null) notes.push(`${k} is not a string`);
		return k === 'clipId' ? `#${index}` : '';
	};
	const bands = (k: string): number[] => {
		const v = e[k];
		const out: number[] = [];
		if (!Array.isArray(v)) notes.push(`${k} is not an array`);
		else if (v.length !== BANDS) notes.push(`${k} has ${v.length} bands, not ${BANDS}`);
		for (let i = 0; i < BANDS; i++) {
			const x = Array.isArray(v) ? v[i] : undefined;
			if (isNum(x) && x <= LEVEL_CEILING_DB) out.push(Math.max(BAND_FLOOR_DB, x));
			else {
				// −Infinity (silence) and a missing band are the floor quietly; NaN / +Infinity are reported
				if (x !== Number.NEGATIVE_INFINITY && x !== undefined) notes.push(`${k}[${i}] is not a finite level`);
				out.push(BAND_FLOOR_DB);
			}
		}
		return out;
	};
	const level = (k: string, silentOk: boolean): number | null => {
		const v = e[k];
		if (isNum(v) && v <= LEVEL_CEILING_DB) return v;
		if (v === null || v === undefined || (silentOk && v === Number.NEGATIVE_INFINITY)) return null;
		notes.push(`${k} is not a finite level`);
		return null;
	};
	const num = (k: string, fallback: number, optional = false): number => {
		const v = e[k];
		if (isNum(v)) return v;
		if (!(optional && v === undefined)) notes.push(`${k} is not a finite number`);
		return fallback;
	};
	let weight = e.weight as SolverWeight;
	if (!SOLVER_WEIGHTS.includes(weight)) {
		notes.push('weight is not hero, support or ambient (support used)');
		weight = 'support';
	}
	let start = num('startSec', 0);
	let end = num('endSec', start);
	if (end < start) {
		notes.push('endSec is before startSec (swapped)');
		[start, end] = [end, start];
	}
	if (typeof e.speechOverlap !== 'boolean' && e.speechOverlap !== undefined) notes.push('speechOverlap is not a boolean');
	const base = Math.max(-1000, Math.min(1000, num('baseGainDb', 0)));
	const offset = Math.max(-1000, Math.min(1000, num('userOffsetDb', 0, true)));
	return {
		clipId: str('clipId'),
		soundId: str('soundId'),
		type: str('type'),
		weight,
		start,
		end,
		sound: bands('soundBandsDb'),
		bed: bands('bedBandsDb'),
		soundPeak: level('soundPeakLu', true),
		truePeak: level('truePeakDb', true),
		bedPeak: level('bedLocalPeakLu', true),
		speech: e.speechOverlap === true,
		base,
		offset,
	};
}

/** Dominant band indices: the strongest, plus the second when its energy share is ≥ {@link DOMINANT_SHARE}. */
function dominant(bands: number[]): number[] {
	let total = 0;
	for (const b of bands) if (b > BAND_FLOOR_DB) total += 10 ** (b / 10);
	if (!(total > 0)) return [];
	const order = bands
		.map((b, i) => ({ b, i }))
		.filter((x) => x.b > BAND_FLOOR_DB)
		.sort((x, y) => y.b - x.b || x.i - y.i);
	const out = [order[0]!.i];
	const second = order[1];
	if (second && 10 ** (second.b / 10) / total >= DOMINANT_SHARE) out.push(second.i);
	return out;
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
	limited: Set<SolverLimit>;
	conflicts: [SolverConstraint, SolverConstraint][];
	/** Bounds recorded by steps 3 and 4 (the re-verification checks them). */
	shadowHi: number | null;
	consistency: [number, number][];
};

function conflict(st: State, kept: SolverConstraint, lost: SolverConstraint): void {
	if (!st.conflicts.some(([a, b]) => a === kept && b === lost)) st.conflicts.push([kept, lost]);
	st.limited.add(`conflict:${kept}/${lost}`);
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
			st.limited.add(by);
		}
		return;
	}
	// the bound is under what an earlier step requires: the earlier one is kept
	conflict(st, st.loBy, by);
	if (st.g > st.lo + EPS) st.limited.add(by);
	st.g = st.lo;
	st.hi = st.lo;
	st.hiBy = st.loBy;
}

/** Step `by` allows gains ≥ `bound`. */
function lower(st: State, by: SolverConstraint, bound: number): void {
	if (bound <= st.hi + EPS) {
		if (bound > st.lo) {
			st.lo = Math.min(st.hi, bound);
			st.loBy = by;
		}
		if (st.g < st.lo - EPS) {
			st.g = st.lo;
			st.limited.add(by);
		}
		return;
	}
	conflict(st, st.hiBy, by);
	if (st.g < st.hi - EPS) st.limited.add(by);
	st.g = st.hi;
	st.lo = st.hi;
	st.loBy = st.hiBy;
}

const levelIn = (bands: number[], idx: number[]): number => sumBandsDb(idx.map((i) => bands[i]!));

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

/** Groups of ≥ 2 event indices sharing a key (empty keys are not grouped), in first-occurrence order. */
function groups(states: State[], key: (s: State) => string): number[][] {
	const map = new Map<string, number[]>();
	states.forEach((s, i) => {
		const k = key(s);
		if (k === '') return;
		const g = map.get(k);
		if (g) g.push(i);
		else map.set(k, [i]);
	});
	return [...map.values()].filter((g) => g.length >= 2);
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
		isNum(o.programLufs) && Math.abs(o.programLufs) <= LEVEL_CEILING_DB ? o.programLufs : DEFAULT_PROGRAM_LUFS;
	if (o.truePeakCeilingDb !== undefined && ceiling !== o.truePeakCeilingDb)
		warnings.push({ code: 'W_INVALID_INPUT', message: `truePeakCeilingDb is not a finite level; ${ceiling} dBTP used` });
	if (o.programLufs !== undefined && program !== o.programLufs)
		warnings.push({ code: 'W_INVALID_INPUT', message: `programLufs is not a finite level; ${program} LUFS used` });
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
			limited: new Set(),
			conflicts: [],
			shadowHi: null,
			consistency: [],
		};
		const dom = dominant(ev.sound);
		if (dom.length === 0) {
			st.g = ev.base + ev.offset;
			st.limited.add('silent-sound');
			warnings.push({
				code: 'W_SILENT_SOUND',
				clipId: ev.clipId,
				message: `${ev.clipId}: the sound has no energy in 125 Hz … 8 kHz; it keeps its base gain`,
			});
		} else {
			const need = levelIn(ev.bed, dom) + TARGET_LIFT_DB[ev.weight] - levelIn(ev.sound, dom);
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
		if (Math.abs(g - st.g) > EPS) st.limited.add('clamp');
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

	// ── 4 consistency: same sound, then same type and weight ─────────────────────────────────────────────────────
	for (const key of [(s: State) => s.ev.soundId, (s: State) => (s.ev.type ? `${s.ev.type}\u0000${s.ev.weight}` : '')]) {
		for (const grp of groups(states, key)) {
			const m = median(grp.map((i) => states[i]!.g));
			for (const i of grp) {
				const st = states[i]!;
				st.consistency.push([m - CONSISTENCY_DB, m + CONSISTENCY_DB]);
				upper(st, 'consistency', m + CONSISTENCY_DB);
				lower(st, 'consistency', m - CONSISTENCY_DB);
			}
		}
	}

	// ── 5 dialogue guard ─────────────────────────────────────────────────────────────────────────────────────────
	const speechLift = (ev: Clean, g: number): number =>
		Math.max(...DIALOGUE_BAND_INDICES.map((b) => ev.sound[b]! + g - ev.bed[b]!));
	const speechBands = (bands: number[]): boolean => bands.some((b) => DIALOGUE_BAND_INDICES.includes(b));
	const clearTypes = new Set<string>();
	const typeDominants = new Map<string, boolean>();
	for (const st of states) {
		const dom = dominant(st.ev.sound);
		if (!st.ev.type || dom.length === 0) continue;
		const inSpeech = speechBands(dom);
		typeDominants.set(st.ev.type, (typeDominants.get(st.ev.type) ?? false) || inSpeech);
	}
	for (const [t, inSpeech] of typeDominants) if (!inSpeech) clearTypes.add(t);
	for (const st of states) {
		const { ev } = st;
		if (!ev.speech) continue;
		const bound = DIALOGUE_LIFT_DB + Math.min(...DIALOGUE_BAND_INDICES.map((b) => ev.bed[b]! - ev.sound[b]!));
		upper(st, 'dialogue', bound);
		const dom = dominant(ev.sound);
		if (speechBands(dom)) {
			const alt = [...clearTypes].sort();
			warnings.push({
				code: 'W_DIALOGUE_BAND',
				clipId: ev.clipId,
				message: `${ev.clipId}: during speech its dominant band (${dom
					.map((b) => `${OCTAVE_BAND_CENTRES_HZ[b]} Hz`)
					.join(', ')}) is in 1–4 kHz; prefer a type whose dominant band is outside 1–4 kHz${
					alt.length ? ` (here: ${alt.join(', ')})` : ''
				}`,
			});
		}
	}

	// ── 6 headroom ───────────────────────────────────────────────────────────────────────────────────────────────
	for (const st of states) {
		const { ev } = st;
		upper(st, 'headroom', ev.truePeak === null ? 0 : ceiling - ev.truePeak);
	}

	// ── quantise, re-verify, report ──────────────────────────────────────────────────────────────────────────────
	const gains: Record<string, number> = {};
	const results: SolverEventResult[] = states.map((st) => {
		const { ev } = st;
		// round to the step, staying inside the interval when the step allows it
		let g = q(st.g);
		if (g > st.hi + EPS && q(g - SOLVER_STEP_DB) >= st.lo - EPS) g = q(g - SOLVER_STEP_DB);
		else if (g < st.lo - EPS && q(g + SOLVER_STEP_DB) <= st.hi + EPS) g = q(g + SOLVER_STEP_DB);
		// an interval narrower than the step may hold no step: rounding may then miss a bound by half a step
		const tol = SOLVER_STEP_DB / 2 + 1e-9;
		const violated: SolverConstraint[] = [];
		if (g < SOLVER_GAIN_MIN_DB - tol || g > SOLVER_GAIN_MAX_DB + tol) violated.push('clamp');
		if (ev.soundPeak !== null && ev.soundPeak + g - bedRef(ev) > BED_CAP_LU[ev.weight] + tol) violated.push('bed-cap');
		if (st.shadowHi !== null && g > st.shadowHi + tol) violated.push('hero-shadow');
		if (st.consistency.some(([a, b]) => g < a - tol || g > b + tol)) violated.push('consistency');
		if (ev.speech && speechLift(ev, g) > DIALOGUE_LIFT_DB + tol) violated.push('dialogue');
		if (g > (ev.truePeak === null ? 0 : ceiling - ev.truePeak) + tol) violated.push('headroom');
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

		const dom = dominant(ev.sound);
		const target = TARGET_LIFT_DB[ev.weight];
		const achieved = dom.length ? levelIn(ev.sound, dom) + g - levelIn(ev.bed, dom) : null;
		if (achieved !== null && ev.offset < 0 && achieved < target - 0.005 && st.limited.size === 0)
			st.limited.add('user-offset');
		const limitedBy = orderLimits(st.limited);
		gains[ev.clipId] = g;
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

/** Limits in a fixed order: constraints in solver order, then conflicts, then the others. */
function orderLimits(set: Set<SolverLimit>): SolverLimit[] {
	const rank = (l: SolverLimit): number => {
		const i = (SOLVER_CONSTRAINTS as readonly string[]).indexOf(l);
		if (i >= 0) return i;
		if (l.startsWith('conflict:')) return 10;
		return l === 'user-offset' ? 20 : 21;
	};
	return [...set].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
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
