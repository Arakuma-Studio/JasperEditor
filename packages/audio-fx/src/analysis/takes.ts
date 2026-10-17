// Takes (spec 12 P6-E9; wp-note "Phase 6 → WP-E5"): a recording of several hits (a typing run, a clock, ten clicks in a
// pack) split into single takes, so each key press is its own library sound ("vary the take, not the pitch"). Adapted
// from earshot `search.py` (`event_candidates`, `_tail_db`, `_head_db`, `_edit_gaps`; MIT, licenses/ported/earshot.md):
//
//   onsets        the descriptors' SuperFlux detector (`soundOnsets`) over up to 120 s, each refined to its attack: the
//                 loudest 1 ms frame within ±30 ms, then back while the 1 ms envelope stays within 30 dB of it (and
//                 10 dB over the floor)
//   stroke        from 5 ms before the attack until the 5 ms envelope has decayed 35 dB under the stroke's peak (the
//                 loudest frame of its first 60 ms; never under the floor + 4 dB), then 20 ms more; never into the next
//                 stroke (which starts 5 ms before its attack) and at most 2 s
//   take          a stroke, or a pair of strokes whose attacks are < 0.25 s apart (a key's down- and up-stroke), never
//                 across ≥ 10 ms of digital silence (≤ −100 dBFS: separate takes of a pack) and never led by a stroke
//                 15 dB weaker than the one it joins
//   head / tail   the first 5 ms / the louder of the last two 5 ms windows against the take's loudest 5 ms (dB); clean
//                 = head ≤ −15 dB and tail ≤ −30 dB, else `head-cut` / `tail-cut` (also `tail-cut`: the take runs into
//                 digital silence from a level over −30 dB, a chopped decay). Cut takes are recorded, never offered.
//   at most 64    clean takes first, then cut ones; within each, round-robin over 2 s stretches, most prominent (over
//                 the floor) first, so a long run is sampled over its whole length; numbered 1… in time order
//
// Differences from earshot (decisions in the wp-note): events are pairs only, not longer chains (a chain of a fast
// typing run would be several keys); no CLAP scoring (every take is kept, judged by its descriptors); the chop check
// into digital silence is ours. Pure and deterministic; never throws for odd audio (invalid arguments throw
// `SoundAnalysisError` like `analyzeSound`).
import {
	analyzeSound,
	DESCRIPTOR_FLOOR_DB,
	MAX_ANALYSIS_SECONDS,
	type PreparedSound,
	prepareSound,
	type SoundDescriptors,
	soundFloorDb,
	soundOnsets,
} from './sound-descriptors.ts';

/** Most takes kept per file. */
export const TAKE_MAX_COUNT = 64;
/** Longest file split into takes (seconds; longer files get none). */
export const TAKE_MAX_FILE_SECONDS = MAX_ANALYSIS_SECONDS;
/** Strokes whose attacks are closer than this join into one take (a key's down- and up-stroke). */
export const TAKE_JOIN_SEC = 0.25;
/** A stroke ends once it has decayed this far under its peak (dB). */
export const TAKE_DECAY_DB = 35;
/** A take starts this long before its attack (s). */
export const TAKE_PRE_ROLL_SEC = 0.005;
/** A take ends this long after its decay (s). */
export const TAKE_POST_ROLL_SEC = 0.02;
/** Longest take (s). */
export const TAKE_MAX_SEC = 2;
/** Shortest take (s). */
export const TAKE_MIN_SEC = 0.02;
/** Digital silence (≤ −100 dBFS) at least this long separates takes (s). */
export const TAKE_EDIT_GAP_SEC = 0.01;
/** Level of digital silence (linear: −100 dBFS). */
export const TAKE_EDIT_GAP_LEVEL = 1e-5;
/** Clean: the first 5 ms at most this loud against the take's peak (dB). */
export const TAKE_CLEAN_HEAD_DB = -15;
/** Clean: the last 10 ms at most this loud against the take's peak (dB). */
export const TAKE_CLEAN_TAIL_DB = -30;
/** A stroke this much weaker than the next one does not lead a pair (dB). */
export const TAKE_WEAK_LEAD_DB = 15;

