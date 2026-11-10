// Kernel streams drawn by the OpenCL program in the composite (apps/engine/src/export/stream/opencl.ts; docs/wp-notes/
// export-performance.md §8). The plan and the result say where kernel streams are drawn and why not on the OpenCL
// device; the built composite runs `hwupload, program_opencl, hwdownload` on each stream whose frames fit the program
// (its pipe then carries programs and pictures), and keeps the others on the CPU kernel by name. On a host with an
// OpenCL device the exported picture matches the CPU kernel's export.
import { ExportResultSchema, RenderPlanSchema } from '@jasper/api';
import { compareVideos } from '@jasper/testkit/oracle';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildNativeGraph } from '../src/export/native.ts';
import {
	gpuTapLayout,
	OPENCL_DEVICE,
	OPENCL_MAX_TAPS,
	probeOpenClTaps,
} from '../src/export/stream/opencl.ts';
import type { TapStreamPlan } from '../src/export/stream/tap-plan.ts';
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
}, 180_000);
afterAll(closeApps);
afterEach(() => {
	delete process.env.JASPER_EXPORT_OPENCL;
});

const settings = (seqId: string) => ({
	sequenceId: seqId,
	range: { type: 'entire' },
	container: 'mov',
	engine: 'native',
	video: {
		codec: 'prores',
		width: 640,
		height: 360,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 10 },
		encoderSpeed: 'fast',
	},
	audio: { codec: 'pcm', sampleRate: 48000, channels: 2 },
});

/** clip-a on V1; two moving, rotating stills on V2 (sub-pixel: one kernel stream of two members). */
async function doc() {
	const [a, still] = await Promise.all(['clip-a.mp4', 'still.png'].map((f) => register(app, fixture(f))));
	const d = new DocBuilder();
	const [ma, ms] = [a!, still!].map((m) => d.addMedia(m));
	const r = d.tx([
		{
			type: 'clip.place',
			source: { mediaId: ma },
			at: 0,
			sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 50 } },
		},
		...[0, 25].map((at, i) => ({
			type: 'clip.place',
			source: { mediaId: ms },
			at,
			tracks: { video: 'V2' },
			sourceRange: { in: { seconds: 0 }, out: { seconds: 25 / 30 } },
			ref: `$s${i}`,
		})),
	]);
	for (const [i, at] of [0, 25].entries()) {
		const s = r.refs[`$s${i}`]!;
		const key = (param: string, f: number, value: unknown) => ({
			type: 'keyframe.add',
			target: ['clip', s, 'transform', param],
			at: { sequenceFrame: at + f },
			value,
		});
		d.tx([
			{ type: 'param.set', target: ['clip', s, 'transform', 'scale'], value: 35 },
			key('position', 0, [500.3, 400.6]),
			key('position', 24, [1300.7, 640.2]),
			key('rotation', 0, -8),
			key('rotation', 24, 11),
		]);
	}
	return d;
}

async function exportFile(d: DocBuilder) {
	const r = await app.inject({
		method: 'POST',
		url: '/api/exports',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) },
	});
	expect(r.statusCode, r.body).toBe(202);
	const done = await coreServices(app).queue.wait(r.json().id);
	expect(done.error, JSON.stringify(done.error)).toBeUndefined();
	return {
		file: (await coreServices(app).exports.outputFile(r.json().id))!,
		result: ExportResultSchema.parse(done.result),
	};
}

async function graphOf(d: DocBuilder, openCl?: { init: string; source: string }) {
	const planned = await coreServices(app).exports.plan({
		envelope: d.envelope(),
		sequenceId: d.seqId,
		settings: settings(d.seqId) as never,
	});
	return buildNativeGraph({
		snapshot: planned.snapshot,
		output: planned.output,
		outputFile: '/tmp/x.mov',
		sources: { media: (id) => planned.media[id] ?? null, mgMaster: () => null },
		threads: 2,
		extensions: { list: [], prepared: new Map() },
		...(openCl ? { openCl } : {}),
	});
}

const OPENCL = { init: `opencl=${OPENCL_DEVICE}:,device_type=gpu`, source: '/tmp/jasper opencl/taps.cl' };

