// Spec 19 TL-050 / TL-104: a look as authored: plain values, no ids, no Animatables. The factory library, user-look
// imports and agent recipes are recipes; `appearanceFromRecipe` turns one into a stored appearance, filling every param
// of each layer type with its default, so a layer type added later stays editable on old looks.
import { z } from 'zod';
import { isPaintParam } from '../registry/fx/title-look/contract.ts';
import { activeParamSpecs, titleLayerType } from '../registry/fx/title-look/registry.ts';
import {
	type AnimLayerParam,
	type Appearance,
	type AppearanceLayer,
	DEFAULT_LIGHT_ALTITUDE,
	DEFAULT_LIGHT_ANGLE,
	type LayerParamValue,
	LIGHT_SOURCES,
	LookColorSchema,
	LookFontSchema,
	MAX_APPEARANCE_LAYERS,
	MAX_TITLE_LOOK_NAME,
	type Role,
	RoleSchema,
	staticAnim,
} from './model.ts';

/** Bytes a recipe may hold before it is read at all. */
export const MAX_RECIPE_BYTES = 256 * 1024;

export const RecipeLayerSchema = z.strictObject({
	type: z.string().min(1).max(64),
	name: z.string().max(MAX_TITLE_LOOK_NAME).optional(),
	enabled: z.boolean().optional(),
	/** TL-051: colourways leave this layer alone (it uses `color` paints, a generator keeps its own colours). */
	fixedColor: z.boolean().optional(),
	params: z.record(z.string(), z.unknown()).optional(),
});
export type RecipeLayer = z.infer<typeof RecipeLayerSchema>;

export const LookRecipeSchema = z.strictObject({
	palette: z.partialRecord(RoleSchema, LookColorSchema).optional(),
	light: z
		.strictObject({
			source: z.enum(LIGHT_SOURCES).optional(),
			angle: z.number().optional(),
			altitude: z.number().optional(),
		})
		.optional(),
	/** Bottom-first. Limits are the commands' to refuse (TL-013: `E_LIMIT`), so a schema cap here is only a sanity bound. */
	layers: z.array(RecipeLayerSchema).max(MAX_APPEARANCE_LAYERS * 8),
	font: LookFontSchema.optional(),
});
export type LookRecipe = z.infer<typeof LookRecipeSchema>;

/**
 * A stored layer from a recipe layer: every param present with its default or the recipe's value. Values are not
 * validated here: the caller runs `appearanceProblem`. Unknown layer types and params throw a message.
 */
export function layerFromRecipe(l: RecipeLayer, id: string): AppearanceLayer {
	const def = titleLayerType(l.type);
	if (!def) throw new Error(`unknown layer type ${l.type}`);
	const given = l.params ?? {};
	const finish = typeof given.finish === 'string' ? given.finish : 'flat';
	const specs = activeParamSpecs(def, finish);
	const names = new Set(specs.map((p) => p.name));
	for (const k of Object.keys(given)) if (!names.has(k)) throw new Error(`${l.type} has no parameter ${k}`);
	const params: Record<string, AnimLayerParam> = {};
	for (const p of specs) {
		const v = (given[p.name] ?? p.default) as LayerParamValue;
		// Paints and hold-only params are stored with hold semantics by the keyframe commands, like any other.
		params[p.name] = staticAnim(isPaintParam(p) ? JSON.parse(JSON.stringify(v)) : v);
	}
	return {
		id,
		type: l.type,
		enabled: l.enabled !== false,
		...(l.name ? { name: l.name } : {}),
		...(l.fixedColor ? { fixedColor: true } : {}),
		params,
	};
}

/** The stored form of a recipe (TL-015: no keyframes). Throws a message for unknown types or params. */
export function appearanceFromRecipe(r: LookRecipe, newLayerId: () => string, seed = 0): Appearance {
	const palette: Appearance['palette'] = {};
	for (const [role, c] of Object.entries(r.palette ?? {}))
		palette[role as Role] = staticAnim([...c] as never);
	return {
		v: 1,
		palette,
		light: {
			source: r.light?.source ?? 'look',
			angle: staticAnim(r.light?.angle ?? DEFAULT_LIGHT_ANGLE),
			altitude: staticAnim(r.light?.altitude ?? DEFAULT_LIGHT_ALTITUDE),
		},
		seed,
		layers: r.layers.map((l) => layerFromRecipe(l, newLayerId())),
		...(r.font ? { font: { ...r.font } } : {}),
	};
}
