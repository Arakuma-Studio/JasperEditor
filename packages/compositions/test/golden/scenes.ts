// The golden scene suite (golden-fuzz; docs/testing.md §Golden frames): small procedural projects — generated
// pictures and a generated movie, the Inter font from the repository, no external media — covering the compositor,
// blend modes, masks, adjustment layers, nests, colour (Lumetri, colour runs, working spaces, interpretation), GPU
// effects of every family, text, text animators, shapes, 3D, time remapping, sim-warp effects, captions and an
// in-composition transition. Each scene is one frame rendered by Remotion (test/golden-scenes.e2e.test.ts) and
// compared with goldens/scenes/<name>.png.
import {
	BLEND_MODES,
	type BlendMode,
	blendPixel,
	type Command,
	isCssBlend,
	type RenderSnapshot,
	type Rgba,
} from '@jasper/project';
import type { Tolerance } from '@jasper/testkit/golden';
import { type Rgba8, rgba8 } from '@jasper/testkit/image';
import { referenceFrame } from '../three-d-reference.ts';

export const GW = 256;
export const GH = 144;

/** Media files the scenes use (written into the served directory before rendering). */
export type GoldenMedia = { card: string; tile: string; video: string };

export type Scene = {
	name: string;
	/** What the scene covers (shown on failure). */
	covers: string;
	frame: number;
	commands(
		m: GoldenMedia & { asset(kind: 'image' | 'video', file: string, w: number, h: number): unknown },
	): Command[];
	/** Render options other than the export's (e.g. the Program monitor's `isPreview` for the display transform). */
	options?: { isPreview?: boolean };
	/**
	 * compositor: a reference computed without the composition's GPU path, checked before the golden is compared or
	 * blessed (a golden must never be blessed from a wrong picture).
	 */
	reference?: {
		describe: string;
		compute(r: ReferenceInputs): Rgba8 | Promise<Rgba8>;
		/** `tolerance` (testkit metrics), or at most `maxBad` of the pixels off by more than `level`. */
		check: { tolerance: Tolerance } | { level: number; maxBad: number };
	};
};

export type ReferenceInputs = {
	card: Rgba8;
	tile: Rgba8;
	snapshot: RenderSnapshot;
	/** The same scene rendered with other options (a reference through another, already verified path). */
	render(options: { isPreview?: boolean }): Promise<Rgba8>;
};

// ---------------------------------------------------------------- generated pictures

const clamp8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/**
 * The golden card (GW×GH, opaque): a hue ramp across the top half, a grey step wedge, saturated bars, a white disc
 * with a dark ring and a fine checker patch — hue, tone, edges and detail for every scene.
 */
export function goldenCard(): Rgba8 {
	const img = rgba8(GW, GH);
	for (let y = 0; y < GH; y++)
		for (let x = 0; x < GW; x++) {
			const i = (y * GW + x) * 4;
			let r: number;
			let g: number;
			let b: number;
			if (y < GH / 2) {
				const h = (x / GW) * 6;
				const f = h - Math.floor(h);
				const k = Math.floor(h) % 6;
				const v = 0.35 + 0.65 * (1 - y / (GH / 2)) * 0.6 + 0.25;
				const rgb = [
					[1, f, 0],
					[1 - f, 1, 0],
					[0, 1, f],
					[0, 1 - f, 1],
					[f, 0, 1],
					[1, 0, 1 - f],
				][k]!;
				[r, g, b] = rgb.map((c) => c * 255 * Math.min(1, v)) as [number, number, number];
			} else if (x < GW / 2) {
				const step = Math.floor((x / (GW / 2)) * 8);
				r = g = b = (step * 255) / 7;
			} else {
				const bar = Math.floor(((x - GW / 2) / (GW / 2)) * 6);
				[r, g, b] = [
					[230, 40, 40],
					[40, 200, 60],
					[50, 70, 230],
					[240, 220, 30],
					[30, 210, 220],
					[210, 50, 200],
				][bar]!;
			}
			const dx = x - GW * 0.62;
			const dy = y - GH * 0.32;
			const d = Math.hypot(dx, dy);
			if (d < 18) r = g = b = 250;
			else if (d < 22) r = g = b = 20;
			if (x >= 8 && x < 40 && y >= GH - 28 && y < GH - 8) r = g = b = (x + y) % 2 ? 230 : 25;
			img.data.set([clamp8(r), clamp8(g), clamp8(b), 255], i);
		}
	return img;
}

