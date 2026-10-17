// Fix "SFX tail truncation" (spec 12 §2.3; wp-note "Fix: SFX tail truncation"): a short sound placed by
// `soundDesign.place` plays WHOLE, its tail to −60 dB included. Before the fix registration padded silence in front of a
// sound only and clips are whole frames inside their media, so with the sub-frame In point the clip ended before the
// media did — for a click shorter than a frame after its peak, exactly at its peak (measured by WP5.1's real run).
//
// Each click is a real library sound (a user folder, indexed), registered into a project by the engine's own route (the
// managed copy every surface places), placed on a cue at 23.976 / 29.97 / 30 / 60 fps, and rendered alone by the
// engine's mixer; the rendered samples are compared with the source file's, sample for sample, over the whole sound.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type EngineJob, RegisterSoundResponseSchema, type SoundEntry } from '@jasper/api';
import { encodeWav } from '@jasper/audio-dsp';
import { frameToSample, LIBRARY_TRAIL_SILENCE_SEC, type Sequence } from '@jasper/project';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderMixdown, WAV_F32_HEADER_BYTES } from '../src/audio/mixdown.ts';
import { audioWorld } from '../src/sound-design/bed.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, H, JSON_H, makeApp, TEST_FFMPEG, tempAppdir } from './helpers.ts';
import { makeStarter } from './sound-fixtures.ts';

const SR = 48_000;
const ENV_KEYS = ['JASPER_SOUND_STARTER_DIR', 'JASPER_SOUND_SYNTH_VARIANTS', 'JASPER_SOUND_AUTO_INDEX'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

/**
 * A click of `ms` milliseconds that starts at once (a loud head: registering pads it) and decays exponentially to
 * exactly −60 dB at its last sample (no quiet tail: the file ends where the sound does). `quietHeadMs` of digital
 * silence before it (≥ 50 ms: registered without lead silence).
 */
function click(ms: number, freq: number, quietHeadMs = 0): Float32Array {
	const n = Math.round((ms / 1000) * SR);
	const head = Math.round((quietHeadMs / 1000) * SR);
	const out = new Float32Array(head + n);
	const tau = (n - 1) / Math.log(1000);
	for (let i = 0; i < n; i++) out[head + i] = 0.8 * Math.exp(-i / tau) * Math.sin((2 * Math.PI * freq * i) / SR);
	return out;
}

/** Interleaved f32 samples of a file's first audio stream, as ffmpeg decodes it. */
function decodeF32(file: string): Float32Array {
	const out = execFileSync(TEST_FFMPEG, ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'f32le', '-']);
	return new Float32Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
}

let app: FastifyInstance;
let folder = '';
let projectId = '';
const files: Record<string, string> = {};

beforeAll(async () => {
	process.env.JASPER_SOUND_STARTER_DIR = makeStarter(tempAppdir('jasper-tail-starter-'));
	process.env.JASPER_SOUND_SYNTH_VARIANTS = '0';
	process.env.JASPER_SOUND_AUTO_INDEX = '0';
	app = await makeApp();
	folder = tempAppdir('jasper-tail-sfx-');
	mkdirSync(join(folder, 'Clicks'), { recursive: true });
	const sounds: [string, Float32Array][] = [
		['tick 20', click(20, 4000)],
		['tick 30', click(30, 3000)],
		['tick 40', click(40, 2500)],
		// a quiet head (registered without lead silence before the fix: in place) and an abrupt end
		['late tick', click(30, 3500, 80)],
	];
	for (const [name, s] of sounds) {
		const path = join(folder, 'Clicks', `${name}.wav`);
		writeFileSync(path, encodeWav([s, s], SR, 's16'));
		files[name] = path;
	}
	const put = await app.inject({
		method: 'PUT',
		url: '/api/sounds/roots',
		headers: JSON_H,
		payload: { roots: [{ path: folder, license: 'CC0-1.0' }] },
	});
	expect(put.statusCode, put.body).toBe(200);
	const job = await coreServices(app).queue.wait((put.json() as { job: EngineJob }).job.id);
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	const created = await app.inject({
		method: 'POST',
		url: '/api/projects',
		headers: JSON_H,
		payload: { name: 'Tails', preset: 'hd-1080p-30' },
	});
	projectId = (created.json() as { projectId: string }).projectId;
}, 300_000);

