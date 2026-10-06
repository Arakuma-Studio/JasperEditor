// Built-in effect presets (S05:EFX-001 Effects ▸ Presets, like Premiere's Blurs / PiPs / Slides): read-only,
// shipped with the app, built only from effects and intrinsic properties that exist today. Authored on a
// 1920×1080, 30 fps, 5 s source; the Motion ones are `relative` so they fit any frame size and media size.
import { FLICKS_PER_SECOND, flicksPerFrame } from '../time.ts';
import {
	EFFECT_PRESET_FORMAT,
	EFFECT_PRESET_VERSION,
	type EffectPreset,
	type EffectPresetType,
	type PresetAnim,
	type PresetEffect,
	type PresetIntrinsic,
	type PresetKeyframe,
} from './schema.ts';

const RATE = { num: 30, den: 1 };
const DURATION = 150;
const W = 1920;
const H = 1080;
const SEC = FLICKS_PER_SECOND;
/** Offset of the source's last frame (Anchor to Out Point presets count back from it). */
const LAST = (DURATION - 1) * flicksPerFrame(RATE);

const EASE_LINEAR = { influence: 1 / 3, slope: 1 };
const EASE_STOP = { influence: 1 / 3, slope: 0 };

/** Two keys: `from` at `t0` and `to` at `t1`; `ease` decelerates into / accelerates out of the move. */
function ramp<T>(
	t0: number,
	from: T,
	t1: number,
	to: T,
	ease: 'none' | 'out' | 'in' = 'none',
): PresetAnim<T> {
	const k0: PresetKeyframe<T> = {
		time: t0,
		value: from,
		interpolation: ease === 'none' ? 'linear' : 'bezier',
	};
	const k1: PresetKeyframe<T> = { time: t1, value: to, interpolation: 'linear' };
	if (ease === 'out') {
		k0.easeOut = EASE_LINEAR;
		k1.easeIn = EASE_STOP;
	} else if (ease === 'in') {
		k0.easeOut = EASE_STOP;
		k1.easeIn = EASE_LINEAR;
	}
	return { value: from, keyframes: [k0, k1] };
}

function preset(
	id: string,
	category: string,
	name: string,
	type: EffectPresetType,
	description: string,
	content: { intrinsic?: PresetIntrinsic; effects?: PresetEffect[]; relative?: boolean },
): EffectPreset {
	return {
		format: EFFECT_PRESET_FORMAT,
		version: EFFECT_PRESET_VERSION,
		id: `builtin.${id}`,
		name,
		description,
		type,
		builtIn: true,
		category,
		...(content.relative ? { spatial: 'relative' as const } : {}),
		source: {
			clipKind: 'video',
			duration: DURATION,
			frameRate: RATE,
			frame: { width: W, height: H },
			box: { width: W, height: H },
		},
		...(content.intrinsic ? { intrinsic: content.intrinsic } : {}),
		...(content.effects ? { effects: content.effects } : {}),
	};
}

const blur = (radius: PresetAnim<number>): PresetEffect => ({
	effectId: 'jasper.gaussian-blur',
	effectVersion: 1,
	enabled: true,
	params: { radius, dimensions: { value: 'both' }, repeatEdge: { value: true } },
});

/** Premiere-style corner PiPs: 25 % of "fit to frame", 5 % margins. */
function pip(id: string, name: string, x: 'left' | 'right', y: 'top' | 'bottom'): EffectPreset {
	const w = W * 0.25;
	const h = H * 0.25;
	const px = x === 'left' ? W * 0.05 + w / 2 : W - W * 0.05 - w / 2;
	const py = y === 'top' ? H * 0.05 + h / 2 : H - H * 0.05 - h / 2;
	return preset(
		`pip-25-${id}`,
		'Picture-in-Picture',
		name,
		'anchor-in',
		`Scales the clip to a quarter of the frame and places it in the ${y === 'top' ? 'upper' : 'lower'} ${x} corner.`,
		{
			relative: true,
			intrinsic: {
				motion: { position: { value: [px, py] }, scale: { value: 25 }, scaleWidth: { value: 25 } },
			},
		},
	);
}

