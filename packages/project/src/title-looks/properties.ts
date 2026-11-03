// Spec 19 TL-014: how the rest of the app addresses what an appearance stores. Every number and colour is an
// animatable property, reached by `param.set`, `keyframe.*` and `expression.*`:
//   ParamPath     ["appearance", fxId, layerId, param]     a layer param
//                 ["appearance", fxId, "palette", role]    a palette colour
//                 ["appearance", fxId, "light", prop]      light angle or altitude
//   property key  appearance.<fxId>.<layerId>.<param>      (the ParamPath joined with dots)
// Global light: ParamPath ["globalLight", sequenceId, prop], keys in sequence time.

import { isPaintParam, type TitleParamSpec } from '../registry/fx/title-look/contract.ts';
import { activeParamSpecs, paramSpec, titleLayerType } from '../registry/fx/title-look/registry.ts';
import type { PropertyContext, PropertySpec } from '../registry/properties.ts';
import type { Animatable } from '../schema/common.ts';
import type { EffectInstance } from '../schema/sequence.ts';
import { type Appearance, type AppearanceLayer, COLOR_ROLES, type Role } from './model.ts';
import { paramValueProblem, titleLookOf } from './validate.ts';

export const APPEARANCE_PATH = 'appearance';
export const PALETTE_SLOT = 'palette';
export const LIGHT_SLOT = 'light';
export const GLOBAL_LIGHT_PATH = 'globalLight';
export const LIGHT_PROPS = ['angle', 'altitude'] as const;
export type LightProp = (typeof LIGHT_PROPS)[number];

export const appearancePropertyKey = (fxId: string, slot: string, name: string) =>
	`${APPEARANCE_PATH}.${fxId}.${slot}.${name}`;

/** Light angle and altitude as param specs (they range like any angle). */
export const LIGHT_SPECS: Record<LightProp, TitleParamSpec> = {
	angle: {
		name: 'angle',
		label: 'Light Angle',
		type: 'number',
		default: 225,
		range: { step: 0.1 },
		unit: 'deg',
		animatable: true,
		ui: { control: 'angle' },
	},
	altitude: {
		name: 'altitude',
		label: 'Light Altitude',
		type: 'number',
		default: 45,
		range: { min: 0, max: 90, step: 0.1 },
		unit: 'deg',
		animatable: true,
	},
};

export const ROLE_LABELS: Record<Role, string> = {
	face: 'Face',
	faceAlt: 'Face Alt',
	keyline: 'Keyline',
	accent1: 'Accent 1',
	accent2: 'Accent 2',
	accent3: 'Accent 3',
	base: 'Base',
	glow: 'Glow',
	shadow: 'Shadow',
};

/** One animatable slot of an appearance. */
export type AppearanceSlot = {
	anim: Animatable<unknown>;
	/** Key of the property registry. */
	key: string;
	/** ParamPath. */
	path: string[];
	/** Where it sits from the effect instance (expressions bind through it). */
	at: (string | number)[];
};

/** Every animatable of an appearance, in a stable order. */
export function appearanceSlots(fxId: string, a: Appearance): AppearanceSlot[] {
	const out: AppearanceSlot[] = [];
	for (const role of COLOR_ROLES) {
		const anim = a.palette?.[role] as Animatable<unknown> | undefined;
		if (anim)
			out.push({
				anim,
				key: appearancePropertyKey(fxId, PALETTE_SLOT, role),
				path: [APPEARANCE_PATH, fxId, PALETTE_SLOT, role],
				at: ['appearance', 'palette', role],
			});
	}
	for (const p of LIGHT_PROPS) {
		const anim = a.light?.[p] as Animatable<unknown> | undefined;
		if (anim)
			out.push({
				anim,
				key: appearancePropertyKey(fxId, LIGHT_SLOT, p),
				path: [APPEARANCE_PATH, fxId, LIGHT_SLOT, p],
				at: ['appearance', 'light', p],
			});
	}
	(a.layers ?? []).forEach((l, i) => {
		for (const [name, anim] of Object.entries(l.params))
			out.push({
				anim: anim as Animatable<unknown>,
				key: appearancePropertyKey(fxId, l.id, name),
				path: [APPEARANCE_PATH, fxId, l.id, name],
				at: ['appearance', 'layers', i, 'params', name],
			});
	});
	return out;
}

/** The param spec of an appearance slot: `palette` gives a colour, `light` a light prop, a layer id its param. */
export function slotParamSpec(
	a: Appearance,
	slot: string,
	name: string,
): { spec: TitleParamSpec; layer: AppearanceLayer | null } | null {
	if (slot === PALETTE_SLOT) {
		if (!(COLOR_ROLES as readonly string[]).includes(name)) return null;
		return {
			spec: {
				name,
				label: ROLE_LABELS[name as Role],
				type: 'color',
				default: [1, 1, 1, 1],
				animatable: true,
			},
			layer: null,
		};
	}
	if (slot === LIGHT_SLOT) {
		const spec = LIGHT_SPECS[name as LightProp];
		return spec ? { spec, layer: null } : null;
	}
	const layer = a.layers.find((l) => l.id === slot);
	if (!layer) return null;
	const def = titleLayerType(layer.type);
	const spec = def ? paramSpec(def, name) : undefined;
	return spec ? { spec, layer } : null;
}

