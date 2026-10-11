// Text animator presets: a library of ready-made animators covering After Effects'
// common text presets (Animate In / Animate Out / Multi-Line / Blurs / Tracking / Mechanical / 3D Text families)
// and the re-expression of the shipped In/Out presets (`TEXT_ANIMATION_SPECS`) as animators. The definitions are
// original (MIT; EffectCraft's eight `text_animators.json` presets are included in spirit: typewriter, fade up
// characters, bounce in words, tracking in, scramble, blur in, jitter, drop in lines).
//
// A preset is data: animators with property values, keyed properties, selectors with fields and keyed fields. Key
// times are seconds from the preset's start at its nominal `duration`; applying scales them to the requested
// length. Every In preset has a mirrored Out twin (`<id>-out`): the keys play backwards from the clip's end, so the
// last unit in is the first out, like the In/Out presets. Loop presets repeat over the whole clip.
import { EASE_PRESETS } from '../keyframes.ts';
import type { Animatable, Ease, Interpolation, Keyframe } from '../schema/common.ts';
import type {
	TextAnimatorGroup,
	TextAnimatorProperties,
	TextSelector,
	TextSelectorBasedOn,
} from '../schema/text-animators.ts';
import { defaultAnimatorPropertyValue, newRangeSelector, newWigglySelector } from './catalog.ts';

type Value = number | number[] | string | boolean;
/** A key: [seconds, value] (eased with the preset's ease), or [seconds, value, 'linear' | 'ease' | 'hold']. */
type KeyDef = [number, Value] | [number, Value, 'linear' | 'ease' | 'hold'];

type SelectorDef = {
	kind: 'range' | 'wiggly';
	set?: Record<string, Value>;
	keys?: Record<string, KeyDef[]>;
	/** Easy ease on this selector's keys (default linear). */
	ease?: boolean;
};

type AnimatorDef = {
	name: string;
	/** Property values (keys of `TextAnimatorProperties`; `axes.<tag>` for variable font axes). */
	properties: Record<string, Value>;
	keys?: Record<string, KeyDef[]>;
	ease?: boolean;
	selectors: SelectorDef[];
};

export type TextAnimatorPresetPhase = 'in' | 'out' | 'loop';

export type TextAnimatorPreset = {
	id: string;
	name: string;
	/** AE-style family, e.g. `Animate In`, `Blurs`, `Mechanical`. */
	category: string;
	phase: TextAnimatorPresetPhase;
	description: string;
	/** Nominal length in seconds (key times are authored at it; loops: one cycle). */
	duration: number;
	/** Needs per-character 3D (enabled on the clip when applied). */
	perCharacter3d?: boolean;
	/** The shipped In/Out preset this re-expresses (`TEXT_ANIMATION_SPECS` id), if any. */
	legacy?: string;
	animators: AnimatorDef[];
};

const sweep = (from: number, to: number, d: number): KeyDef[] => [
	[0, from],
	[d, to],
];

const UNIT_BASED_ON: Record<string, TextSelectorBasedOn> = {
	char: 'characters',
	word: 'words',
	line: 'lines',
};

/** A cascade: a Ramp Up range whose Offset sweeps across the text (units animate one after another). */
const cascade = (
	basedOn: TextSelectorBasedOn,
	d: number,
	extra: Record<string, Value> = {},
	ease = true,
): SelectorDef => ({
	kind: 'range',
	set: { basedOn, shape: 'rampUp', ...extra },
	keys: { offset: sweep(-100, 100, d) },
	ease,
});