describe('kernel streams on the OpenCL device', { timeout: 600_000 }, () => {
	it('plans and reports where kernel streams are drawn; the CPU kernel draws them without an OpenCL device', async () => {
		const probe = await probeOpenClTaps(coreServices(app).ffmpeg);
		const d = await doc();
		const payload = { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) };
		const plan = RenderPlanSchema.parse(
			(await app.inject({ method: 'POST', url: '/api/exports/plan', headers: JSON_H, payload })).json(),
		).pipeline!;
		expect(plan.kernel).toEqual(
			probe.ok ? { device: 'opencl' } : { device: 'cpu', fallbackReasons: [probe.reason] },
		);
		const gpu = await exportFile(d);
		expect(gpu.result.pipeline?.kernel).toEqual(
			probe.ok
				? { device: 'opencl', streams: { opencl: 1, cpu: 0 } }
				: { device: 'cpu', streams: { opencl: 0, cpu: 1 }, fallbackReasons: [probe.reason] },
		);
		if (!probe.ok) return;
		// with a device: the OpenCL kernel's picture against the CPU kernel's
		process.env.JASPER_EXPORT_OPENCL = '0';
		const cpu = await exportFile(d);
		expect(cpu.result.pipeline?.kernel?.device).toBe('cpu');
		const q = compareVideos(cpu.file, gpu.file);
		expect(q.frames).toHaveLength(50);
		console.info(
			`OpenCL vs CPU kernel: SSIM min ${Math.min(...q.frames.map((f) => f.ssim))}, mean ${q.ssim}`,
		);
		for (const [f, v] of q.frames.entries()) expect(v.ssim, `frame ${f}`).toBeGreaterThanOrEqual(0.999);
	});

	it('draws a kernel stream with program_opencl in the composite, its pipe carrying programs and pictures', async () => {
		const d = await doc();
		const cpu = await graphOf(d);
		const gpu = await graphOf(d, OPENCL);
		expect(cpu.kernel).toEqual({ opencl: 0, cpu: 1, fallbackReasons: [] });
		expect(cpu.filter).not.toMatch(/opencl|hwupload/);
		expect(cpu.args).not.toContain('-filter_hw_device');
		expect(gpu.kernel).toEqual({ opencl: 1, cpu: 0, fallbackReasons: [] });
		const [stream] = gpu.streams;
		const pl = stream!.plan as TapStreamPlan;
		const layout = pl.gpu!;
		// the input frame: program rows over the largest picture of the stream
		const pics = pl.members.flatMap((m) => m.pictures);
		expect(layout.inW).toBe(Math.max(64, ...pics.map((p) => p.w)));
		expect(layout.inH).toBe(layout.progRows + Math.max(...pics.map((p) => p.h)));
		const input = gpu.inputs.find((i) => i.includes(`pipe:${stream!.fd}`))!;
		expect(input).toEqual(expect.arrayContaining(['-s', `${layout.inW}x${layout.inH}`]));
		expect(gpu.filter).toContain(
			`hwupload,program_opencl=source='/tmp/jasper opencl/taps.cl':kernel=jasper_taps:size=${pl.outW}x${pl.outH},hwdownload,format=rgba,setpts=PTS-STARTPTS`,
		);
		// one OpenCL device for the process, before its inputs, as the filter device of the uploads
		const dev = gpu.args.indexOf('-init_hw_device');
		expect(gpu.args.slice(dev, dev + 4)).toEqual([
			'-init_hw_device',
			OPENCL.init,
			'-filter_hw_device',
			'jcl',
		]);
		expect(dev).toBeLessThan(gpu.args.indexOf('-i'));
		// the rest of the composite is the CPU kernel's
		expect(gpu.filter.replace(/hwupload,program_opencl=[^,]+,hwdownload,format=rgba,/, '')).toBe(cpu.filter);
	});

	it('keeps a stream whose frames do not fit the OpenCL program on the CPU kernel, by name', async () => {
		const d = await doc();
		const planned = await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId) as never,
		});
		// (a lowered layer with more shutter taps than the program takes)
		const g = buildNativeGraph({
			snapshot: planned.snapshot,
			output: planned.output,
			outputFile: '/tmp/x.mov',
			sources: { media: (id) => planned.media[id] ?? null, mgMaster: () => null },
			threads: 2,
			extensions: { list: [], prepared: new Map() },
			openCl: OPENCL,
		});
		const pl = g.streams[0]!.plan as TapStreamPlan;
		const many = [OPENCL_MAX_TAPS + 1, OPENCL_MAX_TAPS + 1];
		for (let t = 0; t < OPENCL_MAX_TAPS + 1; t++) many.push(1, 1, 0, 0, 0, 1, 0, 0, 0, 10, 10, 0);
		const tooMany = gpuTapLayout(
			{
				...pl,
				members: [{ ...pl.members[0]!, frames: [{ rect: [0, 0, 4, 4], opacity: 1, level: 0, prog: many }] }],
			},
			OPENCL.source,
		);
		expect(tooMany).toEqual({
			reason: `a frame draws ${OPENCL_MAX_TAPS + 1} taps (the OpenCL kernel takes 256)`,
		});
		const huge = gpuTapLayout(
			{ ...pl, members: [{ ...pl.members[0]!, pictures: [{ w: 9000, h: 120, inputs: [], filter: '' }] }] },
			OPENCL.source,
		);
		expect(huge).toEqual({ reason: 'a 9000×120 px picture is larger than an OpenCL image (8192 px)' });
		// a VAAPI encoder's upload owns the process's filter device: every stream on the CPU kernel, by name
		const vaapi = buildNativeGraph({
			snapshot: planned.snapshot,
			output: {
				...planned.output,
				encoder: { ...planned.output.encoder!, codec: 'h264', encoder: 'h264_vaapi' },
			},
			outputFile: '/tmp/x.mp4',
			sources: { media: (id) => planned.media[id] ?? null, mgMaster: () => null },
			threads: 2,
			extensions: { list: [], prepared: new Map() },
			openCl: OPENCL,
		});
		expect(vaapi.kernel).toEqual({
			opencl: 0,
			cpu: 1,
			fallbackReasons: ['the encoder uploads its frames to a VAAPI device (one filter device per process)'],
		});
		expect(vaapi.filter).not.toMatch(/program_opencl/);
		expect(vaapi.args).not.toContain('-filter_hw_device');
	});
});
