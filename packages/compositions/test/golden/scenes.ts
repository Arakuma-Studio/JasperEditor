// The golden scene suite (golden-fuzz; docs/testing.md §Golden frames): small procedural projects — generated
// pictures and a generated movie, the Inter font from the repository, no external media — covering the compositor,
// blend modes, masks, adjustment layers, nests, colour (Lumetri, colour runs, working spaces, interpretation), GPU
// effects of every family, text, text animators, shapes, 3D, time remapping, sim-warp effects, captions and an
// in-composition transition. Each scene is one frame rendered by Remotion (test/golden-scenes.e2e.test.ts) and
// compared with goldens/scenes/<name>.png.
import { BLEND_MODES, type Command } from '@jasper/project';
import { type Rgba8, rgba8 } from '@jasper/testkit/image';

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

/** One small tile per blend mode over the card, in a 4×2 grid. */
function blendScene(modes: readonly string[], part: number): Scene {
	return {
		name: `blend-modes-${part}`,
		covers: `blend modes ${modes.join(', ')}`,
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
	...[0, 1, 2, 3].map((p) => blendScene(BLEND_MODES.slice(p * 8, p * 8 + 8), p + 1)),
	{
		name: 'masks',
		covers: 'masks: a feathered, expanded ellipse minus a polygon (subtract)',
		frame: 10,
		commands: (m) => [
			...background(m),
			tracks(1),
			...tile(m, 'V2', '$t'),
			cmd({ type: 'mask.add', clipId: '$t', shape: 'ellipse', feather: 14, expansion: 4, ref: '$a' }),
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
		covers: 'a text layer (Inter, size, colour) over the card',
		frame: 10,
		commands: (m) => [
			...background(m),
			tracks(1),
			cmd({
				type: 'clip.addText',
				at: 0,
				duration: 60,
				track: 'V2',
				content: { text: 'Golden 42 ✓', style: { size: 34, color: [1, 1, 0.2, 1] } },
				ref: '$x',
			}),
		],
	},
	{
		name: 'text-animator',
		covers: 'a text animator preset mid-animation (per-character offsets and opacity)',
		frame: 8,
		commands: (m) => [
			...background(m),
			tracks(1),
			cmd({
				type: 'clip.addText',
				at: 0,
				duration: 60,
				track: 'V2',
				content: { text: 'ANIMATE', style: { size: 40 } },
				ref: '$x',
			}),
			cmd({ type: 'textAnimator.add', clipId: '$x', properties: ['position', 'opacity'], ref: '$a' }),
			set(['clip', '$x', 'textAnimators', '$a', 'properties', 'position'], [0, -30]),
			set(['clip', '$x', 'textAnimators', '$a', 'properties', 'opacity'], 0),
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
	// GPU effects: one representative of every effect family, at visible settings, on the card.
	...(
		[
			['fx-premiere-adjust', 'jasper.black-white', {}],
			['fx-premiere-stylize', 'jasper.wave-warp', { waveHeight: 12 }],
			['fx-glows', 'jasper.s.glow', {}],
			['fx-paint', 'jasper.s.sketch', {}],
			['fx-film', 'jasper.s.film-effect', {}],
			['fx-stylize', 'jasper.s.mosaic', {}],
			['fx-adjust-composite', 'jasper.s.duo-tone', {}],
			['fx-blur-sharpen', 'jasper.s.blur', {}],
			['fx-distort', 'jasper.s.warp-bubble', {}],
			['fx-render', 'jasper.s.gradient-radial', {}],
			['fx-textures', 'jasper.s.clouds', {}],
			['fx-time', 'jasper.s.flicker', {}],
			['fx-keying', 'jasper.screen-keyer', { screenColour: [0.94, 0.86, 0.12, 1] }],
			['fx-simulation', 'jasper.card-dance', {}],
		] as const
	).map(
		([name, id, params]): Scene => ({
			name,
			covers: `GPU effect ${id} (its family's representative)`,
			frame: 12,
			commands: (m) => [...background(m), ...fx('$bg', id, '$fx', params as Record<string, unknown>)],
		}),
	),
];
