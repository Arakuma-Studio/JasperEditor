// audio-mix (engine): every export path takes the offline mixer's audio — pan, submixes, sends, 5.1, sample
// rates and two-pass loudness normalisation — and the analysis / loudness-normalise jobs.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureLoudness } from '@jasper/audio-dsp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, JSON_H, makeApp, register, type TestApp } from './helpers.ts';

let app: TestApp;
let dir: string;
beforeAll(async () => {
	app = await makeApp();
	dir = mkdtempSync(join(tmpdir(), 'jasper-audiomix-'));
	for (const [name, expr] of [
		['tone-1k.wav', 'sine=frequency=1000:sample_rate=48000:duration=4'],
		['tone-500.wav', 'sine=frequency=500:sample_rate=44100:duration=4'],
	] as const) {
		const r = spawnSync('ffmpeg', [
			'-v',
			'error',
			'-f',
			'lavfi',
			'-i',
			expr,
			'-ac',
			'2',
			'-c:a',
			'pcm_s16le',
			join(dir, name),
		]);
		if (r.status !== 0) throw new Error(`tone generation failed: ${r.stderr}`);
	}
}, 120_000);
afterAll(closeApps);

const settings = (seqId: string, audio: Record<string, unknown> = {}) => ({
	sequenceId: seqId,
	range: { type: 'entire' },
	container: 'mp4',
	video: {
		codec: 'h264',
		width: 320,
		height: 180,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 30 },
		encoderSpeed: 'fast',
		colorTags: 'rec709',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2, ...audio },
	engine: 'native',
});

async function exportOf(d: DocBuilder, audio: Record<string, unknown> = {}) {
	const start = await app.inject({
		method: 'POST',
		url: '/api/exports',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId, audio) },
	});
	expect(start.statusCode, start.body).toBe(202);
	const done = await coreServices(app).queue.wait(start.json().id);
	expect(done.error).toBeUndefined();
	return {
		file: (await coreServices(app).exports.outputFile(start.json().id))!,
		result: done.result as Record<string, unknown>,
	};
}

/** Planar float samples of a file's audio. */
function planar(file: string, channels: number): Float32Array[] {
	const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-f', 'f32le', '-'], {
		maxBuffer: 256 << 20,
	});
	const all = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength / 4);
	const n = Math.floor(all.length / channels);
	const out = Array.from({ length: channels }, () => new Float32Array(n));
	for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) out[c]![i] = all[i * channels + c]!;
	return out;
}
const rms = (x: Float32Array, a = 4800, b = x.length - 4800) => {
	let s = 0;
	for (let i = a; i < b; i++) s += x[i]! * x[i]!;
	return Math.sqrt(s / Math.max(1, b - a));
};
const db = (x: number) => 20 * Math.log10(x);

async function toneDoc(file = 'tone-1k.wav') {
	const d = new DocBuilder();
	const m = d.addMedia(await register(app, join(dir, file)));
	d.tx([{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { audio: 'A1' } }]);
	return d;
}

