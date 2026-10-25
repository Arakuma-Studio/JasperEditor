// The voice analysis contract (src/cleanup/voice-analysis.ts, spec 14 TC-001): building an analysis from feature
// planes (classes, windows, counts), the binary file round trip, the reader against hostile input (fast-check fuzz:
// random bytes, every single-byte change, truncations and extensions never throw and are refused or consistent),
// CRC-32 against zlib, and the summary / page helpers.
import { crc32 } from 'node:zlib';
import { VOICE_HOP, voiceFeatures } from '@jasper/audio-dsp';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	buildVoiceAnalysis,
	crc32Ieee,
	decodeVoiceAnalysis,
	encodeVoiceAnalysis,
	summarizeVoiceAnalysis,
	VOICE_ANALYSIS_FORMAT,
	VOICE_ANALYSIS_VERSION,
	VOICE_WINDOW_FRAMES,
	type VoiceAnalysis,
	voiceAnalysisFileBytes,
	voiceAnalysisPage,
	voiceFrameAt,
	voiceFrameSeconds,
	voiceRuns,
} from '../src/index.ts';

const FP = `q1:${'ab'.repeat(32)}`;
const SR = 16_000;

/** 2.5 min of a −70 dBFS floor with a 150 Hz harmonic tone (−20 dBFS) for 1 s every 5 s. */
function signal(seconds = 150): Float32Array {
	const n = seconds * SR;
	const x = new Float32Array(n);
	let s = 12345;
	for (let i = 0; i < n; i++) {
		s = (s * 1103515245 + 12345) >>> 0;
		x[i] = ((s / 2 ** 32) * 2 - 1) * 10 ** (-70 / 20) * Math.sqrt(3);
		const t = i / SR;
		if (t % 5 < 1) for (let h = 1; h < 10; h++) x[i]! += (0.1 / h) * Math.sin((2 * Math.PI * 150 * h * i) / SR);
	}
	return x;
}

function analysisOf(x: Float32Array): VoiceAnalysis {
	return buildVoiceAnalysis({ fingerprint: FP, stream: 1, samples: x.length, planes: voiceFeatures(x) });
}

const A = analysisOf(signal());
const FILE = encodeVoiceAnalysis(A);

describe('buildVoiceAnalysis', () => {
	it('classifies, counts and splits the levels into 60 s windows', () => {
		expect(A.format).toBe(VOICE_ANALYSIS_FORMAT);
		expect(A.analysisVersion).toBe(VOICE_ANALYSIS_VERSION);
		expect(A.frameCount).toBe(15_000);
		expect(A.counts.silence + A.counts.breath + A.counts.speech).toBe(A.frameCount);
		// 30 tones of ≈ 1 s
		expect(A.counts.speech).toBeGreaterThan(2900);
		expect(A.counts.speech).toBeLessThan(3200);
		expect(voiceRuns(A).filter((r) => r.cls === 'speech')).toHaveLength(30);
		expect(A.windows.map((w) => [w.startFrame, w.frameCount])).toEqual([
			[0, VOICE_WINDOW_FRAMES],
			[6000, 6000],
			[12_000, 3000],
		]);
		for (const w of A.windows) {
			expect(w.floorDb!).toBeLessThan(-65);
			expect(w.speechDb!).toBeGreaterThan(-35);
		}
		expect(A.levels.speechThresholdDb).toBeCloseTo(
			Math.max(A.levels.floorDb! + 0.3 * (A.levels.speechDb! - A.levels.floorDb!), A.levels.floorDb! + 6),
			10,
		);
	});

	it('handles empty and silent streams', () => {
		const empty = buildVoiceAnalysis({
			fingerprint: FP,
			stream: 0,
			samples: 0,
			planes: { level: new Uint8Array(0), voicing: new Uint8Array(0), flatness: new Uint8Array(0) },
		});
		expect(empty.frameCount).toBe(0);
		expect(empty.windows).toEqual([]);
		expect(empty.levels.floorDb).toBeNull();
		const back = decodeVoiceAnalysis(encodeVoiceAnalysis(empty));
		expect(back.ok).toBe(true);
		const silent = analysisOf(new Float32Array(SR * 2));
		expect(silent.levels).toEqual({ floorDb: null, speechDb: null, speechThresholdDb: null, breathFloorDb: null });
		expect(silent.counts.silence).toBe(200);
		expect(silent.windows[0]!.floorDb).toBeNull();
		expect(decodeVoiceAnalysis(encodeVoiceAnalysis(silent)).ok).toBe(true);
	});

	it('refuses planes that do not match the samples', () => {
		expect(() =>
			buildVoiceAnalysis({
				fingerprint: FP,
				stream: 0,
				samples: 1600,
				planes: { level: new Uint8Array(9), voicing: new Uint8Array(9), flatness: new Uint8Array(9) },
			}),
		).toThrow(RangeError);
	});
});

