import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EngineJob, type MaskTraceResponse, type TrackResult, TrackResultSchema } from '@jasper/api';
import {
	type BezierPath,
	evaluate,
	maskKeysFromTrack,
	pathCentroid,
	planMaskTrack,
	rectPath,
} from '@jasper/project';
import { LOSSLESS_VIDEO_ARGS } from '@jasper/testkit/fixture-video';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, JSON_H, makeApp, register, type TestApp } from './helpers.ts';

const W = 320;
const H = 240;
const N = 24;
/** Square's top-left at frame n (the plate's ground truth): 80×80 textured square moving (3, 1) px per frame. */
const at = (n: number): [number, number] => [40 + 3 * n, 60 + n];

let app: TestApp;
let key: string;
let rec: Awaited<ReturnType<typeof register>>;
let dir: string;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'jasper-masktrack-'));
	// lossless (FFV1 in MOV: exact frame times), the textured square's pixels exactly as drawn
	const file = join(dir, 'plate.mov');
	// A static texture (sums of sines, effectcraft's mask-tracker test pattern) moved by the overlay.
	const tex = join(dir, 'tex.png');
	execFileSync('ffmpeg', [
		...['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=80x80,format=gray'],
		...['-vf', "geq=lum='128+60*sin(X*0.37)*cos(Y*0.29)+40*sin((X+1.7*Y)*0.21)+25*sin(X*0.83-Y*0.61)'"],
		...['-frames:v', '1', tex],
	]);
	execFileSync('ffmpeg', [
		...['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=gray:s=${W}x${H}:r=30:d=${N / 30}`],
		...['-loop', '1', '-framerate', '30', '-i', tex],
		...['-filter_complex', `[0][1]overlay=x='40+3*n':y='60+n':shortest=1:format=rgb,format=yuv444p`],
		...[...LOSSLESS_VIDEO_ARGS, file],
	]);
	const png = join(dir, 'disc.png');
	// A white disc (r = 50) and a square with a hole on transparent: alpha trace fixture.
	execFileSync('ffmpeg', [
		...['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black@0:s=${W}x${H},format=rgba`],
		...[
			'-vf',
			"geq=r=255:g=255:b=255:a='if(lt(hypot(X-100,Y-120),50),255,if(between(X,200,280)*between(Y,60,180)*not(between(X,225,255)*between(Y,100,140)),255,0))'",
		],
		...['-frames:v', '1', png],
	]);
	app = await makeApp({ totalSlots: 4 });
	rec = await register(app, file);
	key = rec.mediaKey;
	(globalThis as { __disc?: string }).__disc = (await register(app, png)).mediaKey;
}, 240_000);
afterAll(closeApps);

async function track(body: Record<string, unknown>): Promise<TrackResult> {
	const r = await app.inject({ method: 'POST', url: '/api/tracking/track', headers: JSON_H, payload: body });
	expect(r.statusCode, r.body).toBe(202);
	const job = await coreServices(app).queue.wait((r.json() as EngineJob).id);
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	return TrackResultSchema.parse(job.result);
}

const square = (n: number, inset = 6): [number, number][] => {
	const [x, y] = at(n);
	return [
		[x + inset, y + inset],
		[x + 80 - inset, y + inset],
		[x + 80 - inset, y + 80 - inset],
		[x + inset, y + 80 - inset],
	];
};