/** A second picture (GW×GH) for overlays: radial rings over a diagonal two-colour ramp. */
export function goldenTile(): Rgba8 {
	const img = rgba8(GW, GH);
	for (let y = 0; y < GH; y++)
		for (let x = 0; x < GW; x++) {
			const t = (x / GW + y / GH) / 2;
			const ring = 0.5 + 0.5 * Math.cos(Math.hypot(x - GW / 2, y - GH / 2) / 6);
			img.data.set(
				[clamp8(255 * t * ring + 30), clamp8(200 * (1 - t)), clamp8(255 * ring * (1 - t) + 40 * t), 255],
				(y * GW + x) * 4,
			);
		}
	return img;
}

// ---------------------------------------------------------------- command helpers

const cmd = (c: Record<string, unknown>) => c as unknown as Command;

/** The card full-frame on V1 (a still: 5 s from frame 0), ref `$bg`. */
function background(m: Parameters<Scene['commands']>[0], track = 'V1', ref = '$bg'): Command[] {
	return [
		cmd({ type: 'media.register', ref: `${ref}m`, asset: m.asset('image', m.card, GW, GH) }),
		cmd({ type: 'clip.place', source: { mediaId: `${ref}m` }, at: 0, tracks: { video: track }, ref }),
	];
}

/** The tile picture on `track` from frame `at`, ref `ref`. */
function tile(m: Parameters<Scene['commands']>[0], track: string, ref: string, at = 0): Command[] {
	return [
		cmd({ type: 'media.register', ref: `${ref}m`, asset: m.asset('image', m.tile, GW, GH) }),
		cmd({ type: 'clip.place', source: { mediaId: `${ref}m` }, at, tracks: { video: track }, ref }),
	];
}

const set = (target: (string | number)[], value: unknown) => cmd({ type: 'param.set', target, value });
const tracks = (n: number) => cmd({ type: 'track.add', kind: 'video', count: n });
const fx = (clip: string, effectId: string, ref: string, params: Record<string, unknown> = {}): Command[] => [
	cmd({ type: 'effect.add', target: { clipId: clip }, effectId, ref }),
	...Object.entries(params).map(([k, v]) => set(['effect', ref, k], v)),
];

/** One small tile per CSS-drawable blend mode over the card, in a 4×2 grid (these stack freely). */
function cssBlendScene(modes: readonly string[], part: number): Scene {
	return {
		name: `blend-css-${part}`,
		covers: `blend modes ${modes.join(', ')} (stacked tracks)`,
		frame: 10,
		commands: (m) => [
			...background(m),
			tracks(modes.length),
			...modes.flatMap((mode, i) => {
				const ref = `$t${i}`;
				const col = i % 4;
				const row = Math.floor(i / 4);
				return [
					...tile(m, `V${i + 2}`, ref),
					set(['clip', ref, 'transform', 'scale'], 24),
					set(['clip', ref, 'transform', 'position'], [GW * (0.14 + col * 0.24), GH * (0.28 + row * 0.46)]),
					cmd({ type: 'clip.update', clipId: ref, patch: { blendMode: mode } }),
				];
			}),
		],
	};
}

/**
 * A GPU-composited blend mode: the tile at 60 % over the card, with Opacity 80 % so the opacity path of the
 * compositing shader is covered too. One per scene (each mode's own golden); stacks of them, with adjustment layers,
 * linear light and 3D between them, are the `combo-*` scenes (the flat compositor, docs/wp-notes/compositor.md).
 */
function glBlendScene(mode: string): Scene {
	return {
		name: `blend-${mode}`,
		covers: `blend mode ${mode} (GPU compositing) at 80 % opacity`,
		frame: 10,
		commands: (m) => [
			...background(m),
			tracks(1),
			...tile(m, 'V2', '$t'),
			set(['clip', '$t', 'transform', 'scale'], 60),
			set(['clip', '$t', 'opacity'], 80),
			cmd({ type: 'clip.update', clipId: '$t', patch: { blendMode: mode } }),
		],
	};
}

