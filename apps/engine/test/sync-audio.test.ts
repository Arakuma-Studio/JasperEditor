// POST /api/sync/audio end to end (wp-multicam): real ffmpeg decodes, two-pass GCC-PHAT in the engine. Recordings of
// one synthetic "event" with known offsets: a WAV reference, a camera MP4 (AAC, starts 3.25 s into the event, quieter,
// noisy), a recorder WAV that started 1.5 s before the reference with inverted polarity, an unrelated recording.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type SyncAudioResponse, SyncAudioResponseSchema } from '@jasper/api';
import { encodeWav } from '@jasper/audio-dsp';
import { FLICKS_PER_SECOND } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApps, JSON_H, makeApp, register, type TestApp, tempAppdir } from './helpers.ts';

const SR = 48_000;

function rng(seed: number): () => number {
	let s = (seed * 2654435761) >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		return (s / 0x1_0000_0000) * 2 - 1;
	};
}

/** Speech-like bursts: harmonics of a gliding pitch, noise consonants, pauses. */
function event(secs: number, seed: number): Float32Array {
	const n = Math.floor(SR * secs);
	const r = rng(seed);
	const out = new Float32Array(n);
	let i = 0;
	while (i < n) {
		const len = Math.floor((0.08 + 0.25 * (r() * 0.5 + 0.5)) * SR);
		const kind = r();
		const f0 = 110 + 120 * (r() * 0.5 + 0.5);
		const amp = 0.2 + 0.3 * (r() * 0.5 + 0.5);
		for (let k = 0; k < Math.min(len, n - i); k++) {
			const env = Math.sin((Math.PI * k) / len);
			let v = 0;
			if (kind > 0.3) for (let h = 1; h < 8; h++) v += Math.sin((2 * Math.PI * f0 * h * k) / SR) / h;
			else if (kind > -0.4) v = r();
			out[i + k] = v * env * amp * 0.4;
		}
		i += len + Math.floor((r() * 0.5 + 0.5) * 0.15 * SR);
	}
	return out;
}

/** `src` from `startSec` for `secs`, × gain, + white noise (zero before the event). */
function take(src: Float32Array, startSec: number, secs: number, gain: number, noise: number, seed: number) {
	const out = new Float32Array(Math.floor(secs * SR));
	const r = rng(seed);
	const s0 = Math.round(startSec * SR);
	for (let i = 0; i < out.length; i++) {
		const j = s0 + i;
		out[i] = (j >= 0 && j < src.length ? src[j]! * gain : 0) + r() * noise;
	}
	return out;
}

let app: TestApp;
const keys: Record<string, string> = {};

beforeAll(async () => {
	const dir = tempAppdir('jasper-sync-');
	const src = event(40, 3);
	const wav = (name: string, x: Float32Array) => {
		const p = join(dir, name);
		writeFileSync(p, encodeWav([x, x], SR, 's16'));
		return p;
	};
	const ref = wav('ref.wav', take(src, 5, 25, 1, 0.002, 1));
	const camAudio = wav('cam-audio.wav', take(src, 8.25, 20, 0.3, 0.01, 2));
	const cam = join(dir, 'cam.mp4');
	const r = spawnSync(
		'ffmpeg',
		[
			'-hide_banner',
			'-loglevel',
			'error',
			'-f',
			'lavfi',
			'-i',
			'testsrc2=size=320x180:rate=30',
			'-i',
			camAudio,
			'-shortest',
			'-c:v',
			'mpeg4',
			'-c:a',
			'aac',
			'-b:a',
			'192k',
			'-y',
			cam,
		],
		{ stdio: 'inherit' },
	);
	if (r.status !== 0) throw new Error('ffmpeg failed');
	const recorder = wav('recorder.wav', take(src, 3.5, 30, -0.8, 0.005, 3));
	const other = wav('other.wav', take(event(25, 99), 0, 25, 1, 0.002, 4));
	app = await makeApp();
	for (const [k, p] of Object.entries({ ref, cam, recorder, other }))
		keys[k] = (await register(app, p)).mediaKey;
}, 120_000);
afterAll(closeApps);

