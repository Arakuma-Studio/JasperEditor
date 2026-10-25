// shaky.mp4 pans a test chart by a seeded random walk, providing independent ground truth for stabilisation.
import type { WarpAnalysisResult } from '@jasper/api';
import { planOutputOf, WarpAnalysisDataSchema, warpPlanFor, warpSettingsOf } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
	app = await makeApp();
}, 120_000);
afterAll(closeApps);

/** The fixture's camera walk (same LCG as scripts/fixtures/process.mjs `randomWalk`). */
function walk(n: number, limit = 24, seed = 1234567, step = 6) {
	let s = seed >>> 0;
	const rnd = () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
	const xs: number[] = [];
	const ys: number[] = [];
	let x = 0;
	let y = 0;
	for (let i = 0; i < n; i++) {
		x = Math.max(-limit, Math.min(limit, x + Math.round((rnd() * 2 - 1) * step)));
		y = Math.max(-limit, Math.min(limit, y + Math.round((rnd() * 2 - 1) * step)));
		xs.push(x);
		ys.push(y);
	}
	return { xs, ys };
}

describe('Warp Stabilizer analysis', () => {
	it('analyses the camera walk, stabilises it and refuses exports until that analysis is present', async () => {
		const shaky = await register(app, fixture('shaky.mp4'));
		const r = await app.inject({
			method: 'POST',
			url: '/api/warp-analysis',
			headers: JSON_H,
			payload: { mediaKey: shaky.mediaKey, mediaId: 'med_s', startFrame: 0, frameCount: 90 },
		});
		expect(r.statusCode, r.body).toBe(202);
		const done = await coreServices(app).queue.wait(r.json().id);
		expect(done.error, JSON.stringify(done.error)).toBeUndefined();
		const analysis = done.result as WarpAnalysisResult;
		expect(analysis.analysedFrames).toBe(90);
		expect(analysis.size).toEqual([1920, 1080]);
		expect(WarpAnalysisDataSchema.safeParse(analysis).success).toBe(true);
		// The crop moves by Δ walk, so the content moves by −Δ.
		const w = walk(90);
		let bad = 0;
		let maxErr = 0;
		for (let k = 1; k < 90; k++) {
			const o = k * 14;
			const ex = -(w.xs[k]! - w.xs[k - 1]!);
			const ey = -(w.ys[k]! - w.ys[k - 1]!);
			const e = Math.hypot(analysis.frames[o]! - ex, analysis.frames[o + 1]! - ey);
			const eh = Math.hypot(analysis.frames[o + 8]! - ex, analysis.frames[o + 11]! - ey);
			maxErr = Math.max(maxErr, e, eh);
			if (e > 0.75 || eh > 0.75) bad++;
		}
		expect(bad, `max error ${maxErr.toFixed(2)} px`).toBeLessThanOrEqual(2);
		expect(analysis.tracks!.length).toBeGreaterThan(40);
		expect(analysis.confidence!).toBeGreaterThan(0.8);

		// Applying the stored analysis holds the authored scene still.
		const a = analysis as never;
		// A scene point at the centre of frame 0 is at centre − (walk − walk0) on frame k.
		const at = (k: number): [number, number] => [960 - (w.xs[k]! - w.xs[0]!), 540 - (w.ys[k]! - w.ys[0]!)];
		for (const method of ['position', 'perspective', 'subspaceWarp'] as const) {
			const plan = warpPlanFor(a, {
				...warpSettingsOf({ method, result: 'noMotion', framing: 'stabilizeOnly' }, 30),
			});
			const outs = Array.from({ length: 90 }, (_, k) => planOutputOf(plan, k, at(k))!);
			const spread = Math.max(...outs.map((p) => Math.hypot(p[0] - outs[45]![0], p[1] - outs[45]![1])));
			expect(spread, method).toBeLessThan(method === 'subspaceWarp' ? 2.5 : 1.5);
		}

		// The planner refuses the effect until that analysis is attached.
		const d = new DocBuilder();
		const m = d.addMedia(shaky);
		d.tx([{ type: 'clip.place', source: { mediaId: m }, at: 0 }]);
		const clipId = d.clipIds().find((id) => d.doc.sequences[d.seqId]!.clips[id]!.kind === 'video')!;
		d.tx([{ type: 'effect.add', target: { clipId }, effectId: 'jasper.warp-stabilizer' }]);
		const s = d.doc.sequences[d.seqId]!.settings;
		const settings = {
			sequenceId: d.seqId,
			range: { type: 'custom', startFrame: 0, endFrame: 8 },
			container: 'mp4',
			video: {
				codec: 'h264',
				width: s.width,
				height: s.height,
				frameRate: s.frameRate,
				scaling: 'fit',
				quality: { mode: 'crf', value: 20 },
				encoderSpeed: 'fast',
			},
			audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
			engine: 'auto',
		};
		const plan = () =>
			app.inject({
				method: 'POST',
				url: '/api/exports/plan',
				headers: JSON_H,
				payload: { envelope: d.envelope(), sequenceId: d.seqId, settings },
			});
		const refused = await plan();
		expect(refused.statusCode, refused.body).toBe(409);
		expect(refused.json().code ?? refused.json().error?.code).toBe('WARP_NOT_ANALYZED');
		const fx = (d.doc.sequences[d.seqId]!.clips[clipId] as unknown as { effects: { id: string }[] })
			.effects[0]!;
		const { analysedFrames: _a, framesPerSec: _f, ...stored } = analysis;
		d.tx([{ type: 'effect.setWarpAnalysis', effectInstanceId: fx.id, analysis: stored }]);
		const ok = await plan();
		expect(ok.statusCode, ok.body).toBe(200);
		expect(ok.json().warnings.map((w: { code: string }) => w.code)).not.toContain('WARP_PARTIAL');
	}, 300_000);
});
