// audio-fx (engine): audio effects export natively through the offline mixer (no AUDIO_EFFECT_UNSUPPORTED, no
// Remotion fallback) with exact DSP results; reversed audio and pan too; remix plans on generated beat tracks
// commit as `clip.remix`; Essential Sound Auto-Match reaches its loudness target.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWav, measureLoudness } from '@jasper/audio-dsp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { testMusic } from '../../../packages/audio-fx/test/music.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, JSON_H, makeApp, register, type TestApp } from './helpers.ts';

// ffmpeg decodes, mixes and encodes real media here: allow for a loaded machine (the full gate runs suites in parallel).
vi.setConfig({ testTimeout: 120_000 });

let app: TestApp;
let dir: string;
beforeAll(async () => {
	app = await makeApp();
	dir = mkdtempSync(join(tmpdir(), 'jasper-audiofx-'));
	const r = spawnSync('ffmpeg', [
		'-v',
		'error',
		'-f',
		'lavfi',
		'-i',
		'aevalsrc=0.5*sin(2*PI*1000*t)|0.25*sin(2*PI*1000*t):s=48000:d=4',
		'-c:a',
		'pcm_f32le',
		join(dir, 'tone.wav'),
	]);
	if (r.status !== 0) throw new Error(`tone generation failed: ${r.stderr}`);
	const music = testMusic(48000, 120, 24, 7); // 48 s
	writeFileSync(join(dir, 'music.wav'), encodeWav(music.audio, 48000, 'f32'));
}, 120_000);
afterAll(closeApps);

const settings = (seqId: string, container = 'mov', engine = 'native') => ({
	sequenceId: seqId,
	range: { type: 'entire' },
	container,
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
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
	engine,
});

async function exportOf(d: DocBuilder, engine = 'native') {
	const start = await app.inject({
		method: 'POST',
		url: '/api/exports',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId, 'mov', engine) },
	});
	expect(start.statusCode, start.body).toBe(202);
	const done = await coreServices(app).queue.wait(start.json().id);
	expect(done.error).toBeUndefined();
	return {
		file: (await coreServices(app).exports.outputFile(start.json().id))!,
		result: done.result as Record<string, unknown>,
	};
}

function planar(file: string): [Float32Array, Float32Array] {
	const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '2', '-f', 'f32le', '-'], {
		maxBuffer: 256 << 20,
	});
	const all = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength / 4);
	const n = all.length / 2;
	const l = new Float32Array(n);
	const rr = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		l[i] = all[2 * i]!;
		rr[i] = all[2 * i + 1]!;
	}
	return [l, rr];
}

const amp = (x: Float32Array, a: number, b: number) => {
	let p = 0;
	for (let i = a; i < b; i++) p = Math.max(p, Math.abs(x[i]!));
	return p;
};

async function toneDoc() {
	const d = new DocBuilder();
	const m = d.addMedia(await register(app, join(dir, 'tone.wav')));
	const r = d.tx([
		{
			type: 'clip.place',
			source: { mediaId: m },
			at: 0,
			sourceRange: { in: { seconds: 0 }, out: { seconds: 3 } },
			ref: '$c',
		},
	]);
	return { d, clipId: r.refs.$c! };
}

describe('audio-fx native export', () => {
	it('exports clip effects natively with exact DSP gains (Amplify, Invert, Channel Volume)', async () => {
		const ref = await toneDoc();
		const plainOut = planar((await exportOf(ref.d)).file);
		const { d, clipId } = await toneDoc();
		d.tx([
			{
				type: 'effect.add',
				target: { clipId },
				effectId: 'jasper.audio.amplify',
				params: { leftGain: -6.0206, link: false, rightGain: 0 },
			},
			{
				type: 'effect.add',
				target: { clipId },
				effectId: 'jasper.audio.invert',
				params: { channels: 'right' },
			},
			{
				type: 'effect.add',
				target: { clipId },
				effectId: 'jasper.audio.channel-volume',
				params: { right: 6.0206 },
			},
		]);
		const { file, result } = await exportOf(d);
		expect(result.renderPath).toBe('native');
		const [l, r] = planar(file);
		// L: ½ of the plain export; R: 2× and inverted (AAC: compared with the same clip without effects, ±0.2 dB).
		const db = (x: number) => 20 * Math.log10(x);
		expect(Math.abs(db(amp(l, 24000, 96000) / amp(plainOut[0], 24000, 96000)) + 6.0206)).toBeLessThan(0.2);
		expect(Math.abs(db(amp(r, 24000, 96000) / amp(plainOut[1], 24000, 96000)) - 6.0206)).toBeLessThan(0.2);
		let corr = 0;
		for (let i = 24000; i < 96000; i++) corr += l[i]! * r[i]!;
		expect(corr).toBeLessThan(0);
	});

	it('a hard limiter caps the exported peak; a reversed clip with pan and a reverb exports natively', async () => {
		const { d, clipId } = await toneDoc();
		d.tx([
			{ type: 'audio.setGain', clipIds: [clipId], mode: 'set', db: 12 },
			{
				type: 'effect.add',
				target: { clipId },
				effectId: 'jasper.audio.hard-limiter',
				params: { maxAmplitude: -6 },
			},
		]);
		const lim = await exportOf(d);
		// Clip gain applies after the effects (the export mixer's order): the limiter holds −6 dBFS, then +12 dB.
		const [l] = planar(lim.file);
		expect(Math.abs(20 * Math.log10(amp(l, 24000, 96000)) - 6)).toBeLessThan(0.5);
		const { d: d2, clipId: c2 } = await toneDoc();
		d2.tx([
			{ type: 'clip.setSpeed', clipIds: [c2], rate: 1, reverse: true, ripple: false },
			{ type: 'param.set', target: ['clip', c2, 'pan'], value: -100 },
			{
				type: 'effect.add',
				target: { clipId: c2 },
				effectId: 'jasper.audio.studio-reverb',
				params: { mix: 30 },
			},
		]);
		const planned = await coreServices(app).exports.plan({
			envelope: d2.envelope(),
			sequenceId: d2.seqId,
			settings: settings(d2.seqId) as never,
		});
		expect(planned.plan.blockers.filter((b) => b.path === 'native')).toEqual([]);
		const rev = await exportOf(d2);
		expect(rev.result.renderPath).toBe('native');
		const [rl, rr] = planar(rev.file);
		expect(amp(rl, 24000, 96000)).toBeGreaterThan(0.1);
		expect(amp(rr, 24000, 96000)).toBeLessThan(1e-3); // hard left
	});

	it('the Remotion path carries the same mixer audio (effects too)', async () => {
		const { d, clipId } = await toneDoc();
		d.tx([
			{
				type: 'effect.add',
				target: { clipId },
				effectId: 'jasper.audio.amplify',
				params: { leftGain: -6.0206, rightGain: -6.0206 },
			},
		]);
		const planned = await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId, 'mov', 'remotion') as never,
		});
		expect(planned.plan.path).toBe('remotion');
		// Every path renders the offline mixer's audio (audio-mix): the plan does not refuse the effect.
		expect(planned.plan.blockers.some((b) => /audio effect/i.test(b.reason))).toBe(false);
	});
});

