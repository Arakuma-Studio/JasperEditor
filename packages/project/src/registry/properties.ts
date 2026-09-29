// Property registry (S03 §11 adapted to S01 storage, ARCHITECTURE §2.3/§5.4). Drives Properties /
// Effect Controls rows, agent schemas and range clamping. Keys are dotted and relative to the owner:
// `transform.position`, `opacity`, `volumeDb`, `effects.<fxId>.<param>`, `params.<name>`, `text.sizePx`.
// WP-2D extends this registry.
import { z } from 'zod';
import type { ParamPath } from '../commands/schemas/common.ts';
import { BLEND_MODES, type Clip } from '../schema/sequence.ts';
import { kindCapabilities } from './kinds.ts';
import type { MgTemplateInfo } from './mg.ts';

export type ValueKind = 'number' | 'vec2' | 'color' | 'enum' | 'boolean' | 'string';
export type PropertyGroup = 'motion' | 'opacity' | 'audio' | 'text' | 'solid' | 'params' | 'effect';

export type PropertySpec = {
	key: string;
	label: string;
	group: PropertyGroup;
	kind: ValueKind;
	unit?: 'px' | '%' | 'deg' | 'dB' | 'frames' | 's';
	range?: { min?: number; max?: number; softMin?: number; softMax?: number; step?: number };
	/** `continuous` = interpolated keyframes; `hold-only` = step keyframes (S01:KF-007); `no` = static field. */
	animatable: 'continuous' | 'hold-only' | 'no';
	options?: readonly string[];
	/** Path of the stored value inside the clip (an Animatable when `animatable !== 'no'`). */
	storagePath: readonly string[];
	appliesTo(clip: Pick<Clip, 'kind'>): boolean;
	ui: { control: 'scrub' | 'slider' | 'vec2' | 'angle' | 'color' | 'select' | 'toggle' | 'text'; bipolar?: boolean };
};

const hasTransform = (c: Pick<Clip, 'kind'>) => !!kindCapabilities(c.kind)?.hasTransform;
const hasOpacity = (c: Pick<Clip, 'kind'>) => !!kindCapabilities(c.kind)?.hasOpacity;
const isAudio = (c: Pick<Clip, 'kind'>) => c.kind === 'audio' || c.kind === 'nest-audio';
const isText = (c: Pick<Clip, 'kind'>) => c.kind === 'text';

const spec = (s: PropertySpec) => s;

