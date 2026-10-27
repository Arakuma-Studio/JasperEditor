// Listening transcript events (spec 12 §4 P6-E6; wp-note "Phase 6 → WP-E3"): onsets refined to the attack within 1 ms,
// the band and prominence over the bed, swells, silences, accents, the spectrogram, block-size and chunk independence,
// the sync ladder and chance levels against a brute-force computation, and hostile input that never throws.
import { LoudnessMeter } from '@jasper/audio-dsp';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Prng } from '../src/core/util.ts';
import {
	accentThreshold,
	analyzeSound,
	answerPictureEvent,
	integratedOf,
	LISTEN_EVENTS,
	type ListenAnalysis,
	type ListenEvent,
	ListenMeter,
	syncChance,
	syncIndex,
	syncStats,
} from '../src/index.ts';

const SR = 48_000;

function feed(meter: ListenMeter, planar: Float32Array[], block: number): ListenAnalysis {
	const n = planar[0]!.length;
	for (let i = 0; i < n; i += block) {
		const k = Math.min(block, n - i);
		meter.push(
			planar.map((c) => c.subarray(i, i + k)),
			k,
		);
	}
	return meter.finish();
}
const analyse = (x: Float32Array, block = 4800, opts: { spectrogram?: boolean } = {}) =>
	feed(new ListenMeter(SR, 1, opts), [x], block);

function whiteNoise(n: number, rms: number, seed: number): Float32Array {
	const r = new Prng(seed);
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) out[i] = r.uniform() * rms * Math.sqrt(3);
	return out;
}
/** One-pole low-passed noise (a dark bed). */
function darkNoise(n: number, rms: number, seed: number, coeff = 0.01): Float32Array {
	const w = whiteNoise(n, 1, seed);
	const out = new Float32Array(n);
	let y = 0;
	let e = 0;
	for (let i = 0; i < n; i++) {
		y += coeff * (w[i]! - y);
		out[i] = y;
		e += y * y;
	}
	const g = rms / Math.sqrt(e / n);
	for (let i = 0; i < n; i++) out[i]! *= g;
	return out;
}
/** First difference of white noise (a bright bed). */
function brightNoise(n: number, rms: number, seed: number): Float32Array {
	const w = whiteNoise(n + 1, 1, seed);
	const out = new Float32Array(n);
	let e = 0;
	for (let i = 0; i < n; i++) {
		out[i] = w[i + 1]! - w[i]!;
		e += out[i]! * out[i]!;
	}
	const g = rms / Math.sqrt(e / n);
	for (let i = 0; i < n; i++) out[i]! *= g;
	return out;
}
/** Adds a sound starting exactly at sample `at`. */
function addHit(x: Float32Array, at: number, kind: 'click' | 'thump' | 'burst', amp: number, seed = 1): void {
	const r = new Prng(seed);
	const len = Math.round((kind === 'thump' ? 0.4 : 0.2) * SR);
	for (let i = 0; i < len && at + i < x.length; i++) {
		const t = i / SR;
		const v =
			kind === 'click'
				? Math.sin(2 * Math.PI * 6000 * t) * Math.exp(-t / 0.01)
				: kind === 'thump'
					? Math.sin(2 * Math.PI * 60 * t) * Math.exp(-t / 0.15)
					: r.uniform() * Math.exp(-t / 0.05);
		x[at + i]! += amp * v;
	}
}
const hits = (a: ListenAnalysis) => a.events.filter((e) => e.shape === 'hit');
const near = (a: ListenAnalysis, ms: number, tol: number) =>
	hits(a).filter((e) => Math.abs(e.ms - ms) <= tol);