const CSS_BLENDS = BLEND_MODES.filter((b) => b !== 'normal' && isCssBlend(b as BlendMode));
const GL_BLENDS = BLEND_MODES.filter((b) => !isCssBlend(b as BlendMode));

// ---------------------------------------------------------------- compositor: combined scopes

const to01 = (img: Rgba8, i: number): Rgba => [
	img.data[i]! / 255,
	img.data[i + 1]! / 255,
	img.data[i + 2]! / 255,
	1,
];
/** Premultiplied `c` at opacity `o`. */
const at = (c: Rgba, o: number): Rgba => [c[0] * o, c[1] * o, c[2] * o, o];
const inv = (c: Rgba): Rgba => [c[3] - c[0], c[3] - c[1], c[3] - c[2], c[3]];
/** Stored in RGBA8 between layers, as the compositor and the native kernel do. */
const q8 = (c: Rgba): Rgba => c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255) / 255) as Rgba;

/** A picture computed pixel by pixel from the card and the tile (full-frame layers, so no resampling). */
function pixelwise(r: ReferenceInputs, fn: (card: Rgba, tile: Rgba) => Rgba): Rgba8 {
	const out = rgba8(GW, GH);
	for (let i = 0; i < GW * GH * 4; i += 4) {
		const c = fn(to01(r.card, i), to01(r.tile, i));
		const a = Math.min(1, Math.max(0, c[3]));
		for (let k = 0; k < 3; k++)
			out.data[i + k] = a > 0 ? Math.round((Math.min(a, Math.max(0, c[k]!)) / a) * 255) : 0;
		out.data[i + 3] = Math.round(a * 255);
	}
	return out;
}

/** BT.1886 (Rec. 709 working space) decode / encode of premultiplied colour, as the compositor's `cm_*`. */
const toLin = (c: Rgba): Rgba =>
	c[3] <= 0
		? [0, 0, 0, 0]
		: [(c[0] / c[3]) ** 2.4 * c[3], (c[1] / c[3]) ** 2.4 * c[3], (c[2] / c[3]) ** 2.4 * c[3], c[3]];
const toEnc = (c: Rgba): Rgba =>
	c[3] <= 0
		? [0, 0, 0, 0]
		: [
				(c[0] / c[3]) ** (1 / 2.4) * c[3],
				(c[1] / c[3]) ** (1 / 2.4) * c[3],
				(c[2] / c[3]) ** (1 / 2.4) * c[3],
				c[3],
			];
const linBlend = (mode: string, dst: Rgba, src: Rgba): Rgba =>
	toEnc(blendPixel(mode, toLin(dst), toLin(src), 0));

const GL_EXACT = { tolerance: { minPsnr: 40, maxAbs: 8, p99: 3 } };