const IN_PRESETS: TextAnimatorPreset[] = [
	// ---- the shipped In/Out presets re-expressed (defaults of their params)
	{
		id: 'fade-in',
		name: 'Fade In',
		category: 'Animate In',
		phase: 'in',
		legacy: 'fade',
		description: 'The whole text fades in (re-expresses the Fade preset).',
		duration: 0.5,
		animators: [
			{
				name: 'Fade',
				properties: { opacity: 0 },
				selectors: [
					{ kind: 'range', set: { basedOn: 'words' }, keys: { amount: sweep(100, 0, 0.5) }, ease: true },
				],
			},
		],
	},
	...(
		[
			['slide-up-in', 'Slide Up', 'slide-up', [0, 60]],
			['slide-down-in', 'Slide Down', 'slide-down', [0, -60]],
			['slide-left-in', 'Slide Left', 'slide-left', [60, 0]],
			['slide-right-in', 'Slide Right', 'slide-right', [-60, 0]],
		] as const
	).map(
		([id, name, legacy, pos]): TextAnimatorPreset => ({
			id,
			name,
			category: 'Animate In',
			phase: 'in',
			legacy,
			description: `Words slide ${name.split(' ')[1]!.toLowerCase()} into place while fading in (re-expresses ${name}).`,
			duration: 0.7,
			animators: [
				{
					name,
					properties: { position: [...pos], opacity: 0 },
					selectors: [cascade('words', 0.7, { easeHigh: 70, end: 60 })],
				},
			],
		}),
	),
	{
		id: 'pop-in',
		name: 'Pop',
		category: 'Animate In',
		phase: 'in',
		legacy: 'pop',
		description: 'Characters scale up from nothing with an overshoot (re-expresses Pop).',
		duration: 0.8,
		animators: [
			{
				name: 'Pop Scale',
				properties: { scale: [0, 0], opacity: 0 },
				selectors: [cascade('characters', 0.7, { end: 40 }, false)],
			},
			{
				name: 'Pop Overshoot',
				properties: { scale: [125, 125] },
				selectors: [
					{
						kind: 'range',
						set: { basedOn: 'characters', shape: 'triangle', end: 30 },
						keys: {
							offset: [
								[0.1, -30],
								[0.8, 100],
							],
						},
					},
				],
			},
		],
	},
	{
		id: 'blur-in',
		name: 'Blur In',
		category: 'Blurs',
		phase: 'in',
		legacy: 'blur',
		description: 'Characters come into focus and fade in, left to right (re-expresses Blur).',
		duration: 1.4,
		animators: [
			{
				name: 'Blur In',
				properties: { blur: [32, 32], opacity: 0, scale: [140, 140] },
				selectors: [cascade('characters', 1.4, { easeLow: 60 })],
			},
		],
	},
	{
		id: 'typewriter',
		name: 'Typewriter',
		category: 'Animate In',
		phase: 'in',
		legacy: 'typewriter',
		description: 'Characters appear one at a time, hard-edged (re-expresses Typewriter, without the caret).',
		duration: 2,
		animators: [
			{
				name: 'Typewriter',
				properties: { opacity: 0 },
				selectors: [
					{
						kind: 'range',
						set: { smoothness: 0 },
						keys: {
							start: [
								[0, 0, 'linear'],
								[2, 100, 'linear'],
							],
						},
					},
				],
			},
		],
	},
	{
		id: 'tracking-in',
		name: 'Tracking In',
		category: 'Tracking',
		phase: 'in',
		legacy: 'tracking',
		description: 'Widely spaced text tightens up while fading in (re-expresses Tracking).',
		duration: 1.6,
		animators: [
			{
				name: 'Tracking In',
				properties: { trackingType: 'beforeAndAfter', tracking: 0, opacity: 100 },
				keys: {
					tracking: [
						[0, 500],
						[1.6, 0],
					],
					opacity: [
						[0, 0],
						[0.8, 100],
					],
				},
				ease: true,
				selectors: [],
			},
		],
	},
	{
		id: 'rise-lines-in',
		name: 'Rise Lines',
		category: 'Multi-Line',
		phase: 'in',
		legacy: 'mask-reveal',
		description:
			'Lines rise into place one after another while fading in (re-expresses Mask Reveal; animators do not clip, so the lines fade instead of hiding behind a mask).',
		duration: 0.8,
		animators: [
			{
				name: 'Rise',
				properties: { position: [0, 80], opacity: 0 },
				selectors: [cascade('lines', 0.8, { easeHigh: 80, end: 60 })],
			},
		],
	},
	{
		id: 'rotate-in',
		name: 'Rotate In',
		category: 'Animate In',
		phase: 'in',
		legacy: 'rotate-in',
		description: 'Characters turn into place around their centre while fading in (re-expresses Rotate In).',
		duration: 0.8,
		animators: [
			{
				name: 'Rotate In',
				properties: { rotation: 90, opacity: 0 },
				selectors: [cascade('characters', 0.8, { easeHigh: 60, end: 50 })],
			},
		],
	},
	{
		id: 'drop-in',
		name: 'Drop',
		category: 'Animate In',
		phase: 'in',
		legacy: 'drop',
		description: 'Characters fall from above and bounce into place (re-expresses Drop).',
		duration: 1,
		animators: [
			{
				name: 'Drop',
				properties: { position: [0, -120], opacity: 0 },
				selectors: [cascade('characters', 0.9, { end: 40 }, false)],
			},
			{
				name: 'Bounce',
				properties: { position: [0, 14] },
				selectors: [
					{
						kind: 'range',
						set: { basedOn: 'characters', shape: 'triangle', end: 25 },
						keys: {
							offset: [
								[0.15, -25],
								[1, 100],
							],
						},
					},
				],
			},
		],
	},
	// ---- AE-style library
	{
		id: 'fade-up-characters',
		name: 'Fade Up Characters',
		category: 'Animate In',
		phase: 'in',
		description: 'Characters fade in while rising into place, left to right.',
		duration: 1.5,
		animators: [
			{
				name: 'Fade Up',
				properties: { opacity: 0, position: [0, 40] },
				selectors: [cascade('characters', 1.5, { easeHigh: 50, easeLow: 50 })],
			},
		],
	},
	{
		id: 'fade-in-by-character',
		name: 'Fade In by Character',
		category: 'Animate In',
		phase: 'in',
		description: 'Characters fade in one after another with a soft edge.',
		duration: 1.5,
		animators: [
			{
				name: 'Fade In',
				properties: { opacity: 0 },
				selectors: [
					{
						kind: 'range',
						keys: {
							start: [
								[0, 0, 'linear'],
								[1.5, 100, 'linear'],
							],
						},
					},
				],
			},
		],
	},
	{
		id: 'fade-in-by-word',
		name: 'Fade In by Word',
		category: 'Animate In',
		phase: 'in',
		description: 'Words fade in one after another.',
		duration: 1.5,
		animators: [
			{
				name: 'Fade In',
				properties: { opacity: 0 },
				selectors: [
					{
						kind: 'range',
						set: { basedOn: 'words' },
						keys: {
							start: [
								[0, 0, 'linear'],
								[1.5, 100, 'linear'],
							],
						},
					},
				],
			},
		],
	},
	{
		id: 'random-fade-in',
		name: 'Random Fade In',
		category: 'Animate In',
		phase: 'in',
		description: 'Characters fade in in a random order.',
		duration: 1.5,
		animators: [
			{
				name: 'Random Fade',
				properties: { opacity: 0 },
				selectors: [
					{
						kind: 'range',
						set: { randomize: true, smoothness: 100 },
						keys: {
							start: [
								[0, 0, 'linear'],
								[1.5, 100, 'linear'],
							],
						},
					},
				],
			},
		],
	},
	{
		id: 'bounce-in-words',
		name: 'Bounce In Words',
		category: 'Animate In',
		phase: 'in',
		description: 'Words scale up from nothing with an overshoot, one after another.',
		duration: 1.5,
		animators: [
			{
				name: 'Bounce Scale',
				properties: { scale: [0, 0], opacity: 0 },
				selectors: [cascade('words', 1.2, {}, false)],
			},
			{
				name: 'Bounce Overshoot',
				properties: { scale: [130, 130] },
				selectors: [
					{
						kind: 'range',
						set: { basedOn: 'words', shape: 'triangle', end: 35 },
						keys: {
							offset: [
								[0.15, -35],
								[1.5, 100],
							],
						},
					},
				],
			},
		],
	},
	{
		id: 'slide-in-characters',
		name: 'Slide In Characters',
		category: 'Animate In',
		phase: 'in',
		description: 'Characters slide in from the right and settle, left to right.',
		duration: 1.2,
		animators: [
			{
				name: 'Slide In',
				properties: { position: [300, 0], opacity: 0 },
				selectors: [cascade('characters', 1.2, { easeHigh: 80 })],
			},
		],
	},
	{
		id: 'scale-down-in',
		name: 'Raining Characters',
		category: 'Animate In',
		phase: 'in',
		description: 'Large characters shrink into place while fading in.',
		duration: 1.2,
		animators: [
			{
				name: 'Scale Down',
				properties: { scale: [400, 400], opacity: 0 },
				selectors: [cascade('characters', 1.2, { easeHigh: 70 })],
			},
		],
	},
	{
		id: 'skew-in',
		name: 'Skew In',
		category: 'Animate In',
		phase: 'in',
		description: 'Characters straighten from a strong slant while sliding in.',
		duration: 1,
		animators: [
			{
				name: 'Skew In',
				properties: { skew: 60, skewAxis: 0, position: [-80, 0], opacity: 0 },
				selectors: [cascade('characters', 1, { easeHigh: 60 })],
			},
		],
	},
	{
		id: 'tracking-out-in',
		name: 'Tracking In Tight',
		category: 'Tracking',
		phase: 'in',
		description: 'Overlapping characters spread to their spacing while fading in.',
		duration: 1.2,
		animators: [
			{
				name: 'Tracking',
				properties: { trackingType: 'beforeAndAfter', tracking: 0, opacity: 100 },
				keys: {
					tracking: [
						[0, -300],
						[1.2, 0],
					],
					opacity: [
						[0, 0],
						[0.6, 100],
					],
				},
				ease: true,
				selectors: [],
			},
		],
	},
	{
		id: 'blur-in-words',
		name: 'Blur By Word',
		category: 'Blurs',
		phase: 'in',
		description: 'Words sharpen from a horizontal blur one after another.',
		duration: 1.2,
		animators: [
			{
				name: 'Blur By Word',
				properties: { blur: [60, 0], opacity: 0 },
				selectors: [cascade('words', 1.2, { easeLow: 50 })],
			},
		],
	},
	{
		id: 'scramble',
		name: 'Scramble',
		category: 'Mechanical',
		phase: 'in',
		description: 'Letters cycle through random characters before settling, left to right.',
		duration: 2,
		animators: [
			{
				name: 'Scramble',
				properties: { characterOffset: 12 },
				selectors: [
					{
						kind: 'range',
						set: { randomize: true, smoothness: 0 },
						keys: {
							start: [
								[0, 0, 'linear'],
								[2, 100, 'linear'],
							],
						},
					},
					{ kind: 'wiggly', set: { wigglesPerSecond: 8, correlation: 0 } },
				],
			},
		],
	},
	{
		id: 'decoder',
		name: 'Decoder Fade In',
		category: 'Mechanical',
		phase: 'in',
		description: 'Characters appear as flickering random glyphs that decode to the text, left to right.',
		duration: 2,
		animators: [
			{
				name: 'Decode',
				properties: { characterOffset: 20 },
				selectors: [
					{
						kind: 'range',
						set: { smoothness: 0 },
						keys: {
							start: [
								[0, 0, 'linear'],
								[2, 100, 'linear'],
							],
						},
					},
					{ kind: 'wiggly', set: { wigglesPerSecond: 12, correlation: 0 } },
				],
			},
			{
				name: 'Reveal',
				properties: { opacity: 0 },
				selectors: [
					{
						kind: 'range',
						set: { smoothness: 0 },
						keys: {
							start: [
								[0, 0, 'linear'],
								[1.4, 100, 'linear'],
							],
						},
					},
				],
			},
		],
	},
	{
		id: 'drop-in-lines',
		name: 'Drop In Lines',
		category: 'Multi-Line',
		phase: 'in',
		description: 'Lines drop from above with a slight rotation, one after another.',
		duration: 1.4,
		animators: [
			{
				name: 'Drop In',
				properties: { position: [0, -120], rotation: -8, opacity: 0 },
				selectors: [cascade('lines', 1.4, { easeHigh: 80 })],
			},
		],
	},
	{
		id: 'flip-in-3d',
		name: '3D Flip In',
		category: '3D Text',
		phase: 'in',
		perCharacter3d: true,
		description: 'Characters flip in around their vertical axis (per-character 3D).',
		duration: 1.2,
		animators: [
			{
				name: '3D Flip',
				properties: { rotationY: 90, opacity: 0 },
				selectors: [cascade('characters', 1.2, { easeHigh: 60 })],
			},
		],
	},
	{
		id: 'fly-in-3d',
		name: '3D Fly In',
		category: '3D Text',
		phase: 'in',
		perCharacter3d: true,
		description: 'Characters fly in from behind the viewer and tilt into place (per-character 3D).',
		duration: 1.4,
		animators: [
			{
				name: '3D Fly In',
				properties: { positionZ: -900, rotationX: -70, opacity: 0 },
				selectors: [cascade('characters', 1.4, { easeHigh: 70 })],
			},
		],
	},
];