afterAll(async () => {
	await closeApps();
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

async function soundByTitle(title: string): Promise<SoundEntry> {
	const r = await app.inject({ method: 'GET', url: '/api/sounds?sources=folder&limit=50', headers: H });
	const hit = (r.json() as { results: { sound: SoundEntry }[] }).results.find((x) => x.sound.title === title);
	if (!hit) throw new Error(`no sound ${title}`);
	return hit.sound;
}

async function registerSound(id: string) {
	const r = await app.inject({
		method: 'POST',
		url: `/api/sounds/${id}/register`,
		headers: JSON_H,
		payload: { projectId },
	});
	expect(r.statusCode, r.body).toBe(200);
	return RegisterSoundResponseSchema.parse(r.json());
}

const RATES: [string, { num: number; den: number }, boolean][] = [
	['23.976', { num: 24000, den: 1001 }, false],
	['29.97', { num: 30000, den: 1001 }, true],
	['30', { num: 30, den: 1 }, false],
	['60', { num: 60, den: 1 }, false],
];

describe('a placed short sound plays whole, its tail included', { timeout: 300_000 }, () => {
	it.each(RATES)('%s fps: every click is rendered sample for sample to its −60 dB end', async (label, fps, df) => {
		const b = new DocBuilder(`hd-1080p-${label}`, 600);
		if (df) b.tx([{ type: 'sequence.updateSettings', settings: { dropFrame: true } }]);
		const placed: { clipId: string; frame: number; source: Float32Array; peakSample: number }[] = [];
		for (const [i, title] of ['tick 20', 'tick 30', 'tick 40', 'late tick'].entries()) {
			const e = await soundByTitle(title);
			const reg = await registerSound(e.id);
			const { mediaKey: _k, browserPlayable: _b, library, existingMediaId: _x, ...asset } = reg;
			const r0 = b.tx([{ type: 'media.register', asset: { ...asset, derivation: null, library } }]);
			const mediaId = (r0.results[0] as { mediaId: string }).mediaId;
			// cues on frames that are not whole seconds, so the In point keeps a sub-frame rest
			const frame = Math.round((0.6 + 0.7 * i) * (fps.num / fps.den)) + i;
			const r = b.tx([
				{
					type: 'soundCue.add',
					cues: [{ frame, kind: 'cut', weight: 'support', source: 'user', align: 'peak', ref: '$c' }],
				},
				{ type: 'soundDesign.place', cueId: '$c', layers: [{ mediaId, gainDb: 0 }] },
			]);
			const clip = (r.results[1] as { clips: { clipId: string; errorFlicks: number; sourceInFlicks: number }[] })
				.clips[0]!;
			expect(clip.errorFlicks).toBe(0);
			// the source sound (left channel) and where its peak is in it
			const src = decodeF32(files[title]!).filter((_, k) => k % 2 === 0);
			placed.push({
				clipId: clip.clipId,
				frame,
				source: src,
				peakSample: Math.round(e.descriptors.peakSec * SR),
			});
		}
		const doc = b.doc;
		const world = await audioWorld(doc, b.seqId, coreServices(app).registry);
		const scratch = tempAppdir('jasper-tail-render-');
		const total = (doc.sequences[b.seqId] as Sequence).settings;
		const end = Math.max(...placed.map((p) => p.frame)) + Math.ceil((total.frameRate.num / total.frameRate.den) * 0.5);
		const out = await renderMixdown({
			ff: coreServices(app).ffmpeg,
			snapshot: world.snapshot,
			media: world.media,
			range: { start: 0, end },
			outputLayout: 'stereo',
			scratchDir: scratch,
			withoutLoudness: true,
		});
		const buf = await readFile(out.path!);
		const pcm = new Float32Array(buf.buffer.slice(buf.byteOffset + WAV_F32_HEADER_BYTES));
		await rm(scratch, { recursive: true, force: true });
		const left = (i: number) => pcm[i * 2] ?? 0;
		for (const p of placed) {
			const at = frameToSample(p.frame, fps, SR) - p.peakSample; // where the source's first sample plays
			// the whole sound: from its first sample to its last one above −60 dB (its last sample here)
			const peak = Math.max(...p.source.map(Math.abs));
			let last = p.source.length - 1;
			while (last > 0 && Math.abs(p.source[last]!) < peak / 1000) last--;
			let worst = 0;
			let worstAt = -1;
			for (let k = 0; k < p.source.length; k++) {
				const d = Math.abs(left(at + k) - p.source[k]!);
				if (d > worst) {
					worst = d;
					worstAt = k;
				}
			}
			expect(
				worst,
				`${label} fps, clip ${p.clipId}: worst difference ${worst} at source sample ${worstAt} of ${p.source.length} (−60 dB end at ${last})`,
			).toBeLessThan(peak * 1e-5);
		}
	});

	it('registration pads silence after a sound that ends abruptly, in front of one that starts at once', async () => {
		const tick = await soundByTitle('tick 30');
		const late = await soundByTitle('late tick');
		const r1 = await registerSound(tick.id);
		const r2 = await registerSound(late.id);
		expect(r1.library.leadSilenceSec).toBe(0.05);
		expect(r1.library.trailSilenceSec).toBe(LIBRARY_TRAIL_SILENCE_SEC);
		// a quiet head needs no lead, but the abrupt end needs the trail: copied (not registered in place)
		expect(r2.library.leadSilenceSec).toBeUndefined();
		expect(r2.library.trailSilenceSec).toBe(LIBRARY_TRAIL_SILENCE_SEC);
		expect(r2.fingerprint).not.toBe(late.fingerprint);
		// deterministic: registering again gives the same bytes (one media)
		expect((await registerSound(tick.id)).fingerprint).toBe(r1.fingerprint);
	});
});
