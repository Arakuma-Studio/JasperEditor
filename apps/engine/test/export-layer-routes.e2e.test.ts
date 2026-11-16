// Layer routes (layer-routes.ts, REMOTION_E2E=1: FFmpeg and a Chrome with HTML-in-Canvas): an `auto` export whose only
// native blockers are adjustment layers renders those spans split at them — native plate, the adjustment track on
// Remotion over it, the layers above natively — and the rest natively. Checked against a native export of the same
// sequence without the adjustment layer (everywhere outside the adjustment's crop), at the span edge (the frame before
// the span against its first frame), and against a full Remotion export inside the spans of a stack both renderers
// draw alike (solids and a title; a picture such as chart.png already differs between them).
import { spawnSync } from 'node:child_process';
import { ExportResultSchema } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import { DocBuilder, ensureFixtures, fixture, JSON_H, register } from './helpers.ts';
import { tempAppdir } from './temp.ts';

const W = 1280;
const H = 720;
let engine: RunningEngine;
const host = () => ({ host: `127.0.0.1:${engine.port}` });

beforeAll(async () => {
	if (process.env.REMOTION_E2E !== '1') return;
	ensureFixtures();
	// A listening engine: the render browser fetches the signed media, font and plate URLs over HTTP.
	engine = await startEngine({
		appdir: tempAppdir(),
		port: Number(process.env.JASPER_E2E_PORT ?? 0),
		insecure: true,
		dev: true,
		env: {
			PATH: process.env.PATH,
			...(process.env.JASPER_BROWSER_EXECUTABLE
				? { JASPER_BROWSER_EXECUTABLE: process.env.JASPER_BROWSER_EXECUTABLE }
				: {}),
		},
	});
}, 600_000);
afterAll(async () => {
	await engine?.stop();
});

async function exportOf(d: DocBuilder, engineChoice: 'auto' | 'remotion' | 'native') {
	const r = await engine.app.inject({
		method: 'POST',
		url: '/api/exports',
		headers: { ...JSON_H, ...host() },
		payload: {
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: {
				sequenceId: d.seqId,
				range: { type: 'entire' },
				container: 'mov',
				engine: engineChoice,
				video: {
					codec: 'prores',
					proresProfile: '4444',
					width: W,
					height: H,
					frameRate: { num: 30, den: 1 },
					scaling: 'fit',
					quality: { mode: 'crf', value: 10 },
					encoderSpeed: 'fast',
				},
			},
		},
	});
	expect(r.statusCode, r.body).toBe(202);
	const core = coreServices(engine.app);
	const t0 = performance.now();
	const done = await core.queue.wait(r.json().id);
	expect(done.error, JSON.stringify(done.error)).toBeUndefined();
	const result = ExportResultSchema.parse(done.result);
	if (process.env.LAYER_ROUTES_DEBUG_DIR) {
		const { copyFileSync } = await import('node:fs');
		copyFileSync(
			(await core.exports.outputFile(r.json().id))!,
			`${process.env.LAYER_ROUTES_DEBUG_DIR}/${engineChoice}-${d.seqId}.mov`,
		);
	}
	console.info(
		`[layer-routes] ${engineChoice}: ${result.renderPath}, ${Math.round(performance.now() - t0)} ms`,
	);
	return { result, file: (await core.exports.outputFile(r.json().id))! };
}

/** Frame `n` of a file as RGB bytes. */
function frameOf(file: string, n: number): Buffer {
	const r = spawnSync(
		'ffmpeg',
		[
			'-v',
			'error',
			'-i',
			file,
			'-vf',
			`select=eq(n\\,${n})`,
			'-frames:v',
			'1',
			'-f',
			'rawvideo',
			'-pix_fmt',
			'rgb24',
			'-',
		],
		{ maxBuffer: 64 << 20 },
	);
	expect(r.status, String(r.stderr)).toBe(0);
	expect(r.stdout.length).toBe(W * H * 3);
	return r.stdout;
}

/** Share of the channel values of `a` and `b` (in columns [x0, x1)) that differ by at most `tol`. */
function within(a: Buffer, b: Buffer, tol: number, x0 = 0, x1 = W): number {
	let ok = 0;
	let all = 0;
	for (let y = 0; y < H; y++)
		for (let x = x0; x < x1; x++)
			for (let c = 0; c < 3; c++) {
				const i = (y * W + x) * 3 + c;
				all++;
				if (Math.abs(a[i]! - b[i]!) <= tol) ok++;
			}
	return ok / all;
}

async function chart(d: DocBuilder) {
	return d.addMedia(await register(engine.app, fixture('chart.png'), host()));
}

