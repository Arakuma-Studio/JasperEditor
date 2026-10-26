// spec 13 AS-070…073 (REMOTION_E2E=1): subtitle templates exported on the native path (layer stills drawn by the
// kernel through Motion, the Transform effect with its 360° shutter and S_Shake; static stills; all baked in sheet
// renders and drawn by one kernel stream per track; motion-blurred shakes baked as one run master) against the composition's own frames (Remotion stills of the
// same document: the Program preview's renderer). Per template and frame: SSIM of the subtitle region (FX-040:
// ≥ 0.98) and the share of pixels within 3/255.
import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineJob } from '@jasper/api';
import { buildRenderSnapshot } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import { DocBuilder, JSON_H, TEST_FFMPEG, tempAppdir, until } from './helpers.ts';

const enabled = process.env.REMOTION_E2E === '1';
const PORT = Number(process.env.JASPER_E2E_PORT ?? 0);
const W = 1080;
const H = 1920;
/** The subtitle region compared (the captions sit at y 0.50 in shorts, spec 13 §0). */
const REGION = { x: 0, y: 760, w: 1080, h: 400 };
/** Frames per subtitle clip (the pop-in lasts 10 frames at 59.94). */
const CLIP = 16;

function report(line: string): void {
	console.info(line);
	appendFileSync(join(tmpdir(), 'subtitle-parity.txt'), `${new Date().toISOString()} ${line}\n`);
}

function decodeRegion(file: string, frame: number | null): Buffer {
	const crop = `crop=${REGION.w}:${REGION.h}:${REGION.x}:${REGION.y}`;
	const r = spawnSync(
		TEST_FFMPEG,
		[
			'-v',
			'error',
			'-i',
			file,
			'-vf',
			frame === null ? crop : `select=eq(n\\,${frame}),${crop}`,
			'-frames:v',
			'1',
			'-pix_fmt',
			'rgb24',
			'-f',
			'rawvideo',
			'pipe:1',
		],
		{ maxBuffer: 1 << 28 },
	);
	if (r.status !== 0) throw new Error(`decode failed: ${r.stderr}`);
	return r.stdout;
}