const LOOP_PRESETS: TextAnimatorPreset[] = [
	{
		id: 'wave',
		name: 'Wave',
		category: 'Animate In',
		phase: 'loop',
		description: 'A wave travels through the characters, lifting them as it passes (repeats over the clip).',
		duration: 1.5,
		animators: [
			{
				name: 'Wave',
				properties: { position: [0, -30] },
				selectors: [
					{
						kind: 'range',
						set: { shape: 'smooth', end: 40 },
						keys: {
							offset: [
								[0, -40],
								[1.5, 100],
							],
						},
					},
				],
			},
		],
	},
	{
		id: 'jitter',
		name: 'Jitter',
		category: 'Mechanical',
		phase: 'loop',
		description: 'Characters wobble randomly in position and rotation, continuously.',
		duration: 1,
		animators: [
			{
				name: 'Jitter',
				properties: { position: [0, 18], rotation: 12 },
				selectors: [{ kind: 'range' }, { kind: 'wiggly', set: { wigglesPerSecond: 3, correlation: 20 } }],
			},
		],
	},
	{
		id: 'hue-sweep',
		name: 'Hue Sweep',
		category: 'Fill and Stroke',
		phase: 'loop',
		description: 'A band of shifted hue sweeps through the characters (repeats over the clip).',
		duration: 2,
		animators: [
			{
				name: 'Hue Sweep',
				properties: { fillHue: 180, fillSaturation: 60 },
				selectors: [
					{
						kind: 'range',
						set: { shape: 'triangle', end: 50 },
						keys: {
							offset: [
								[0, -50],
								[2, 100],
							],
						},
					},
				],
			},
		],
	},
	{
		id: 'pulse-words',
		name: 'Pulse Words',
		category: 'Animate In',
		phase: 'loop',
		description: 'Words swell one after another (repeats over the clip).',
		duration: 2,
		animators: [
			{
				name: 'Pulse',
				properties: { scale: [130, 130] },
				selectors: [
					{
						kind: 'range',
						set: { basedOn: 'words', shape: 'smooth', end: 30 },
						keys: {
							offset: [
								[0, -30],
								[2, 100],
							],
						},
					},
				],
			},
		],
	},
];

