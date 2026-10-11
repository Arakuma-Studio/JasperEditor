// reframe.mp4 has a textured subject moving 7 px/frame through one jerky camera reframe; tests use no face model.
import type { ReframeResult } from '@jasper/api';
import { contentTimeAt, evaluate, smoothSubjectPath } from '@jasper/project';
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

/** The subject's centre on frame n (overlay x = 40 + 7n, y = 150, 144 × 208), normalised. */
const truth = (n: number): [number, number] => [(40 + 7 * n + 72) / 848, (150 + 104) / 480];

describe('Auto Reframe', () => {
	let res: ReframeResult;
	let mediaKey = '';
	it('follows the moving subject (saliency)', async () => {
		const m = await register(app, fixture('reframe.mp4'));
		mediaKey = m.mediaKey;
		const r = await app.inject({
			method: 'POST',
			url: '/api/reframe',
			headers: JSON_H,
			payload: { mediaKey, startFrame: 0, frameCount: 90 },
		});
		expect(r.statusCode, r.body).toBe(202);
		const done = await coreServices(app).queue.wait(r.json().id);
		expect(done.error, JSON.stringify(done.error)).toBeUndefined();
		res = done.result as ReframeResult;
		expect(res.frames).toBe(90);
		expect(res.source).toBe('saliency');
		const errs: number[] = [];
		for (let n = 2; n < 90; n++) errs.push(Math.abs(res.points[3 * n]! - truth(n)[0]));
		errs.sort((a, b) => a - b);
		const median = errs[Math.floor(errs.length / 2)]!;
		const p90 = errs[Math.floor(errs.length * 0.9)]!;
		expect(median, `median x error ${(median * 848).toFixed(0)} px`).toBeLessThan(0.06);
		expect(p90).toBeLessThan(0.15);
		const sm = smoothSubjectPath(res.points, res.frameDuration, 'default');
		expect(sm[80]![0]).toBeGreaterThan(sm[20]![0] + 0.3);
	}, 300_000);

	it('makes a 9:16 copy whose Position keeps the subject in frame', async () => {
		const m = await register(app, fixture('reframe.mp4'));
		const d = new DocBuilder();
		const mediaId = d.addMedia(m);
		d.tx([{ type: 'clip.place', source: { mediaId }, at: 0 }]);
		const clipId = d.clipIds().find((id) => d.doc.sequences[d.seqId]!.clips[id]!.kind === 'video')!;
		const before = Object.keys(d.doc.sequences).length;
		const out = d.tx([
			{
				type: 'sequence.autoReframe',
				sequenceId: d.seqId,
				width: 608,
				height: 1080,
				tracking: 'default',
				subjects: [{ clipId, start: res.start, frameDuration: res.frameDuration, points: res.points }],
			},
		]);
		const r = out.results[0] as { sequenceId: string; reframed: string[]; skipped: unknown[] };
		expect(Object.keys(d.doc.sequences).length).toBe(before + 1);
		expect(r.reframed).toHaveLength(1);
		const seq = d.doc.sequences[r.sequenceId]!;
		expect([seq.settings.width, seq.settings.height]).toEqual([608, 1080]);
		const c = seq.clips[r.reframed[0]!]! as unknown as {
			start: number;
			transform: {
				position: { keyframes: unknown[] };
				scale: { value: number };
				anchor: { value: [number, number] };
			};
		};
		expect(c.transform.position.keyframes.length).toBeGreaterThan(2);
		const s = c.transform.scale.value / 100;
		expect(s).toBeCloseTo(1080 / 480, 3);
		const rate = seq.settings.frameRate;
		// The sequence of the fixture runs at 30 fps like the media: frame n shows media frame n.
		let inside = 0;
		for (const n of [10, 30, 45, 60, 80]) {
			const pos = evaluate(c.transform.position as never, contentTimeAt(c as never, n, rate)) as [
				number,
				number,
			];
			const sx = pos[0] + (truth(n)[0] * 848 - c.transform.anchor.value[0]) * s;
			if (sx > 0.1 * 608 && sx < 0.9 * 608) inside++;
			expect(pos[0] - c.transform.anchor.value[0] * s).toBeLessThanOrEqual(0.5);
			expect(pos[0] + (848 - c.transform.anchor.value[0]) * s).toBeGreaterThanOrEqual(607.5);
		}
		expect(inside).toBeGreaterThanOrEqual(4);
	}, 300_000);
});