/** What a param goes back to: the linked look's value where the look has it, else the type's default. */
function defaultOf(p: TitleParamSpec, storagePath: readonly string[]) {
	return (ctx: PropertyContext): unknown => {
		const [, fxId, slot, name] = storagePath;
		const fx = (ctx.clip as { effects?: EffectInstance[] }).effects?.find((e) => e.id === fxId);
		const lookId = (fx?.appearance as Appearance | undefined)?.lookId;
		const look = lookId ? titleLookOf(ctx.doc as never, lookId) : null;
		const held = look ? appearanceAnimAt(look.appearance, slot!, name!) : undefined;
		return held ? held.value : p.default;
	};
}

function propertySpecOf(key: string, p: TitleParamSpec, storagePath: string[], label: string): PropertySpec {
	const appliesTo = () => true;
	if (isPaintParam(p))
		return {
			key,
			label,
			group: 'effect',
			kind: 'json',
			animatable: 'hold-only',
			storagePath,
			appliesTo,
			ui: { control: 'paint' },
			defaultValue: defaultOf(p, storagePath),
			validate: (v) => !paramValueProblem(p, v),
		};
	return {
		key,
		label,
		group: 'effect',
		kind: p.type as PropertySpec['kind'],
		...(p.unit ? { unit: p.unit } : {}),
		...(p.range ? { range: p.range } : {}),
		...(p.options ? { options: p.options } : {}),
		animatable: p.animatable ? 'continuous' : 'hold-only',
		storagePath,
		appliesTo,
		ui: p.ui ?? { control: p.type === 'number' ? 'scrub' : p.type === 'color' ? 'color' : 'select' },
		defaultValue: defaultOf(p, storagePath),
	} as PropertySpec;
}

/** Property specs of one layer's shown params (Effect Controls, Properties, agent queries). */
export function layerPropertySpecs(fx: Pick<EffectInstance, 'id'>, layer: AppearanceLayer): PropertySpec[] {
	const def = titleLayerType(layer.type);
	if (!def) return [];
	const finish = layer.params.finish?.value;
	return activeParamSpecs(def, typeof finish === 'string' ? finish : 'flat').map((p) =>
		propertySpecOf(
			appearancePropertyKey(fx.id, layer.id, p.name),
			p,
			['$appearance', fx.id, layer.id, p.name],
			p.label,
		),
	);
}

/** Every property spec of an appearance: palette, light and layers. */
export function appearancePropertySpecs(fx: Pick<EffectInstance, 'id'>, a: Appearance): PropertySpec[] {
	const out: PropertySpec[] = [];
	for (const role of COLOR_ROLES) {
		const s = slotParamSpec(a, PALETTE_SLOT, role)!;
		out.push(
			propertySpecOf(
				appearancePropertyKey(fx.id, PALETTE_SLOT, role),
				s.spec,
				['$appearance', fx.id, PALETTE_SLOT, role],
				ROLE_LABELS[role],
			),
		);
	}
	for (const p of LIGHT_PROPS)
		out.push(
			propertySpecOf(
				appearancePropertyKey(fx.id, LIGHT_SLOT, p),
				LIGHT_SPECS[p],
				['$appearance', fx.id, LIGHT_SLOT, p],
				LIGHT_SPECS[p].label,
			),
		);
	for (const l of a.layers) out.push(...layerPropertySpecs(fx, l));
	return out;
}

/** What a slot is called where a list needs one name: `Rim Width`, `Palette Face`, `Light Angle`. */
export function slotLabel(a: Appearance, key: string): string {
	const [, , slot, name] = key.split('.');
	if (slot === PALETTE_SLOT) return `Palette ${ROLE_LABELS[name as Role] ?? name}`;
	if (slot === LIGHT_SLOT) return LIGHT_SPECS[name as LightProp]?.label ?? name!;
	const layer = a.layers?.find((l) => l.id === slot);
	const def = layer ? titleLayerType(layer.type) : undefined;
	const spec = def ? paramSpec(def, name!) : undefined;
	return `${layer?.name ?? def?.label ?? slot} ${spec?.label ?? name}`;
}

/** The stored Animatable of a property path, or undefined. */
export function appearanceAnimAt(a: Appearance, slot: string, name: string): Animatable<unknown> | undefined {
	if (slot === PALETTE_SLOT) return a.palette?.[name as Role] as Animatable<unknown> | undefined;
	if (slot === LIGHT_SLOT) return a.light?.[name as LightProp] as Animatable<unknown> | undefined;
	return a.layers?.find((l) => l.id === slot)?.params[name] as Animatable<unknown> | undefined;
}