/** Every key time `t` of a preset becomes `duration − t` (values unchanged), playing it backwards. */
function mirrorKeys(keys: KeyDef[], d: number): KeyDef[] {
	return [...keys].reverse().map((k) => [d - k[0], k[1], ...(k[2] ? [k[2]] : [])] as KeyDef);
}

function mirrorAnimator(a: AnimatorDef, d: number): AnimatorDef {
	const m = (keys?: Record<string, KeyDef[]>) =>
		keys ? Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, mirrorKeys(v, d)])) : undefined;
	return {
		...a,
		...(a.keys ? { keys: m(a.keys) } : {}),
		selectors: a.selectors.map((s) => ({ ...s, ...(s.keys ? { keys: m(s.keys) } : {}) })),
	};
}

const OUT_PRESETS: TextAnimatorPreset[] = IN_PRESETS.map((p) => ({
	...p,
	id: p.id.endsWith('-in') ? `${p.id.slice(0, -3)}-out` : `${p.id}-out`,
	name: `${p.name} (Out)`,
	category: p.category === 'Animate In' ? 'Animate Out' : p.category,
	phase: 'out',
	description: `${p.description.replace(/ \(re-expresses .*\)\.$/, '.')} Played backwards to end the clip.`,
	animators: p.animators.map((a) => mirrorAnimator(a, p.duration)),
}));

