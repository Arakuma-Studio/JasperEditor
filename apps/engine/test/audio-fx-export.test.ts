// audio-fx on export: clips with audio effects, pan and reversed audio render natively (no Remotion fallback), and
// the export's samples equal the preview's — the same ClipChain run the way the AudioWorklet runs it (128-sample
// quanta from the clip start) on the same decoded input.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClipChain } from '@jasper/audio-fx';
import { buildRenderSnapshot, flicksPerFrame } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderAudioMix } from '../src/export/audio/mix-file.ts';
import { audioClipNeedsDsp, chainConfigOf, planAudioDsp } from '../src/export/audio/plan.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, JSON_H, makeApp, register, type TestApp } from './helpers.ts';

let app: TestApp;
let dir: string;
let src: string;
beforeAll(async () => {
	app = await makeApp();
	dir = mkdtempSync(join(tmpdir(), 'jasper-audiofx-'));
	src = join(dir, 'stereo.wav');
	// Different content per channel: a 440 Hz sine left, a 660 Hz sine + chirp right, 4 s, float.
	const r = spawnSync('ffmpeg', [
		'-v',
		'error',
		'-f',
		'lavfi',
		'-i',
		'aevalsrc=0.5*sin(2*PI*440*t)|0.4*sin(2*PI*660*t)+0.1*sin(2*PI*(200+300*t)*t):s=48000:d=4',
		'-c:a',
		'pcm_f32le',
		src,
	]);
	if (r.status !== 0) throw new Error(`source generation failed: ${r.stderr}`);
}, 120_000);
afterAll(closeApps);

const settings = (seqId: string, container = 'mov') => ({
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
	engine: 'auto',
});

const key = (frames: number, value: number, F: number) => ({ time: frames * F, value });

/** A1: the source at frame 15 (media 0.5…3.5 s) with keyframed effects and pan; optionally reversed. */
async function fxDoc(opts: { reverse?: boolean } = {}) {
	const d = new DocBuilder();
	const m = d.addMedia(await register(app, src));
	const F = flicksPerFrame({ num: 30, den: 1 });
	const r = d.tx([
		{
			type: 'clip.place',
			source: { mediaId: m },
			at: 15,
			sourceRange: { in: { seconds: 0.5 }, out: { seconds: 3.5 } },
			ref: '$c',
		},
	]);
	const clipId = r.refs.$c!;
	d.tx([
		{
			type: 'effect.add',
			target: { clipId },
			effectId: 'jasper.audio.stereo-width',
			params: { width: { value: 100, keyframes: [key(15, 40, F), key(60, 180, F)] } },
		},
		{ type: 'effect.add', target: { clipId }, effectId: 'jasper.audio.amplify', params: { leftGain: -4 } },
		{ type: 'effect.add', target: { clipId }, effectId: 'jasper.audio.mono-maker', params: { mode: 'below', amount: 70 } },
		{ type: 'param.set', target: ['clip', clipId, 'pan'], value: -35 },
		...(opts.reverse ? [{ type: 'clip.setSpeed', clipIds: [clipId], rate: 1, reverse: true, ripple: false }] : []),
	]);
	return { d, clipId };
}

function readWavF32(file: string): [Float32Array, Float32Array] {
	const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '2', '-'], {
		maxBuffer: 256 * 1024 * 1024,
	});
	const b = r.stdout;
	const f = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
	const n = f.length / 2;
	const l = new Float32Array(n);
	const rr = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		l[i] = f[2 * i]!;
		rr[i] = f[2 * i + 1]!;
	}
	return [l, rr];
}

/** The preview's samples: the decoder input run through the chain in 128-sample worklet quanta from s = 0. */
function previewRender(planned: Awaited<ReturnType<typeof planOf>>, clipIndex = 0) {
	const a = planned.snapshot.audioClips[clipIndex]!;
	const m = planned.media[a.mediaId]!;
	const plan = planAudioDsp({
		clip: a,
		media: { path: m.path, streamIndex: 0 },
		fps: planned.snapshot.settings.fps,
		range: planned.snapshot.range,
		master: planned.snapshot.master,
	})!;
	const dec = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', ...plan.decodeArgs], {
		maxBuffer: 256 * 1024 * 1024,
	});
	const b = dec.stdout;
	const f = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
	const decoded = Math.min(plan.decodeCount, f.length / 2);
	const total = plan.inEnd;
	const l = new Float32Array(total);
	const r = new Float32Array(total);
	for (let k = 0; k < decoded; k++) {
		const j = plan.reverse ? plan.decodeCount - 1 - k : k;
		if (j >= decoded) continue;
		l[plan.decodeStart + k] = f[2 * j]!;
		r[plan.decodeStart + k] = f[2 * j + 1]!;
	}
	const chain = new ClipChain(chainConfigOf(a, planned.snapshot.settings.fps, planned.snapshot.master));
	for (let s = 0; s < total; s += 128) chain.process([l, r], s, Math.min(total, s + 128), s);
	const L = chain.latency();
	return { l: l.subarray(L), r: r.subarray(L), plan };
}