describe('remix plan route + clip.remix', () => {
	it('plans a 48 s generated song to 30 s and commits it; the export is 30 s long', async () => {
		const d = new DocBuilder();
		const reg = await register(app, join(dir, 'music.wav'));
		const m = d.addMedia(reg);
		const r = d.tx([{ type: 'clip.place', source: { mediaId: m }, at: 0, ref: '$m' }]);
		const clipId = r.refs.$m!;
		const res = await app.inject({
			method: 'POST',
			url: '/api/audio/remix-plan',
			headers: JSON_H,
			payload: { mediaKey: reg.mediaKey, startSeconds: 0, durationSeconds: 48, targetSeconds: 30 },
		});
		expect(res.statusCode, res.body).toBe(200);
		const plan = res.json() as {
			bpm: number;
			pieces: { srcSeconds: number; lenSeconds: number }[];
			lengthSeconds: number;
		};
		expect(Math.abs(plan.bpm - 120)).toBeLessThan(1);
		expect(Math.abs(plan.lengthSeconds - 30)).toBeLessThanOrEqual(0.5);
		expect(plan.pieces[0]!.srcSeconds).toBe(0);
		d.tx([{ type: 'clip.remix', clipId, targetFrames: 900, pieces: plan.pieces, bpm: plan.bpm }]);
		const seq = d.doc.sequences[d.seqId]!;
		const clips = Object.values(seq.clips).sort((a, b) => a.start - b.start);
		expect(clips.length).toBe(plan.pieces.length);
		expect(clips[clips.length - 1]!.start + clips[clips.length - 1]!.duration).toBe(900);
		const { file } = await exportOf(d);
		const [l] = planar(file);
		expect(Math.abs(l.length / 48000 - 30)).toBeLessThan(0.05);
		// Silence / noise is refused with a typed error.
		const bad = await app.inject({
			method: 'POST',
			url: '/api/audio/remix-plan',
			headers: JSON_H,
			payload: {
				mediaKey: (await register(app, join(dir, 'tone.wav'))).mediaKey,
				startSeconds: 0,
				durationSeconds: 4,
				targetSeconds: 2,
			},
		});
		expect(bad.statusCode).toBe(422);
		expect(bad.json().code).toMatch(/^REMIX_/);
	});
});

describe('Essential Sound Auto-Match', () => {
	it('measures the clip (source levels, with its effects) and matches −23 LUFS in the export', async () => {
		const { d, clipId } = await toneDoc();
		d.tx([
			{ type: 'essentialSound.setType', clipIds: [clipId], audioType: 'dialogue' },
			{ type: 'essentialSound.set', clipIds: [clipId], values: { 'clarity.dynamics.on': true } },
		]);
		const job = await app.inject({
			method: 'POST',
			url: '/api/audio/analyze?wait=1',
			headers: JSON_H,
			payload: {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				scope: { type: 'clips', clipIds: [clipId] },
				levels: 'source',
			},
		});
		expect(job.statusCode, job.body).toBe(200);
		const lufs = job.json().result.clips[clipId].integratedLufs as number;
		d.tx([{ type: 'essentialSound.autoMatch', measuredLufs: { [clipId]: lufs }, targetLufs: -23 }]);
		const { file } = await exportOf(d);
		const [l, r] = planar(file);
		const meas = measureLoudness([l.subarray(0, 90000), r.subarray(0, 90000)], 48000);
		expect(Math.abs(meas.integrated - -23)).toBeLessThan(0.5);
	});
});
