// "Save Preset…" (S03:FX-030, EC-004): builds a preset from effect headers of one clip — the intrinsic sections
// (Motion, Opacity with its blend mode, the pinned Crop, Volume, Panner) and applied effect instances — with every
// key time turned into an offset from the clip's first frame (time.ts). Pure; the editor and the MCP server use it.
import type { ClipTiming } from '../color/retime.ts';
import { CROP_EFFECT } from '../registry/effects.ts';
import { intrinsicBoxOf } from '../registry/properties.ts';
import type { Animatable } from '../schema/common.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, EffectInstance, Sequence, Transform } from '../schema/sequence.ts';
import {
	EFFECT_PRESET_FORMAT,
	EFFECT_PRESET_VERSION,
	type EffectPreset,
	type EffectPresetType,
	MOTION_PROPERTIES,
	type PresetAnim,
	type PresetEffect,
	type PresetIntrinsic,
	type PresetMotion,
} from './schema.ts';
import { presetOffsetOf } from './time.ts';

/** The effect headers chosen in Effect Controls (or by an agent). */
export type PresetSections = {
	motion?: boolean;
	/** Opacity and Blend Mode. */
	opacity?: boolean;
	/** The pinned Crop (the clip's first `jasper.crop`). */
	crop?: boolean;
	volume?: boolean;
	panner?: boolean;
	/** Applied effect instances in the clip's stack (stack order is kept, whatever order they are given in). */
	effectIds?: readonly string[];
};

export class PresetBuildError extends Error {
	constructor(
		readonly code: 'E_NOT_FOUND' | 'E_INVALID_PARAM',
		message: string,
	) {
		super(message);
		this.name = 'PresetBuildError';
	}
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function findClip(doc: ProjectDocument, clipId: string): { seq: Sequence; clip: Clip } {
	for (const seq of Object.values(doc.sequences)) {
		const clip = seq.clips[clipId];
		if (clip) return { seq, clip };
	}
	throw new PresetBuildError('E_NOT_FOUND', `Clip not found: ${clipId}`);
}

function toPresetAnim<T>(a: Animatable<T>, timing: ClipTiming, seq: Sequence): PresetAnim<T> {
	const rate = seq.settings.frameRate;
	return {
		value: clone(a.value),
		...(a.expression ? { expression: { text: a.expression.text, enabled: a.expression.enabled } } : {}),
		...(a.keyframes.length
			? {
					keyframes: a.keyframes.map((k) => ({
						time: presetOffsetOf(k.time, timing, rate),
						value: clone(k.value),
						interpolation: k.interpolation,
						...(k.inInterpolation !== undefined ? { inInterpolation: k.inInterpolation } : {}),
						easeIn: { ...k.easeIn },
						easeOut: { ...k.easeOut },
						// spatial-points: curved paths of point keys travel with the preset.
						...(k.spatial ? { spatial: clone(k.spatial) } : {}),
					})),
				}
			: {}),
	};
}

function paramsOf(fx: EffectInstance, timing: ClipTiming, seq: Sequence): PresetEffect['params'] {
	const out: PresetEffect['params'] = {};
	for (const [name, a] of Object.entries(fx.params)) out[name] = toPresetAnim(a, timing, seq);
	return out;
}

/** Builds a preset (without an id: the library assigns one) from sections of one clip. */
export function buildEffectPreset(
	doc: ProjectDocument,
	clipId: string,
	opts: {
		name: string;
		type: EffectPresetType;
		description?: string;
		sections: PresetSections;
		folderId?: string | null;
		id?: string;
		now?: string;
	},
): EffectPreset {
	const { seq, clip } = findClip(doc, clipId);
	const r = clip as Record<string, unknown>;
	const timing: ClipTiming = {
		start: clip.start,
		duration: clip.duration,
		sourceIn: clip.sourceIn,
		speed: { rate: clip.speed.rate, reverse: clip.speed.reverse },
	};
	const s = opts.sections;
	const intrinsic: PresetIntrinsic = {};
	if (s.motion && r.transform) {
		const t = r.transform as Transform;
		const motion: PresetMotion = { uniformScale: t.uniformScale };
		for (const k of MOTION_PROPERTIES) motion[k] = toPresetAnim(t[k] as Animatable<never>, timing, seq);
		intrinsic.motion = motion;
	}
	if (s.opacity && r.opacity) {
		intrinsic.opacity = toPresetAnim(r.opacity as Animatable<number>, timing, seq);
		if (typeof r.blendMode === 'string') intrinsic.blendMode = r.blendMode as PresetIntrinsic['blendMode'];
	}
	const stack = (r.effects as EffectInstance[] | undefined) ?? [];
	const pinned = stack.find((fx) => fx.effectId === CROP_EFFECT.id) ?? null;
	const wantCrop = s.crop || (!!pinned && !!s.effectIds?.includes(pinned.id));
	if (wantCrop && r.transform) {
		// No crop effect yet = registry defaults (nothing cropped); saved explicitly so applying resets a crop.
		intrinsic.crop = pinned
			? { enabled: pinned.enabled, params: paramsOf(pinned, timing, seq) }
			: {
					enabled: true,
					params: Object.fromEntries(CROP_EFFECT.params.map((p) => [p.name, { value: clone(p.default) }])),
				};
	}
	if (s.volume && r.volumeDb) intrinsic.volume = toPresetAnim(r.volumeDb as Animatable<number>, timing, seq);
	if (s.panner && r.pan) intrinsic.pan = toPresetAnim(r.pan as Animatable<number>, timing, seq);
	const missing = (s.effectIds ?? []).filter((id) => !stack.some((fx) => fx.id === id));
	if (missing.length)
		throw new PresetBuildError('E_NOT_FOUND', `The clip has no effect instance ${missing.join(', ')}`);
	const effects: PresetEffect[] = stack
		.filter((fx) => fx !== pinned && s.effectIds?.includes(fx.id))
		.map((fx) => ({
			id: fx.id,
			effectId: fx.effectId,
			effectVersion: fx.effectVersion,
			enabled: fx.enabled,
			params: paramsOf(fx, timing, seq),
		}));
	if (!Object.keys(intrinsic).length && !effects.length)
		throw new PresetBuildError(
			'E_INVALID_PARAM',
			'Choose at least one effect or intrinsic property (Motion, Opacity, Crop, Volume, Panner) of this clip',
		);
	const box = r.transform ? intrinsicBoxOf({ doc, seq, clip }) : undefined;
	const description = opts.description?.trim();
	return {
		format: EFFECT_PRESET_FORMAT,
		version: EFFECT_PRESET_VERSION,
		id: opts.id ?? 'new',
		name: opts.name.trim(),
		...(description ? { description } : {}),
		type: opts.type,
		...(opts.folderId ? { folderId: opts.folderId } : {}),
		...(opts.now ? { createdAt: opts.now, updatedAt: opts.now } : {}),
		source: {
			clipKind: clip.kind,
			duration: clip.duration,
			frameRate: { ...seq.settings.frameRate },
			frame: { width: seq.settings.width, height: seq.settings.height },
			...(box ? { box: { width: box.width, height: box.height } } : {}),
		},
		...(Object.keys(intrinsic).length ? { intrinsic } : {}),
		...(effects.length ? { effects } : {}),
	};
}