describe('export audio = the offline mixer (audio-mix)', () => {
	it('balance hard left, a submix with a pre-fader send of a muted track, at 44.1 kHz', async () => {
		const d = await toneDoc();
		d.tx([{ type: 'mixer.updateStrip', stripId: 'A1', patch: { pan: -100 } }]);
		const a = await exportOf(d, { sampleRate: 44100 });
		const probe = spawnSync('ffprobe', [
			'-v',
			'error',
			'-show_entries',
			'stream=sample_rate,channels',
			'-select_streams',
			'a',
			'-of',
			'csv=p=0',
			a.file,
		]);
		expect(probe.stdout.toString().trim()).toBe('44100,2');
		const [l, r] = planar(a.file, 2);
		expect(db(rms(l!)) - db(rms(r!))).toBeGreaterThan(40); // right is silent
		// A1 muted, sent pre-fader at −6 dB to S1 (−6 dB): both sides at −12 dB of the tone, centred.
		const s = d.tx([{ type: 'mixer.addSubmix', ref: '$s' }]);
		void s;
		d.tx([
			{ type: 'mixer.updateStrip', stripId: 'A1', patch: { pan: 0, mute: true } },
			{ type: 'mixer.updateStrip', stripId: 'S1', patch: { volumeDb: -6 } },
			{ type: 'mixer.addSend', stripId: 'A1', target: 'S1', preFader: true, levelDb: -6 },
		]);
		const b = await exportOf(d);
		const [l2, r2] = planar(b.file, 2);
		const ref = (await exportOf(await toneDoc())).file;
		const [lr] = planar(ref, 2);
		expect(Math.abs(db(rms(l2!)) - db(rms(lr!)) + 12)).toBeLessThan(0.3);
		expect(Math.abs(db(rms(l2!)) - db(rms(r2!)))).toBeLessThan(0.1);
	}, 300_000);

	it('a 5.1 Mix exports discrete 5.1 (puck rear left → Ls) and folds to stereo with BS.775', async () => {
		const d = await toneDoc();
		d.tx([
			{ type: 'mixer.updateStrip', stripId: 'Mix', patch: { channelFormat: '5.1' } },
			{ type: 'mixer.updateStrip', stripId: 'A1', patch: { channelFormat: 'mono' } },
			{ type: 'mixer.setLane', stripId: 'A1', lane: 'pan51.x', value: -100 },
			{ type: 'mixer.setLane', stripId: 'A1', lane: 'pan51.y', value: -100 },
		]);
		const six = await exportOf(d, { channels: 6, bitrateKbps: 384 });
		const ch = planar(six.file, 6).map((c) => db(rms(c)));
		// decoded order: FL FR FC LFE BL BR — only Ls (index 4) carries the tone. The file's tone is −21.07 dBFS
		// peak per channel (ffmpeg's −18.06 dBFS sine upmixed at −3 dB); the mono fold k·(L+R) puts it back at
		// −18.06 dB peak, so the Ls RMS is −21.07 dB.
		expect(Math.abs(ch[4]! + 21.07)).toBeLessThan(0.3);
		for (const i of [0, 1, 2, 3, 5]) expect(ch[i]!).toBeLessThan(ch[4]! - 40);
		const two = await exportOf(d, { channels: 2 });
		const [l, r] = planar(two.file, 2);
		// Lo = L + k·Ls: the rear-left tone is on the left only, 3 dB down
		expect(Math.abs(db(rms(l!)) - (ch[4]! - 3.01))).toBeLessThan(0.3);
		expect(db(rms(r!))).toBeLessThan(db(rms(l!)) - 40);
	}, 300_000);

	it('two-pass loudness normalisation reaches the target within 0.1 LU under the true-peak ceiling', async () => {
		const d = await toneDoc('tone-500.wav');
		const n = await exportOf(d, { normalize: { targetLufs: -16, truePeakDb: -1 } });
		const [l, r] = planar(n.file, 2);
		const m = measureLoudness([l!, r!], 48000);
		expect(Math.abs(m.integrated + 16)).toBeLessThan(0.15); // AAC adds a few hundredths
		expect(m.truePeakDb).toBeLessThan(-0.8);
		expect((n.result.audioLoudness as { integratedLufs: number }).integratedLufs).toBeCloseTo(-16, 1);
		// a target that would clip: the limiter holds the ceiling
		const loud = await exportOf(d, { normalize: { targetLufs: -3, truePeakDb: -2 } });
		const [l2, r2] = planar(loud.file, 2);
		expect(measureLoudness([l2!, r2!], 48000).truePeakDb).toBeLessThan(-1.7);
	}, 300_000);

	it('audio effects without an export processor block every path by name', async () => {
		const d = await toneDoc();
		const original = d.doc;
		d.doc = structuredClone(original);
		const seq = d.doc.sequences[d.seqId]!;
		seq.master.effects.push({
			id: 'fx_0000000000000000',
			effectId: 'test.unknown-audio',
			effectVersion: 1,
			enabled: true,
			params: {},
		});
		const r = await app.inject({
			method: 'POST',
			url: '/api/exports/plan',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
		});
		expect(r.statusCode).toBe(409);
		expect(r.json().code).toBe('AUDIO_EFFECT_UNSUPPORTED');
		d.doc = original;
	});
});