describe('mask tracking jobs', () => {
	for (const method of ['position', 'position-scale-rotation', 'perspective'] as const)
		it(`${method}: follows the moving square forward (≤ 0.6 px)`, async () => {
			const res = await track({
				mediaKey: key,
				kind: 'mask',
				reference: { frame: 0, polygon: square(0) },
				range: { startFrame: 0, endFrame: N },
				direction: 'forward',
				options: { maskMethod: method },
			});
			expect(res.stride).toBe(9);
			expect(res.method).toBe('mask-klt@1');
			expect(res.lost).toEqual([]);
			for (let f = 1; f < N; f++) {
				const h = res.data.slice(f * 9, f * 9 + 9);
				const [x0, y0] = square(0)[0]!;
				const w = h[6]! * x0 + h[7]! * y0 + h[8]!;
				const x = (h[0]! * x0 + h[1]! * y0 + h[2]!) / w;
				const y = (h[3]! * x0 + h[4]! * y0 + h[5]!) / w;
				const want = square(f)[0]!;
				if (process.env.MASK_DEBUG) console.log(method, f, x - x0, y - y0, want[0] - x0, want[1] - y0);
				expect(Math.hypot(x - want[0], y - want[1]), `frame ${f}`).toBeLessThanOrEqual(0.6);
			}
		}, 120_000);

	it('backward from the last frame; the document round trip writes Mask Path keys', async () => {
		const d = new DocBuilder('hd-1080p-30');
		const m = d.addMedia(rec);
		d.tx([
			{ type: 'sequence.updateSettings', sequenceId: d.seqId, settings: { width: W, height: H } },
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: 0,
				sourceRange: { in: { flicks: 0 }, out: { sourceFrames: N } },
				tracks: { video: 'V1' },
				ref: '$c',
			},
		]);
		const clipId = Object.values(d.doc.sequences[d.seqId]!.clips).find((c) => c.kind === 'video')!.id;
		const [x, y] = at(N - 1);
		const r = d.tx([
			{
				type: 'mask.add',
				clipId,
				shape: 'polygon',
				path: rectPath((x + 6) / W, (y + 6) / H, (x + 74) / W, (y + 74) / H),
				ref: '$m',
			},
		]);
		const maskId = r.refs.$m!;
		const step = 705_600_000 / 30;
		const plan = planMaskTrack(d.doc, maskId, { mode: 'backward', at: (N - 1) * step, method: 'position' });
		expect(plan.request.direction).toBe('backward');
		const res = await track({ ...plan.request, mediaKey: key });
		const { keys, lostAt } = maskKeysFromTrack(plan, res);
		expect(lostAt).toBeNull();
		expect(keys).toHaveLength(N);
		d.tx([{ type: 'mask.setPathKeys', maskId, keys }]);
		const mask = (
			d.doc.sequences[d.seqId]!.clips[clipId] as {
				masks: { path: { value: BezierPath; keyframes: unknown[] } }[];
			}
		).masks[0]!;
		expect(mask.path.keyframes).toHaveLength(N);
		const c0 = pathCentroid(evaluate(mask.path as never, 0) as BezierPath);
		expect(Math.abs(c0[0] * W - (at(0)[0] + 40))).toBeLessThanOrEqual(0.6);
		expect(Math.abs(c0[1] * H - (at(0)[1] + 40))).toBeLessThanOrEqual(0.6);
	}, 120_000);

	it('rejects a mask track without a polygon', async () => {
		const r = await app.inject({
			method: 'POST',
			url: '/api/tracking/track',
			headers: JSON_H,
			payload: {
				mediaKey: key,
				kind: 'mask',
				reference: { frame: 0 },
				range: { startFrame: 0, endFrame: 4 },
			},
		});
		expect(r.statusCode).toBe(400);
	});
});

describe('POST /api/masks/trace', () => {
	it('traces the alpha of a still into a disc and a square with a hole', async () => {
		const r = await app.inject({
			method: 'POST',
			url: '/api/masks/trace',
			headers: JSON_H,
			payload: {
				mediaKey: (globalThis as { __disc?: string }).__disc,
				frame: 0,
				width: W,
				height: H,
				channel: 'alpha',
				cornerRoundness: 0,
			},
		});
		expect(r.statusCode, r.body).toBe(200);
		const body = r.json() as MaskTraceResponse;
		expect(body.total).toBe(3);
		expect(body.paths.filter((p) => p.depth === 1)).toHaveLength(1);
		const disc = body.paths.find((p) => p.depth === 0 && p.path.vertices.every((v) => v.p[0] < 0.5))!;
		const c = pathCentroid(disc.path as BezierPath);
		expect(Math.abs(c[0] * W - 100)).toBeLessThan(1.5);
		expect(Math.abs(c[1] * H - 120)).toBeLessThan(1.5);
	}, 60_000);
});
