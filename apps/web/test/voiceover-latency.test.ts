// WP0.1 (spec 12 Phase 0): voice-over takes are placed compensating the round-trip latency (Program monitor output
// latency + input device latency + the user's offset). Simulation of a recording: the talent claps exactly when they
// hear the record point; the clap must land at the start of the take within one capture buffer.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseAudioPrefs } from '../src/audio/prefs.ts';
import {
	assembleTake,
	captureSampleAt,
	type FramePair,
	takeRange,
	voiceoverLatencySeconds,
} from '../src/audio/voiceover.ts';

const SR = 48000;
const FPS = { num: 30, den: 1 };

type Sim = {
	/** Playback (Program monitor) output latency and input device latency, seconds. */
	outputLatency: number;
	inputLatency: number;
	/** Capture callback buffer (the capture clock advances in these steps), samples. */
	buffer: number;
	/** Display refresh (frame reports arrive at the next animation frame), seconds. */
	raf: number;
	seed: number;
	captureFrame: number;
	recordFrame: number;
	endFrame: number;
	firstSample: number;
};

function rng(seed: number) {
	let x = seed >>> 0 || 1;
	return () => {
		x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
		return x / 2 ** 32;
	};
}

/**
 * Wall time 0 = playback of `captureFrame` starts and the capture tap's first sample (`firstSample`) is processed.
 * Frame f is rendered at (f − captureFrame)/fps and heard `outputLatency` later. A transport report of f arrives up to one
 * animation frame late; the recorder pairs it with the capture clock read then (quantised to `buffer`). The clap the
 * talent makes on hearing the record point reaches the capture stream `inputLatency` later.
 */
function simulate(s: Sim) {
	const r = rng(s.seed);
	const fps = FPS.num / FPS.den;
	const spf = (SR * FPS.den) / FPS.num;
	const capturePos = (samples: number) => Math.floor(samples / s.buffer) * s.buffer;
	const pairs: FramePair[] = [];
	for (let f = s.captureFrame; f <= s.endFrame; f++)
		pairs.push({ frame: f, sample: capturePos((f - s.captureFrame) * spf + r() * s.raf * SR) });
	const heard = (s.recordFrame - s.captureFrame) / fps + s.outputLatency;
	const clap = Math.round((heard + s.inputLatency) * SR);
	const total = Math.ceil(((s.endFrame - s.captureFrame) / fps + 1) * SR);
	const chunks: { start: number; channels: Float32Array[] }[] = [];
	for (let at = 0; at < total; at += 4080) {
		const ch = new Float32Array(Math.min(4080, total - at));
		if (clap >= at && clap < at + ch.length) ch[clap - at] = 1;
		chunks.push({ start: s.firstSample + at, channels: [ch] });
	}
	return { pairs, chunks };
}

function clapIndex(take: Float32Array): number {
	return take.indexOf(1);
}

function record(s: Sim, latency: number) {
	const { pairs, chunks } = simulate(s);
	const range = takeRange(pairs, s.recordFrame, s.endFrame, FPS, SR, latency)!;
	// a clap before the take start is not in the take: look a little earlier too
	const wide = assembleTake(chunks, s.firstSample, range.start - SR, range.length + SR, 0);
	return clapIndex(wide) - SR;
}

const base: Sim = {
	outputLatency: 0.04,
	inputLatency: 0.025,
	buffer: 480,
	raf: 1 / 60,
	seed: 1,
	captureFrame: 40,
	recordFrame: 100,
	endFrame: 160,
	firstSample: 123_456,
};

