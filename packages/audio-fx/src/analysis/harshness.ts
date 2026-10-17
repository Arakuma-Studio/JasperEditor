// Harshness for Sound Check (spec 12 §4 P6-E2 `HARSH`; wp-note "Phase 6 → WP-E1"). Pure, deterministic, streaming
// and total (never throws).
//
// Adapted from earshot `skills/real-sound/scripts/qa.py` `check_harshness` (MIT, Copyright (c) 2026 Leon Lin;
// licenses/ported/earshot.md): the presence band 2–6 kHz (a 4th-order Butterworth high-pass at 2 kHz and low-pass at
// 6 kHz), its 5 ms RMS. earshot band-passes the channel mean; here each channel is band-passed and their mean square
// taken (decision, wp-note): equal for a mono or dual-mono sound, but wide (decorrelated) stereo music is not read
// 3 dB low, which would make every centred sound effect look harsh against it. A placed sound whose 5 ms presence peak is more than 6 dB over the loudest
// 5 ms presence of the music anywhere in the range is harsh: 2–6 kHz is what phone and laptop speakers make painful
// first. Here the presence level is kept per 10 ms hop (the largest 5 ms window ending in each hop), so the engine can
// read any event's peak and a stem's maximum from one streaming pass.
import { designBiquad } from '@jasper/audio-dsp';

export const PRESENCE_BAND = { lowHz: 2000, highHz: 6000, rmsMs: 5 } as const;
/** Floor of presence levels (dBFS). */
export const PRESENCE_FLOOR_DB = -120;

const BUTTER4_Q = [0.5411961, 1.306563] as const;
const fin = (x: number) => x - x === 0;

/**
 * Streams planar blocks into per-hop presence levels: hop `h` holds the largest mean square (over the channels and a
 * 5 ms window) of the band-passed signal for windows ending inside the hop, in dB (floored). Hops of `hopSec` (default 10 ms).
 */
export class PresenceMeter {
	readonly sampleRate: number;
	readonly channels: number;
	readonly hop: number;
	readonly window: number;
	/** Four sections (2 high-pass, 2 low-pass): b0 b1 b2 a1 a2 each; TDF-II state s1 s2 each. */
	private readonly coeffs: Float64Array;
	private readonly state: Float64Array;
	private readonly ring: Float64Array;
	private ringPos = 0;
	private filled = 0;
	private sum = 0;
	private inHop = 0;
	private hopMax = 0;
	private levels: Float32Array;
	private n = 0;
	private readonly cap: number;

	constructor(sampleRate: number, channels: number, opts: { hopSec?: number; maxHops?: number } = {}) {
		this.sampleRate = fin(sampleRate) && sampleRate >= 1000 && sampleRate <= 768_000 ? Math.round(sampleRate) : 48_000;
		this.channels = Math.max(1, Math.min(32, Math.floor(fin(channels) ? channels : 1)));
		const hopSec = fin(opts.hopSec as number) && (opts.hopSec as number) > 0 ? (opts.hopSec as number) : 0.01;
		this.hop = Math.max(1, Math.round(this.sampleRate * hopSec));
		this.window = Math.max(1, Math.round((PRESENCE_BAND.rmsMs / 1000) * this.sampleRate));
		const nyq = this.sampleRate * 0.49;
		const sections = [
			...BUTTER4_Q.map((q) => designBiquad('highPass', this.sampleRate, PRESENCE_BAND.lowHz, q)),
			...BUTTER4_Q.map((q) => designBiquad('lowPass', this.sampleRate, Math.min(nyq, PRESENCE_BAND.highHz), q)),
		];
		this.coeffs = new Float64Array(20);
		sections.forEach((c, k) => this.coeffs.set([c.b0, c.b1, c.b2, c.a1, c.a2], k * 5));
		this.state = new Float64Array(8 * this.channels);
		this.ring = new Float64Array(this.window);
		this.cap = Math.max(1, Math.min(6 * 3600 * 100, Math.floor(opts.maxHops ?? 6 * 3600 * 100)));
		this.levels = new Float32Array(Math.min(this.cap, 1024));
	}

