// The composite's base sliced in time (docs/wp-notes/export-performance.md §12, native.ts `drawStack`): an opaque,
// full-frame video is the base for its frames instead of a blend over the background, the layers below it are
// switched off there, and the composite is the same, frame for frame, as blending every layer.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExportResultSchema } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildNativeGraph } from '../src/export/native.ts';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	JSON_H,
	makeApp,
	register,
	TEST_FFMPEG,
	type TestApp,
} from './helpers.ts';

const OUT_W = 640;
const OUT_H = 360;
const FRAMES = 56;

let app: TestApp;
beforeAll(async () => {
	ensureFixtures();
	app = await makeApp();
}, 180_000);
afterAll(closeApps);

/**
 * 720p30, frames [0, 56): V1 solids on [0, 38) and [44, 56) (below); V2 full-frame `clip-a` on [2, 16), `clip-b` at 50 % on
 * [16, 28), `clip-a` at 60 % opacity on [28, 36), nothing on [36, 40), full-frame `clip-a` on [40, 56); V3 a solid at
 * 50 % scale and 50 % opacity on [8, 50) (above).
 */
async function doc() {
	const d = new DocBuilder('hd-720p-30');
	const a = d.addMedia(await register(app, fixture('clip-a.mp4')));
	const b = d.addMedia(await register(app, fixture('clip-b.mp4')));
	const place = (media: string, at: number, frames: number, from: number, ref: string) => ({
		type: 'clip.place',
		source: { mediaId: media },
		at,
		tracks: { video: 'V2' },
		sourceRange: { in: { sourceFrames: from }, out: { sourceFrames: from + frames } },
		ref,
	});
	const { refs } = d.tx([
		{ type: 'clip.addSolid', at: 0, duration: 38, track: 'V1', color: [0.9, 0.3, 0.1, 1] },
		{ type: 'clip.addSolid', at: 44, duration: 12, track: 'V1', color: [0.5, 0.1, 0.7, 1] },
		place(a, 2, 14, 5, '$a1'),
		place(b, 16, 12, 3, '$b'),
		place(a, 28, 8, 40, '$a3'),
		place(a, 40, 16, 90, '$a2'),
		{ type: 'clip.addSolid', at: 8, duration: 42, track: 'V3', color: [0.1, 0.8, 0.3, 1], ref: '$s3' },
	]);
	d.tx([
		{ type: 'param.set', target: ['clip', refs.$b, 'transform', 'scale'], value: 50 },
		{ type: 'param.set', target: ['clip', refs.$a3, 'opacity'], value: 60 },
		{ type: 'param.set', target: ['clip', refs.$s3, 'transform', 'scale'], value: 50 },
		{ type: 'param.set', target: ['clip', refs.$s3, 'opacity'], value: 50 },
	]);
	return d;
}

const settings = (seqId: string) => ({
	sequenceId: seqId,
	range: { type: 'custom', startFrame: 0, endFrame: FRAMES },
	container: 'mov',
	engine: 'native',
	video: {
		codec: 'prores',
		proresProfile: '4444',
		width: OUT_W,
		height: OUT_H,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 10 },
		encoderSpeed: 'fast',
	},
});