describe.runIf(process.env.REMOTION_E2E === '1')('layer routes', { timeout: 1_800_000 }, () => {
	it('an adjustment span is split at its layer: native pixels outside its effect, no jump at its edges', async () => {
		const d = new DocBuilder('hd-720p-30');
		const c = await chart(d);
		const base = [
			{
				type: 'clip.place',
				source: { mediaId: c },
				at: 0,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 3 } },
			},
			// a title across the span edges, drawn natively (its bake) on both sides
			{ type: 'clip.addText', at: 0, duration: 90, track: 'V3', content: { text: 'Edge parity' } },
		];
		d.tx(base);
		const plain = new DocBuilder('hd-720p-30');
		plain.doc = structuredClone(d.doc);
		plain.revision = d.revision;
		// Offset (no native path on adjustment layers) on the right half only (its crop)
		d.tx([
			{ type: 'clip.addAdjustment', at: 30, duration: 30, track: 'V2', ref: '$fx' },
			{
				type: 'effect.add',
				target: { clipId: '$fx' },
				effectId: 'jasper.offset',
				params: { shiftCenterTo: [0.8, 0.6] },
			},
			{ type: 'effect.add', target: { clipId: '$fx' }, effectId: 'jasper.crop', params: { left: 50 } },
		]);
		const routed = await exportOf(d, 'auto');
		expect(routed.result.renderPath).toBe('hybrid');
		expect(routed.result.warnings?.find((w) => w.code === 'LAYER_ROUTE_FALLBACK')).toBeUndefined();
		const native = await exportOf(plain, 'native');
		for (const n of [10, 29, 60, 85])
			expect(within(frameOf(routed.file, n), frameOf(native.file, n), 0), `frame ${n}`).toBe(1);
		// inside the span: the native picture outside the crop, the effect inside it
		for (const n of [30, 45, 59]) {
			const [a, b] = [frameOf(routed.file, n), frameOf(native.file, n)];
			expect(within(a, b, 2, 0, W / 2 - 8), `frame ${n}`).toBeGreaterThanOrEqual(0.999);
			expect(within(a, b, 3, W / 2 + 8, W), `frame ${n}`).toBeLessThan(0.9);
		}
		// span edge: outside the crop the picture is static, so the frame before the span equals its first frame
		expect(
			within(frameOf(routed.file, 29), frameOf(routed.file, 30), 2, 0, W / 2 - 8),
		).toBeGreaterThanOrEqual(0.999);
		expect(
			within(frameOf(routed.file, 60), frameOf(routed.file, 59), 2, 0, W / 2 - 8),
		).toBeGreaterThanOrEqual(0.999);
	});

	it('1 native, 2 adjustment on Remotion, 3 native, 4 a baked title, 5 adjustment on Remotion, 6 native on top', async () => {
		const d = new DocBuilder('hd-720p-30');
		d.tx([
			{ type: 'clip.addSolid', at: 0, duration: 150, track: 'V1', color: [0.1, 0.7, 0.2, 1], ref: '$s1' },
			{ type: 'param.set', target: ['clip', '$s1', 'transform', 'scale'], value: 50 },
			{ type: 'param.set', target: ['clip', '$s1', 'transform', 'position'], value: [400, 300] },
			{ type: 'clip.addAdjustment', at: 50, duration: 50, track: 'V2', ref: '$a2' },
			{ type: 'effect.add', target: { clipId: '$a2' }, effectId: 'jasper.mirror', params: {} },
			{ type: 'clip.addSolid', at: 0, duration: 150, track: 'V3', color: [1, 0, 0, 1], ref: '$s3' },
			{ type: 'param.set', target: ['clip', '$s3', 'transform', 'scale'], value: 25 },
			{ type: 'clip.addText', at: 0, duration: 150, track: 'V4', content: { text: 'Clip type' } },
			{ type: 'clip.addAdjustment', at: 50, duration: 50, track: 'V5', ref: '$a5' },
			{
				type: 'effect.add',
				target: { clipId: '$a5' },
				effectId: 'jasper.offset',
				params: { shiftCenterTo: [0.65, 0.5] },
			},
			{ type: 'clip.addSolid', at: 0, duration: 150, track: 'V6', color: [0, 0, 1, 1], ref: '$s6' },
			{ type: 'param.set', target: ['clip', '$s6', 'opacity'], value: 30 },
		]);
		const routed = await exportOf(d, 'auto');
		expect(routed.result.renderPath).toBe('hybrid');
		expect(routed.result.warnings?.some((w) => w.code === 'LAYER_ROUTE_FALLBACK')).toBeFalsy();
		const remotion = await exportOf(d, 'remotion');
		for (const n of [50, 75, 99])
			expect(
				within(frameOf(routed.file, n), frameOf(remotion.file, n), 3),
				`frame ${n}`,
			).toBeGreaterThanOrEqual(0.99);
	});
});
