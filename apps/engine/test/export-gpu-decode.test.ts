// GPU decode of a native export's video sources (apps/engine/src/export/gpu.ts; docs/wp-notes/export-performance.md
// §5). Without a CUDA device the export decodes on the CPU and says so (plan and result `pipeline.decode`; NVDEC on
// a host with one); the GPU command is checked where it is built — NVDEC arguments in front of the eligible inputs
// only, one CUDA device per process, the per-process cap, and an unchanged filter graph (the composite is the CPU one
// either way).
import { ExportResultSchema, RenderPlanSchema } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CUDA_DEVICE, nvdecForGraph, probeCudaDecode } from '../src/export/gpu.ts';
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
	type TestApp,
} from './helpers.ts';

let app: TestApp;
beforeAll(async () => {
	ensureFixtures();
	app = await makeApp();
}, 180_000);
afterAll(closeApps);

const settings = (seqId: string) => ({
	sequenceId: seqId,
	range: { type: 'entire' },
	container: 'mp4',
	engine: 'native',
	video: {
		codec: 'h264',
		width: 640,
		height: 360,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 23 },
		encoderSpeed: 'fast',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
});

/** clip-a | clip-b | clip-a on V1 (H.264), a VP9-with-alpha overlay on V2 (libvpx: never the GPU). */
async function doc() {
	const a = await register(app, fixture('clip-a.mp4'));
	const b = await register(app, fixture('clip-b.mp4'));
	const alpha = await register(app, fixture('overlay-alpha.webm'));
	const d = new DocBuilder();
	const [ma, mb, mw] = [a, b, alpha].map((m) => d.addMedia(m));
	const place = (media: string, at: number, track = 'V1') => ({
		type: 'clip.place',
		source: { mediaId: media },
		at,
		tracks: { video: track },
		sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 20 } },
	});
	d.tx([place(ma!, 0), place(mb!, 20), place(ma!, 40), place(mw!, 10, 'V2')]);
	return { d, alphaId: mw! };
}

describe('GPU decode (NVDEC)', { timeout: 300_000 }, () => {
	it('decodes on the CPU without a CUDA device (NVDEC with one), as the plan and the result say', async () => {
		const probe = await probeCudaDecode(coreServices(app).ffmpeg);
		const decode = probe.ok ? 'nvdec' : 'cpu';
		const { d } = await doc();
		const payload = { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId) };
		const plan = await app.inject({ method: 'POST', url: '/api/exports/plan', headers: JSON_H, payload });
		expect(RenderPlanSchema.parse(plan.json()).pipeline).toMatchObject({ decode, composite: { device: 'cpu' } });
		const start = await app.inject({ method: 'POST', url: '/api/exports', headers: JSON_H, payload });
		const done = await coreServices(app).queue.wait(start.json().id);
		expect(done.error).toBeUndefined();
		expect(ExportResultSchema.parse(done.result).pipeline).toMatchObject({ decode, composite: { device: 'cpu' } });
	});

	it('puts NVDEC in front of the eligible inputs only, one device per process, up to the cap', async () => {
		const { d, alphaId } = await doc();
		const planned = await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId) as never,
		});
		const build = (hwDecode?: ReturnType<typeof nvdecForGraph>) =>
			buildNativeGraph({
				snapshot: planned.snapshot,
				output: planned.output,
				outputFile: '/tmp/x.mp4',
				sources: { media: (id) => planned.media[id] ?? null, mgMaster: () => null },
				threads: 2,
				...(hwDecode ? { hwDecode } : {}),
			});
		const cpu = build();
		const gpu = build(nvdecForGraph(16));
		const capped = build(nvdecForGraph(2));
		expect(cpu.hwDecoded).toBe(0);
		expect(cpu.args).not.toContain('-hwaccel');
		// the composite itself is unchanged
		expect(gpu.filter).toBe(cpu.filter);
		/** The `-i` paths of the inputs that carry `-hwaccel cuda -hwaccel_device jcu`. */
		const hwInputs = (args: string[]) =>
			args.flatMap((a, i) => {
				if (a !== '-i') return [];
				let k = i - 1;
				while (k >= 0 && args[k] !== '-i' && args[k] !== '-hwaccel') k--;
				return args[k] === '-hwaccel' && args[k + 1] === 'cuda' && args[k + 3] === CUDA_DEVICE
					? [args[i + 1]!]
					: [];
			});
		const gpuInputs = hwInputs(gpu.args);
		expect(gpu.hwDecoded).toBe(3);
		expect(gpuInputs).toHaveLength(3);
		expect(gpu.args).toContain(planned.media[alphaId]!.path);
		expect(gpuInputs).not.toContain(planned.media[alphaId]!.path);
		expect(gpu.args.filter((a) => a === '-init_hw_device')).toHaveLength(1);
		const dev = gpu.args.indexOf('-init_hw_device');
		expect(gpu.args[dev + 1]).toBe(`cuda=${CUDA_DEVICE}`);
		expect(dev).toBeLessThan(gpu.args.indexOf('-i'));
		expect(capped.hwDecoded).toBe(2);
		expect(hwInputs(capped.args)).toHaveLength(2);
	});
});