async function planOf(d: DocBuilder) {
	return coreServices(app).exports.plan({
		envelope: d.envelope(),
		sequenceId: d.seqId,
		settings: settings(d.seqId) as never,
	});
}

describe('audio-fx native export', { timeout: 120_000 }, () => {
	it('plans audio effects, pan and reverse on the native path', async () => {
		const { d } = await fxDoc({ reverse: true });
		const planned = await planOf(d);
		expect(planned.plan.blockers.filter((b) => b.path === 'native')).toEqual([]);
		expect(planned.plan.path).toBe('native');
		expect(planned.plan.audio.mode).toBe('native-mix');
		expect(audioClipNeedsDsp(planned.snapshot.audioClips[0]!)).toBe(true);
		const snap = buildRenderSnapshot(planned.document, d.seqId, {
			resolveMedia: () => null,
			resolveFont: () => null,
		});
		expect(snap.audioClips[0]!.effects.length).toBe(3);
	});

	for (const reverse of [false, true])
		it(`export samples equal the preview chain bit for bit (${reverse ? 'reversed' : 'forward'})`, async () => {
			const { d } = await fxDoc({ reverse });
			const planned = await planOf(d);
			const file = join(dir, `mix-${reverse}.wav`);
			await renderAudioMix(coreServices(app).ffmpeg, planned, file, { signal: new AbortController().signal });
			const [el, er] = readWavF32(file);
			const pv = previewRender(planned);
			const delay = pv.plan.delay;
			expect(delay).toBe(Math.round((15 / 30) * 48000));
			let maxDiff = 0;
			let energy = 0;
			for (let i = 0; i < pv.plan.outCount; i++) {
				maxDiff = Math.max(maxDiff, Math.abs(el[delay + i]! - pv.l[i]!), Math.abs(er[delay + i]! - pv.r[i]!));
				energy += pv.l[i]! * pv.l[i]!;
			}
			expect(energy).toBeGreaterThan(100);
			expect(maxDiff).toBe(0);
			// Silence before the clip.
			for (let i = 0; i < delay; i++) expect(el[i]).toBe(0);
		});

	it('a reversed clip plays its source backwards', async () => {
		const { d } = await fxDoc({ reverse: true });
		const planned = await planOf(d);
		const pv = previewRender(planned);
		const fwd = previewRender(await planOf((await fxDoc()).d));
		// The chirp on the right rises forwards and falls backwards: compare zero-crossing rates of the first and
		// last 0.5 s (the 660 Hz part is common to both).
		const zc = (x: Float32Array, a: number, b: number) => {
			let n = 0;
			for (let i = a + 1; i < b; i++) if (x[i - 1]! < 0 !== x[i]! < 0) n++;
			return n;
		};
		const half = 24000;
		const n = pv.plan.outCount;
		expect(zc(fwd.r, n - half, n)).toBeGreaterThan(zc(fwd.r, 0, half));
		expect(zc(pv.r, 0, half)).toBeGreaterThan(zc(pv.r, n - half, n));
	});

	it('runs a full native export (mov, PCM audio) whose audio matches the preview within 16-bit quantisation', async () => {
		const { d } = await fxDoc();
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
		});
		expect(start.statusCode).toBe(202);
		const done = await coreServices(app).queue.wait(start.json().id);
		expect(done.error).toBeUndefined();
		expect(done.result).toMatchObject({ renderPath: 'native' });
		const out = (await coreServices(app).exports.outputFile(start.json().id))!;
		const [el, er] = readWavF32(out);
		const pv = previewRender(await planOf(d));
		const delay = pv.plan.delay;
		let maxDiff = 0;
		for (let i = 0; i < pv.plan.outCount; i++)
			maxDiff = Math.max(maxDiff, Math.abs(el[delay + i]! - pv.l[i]!), Math.abs(er[delay + i]! - pv.r[i]!));
		expect(maxDiff).toBeLessThan(2 / 32768);
		expect(readFileSync(out).length).toBeGreaterThan(1000);
	});
});