describe('the binary file', () => {
	it('round-trips exactly and is ≈ 4 bytes per frame', () => {
		const r = decodeVoiceAnalysis(FILE, { fingerprint: FP, stream: 1, analysisVersion: VOICE_ANALYSIS_VERSION });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect({ ...r.analysis }).toEqual({ ...A });
		expect(encodeVoiceAnalysis(r.analysis)).toEqual(FILE);
		const headerBytes = new DataView(FILE.buffer, FILE.byteOffset).getUint32(4, true);
		expect(FILE.length).toBe(voiceAnalysisFileBytes(A.frameCount, headerBytes));
		expect(FILE.length - 4 * A.frameCount).toBeLessThan(1000);
		// one hour: 360 000 frames ≈ 1.44 MB plus a header of 60 windows
		expect(voiceAnalysisFileBytes(360_000, 60 * 120)).toBeLessThan(1.45e6);
	});

	it('refuses a file of another media, stream or analysis version', () => {
		expect(decodeVoiceAnalysis(FILE, { fingerprint: `q1:${'cd'.repeat(32)}` })).toEqual({
			ok: false,
			error: 'fingerprint mismatch',
		});
		expect(decodeVoiceAnalysis(FILE, { stream: 2 }).ok).toBe(false);
		expect(decodeVoiceAnalysis(FILE, { analysisVersion: VOICE_ANALYSIS_VERSION + 1 }).ok).toBe(false);
	});

	it('CRC-32 is the IEEE one (zlib)', () => {
		fc.assert(
			fc.property(fc.uint8Array({ maxLength: 300 }), (b) => {
				expect(crc32Ieee(b)).toBe(crc32(b));
			}),
		);
	});

	it('encode refuses inconsistent analyses', () => {
		const bad = { ...A, counts: { ...A.counts, speech: A.counts.speech + 1 } };
		expect(() => encodeVoiceAnalysis(bad)).toThrow(RangeError);
		const badClass = { ...A, classes: A.classes.slice() };
		badClass.classes[5] = 7;
		expect(() => encodeVoiceAnalysis(badClass)).toThrow(RangeError);
	});
});