export const BUILTIN_EFFECT_PRESETS: readonly EffectPreset[] = [
	preset(
		'blur-in',
		'Blurs',
		'Blur In (1 s)',
		'anchor-in',
		'Starts heavily blurred and sharpens over the first second (Gaussian Blur).',
		{ effects: [blur(ramp(0, 60, SEC, 0, 'out'))] },
	),
	preset(
		'blur-out',
		'Blurs',
		'Blur Out (1 s)',
		'anchor-out',
		'Blurs over the last second until the Out point (Gaussian Blur).',
		{ effects: [blur(ramp(LAST - SEC, 0, LAST, 60, 'in'))] },
	),
	preset(
		'fade-in',
		'Fades',
		'Fade In (1 s)',
		'anchor-in',
		'Fades the clip in from transparent over the first second.',
		{
			intrinsic: { opacity: ramp(0, 0, SEC, 100) },
		},
	),
	preset(
		'fade-out',
		'Fades',
		'Fade Out (1 s)',
		'anchor-out',
		'Fades the clip out to transparent over the last second.',
		{ intrinsic: { opacity: ramp(LAST - SEC, 100, LAST, 0) } },
	),
	preset(
		'slide-in-left',
		'Slides',
		'Slide In from Left',
		'anchor-in',
		'Moves in from beyond the left edge to the centre over the first second, easing into place.',
		{
			relative: true,
			intrinsic: {
				motion: { position: ramp<[number, number]>(0, [-W / 2, H / 2], SEC, [W / 2, H / 2], 'out') },
			},
		},
	),
	preset(
		'slide-in-right',
		'Slides',
		'Slide In from Right',
		'anchor-in',
		'Moves in from beyond the right edge to the centre over the first second, easing into place.',
		{
			relative: true,
			intrinsic: {
				motion: { position: ramp<[number, number]>(0, [W * 1.5, H / 2], SEC, [W / 2, H / 2], 'out') },
			},
		},
	),
	preset(
		'slide-out-left',
		'Slides',
		'Slide Out to Left',
		'anchor-out',
		'Moves from the centre out beyond the left edge over the last second, accelerating.',
		{
			relative: true,
			intrinsic: {
				motion: { position: ramp<[number, number]>(LAST - SEC, [W / 2, H / 2], LAST, [-W / 2, H / 2], 'in') },
			},
		},
	),
	preset(
		'slide-out-right',
		'Slides',
		'Slide Out to Right',
		'anchor-out',
		'Moves from the centre out beyond the right edge over the last second, accelerating.',
		{
			relative: true,
			intrinsic: {
				motion: {
					position: ramp<[number, number]>(LAST - SEC, [W / 2, H / 2], LAST, [W * 1.5, H / 2], 'in'),
				},
			},
		},
	),
	preset(
		'zoom-in',
		'Zooms',
		'Slow Zoom In',
		'scale',
		'Pushes in from 100 % to 120 % over the whole clip (Ken Burns).',
		{
			relative: true,
			intrinsic: {
				motion: { scale: ramp(0, 100, LAST, 120), scaleWidth: ramp(0, 100, LAST, 120), uniformScale: true },
			},
		},
	),
	preset(
		'zoom-out',
		'Zooms',
		'Slow Zoom Out',
		'scale',
		'Pulls out from 120 % to 100 % over the whole clip (Ken Burns).',
		{
			relative: true,
			intrinsic: {
				motion: { scale: ramp(0, 120, LAST, 100), scaleWidth: ramp(0, 120, LAST, 100), uniformScale: true },
			},
		},
	),
	pip('ul', 'PiP 25% Upper Left', 'left', 'top'),
	pip('ur', 'PiP 25% Upper Right', 'right', 'top'),
	pip('ll', 'PiP 25% Lower Left', 'left', 'bottom'),
	pip('lr', 'PiP 25% Lower Right', 'right', 'bottom'),
];

export function builtinEffectPreset(id: string): EffectPreset | undefined {
	return BUILTIN_EFFECT_PRESETS.find((p) => p.id === id);
}
