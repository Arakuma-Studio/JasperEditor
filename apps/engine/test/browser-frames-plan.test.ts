// AGENTS §4: footage the render browser cannot decode (HEVC…) is read through FFmpeg in browser-drawn layers, by its
// frame timestamps when the frame rate is variable. A variable-frame-rate HEVC file in a container whose frame table
// the page cannot demux (FLV) is refused at plan time, naming the clip and the codec, when a layer the browser draws
// shows it — not a render that fails midway. The native path reads it as before.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlanError } from '../src/export/planner.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, fixture, makeApp, register, type TestApp, tempAppdir } from './helpers.ts';

const SOURCE = fixture('vfr-code-hevc.mp4');

const settings = (seqId: string) => ({
	sequenceId: seqId,
	range: { type: 'entire' },
	container: 'mp4',
	engine: 'auto',
	video: {
		codec: 'h264',
		width: 640,
		height: 360,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 18 },
		encoderSpeed: 'fast',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
});

describe.runIf(existsSync(SOURCE))('browser-drawn HEVC footage at plan time', () => {
	let app: TestApp;
	beforeAll(async () => {
		app = await makeApp();
	}, 120_000);
	afterAll(closeApps);

	async function doc(file: string, gpuEffect: boolean) {
		const d = new DocBuilder('hd-720p-30');
		const mediaId = d.addMedia(await register(app, file));
		const clip = d.tx([{ type: 'clip.place', source: { mediaId }, at: 0, matchSequence: 'keep', ref: '$c' }])
			.refs.$c!;
		if (gpuEffect) d.tx([{ type: 'effect.add', target: { clipId: clip }, effectId: 'jasper.bevel-edges' }]);
		return { d, clip };
	}
	const plan = (d: DocBuilder) =>
		coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId) as never,
		});

	it('refuses VFR HEVC in FLV under a GPU effect by clip and codec; MP4, or no browser-drawn layer, plan', async () => {
		const flv = join(tempAppdir('jasper-hevc-flv-'), 'phone.flv');
		const remux = spawnSync('ffmpeg', ['-v', 'error', '-i', SOURCE, '-c', 'copy', '-f', 'flv', flv]);
		expect(remux.status, String(remux.stderr)).toBe(0);

		const drawn = await doc(flv, true);
		const err = await plan(drawn.d).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(PlanError);
		expect((err as PlanError).code).toBe('MEDIA_UNDECODABLE');
		const blockers = ((err as PlanError).detail as { blockers: { itemId: string; reason: string }[] })
			.blockers;
		expect(blockers.map((b) => b.itemId)).toEqual([drawn.clip]);
		expect(blockers[0]!.reason).toMatch(/hevc/);

		await expect(plan((await doc(flv, false)).d)).resolves.toMatchObject({ plan: { path: 'native' } });
		await expect(plan((await doc(SOURCE, true)).d)).resolves.toMatchObject({ plan: { path: 'hybrid' } });
	});
});
