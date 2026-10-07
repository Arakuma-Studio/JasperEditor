// Shape presets (wp shapes): ready-made vector shape contents for the New Shape menu, the Properties "Add ▸ Preset"
// list and agents (`clip.addShape {type: 'vector', preset}`, `shape.addItems {preset}`). Coordinates are layer
// pixels around the layer centre, sized for a 1080p frame; animated presets key times in seconds from the clip's
// first frame.
import type { Keyframe } from '../schema/common.ts';
import { FLICKS_PER_SECOND } from '../time.ts';

export type ShapePreset = {
	id: string;
	label: string;
	category: 'basic' | 'symbols' | 'animated';
	description: string;
	/** Items in the relaxed input form (`ShapeItemInputSchema`), validated when built. */
	items(): Record<string, unknown>[];
};

const EASY = { influence: 1 / 3, slope: 0 };
const LIN = { influence: 1 / 3, slope: 1 };

/** Keyframes from [seconds, value] pairs (Easy Ease unless `linear`); ids are replaced when the items are built. */
function keys<T>(pairs: [number, T][], linear = false) {
	const kfs: Keyframe<T>[] = pairs.map(([s, value], i) => ({
		id: `kf_preset${i}`,
		time: Math.round(s * FLICKS_PER_SECOND),
		value,
		interpolation: linear ? 'linear' : 'bezier',
		easeIn: linear ? LIN : EASY,
		easeOut: linear ? LIN : EASY,
	}));
	return { value: pairs[0]![1], keyframes: kfs };
}

const WHITE = [1, 1, 1, 1];
const ACCENT = [0.18, 0.52, 1, 1];