/** Mean SSIM (ffmpeg `ssim`, all planes) of two raw rgb24 regions. */
function ssim(a: Buffer, b: Buffer): number {
	const raw = ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${REGION.w}x${REGION.h}`];
	const dir = tempAppdir('jasper-ssim-');
	const fa = join(dir, 'a.rgb');
	const fb = join(dir, 'b.rgb');
	writeFileSync(fa, a);
	writeFileSync(fb, b);
	const r = spawnSync(TEST_FFMPEG, [
		...['-v', 'info', ...raw, '-i', fa, ...raw, '-i', fb],
		...['-filter_complex', '[0:v]format=yuv444p[a];[1:v]format=yuv444p[b];[a][b]ssim', '-f', 'null', '-'],
	]);
	const m = /SSIM .*All:([0-9.]+)/.exec(r.stderr.toString());
	if (!m) throw new Error(`ssim failed: ${r.stderr.toString().slice(-2000)}`);
	return Number(m[1]);
}

function within(a: Uint8Array, b: Uint8Array, tol: number): number {
	let n = 0;
	for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) <= tol) n++;
	return n / a.length;
}

const lin = (
	dd: DocBuilder,
	target: unknown[],
	f: number,
	value: unknown,
	extra: Record<string, unknown> = {},
) =>
	dd.tx([
		{ type: 'keyframe.add', target, at: { sequenceFrame: f }, value, interpolation: 'linear', ...extra },
	]);

type Template = { name: string; apply(d: DocBuilder, clip: string, at: number): void };

/** The templates of spec 13 AS-021 the lowered path draws (built-in Pixel Pop recipes and generic motion). */
const TEMPLATES: Template[] = [
	{ name: 'static', apply: () => {} },
	{
		name: 'motion pop',
		apply: (d, c, at) => {
			const t = ['clip', c, 'transform', 'scale'];
			lin(d, t, at, 75);
			lin(d, t, at + 3, 108);
			lin(d, t, at + 6, 100);
			lin(d, ['clip', c, 'opacity'], at, 0);
			lin(d, ['clip', c, 'opacity'], at + 3, 100);
		},
	},
	{
		name: 'pixel pop',
		apply: (d, c, at) => {
			const r = d.tx([
				{
					type: 'effect.add',
					target: { clipId: c },
					effectId: 'jasper.transform',
					params: { useCompShutterAngle: false, shutterAngle: 360 },
					ref: '$tf',
				},
				{
					type: 'effect.add',
					target: { clipId: c },
					effectId: 'jasper.s.shake',
					params: {
						amplitude: 0.6,
						frequency: 1,
						wrapX: 'no',
						wrapY: 'no',
						xRandAmp: 0.889,
						yRandAmp: 0.444,
						tiltRandAmp: 1,
					},
				},
			]);
			const tf = r.refs.$tf!;
			lin(d, ['effect', tf, 'scaleHeight'], at, 75);
			lin(d, ['effect', tf, 'scaleHeight'], at + 6, 108);
			lin(d, ['effect', tf, 'scaleHeight'], at + 10, 100);
			lin(d, ['effect', tf, 'opacity'], at, 0);
			lin(d, ['effect', tf, 'opacity'], at + 3, 100);
		},
	},
	{
		name: 'pixel pop classic',
		apply: (d, c, at) => {
			const tf = d.tx([
				{
					type: 'effect.add',
					target: { clipId: c },
					effectId: 'jasper.transform',
					params: { useCompShutterAngle: false, shutterAngle: 360 },
					ref: '$tf',
				},
			]).refs.$tf!;
			lin(d, ['effect', tf, 'scaleHeight'], at, 0.1);
			lin(d, ['effect', tf, 'scaleHeight'], at + 5, 100, {
				interpolation: 'bezier',
				easeIn: { influence: 1, slope: 0 },
			});
		},
	},
	{
		name: 'shake',
		apply: (d, c) => {
			d.tx([
				{
					type: 'effect.add',
					target: { clipId: c },
					effectId: 'jasper.s.shake',
					params: { amplitude: 1.5, frequency: 10, wrapX: 'no', wrapY: 'no' },
				},
			]);
		},
	},
	{
		// S_Shake with its motion blur: not lowered (the kernel draws no shake blur) — the three words of the track
		// bake as ONE run master (AS-073).
		name: 'shake blur',
		apply: (d, c) => {
			d.tx([
				{
					type: 'effect.add',
					target: { clipId: c },
					effectId: 'jasper.s.shake',
					params: { amplitude: 6, frequency: 6, wrapX: 'no', wrapY: 'no', motionBlur: true },
				},
			]);
		},
	},
];
const WORDS = ['HOLA', 'MUNDO', 'PIXEL ARTE'];

describe.runIf(enabled)(
	'subtitle templates: native vs the composition (REMOTION_E2E=1, spec 13 AS-070…073)',
	() => {
		let engine: RunningEngine;
		const hostH = () => ({ host: `127.0.0.1:${engine.port}` });
		beforeAll(async () => {
			engine = await startEngine({
				appdir: tempAppdir('jasper-subparity-'),
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
			await engine?.stop();
		});
		const queue = () => coreServices(engine.app).queue;
		const wait = async (id: string): Promise<EngineJob> => {
			await until(
				() => ['succeeded', 'failed', 'cancelled'].includes(queue().get(id)?.state ?? ''),
				1_800_000,
				250,
			);
			return queue().get(id)!;
		};

		function subtitlesDoc() {
			const d = new DocBuilder('hd-1080p-59.94');
			d.tx([{ type: 'sequence.updateSettings', sequenceId: d.seqId, settings: { width: W, height: H } }]);
			const font = d.tx([{ type: 'font.add', family: 'JetBrains Mono', ref: '$f' }]).refs.$f!;
			const total = TEMPLATES.length * WORDS.length * CLIP;
			d.tx([{ type: 'clip.addSolid', at: 0, duration: total, track: 'V1', color: [0.16, 0.2, 0.28, 1] }]);
			const spans: { template: string; f0: number }[] = [];
			let at = 0;
			for (const t of TEMPLATES)
				for (const word of WORDS) {
					const clip = d.tx([
						{
							type: 'clip.addText',
							at,
							duration: CLIP,
							track: 'V2',
							content: {
								text: word,
								style: {
									fontId: font,
									weight: 800,
									sizePx: 98,
									fill: [1, 1, 1, 1],
									strokes: [{ color: [0.68, 0, 1, 1], widthPx: 11.5, position: 'outside' }],
									shadow: { color: [0.13, 0.11, 0.35, 0.8], angleDeg: 0, distancePx: 0, blurPx: 12 },
								},
							},
							box: { width: 810, height: 140, autoSize: 'none' },
							transform: { position: [540, 960] },
							ref: '$t',
						},
					]).refs.$t!;
					t.apply(d, clip, at);
					spans.push({ template: t.name, f0: at });
					at += CLIP;
				}
			return { d, spans, total };
		}

		it('every template within FX-040 of the composition; stills baked in one sheet, one kernel stream', async () => {
			const { d, spans, total } = subtitlesDoc();
			const settings = {
				sequenceId: d.seqId,
				range: { type: 'entire' },
				container: 'mov',
				engine: 'auto',
				video: {
					codec: 'prores',
					proresProfile: '4444',
					width: W,
					height: H,
					frameRate: { num: 60000, den: 1001 },
					scaling: 'fit',
					quality: { mode: 'crf', value: 10 },
					encoderSpeed: 'fast',
				},
			};
			const plan = (
				await engine.app.inject({
					method: 'POST',
					url: '/api/exports/plan',
					headers: { ...JSON_H, ...hostH() },
					payload: { envelope: d.envelope(), sequenceId: d.seqId, settings },
				})
			).json();
			expect(plan.path, JSON.stringify(plan.blockers)).toBe('hybrid');
			const started = Date.now();
			const r = await engine.app.inject({
				method: 'POST',
				url: '/api/exports',
				headers: { ...JSON_H, ...hostH() },
				payload: { envelope: d.envelope(), sequenceId: d.seqId, settings },
			});
			expect(r.statusCode, r.body).toBeLessThan(300);
			const done = await wait(r.json().id);
			expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
			report(
				`[subtitle parity] native export of ${total} frames (${spans.length} subtitles): ${Date.now() - started} ms`,
			);
			const bakes = queue()
				.list({})
				.filter((j) => j.parentId === done.id && j.kind === 'layer-bake');
			// Every lowered or static subtitle is a still (identical words share one), all in one sheet render; the
			// motion-blurred shakes are one run master.
			expect(bakes.map((j) => j.title).sort()).toEqual([
				expect.stringMatching(/Bake graphics – 3 layers from /),
				expect.stringMatching(/Bake graphics – \d+ stills/),
			]);
			const out = join(coreServices(engine.app).config.paths.rendersDir, done.id, 'output.mov');

			const core = coreServices(engine.app);
			const referenceDoc = buildRenderSnapshot(d.doc, d.seqId, {
				resolveMedia: () => null,
				resolveFont: (font, weight, italic) => {
					const face = core.fonts.resolve(font.family, weight, italic);
					return face ? core.signer.signUrl(`http://127.0.0.1:${engine.port}`, face.url) : null;
				},
			});
			const worst = new Map<string, { ssim: number; share: number }>();
			for (const s of spans) {
				// The pop-in (blurred), the overshoot and the hold.
				for (const k of [0, 2, 5, 8, 13]) {
					const f = s.f0 + k;
					const ref = join(tempAppdir('jasper-sub-ref-'), 'ref.png');
					await core.remotion.renderStill({
						inputProps: {
							doc: referenceDoc,
							options: { isPreview: false, useProxies: false, transparentBackground: false },
						},
						output: ref,
						frame: f,
						signal: new AbortController().signal,
					});
					const a = decodeRegion(out, f);
					const b = decodeRegion(ref, null);
					const q = { ssim: ssim(a, b), share: within(a, b, 3) };
					// SUBTITLE_PARITY_OUT=<dir>: both regions side by side as PNGs, for looking at them.
					const keep = process.env.SUBTITLE_PARITY_OUT;
					if (keep) {
						const raw = join(tempAppdir('jasper-sub-keep-'), 'pair.rgb');
						writeFileSync(raw, Buffer.concat([a, b]));
						spawnSync(TEST_FFMPEG, [
							...[
								'-v',
								'error',
								'-y',
								'-f',
								'rawvideo',
								'-pix_fmt',
								'rgb24',
								'-s',
								`${REGION.w}x${REGION.h * 2}`,
							],
							...['-i', raw, join(keep, `${s.template.replace(/ /g, '-')}-${s.f0}-${k}.png`)],
						]);
					}
					report(
						`[subtitle parity] ${s.template} frame +${k}: SSIM ${q.ssim.toFixed(4)}, within 3/255 ${q.share.toFixed(4)}`,
					);
					const w = worst.get(s.template);
					worst.set(s.template, {
						ssim: Math.min(w?.ssim ?? 1, q.ssim),
						share: Math.min(w?.share ?? 1, q.share),
					});
				}
			}
			for (const [t, q] of worst) {
				report(
					`[subtitle parity] ${t}: worst SSIM ${q.ssim.toFixed(4)}, worst share within 3/255 ${q.share.toFixed(4)}`,
				);
				expect(q.ssim, `${t} SSIM`).toBeGreaterThanOrEqual(0.98);
			}
		}, 3_600_000);
	},
);