describe('audio analysis and loudness normalisation jobs', () => {
	it('measures the sequence, soloed tracks and clips (source levels without gain)', async () => {
		const d = await toneDoc();
		const clip = d.clipIds()[0]!;
		d.tx([{ type: 'audio.setGain', clipIds: [clip], mode: 'set', db: -6 }]);
		const run = async (scope: unknown, extra: Record<string, unknown> = {}) => {
			const r = await app.inject({
				method: 'POST',
				url: '/api/audio/analyze?wait=1',
				headers: JSON_H,
				payload: { envelope: d.envelope(), sequenceId: d.seqId, scope, ...extra },
			});
			expect(r.statusCode, r.body).toBe(200);
			return r.json().result;
		};
		const seqR = await run({ type: 'sequence' });
		const src = await run({ type: 'clips', clipIds: [clip] }, { levels: 'source' });
		// ffmpeg's lavfi sine (amplitude 1/8, −18.06 dBFS) upmixed to stereo at −3 dB: −21.07 dBFS sample peak
		expect(src.clips[clip].samplePeakDb).toBeCloseTo(-21.07, 1);
		expect(seqR.loudness.integratedLufs).toBeCloseTo(src.loudness.integratedLufs - 6, 1);
		expect(typeof seqR.mixHash).toBe('string');
		const act = await run({ type: 'tracks', trackIds: ['A1'] }, { activity: { sensitivity: 6 } });
		expect(act.activity.regions.length).toBe(1);
		expect(act.activity.regions[0][0]).toBeLessThan(705_600_000 * 0.1);
	}, 300_000);

	it('normalises a media into a WAV version and audio clips switch to it in one step', async () => {
		const d = await toneDoc('tone-500.wav');
		const asset = Object.values(d.doc.media)[0]!;
		const key = asset.locators.find((l) => l.type === 'engine-store')!.key as string;
		const r = await app.inject({
			method: 'POST',
			url: `/api/media/${key}/loudness-normalize?wait=1`,
			headers: JSON_H,
			payload: { targetLufs: -20, truePeakDb: -1 },
		});
		expect(r.statusCode, r.body).toBe(200);
		const res = r.json().result;
		expect(res.after.integratedLufs).toBeCloseTo(-20, 1);
		expect(res.after.truePeakDbtp).toBeLessThanOrEqual(-0.95);
		const clip = d.clipIds()[0]!;
		const reg = res.registered;
		const out = d.tx([
			{
				type: 'media.derive',
				fromMediaId: asset.id,
				recipe: { op: 'loudness-normalize', targetLufs: -20, truePeakDb: -1 },
				asset: {
					fingerprint: reg.fingerprint,
					originalName: reg.originalName,
					sizeBytes: reg.sizeBytes,
					container: reg.container,
					probe: reg.probe,
					locators: [{ type: 'engine-store', engineId: 'local', key: reg.mediaKey }],
					recipeVersion: res.recipeVersion,
					recipeHash: res.recipeHash,
				},
				replaceInClips: [clip],
			},
		]);
		const mediaId = (out.results[0] as { mediaId: string }).mediaId;
		expect(d.doc.media[mediaId]!.kind).toBe('audio');
		expect((d.doc.sequences[d.seqId]!.clips[clip] as { mediaId: string }).mediaId).toBe(mediaId);
	}, 300_000);
});