describe('onsets', () => {
	it('finds each hit at its attack within 1 ms, in silence and over a bed', () => {
		const n = 4 * SR;
		const silent = new Float32Array(n);
		const bed = whiteNoise(n, 0.003, 7);
		const at = [0.5, 1.3337, 2.1, 3.05].map((s) => Math.round(s * SR));
		for (const [k, x] of [silent, bed].entries()) {
			at.forEach((a, i) => {
				addHit(x, a, (['click', 'thump', 'burst', 'click'] as const)[i]!, 0.3, i + k);
			});
			const r = analyse(x);
			for (const a of at) {
				const ms = (a / SR) * 1000;
				const found = near(r, ms, 1);
				expect(found, `hit at ${ms} ms in ${JSON.stringify(hits(r).map((e) => e.ms))}`).toHaveLength(1);
				expect(found[0]!.peakMs).toBeGreaterThanOrEqual(found[0]!.ms);
				expect(found[0]!.peakDb).toBeGreaterThan(-15);
				expect(found[0]!.lengthMs).toBeGreaterThan(5);
			}
			// nothing else stands out: noise flicker in the bed may read as an onset, never as a rise of the level (inner
			// onsets of a decaying noise burst, within its 200 ms, are its own)
			const others = hits(r).filter(
				(e) => !at.some((a) => e.ms - (a / SR) * 1000 >= -40 && e.ms - (a / SR) * 1000 <= 200),
			);
			expect(others.filter((e) => e.prominenceDb >= 3 || e.accent)).toEqual([]);
		}
	});

	it("puts an event's peak where the sound descriptors put it (the point placement aligns)", () => {
		// a whoosh: noise swelling over 300 ms and falling over 200 ms, and a crunch: bursts in a decaying tail
		const whoosh = whiteNoise(Math.round(0.6 * SR), 1, 31);
		for (let i = 0; i < whoosh.length; i++) {
			const t = i / SR;
			whoosh[i]! *= 0.4 * (t < 0.3 ? (t / 0.3) ** 2 : Math.max(0, 1 - (t - 0.3) / 0.2));
		}
		const crunch = whiteNoise(Math.round(0.5 * SR), 1, 32);
		for (let i = 0; i < crunch.length; i++) {
			const t = i / SR;
			crunch[i]! *= 0.5 * Math.exp(-t / 0.08) * (1 + 0.8 * Math.sin(2 * Math.PI * 23 * t));
		}
		for (const sound of [whoosh, crunch]) {
			const peakSec = analyzeSound([sound], SR).peakSec;
			const x = new Float32Array(3 * SR);
			const at = SR;
			x.set(sound, at);
			const events = hits(analyse(x));
			const ev = events.find((e) => e.ms >= 990 && e.ms <= 1000 + peakSec * 1000);
			expect(ev, JSON.stringify(events)).toBeDefined();
			expect(Math.abs(ev!.peakMs - (1000 + peakSec * 1000))).toBeLessThanOrEqual(1);
		}
	});

	it('names the band the event stands out in', () => {
		const n = 3 * SR;
		const dark = darkNoise(n, 0.02, 3);
		addHit(dark, SR, 'click', 0.05);
		const click = near(analyse(dark), 1000, 1)[0];
		expect(click?.band).toBe('high');
		const bright = brightNoise(n, 0.02, 4);
		addHit(bright, SR, 'thump', 0.2);
		const thump = near(analyse(bright), 1000, 2)[0];
		expect(thump?.band).toBe('low');
	});

	it('measures prominence over the K-weighted bed (and the bed in LUFS)', () => {
		const n = 3 * SR;
		const bedRms = 0.01;
		const x = whiteNoise(n, bedRms, 11);
		const burst = whiteNoise(Math.round(0.3 * SR), bedRms * 10, 12);
		const at = Math.round(1.5 * SR);
		for (let i = 0; i < burst.length; i++) x[at + i]! += burst[i]!;
		const ev = near(analyse(x), 1500, 2)[0]!;
		expect(ev).toBeDefined();
		// +20 dB of uncorrelated noise over the bed: 10·log10(1 + 100) ≈ 20 dB
		expect(ev.prominenceDb).toBeGreaterThan(18);
		expect(ev.prominenceDb).toBeLessThan(23);
		const meter = new LoudnessMeter(SR, 1);
		meter.process([whiteNoise(n, bedRms, 11)]);
		expect(Math.abs(ev.bedDb - meter.integrated())).toBeLessThan(1.5);
	});

	it('is block-size independent and finds events across chunk boundaries once', () => {
		const n = 3 * SR;
		const x = whiteNoise(n, 0.002, 5);
		for (const [i, s] of [0.4, 1.0, 1.9, 2.5].entries()) addHit(x, Math.round(s * SR), 'burst', 0.2, i);
		const ref = JSON.stringify(analyse(x, n).events);
		for (const block of [1, 97, 4800]) expect(JSON.stringify(analyse(x, block).events)).toBe(ref);
		// a 70 s stem: hits on and around the 30 s analysis chunks
		const long = whiteNoise(70 * SR, 0.002, 6);
		const times = [10, 29.995, 30.05, 59.99, 60.4, 69];
		times.forEach((s, i) => {
			addHit(long, Math.round(s * SR), 'click', 0.3, i);
		});
		const r = analyse(long, 48_000);
		for (const s of times) expect(near(r, s * 1000, 1), `${s} s`).toHaveLength(1);
		expect(hits(r).filter((e) => e.prominenceDb >= 10)).toHaveLength(times.length);
		expect(r.events.every((e, i, a) => i === 0 || a[i - 1]!.ms <= e.ms)).toBe(true);
	});
});

