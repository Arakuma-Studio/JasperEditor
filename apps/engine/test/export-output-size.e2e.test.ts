// Fidelity gate of the output-size composite (REMOTION_E2E=1; apps/engine/src/export/output-size.ts, docs/wp-notes/
// export-performance.md §7): a 1080p sequence with every kind of layer the user's projects draw — a cropped video,
// a nested sequence, a masked still, a baked title card with an animated blur, and subtitle-style text with Transform
// keyframes and S_Shake (lowered: drawn by the kernel) — exported at 720p composited at the output size against the
// same export composited at the sequence size and scaled to 720p: SSIM per frame, and per pixel on the text.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExportResultSchema } from '@jasper/api';
import { compareVideos } from '@jasper/testkit/oracle';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import { DocBuilder, ensureFixtures, fixture, JSON_H, register, TEST_FFMPEG, tempAppdir } from './helpers.ts';

const enabled = process.env.REMOTION_E2E === '1';
const PORT = Number(process.env.JASPER_E2E_PORT ?? 0);
const FRAMES = 120;
/** Regions on the 1280×720 output: the subtitles and the title card. */
const REGIONS = {
	subtitles: { x: 240, y: 500, w: 800, h: 160 },
	title: { x: 160, y: 60, w: 960, h: 200 },
};

function report(line: string): void {
	console.info(line);
	appendFileSync(join(tmpdir(), 'output-size-fidelity.txt'), `${new Date().toISOString()} ${line}\n`);
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

/** Share of the region's channel values within `tol` levels of each other. */
function textAgreement(a: Buffer, b: Buffer, tol: number): number {
	let n = 0;
	let ok = 0;
	for (let i = 0; i < a.length; i += 3) {
		for (let c = 0; c < 3; c++) {
			n++;
			if (Math.abs(a[i + c]! - b[i + c]!) <= tol) ok++;
		}
	}
	return n ? ok / n : 1;
}

describe.runIf(enabled)('output-size composite fidelity (REMOTION_E2E=1)', { timeout: 1_200_000 }, () => {
	let engine: RunningEngine;
	beforeAll(async () => {
		ensureFixtures();
		engine = await startEngine({
			appdir: tempAppdir('jasper-outsize-'),
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
		delete process.env.JASPER_EXPORT_COMPOSITE_SIZE;
		await engine?.stop();
	});
	const hostH = () => ({ host: `127.0.0.1:${engine.port}` });

	async function doc() {
		const app = engine.app as never;
		const [a, still] = await Promise.all([
			register(app, fixture('clip-a.mp4'), hostH()),
			register(app, fixture('still.png'), hostH()),
		]);
		const d = new DocBuilder('hd-1080p-30');
		const [ma, ms] = [a, still].map((m) => d.addMedia(m));
		const font = d.tx([{ type: 'font.add', family: 'JetBrains Mono', ref: '$f' }]).refs.$f!;
		const r = d.tx([
			{
				type: 'clip.place',
				source: { mediaId: ma },
				at: 0,
				sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: FRAMES } },
				ref: '$v',
			},
			{
				type: 'clip.place',
				source: { mediaId: ms },
				at: 0,
				tracks: { video: 'V2' },
				sourceRange: { in: { seconds: 0 }, out: { seconds: FRAMES / 30 } },
				ref: '$nest',
			},
			{
				type: 'clip.place',
				source: { mediaId: ms },
				at: 10,
				tracks: { video: 'V3' },
				sourceRange: { in: { seconds: 0 }, out: { seconds: 3 } },
				ref: '$masked',
			},
			{
				type: 'clip.addText',
				at: 0,
				duration: FRAMES,
				track: 'V4',
				content: {
					text: 'TITLE CARD',
					style: { fontId: font, weight: 800, sizePx: 120, fill: [1, 0.9, 0.2, 1] },
				},
				box: { width: 1300, height: 200, autoSize: 'none' },
				transform: { position: [960, 240] },
				ref: '$title',
			},
		]);
		const { $v: v, $nest: nestSrc, $masked: masked, $title: title } = r.refs as Record<string, string>;
		d.tx([
			{
				type: 'effect.add',
				target: { clipId: v! },
				effectId: 'jasper.crop',
				params: { left: 4, top: 6, right: 3, bottom: 5 },
			},
			{ type: 'param.set', target: ['clip', nestSrc!, 'transform', 'scale'], value: 60 },
			{ type: 'param.set', target: ['clip', masked!, 'transform', 'scale'], value: 45 },
			{ type: 'param.set', target: ['clip', masked!, 'transform', 'position'], value: [1500.5, 700.25] },
			{ type: 'mask.add', clipId: masked!, shape: 'ellipse' },
		]);
		const blur = d.tx([
			{
				type: 'effect.add',
				target: { clipId: title! },
				effectId: 'jasper.gaussian-blur',
				params: { radius: 0 },
				ref: '$b',
			},
		]).refs.$b!;
		d.tx([
			{
				type: 'keyframe.add',
				target: ['effect', blur, 'radius'],
				at: { sequenceFrame: 0 },
				value: 0,
				interpolation: 'linear',
			},
			{
				type: 'keyframe.add',
				target: ['effect', blur, 'radius'],
				at: { sequenceFrame: 60 },
				value: 10,
				interpolation: 'linear',
			},
		]);
		d.tx([{ type: 'clip.nest', clipIds: [nestSrc!], name: 'Nested still' }]);
		// subtitle-style words: Transform keyframes (pop-in) + S_Shake, one every 20 frames
		for (let i = 0; i < FRAMES / 20; i++) {
			const at = i * 20;
			const t = d.tx([
				{
					type: 'clip.addText',
					at,
					duration: 20,
					track: 'V5',
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

	async function exportFile(d: DocBuilder) {
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
	}

	it('the output-size composite matches the sequence-size one scaled to the output', async () => {
		const d = await doc();
		const small = await exportFile(d);
		process.env.JASPER_EXPORT_COMPOSITE_SIZE = 'sequence';
		const full = await exportFile(d);
		delete process.env.JASPER_EXPORT_COMPOSITE_SIZE;
		report(
			`output-size pipeline ${JSON.stringify(small.result.pipeline)}; sequence-size ${JSON.stringify(full.result.pipeline)}`,
		);
		expect(small.result.renderPath).toBe('hybrid');
		expect(small.result.pipeline?.composite).toEqual({ device: 'cpu', size: 'output' });
		expect(full.result.pipeline?.composite.size).toBe('sequence');
		const q = compareVideos(full.file, small.file);
		expect(q.frames).toHaveLength(FRAMES);
		report(
			`SSIM per frame: min ${Math.min(...q.frames.map((f) => f.ssim))}, mean ${q.ssim}; PSNR min ${q.psnrMin}`,
		);
		for (const [f, v] of q.frames.entries()) expect(v.ssim, `frame ${f}`).toBeGreaterThanOrEqual(0.98);
		for (const [name, r] of Object.entries(REGIONS))
			for (const n of [3, 8, 25, 47, 61, 90, 115]) {
				const share = textAgreement(region(full.file, n, r), region(small.file, n, r), 24);
				report(`${name} frame ${n}: ${(share * 100).toFixed(2)} % of values within 24 levels`);
				expect(share, `${name} frame ${n}`).toBeGreaterThanOrEqual(0.97);
			}
	});
});
