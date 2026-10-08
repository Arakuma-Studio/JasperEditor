// @vitest-environment node
// compositor: stacks whose canvas scopes used to nest (CANVAS_NESTED) are drawn by the flat compositor (fx/flat.tsx).
// Every combination that failed before renders here on the Remotion path (what exports and stills render) against
// references computed without a browser: the CPU reference of three-d-reference.ts (solids, `blendPixel` = the native
// kernel's formulas, the Classic 3D CPU renderer, pointwise adjustment layers), Invert = 1 − c, and the BT.1886 curve
// for linear-light blending. Gated by REMOTION_E2E=1; needs ffmpeg on PATH. COMPOSITOR_OUT=<dir> copies the stills.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blendPixel, type Command, type Rgba } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { FX_H, FX_W, type FxMedia, fxCmd, fxSnapshot, startFxMedia } from './fx-media.ts';
import { referenceFrame } from './three-d-reference.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';
type Rgb = [number, number, number];

const solid = (track: string, color: Rgba, ref: string, extra: Record<string, unknown> = {}): Command =>
	({ type: 'clip.addSolid', at: 0, duration: 30, track, color, ref, ...extra }) as Command;
const mode = (ref: string, blendMode: string): Command =>
	({ type: 'clip.update', clipId: ref, patch: { blendMode } }) as Command;
const adjustment = (track: string, ref: string, extra: Record<string, unknown> = {}): Command =>
	({ type: 'clip.addAdjustment', at: 0, duration: 30, track, ref, ...extra }) as Command;
const effect = (ref: string, effectId: string, params?: Record<string, unknown>): Command =>
	({ type: 'effect.add', target: { clipId: ref }, effectId, ...(params ? { params } : {}) }) as Command;
const opacity = (ref: string, value: number): Command =>
	({ type: 'param.set', target: ['clip', ref, 'opacity'], value }) as Command;
const scale = (ref: string, value: number): Command =>
	({ type: 'param.set', target: ['clip', ref, 'transform', 'scale'], value }) as Command;
const card3d = (track: string, ref: string, color: Rgba = [1, 0, 0, 1]): Command[] => [
	solid(track, color, ref),
	scale(ref, 30),
	{ type: 'clip.set3d', clipIds: [ref], enabled: true } as Command,
	{ type: 'param.set', target: ['clip', ref, 'threeD', 'rotationY'], value: 35 } as Command,
];
const rect = (track: string, color: Rgba, ref: string, at = 0, duration = 30): Command =>
	({
		type: 'clip.addShape',
		at,
		duration,
		track,
		shape: { type: 'rect', size: [FX_W, FX_H], fill: color },
		ref,
	}) as Command;

const invert = (c: Rgba): Rgba => [1 - c[0], 1 - c[1], 1 - c[2], c[3]];
const to8 = (c: Rgba): Rgb => [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)];
/** `layers` composited bottom → top with `blendPixel` over the opaque black background. */
const over = (layers: { c: Rgba; mode?: string }[], from: Rgba = [0, 0, 0, 1]): Rgba => {
	let dst = from;
	for (const l of layers) dst = blendPixel(l.mode ?? 'normal', dst, l.c, 0);
	return dst;
};