/** The whole library: In presets, their Out twins, loops. */
export const TEXT_ANIMATOR_PRESETS: readonly TextAnimatorPreset[] = [
	...IN_PRESETS,
	...OUT_PRESETS,
	...LOOP_PRESETS,
];

export function getTextAnimatorPreset(id: string): TextAnimatorPreset | undefined {
	const k = id.trim().toLowerCase();
	return TEXT_ANIMATOR_PRESETS.find((p) => p.id === k || p.name.toLowerCase() === k);
}

export type PresetBuildContext = {
	newId: (prefix: string) => string;
	/** Content time (flicks) of the preset's start. */
	start: number;
	/** Flicks per preset second (scales the preset to the requested length: `FLICKS_PER_SECOND · length / duration`). */
	flicksPerSecond: number;
	/** Snap a content time to the clip's frame grid. */
	snap: (t: number) => number;
	/** Loop presets: repeat cycles until this content time. */
	loopUntil?: number;
	/** Per-character 3D is on (Z components / X-Y rotation get their companions). */
	threeD: boolean;
};

const EASY: Ease = EASE_PRESETS.easy;
const LINEAR: Ease = EASE_PRESETS.linear;

function toKeyframe(
	id: string,
	time: number,
	value: unknown,
	how: 'linear' | 'ease' | 'hold',
): Keyframe<unknown> {
	const eased = how === 'ease';
	const interpolation: Interpolation = how === 'hold' ? 'hold' : eased ? 'bezier' : 'linear';
	return { id, time, value, interpolation, easeIn: eased ? EASY : LINEAR, easeOut: eased ? EASY : LINEAR };
}