const COMBINED: Scene[] = [
	{
		name: 'combo-gl-blends-stacked',
		covers: 'two GPU-composited blend modes on consecutive tracks (Linear Burn 60 %, Color Dodge 50 %)',
		frame: 10,
		commands: (m) => [
			...background(m),
			tracks(2),
			...tile(m, 'V2', '$a'),
			set(['clip', '$a', 'opacity'], 60),
			cmd({ type: 'clip.update', clipId: '$a', patch: { blendMode: 'linear-burn' } }),
			...tile(m, 'V3', '$b'),
			set(['clip', '$b', 'opacity'], 50),
			cmd({ type: 'clip.update', clipId: '$b', patch: { blendMode: 'color-dodge' } }),
		],
		reference: {
			describe: 'blendPixel per pixel, stored in RGBA8 between layers',
			compute: (r) =>
				pixelwise(r, (c, t) =>
					q8(blendPixel('color-dodge', q8(blendPixel('linear-burn', c, at(t, 0.6), 0)), at(t, 0.5), 0)),
				),
			check: GL_EXACT,
		},
	},
	{
		name: 'combo-adjust-over-gl-blend',
		covers:
			'an adjustment layer with a GPU effect (Invert) over a GPU-composited blend mode (Linear Burn 70 %)',
		frame: 10,
		commands: (m) => [
			...background(m),
			tracks(2),
			...tile(m, 'V2', '$a'),
			set(['clip', '$a', 'opacity'], 70),
			cmd({ type: 'clip.update', clipId: '$a', patch: { blendMode: 'linear-burn' } }),
			cmd({ type: 'clip.addAdjustment', at: 0, duration: 60, track: 'V3', ref: '$adj' }),
			...fx('$adj', 'jasper.invert', '$i'),
		],
		reference: {
			describe: 'Invert of blendPixel per pixel',
			compute: (r) => pixelwise(r, (c, t) => inv(q8(blendPixel('linear-burn', c, at(t, 0.7), 0)))),
			check: GL_EXACT,
		},
	},
	{
		name: 'combo-blend-adjust-blend',
		covers: 'two GPU-composited blend modes separated by an adjustment layer with a GPU effect',
		frame: 10,
		commands: (m) => [
			...background(m),
			tracks(3),
			...tile(m, 'V2', '$a'),
			set(['clip', '$a', 'opacity'], 60),
			cmd({ type: 'clip.update', clipId: '$a', patch: { blendMode: 'vivid-light' } }),
			cmd({ type: 'clip.addAdjustment', at: 0, duration: 60, track: 'V3', ref: '$adj' }),
			...fx('$adj', 'jasper.invert', '$i'),
			...tile(m, 'V4', '$b'),
			set(['clip', '$b', 'opacity'], 40),
			cmd({ type: 'clip.update', clipId: '$b', patch: { blendMode: 'subtract' } }),
		],
		reference: {
			describe: 'blendPixel, Invert, blendPixel per pixel',
			compute: (r) =>
				pixelwise(r, (c, t) =>
					q8(blendPixel('subtract', inv(q8(blendPixel('vivid-light', c, at(t, 0.6), 0))), at(t, 0.4), 0)),
				),
			check: GL_EXACT,
		},
	},
	{
		name: 'combo-linear-adjust-between',
		covers:
			'Blend Using 1.0 Gamma with an adjustment layer (Invert) between the blended tracks (Normal 50 %, Screen 40 %)',
		frame: 10,
		commands: (m) => [
			cmd({ type: 'sequence.updateSettings', settings: { color: { blendLinear: true } } }),
			...background(m),
			tracks(3),
			...tile(m, 'V2', '$a'),
			set(['clip', '$a', 'opacity'], 50),
			cmd({ type: 'clip.addAdjustment', at: 0, duration: 60, track: 'V3', ref: '$adj' }),
			...fx('$adj', 'jasper.invert', '$i'),
			...tile(m, 'V4', '$b'),
			set(['clip', '$b', 'opacity'], 40),
			cmd({ type: 'clip.update', clipId: '$b', patch: { blendMode: 'screen' } }),
		],
		reference: {
			describe: 'blendPixel in linear light of BT.1886 (decode, blend, encode) per pixel',
			compute: (r) =>
				pixelwise(r, (c, t) =>
					q8(linBlend('screen', inv(q8(linBlend('normal', c, at(t, 0.5)))), at(t, 0.4))),
				),
			check: GL_EXACT,
		},
	},
	{
		name: 'combo-3d-blend-adjust',
		covers: 'a 3D run between a GPU-composited blend mode and an adjustment layer with a GPU effect (solids)',
		frame: 10,
		commands: () => [
			tracks(1),
			cmd({
				type: 'clip.addSolid',
				at: 0,
				duration: 60,
				track: 'V1',
				color: [0.85, 0.45, 0.2, 1],
				ref: '$a',
			}),
			cmd({ type: 'clip.addSolid', at: 0, duration: 60, track: 'V2', color: [0.3, 0.6, 0.9, 1], ref: '$b' }),
			set(['clip', '$b', 'transform', 'scale'], 60),
			cmd({ type: 'clip.update', clipId: '$b', patch: { blendMode: 'linear-burn' } }),
			cmd({
				type: 'clip.addSolid',
				at: 0,
				duration: 60,
				track: 'V3',
				color: [0.95, 0.1, 0.15, 1],
				ref: '$c',
			}),
			set(['clip', '$c', 'transform', 'scale'], 40),
			cmd({ type: 'clip.set3d', clipIds: ['$c'], enabled: true }),
			set(['clip', '$c', 'threeD', 'rotationY'], 35),
			cmd({ type: 'clip.addAdjustment', at: 0, duration: 60, track: 'V4', ref: '$adj' }),
			...fx('$adj', 'jasper.invert', '$i'),
		],
		reference: {
			describe: 'the Classic 3D CPU reference with blendPixel and a pointwise Invert',
			compute: (r) => {
				const px = referenceFrame(r.snapshot, 10, { adjust: (c) => [1 - c[0], 1 - c[1], 1 - c[2], c[3]] });
				return rgba8(GW, GH, px);
			},
			// Edges: the reference samples pixel centres without antialiasing.
			check: { level: 6, maxBad: 0.02 },
		},
	},
	{
		name: 'combo-hdr-display-scope',
		covers:
			'the Program monitor of a Rec. 2100 PQ sequence (display transform) while a GPU blend scope draws inside it',
		frame: 10,
		options: { isPreview: true },
		commands: (m) => [
			cmd({ type: 'sequence.updateSettings', settings: { workingColorSpace: 'rec2100-pq' } }),
			...background(m),
			tracks(1),
			...tile(m, 'V2', '$a'),
			set(['clip', '$a', 'opacity'], 70),
			cmd({ type: 'clip.update', clipId: '$a', patch: { blendMode: 'linear-burn' } }),
		],
		reference: {
			describe:
				'the export render (working signal; one blend scope, the nested structure) through the display LUT on the CPU',
			compute: async (r) => {
				const img = await r.render({ isPreview: false });
				// Loaded here: the engine's golden-parity test imports this module for its pictures only.
				const { displayLutOf } = await import('../../src/color/DisplayStage.tsx');
				const { applyLutRgba8 } = await import('../../src/color/cpu.ts');
				const display = displayLutOf(r.snapshot.settings.color);
				if (!display) throw new Error('no display transform for this working space');
				const px = new Uint8ClampedArray(img.data);
				applyLutRgba8(display.lut, px);
				return rgba8(GW, GH, px);
			},
			check: GL_EXACT,
		},
	},
];