export const PROPERTY_SPECS: readonly PropertySpec[] = [
	spec({ key: 'transform.position', label: 'Position', group: 'motion', kind: 'vec2', unit: 'px', animatable: 'continuous', storagePath: ['transform', 'position'], appliesTo: hasTransform, ui: { control: 'vec2' } }),
	spec({ key: 'transform.anchor', label: 'Anchor Point', group: 'motion', kind: 'vec2', unit: 'px', animatable: 'continuous', storagePath: ['transform', 'anchor'], appliesTo: hasTransform, ui: { control: 'vec2' } }),
	spec({ key: 'transform.scale', label: 'Scale', group: 'motion', kind: 'number', unit: '%', range: { min: 0, max: 10000, softMax: 400, step: 0.1 }, animatable: 'continuous', storagePath: ['transform', 'scale'], appliesTo: hasTransform, ui: { control: 'scrub' } }),
	spec({ key: 'transform.scaleWidth', label: 'Scale Width', group: 'motion', kind: 'number', unit: '%', range: { min: 0, max: 10000, softMax: 400, step: 0.1 }, animatable: 'continuous', storagePath: ['transform', 'scaleWidth'], appliesTo: hasTransform, ui: { control: 'scrub' } }),
	spec({ key: 'transform.uniformScale', label: 'Uniform Scale', group: 'motion', kind: 'boolean', animatable: 'no', storagePath: ['transform', 'uniformScale'], appliesTo: hasTransform, ui: { control: 'toggle' } }),
	spec({ key: 'transform.rotation', label: 'Rotation', group: 'motion', kind: 'number', unit: 'deg', range: { step: 0.1 }, animatable: 'continuous', storagePath: ['transform', 'rotation'], appliesTo: hasTransform, ui: { control: 'angle' } }),
	spec({ key: 'transform.flipH', label: 'Flip Horizontal', group: 'motion', kind: 'boolean', animatable: 'no', storagePath: ['transform', 'flipH'], appliesTo: hasTransform, ui: { control: 'toggle' } }),
	spec({ key: 'transform.flipV', label: 'Flip Vertical', group: 'motion', kind: 'boolean', animatable: 'no', storagePath: ['transform', 'flipV'], appliesTo: hasTransform, ui: { control: 'toggle' } }),
	spec({ key: 'opacity', label: 'Opacity', group: 'opacity', kind: 'number', unit: '%', range: { min: 0, max: 100, step: 0.1 }, animatable: 'continuous', storagePath: ['opacity'], appliesTo: hasOpacity, ui: { control: 'slider' } }),
	spec({ key: 'blendMode', label: 'Blend Mode', group: 'opacity', kind: 'enum', options: BLEND_MODES, animatable: 'no', storagePath: ['blendMode'], appliesTo: (c) => hasOpacity(c) && c.kind !== 'captions', ui: { control: 'select' } }),
	spec({ key: 'gainDb', label: 'Gain', group: 'audio', kind: 'number', unit: 'dB', range: { min: -96, max: 96, step: 0.1 }, animatable: 'no', storagePath: ['gainDb'], appliesTo: isAudio, ui: { control: 'scrub', bipolar: true } }),
	spec({ key: 'volumeDb', label: 'Level', group: 'audio', kind: 'number', unit: 'dB', range: { min: -96, max: 15, step: 0.1 }, animatable: 'continuous', storagePath: ['volumeDb'], appliesTo: isAudio, ui: { control: 'scrub', bipolar: true } }),
	spec({ key: 'pan', label: 'Pan', group: 'audio', kind: 'number', range: { min: -100, max: 100, step: 1 }, animatable: 'continuous', storagePath: ['pan'], appliesTo: isAudio, ui: { control: 'scrub', bipolar: true } }),
	spec({ key: 'text.content', label: 'Text', group: 'text', kind: 'string', animatable: 'no', storagePath: ['content', 'text'], appliesTo: isText, ui: { control: 'text' } }),
	spec({ key: 'text.fontId', label: 'Font', group: 'text', kind: 'string', animatable: 'no', storagePath: ['content', 'style', 'fontId'], appliesTo: isText, ui: { control: 'select' } }),
	spec({ key: 'text.weight', label: 'Weight', group: 'text', kind: 'number', range: { min: 100, max: 900, step: 100 }, animatable: 'no', storagePath: ['content', 'style', 'weight'], appliesTo: isText, ui: { control: 'select' } }),
	spec({ key: 'text.italic', label: 'Italic', group: 'text', kind: 'boolean', animatable: 'no', storagePath: ['content', 'style', 'italic'], appliesTo: isText, ui: { control: 'toggle' } }),
	spec({ key: 'text.sizePx', label: 'Font Size', group: 'text', kind: 'number', unit: 'px', range: { min: 1, max: 2000, softMax: 400, step: 1 }, animatable: 'no', storagePath: ['content', 'style', 'sizePx'], appliesTo: isText, ui: { control: 'scrub' } }),
	spec({ key: 'text.lineHeight', label: 'Leading', group: 'text', kind: 'number', range: { min: 0.1, max: 10, step: 0.05 }, animatable: 'no', storagePath: ['content', 'style', 'lineHeight'], appliesTo: isText, ui: { control: 'scrub' } }),
	spec({ key: 'text.trackingEm', label: 'Tracking', group: 'text', kind: 'number', range: { min: -1000, max: 1000, step: 1 }, animatable: 'no', storagePath: ['content', 'style', 'trackingEm'], appliesTo: isText, ui: { control: 'scrub' } }),
	spec({ key: 'text.align', label: 'Align', group: 'text', kind: 'enum', options: ['left', 'center', 'right', 'justify'], animatable: 'no', storagePath: ['content', 'style', 'align'], appliesTo: isText, ui: { control: 'select' } }),
	spec({ key: 'text.fill', label: 'Fill', group: 'text', kind: 'color', animatable: 'no', storagePath: ['content', 'style', 'fill'], appliesTo: isText, ui: { control: 'color' } }),
	spec({ key: 'text.allCaps', label: 'All Caps', group: 'text', kind: 'boolean', animatable: 'no', storagePath: ['content', 'style', 'allCaps'], appliesTo: isText, ui: { control: 'toggle' } }),
	spec({ key: 'solid.color', label: 'Color', group: 'solid', kind: 'color', animatable: 'no', storagePath: ['$synthetic', 'color'], appliesTo: (c) => c.kind === 'solid', ui: { control: 'color' } }),
];