const isNumArray = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => typeof x === 'number');

/** Coerces a preset value to the stored shape of `like` (numbers ↔ vec2 / colour arrays). */
function shaped(v: Value, like: unknown): unknown {
	if (typeof like === 'number') return typeof v === 'number' ? v : isNumArray(v) ? v[0] : like;
	if (isNumArray(like)) {
		if (isNumArray(v)) return like.map((d, i) => v[i] ?? d);
		if (typeof v === 'number') return like.map(() => v);
	}
	return v;
}

/** Keyframes of a field over the preset's timeline (loops repeat cycles until `loopUntil`). */
function keysOf(
	defs: KeyDef[],
	like: unknown,
	ease: boolean,
	ctx: PresetBuildContext,
	cycle: number | null,
): Keyframe<unknown>[] {
	const out: Keyframe<unknown>[] = [];
	const sorted = [...defs].sort((a, b) => a[0] - b[0]);
	const cycles =
		cycle && ctx.loopUntil !== undefined
			? Math.max(1, Math.ceil(Math.abs((ctx.loopUntil - ctx.start) / (cycle * ctx.flicksPerSecond))))
			: 1;
	for (let c = 0; c < cycles; c++) {
		sorted.forEach((k, i) => {
			const last = i === sorted.length - 1;
			// A loop's last key holds until the next cycle's first key (the wrap is invisible: both ends select nothing).
			const how = k[2] ?? (cycles > 1 && last ? 'hold' : ease ? 'ease' : 'linear');
			const time = ctx.snap(ctx.start + (c * (cycle ?? 0) + k[0]) * ctx.flicksPerSecond);
			out.push(toKeyframe(ctx.newId('kf'), time, shaped(k[1], like), how));
		});
	}
	return normalizeKeys(out);
}

/** Keys sorted by time; keys that snapped onto the same frame keep the later one. */
export function normalizeKeys<T>(keys: Keyframe<T>[]): Keyframe<T>[] {
	const sorted = [...keys].sort((a, b) => a.time - b.time);
	return sorted.filter((k, i) => i === sorted.length - 1 || sorted[i + 1]!.time !== k.time);
}