export type TakeFlag = 'head-cut' | 'tail-cut';
export const TAKE_FLAGS: readonly TakeFlag[] = Object.freeze(['head-cut', 'tail-cut']);

export interface TakeSegment {
	/** 1-based, in time order. */
	index: number;
	/** First sample of the take (inclusive) and the sample after its last, at the input's rate. */
	startSample: number;
	endSample: number;
	/** The same in seconds (0.1 µs, so `round(sec × rate)` gives the sample back). */
	startSec: number;
	endSec: number;
	/** The first 5 ms against the take's loudest 5 ms (dB, ≤ 0, floor −120). */
	headDb: number;
	/** The louder of the last two 5 ms windows against the take's loudest 5 ms (dB, ≤ 0, floor −120). */
	tailDb: number;
	/** Empty for a clean take. */
	flags: TakeFlag[];
	/** Strokes it holds (1, or 2 for a joined pair). */
	strokes: 1 | 2;
}

export interface AnalysedTake extends TakeSegment {
	/** `analyzeSound` of the take's samples; `floorDb` is the whole recording's (the floor between its events). */
	descriptors: SoundDescriptors;
}

const qDb = (x: number): number => {
	const v =
		Math.round(
			Math.max(DESCRIPTOR_FLOOR_DB, Math.min(0, Number.isFinite(x) ? x : DESCRIPTOR_FLOOR_DB)) * 100,
		) / 100;
	return v === 0 ? 0 : v;
};
const qSec = (x: number): number => Math.round(x * 1e7) / 1e7;
const dbPow = (p: number): number => (p > 0 ? 10 * Math.log10(p) : DESCRIPTOR_FLOOR_DB);

/** Mean power over channels of samples [a, b) (0 for an empty range). */
function power(ch: readonly Float32Array[], a: number, b: number): number {
	if (b <= a || ch.length === 0) return 0;
	let s = 0;
	for (const c of ch)
		for (let i = a; i < b; i++) {
			const x = c[i]!;
			s += x * x;
		}
	return s / ((b - a) * ch.length);
}

/** Level of fixed frames of `w` samples (dB of the mean power over channels; −120 for silence). */
function frameDb(ch: readonly Float32Array[], n: number, w: number): Float64Array {
	const k = Math.ceil(n / w);
	const out = new Float64Array(k);
	for (let f = 0; f < k; f++)
		out[f] = Math.max(DESCRIPTOR_FLOOR_DB, dbPow(power(ch, f * w, Math.min(n, (f + 1) * w))));
	return out;
}

/** 10th percentile of a level array (dB). */
function percentile10(v: Float64Array): number {
	if (v.length === 0) return DESCRIPTOR_FLOOR_DB;
	const s = Float64Array.from(v).sort();
	return s[Math.floor(0.1 * (s.length - 1))]!;
}

/** Runs of ≥ `minLen` samples whose every channel is within ±`level` (digital silence), as [start, end) pairs. */
function silentRuns(
	ch: readonly Float32Array[],
	n: number,
	minLen: number,
	level: number,
): [number, number][] {
	const runs: [number, number][] = [];
	let from = -1;
	for (let i = 0; i <= n; i++) {
		let quiet = i < n;
		if (quiet)
			for (const c of ch)
				if (Math.abs(c[i]!) > level) {
					quiet = false;
					break;
				}
		if (quiet) {
			if (from < 0) from = i;
		} else if (from >= 0) {
			if (i - from >= minLen) runs.push([from, i]);
			from = -1;
		}
	}
	return runs;
}

type Stroke = { start: number; end: number; attack: number; prom: number };
type Event = { start: number; end: number; prom: number; strokes: 1 | 2 };

/** At most `max` events, round-robin over `bucket`-sample stretches, most prominent first within each. */
function selectRoundRobin(events: Event[], max: number, bucket: number): Event[] {
	const by = new Map<number, Event[]>();
	for (const e of events) {
		const k = Math.floor(e.start / bucket);
		const list = by.get(k);
		if (list) list.push(e);
		else by.set(k, [e]);
	}
	const keys = [...by.keys()].sort((a, b) => a - b);
	for (const k of keys) by.get(k)!.sort((a, b) => b.prom - a.prom || a.start - b.start);
	const out: Event[] = [];
	while (out.length < max) {
		let took = false;
		for (const k of keys) {
			const list = by.get(k)!;
			if (list.length && out.length < max) {
				out.push(list.shift()!);
				took = true;
			}
		}
		if (!took) break;
	}
	return out;
}