const BY_KEY = new Map(PROPERTY_SPECS.map((s) => [s.key, s]));

export function getPropertySpec(key: string): PropertySpec | undefined {
	return BY_KEY.get(key);
}

/** Specs for a motion-graphic clip's `params.<name>` from the template's params schema. */
export function paramsPropertySpecs(template: MgTemplateInfo): PropertySpec[] {
	let json: { properties?: Record<string, Record<string, unknown>> };
	try {
		json = z.toJSONSchema(template.paramsSchema, { unrepresentable: 'any', io: 'input' }) as typeof json;
	} catch {
		return [];
	}
	const out: PropertySpec[] = [];
	for (const [name, s] of Object.entries(json.properties ?? {})) {
		let kind: ValueKind = 'string';
		let options: readonly string[] | undefined;
		if (s.type === 'number' || s.type === 'integer') kind = 'number';
		else if (s.type === 'boolean') kind = 'boolean';
		else if (Array.isArray(s.enum)) {
			kind = 'enum';
			options = s.enum as string[];
		} else if (s.type === 'array' && s.minItems === 4 && s.maxItems === 4) kind = 'color';
		else if (s.type === 'array' && s.minItems === 2 && s.maxItems === 2) kind = 'vec2';
		out.push({
			key: `params.${name}`,
			label: typeof s.title === 'string' ? s.title : name,
			group: 'params',
			kind,
			options,
			range:
				kind === 'number'
					? { min: typeof s.minimum === 'number' ? s.minimum : undefined, max: typeof s.maximum === 'number' ? s.maximum : undefined }
					: undefined,
			animatable: 'no',
			storagePath: ['params', name],
			appliesTo: (c) => c.kind === 'motion-graphic',
			ui: {
				control: kind === 'number' ? 'scrub' : kind === 'boolean' ? 'toggle' : kind === 'enum' ? 'select' : kind === 'color' ? 'color' : kind === 'vec2' ? 'vec2' : 'text',
			},
		});
	}
	return out;
}

/** Registry specs that apply to a clip, plus `params.*` for motion graphics when a template is given. */
export function propertiesForClip(clip: Pick<Clip, 'kind'>, template?: MgTemplateInfo): PropertySpec[] {
	const base = PROPERTY_SPECS.filter((s) => s.appliesTo(clip));
	return template && clip.kind === 'motion-graphic' ? [...base, ...paramsPropertySpecs(template)] : base;
}

/** Resolves a spec for a key, including dynamic `params.<name>` keys. */
export function resolvePropertySpec(key: string, template?: MgTemplateInfo): PropertySpec | undefined {
	if (key.startsWith('params.')) return template ? paramsPropertySpecs(template).find((s) => s.key === key) : undefined;
	return getPropertySpec(key);
}

// ---------------------------------------------------------------- key <-> ParamPath

export type PropertyOwner = { clipId: string } | { trackId: string } | { master: true; sequenceId?: string };

/** Property key + owner → ParamPath (S01:CMD-010). */
export function propertyKeyToParamPath(owner: PropertyOwner, key: string): ParamPath {
	if (key.startsWith('effects.')) {
		const [, fxId, ...param] = key.split('.');
		return ['effect', fxId!, param.join('.')];
	}
	if ('clipId' in owner) return ['clip', owner.clipId, ...key.split('.')];
	if ('trackId' in owner) return ['track', owner.trackId, ...key.split('.')];
	return owner.sequenceId ? ['master', owner.sequenceId, key] : ['master', key];
}

/** ParamPath → owner + property key (inverse of `propertyKeyToParamPath`). */
export function paramPathToPropertyKey(path: readonly string[]): { owner: PropertyOwner | { effectId: string }; key: string } | null {
	const [head, a, ...rest] = path;
	if (!head || a === undefined) return null;
	switch (head) {
		case 'clip':
			return rest.length ? { owner: { clipId: a }, key: rest.join('.') } : null;
		case 'track':
			return rest.length ? { owner: { trackId: a }, key: rest.join('.') } : null;
		case 'effect':
			return rest.length ? { owner: { effectId: a }, key: `effects.${a}.${rest.join('.')}` } : null;
		case 'master':
			return rest.length ? { owner: { master: true, sequenceId: a }, key: rest.join('.') } : { owner: { master: true }, key: a };
		default:
			return null;
	}
}