describe('swells, silences, accents, loudness', () => {
	it('times a build-up at its peak', () => {
		const n = 4 * SR;
		const x = new Float32Array(n);
		const w = whiteNoise(n, 1, 9);
		for (let i = 0; i < n; i++) {
			const t = i / SR;
			let db = -70;
			if (t >= 1 && t < 2.2)
				db = -60 + ((t - 1) / 1.2) * 45; // −60 → −15 dBFS over 1.2 s
			else if (t >= 2.2 && t < 2.3) db = -15 - ((t - 2.2) / 0.1) * 45;
			x[i] = w[i]! * 10 ** (db / 20);
		}
		const r = analyse(x);
		const swells = r.events.filter((e) => e.shape === 'swell');
		const s = swells.find((e) => Math.abs(e.ms - 2200) <= 60);
		expect(s, JSON.stringify(swells)).toBeDefined();
		expect(s!.prominenceDb).toBeGreaterThanOrEqual(LISTEN_EVENTS.swellRiseDb);
		expect(s!.riseMs).toBeGreaterThanOrEqual(250);
		expect(s!.riseMs).toBeLessThanOrEqual(2000);
	});

	it('finds a digital silence and a drop, with the integrated loudness', () => {
		const n = 6 * SR;
		const x = whiteNoise(n, 0.03, 13);
		for (let i = Math.round(2 * SR); i < Math.round(2.8 * SR); i++) x[i] = 0;
		for (let i = Math.round(4 * SR); i < Math.round(4.6 * SR); i++) x[i]! *= 10 ** (-28 / 20);
		const r = analyse(x);
		const meter = new LoudnessMeter(SR, 1);
		meter.process([x]);
		expect(r.integratedLufs).not.toBeNull();
		expect(Math.abs(r.integratedLufs! - meter.integrated())).toBeLessThan(0.3);
		const dig = r.silences.find((s) => s.kind === 'digital silence');
		expect(dig, JSON.stringify(r.silences)).toBeDefined();
		expect(Math.abs(dig!.startMs - 2000)).toBeLessThanOrEqual(60);
		expect(Math.abs(dig!.endMs - 2800)).toBeLessThanOrEqual(60);
		const drop = r.silences.find((s) => s.startMs > 3500);
		expect(drop?.kind).toBe('drop');
		expect(Math.abs(drop!.startMs - 4000)).toBeLessThanOrEqual(80);
	});

	it('marks the top 20 % by prominence that are ≥ 6 dB over the bed as accents', () => {
		const ev = (p: number) => ({ prominenceDb: p });
		expect(accentThreshold([])).toBeNull();
		expect(accentThreshold([1, 2, 3, 4, 5].map(ev))).toBe(6);
		expect(accentThreshold([0, 10, 20, 30, 40].map(ev))).toBe(32);
		const n = 6 * SR;
		const x = whiteNoise(n, 0.002, 21);
		[0.5, 1.5, 2.5, 3.5, 4.5].forEach((s, i) => {
			addHit(x, Math.round(s * SR), 'burst', 0.02 * (i + 1), i);
		});
		const r = analyse(x);
		expect(r.accentDb).not.toBeNull();
		for (const e of r.events) expect(e.accent).toBe(e.prominenceDb >= r.accentDb!);
		expect(r.events.filter((e) => e.accent).length).toBeGreaterThan(0);
	});

	it('draws a log-frequency spectrogram, 10 ms × 96 bands', () => {
		const n = SR;
		const x = new Float32Array(n);
		for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR);
		const s = analyse(x, 4800, { spectrogram: true }).spectrogram!;
		expect(s.bands).toBe(96);
		expect(Math.abs(s.frames - 100)).toBeLessThanOrEqual(2);
		expect(s.data.length).toBe(s.frames * s.bands);
		const col = s.data.subarray(50 * s.bands, 51 * s.bands);
		let best = 0;
		for (let b = 0; b < s.bands; b++) if (col[b]! > col[best]!) best = b;
		const centre = s.fMinHz * (s.fMaxHz / s.fMinHz) ** ((best + 1) / (s.bands + 1));
		expect(Math.abs(Math.log2(centre / 1000))).toBeLessThan(1 / 3);
		expect(col[best]).toBeGreaterThan(200);
		expect(analyse(x).spectrogram).toBeNull();
	});

	it('integratedOf gates silence and returns null when everything is gated out', () => {
		expect(integratedOf(new Float64Array(100), 480)).toBeNull();
		expect(integratedOf([], 480)).toBeNull();
		const e = 10 ** ((-20 + 0.691) / 10) * 480;
		expect(integratedOf(new Float64Array(200).fill(e), 480)).toBeCloseTo(-20, 6);
	});
});