describe('decodeVoiceAnalysis against hostile input (fuzz)', () => {
	const small = encodeVoiceAnalysis(analysisOf(signal(5)));

	it('never throws on random bytes', () => {
		fc.assert(
			fc.property(fc.uint8Array({ maxLength: 4096 }), (b) => {
				const r = decodeVoiceAnalysis(b);
				expect(r.ok).toBe(false);
			}),
			{ numRuns: 500 },
		);
	});

	it('never throws on random bytes behind a valid magic and header length', () => {
		fc.assert(
			fc.property(fc.uint8Array({ maxLength: 2048 }), fc.integer({ min: 0, max: 2 ** 32 - 1 }), (b, hl) => {
				const f = new Uint8Array(8 + b.length);
				f.set([0x4a, 0x56, 0x41, 0x31]);
				new DataView(f.buffer).setUint32(4, hl, true);
				f.set(b, 8);
				expect(decodeVoiceAnalysis(f).ok).toBe(false);
			}),
			{ numRuns: 500 },
		);
	});

	it('refuses every single-byte change of a valid file (or decodes it consistently)', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: small.length - 1 }),
				fc.integer({ min: 1, max: 255 }),
				(at, xor) => {
					const f = small.slice();
					f[at]! ^= xor;
					const r = decodeVoiceAnalysis(f);
					// the CRC catches every single-byte change
					expect(r.ok).toBe(false);
				},
			),
			{ numRuns: 1000 },
		);
	});

	it('refuses truncated and extended files', () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: small.length - 1 }), (n) => {
				expect(decodeVoiceAnalysis(small.subarray(0, n)).ok).toBe(false);
			}),
			{ numRuns: 300 },
		);
		const longer = new Uint8Array(small.length + 3);
		longer.set(small);
		expect(decodeVoiceAnalysis(longer).ok).toBe(false);
	});

	it('refuses well-formed files with a header the schema rejects (with a valid CRC)', () => {
		const header = (h: Record<string, unknown>, planes: Uint8Array) => {
			const text = JSON.stringify(h);
			const f = new Uint8Array(8 + text.length + planes.length + 4);
			f.set([0x4a, 0x56, 0x41, 0x31]);
			const dv = new DataView(f.buffer);
			dv.setUint32(4, text.length, true);
			for (let i = 0; i < text.length; i++) f[8 + i] = text.charCodeAt(i);
			f.set(planes, 8 + text.length);
			dv.setUint32(f.length - 4, crc32Ieee(f.subarray(0, f.length - 4)), true);
			return f;
		};
		const ok = decodeVoiceAnalysis(small);
		if (!ok.ok) throw new Error(ok.error);
		const { level, voicing, flatness, classes, ...h } = ok.analysis;
		const planes = new Uint8Array(4 * h.frameCount);
		planes.set(level, 0);
		planes.set(voicing, h.frameCount);
		planes.set(flatness, 2 * h.frameCount);
		planes.set(classes, 3 * h.frameCount);
		expect(decodeVoiceAnalysis(header(h, planes)).ok).toBe(true);
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ ...h, frameCount: h.frameCount + 1 }, 'size'],
			[{ ...h, samples: h.samples + VOICE_HOP }, 'frameCount does not match'],
			[{ ...h, extra: 1 }, 'invalid header'],
			[{ ...h, frameStep: 100 }, 'invalid header'],
			[{ ...h, levels: { ...h.levels, floorDb: Number.MAX_VALUE } }, 'invalid header'],
			[{ ...h, counts: { ...h.counts, speech: h.counts.speech + 1 } }, 'class counts'],
			[{ ...h, windows: [] }, 'windows'],
			[{ ...h, windows: [{ ...h.windows[0]!, startFrame: 3 }] }, 'window 0 start'],
		];
		for (const [bad, why] of cases) {
			const r = decodeVoiceAnalysis(header(bad, planes));
			expect(r.ok, why).toBe(false);
			if (!r.ok) expect(r.error).toContain(why);
		}
		const badClasses = planes.slice();
		badClasses[3 * h.frameCount + 2] = 3;
		const r = decodeVoiceAnalysis(header(h, badClasses));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain('invalid class');
	});
});

describe('summary and pages', () => {
	it('summarizes classes, runs and windows', () => {
		const s = summarizeVoiceAnalysis(A);
		expect(s.durationSeconds).toBe(150);
		expect(s.frameCount).toBe(15_000);
		expect(s.runs.speech).toBe(30);
		expect(s.seconds.speech + s.seconds.breath + s.seconds.silence).toBeCloseTo(150, 6);
		expect(s.longestSeconds.speech).toBeGreaterThan(0.95);
		expect(s.longestSeconds.speech).toBeLessThan(1.1);
		expect(s.windows).toHaveLength(3);
		expect(s.windows[2]).toMatchObject({ startSeconds: 120, seconds: 30 });
	});

	it('pages frames with the loudest level, mean features and majority class per point', () => {
		const p = voiceAnalysisPage(A, { fromFrame: 450, frames: 200, step: 10 });
		expect(p.fromFrame).toBe(450);
		expect(p.toFrame).toBe(650);
		expect(p.times).toHaveLength(20);
		expect(p.times[0]).toBe(4.5);
		// 4.5–5 s silence, 5–6 s tone
		expect(p.classes.slice(0, 4)).toEqual(['silence', 'silence', 'silence', 'silence']);
		expect(p.classes.slice(6, 14).every((c) => c === 'speech')).toBe(true);
		expect(p.levelDb[10]!).toBeGreaterThan(-30);
		expect(p.runs[0]).toMatchObject({ cls: 'silence', start: 4.5 });
		expect(p.runs.some((r) => r.cls === 'speech' && Math.abs(r.start - 5) < 0.05)).toBe(true);
		// clamped to the analysis
		const end = voiceAnalysisPage(A, { fromFrame: 14_990, frames: 500, step: 3 });
		expect(end.toFrame).toBe(15_000);
		expect(end.times).toHaveLength(4);
		expect(voiceAnalysisPage(A, { fromFrame: Number.NaN, frames: -5, step: 0 }).times).toEqual([]);
	});

	it('maps frames and seconds', () => {
		expect(voiceFrameSeconds(150)).toBe(1.5);
		expect(voiceFrameAt(A, 1.505)).toBe(150);
		expect(voiceFrameAt(A, -1)).toBe(0);
		expect(voiceFrameAt(A, 1e9)).toBe(14_999);
		expect(voiceFrameAt({ frameCount: 0 }, 3)).toBe(0);
	});
});
