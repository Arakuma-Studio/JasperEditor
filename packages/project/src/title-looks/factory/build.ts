// Spec 19 TL-050: the words the category files write looks in. A look is structure with roles for its colours, so any
// colourway fits it (TL-051); a colour outside the palette needs `fixedColor` on its layer, and the library test checks it.
import type { RGBA } from '../../schema/common.ts';
import type { Colorway, LookFont, Paint, Role, TitleLook } from '../model.ts';
import type { LookRecipe, RecipeLayer } from '../recipe.ts';

/** A factory look: metadata and a recipe, under a library id (`look.<slug>`), not a project id. */
export type FactoryLook = Omit<TitleLook, 'id' | 'appearance' | 'sourceId' | 'tags' | 'category'> & {
	libraryId: string;
	/** Spanish name (TL-097); English `name` is what a project stores. */
	nameEs: string;
	/** One of `LOOK_CATEGORIES`. */
	category: string;
	/** Search words in English, Spanish and, where they apply, Japanese. Never a real title (TL-001). */
	tags: string[];
	/** One line for tooltips and agents. */
	description: string;
	/** A generic sample for thumbnails and contact sheets. */
	sampleText: string;
	/** The colourway its palette starts as, and the ones shown on its card. */
	colorwayId: string;
	suggestedColorways: readonly string[];
	recipe: LookRecipe;
};

export type FactoryColorway = Colorway & {
	nameEs: string;
	tags: readonly string[];
	/** Every role filled (TL-051: tags are stored, not guessed). */
	palette: Record<Role, RGBA>;
};

export const role = (r: Role): Paint => ({ kind: 'role', role: r });

type StopInit = readonly [at: number, role: Role, alpha?: number];

/** A gradient of roles over the title (`block`). `angle`: 0° = right, 90° = down. */
export function gradient(angle: number, ...stops: readonly StopInit[]): Paint {
	return {
		kind: 'gradient',
		gradient: {
			type: 'linear',
			span: 'block',
			angle,
			stops: stops.map(([at, r, alpha]) => ({
				at,
				paint: { role: r },
				...(alpha !== undefined ? { alpha } : {}),
			})),
		},
	};
}

/** From the centre outward. */
export function radial(...stops: readonly StopInit[]): Paint {
	const p = gradient(0, ...stops) as Extract<Paint, { kind: 'gradient' }>;
	return { kind: 'gradient', gradient: { ...p.gradient, type: 'radial' } };
}

type Params = Record<string, unknown>;

export const face = (paint: Paint = role('face'), params: Params = {}): RecipeLayer => ({
	type: 'face',
	params: { paint, ...params },
});
export const rim = (width: number, paint: Paint, params: Params = {}): RecipeLayer => ({
	type: 'rim',
	params: { width, paint, ...params },
});
export const shadow = (params: Params = {}): RecipeLayer => ({ type: 'shadow', params });
export const glow = (radius: number, intensity: number, params: Params = {}): RecipeLayer => ({
	type: 'glow',
	params: { radius, intensity, ...params },
});

/** Hard offset block: what a sticker or a comic panel casts. */
export const hardShadow = (distance: number, angle: number, paint: Paint = role('base')): RecipeLayer =>
	shadow({ distance, angle, blur: 0, opacity: 100, paint });

/** A long extruded shadow. */
export const longShadow = (distance: number, angle: number, paint: Paint = role('base')): RecipeLayer =>
	shadow({ kind: 'long', distance, angle, blur: 0, opacity: 100, paint });

/** A layer of the given type with its params as written (inner effects, plates, textures, gloss, extrusion). */
export const layer = (type: string, params: Params = {}): RecipeLayer => ({ type, params });

/**
 * A generator as a look layer (§7). Its picture follows the colourway through its `paint` role; `own` keeps the
 * generator's own colours (TL-051: fire stays fire), so the layer is marked fixed and its look colour is a colour.
 */
export const generator = (id: string, params: Params = {}, own?: RGBA): RecipeLayer => ({
	type: `generator:${id}`,
	...(own ? { fixedColor: true } : {}),
	params: own ? { ...params, ownColors: true, paint: { kind: 'color', color: own } } : params,
});

/** Latin display faces name a Japanese face and a fallback: see `chooseLookFont`. */
export const font = (
	family: string,
	weight: number,
	fallback: string,
	ja: string,
	jaWeight: number,
	trackingEm = 0,
): LookFont => ({
	family,
	weight,
	...(trackingEm ? { trackingEm } : {}),
	...(family !== fallback ? { fallback } : {}),
	...(family !== ja ? { ja: { family: ja, weight: jaWeight } } : {}),
});

/** The Japanese faces, by what they do. */
export const JA = {
	heavy: ['Dela Gothic One', 400],
	pop: ['Reggae One', 400],
	rock: ['RocknRoll One', 400],
	gothic: ['Zen Kaku Gothic New', 900],
	round: ['Zen Maru Gothic', 900],
	mincho: ['Kaisei Tokumin', 800],
	brush: ['Yuji Boku', 400],
	pixel: ['DotGothic16', 400],
} as const;