describe('sync', () => {
	const mk = (ms: number, o: Partial<ListenEvent> = {}): ListenEvent => ({
		ms,
		peakMs: ms,
		shape: 'hit',
		band: 'full',
		prominenceDb: 10,
		bedDb: -30,
		contrastDb: 10,
		z: 5,
		lengthMs: 50,
		peakDb: -10,
		accent: false,
		...o,
	});

	it('answers a picture event with the ladder: OK, near, swell, none', () => {
		const events = [
			mk(1000),
			mk(2070, { prominenceDb: 1 }),
			mk(2090, { prominenceDb: 12 }),
			mk(3250, { shape: 'swell' }),
			mk(4200, { prominenceDb: 12 }),
		];
		const ix = syncIndex(events);
		expect(answerPictureEvent(ix, 1020, 33.3)).toMatchObject({
			status: 'ok',
			event: 0,
			offsetMs: -20,
			at: 'attack',
		});
		// near prefers the strong onset over a closer weak one
		expect(answerPictureEvent(ix, 2000, 33.3)).toMatchObject({ status: 'near', event: 2, offsetMs: 90 });
		expect(answerPictureEvent(ix, 3000, 33.3)).toMatchObject({ status: 'swell', event: 3, offsetMs: 250 });
		expect(answerPictureEvent(ix, 4000, 33.3)).toMatchObject({
			status: 'none',
			event: null,
			offsetMs: null,
			nearestStrongMs: 200,
		});
		expect(answerPictureEvent(ix, 9000, 33.3)).toMatchObject({ status: 'none', nearestStrongMs: null });
		expect(answerPictureEvent(syncIndex([]), 0, 40).status).toBe('none');
		// a whoosh answers its cut at its peak, long after its attack
		const whoosh = syncIndex([mk(1000, { peakMs: 1450 })]);
		expect(answerPictureEvent(whoosh, 1450, 33.3)).toMatchObject({
			status: 'ok',
			event: 0,
			offsetMs: 0,
			at: 'peak',
		});
		expect(answerPictureEvent(whoosh, 1010, 33.3)).toMatchObject({
			status: 'ok',
			offsetMs: -10,
			at: 'attack',
		});
		// the flicker of a bed (no rise of the level) answers nothing
		expect(answerPictureEvent(syncIndex([mk(1000, { prominenceDb: 2.9 })]), 1000, 40).status).toBe('none');
	});

	it('chance equals a brute-force count of random times', () => {
		fc.assert(
			fc.property(
				fc.array(fc.double({ min: -500, max: 10_500, noNaN: true }), { maxLength: 40 }),
				fc.double({ min: 0.5, max: 400, noNaN: true }),
				(ts, tol) => {
					const lo = 0;
					const hi = 10_000;
					const step = 0.05;
					let hit = 0;
					let total = 0;
					for (let t = lo; t < hi; t += step) {
						total++;
						if (ts.some((x) => Math.abs(x - t) <= tol)) hit++;
					}
					const brute = hit / total;
					const exact = syncChance(ts, lo, hi, tol);
					expect(Math.abs(exact - brute)).toBeLessThanOrEqual(
						((2 * ts.length + 2) * step) / (hi - lo) + 1e-9,
					);
				},
			),
			{ numRuns: 60 },
		);
		expect(syncChance([], 0, 1000, 10)).toBe(0);
		expect(syncChance([500], 0, 1000, 10)).toBeCloseTo(0.02, 9);
		expect(syncChance([500, 505], 0, 1000, 10)).toBeCloseTo(0.025, 9);
		expect(syncChance([0, 1000], 0, 1000, 2000)).toBe(1);
	});

	it('reports shares with their chance levels and on-beat stats', () => {
		const events = [mk(1000, { accent: true }), mk(2000), mk(3030), mk(6000)];
		const ix = syncIndex(events);
		const times = [1000, 2010, 3000, 4500];
		const answers = times.map((t) => answerPictureEvent(ix, t, 33.3));
		const s = syncStats(ix, times, answers, 33.3, [1000, 1500, 2000, 2500, 3000, 3500])!;
		expect(s).toMatchObject({ n: 4, ok: 3, near: 0, none: 1, okShare: 0.75, within100Share: 0.75 });
		const all = events.map((e) => e.ms);
		expect(s.okChance).toBeCloseTo(syncChance(all, 0, 5500, 33.3), 3);
		expect(s.within100Chance).toBeCloseTo(syncChance(all, 0, 5500, 100), 3);
		expect(s.accentOkShare).toBe(0.25);
		expect(s.accentOkChance).toBeCloseTo(syncChance([1000], 0, 5500, 33.3), 3);
		expect(s.onBeatShare).toBe(0.75);
		expect(s.onBeatChance).toBeCloseTo(syncChance([1000, 1500, 2000, 2500, 3000, 3500], 0, 5500, 50), 3);
		expect(s.medianAbsOffsetMs).toBe(10);
		expect(syncStats(ix, [], [], 33.3)).toBeNull();
	});
});

