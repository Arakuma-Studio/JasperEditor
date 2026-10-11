// Colour grading on the engine (S06 §9 tests 2, 3, 5; CG-050…055, LUT-001): `.cube` assets, the colour native
// extension (baked lut3d runs, per-frame windows for keyframed grades), native still parity with the TypeScript
// reference on the test chart, and the GPL-filter scan of the generated filter text.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	applyLut,
	bakeColorRun,
	defaultEffectRegistry,
	LUMETRI_EFFECT_ID,
	type Lut,
	parseCube,
	type Rgb,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildNativeGraph } from '../src/export/native.ts';
import { prepareExtensions } from '../src/export/native-ext.ts';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	H,
	JSON_H,
	makeApp,
	ROOT,
	register,
	type TestApp,
} from './helpers.ts';

let app: TestApp;
beforeAll(async () => {
	ensureFixtures();
	app = await makeApp();
}, 180_000);
afterAll(closeApps);

const FFMPEG = (() => {
	const vendor = join(ROOT, 'vendor', 'ffmpeg-lgpl', 'linux-x64', 'ffmpeg');
	return process.env.JASPER_FFMPEG || (spawnSync(vendor, ['-version']).status === 0 ? vendor : 'ffmpeg');
})();

/** Decodes an image/video frame to packed RGB (8-bit). */
function rgbOf(file: string, frame = 0): { data: Buffer; width: number; height: number } {
	const probe = spawnSync(FFMPEG.replace(/ffmpeg$/, 'ffprobe'), [
		...['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0'],
		file,
	]);
	const [width, height] = probe.stdout.toString().trim().split(',').map(Number) as [number, number];
	const r = spawnSync(
		FFMPEG,
		[
			...['-v', 'error', '-i', file],
			...['-vf', `select=eq(n\\,${frame}),scale=in_color_matrix=bt709:flags=accurate_rnd+full_chroma_int`],
			...['-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
		],
		{ maxBuffer: 1 << 28 },
	);
	return { data: r.stdout, width, height };
}

/** Per-channel |a − b| statistics in 8-bit code values. */
function diffStats(a: Buffer, b: Buffer) {
	const hist = new Array<number>(256).fill(0);
	let sum = 0;
	for (let i = 0; i < a.length; i++) {
		const d = Math.abs(a[i]! - b[i]!);
		hist[d]!++;
		sum += d;
	}
	const n = a.length;
	let acc = 0;
	let p995 = 0;
	for (let d = 0; d < 256; d++) {
		acc += hist[d]!;
		if (acc / n >= 0.995) {
			p995 = d;
			break;
		}
	}
	let max = 0;
	for (let d = 255; d >= 0; d--)
		if (hist[d]) {
			max = d;
			break;
		}
	return { max, p995, mean: sum / n, exact: hist[0]! / n, within1: (hist[0]! + hist[1]!) / n };
}

/** `applyLut` of a baked LUT on decoded RGB (the TS reference of S06 §9.3). */
function reference(src: Buffer, lut: Lut): Buffer {
	const out = Buffer.alloc(src.length);
	const c: Rgb = [0, 0, 0];
	for (let i = 0; i < src.length; i += 3) {
		c[0] = src[i]! / 255;
		c[1] = src[i + 1]! / 255;
		c[2] = src[i + 2]! / 255;
		applyLut(lut, c);
		out[i] = Math.round(c[0] * 255);
		out[i + 1] = Math.round(c[1] * 255);
		out[i + 2] = Math.round(c[2] * 255);
	}
	return out;
}

/** A representative grade (S06 §9.3): basic correction, look LUT at 80 %, curves and wheels. */
const GRADE = (look: string) => ({
	temperature: -30,
	tint: 6,
	exposure: 0.3,
	contrast: 15,
	highlights: -25,
	shadows: 30,
	whites: 4,
	blacks: -3,
	saturation: 115,
	look: { mediaId: look },
	lookIntensity: 80,
	vibrance: 15,
	curveMaster: {
		curve: [
			[0, 0.02],
			[0.5, 0.52],
			[1, 0.98],
		],
	},
	midtonesWheel: [0.1, 0.2],
	shadowsLevel: 4,
});

async function stillOf(d: DocBuilder, frame: number): Promise<{ file: string; renderPath: string }> {
	const r = await app.inject({
		method: 'POST',
		url: '/api/stills',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, frame },
	});
	expect(r.statusCode).toBe(202);
	const done = await coreServices(app).queue.wait(r.json().id);
	expect(done.error).toBeUndefined();
	const png = await app.inject({ method: 'GET', url: `/renders/${r.json().id}/output`, headers: H });
	const f = join(mkdtempSync(join(tmpdir(), 'jasper-color-')), 'still.png');
	writeFileSync(f, png.rawPayload);
	return { file: f, renderPath: (done.result as { renderPath: string }).renderPath };
}

