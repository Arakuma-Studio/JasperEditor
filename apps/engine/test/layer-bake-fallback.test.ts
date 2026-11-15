// A layer bake that keeps failing (layer-bake extension retries, service.ts `renderAroundFailedLayers`): it is baked
// again in a browser of its own, then only the frames its layer is drawn on render on the Remotion path; the rest of
// the range stays native and the result warns with the clip, its frames and the bake's error.
import { spawnSync } from 'node:child_process';
import { ExportResultSchema } from '@jasper/api';
import type { RenderSnapshot } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { JobError } from '../src/jobs/types.ts';
import type { LayerBakeService } from '../src/layer-bake/service.ts';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	JSON_H,
	makeApp,
	register,
	type TestApp,
} from './helpers.ts';

let app: TestApp;
beforeAll(async () => {
	ensureFixtures();
	app = await makeApp({ totalSlots: 4 });
}, 180_000);
afterAll(closeApps);

describe('a failed layer bake', { timeout: 600_000 }, () => {
	it('is baked again, then renders only its frames on the Remotion path and warns with the clip', async () => {
		const d = new DocBuilder('hd-720p-30');
		const [a, b] = await Promise.all(
			['clip-a.mp4', 'clip-b.mp4'].map(async (f) => d.addMedia(await register(app, fixture(f)))),
		);
		d.tx([
			{
				type: 'clip.place',
				source: { mediaId: a! },
				at: 0,
				sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 75 } },
			},
			{
				type: 'clip.place',
				source: { mediaId: b! },
				at: 75,
				sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 75 } },
			},
			{ type: 'clip.addText', at: 60, duration: 30, track: 'V2', content: { text: 'dev (1)' } },
		]);
		const core = coreServices(app);
		const bakes = app.jasper.services.layerBake as LayerBakeService;
		// The renderer is a test double: the bake fails as the user's did, the Remotion path draws a solid
		vi.spyOn(core.remotion, 'state').mockReturnValue('ready');
		vi.spyOn(bakes, 'unavailableReason').mockReturnValue(null);
		vi.spyOn(bakes, 'environment').mockResolvedValue({
			bundleId: 'b1',
			animejs: '4.5.0',
			remotion: '4.0.499',
			browser: 'test',
			gl: 'swangle',
		});
		const ensureBake = vi
			.spyOn(bakes, 'ensureBake')
			.mockRejectedValue(
				new JobError('RENDER_FAILED', 'Invalid message: {"type":"response-success","frame":{}}', true),
			);
		const remotionRanges: { start: number; end: number }[] = [];
		vi.spyOn(core.remotion, 'renderMedia').mockImplementation(async (input) => {
			const doc = (input.inputProps as { doc: RenderSnapshot }).doc;
			remotionRanges.push(doc.range);
			const frames = doc.range.end - doc.range.start;
			const { width, height } = doc.settings;
			const r = spawnSync('ffmpeg', [
				'-v',
				'error',
				'-f',
				'lavfi',
				'-i',
				`color=c=blue:s=${width}x${height}:r=30`,
				'-frames:v',
				String(frames),
				'-c:v',
				'prores_ks',
				'-profile:v',
				'3',
				'-y',
				input.output,
			]);
			expect(r.status, String(r.stderr)).toBe(0);
			return { frames };
		});
		const r = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: {
					sequenceId: d.seqId,
					range: { type: 'custom', startFrame: 0, endFrame: 150 },
					container: 'mp4',
					engine: 'auto',
					video: {
						codec: 'h264',
						width: 640,
						height: 360,
						frameRate: { num: 30, den: 1 },
						scaling: 'fit',
						quality: { mode: 'crf', value: 23 },
						encoderSpeed: 'fast',
					},
				},
			},
		});
		expect(r.statusCode, r.body).toBe(202);
		const done = await core.queue.wait(r.json().id);
		expect(done.error, JSON.stringify(done.error)).toBeUndefined();
		const result = ExportResultSchema.parse(done.result);
		expect(result.frames).toBe(150);
		// retried, then only the title's frames left the native path
		expect(ensureBake).toHaveBeenCalledTimes(3);
		expect(ensureBake.mock.calls.slice(1).every(([, meta]) => meta.browserGroup === undefined)).toBe(true);
		expect(remotionRanges).toEqual([{ start: 60, end: 90 }]);
		expect(result.renderPath).toBe('hybrid');
		const warning = result.warnings?.find((w) => w.code === 'LAYER_BAKE_FALLBACK');
		expect(warning?.message).toMatch(
			/"dev \(1\)" \(frames 60–90\) failed 3 times: RENDER_FAILED: .*Invalid message/,
		);
	});
});