function setField(target: Record<string, unknown>, field: string, v: Value): void {
	const cur = target[field];
	if (cur && typeof cur === 'object' && 'keyframes' in (cur as object)) {
		const a = cur as Animatable<unknown>;
		a.value = shaped(v, a.value);
	} else target[field] = v;
}

/** Builds the animators of a preset (new ids), keys placed by `ctx`. */
export function buildPresetAnimators(
	preset: TextAnimatorPreset,
	ctx: PresetBuildContext,
): TextAnimatorGroup[] {
	const cycle = preset.phase === 'loop' ? preset.duration : null;
	return preset.animators.map((a) => {
		const properties: Record<string, unknown> = {};
		for (const [key, v] of Object.entries(a.properties)) {
			if (key.startsWith('axes.')) {
				const tag = key.slice(5);
				const axes = (properties.axes ??= {}) as Record<string, Animatable<number>>;
				axes[tag] = { value: Number(v), keyframes: [] };
				continue;
			}
			properties[key] = defaultAnimatorPropertyValue(key as never);
			setField(properties, key, v);
			// AE companions of a property the preset sets.
			if (key === 'skew' && properties.skewAxis === undefined)
				properties.skewAxis = defaultAnimatorPropertyValue('skewAxis');
			if (key === 'tracking' && properties.trackingType === undefined)
				properties.trackingType = 'beforeAndAfter';
			if ((key === 'characterOffset' || key === 'characterValue') && properties.characterRange === undefined)
				properties.characterRange = 'preserveCaseAndDigits';
			if (key === 'characterOffset' && properties.characterAlignment === undefined)
				properties.characterAlignment = 'center';
		}
		for (const [key, defs] of Object.entries(a.keys ?? {})) {
			const p = properties[key] as Animatable<unknown> | undefined;
			if (!p) continue;
			p.keyframes = keysOf(defs, p.value, !!a.ease, ctx, cycle);
			p.value = p.keyframes[0]?.value ?? p.value;
		}
		let ranges = 0;
		let wigglies = 0;
		const selectors: TextSelector[] = a.selectors.map((s) => {
			const sel =
				s.kind === 'wiggly'
					? newWigglySelector(ctx.newId('sel'), `Wiggly Selector ${++wigglies}`)
					: newRangeSelector(ctx.newId('sel'), `Range Selector ${++ranges}`);
			const rec = sel as unknown as Record<string, unknown>;
			for (const [field, v] of Object.entries(s.set ?? {})) setField(rec, field, v);
			for (const [field, defs] of Object.entries(s.keys ?? {})) {
				const p = rec[field] as Animatable<unknown> | undefined;
				if (!p || typeof p !== 'object' || !('keyframes' in p)) continue;
				p.keyframes = keysOf(defs, p.value, !!s.ease, ctx, cycle);
				p.value = p.keyframes[0]?.value ?? p.value;
			}
			return sel;
		});
		return {
			id: ctx.newId('tan'),
			name: a.name,
			enabled: true,
			properties: properties as TextAnimatorProperties,
			selectors,
		};
	});
}

/** The animator preset that re-expresses a shipped In/Out preset (`TEXT_ANIMATION_SPECS` id) on a side. */
export function presetForLegacy(legacyId: string, side: 'in' | 'out'): TextAnimatorPreset | undefined {
	const inPreset = IN_PRESETS.find((p) => p.legacy === legacyId);
	if (!inPreset) return undefined;
	return side === 'in' ? inPreset : OUT_PRESETS[IN_PRESETS.indexOf(inPreset)];
}

/**
 * The legacy preset's `unit` param as a Based On, applied to every selector of a re-expressed preset (its other
 * params keep the preset's own look; see the wp-note for what each conversion keeps).
 */
export function legacyBasedOn(params: Record<string, unknown>): TextSelectorBasedOn | undefined {
	const u = params.unit;
	return typeof u === 'string' ? UNIT_BASED_ON[u] : undefined;
}