const settings = (seqId: string, engine = 'auto') => ({
	sequenceId: seqId,
	range: { type: 'entire' },
	container: 'mp4',
	video: {
		codec: 'h264',
		width: 1920,
		height: 1080,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 12 },
		encoderSpeed: 'fast',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
	engine,
});

// Filter names absent from the shipped LGPL FFmpeg (ARCHITECTURE D-13).
const GPL_FILTER =
	/(?:^|[,;\]\s])(?:eq|hqdn3d|perspective|boxblur|smartblur|delogo|frei0r|spp|pp7|uspp|fspp|mpdecimate|pullup)(?==|,|;|\[|$)/im;

describe('LUT assets (S06:LUT-001, §9 test 2)', () => {
	it('registers a vendor-style 33³ .cube as kind lut with its header', async () => {
		const m = await register(app, fixture('look-33.cube'));
		expect(m.kind).toBe('lut');
		expect(m.lut).toEqual({
			format: 'cube',
			dimensions: 3,
			size: 33,
			title: 'Warm Teal 33',
			domainMin: [0, 0, 0],
			domainMax: [1, 1, 1],
		});
		// Served like any media file (the client parses it once per session, LUT-003).
		const f = await app.inject({ method: 'GET', url: `/media/${m.mediaKey}`, headers: H });
		expect(f.statusCode).toBe(200);
		expect(f.body).toBe(readFileSync(fixture('look-33.cube'), 'utf8'));
	});

	it('registers a 1D LUT (LUT-004)', async () => {
		const m = await register(app, fixture('tone-1d.cube'));
		expect(m.lut).toMatchObject({ dimensions: 1, size: 1024, title: 'S-curve 1D' });
	});

	it('rejects broken files with the parser line number', async () => {
		for (const [name, line] of [
			['broken-number.cube', 7],
			['broken-count.cube', 6], // "Expected 8 table entries, found 3" at the end of the file
		] as const) {
			const r = await app.inject({
				method: 'POST',
				url: '/api/media/register',
				headers: JSON_H,
				payload: { projectId: 'prj_0000000000000001', paths: [fixture(name)] },
			});
			const body = r.json() as { items: unknown[]; errors: { code: string; message: string }[] };
			expect(body.items).toEqual([]);
			expect(body.errors[0]!.code).toBe('INVALID_LUT');
			expect(body.errors[0]!.message).toContain(`line ${line}`);
		}
	});

	it('reports features.color (lut3d in the engine ffmpeg)', async () => {
		const caps = (await app.inject({ method: 'GET', url: '/api/capabilities', headers: H })).json();
		expect(caps.features.color).toMatchObject({ lut3d: true });
	});
});

async function chartDoc(
	grade: (look: string) => Record<string, unknown>,
	keyframed?: Record<string, unknown>,
) {
	const chart = await register(app, fixture('chart.png'));
	const look = await register(app, fixture('look-33.cube'));
	const d = new DocBuilder();
	const c = d.addMedia(chart);
	const l = d.addMedia(look);
	const placed = d.tx([
		{
			type: 'clip.place',
			source: { mediaId: c },
			at: 0,
			sourceRange: { in: { seconds: 0 }, out: { seconds: 1 } },
			ref: '$c',
		},
	]);
	const clip = placed.refs.$c!;
	const fx = d.tx([
		{
			type: 'effect.add',
			target: { clipId: clip },
			effectId: LUMETRI_EFFECT_ID,
			params: grade(l),
			ref: '$g',
		},
	]).refs.$g!;
	if (keyframed) {
		for (const [name, [a, b]] of Object.entries(keyframed as Record<string, [unknown, unknown]>)) {
			d.tx([
				{ type: 'param.setAnimated', target: ['effect', fx, name], animated: true, at: { sequenceFrame: 0 } },
				{ type: 'param.set', target: ['effect', fx, name], value: a, at: { sequenceFrame: 0 } },
				{ type: 'param.set', target: ['effect', fx, name], value: b, at: { sequenceFrame: 29 } },
			]);
		}
	}
	return { d, clip, lookFile: fixture('look-33.cube') };
}

describe('native export of graded clips (S06:CG-050…054, §9 test 5)', () => {
	it('plans graded clips natively without GPL-only filters', async () => {
		const { d, clip } = await chartDoc(GRADE);
		d.tx([
			{
				type: 'effect.add',
				target: { clipId: clip },
				effectId: 'jasper.brightness-contrast',
				params: { brightness: 10 },
			},
			{
				type: 'effect.add',
				target: { clipId: clip },
				effectId: 'jasper.hue-saturation',
				params: { hue: 20 },
			},
			{
				type: 'effect.add',
				target: { clipId: clip },
				effectId: 'jasper.black-white',
				params: { amount: 30 },
			},
		]);
		const planned = await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId) as never,
		});
		expect(planned.plan.blockers).toEqual([]);
		expect(planned.plan.path).toBe('native');
		const exts = coreServices(app).exports.nativeExtensions.all();
		const prepared = await prepareExtensions(exts, planned, {
			signal: new AbortController().signal,
			stage: () => {},
			scratchDir: async () => tmpdir(),
			log: () => {},
			jobId: 'job_test',
		});
		const g = buildNativeGraph({
			snapshot: planned.snapshot,
			output: planned.output,
			outputFile: '/tmp/x.mp4',
			sources: { media: (id) => planned.media[id] ?? null, mgMaster: () => null },
			threads: 2,
			extensions: { list: exts, prepared },
		});
		expect(g.filter).toMatch(/(?:^|[,;\]\s])lut3d=/);
		expect(g.filter).not.toMatch(GPL_FILTER);
	}, 60_000);

	it('keyframed export frames match the start and end grades', async () => {
		const keys = { exposure: [-0.5, 0.8], temperature: [-40, 40] };
		const { d } = await chartDoc((l) => ({ ...GRADE(l), exposure: 0, temperature: 0 }), keys);
		// Export, then compare frames 0 / 29 with native stills of the static start / end grades.
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId, 'native') },
		});
		expect(start.statusCode).toBe(202);
		const done = await coreServices(app).queue.wait(start.json().id);
		expect(done.error).toBeUndefined();
		const file = (await coreServices(app).exports.outputFile(start.json().id))!;
		for (const [frame, pick] of [
			[0, 0],
			[29, 1],
		] as const) {
			const { d: s } = await chartDoc((l) => ({
				...GRADE(l),
				exposure: keys.exposure[pick],
				temperature: keys.temperature[pick],
			}));
			const still = await stillOf(s, 0);
			const a = rgbOf(file, frame).data;
			const b = rgbOf(still.file).data;
			const st = diffStats(a, b);
			// H.264 4:2:0 at crf 12 vs a PNG: small mean error; a wrong LUT state would be far off.
			expect(st.mean).toBeLessThan(2.5);
			const other = rgbOf(file, 29 - frame).data;
			expect(diffStats(other, b).mean).toBeGreaterThan(st.mean + 5);
		}
	}, 240_000);

	it('native still parity with the TS reference on the chart (S06 §9 test 3: ≤ 2/255 on 99.5 %, max ≤ 4)', async () => {
		const { d, lookFile } = await chartDoc(GRADE);
		const still = await stillOf(d, 5);
		expect(still.renderPath).toBe('native');
		const look = parseCube(readFileSync(lookFile, 'utf8'));
		const lut = bakeColorRun(
			[{ id: 'g', effectId: LUMETRI_EFFECT_ID, effectVersion: 1, enabled: true, params: GRADE('L') }],
			defaultEffectRegistry,
			{ lut: (id) => (id === 'L' ? look : null) },
			33,
		)!;
		const src = rgbOf(fixture('chart.png')).data;
		const ref = reference(src, lut);
		const got = rgbOf(still.file).data;
		expect(got.length).toBe(ref.length);
		const st = diffStats(got, ref);
		console.info(
			`[S06 §9.3] native still vs TS reference: exact ${(st.exact * 100).toFixed(3)} %, ≤1 ${(st.within1 * 100).toFixed(3)} %, p99.5 ${st.p995}, max ${st.max}, mean ${st.mean.toFixed(4)}`,
		);
		expect(st.p995).toBeLessThanOrEqual(2);
		expect(st.max).toBeLessThanOrEqual(4);
		// The grade actually changed the picture.
		expect(diffStats(got, src).mean).toBeGreaterThan(5);
	}, 120_000);
});
