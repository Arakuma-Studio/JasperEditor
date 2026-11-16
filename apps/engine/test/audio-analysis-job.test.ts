// Loudness analysis as a job (measure_loudness): a slow mix reports the frames it has mixed and can be cancelled, and
// the same measurement of an unchanged mix is kept, so asking again answers at once. The slow mix is a stand-in mixer
// that stops halfway until the test lets it go on (no timing).
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AudioAnalyzeRequest, AudioAnalyzeRequestSchema, type AudioAnalyzeResult } from '@jasper/api';
import { LoudnessMeter } from '@jasper/audio-dsp';
import { frameToSample } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { renderMixdown } from '../src/audio/mixdown.ts';
import { AudioService } from '../src/audio/service.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, JSON_H, makeApp, register, type TestApp } from './helpers.ts';

let app: TestApp;
let tone: string;
beforeAll(async () => {
	app = await makeApp();
	tone = join(mkdtempSync(join(tmpdir(), 'jasper-analysis-job-')), 'tone.wav');
	const r = spawnSync('ffmpeg', [
		'-v',
		'error',
		'-f',
		'lavfi',
		'-i',
		'sine=frequency=1000:sample_rate=48000:duration=4',
		'-ac',
		'2',
		'-c:a',
		'pcm_s16le',
		tone,
	]);
	if (r.status !== 0) throw new Error(`tone generation failed: ${r.stderr}`);
});
afterAll(closeApps);

/** 4 s of tone on A1 of a 30 fps sequence: 120 frames. */
async function toneDoc(on: TestApp) {
	const d = new DocBuilder();
	const m = d.addMedia(await register(on, tone));
	d.tx([{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { audio: 'A1' } }]);
	return d;
}

const request = (d: DocBuilder, scope: AudioAnalyzeRequest['scope']): AudioAnalyzeRequest =>
	AudioAnalyzeRequestSchema.parse({ envelope: d.envelope(), sequenceId: d.seqId, scope, delivery: null });

/** A mixer that mixes half the range, then waits until `release()` (or its cancellation). */
function halfwayMixer() {
	let reached!: () => void;
	const halfway = new Promise<void>((resolve) => {
		reached = resolve;
	});
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const mix: typeof renderMixdown = async (o) => {
		const sr = o.snapshot.audioMix?.sampleRate ?? 48_000;
		const fps = o.snapshot.settings.fps;
		const total = frameToSample(o.range.end, fps, sr) - frameToSample(o.range.start, fps, sr);
		const silence = (n: number) => o.onBlock?.([new Float32Array(n), new Float32Array(n)], n);
		const half = Math.floor(total / 2);
		silence(half);
		o.onProgress?.(half / total, 'Mixing audio');
		reached();
		await Promise.race([
			released,
			new Promise((resolve) => o.signal?.addEventListener('abort', resolve, { once: true })),
		]);
		if (o.signal?.aborted) throw new Error('aborted');
		silence(total - half);
		o.onProgress?.(1, 'Mixing audio');
		return {
			path: null,
			sampleRate: sr,
			channels: 2,
			samples: total,
			loudness: new LoudnessMeter(sr, 2).summary(),
		};
	};
	return { mix, halfway, release };
}

describe('loudness analysis jobs', () => {
	it('the same measurement of an unchanged mix answers at once, finished; an edit measures again', async () => {
		const d = await toneDoc(app);
		const analyze = (wait: boolean) =>
			app.inject({
				method: 'POST',
				url: `/api/audio/analyze${wait ? '?wait=1' : ''}`,
				headers: JSON_H,
				payload: request(d, { type: 'tracks', trackIds: ['A1'] }),
			});
		const first = await analyze(true);
		expect(first.statusCode, first.body).toBe(200);
		const measured = first.json().result;
		const again = await analyze(false);
		expect(again.statusCode, again.body).toBe(200);
		expect(again.json()).toMatchObject({ state: 'succeeded', result: measured });
		d.tx([{ type: 'audio.setGain', clipIds: [d.clipIds()[0]], mode: 'set', db: -6 }]);
		const edited = await analyze(false);
		expect(edited.statusCode, edited.body).toBe(202);
		const done = await coreServices(app).queue.wait(edited.json().id);
		expect((done.result as AudioAnalyzeResult).loudness.integratedLufs!).toBeCloseTo(
			measured.loudness.integratedLufs - 6,
			1,
		);
	});

	it('a slow mix reports the frames mixed of the range while it runs, then answers the measurement', async () => {
		const slow = await makeApp();
		const queue = coreServices(slow).queue;
		const mixer = halfwayMixer();
		const svc = new AudioService(coreServices(slow), mixer.mix);
		svc.registerRunners();
		const req = request(await toneDoc(slow), { type: 'sequence' });
		const { job, cached } = await svc.submitAnalysis(req);
		expect(cached).toBe(false);
		await mixer.halfway;
		const running = queue.get(job.id)!;
		expect(running.state).toBe('running');
		expect(running.stage).toBe('Mixing audio: frame 60 of 120');
		expect(running.progress).toBeGreaterThan(0.4);
		expect(running.progress).toBeLessThan(0.6);
		mixer.release();
		const done = await queue.wait(job.id);
		expect(done.state).toBe('succeeded');
		expect(done.result).toMatchObject({
			range: { startFrame: 0, endFrame: 120 },
			loudness: { durationSec: 4 },
		});
		const repeat = await svc.submitAnalysis(req);
		expect(repeat.cached).toBe(true);
		expect((await queue.wait(repeat.job.id)).result).toEqual(done.result);
	});

	it('cancelling a slow measurement stops its mix, and nothing of it is kept', async () => {
		const slow = await makeApp();
		const queue = coreServices(slow).queue;
		const mixer = halfwayMixer();
		const svc = new AudioService(coreServices(slow), mixer.mix);
		svc.registerRunners();
		const req = request(await toneDoc(slow), { type: 'sequence' });
		const { job } = await svc.submitAnalysis(req);
		await mixer.halfway;
		queue.cancel(job.id);
		expect((await queue.wait(job.id)).state).toBe('cancelled');
		const repeat = await svc.submitAnalysis(req);
		expect(repeat.cached).toBe(false);
		queue.cancel(repeat.job.id);
		expect((await queue.wait(repeat.job.id)).state).toBe('cancelled');
	});
});