// ---------------------------------------------------------------- the scenes

export const SCENES: Scene[] = [
	{
		name: 'card',
		covers: 'a still placed full-frame (the reference the other scenes change)',
		frame: 10,
		commands: (m) => background(m),
	},
	{
		name: 'transform-opacity',
		covers: 'Motion: position, scale, rotation, anchor; Opacity over a background',
		frame: 10,
		commands: (m) => [
			...background(m),
			tracks(1),
			...tile(m, 'V2', '$t'),
			set(['clip', '$t', 'transform', 'scale'], 55),
			set(['clip', '$t', 'transform', 'rotation'], 25),
			set(['clip', '$t', 'transform', 'position'], [GW * 0.6, GH * 0.55]),
			set(['clip', '$t', 'opacity'], 65),
		],
	},
	{
		name: 'crop-corner-pin',
		covers: 'Crop (with feather) and Corner Pin on an overlay',
		frame: 10,
		commands: (m) => [
			...background(m),
			tracks(1),
			...tile(m, 'V2', '$t'),
			...fx('$t', 'jasper.crop', '$c', { left: 10, right: 15, top: 8, bottom: 20, feather: 6 }),
			...fx('$t', 'jasper.corner-pin', '$p', {
				topLeft: [0.1, 0.05],
				topRight: [0.85, 0.2],
				bottomRight: [0.95, 0.9],
				bottomLeft: [0.05, 0.75],
			}),
		],
	},
	cssBlendScene(CSS_BLENDS.slice(0, 6), 1),
	cssBlendScene(CSS_BLENDS.slice(6), 2),
	...GL_BLENDS.map(glBlendScene),
	{
		name: 'masks',
		covers: 'masks: a feathered, expanded ellipse minus a polygon (subtract)',
		frame: 10,
		commands: (m) => [
			...background(m),
			tracks(1),
			...tile(m, 'V2', '$t'),
			cmd({ type: 'mask.add', clipId: '$t', shape: 'ellipse', feather: 4, expansion: 6, ref: '$a' }),
			cmd({ type: 'mask.add', clipId: '$t', shape: 'polygon', mode: 'subtract', feather: 0, ref: '$b' }),
		],
	},
	{
		name: 'adjustment-layer',
		covers: 'an adjustment layer (Black & White + Gaussian Blur) affecting the layers below, masked',
		frame: 10,
		commands: (m) => [
			...background(m),
			tracks(1),
			cmd({ type: 'clip.addAdjustment', at: 0, duration: 60, track: 'V2', ref: '$adj' }),
			...fx('$adj', 'jasper.black-white', '$bw'),
			...fx('$adj', 'jasper.gaussian-blur', '$gb', { radius: 3 }),
			cmd({ type: 'mask.add', clipId: '$adj', shape: 'ellipse', feather: 10, ref: '$am' }),
		],
	},
	{
		name: 'nest',
		covers: 'a nested sequence (two layers) transformed as one clip',
		frame: 10,
		commands: (m) => [
			...background(m),
			tracks(2),
			...tile(m, 'V2', '$t'),
			cmd({ type: 'clip.addSolid', at: 0, duration: 60, track: 'V3', color: [1, 0.5, 0, 1], ref: '$s' }),
			set(['clip', '$s', 'transform', 'scale'], 30),
			cmd({ type: 'clip.nest', clipIds: ['$t', '$s'], name: 'Nest', ref: '$n' }),
		],
	},
	{
		name: 'lumetri',
		covers: 'Lumetri Color: temperature, tint, exposure, contrast, highlights/shadows, saturation, vibrance',
		frame: 10,
		commands: (m) => [
			...background(m),
			...fx('$bg', 'jasper.lumetri', '$l', {
				temperature: -35,
				tint: 12,
				exposure: 0.4,
				contrast: 25,
				highlights: -30,
				shadows: 25,
				saturation: 140,
				vibrance: 20,
			}),
		],
	},
	{
		name: 'colour-run',
		covers: 'a colour run (Brightness & Contrast, Hue/Saturation, Tint baked into one LUT pass)',
		frame: 10,
		commands: (m) => [
			...background(m),
			...fx('$bg', 'jasper.brightness-contrast', '$b', { brightness: 15, contrast: 30 }),
			...fx('$bg', 'jasper.hue-saturation', '$h', { hue: 60, saturation: -30 }),
			...fx('$bg', 'jasper.tint', '$t', { mapBlackTo: [0.1, 0, 0.3, 1], amountToTint: 40 }),
		],
	},
	{
		name: 'working-space-linear',
		covers:
			'colour management: a linear working space (Linearize + linear-light blending) of overlapping layers',
		frame: 10,
		commands: (m) => [
			cmd({ type: 'sequence.updateSettings', settings: { workingColorSpace: 'rec709-linear' } }),
			...background(m),
			tracks(1),
			...tile(m, 'V2', '$t'),
			set(['clip', '$t', 'opacity'], 50),
			cmd({ type: 'clip.update', clipId: '$t', patch: { blendMode: 'screen' } }),
		],
	},
	{
		name: 'working-space-pq',
		covers:
			'colour management: a Rec. 2100 PQ working space (HDR) with Opacity over the card, shown tone mapped',
		frame: 10,
		commands: (m) => [
			cmd({ type: 'sequence.updateSettings', settings: { workingColorSpace: 'rec2100-pq' } }),
			...background(m),
			tracks(1),
			...tile(m, 'V2', '$t'),
			set(['clip', '$t', 'transform', 'scale'], 50),
			set(['clip', '$t', 'opacity'], 70),
		],
	},
	{
		name: 'optical-flow',
		covers:
			'Time Interpolation ▸ Optical Flow on the generated movie at 30 % speed (in-between frames synthesised)',
		frame: 13,
		commands: (m) => [
			cmd({ type: 'media.register', ref: '$vm', asset: m.asset('video', m.video, GW, GH) }),
			cmd({
				type: 'clip.place',
				source: { mediaId: '$vm' },
				at: 0,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 1 } },
				tracks: { video: 'V1' },
				ref: '$v',
			}),
			cmd({ type: 'clip.setSpeed', clipIds: ['$v'], rate: 0.3, ripple: false }),
			cmd({ type: 'clip.setTimeInterpolation', clipIds: ['$v'], mode: 'optical-flow' }),
		],
	},
	{
		name: 'interpret-log',
		covers:
			'colour management: footage interpreted as S-Log3 / S-Gamut3.Cine into the Rec. 709 working space',
		frame: 10,
		commands: (m) => [
			...background(m),
			cmd({ type: 'media.interpretColor', mediaIds: ['$bgm'], color: { space: 'slog3-sgamut3cine' } }),
		],
	},
	{
		name: 'text',
		covers: 'a text layer (Inter, size, fill, drop shadow) over the card',
		frame: 10,
		commands: (m) => [
			...background(m),
			tracks(1),
			cmd({
				type: 'clip.addText',
				at: 0,
				duration: 60,
				track: 'V2',
				content: {
					text: 'Golden 42 ✓',
					style: {
						sizePx: 26,
						fill: [1, 1, 0.2, 1],
						shadow: { color: [0, 0, 0, 1], angleDeg: 135, distancePx: 2, blurPx: 1 },
					},
				},
				ref: '$x',
			}),
		],
	},
	{
		name: 'text-animator',
		covers: 'a text animator: per-character position offset and opacity through the default range selector',
		frame: 8,
		commands: (m) => [
			...background(m),
			tracks(1),
			cmd({
				type: 'clip.addText',
				at: 0,
				duration: 60,
				track: 'V2',
				content: { text: 'ANIMATE', style: { sizePx: 30 } },
				ref: '$x',
			}),
			cmd({ type: 'textAnimator.add', clipId: '$x', properties: ['position', 'opacity'], ref: '$a' }),
			set(['clip', '$x', 'textAnimators', '$a', 'properties', 'position'], [0, -30]),
			set(['clip', '$x', 'textAnimators', '$a', 'properties', 'opacity'], 35),
		],
	},
	{
		name: 'shapes',
		covers: 'shape layers: rectangle with stroke, ellipse, a vector star with fill and stroke',
		frame: 10,
		commands: (m) => [
			...background(m),
			tracks(3),
			cmd({
				type: 'clip.addShape',
				at: 0,
				duration: 60,
				track: 'V2',
				shape: {
					type: 'rect',
					size: [80, 50],
					fill: [0.2, 0.8, 1, 1],
					stroke: { color: [0, 0, 0, 1], width: 4 },
				},
				ref: '$r',
			}),
			set(['clip', '$r', 'transform', 'position'], [GW * 0.25, GH * 0.5]),
			cmd({
				type: 'clip.addShape',
				at: 0,
				duration: 60,
				track: 'V3',
				shape: { type: 'ellipse', size: [60, 60], fill: [1, 0.3, 0.6, 1] },
				ref: '$e',
			}),
			set(['clip', '$e', 'transform', 'position'], [GW * 0.55, GH * 0.5]),
			cmd({
				type: 'clip.addShape',
				at: 0,
				duration: 60,
				track: 'V4',
				shape: {
					type: 'vector',
					contents: [{ type: 'polystar' }, { type: 'fill' }, { type: 'stroke' }],
				},
				ref: '$v',
			}),
			set(['clip', '$v', 'transform', 'position'], [GW * 0.8, GH * 0.5]),
			set(['clip', '$v', 'transform', 'scale'], 40),
		],
	},
	{
		name: 'three-d',
		covers: '3D layers: a rotated, pushed-back layer seen by the default camera',
		frame: 10,
		commands: (m) => [
			...background(m),
			tracks(1),
			...tile(m, 'V2', '$t'),
			set(['clip', '$t', 'transform', 'scale'], 60),
			cmd({ type: 'clip.set3d', clipIds: ['$t'], enabled: true }),
			set(['clip', '$t', 'threeD', 'rotationY'], 35),
			set(['clip', '$t', 'threeD', 'positionZ'], 120),
		],
	},
	{
		name: 'time-remap',
		covers: 'Time Remapping: a generated movie slowed to 25 % between two speed keyframes',
		frame: 20,
		commands: (m) => [
			cmd({ type: 'media.register', ref: '$vm', asset: m.asset('video', m.video, GW, GH) }),
			cmd({
				type: 'clip.place',
				source: { mediaId: '$vm' },
				at: 0,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 1.5 } },
				tracks: { video: 'V1' },
				ref: '$v',
			}),
			cmd({ type: 'timeRemap.enable', clipIds: ['$v'], enabled: true }),
			cmd({ type: 'timeRemap.addKeyframe', clipId: '$v', at: 5 }),
			cmd({ type: 'timeRemap.addKeyframe', clipId: '$v', at: 10 }),
			cmd({ type: 'timeRemap.setSpeed', clipId: '$v', at: 7, speedPercent: 25 }),
		],
	},
	{
		name: 'sim-warp',
		covers: 'sim-warp: a Liquify warp stroke and Wave Warp on the card',
		frame: 10,
		commands: (m) => [
			...background(m),
			...fx('$bg', 'jasper.liquify', '$lq', { brushSize: 50 }),
			cmd({
				type: 'liquify.stroke',
				effectInstanceId: '$lq',
				points: [
					[60, 70],
					[110, 60],
					[150, 75],
				],
			}),
			...fx('$bg', 'jasper.wave-warp', '$ww', { waveHeight: 6, waveWidth: 50 }),
		],
	},
	{
		name: 'captions',
		covers: 'captions burned in from a caption track (default style, Inter)',
		frame: 10,
		commands: (m) => [
			...background(m),
			cmd({ type: 'caption.addTrack', name: 'English', language: 'en' }),
			cmd({ type: 'caption.add', at: 0, duration: 40, text: 'Burned-in caption\nsecond line' }),
		],
	},
	{
		name: 'transition-cross-dissolve',
		covers: 'a Cross Dissolve at 50 % between the card and the tile, rendered by the composition',
		frame: 40,
		commands: (m) => [
			...background(m),
			// Overwrites the card from frame 40: the cut the transition sits on (centred: frames 30–50).
			...tile(m, 'V1', '$t', 40),
			cmd({
				type: 'transition.add',
				clipId: '$t',
				edge: 'in',
				effectId: 'jasper.cross-dissolve',
				duration: 20,
			}),
		],
	},
	{
		name: 'fx-time',
		covers:
			'GPU time effect jasper.s.trails (time-flicker family) on the generated movie: earlier frames blended in',
		frame: 20,
		commands: (m) => [
			cmd({ type: 'media.register', ref: '$vm', asset: m.asset('video', m.video, GW, GH) }),
			cmd({
				type: 'clip.place',
				source: { mediaId: '$vm' },
				at: 0,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 1.5 } },
				tracks: { video: 'V1' },
				ref: '$v',
			}),
			...fx('$v', 'jasper.s.trails', '$fx'),
		],
	},
	// GPU effects: one representative of every effect family, at visible settings, on the card.
	...(
		[
			['fx-premiere-adjust', 'jasper.black-white', {}],
			['fx-premiere-stylize', 'jasper.wave-warp', { waveHeight: 12 }],
			['fx-glows', 'jasper.s.glow', {}],
			['fx-paint', 'jasper.s.posterize', {}],
			['fx-film', 'jasper.s.bleach-bypass', {}],
			['fx-stylize', 'jasper.s.mosaic', {}],
			['fx-adjust-composite', 'jasper.s.duo-tone', {}],
			['fx-blur-sharpen', 'jasper.s.blur', {}],
			['fx-distort', 'jasper.s.warp-bubble', {}],
			['fx-render', 'jasper.s.gradient-radial', {}],
			['fx-textures', 'jasper.s.clouds', {}],
			['fx-keying', 'jasper.screen-keyer', { screenColour: [0.94, 0.86, 0.12, 1] }],
			['fx-simulation', 'jasper.pixel-polly', {}],
		] as const
	).map(
		([name, id, params]): Scene => ({
			name,
			covers: `GPU effect ${id} (its family's representative)`,
			frame: 12,
			commands: (m) => [...background(m), ...fx('$bg', id, '$fx', params as Record<string, unknown>)],
		}),
	),
	// compositor: combinations whose canvas scopes used to nest (CANVAS_NESTED) and render through the flat
	// compositor now, each checked against a computed reference before its golden (see `reference`).
	...COMBINED,
];