export const SHAPE_PRESETS: readonly ShapePreset[] = [
	{
		id: 'rounded-rectangle',
		label: 'Rounded Rectangle',
		category: 'basic',
		description: 'A 600×300 rectangle with 40 px corners and a white fill.',
		items: () => [
			{ type: 'rect', size: [600, 300], roundness: 40 },
			{ type: 'fill', color: WHITE },
		],
	},
	{
		id: 'circle-outline',
		label: 'Circle Outline',
		category: 'basic',
		description: 'A 400 px circle drawn with a 12 px white stroke.',
		items: () => [
			{ type: 'ellipse', size: [400, 400] },
			{ type: 'stroke', color: WHITE, width: 12 },
		],
	},
	{
		id: 'star',
		label: 'Star',
		category: 'basic',
		description: 'A five-point star (outer radius 200, inner 90) with a gold fill.',
		items: () => [
			{ type: 'polystar', starType: 'star', points: 5, outerRadius: 200, innerRadius: 90 },
			{ type: 'fill', color: [1, 0.78, 0.15, 1] },
		],
	},
	{
		id: 'hexagon',
		label: 'Hexagon',
		category: 'basic',
		description: 'A regular hexagon (radius 200) with slightly rounded corners.',
		items: () => [
			{ type: 'polystar', starType: 'polygon', points: 6, outerRadius: 200, rotation: 30 },
			{ type: 'roundCorners', radius: 16 },
			{ type: 'fill', color: ACCENT },
		],
	},
	{
		id: 'burst-badge',
		label: 'Burst Badge',
		category: 'basic',
		description: 'A 20-point burst with rounded tips, for price tags and callouts.',
		items: () => [
			{ type: 'polystar', starType: 'star', points: 20, outerRadius: 220, innerRadius: 185, outerRoundness: 20 },
			{ type: 'fill', color: [0.95, 0.2, 0.25, 1] },
		],
	},
	{
		id: 'ring',
		label: 'Ring',
		category: 'basic',
		description: 'A donut: a 400 px circle minus a 260 px circle (Merge Paths ▸ Subtract).',
		items: () => [
			{ type: 'ellipse', size: [400, 400] },
			{ type: 'ellipse', size: [260, 260] },
			{ type: 'mergePaths', mode: 'subtract' },
			{ type: 'fill', color: WHITE },
		],
	},
	{
		id: 'gradient-orb',
		label: 'Gradient Orb',
		category: 'basic',
		description: 'A sphere-like circle filled with a radial gradient whose highlight sits top-left.',
		items: () => [
			{ type: 'ellipse', size: [400, 400] },
			{
				type: 'gradientFill',
				gradientType: 'radial',
				startPoint: [0, 0],
				endPoint: [200, 0],
				highlightLength: 55,
				highlightAngle: -135,
				colors: {
					colors: [
						{ position: 0, color: [0.75, 0.88, 1] },
						{ position: 1, color: [0.05, 0.2, 0.55] },
					],
					opacities: [
						{ position: 0, opacity: 1 },
						{ position: 1, opacity: 1 },
					],
				},
			},
		],
	},
	{
		id: 'lower-third-bar',
		label: 'Lower Third Bar',
		category: 'basic',
		description: 'A 1200×120 bar with a left-to-right gradient that fades out.',
		items: () => [
			{ type: 'rect', size: [1200, 120], position: [0, 360] },
			{
				type: 'gradientFill',
				startPoint: [-600, 360],
				endPoint: [600, 360],
				colors: {
					colors: [
						{ position: 0, color: [0.1, 0.1, 0.12] },
						{ position: 1, color: [0.1, 0.1, 0.12] },
					],
					opacities: [
						{ position: 0, opacity: 0.9 },
						{ position: 0.7, opacity: 0.6 },
						{ position: 1, opacity: 0 },
					],
				},
			},
		],
	},
	{
		id: 'heart',
		label: 'Heart',
		category: 'symbols',
		description: 'A heart drawn as one Bézier path.',
		items: () => [
			{
				type: 'path',
				path: 'M0 170 C-110 90 -200 20 -200 -60 C-200 -130 -145 -180 -90 -180 C-45 -180 -15 -150 0 -115 C15 -150 45 -180 90 -180 C145 -180 200 -130 200 -60 C200 20 110 90 0 170 Z',
			},
			{ type: 'fill', color: [0.92, 0.16, 0.3, 1] },
		],
	},
	{
		id: 'arrow',
		label: 'Arrow',
		category: 'symbols',
		description: 'A right-pointing block arrow.',
		items: () => [
			{ type: 'path', path: 'M-220 -50 L40 -50 L40 -130 L220 0 L40 130 L40 50 L-220 50 Z' },
			{ type: 'fill', color: WHITE },
		],
	},
	{
		id: 'speech-bubble',
		label: 'Speech Bubble',
		category: 'symbols',
		description: 'A rounded bubble with a tail, merged into one outline (Merge Paths ▸ Add).',
		items: () => [
			{ type: 'rect', size: [520, 300], roundness: 60 },
			{ type: 'path', path: 'M-150 100 L-200 220 L-40 130 Z' },
			{ type: 'mergePaths', mode: 'add' },
			{ type: 'stroke', color: [0.1, 0.1, 0.1, 1], width: 8, lineJoin: 'round' },
			{ type: 'fill', color: WHITE },
		],
	},
	{
		id: 'checkmark',
		label: 'Check Mark',
		category: 'symbols',
		description: 'A check mark stroked with round caps and joins.',
		items: () => [
			{ type: 'path', path: 'M-150 0 L-40 110 L170 -120' },
			{ type: 'stroke', color: [0.2, 0.85, 0.4, 1], width: 40, lineCap: 'round', lineJoin: 'round' },
		],
	},
	{
		id: 'plus',
		label: 'Plus',
		category: 'symbols',
		description: 'A plus sign from two rounded bars (Merge Paths ▸ Add).',
		items: () => [
			{ type: 'rect', size: [360, 90], roundness: 20 },
			{ type: 'rect', size: [90, 360], roundness: 20 },
			{ type: 'mergePaths', mode: 'add' },
			{ type: 'fill', color: WHITE },
		],
	},
	{
		id: 'draw-on-circle',
		label: 'Draw-On Circle',
		category: 'animated',
		description: 'A circle stroke that draws itself in the first second (Trim Paths End 0 → 100 %).',
		items: () => [
			{ type: 'ellipse', size: [400, 400] },
			{ type: 'stroke', color: WHITE, width: 14, lineCap: 'round' },
			{ type: 'trim', end: keys([[0, 0], [1, 100]]) },
		],
	},
	{
		id: 'loading-spinner',
		label: 'Loading Spinner',
		category: 'animated',
		description: 'A quarter arc spinning around a circle (Trim Paths Offset, two turns a second for 5 s).',
		items: () => [
			{ type: 'ellipse', size: [240, 240] },
			{ type: 'stroke', color: ACCENT, width: 20, lineCap: 'round' },
			{ type: 'trim', start: 0, end: 25, offset: keys([[0, 0], [5, 3600]], true) },
		],
	},
	{
		id: 'pulse-rings',
		label: 'Pulse Rings',
		category: 'animated',
		description: 'Concentric rings from a Repeater, growing outwards and fading (Scale and Opacity ramp).',
		items: () => [
			{
				type: 'group',
				name: 'Rings',
				contents: [
					{ type: 'ellipse', size: [120, 120] },
					{ type: 'stroke', color: WHITE, width: 6 },
				],
				transform: { scale: keys([[0, [60, 60]], [2, [110, 110]]]) },
			},
			{
				type: 'repeater',
				copies: 5,
				composite: 'below',
				transform: { position: [0, 0], scale: [150, 150], startOpacity: 100, endOpacity: 10 },
			},
		],
	},
	{
		id: 'wobbly-blob',
		label: 'Wobbly Blob',
		category: 'animated',
		description: 'A circle that wobbles on its own (Wiggle Paths, smooth, 1 wiggle per second).',
		items: () => [
			{ type: 'ellipse', size: [360, 360] },
			{ type: 'wiggle', size: 30, detail: 3, points: 'smooth', speed: 1, correlation: 20 },
			{ type: 'fill', color: [0.55, 0.3, 0.95, 1] },
		],
	},
	{
		id: 'wave-line',
		label: 'Wave Line',
		category: 'animated',
		description: 'A smooth zig-zag line whose waves travel (Zig Zag + animated Trim Paths offset).',
		items: () => [
			{ type: 'path', path: 'M-500 0 L500 0' },
			{ type: 'zigZag', size: 30, ridges: 12, points: 'smooth' },
			{ type: 'stroke', color: WHITE, width: 8, lineCap: 'round' },
			{ type: 'trim', start: 0, end: keys([[0, 0], [1.5, 100]]) },
		],
	},
	{
		id: 'burst-lines',
		label: 'Burst Lines',
		category: 'animated',
		description: 'Twelve rays around a centre (Repeater rotation 30°) that shoot out with Trim Paths.',
		items: () => [
			{ type: 'path', path: 'M0 -80 L0 -220' },
			{ type: 'stroke', color: [1, 0.85, 0.2, 1], width: 10, lineCap: 'round' },
			{ type: 'trim', start: keys([[0.2, 0], [0.8, 100]]), end: keys([[0, 0], [0.6, 100]]) },
			{ type: 'repeater', copies: 12, transform: { position: [0, 0], rotation: 30 } },
		],
	},
	{
		id: 'marching-ants',
		label: 'Marching Ants',
		category: 'animated',
		description: 'A dashed rectangle outline whose dashes march around it (Dash Offset animated).',
		items: () => [
			{ type: 'rect', size: [600, 340], roundness: 12 },
			{
				type: 'stroke',
				color: WHITE,
				width: 6,
				dashes: { segments: [{ dash: 24, gap: 16 }], offset: keys([[0, 0], [5, -400]], true) },
			},
		],
	},
	{
		id: 'tapered-swoosh',
		label: 'Tapered Swoosh',
		category: 'animated',
		description: 'A curved brush stroke with tapered ends that draws on (Stroke Taper + Trim Paths).',
		items: () => [
			{ type: 'path', path: 'M-400 120 C-200 -160 200 -160 400 60' },
			{
				type: 'stroke',
				color: WHITE,
				width: 36,
				lineCap: 'round',
				taper: { units: 'percent', startLength: 40, endLength: 40, startWidth: 0, endWidth: 0, startEase: 50, endEase: 50 },
			},
			{ type: 'trim', end: keys([[0, 0], [0.8, 100]]) },
		],
	},
];

export function getShapePreset(id: string): ShapePreset | undefined {
	return SHAPE_PRESETS.find((p) => p.id === id);
}