function decodeAll(file: string): Buffer[] {
	const r = spawnSync(
		TEST_FFMPEG,
		['-v', 'error', '-i', file, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
		{
			maxBuffer: 1 << 28,
		},
	);
	if (r.status !== 0) throw new Error(`decode failed: ${r.stderr}`);
	const size = OUT_W * OUT_H * 3;
	return Array.from({ length: r.stdout.length / size }, (_, i) =>
		r.stdout.subarray(i * size, (i + 1) * size),
	);
}

describe('composite base sliced in time (export-performance §12)', () => {
	it('opaque full-frame video spans are the base: lower layers off there, the same frames as blending them', async () => {
		const d = await doc();
		const planned = await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId) as never,
		});
		expect(planned.plan.path).toBe('native');
		// A background colour that shows where nothing covers it (frames 38, 39).
		planned.snapshot.settings.backgroundColor = [0.2, 0.4, 0.6, 1];
		const dir = mkdtempSync(join(tmpdir(), 'jasper-cbase-'));
		const graph = (coverBase: boolean) =>
			buildNativeGraph({
				snapshot: planned.snapshot,
				output: planned.output,
				outputFile: join(dir, `${coverBase ? 'base' : 'blend'}.mov`),
				sources: { media: (id) => planned.media[id] ?? null, mgMaster: () => null },
				threads: 2,
				extensions: { list: [], prepared: new Map() },
				coverBase,
			});
		const sliced = graph(true);
		const blended = graph(false);
		const overlays = (g: { filter: string }) => (g.filter.match(/overlay=/g) ?? []).length;
		// Every layer blended: the two solids below, the four V2 clips, the solid above.
		expect(overlays(blended)).toBe(7);
		// The two full-frame opaque spans are base pieces; the scaled and the translucent clip are still blended.
		expect(overlays(sliced)).toBe(5);
		// (the background colour before the first piece, then each piece padded with it up to the next)
		expect(sliced.filter).toMatch(/\[bgg\]\[bgp0\]\[bgp1\]concat=n=3:v=1:a=0,settb=1\/30,setpts=N\[bg\]/);
		// Each solid below is switched off on the frames of the piece above it; the solid above on none.
		const off = sliced.filter.split(';\n').filter((c) => c.includes('*not(between(t,'));
		expect(off).toHaveLength(2);
		expect(off.map((c) => c.match(/\*not\(/g)?.length)).toEqual([1, 1]);
		expect(off[0]).toMatch(/^\[bg\]/);
		expect(sliced.streams).toHaveLength(0);
		expect(blended.streams).toHaveLength(0);

		const run = (g: { args: string[] }) => {
			const r = spawnSync(TEST_FFMPEG, ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...g.args]);
			if (r.status !== 0) throw new Error(r.stderr.toString());
		};
		run(sliced);
		run(blended);
		const fa = decodeAll(join(dir, 'base.mov'));
		const fb = decodeAll(join(dir, 'blend.mov'));
		expect(fa).toHaveLength(FRAMES);
		expect(fb).toHaveLength(FRAMES);
		for (let f = 0; f < FRAMES; f++) expect(fa[f]!.equals(fb[f]!), `frame ${f}`).toBe(true);
	}, 300_000);

	it("the plan's overlay count is the built graph's: no overlay for base pieces, one per kernel stream", async () => {
		const d = await doc();
		// V4: three sub-pixel stills one after the other (one kernel stream)
		const still = d.addMedia(await register(app, fixture('still.png')));
		const { refs } = d.tx(
			[0, 18, 36].map((at, i) => ({
				type: 'clip.place',
				source: { mediaId: still },
				at,
				tracks: { video: 'V4' },
				sourceRange: { in: { seconds: 0 }, out: { seconds: (at === 36 ? 20 : 18) / 30 } },
				ref: `$st${i}`,
			})),
		);
		d.tx(
			Object.values(refs).flatMap((id, i) => [
				{ type: 'param.set', target: ['clip', id, 'transform', 'scale'], value: 30 },
				{ type: 'param.set', target: ['clip', id, 'transform', 'position'], value: [300.3 + i * 100, 200.7] },
			]),
		);
		const core = coreServices(app);
		const planned = await core.exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId) as never,
		});
		const r = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
		});
		expect(r.statusCode, r.body).toBe(202);
		const done = await core.queue.wait(r.json().id);
		expect(done.error, JSON.stringify(done.error)).toBeUndefined();
		const result = ExportResultSchema.parse(done.result);
		// 2 solids below + 2 blended V2 clips + the solid above + 1 kernel stream (10 layers)
		expect(result.pipeline?.overlays).toBe(6);
		expect(planned.plan.pipeline?.overlays).toBe(result.pipeline?.overlays);
	}, 300_000);
});