/** Splits prepared input into takes (see the module comment). */
function takesOf(p: PreparedSound): TakeSegment[] {
	const { channels: ch, frames: n, sampleRate: sr } = p;
	if (ch.length === 0 || n === 0) return [];
	const onsets = soundOnsets(p, TAKE_MAX_FILE_SECONDS);
	if (onsets.length === 0) return [];
	const w1 = Math.max(1, Math.round(sr * 0.001));
	const w5 = Math.max(1, Math.round(sr * 0.005));
	const env1 = frameDb(ch, n, w1);
	const env5 = frameDb(ch, n, w5);
	const floor1 = percentile10(env1);
	const floor5 = percentile10(env5);
	const pre = Math.max(1, Math.round(TAKE_PRE_ROLL_SEC * sr));
	const post = Math.round(TAKE_POST_ROLL_SEC * sr);
	const cap = Math.round(TAKE_MAX_SEC * sr);
	const minLen = Math.round(TAKE_MIN_SEC * sr);
	const search = Math.round(0.03 * sr);
	const gaps = silentRuns(ch, n, Math.max(1, Math.round(TAKE_EDIT_GAP_SEC * sr)), TAKE_EDIT_GAP_LEVEL);
	/** Whether [a, b) holds ≥ 10 ms of one digital-silence run. */
	const gapIn = (a: number, b: number): boolean =>
		gaps.some(([g0, g1]) => Math.min(b, g1) - Math.max(a, g0) >= Math.round(TAKE_EDIT_GAP_SEC * sr));

	// attacks: each onset refined on the 1 ms envelope, strictly increasing
	const attacks: number[] = [];
	for (const o of onsets) {
		const lastFrame = attacks.length ? Math.floor(attacks[attacks.length - 1]! / w1) : -1;
		const k0 = Math.max(lastFrame + 1, Math.floor(Math.max(0, o - search) / w1));
		const k1 = Math.min(env1.length - 1, Math.floor(Math.min(n - 1, o + search) / w1));
		if (k0 > k1) continue;
		let kmax = k0;
		for (let k = k0 + 1; k <= k1; k++) if (env1[k]! > env1[kmax]!) kmax = k;
		const thr = Math.max(floor1 + 10, env1[kmax]! - 30);
		if (env1[kmax]! < thr) continue;
		let k = kmax;
		while (k - 1 >= k0 && env1[k - 1]! >= thr) k--;
		attacks.push(k * w1);
	}

	// strokes: attack → decayed 35 dB (+ 20 ms), never into the next stroke
	const strokes: Stroke[] = [];
	let prevEnd = 0;
	for (let i = 0; i < attacks.length; i++) {
		const att = attacks[i]!;
		const limit = i + 1 < attacks.length ? Math.max(0, attacks[i + 1]! - pre) : n;
		const start = Math.max(0, att - pre, prevEnd);
		if (limit <= start) continue;
		const f0 = Math.min(env5.length - 1, Math.floor(att / w5));
		const fLimit = Math.min(env5.length, Math.ceil(limit / w5));
		let pk = f0;
		for (let f = f0 + 1; f < Math.min(fLimit, f0 + 13); f++) if (env5[f]! > env5[pk]!) pk = f;
		const thr = Math.max(env5[pk]! - TAKE_DECAY_DB, floor5 + 4);
		let end = limit;
		for (let f = pk + 1; f < fLimit; f++)
			if (env5[f]! < thr) {
				end = f * w5 + post;
				break;
			}
		end = Math.min(end, limit, start + cap, n);
		if (end - start < minLen) continue;
		strokes.push({ start, end, attack: att, prom: env5[pk]! - floor5 });
		prevEnd = end;
	}

	// takes: single strokes and joined pairs
	const events: Event[] = [];
	for (let i = 0; i < strokes.length; ) {
		const a = strokes[i]!;
		const b = strokes[i + 1];
		if (
			b &&
			b.attack - a.attack < TAKE_JOIN_SEC * sr &&
			!gapIn(a.attack, b.attack) &&
			a.prom >= b.prom - TAKE_WEAK_LEAD_DB &&
			b.end - a.start <= cap
		) {
			events.push({ start: a.start, end: b.end, prom: Math.max(a.prom, b.prom), strokes: 2 });
			i += 2;
		} else {
			events.push({ start: a.start, end: a.end, prom: a.prom, strokes: 1 });
			i += 1;
		}
	}

	// edges: head and tail against the take's loudest 5 ms
	const measured = events.map((e) => {
		let peak = 0;
		for (let x = e.start; x < e.end; x += w5) peak = Math.max(peak, power(ch, x, Math.min(e.end, x + w5)));
		const head = power(ch, e.start, Math.min(e.end, e.start + w5));
		const tail = Math.max(
			power(ch, Math.max(e.start, e.end - w5), e.end),
			power(ch, Math.max(e.start, e.end - 2 * w5), Math.max(e.start, e.end - w5)),
		);
		peak = Math.max(peak, head, tail);
		const rel = (x: number) => (peak > 0 ? dbPow(x / peak) : DESCRIPTOR_FLOOR_DB);
		const headDb = qDb(rel(head));
		const tailDb = qDb(rel(tail));
		const flags: TakeFlag[] = [];
		if (headDb > TAKE_CLEAN_HEAD_DB) flags.push('head-cut');
		let chopped = tailDb > TAKE_CLEAN_TAIL_DB;
		if (!chopped)
			for (const [g0] of gaps)
				if (
					g0 > e.start + w5 &&
					g0 < e.end &&
					rel(power(ch, Math.max(e.start, g0 - w5), g0)) > TAKE_CLEAN_TAIL_DB
				) {
					chopped = true;
					break;
				}
		if (chopped) flags.push('tail-cut');
		return { ...e, headDb, tailDb, flags };
	});

	// at most 64: clean ones first, round-robin over 2 s stretches
	const bucket = Math.max(1, Math.round(2 * sr));
	const clean = measured.filter((e) => e.flags.length === 0);
	const cut = measured.filter((e) => e.flags.length > 0);
	let kept: typeof measured = measured;
	if (measured.length > TAKE_MAX_COUNT) {
		const first = selectRoundRobin(clean, TAKE_MAX_COUNT, bucket) as typeof measured;
		const rest = selectRoundRobin(cut, TAKE_MAX_COUNT - first.length, bucket) as typeof measured;
		kept = [...first, ...rest];
	}
	return [...kept]
		.sort((a, b) => a.start - b.start)
		.map((e, i) => ({
			index: i + 1,
			startSample: e.start,
			endSample: e.end,
			startSec: qSec(e.start / sr),
			endSec: qSec(e.end / sr),
			headDb: e.headDb,
			tailDb: e.tailDb,
			flags: e.flags,
			strokes: e.strokes,
		}));
}

/**
 * The takes of a recording (its first {@link TAKE_MAX_FILE_SECONDS}): segments only. `channels` and `sampleRate` as
 * for `analyzeSound` (invalid arguments throw `SoundAnalysisError`; non-finite samples count as 0).
 */
export function findTakes(channels: Float32Array[], sampleRate: number): TakeSegment[] {
	return takesOf(prepareSound(channels, sampleRate));
}

/** The takes of a recording with each take's own descriptors (`floorDb` = the recording's floor between events). */
export function analyzeTakes(channels: Float32Array[], sampleRate: number): AnalysedTake[] {
	const p = prepareSound(channels, sampleRate);
	const segments = takesOf(p);
	if (segments.length === 0) return [];
	const floorDb = soundFloorDb(p);
	return segments.map((s) => {
		const d = analyzeSound(
			p.channels.map((c) => c.subarray(s.startSample, s.endSample)),
			p.sampleRate,
		);
		return { ...s, descriptors: { ...d, floorDb } };
	});
}
