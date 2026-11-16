// Per-span routing (routing.ts, layer-routes.ts): an `auto` export whose only native blocker is an adjustment layer
// over a short span plans the native path for the rest, with that span alone on Remotion, split at the layer.
import { RenderPlanSchema } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spanRuns } from '../src/export/routing.ts';
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
	app = await makeApp();
}, 180_000);
afterAll(closeApps);

describe('per-span routing', () => {
	it('a Remotion-only adjustment layer over 30 of 150 frames leaves the rest of the export native', async () => {
		const d = new DocBuilder('hd-720p-30');
		const a = d.addMedia(await register(app, fixture('clip-a.mp4')));
		const { refs } = d.tx([
			{
				type: 'clip.place',
				source: { mediaId: a },
				at: 0,
				sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 150 } },
			},
			{ type: 'clip.addAdjustment', at: 60, duration: 30, track: 'V2', ref: '$fx' },
			{ type: 'effect.add', target: { clipId: '$fx' }, effectId: 'jasper.mirror', params: {} },
		]);
		const r = await app.inject({
			method: 'POST',
			url: '/api/exports/plan',
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
						width: 1280,
						height: 720,
						frameRate: { num: 30, den: 1 },
						scaling: 'fit',
						quality: { mode: 'crf', value: 20 },
						encoderSpeed: 'fast',
					},
				},
			},
		});
		expect(r.statusCode, r.body).toBe(200);
		const plan = RenderPlanSchema.parse(r.json());
		expect(plan.path).toBe('hybrid');
		expect(plan.paths).toEqual({ native: 120, remotion: 30, spans: 1 });
		expect(plan.segments.map((s) => [s.startFrame, s.endFrame, s.mode])).toEqual([
			[0, 60, 'native'],
			[60, 90, 'remotion'],
			[90, 150, 'native'],
		]);
		// every reason stays in the plan; the warning names the span, why, and that it is split at the layer
		expect(plan.blockers.map((b) => b.itemId)).toContain(refs.$fx);
		const w = plan.warnings.find((x) => x.code === 'REMOTION_SPANS');
		expect(w?.message).toMatch(/frames 60–90\. Why: .+\. 1 span split at its adjustment layers/);
	});

	it('merges spans closer than a pair of pieces costs, and keeps the run count bounded', () => {
		const cost = { remotionFps: 2.5, nativeFps: 8, nativeRunSec: 4, remotionRunSec: 8, maxRuns: 5 };
		// a 10-frame gap is cheaper on Remotion than two more pieces; a 2,000-frame one is not
		const near = spanRuns(
			{ start: 0, end: 10_000 },
			[
				{ start: 1000, end: 1100 },
				{ start: 1110, end: 1200 },
			],
			cost,
		);
		expect(near?.runs.map((x) => [x.start, x.end, x.kind === 'render' && x.engine])).toEqual([
			[0, 1000, undefined],
			[1000, 1200, 'remotion'],
			[1200, 10_000, undefined],
		]);
		const many = spanRuns(
			{ start: 0, end: 10_000 },
			Array.from({ length: 6 }, (_, i) => ({ start: 1000 + i * 1000, end: 1100 + i * 1000 })),
			cost,
		);
		expect(many!.runs.length).toBeLessThanOrEqual(5);
		// Remotion over most of the range: the whole range on Remotion is cheaper
		expect(spanRuns({ start: 0, end: 1000 }, [{ start: 0, end: 990 }], cost)).toBeNull();
	});
});