describe('voice-over latency compensation', () => {
	it('without jitter the clap lands on the record point (±1 sample)', () => {
		// every reading is then an exact multiple of the frame length (1600 samples): no clock step to undo
		const s = { ...base, buffer: 1, raf: 0 };
		const lat = voiceoverLatencySeconds({
			playback: { baseLatency: 0.01, outputLatency: 0.03 },
			inputLatency: 0.025,
		});
		expect(lat).toBeCloseTo(0.065, 9);
		expect(Math.abs(record(s, lat))).toBeLessThanOrEqual(1);
	});

	it('simulated input latency: aligned within one capture buffer; uncompensated it is not', () => {
		const lat = voiceoverLatencySeconds({
			playback: { baseLatency: 0.01, outputLatency: 0.03 },
			inputLatency: base.inputLatency,
		});
		expect(Math.abs(record(base, lat))).toBeLessThanOrEqual(base.buffer);
		// before WP0.1 the input latency was ignored: the take started 25 ms (1200 samples) early
		const before = voiceoverLatencySeconds({ capture: { baseLatency: 0.01, outputLatency: 0.03 } });
		expect(Math.abs(record(base, before))).toBeGreaterThan(base.buffer);
	});

	it('any latency, buffer and report jitter: within one buffer (property)', () => {
		fc.assert(
			fc.property(
				fc.record({
					outputLatency: fc.double({ min: 0, max: 0.2, noNaN: true }),
					inputLatency: fc.double({ min: 0, max: 0.1, noNaN: true }),
					buffer: fc.constantFrom(256, 480, 512, 1024),
					raf: fc.constantFrom(1 / 60, 1 / 120),
					seed: fc.nat(),
					recordFrame: fc.integer({ min: 60, max: 400 }),
				}),
				(o) => {
					const s: Sim = { ...base, ...o, captureFrame: o.recordFrame - 60, endFrame: o.recordFrame + 60 };
					const lat = voiceoverLatencySeconds({
						playback: { outputLatency: o.outputLatency },
						inputLatency: o.inputLatency,
					});
					expect(Math.abs(record(s, lat))).toBeLessThanOrEqual(s.buffer);
				},
			),
			{ numRuns: 300 },
		);
	});

	it('a late frame report (stall) does not shift the take (lower envelope of the pairs around the frame)', () => {
		const { pairs } = simulate({ ...base, raf: 0, buffer: 1 });
		const stalled = pairs.map((p) => (p.frame === 100 ? { ...p, sample: p.sample + 24_000 } : p));
		expect(captureSampleAt(stalled, 100, FPS, SR)).toBe(captureSampleAt(pairs, 100, FPS, SR));
	});

	it('the user offset and the capture-context fallback; hostile values count as 0', () => {
		expect(voiceoverLatencySeconds({ capture: { baseLatency: 0.005, outputLatency: 0.02 } })).toBeCloseTo(0.025, 9);
		expect(
			voiceoverLatencySeconds({ playback: { outputLatency: 0.02 }, capture: { outputLatency: 0.5 }, offsetMs: -5 }),
		).toBeCloseTo(0.015, 9);
		expect(
			voiceoverLatencySeconds({
				playback: { baseLatency: Number.NaN, outputLatency: Number.POSITIVE_INFINITY },
				inputLatency: '0.2',
				offsetMs: Number.NaN,
			}),
		).toBe(0);
		expect(voiceoverLatencySeconds({ inputLatency: -1, offsetMs: 1e9 })).toBe(1);
		expect(captureSampleAt([], 10, FPS, SR)).toBeNull();
		expect(captureSampleAt([{ frame: 0, sample: 0 }], 10, { num: 0, den: 1 }, SR)).toBeNull();
		expect(takeRange([], 0, 10, FPS, SR, 0)).toBeNull();
		expect(assembleTake([{ start: 0, channels: [] }], 0, 0, 4, 3)).toEqual(new Float32Array(4));
	});

	it('the Latency Offset preference parses tolerantly (−500 … 500 ms, default 0)', () => {
		expect(parseAudioPrefs({}).voiceOver.latencyOffsetMs).toBe(0);
		expect(parseAudioPrefs({ voiceOver: { latencyOffsetMs: 12.4 } }).voiceOver.latencyOffsetMs).toBe(12);
		expect(parseAudioPrefs({ voiceOver: { latencyOffsetMs: -9999 } }).voiceOver.latencyOffsetMs).toBe(-500);
		expect(parseAudioPrefs({ voiceOver: { latencyOffsetMs: 'x' } }).voiceOver.latencyOffsetMs).toBe(0);
	});
});
