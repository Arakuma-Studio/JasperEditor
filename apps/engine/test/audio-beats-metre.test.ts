// `POST /api/audio/beats` tempo octave and metre on a real engine (wp-note "Phase 6 → WP6.5b", item 10): a 150 BPM
// click WAV reads 150 (it used to read 75); a waltz WAV is detected in 3 (`beatsPerBar` 3, a downbeat per bar on its
// accent) with `timeSignature` 'auto' and 3, finds no 4/4 bar when forced to 4; each metre is cached separately; an
// invalid metre is a typed 400.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BeatsResultSchema } from '@jasper/api';
import { encodeWav } from '@jasper/audio-dsp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApps, makeApp, register, type TestApp } from './helpers.ts';

const HOST = { host: '127.0.0.1:47900' };
const JSON_H = { ...HOST, 'content-type': 'application/json' };
const SR = 48000;

let app: TestApp;
let keys: { fast: string; waltz: string };

/** Decaying 2 kHz clicks at `bpm` from 0.25 s; every `accentEvery`-th at 3× (0 = none). */
function clicks(file: string, bpm: number, seconds: number, accentEvery: number): number[] {
	const n = SR * seconds;
	const x = new Float32Array(n);
	const at: number[] = [];
	for (let k = 0; ; k++) {
		const t = 0.25 + (k * 60) / bpm;
		const s = Math.round(t * SR);
		if (s >= n) break;
		at.push(t);
		const amp = accentEvery > 0 && k % accentEvery === 0 ? 0.75 : 0.25;
		for (let i = 0; i < 0.03 * SR && s + i < n; i++)
			x[s + i] = amp * Math.exp(-i / (0.004 * SR)) * Math.sin((2 * Math.PI * 2000 * i) / SR);
	}
	writeFileSync(file, encodeWav([x, x], SR, 's16'));
	return at;
}

async function beats(body: Record<string, unknown>) {
	const r = await app.inject({
		method: 'POST',
		url: '/api/audio/beats',
		headers: JSON_H,
		payload: JSON.stringify(body),
	});
	return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, unknown> };
}

let waltzTimes: number[] = [];

describe('POST /api/audio/beats: tempo octave and metre', () => {
	beforeAll(async () => {
		app = await makeApp();
		const dir = mkdtempSync(join(tmpdir(), 'jasper-beats-'));
		clicks(join(dir, 'fast.wav'), 150, 12, 0);
		waltzTimes = clicks(join(dir, 'waltz.wav'), 120, 15, 3);
		keys = {
			fast: (await register(app, join(dir, 'fast.wav'))).mediaKey,
			waltz: (await register(app, join(dir, 'waltz.wav'))).mediaKey,
		};
	}, 120_000);
	afterAll(() => closeApps());

	it('a 150 BPM click reads 150 BPM, not 75', async () => {
		const r = await beats({ mediaKey: keys.fast, startSeconds: 0, durationSeconds: 12 });
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		const res = BeatsResultSchema.parse(r.body);
		expect(Math.abs(res.bpm! - 150)).toBeLessThan(1.5);
		expect(res.beats.length).toBeGreaterThanOrEqual(26);
		expect(res.downbeats).toBeNull();
		expect(res.beatsPerBar).toBeNull();
	}, 60_000);

	it('a waltz: 3 beats per bar detected, forced 3 the same, forced 4 no bar; metres cached apart; 400s', async () => {
		const auto = BeatsResultSchema.parse(
			(await beats({ mediaKey: keys.waltz, startSeconds: 0, durationSeconds: 15 })).body,
		);
		expect(Math.abs(auto.bpm! - 120)).toBeLessThan(1.5);
		expect(auto.beatsPerBar).toBe(3);
		const accented = waltzTimes.filter((_, k) => k % 3 === 0);
		expect(auto.downbeats!.length).toBeGreaterThanOrEqual(6);
		for (const d of auto.downbeats!)
			expect(Math.min(...accented.map((t) => Math.abs(t - d)))).toBeLessThan(0.006);
		const three = BeatsResultSchema.parse(
			(await beats({ mediaKey: keys.waltz, startSeconds: 0, durationSeconds: 15, timeSignature: 3 })).body,
		);
		expect(three.cached).toBe(false);
		expect(three.downbeats).toEqual(auto.downbeats);
		const four = BeatsResultSchema.parse(
			(await beats({ mediaKey: keys.waltz, startSeconds: 0, durationSeconds: 15, timeSignature: 4 })).body,
		);
		expect(four.cached).toBe(false);
		expect(four.downbeats).toBeNull();
		expect(four.beatsPerBar).toBe(4);
		const again = BeatsResultSchema.parse(
			(await beats({ mediaKey: keys.waltz, startSeconds: 0, durationSeconds: 15, timeSignature: 'auto' }))
				.body,
		);
		expect(again).toEqual({ ...auto, cached: true });
		for (const bad of [1, 13, 2.5, '3/4', null])
			expect(
				(await beats({ mediaKey: keys.waltz, startSeconds: 0, durationSeconds: 15, timeSignature: bad }))
					.status,
			).toBe(400);
	}, 60_000);
});