	private close(): void {
		if (this.n >= this.cap) return;
		if (this.n >= this.levels.length) {
			const next = new Float32Array(Math.min(this.cap, this.levels.length * 2));
			next.set(this.levels);
			this.levels = next;
		}
		const m = this.hopMax;
		this.levels[this.n++] = m > 0 ? Math.max(PRESENCE_FLOOR_DB, 10 * Math.log10(m)) : PRESENCE_FLOOR_DB;
		this.hopMax = 0;
		this.inHop = 0;
	}

	/** Feeds `frames` samples of every channel (missing channels are silence; non-finite samples count as 0). */
	push(planar: readonly Float32Array[], frames: number): void {
		const total = Math.max(0, Math.floor(fin(frames) ? frames : 0));
		const C = this.channels;
		const k = this.coeffs;
		const st = this.state;
		const w = this.window;
		for (let i = 0; i < total; i++) {
			// mean square over the channels of the band-passed signal
			let sq = 0;
			for (let c = 0; c < C; c++) {
				const ch = planar[c];
				const raw = ch && i < ch.length ? ch[i]! : 0;
				let x = raw - raw === 0 ? raw : 0;
				const b = c * 8;
				for (let q = 0; q < 4; q++) {
					const o = q * 5;
					const s1 = b + q * 2;
					const y = k[o]! * x + st[s1]!;
					st[s1] = k[o + 1]! * x - k[o + 3]! * y + st[s1 + 1]!;
					st[s1 + 1] = k[o + 2]! * x - k[o + 4]! * y;
					x = y;
				}
				sq += x * x;
			}
			sq /= C;
			this.sum += sq - this.ring[this.ringPos]!;
			this.ring[this.ringPos] = sq;
			this.ringPos = (this.ringPos + 1) % w;
			if (this.ringPos === 0) {
				// no drift over hours of audio: the running sum is recomputed once per window
				let s = 0;
				for (let j = 0; j < w; j++) s += this.ring[j]!;
				this.sum = s;
				for (let j = 0; j < st.length; j++) if (Math.abs(st[j]!) < 1e-30) st[j] = 0;
			}
			if (this.filled < w) this.filled++;
			// a 5 ms window (silence before the first sample)
			const ms = Math.max(0, this.sum) / w;
			if (ms > this.hopMax) this.hopMax = ms;
			if (++this.inHop === this.hop) this.close();
		}
	}

	/** Closes a partial hop and returns the per-hop presence levels (dB). */
	finish(): Float32Array {
		if (this.inHop > 0) this.close();
		return this.levels.slice(0, this.n);
	}
}

/** Largest presence level over hops `[from, to)` of a meter's levels (PRESENCE_FLOOR_DB when none). */
export function presencePeakDb(levels: ArrayLike<number>, from = 0, to = levels.length): number {
	let best = PRESENCE_FLOOR_DB;
	const a = Math.max(0, Math.floor(fin(from) ? from : 0));
	const b = Math.min(levels.length, Math.floor(fin(to) ? to : levels.length));
	for (let i = a; i < b; i++) {
		const v = levels[i]!;
		if (fin(v) && v > best) best = v;
	}
	return best;
}

/** Presence levels of a whole signal. */
export function presenceLevels(planar: readonly Float32Array[], sampleRate: number): Float32Array {
	const m = new PresenceMeter(sampleRate, Math.max(1, planar.length));
	m.push(planar, planar[0]?.length ?? 0);
	return m.finish();
}

/**
 * How much a sound's presence peak exceeds a reference's (dB) and whether that is harsh (`> overDb`). Null when either
 * is at the floor (nothing to judge: no reference stem, or a silent sound).
 */
export function harshExcess(
	soundPeakDb: number,
	referenceMaxDb: number,
	overDb: number,
): { overDb: number; harsh: boolean } | null {
	if (!fin(soundPeakDb) || !fin(referenceMaxDb)) return null;
	if (soundPeakDb <= PRESENCE_FLOOR_DB + 1 || referenceMaxDb <= PRESENCE_FLOOR_DB + 1) return null;
	const d = soundPeakDb - referenceMaxDb;
	return { overDb: Math.round(d * 10) / 10, harsh: d > overDb };
}
