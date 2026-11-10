// Fidelity gate of the OpenCL kernel (JASPER_OPENCL_E2E=1, on a host with an OpenCL GPU; stream/opencl.ts,
// docs/wp-notes/export-performance.md §9). The OpenCL program computes in float32 where the CPU kernel computes in
// float64, so its frames are compared with the CPU kernel's:
// - frames of the user's real project dumped from the kernel (`JASPER_TAPDUMP_DIR`: `<name>.json` with the picture
//   size `w × h`, the stream size `dw × dh`, `prog`, `rect`, `opacity`, and `<name>.bin` the picture's RGBA), drawn
//   by `program_opencl` exactly as the composite runs it: per pixel;
// - an export of subtitle words with Transform keyframes (pop-in), a 360° shutter and S_Shake (lowered: kernel
//   streams; the layer bake needs Remotion) drawn by the OpenCL kernel against the same export drawn by the CPU
//   kernel: SSIM per frame, and per pixel on the text.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExportResultSchema } from '@jasper/api';
import { compareVideos } from '@jasper/testkit/oracle';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drawTaps } from '../src/export/stream/kernel.ts';
import { encodeGpuFrame, gpuTapFilters, gpuTapLayout, probeOpenClTaps } from '../src/export/stream/opencl.ts';
import type { TapStreamPlan } from '../src/export/stream/tap-plan.ts';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import { DocBuilder, ensureFixtures, fixture, JSON_H, register, TEST_FFMPEG, tempAppdir } from './helpers.ts';

const enabled = process.env.JASPER_OPENCL_E2E === '1';
const DUMPS = process.env.JASPER_TAPDUMP_DIR ?? '';
const PORT = Number(process.env.JASPER_E2E_PORT ?? 0);
const FRAMES = 120;
const SUBTITLES = { x: 240, y: 500, w: 800, h: 160 };

function report(line: string): void {
	console.info(line);
	appendFileSync(join(tmpdir(), 'opencl-fidelity.txt'), `${new Date().toISOString()} ${line}\n`);
}

/** rgb24 bytes of a region of frame `n`. */
function region(file: string, n: number, r: { x: number; y: number; w: number; h: number }): Buffer {
	const p = spawnSync(
		TEST_FFMPEG,
		[
			...['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${n}),crop=${r.w}:${r.h}:${r.x}:${r.y}`],
			...['-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
		],
		{ maxBuffer: 1 << 26 },
	);
	if (p.status !== 0) throw new Error(p.stderr.toString());
	return p.stdout;
}

/** Share of the channel values of `a` and `b` within `tol` levels of each other. */
function agreement(a: Uint8Array, b: Uint8Array, tol: number): number {
	let ok = 0;
	for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) <= tol) ok++;
	return a.length ? ok / a.length : 1;
}