async function sync(body: unknown): Promise<{ status: number; json: unknown }> {
	const r = await app.inject({
		method: 'POST',
		url: '/api/sync/audio',
		headers: JSON_H,
		payload: body as object,
	});
	return { status: r.statusCode, json: r.json() };
}

describe('POST /api/sync/audio', () => {
	it('finds each recording’s offset against the reference, sample-accurate for PCM and within 1 ms through AAC', async () => {
		const r = await sync({
			clips: [
				{ key: 'ref', mediaKey: keys.ref },
				{ key: 'cam', mediaKey: keys.cam },
				{ key: 'recorder', mediaKey: keys.recorder },
				{ key: 'other', mediaKey: keys.other },
			],
		});
		expect(r.status).toBe(200);
		const body: SyncAudioResponse = SyncAudioResponseSchema.parse(r.json);
		const by = Object.fromEntries(body.results.map((x) => [x.key, x]));
		const sec = (k: string) => by[k]!.offsetFlicks / FLICKS_PER_SECOND;
		expect(body.reference).toBe('ref');
		expect(by.ref).toMatchObject({ offsetFlicks: 0, reliable: true });
		// cam media t = event t − 8.25, ref media t = event t − 5 → t_cam = t_ref − 3.25 s
		expect(Math.abs(sec('cam') + 3.25)).toBeLessThan(0.001);
		expect(by.cam!.reliable).toBe(true);
		// recorder started 1.5 s before the reference, inverted
		expect(Math.abs(sec('recorder') - 1.5)).toBeLessThan(1 / SR + 1e-9);
		expect(by.recorder!.inverted).toBe(true);
		expect(by.recorder!.reliable).toBe(true);
		expect(by.recorder!.confidence!).toBeGreaterThan(8);
		// unrelated material is flagged
		expect(by.other!.reliable).toBe(false);
	}, 120_000);

	it('analyses a stretch of each recording (timeline clips: sourceIn / duration) and honours maxOffset', async () => {
		const r = await sync({
			reference: 'b',
			clips: [
				{
					key: 'a',
					mediaKey: keys.recorder,
					startFlicks: 2 * FLICKS_PER_SECOND,
					durationFlicks: 20 * FLICKS_PER_SECOND,
				},
				{ key: 'b', mediaKey: keys.ref, startFlicks: 4 * FLICKS_PER_SECOND },
			],
		});
		const body = SyncAudioResponseSchema.parse(r.json);
		const a = body.results.find((x) => x.key === 'a')!;
		// offsets are media times, whatever stretch was analysed: t_rec = t_ref + 1.5 s
		expect(Math.abs(a.offsetFlicks / FLICKS_PER_SECOND - 1.5)).toBeLessThan(1 / SR + 1e-9);
		const lim = SyncAudioResponseSchema.parse(
			(
				await sync({
					maxOffsetSeconds: 0.5,
					clips: [
						{ key: 'ref', mediaKey: keys.ref },
						{ key: 'cam', mediaKey: keys.cam },
					],
				})
			).json,
		);
		const cam = lim.results.find((x) => x.key === 'cam')!;
		expect(cam.reliable && Math.abs(cam.offsetFlicks / FLICKS_PER_SECOND + 3.25) < 0.01).toBe(false);
	}, 120_000);

	it('validates requests', async () => {
		expect((await sync({ clips: [{ key: 'x', mediaKey: keys.ref }] })).status).toBe(400);
		expect(
			(
				await sync({
					clips: [
						{ key: 'x', mediaKey: keys.ref },
						{ key: 'y', mediaKey: 'mk_nope' },
					],
				})
			).status,
		).toBe(404);
		expect(
			(
				await sync({
					reference: 'z',
					clips: [
						{ key: 'x', mediaKey: keys.ref },
						{ key: 'y', mediaKey: keys.cam },
					],
				})
			).status,
		).toBe(400);
		const cap = await app.inject({ method: 'GET', url: '/api/capabilities', headers: JSON_H });
		expect((cap.json() as { features?: { audioSync?: { state: string } } }).features?.audioSync?.state).toBe(
			'ready',
		);
	});
});
