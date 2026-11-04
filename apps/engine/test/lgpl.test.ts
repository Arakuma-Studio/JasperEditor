import { spawnSync } from 'node:child_process';
import { RenderPlanSchema } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	H,
	JSON_H,
	makeApp,
	register,
	type TestApp,
} from './helpers.ts';

let app: TestApp;
beforeAll(async () => {
	ensureFixtures();
	app = await makeApp({ env: { JASPER_FFMPEG_LGPL_ONLY: '1' } });
});
afterAll(closeApps);

function probe(file: string) {
	const r = spawnSync('ffprobe', [
		'-v',
		'error',
		'-count_frames',
		'-show_entries',
		'stream=codec_type,codec_name,width,height,nb_read_frames,pix_fmt,color_space,sample_rate,channels:format=format_name',
		'-of',
		'json',
		file,
	]);
	return JSON.parse(r.stdout.toString()) as {
		streams: Record<string, string | number>[];
		format: { format_name: string };
	};
}

const settings = (seqId: string) => ({
	sequenceId: seqId,
	range: { type: 'custom', startFrame: 0, endFrame: 45 },
	container: 'mp4',
	video: {
		codec: 'h264',
		width: 640,
		height: 360,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 23 },
		encoderSpeed: 'fast',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
	engine: 'native',
});

describe('LGPL-only mode (JASPER_FFMPEG_LGPL_ONLY=1)', () => {
	it('plans and runs a real native export with an LGPL-compatible encoder', async () => {
		const clipA = await register(app, fixture('clip-a.mp4'));
		const still = await register(app, fixture('still.png'));
		const d = new DocBuilder();
		const a = d.addMedia(clipA);
		const s = d.addMedia(still);
		const placed = d.tx([
			{ type: 'clip.place', source: { mediaId: a }, at: 0 },
			{ type: 'clip.place', source: { mediaId: s }, at: 10, tracks: { video: 'V2' }, ref: '$s' },
		]);
		d.tx([{ type: 'param.set', target: ['clip', placed.refs.$s!, 'transform', 'scale'], value: 40 }]);

		const planRes = await app.inject({
			method: 'POST',
			url: '/api/exports/plan',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
		});
		expect(planRes.statusCode).toBe(200);
		const plan = RenderPlanSchema.parse(planRes.json());
		expect(plan.path).toBe('native');
		const chosen = plan.encoder!;
		expect(chosen.gpl).toBe(false);
		expect(chosen.encoder).not.toBe('libx264');
		if (chosen.codec !== 'h264') expect(plan.warnings.map((w) => w.code)).toContain('ENCODER_FALLBACK');

		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: settings(d.seqId),
				planId: plan.planId,
			},
		});
		expect(start.statusCode).toBe(202);
		const done = await coreServices(app).queue.wait(start.json().id);
		expect(done.error).toBeUndefined();
		expect(done.state).toBe('succeeded');
		const result = done.result as { frames: number; encoder: string; container: string; renderPath: string };
		expect(result).toMatchObject({
			frames: 45,
			renderPath: 'native',
			encoder: chosen.encoder,
			container: chosen.container,
		});

		const file = (await coreServices(app).exports.outputFile(start.json().id))!;
		expect(file.endsWith(`.${chosen.container}`)).toBe(true);
		const info = probe(file);
		const v = info.streams.find((x) => x.codec_type === 'video')!;
		const au = info.streams.find((x) => x.codec_type === 'audio')!;
		expect(v).toMatchObject({
			codec_name: chosen.codec,
			width: 640,
			height: 360,
			pix_fmt: 'yuv420p',
			nb_read_frames: '45',
		});
		expect(au).toMatchObject({
			codec_name: chosen.audioEncoder === 'libopus' ? 'opus' : 'aac',
			sample_rate: '48000',
			channels: 2,
		});
		expect(info.format.format_name).toContain(chosen.container === 'webm' ? 'webm' : 'mp4');
	}, 120_000);

	it('makes proxies with an LGPL-compatible encoder (MP4)', async () => {
		const m = await register(app, fixture('clip-b.mp4'));
		const core = coreServices(app);
		const rec = core.registry.get(m.mediaKey)!;
		const choice = core.encoders.select({ purpose: 'proxy' })!;
		expect(choice.gpl).toBe(false);
		const [job] = core.derivatives.request(rec, ['proxy-540'], { priority: 'user' });
		const done = await core.queue.wait(job!.id);
		expect(done.error).toBeUndefined();
		expect(done.state).toBe('succeeded');
		const file = core.derivatives.paths(rec.fingerprint, 'proxy-540').main;
		const info = probe(file);
		const v = info.streams.find((x) => x.codec_type === 'video')!;
		expect(v.codec_name).toBe(choice.codec);
		expect(Number(v.height)).toBeLessThanOrEqual(540);
		expect(info.format.format_name).toContain('mp4');
		const r = await app.inject({ method: 'GET', url: `/api/media/${m.mediaKey}`, headers: H });
		expect(r.json().derivatives?.['proxy-540']?.state).toBe('ready');
	}, 120_000);
});