describe.runIf(enabled)('OpenCL kernel fidelity (JASPER_OPENCL_E2E=1)', { timeout: 1_800_000 }, () => {
	let engine: RunningEngine;
	beforeAll(async () => {
		ensureFixtures();
		engine = await startEngine({
			appdir: tempAppdir('jasper-opencl-'),
			port: PORT,
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
		delete process.env.JASPER_EXPORT_OPENCL;
		await engine?.stop();
	});
	const hostH = () => ({ host: `127.0.0.1:${engine.port}` });

	it('an OpenCL device passes the probe', async () => {
		const probe = await probeOpenClTaps(coreServices(engine.app).ffmpeg);
		report(`probe ${JSON.stringify(probe)}`);
		expect(probe.ok, JSON.stringify(probe)).toBe(true);
	});

	it.runIf(existsSync(DUMPS))(
		'draws the dumped frames of the real project as the CPU kernel does',
		async () => {
			const probe = await probeOpenClTaps(coreServices(engine.app).ffmpeg);
			if (!probe.ok) throw new Error(probe.reason);
			const names = readdirSync(DUMPS)
				.filter((f) => f.endsWith('.json'))
				.sort();
			expect(names.length).toBeGreaterThan(0);
			const cases = names.map((f) => ({
				...(JSON.parse(readFileSync(join(DUMPS, f), 'utf8')) as {
					w: number;
					h: number;
					dw: number;
					dh: number;
					prog: number[];
					rect: [number, number, number, number];
					opacity: number;
				}),
				pic: new Uint8Array(readFileSync(join(DUMPS, f.replace(/\.json$/, '.bin')))),
				name: f,
			}));
			// one stream of every frame, as the composite draws one (the largest picture and stream frame)
			const outW = Math.max(...cases.map((c) => c.dw));
			const outH = Math.max(...cases.map((c) => c.dh));
			const plan = {
				members: [
					{
						pictures: cases.map((c) => ({ w: c.w, h: c.h })),
						frames: cases.map((c) => ({ rect: c.rect, prog: c.prog })),
					},
				],
				outW,
				outH,
			} as unknown as TapStreamPlan;
			const r = gpuTapLayout(plan, probe.taps.source);
			if (!('layout' in r)) throw new Error(r.reason);
			const L = r.layout;
			const frameBytes = L.inW * L.inH * 4;
			const input = Buffer.alloc(frameBytes * cases.length);
			for (const [i, c] of cases.entries()) {
				const off = i * frameBytes;
				encodeGpuFrame(
					L,
					c,
					c.w,
					c.h,
					outW,
					outH,
					new Float32Array(input.buffer, input.byteOffset + off, L.progRows * L.inW),
				);
				for (let y = 0; y < c.h; y++)
					input.set(c.pic.subarray(y * c.w * 4, (y + 1) * c.w * 4), off + (L.progRows + y) * L.inW * 4);
			}
			const ff = coreServices(engine.app).ffmpeg.bins.ffmpeg!;
			const p = spawnSync(
				ff,
				[
					...['-v', 'error', '-init_hw_device', probe.taps.init, '-filter_hw_device', 'jcl'],
					...[
						'-f',
						'rawvideo',
						'-pix_fmt',
						'rgba',
						'-s',
						`${L.inW}x${L.inH}`,
						'-framerate',
						'30',
						'-i',
						'pipe:0',
					],
					...['-vf', gpuTapFilters(L, outW, outH).join(','), '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
				],
				{ input, maxBuffer: 1 << 30 },
			);
			if (p.status !== 0) throw new Error(p.stderr.toString());
			const bytes = outW * outH * 4;
			expect(p.stdout.length).toBe(bytes * cases.length);
			let worst = 0;
			let differing = 0;
			for (const [i, c] of cases.entries()) {
				const want = new Uint8Array(bytes);
				drawTaps(c.pic, c.w, c.w, c.h, want, outW, outH, c.prog, c.opacity, c.rect, new Float32Array(bytes));
				const got = p.stdout.subarray(i * bytes, (i + 1) * bytes);
				let w = 0;
				for (let k = 0; k < bytes; k++) {
					const dd = Math.abs(got[k]! - want[k]!);
					if (dd) differing++;
					if (dd > w) w = dd;
				}
				worst = Math.max(worst, w);
				expect(w, `${c.name} (${c.prog[0]} taps)`).toBeLessThanOrEqual(2);
			}
			report(
				`dumped frames: ${cases.length}, worst ${worst} levels, ${differing} of ${bytes * cases.length} values differ`,
			);
			expect(differing / (bytes * cases.length)).toBeLessThan(0.001);
		},
	);

	/** Subtitle words: Transform pop-in keyframes with a 360° shutter, then S_Shake, one every 20 frames, over a video. */
	async function subtitleDoc(): Promise<DocBuilder> {
		const app = engine.app as never;
		const a = await register(app, fixture('clip-a.mp4'), hostH());
		const d = new DocBuilder('hd-1080p-30');
		const ma = d.addMedia(a);
		const font = d.tx([{ type: 'font.add', family: 'JetBrains Mono', ref: '$f' }]).refs.$f!;
		d.tx([
			{
				type: 'clip.place',
				source: { mediaId: ma },
				at: 0,
				sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: FRAMES } },
			},
		]);
		for (let i = 0; i < FRAMES / 20; i++) {
			const at = i * 20;
			const t = d.tx([
				{
					type: 'clip.addText',
					at,
					duration: 20,
					track: 'V2',
					content: {
						text: ['HOLA', 'MUNDO', 'PIXEL', 'ARTE', 'SUBS', 'FIN'][i]!,
						style: {
							fontId: font,
							weight: 800,
							sizePx: 98,
							fill: [1, 1, 1, 1],
							strokes: [{ color: [0.68, 0, 1, 1], widthPx: 11.5, position: 'outside' }],
						},
					},
					box: { width: 810, height: 140, autoSize: 'none' },
					transform: { position: [960, 870] },
					ref: '$t',
				},
			]).refs.$t!;
			const tf = d.tx([
				{
					type: 'effect.add',
					target: { clipId: t },
					effectId: 'jasper.transform',
					params: { useCompShutterAngle: false, shutterAngle: 360 },
					ref: '$tf',
				},
				{
					type: 'effect.add',
					target: { clipId: t },
					effectId: 'jasper.s.shake',
					params: { amplitude: 0.6, frequency: 1, wrapX: 'no', wrapY: 'no' },
				},
			]).refs.$tf!;
			for (const [f, val] of [
				[0, 75],
				[6, 108],
				[10, 100],
			] as const)
				d.tx([
					{
						type: 'keyframe.add',
						target: ['effect', tf, 'scaleHeight'],
						at: { sequenceFrame: at + f },
						value: val,
						interpolation: 'linear',
					},
				]);
		}
		return d;
	}

	const exportFile = async (d: DocBuilder) => {
		const settings = {
			sequenceId: d.seqId,
			range: { type: 'entire' },
			container: 'mov',
			engine: 'auto',
			video: {
				codec: 'prores',
				width: 1280,
				height: 720,
				frameRate: { num: 30, den: 1 },
				scaling: 'fit',
				quality: { mode: 'crf', value: 10 },
				encoderSpeed: 'fast',
			},
			audio: { codec: 'pcm', sampleRate: 48000, channels: 2 },
		};
		const r = await engine.app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: { ...JSON_H, ...hostH() },
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings },
		});
		expect(r.statusCode, r.body).toBeLessThan(300);
		const done = await coreServices(engine.app).queue.wait(r.json().id);
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		return {
			file: join(coreServices(engine.app).config.paths.rendersDir, done.id, 'output.mov'),
			result: ExportResultSchema.parse(done.result),
		};
	};

	it('exports shaken, motion-blurred subtitles with the OpenCL kernel as with the CPU kernel', async () => {
		const d = await subtitleDoc();
		const gpu = await exportFile(d);
		process.env.JASPER_EXPORT_OPENCL = '0';
		const cpu = await exportFile(d);
		delete process.env.JASPER_EXPORT_OPENCL;
		report(
			`OpenCL pipeline ${JSON.stringify(gpu.result.pipeline)}; CPU ${JSON.stringify(cpu.result.pipeline)}`,
		);
		expect(gpu.result.renderPath).toBe('hybrid');
		expect(gpu.result.pipeline?.kernel?.device).toBe('opencl');
		expect(gpu.result.pipeline?.kernel?.streams?.cpu).toBe(0);
		expect(cpu.result.pipeline?.kernel?.device).toBe('cpu');
		const q = compareVideos(cpu.file, gpu.file);
		expect(q.frames).toHaveLength(FRAMES);
		report(
			`SSIM per frame: min ${Math.min(...q.frames.map((f) => f.ssim))}, mean ${q.ssim}; PSNR min ${q.psnrMin}`,
		);
		for (const [f, v] of q.frames.entries()) expect(v.ssim, `frame ${f}`).toBeGreaterThanOrEqual(0.998);
		for (const n of [1, 3, 8, 25, 47, 61, 90, 115]) {
			const a = region(cpu.file, n, SUBTITLES);
			const b = region(gpu.file, n, SUBTITLES);
			const within2 = agreement(a, b, 2);
			report(`subtitles frame ${n}: ${(within2 * 100).toFixed(3)} % of values within 2 levels`);
			expect(within2, `frame ${n}`).toBeGreaterThanOrEqual(0.995);
		}
	});

	it('renders again with the CPU kernel when the OpenCL composite fails', async () => {
		const d = await subtitleDoc();
		// (the probe passed; the composite's device then fails to open: no OpenCL platform)
		const icd = process.env.OCL_ICD_FILENAMES;
		process.env.OCL_ICD_FILENAMES = join(tmpdir(), 'no-such-opencl-driver.so');
		try {
			const r = await exportFile(d);
			report(`after an OpenCL failure: ${JSON.stringify(r.result.pipeline?.kernel)}`);
			expect(r.result.pipeline?.kernel).toMatchObject({
				device: 'cpu',
				fallbackReasons: [expect.stringMatching(/^the OpenCL kernel failed: .*opencl/i)],
			});
		} finally {
			if (icd === undefined) delete process.env.OCL_ICD_FILENAMES;
			else process.env.OCL_ICD_FILENAMES = icd;
		}
	});
});
