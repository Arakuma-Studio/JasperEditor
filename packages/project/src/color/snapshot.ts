// Colour management in render snapshots: every renderer (Program monitor, Remotion export,
// native export, layer bakes) sees a source's colour conversion as the first colour effect of its layer — the
// internal `jasper.color-input` effect — so it fuses with the layer's colour runs into the one baked LUT (ARCHITECTURE
// D-21) on every path. Graphics (text, shapes, solids, motion graphics, the sequence background) are SDR content
// with BT.709 primaries in the working space's SDR encoding; they are converted only when the working space has other
// primaries or is HDR (SDR white → HDR Graphics White). Nothing is added in a plain Rec. 709 sequence.
import type { RGBA } from '../schema/common.ts';
import type { MediaAsset } from '../schema/media.ts';
import type { EffectInstance } from '../schema/sequence.ts';
import { colorSpace } from './cms/spaces.ts';
import { inputTransformFn, isIdentityInput } from './cms/transform.ts';
import type { Rgb } from './lut.ts';
import {
	type ColorInterpretation,
	effectiveColorInterpretation,
	resolveInputSpace,
	type SequenceColorInfo,
} from './model.ts';

export const COLOR_INPUT_ID = 'jasper.color-input';

const stat = (value: unknown) => ({ value, keyframes: [] });

function inputEffect(id: string, p: Record<string, unknown>): EffectInstance {
	const params: EffectInstance['params'] = {};
	for (const [k, v] of Object.entries(p)) params[k] = stat(v) as never;
	return { id, effectId: COLOR_INPUT_ID, effectVersion: 1, enabled: true, params };
}

/** The graphics space of a working space: its SDR encoding with BT.709 primaries. */
export function graphicsSpaceOf(info: SequenceColorInfo): string {
	return colorSpace(info.space)?.curve === 'srgb' ? 'srgb' : 'rec709';
}

/** The input effect of a graphics layer, or null when graphics need no conversion in this working space. */
export function graphicsColorEffect(clipId: string, info: SequenceColorInfo): EffectInstance | null {
	const space = graphicsSpaceOf(info);
	if (isIdentityInput({ space }, info)) return null;
	return inputEffect(`cin_${clipId}`, { space, range: 'pc', toneMap: 'auto', peakNits: 0 });
}

/**
 * The input effect of a media clip under its (media + clip) interpretation, or null for the identity. `nestedSpace`:
 * a nest clip shows its nested sequence's working space.
 */
export function sourceColorEffect(
	clipId: string,
	asset: Pick<MediaAsset, 'kind' | 'probe'> & {
		interpretation?: { color?: ColorInterpretation | null } | null;
	},
	clip: { colorInterpretation?: ColorInterpretation | null },
	info: SequenceColorInfo,
): EffectInstance | null {
	const interp = effectiveColorInterpretation(asset, clip);
	const r = resolveInputSpace(asset, interp, info.space);
	const base = {
		range: r.range,
		toneMap: r.toneMap === undefined ? 'auto' : r.toneMap ? 'on' : 'off',
		peakNits: r.peakNits ?? 0,
		inputLut: { mediaId: r.inputLut ?? '' },
	};
	if (r.ocio)
		return inputEffect(`cin_${clipId}`, {
			...base,
			space: 'aces2065',
			ocioConfig: { mediaId: r.ocio.configId },
			ocioSpace: r.ocio.space,
		});
	const space = r.space?.id ?? 'rec709';
	if (!r.inputLut && isIdentityInput({ space }, info)) return null;
	return inputEffect(`cin_${clipId}`, { ...base, space });
}

/** A nest clip whose nested sequence works in another space: nested working signal → this working space. */
export function nestColorEffect(
	clipId: string,
	nestedSpace: string,
	info: SequenceColorInfo,
): EffectInstance | null {
	if (isIdentityInput({ space: nestedSpace }, info)) return null;
	return inputEffect(`cin_${clipId}`, { space: nestedSpace, range: 'pc', toneMap: 'auto', peakNits: 0 });
}

/** A graphics colour (background, generators) converted into the working space (alpha kept). */
export function graphicsColorIn(rgba: RGBA, info: SequenceColorInfo): RGBA {
	const fn = inputTransformFn({ space: graphicsSpaceOf(info) }, info);
	if (!fn) return rgba;
	const c: Rgb = [rgba[0] ?? 0, rgba[1] ?? 0, rgba[2] ?? 0];
	fn(c);
	return [c[0], c[1], c[2], rgba[3] ?? 1];
}

/**
 * Canonical cache key of the settings colour ops depend on (`colorRunKey` extra); '' for the default Rec. 709 settings
 * (the keys of sequences made before colour management stay what they were).
 */
export function workingKey(info: SequenceColorInfo | undefined): string {
	if (!info) return '';
	const k = `${info.space}|${info.autoToneMap ? 1 : 0}|${info.sdrWhiteNits}|${info.hdrPeakNits}`;
	return k === 'rec709|1|203|1000' ? '' : k;
}