describe('hostile input', () => {
	it('never throws and stays finite', () => {
		fc.assert(
			fc.property(
				fc.oneof(fc.constant(Number.NaN), fc.constant(0), fc.constant(1e9), fc.double()),
				fc.integer({ min: -2, max: 9 }),
				fc.array(fc.oneof(fc.double(), fc.constant(Number.NaN), fc.constant(Number.POSITIVE_INFINITY)), {
					maxLength: 3000,
				}),
				fc.integer({ min: 0, max: 3 }),
				(sr, channels, xs, give) => {
					const m = new ListenMeter(sr, channels, { spectrogram: true, maxSeconds: 5 });
					const planar = Array.from({ length: give }, () => Float32Array.from(xs));
					m.push(planar, xs.length + 7);
					m.push([], 100);
					const r = m.finish();
					expect(m.finish()).toBe(r);
					for (const e of r.events)
						for (const v of Object.values(e))
							if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
					expect(JSON.stringify(r.silences)).not.toContain('null');
				},
			),
			{ numRuns: 150 },
		);
	});

	it('handles one sample, DC and long silence', () => {
		const one = analyse(Float32Array.of(0.5));
		expect(one.events).toEqual([]);
		expect(one.integratedLufs).toBeNull();
		const dc = analyse(new Float32Array(2 * SR).fill(0.5));
		expect(hits(dc).length).toBeLessThanOrEqual(1);
		const quiet = analyse(new Float32Array(40 * SR), 48_000);
		expect(quiet.events).toEqual([]);
		expect(quiet.silences).toHaveLength(1);
		expect(quiet.silences[0]).toMatchObject({ kind: 'digital silence', atStart: true, atEnd: true });
		const capped = new ListenMeter(SR, 1, { maxSeconds: 1 });
		capped.push([new Float32Array(2 * SR)], 2 * SR);
		expect(capped.finish()).toMatchObject({ truncated: true, samples: SR });
	});
});