describe.runIf(enabled)('flat compositor in Remotion renders (REMOTION_E2E=1)', { timeout: 300_000 }, () => {
	let media: FxMedia;
	let serveUrl: string;
	let renderer: typeof import('@remotion/renderer');
	const browserExecutable =
		process.env.JASPER_BROWSER_EXECUTABLE ??
		(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
	const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};
	const copyTo = process.env.COMPOSITOR_OUT;

	beforeAll(async () => {
		media = await startFxMedia('compositor-');
		const { bundle } = await import('@remotion/bundler');
		serveUrl = await bundle({ entryPoint: join(here, '..', 'src', 'remotion-entry.ts') });
		renderer = await import('@remotion/renderer');
		if (copyTo) mkdirSync(copyTo, { recursive: true });
	}, 300_000);
	afterAll(() => media?.close());

	async function still(commands: Command[], frame: number, name: string): Promise<Buffer> {
		const doc = fxSnapshot(commands);
		const inputProps = {
			doc,
			options: { isPreview: false, useProxies: false, transparentBackground: false },
		};
		const composition = await renderer.selectComposition({
			serveUrl,
			id: SEQUENCE_COMPOSITION_ID,
			inputProps,
			...browser,
		});
		const output = join(media.dir, `${name}.png`);
		await renderer.renderStill({
			composition,
			serveUrl,
			inputProps,
			frame,
			output,
			timeoutInMilliseconds: 60_000,
			onBrowserLog: (l) => {
				if (l.type === 'error') console.log(`[browser ${l.type}]`, l.text);
			},
			...browser,
		});
		if (copyTo) copyFileSync(output, join(copyTo, `${name}.png`));
		return execFileSync('ffmpeg', ['-v', 'error', '-i', output, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], {
			maxBuffer: 1 << 26,
		});
	}
	const at = (raw: Buffer, x: number, y: number): Rgb => {
		const i = (Math.round(y) * FX_W + Math.round(x)) * 4;
		return [raw[i]!, raw[i + 1]!, raw[i + 2]!];
	};
	const near = (a: Rgb, b: Rgb, tol = 4) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);
	const expectAt = (raw: Buffer, x: number, y: number, want: Rgba | Rgb, tol = 4) => {
		const w = (want.length === 4 ? to8(want as Rgba) : want) as Rgb;
		const got = at(raw, x, y);
		expect(near(got, w, tol), `(${x}, ${y}): ${got} want ${w}`).toBe(true);
	};
	/** Whole-frame comparison with the CPU reference: fraction of pixels off by more than `tol`. */
	const diff = (raw: Buffer, ref: Uint8ClampedArray, tol = 6) => {
		let bad = 0;
		let worst = 0;
		for (let i = 0; i < FX_W * FX_H; i++) {
			let e = 0;
			for (let c = 0; c < 3; c++) e = Math.max(e, Math.abs(raw[i * 4 + c]! - ref[i * 4 + c]!));
			worst = Math.max(worst, e);
			if (e > tol) bad++;
		}
		return { bad: bad / (FX_W * FX_H), worst };
	};
	const matchesReference = async (cmds: Command[], name: string, adjust?: (c: Rgba) => Rgba) => {
		const raw = await still(cmds, 5, name);
		const d = diff(raw, referenceFrame(fxSnapshot(cmds), 5, adjust ? { adjust } : {}));
		expect(d.bad, `${name}: worst ${d.worst}`).toBeLessThan(0.005);
		return raw;
	};

	const base: Rgba = [0.8, 0.4, 0.2, 1];
	const mid: Rgba = [0.3, 0.6, 0.9, 1];
	const top: Rgba = [0.5, 0.5, 0.25, 1];

	// ------------------------------------------------------------ adjustment layers and GL blend modes

	it('an adjustment layer with GPU effects over a GL blend-mode track', async () => {
		await matchesReference(
			[
				solid('V1', base, '$a'),
				solid('V2', mid, '$b'),
				mode('$b', 'linear-burn'),
				adjustment('V3', '$adj'),
				effect('$adj', 'jasper.invert'),
			],
			'adjust-over-blend',
			invert,
		);
	});

	it('a GL blend-mode track over an adjustment layer with GPU effects', async () => {
		await matchesReference(
			[
				solid('V1', base, '$a'),
				adjustment('V2', '$adj'),
				effect('$adj', 'jasper.invert'),
				solid('V3', top, '$t'),
				mode('$t', 'color-dodge'),
			],
			'blend-over-adjust',
			invert,
		);
	});

	it('two GL blend-mode tracks separated by an adjustment layer (and a small Normal layer)', async () => {
		await matchesReference(
			[
				solid('V1', base, '$a'),
				solid('V2', mid, '$b'),
				mode('$b', 'linear-burn'),
				adjustment('V3', '$adj'),
				effect('$adj', 'jasper.invert'),
				solid('V4', [0.1, 0.9, 0.1, 1], '$n'),
				scale('$n', 25),
				solid('V5', top, '$t'),
				mode('$t', 'color-dodge'),
			],
			'blend-adjust-blend',
			invert,
		);
	});

	it('an adjustment layer limited by its crop and opacity over a GL blend (the scope mix, padded layout)', async () => {
		const raw = await still(
			[
				solid('V1', base, '$a'),
				solid('V2', mid, '$b'),
				mode('$b', 'linear-burn'),
				adjustment('V3', '$adj'),
				effect('$adj', 'jasper.invert'),
				effect('$adj', 'jasper.crop', { left: 50 }),
				opacity('$adj', 50),
			],
			5,
			'adjust-crop-opacity',
		);
		const below = over([{ c: base }, { c: mid, mode: 'linear-burn' }]);
		const mixed: Rgba = [
			below[0] + (invert(below)[0] - below[0]) * 0.5,
			below[1] + (invert(below)[1] - below[1]) * 0.5,
			below[2] + (invert(below)[2] - below[2]) * 0.5,
			1,
		];
		expectAt(raw, FX_W * 0.25, FX_H / 2, below);
		expectAt(raw, FX_W * 0.75, FX_H / 2, mixed);
	});

	// ------------------------------------------------------------ DOM layers drawing through HTML-in-Canvas

	it('a DOM layer with GPU effects under a GL blend-mode track', async () => {
		const raw = await still(
			[
				rect('V1', base, '$s'),
				effect('$s', 'jasper.invert'),
				solid('V2', mid, '$b'),
				mode('$b', 'linear-burn'),
			],
			5,
			'dom-fx-under-blend',
		);
		expectAt(raw, FX_W / 2, FX_H / 2, over([{ c: invert(base) }, { c: mid, mode: 'linear-burn' }]));
	});

	it('a DOM layer with GPU effects under an adjustment layer with GPU effects', async () => {
		const raw = await still(
			[
				rect('V1', base, '$s'),
				effect('$s', 'jasper.invert'),
				adjustment('V2', '$adj'),
				effect('$adj', 'jasper.invert'),
			],
			5,
			'dom-fx-under-adjust',
		);
		expectAt(raw, FX_W / 2, FX_H / 2, base);
	});

	it('a GPU transition between DOM layers under an adjustment layer', async () => {
		const a: Rgba = [0.9, 0.2, 0.1, 1];
		const b: Rgba = [0.1, 0.2, 0.9, 1];
		const raw = await still(
			[
				rect('V1', a, '$x', 0, 30),
				rect('V1', b, '$y', 30, 30),
				{ type: 'transition.add', trackId: 'V1', at: 30, effectId: 'jasper.push', duration: 20 } as Command,
				adjustment('V2', '$adj', { duration: 60 }),
				effect('$adj', 'jasper.invert'),
			],
			30,
			'transition-under-adjust',
		);
		// Push at the middle of the span: B came in from the left, A moved right.
		expectAt(raw, 10, FX_H / 2, invert(b), 6);
		expectAt(raw, FX_W - 10, FX_H / 2, invert(a), 6);
	});

	// ------------------------------------------------------------ linear light

	const dec = (v: number) => v ** 2.4;
	const enc = (x: number) => x ** (1 / 2.4);
	/** Linear-light Normal of `c` at `alpha` over `dst` (BT.1886 curve, Rec. 709 working space). */
	const linMix = (dst: Rgba, c: Rgba, alpha: number): Rgba => [
		enc(dec(dst[0]) * (1 - alpha) + dec(c[0]) * alpha),
		enc(dec(dst[1]) * (1 - alpha) + dec(c[1]) * alpha),
		enc(dec(dst[2]) * (1 - alpha) + dec(c[2]) * alpha),
		1,
	];
	const linear = { type: 'sequence.updateSettings', settings: { color: { blendLinear: true } } } as Command;

	it('linear-light blending with an adjustment layer with GPU effects between the blended tracks', async () => {
		const raw = await still(
			[
				linear,
				solid('V1', base, '$a'),
				solid('V2', mid, '$b'),
				opacity('$b', 50),
				adjustment('V3', '$adj'),
				effect('$adj', 'jasper.invert'),
				solid('V4', top, '$t'),
				opacity('$t', 50),
			],
			5,
			'linear-adjust-between',
		);
		const want = linMix(invert(linMix(base, mid, 0.5)), top, 0.5);
		expectAt(raw, FX_W / 2, FX_H / 2, want);
		// Encoded blending would be visibly different.
		const encoded = over([
			{ c: invert(over([{ c: base }, { c: [mid[0] * 0.5, mid[1] * 0.5, mid[2] * 0.5, 0.5] }])) },
		]);
		expect(near(at(raw, FX_W / 2, FX_H / 2), to8(encoded), 4)).toBe(false);
	});

	it('linear-light blending with a DOM layer with GPU effects between the blended tracks', async () => {
		const raw = await still(
			[
				linear,
				solid('V1', base, '$a'),
				rect('V2', mid, '$s'),
				effect('$s', 'jasper.invert'),
				opacity('$s', 50),
				adjustment('V3', '$adj'),
				solid('V4', top, '$t'),
				opacity('$t', 50),
			],
			5,
			'linear-dom-fx-between',
		);
		expectAt(raw, FX_W / 2, FX_H / 2, linMix(linMix(base, invert(mid), 0.5), top, 0.5));
	});

	// ------------------------------------------------------------ 3D runs

	it('a 3D run over a GL blend-mode track = the CPU reference', async () => {
		await matchesReference(
			[solid('V1', base, '$a'), solid('V2', mid, '$b'), mode('$b', 'linear-burn'), ...card3d('V3', '$c')],
			'run-over-blend',
		);
	});

	it('a GL blend-mode track over a 3D run = the CPU reference', async () => {
		await matchesReference(
			[solid('V1', base, '$a'), ...card3d('V2', '$c'), solid('V3', top, '$t'), mode('$t', 'color-dodge')],
			'blend-over-run',
		);
	});

	it('an adjustment layer with GPU effects over a 3D run = the CPU reference', async () => {
		await matchesReference(
			[
				solid('V1', base, '$a'),
				...card3d('V2', '$c'),
				adjustment('V3', '$adj'),
				effect('$adj', 'jasper.invert'),
			],
			'adjust-over-run',
			invert,
		);
	});

	it('a 3D run over an adjustment layer with GPU effects = the CPU reference', async () => {
		await matchesReference(
			[
				solid('V1', base, '$a'),
				adjustment('V2', '$adj'),
				effect('$adj', 'jasper.invert'),
				...card3d('V3', '$c'),
			],
			'run-over-adjust',
			invert,
		);
	});

	it('two GL blend-mode tracks separated by a 3D run = the CPU reference', async () => {
		await matchesReference(
			[
				solid('V1', base, '$a'),
				solid('V2', mid, '$b'),
				mode('$b', 'linear-burn'),
				...card3d('V3', '$c'),
				solid('V4', top, '$t'),
				mode('$t', 'color-dodge'),
			],
			'blend-run-blend',
		);
	});

	// ------------------------------------------------------------ nested sequences

	const nested = (inner: Command[]): Command[] => [
		{
			type: 'sequence.create',
			name: 'Nest',
			preset: 'hd-720p-30',
			settings: { width: FX_W, height: FX_H },
			tracks: { video: 4, audio: 1 },
			ref: '$seq',
		} as Command,
		...inner.map((c) =>
			(c as { type: string }).type.startsWith('clip.add') ? ({ ...c, sequenceId: '$seq' } as Command) : c,
		),
	];
	const placeNest = (track: string): Command =>
		({
			type: 'clip.place',
			source: { sequenceId: '$seq' },
			at: 0,
			tracks: { video: track },
			ref: '$nest',
		}) as unknown as Command;
	const innerBlendAdjust = [
		solid('V1', base, '$na'),
		solid('V2', mid, '$nb'),
		mode('$nb', 'linear-burn'),
		adjustment('V3', '$nadj'),
		effect('$nadj', 'jasper.invert'),
	];

	it('a nest with GPU effects whose nested sequence nests scopes, under a GL blend (canvas source)', async () => {
		const raw = await still(
			[
				...nested(innerBlendAdjust),
				placeNest('V1'),
				effect('$nest', 'jasper.invert'),
				solid('V2', top, '$t'),
				mode('$t', 'color-dodge'),
			],
			5,
			'nest-canvas-source',
		);
		// The nest shows invert(invert(burn)) = burn; dodged by V2.
		expectAt(
			raw,
			FX_W / 2,
			FX_H / 2,
			over([{ c: base }, { c: mid, mode: 'linear-burn' }, { c: top, mode: 'color-dodge' }]),
		);
	});

	it('a nest whose nested sequence holds a GL blend, under an adjustment layer with GPU effects', async () => {
		const raw = await still(
			[
				...nested([solid('V1', base, '$na'), solid('V2', mid, '$nb'), mode('$nb', 'linear-burn')]),
				placeNest('V1'),
				adjustment('V2', '$adj'),
				effect('$adj', 'jasper.invert'),
			],
			5,
			'nest-under-adjust',
		);
		expectAt(raw, FX_W / 2, FX_H / 2, invert(over([{ c: base }, { c: mid, mode: 'linear-burn' }])));
	});

	// ------------------------------------------------------------ parity with the nested structure
	// The same frame through the scope it always used (one scope: no nesting) and through the flat compositor (the
	// stack is made flat by a GL blend clip on a high track at OTHER frames: two scopes statically, nothing drawn by it
	// at frame 5). Whole frames, so placement, padding and edges are compared too.
	const flatter = (): Command[] => [
		{ type: 'clip.addAdjustment', at: 40, duration: 10, track: 'V6', ref: '$flatAdj' } as Command,
		effect('$flatAdj', 'jasper.invert'),
		{
			type: 'clip.addSolid',
			at: 40,
			duration: 10,
			track: 'V7',
			color: [0.5, 0.5, 0.5, 1],
			ref: '$flat',
		} as Command,
		mode('$flat', 'linear-burn'),
	];
	const parity = async (cmds: Command[], name: string, tol: number, maxBad = 0.002) => {
		const nestedPic = await still(cmds, 5, `${name}-scope`);
		const flatPic = await still([...cmds, ...flatter()], 5, `${name}-flat`);
		let bad = 0;
		let worst = 0;
		for (let i = 0; i < FX_W * FX_H; i++) {
			let e = 0;
			for (let c = 0; c < 3; c++) e = Math.max(e, Math.abs(nestedPic[i * 4 + c]! - flatPic[i * 4 + c]!));
			worst = Math.max(worst, e);
			if (e > tol) bad++;
		}
		expect(bad / (FX_W * FX_H), `${name}: worst ${worst}`).toBeLessThanOrEqual(maxBad);
		return { worst };
	};

	it('parity: an adjustment layer whose GPU blur pads its layout (soft borders) over video', async () => {
		const { worst } = await parity(
			[
				...fxCmd.video(media),
				adjustment('V2', '$adj'),
				effect('$adj', 'jasper.s.blur', { blurAmount: 1.5, softBorders: true }),
				effect('$adj', 'jasper.invert'),
			],
			'parity-adjust-padded',
			2,
		);
		process.stderr.write(`[compositor] parity padded adjustment: worst ${worst}\n`);
	});

	it('parity: a GL blend mode over video and a rotated DOM text layer', async () => {
		await parity(
			[
				...fxCmd.video(media),
				{
					type: 'clip.addText',
					at: 0,
					duration: 30,
					track: 'V2',
					content: { text: 'Jasper', style: { fontSize: 120, fill: [1, 0.9, 0.2, 1] } },
					ref: '$txt',
				} as Command,
				{ type: 'param.set', target: ['clip', '$txt', 'transform', 'rotation'], value: 12 } as Command,
				solid('V3', mid, '$b'),
				mode('$b', 'color-dodge'),
				opacity('$b', 70),
			],
			'parity-blend-text',
			3,
			0.01,
		);
	});

	it('parity: a 3D run over video', async () => {
		await parity([...fxCmd.video(media), ...card3d('V2', '$card')], 'parity-run', 3);
	});

	it('parity: linear-light blending of video, text and a translucent solid', async () => {
		await parity(
			[
				linear,
				...fxCmd.video(media),
				{
					type: 'clip.addText',
					at: 0,
					duration: 30,
					track: 'V2',
					content: { text: 'Jasper', style: { fontSize: 120, fill: [1, 1, 1, 1] } },
				} as Command,
				solid('V3', top, '$t'),
				opacity('$t', 40),
			],
			'parity-linear',
			3,
			0.01,
		);
	});
});
