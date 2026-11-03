// Spec 19 §4 (TL-010…TL-021): the Title Looks data model. A look on a clip is one structured effect instance
// (`jasper.title-look`) whose `EffectInstance.appearance` holds an ordered stack of layers, a palette and lighting, the
// way `EffectInstance.puppet` holds Puppet's pins. This file is pure (zod and types only): the layer catalogue lives in
// `registry/fx/title-look/`, what needs both (validation, defaults) in `validate.ts`.
import { z } from 'zod';
import { hashString } from '../registry/fx/shader.ts';
import { type Animatable, animatable, type ParamValue, type RGBA } from '../schema/common.ts';
import type { FontRef } from '../schema/media.ts';

/** Effect id of a look (`EffectInstance.appearance`). Internal: never listed in the Effects panel. */
export const TITLE_LOOK_EFFECT_ID = 'jasper.title-look';

/** TL-089: the look effect's own param (`u_lookIntensity`), named not to meet a layer param in a pass. */
export const TITLE_LOOK_INTENSITY = 'lookIntensity';

/** TL-010: the clip kinds a look applies to. */
export const TITLE_LOOK_CLIP_KINDS = ['text', 'shape', 'still', 'solid', 'video'] as const;

/** TL-013. */
export const MAX_APPEARANCE_LAYERS = 24;
export const MAX_GRADIENT_STOPS = 32;
export const MAX_APPEARANCE_BYTES = 64 * 1024;
/** Most looks one project holds (`ProjectDocument.titleLooks`), and most colourways one look carries. */
export const MAX_TITLE_LOOKS = 1000;
export const MAX_LOOK_COLORWAYS = 64;
export const MAX_TITLE_LOOK_NAME = 120;
/** Gradient stops a stored value may hold before a load treats it as unreadable (TL-013 refuses more than 32 first). */
const HARD_STOP_CAP = 4096;

/** A colour slot of a look (§3 "Role"). */
export const COLOR_ROLES = [
	'face',
	'faceAlt',
	'keyline',
	'accent1',
	'accent2',
	'accent3',
	'base',
	'glow',
	'shadow',
] as const;
export const RoleSchema = z.enum(COLOR_ROLES);
export type Role = z.infer<typeof RoleSchema>;

/** What a role reads as when a palette does not fill it. */
export const DEFAULT_PALETTE: Readonly<Record<Role, RGBA>> = {
	face: [1, 1, 1, 1],
	faceAlt: [0.8, 0.8, 0.8, 1],
	keyline: [0, 0, 0, 1],
	accent1: [1, 0.8, 0.2, 1],
	accent2: [0.2, 0.6, 1, 1],
	accent3: [1, 0.25, 0.35, 1],
	base: [0.1, 0.1, 0.12, 1],
	glow: [1, 1, 1, 1],
	shadow: [0, 0, 0, 1],
};

const channel = z.number().min(0).max(1);
export const LookColorSchema = z.tuple([channel, channel, channel, channel]);

const StopPaintSchema = z.union([
	z.strictObject({ role: RoleSchema }),
	z.strictObject({ color: LookColorSchema }),
]);
export const GradientStopSchema = z.strictObject({
	/** Position along the gradient, 0…1. */
	at: z.number().min(0).max(1),
	paint: StopPaintSchema,
	/** Stop opacity 0…1 (absent = 1). */
	alpha: z.number().min(0).max(1).optional(),
});
export type GradientStop = z.infer<typeof GradientStopSchema>;

export const GRADIENT_TYPES = ['linear', 'radial', 'sweep', 'shape'] as const;
export const GRADIENT_SPANS = ['block', 'line', 'glyph'] as const;
export const GradientSchema = z.strictObject({
	type: z.enum(GRADIENT_TYPES),
	span: z.enum(GRADIENT_SPANS),
	/** Degrees, 0° = right, clockwise on screen (the framework's angle convention). */
	angle: z.number().min(-3600).max(3600),
	/** 2…32 (TL-013: commands refuse more with E_LIMIT; repair keeps the first 32). */
	stops: z.array(GradientStopSchema).min(2).max(HARD_STOP_CAP),
});
export type Gradient = z.infer<typeof GradientSchema>;

/**
 * A paint (TL-011) plus `source`: the clip's own picture. TL-011 lists role, colour and gradient; `source` is a fourth
 * kind so a look can sit on a still, a video or a styled text run without flattening it (TL-093 relies on it).
 */
export const PaintSchema = z.union([
	z.strictObject({ kind: z.literal('role'), role: RoleSchema }),
	z.strictObject({ kind: z.literal('color'), color: LookColorSchema }),
	z.strictObject({ kind: z.literal('gradient'), gradient: GradientSchema }),
	z.strictObject({ kind: z.literal('source') }),
]);
export type Paint = z.infer<typeof PaintSchema>;

/** A layer param's value: an ordinary param value, or a paint (paints are hold-only structure, TL-014). */
export type LayerParamValue = ParamValue | Paint;
export type AnimLayerParam = Animatable<LayerParamValue>;

/** A layer param as stored: an Animatable whose value the layer type's spec checks (`validate.ts`). */
export const LayerParamSchema = animatable(z.custom<LayerParamValue>((v) => v !== undefined));

export const AppearanceLayerSchema = z.looseObject({
	/** `apl_…`, unique inside its appearance (it keys `lookOverrides`, so it survives split, duplicate and paste). */
	id: z.string(),
	/** `face`, `rim`, …, `generator:<id>` (§5.1). */
	type: z.string(),
	enabled: z.boolean(),
	name: z.string().max(MAX_TITLE_LOOK_NAME).optional(),
	/** TL-051: colourways leave this layer alone. It reads no role, and a generator keeps its own colours. */
	fixedColor: z.boolean().optional(),
	params: z.record(z.string(), LayerParamSchema),
});
export type AppearanceLayer = {
	id: string;
	type: string;
	enabled: boolean;
	name?: string;
	fixedColor?: boolean;
	params: Record<string, AnimLayerParam>;
};

export const LIGHT_SOURCES = ['look', 'sequence'] as const;
export const AppearanceLightSchema = z.looseObject({
	/** `sequence` follows `Sequence.settings.globalLight` (TL-017); `look` uses the values here. */
	source: z.enum(LIGHT_SOURCES),
	angle: animatable(z.number()),
	altitude: animatable(z.number()),
});
export type AppearanceLight = {
	source: (typeof LIGHT_SOURCES)[number];
	angle: Animatable<number>;
	altitude: Animatable<number>;
};

/**
 * TL-053: the typography a look brings, applied to a text clip when the look is applied and not read again. A display
 * family has one or two weights, so the look names the weight: a text left at another one would be synthesised.
 */
export const LookFontSchema = z.strictObject({
	family: z.string().min(1).max(256),
	weight: z.number().int().min(1).max(1000).optional(),
	italic: z.boolean().optional(),
	trackingEm: z.number().min(-1).max(2).optional(),
	/** The family to use where `family` is not installed (a shared look); see `chooseLookFont`. */
	fallback: z.string().min(1).max(256).optional(),
	/** The face for text in Japanese: Latin display families have no kana. */
	ja: z
		.strictObject({
			family: z.string().min(1).max(256),
			weight: z.number().int().min(1).max(1000).optional(),
		})
		.optional(),
});
export type LookFont = z.infer<typeof LookFontSchema>;

/** Default light: from the upper left, 45° above the horizon. */
export const DEFAULT_LIGHT_ANGLE = 225;
export const DEFAULT_LIGHT_ALTITUDE = 45;

export const AppearanceSchema = z.looseObject({
	v: z.literal(1),
	lookId: z.string().optional(),
	lookOverrides: z.record(z.string(), z.unknown()).optional(),
	colorwayId: z.string().optional(),
	palette: z.partialRecord(RoleSchema, animatable(LookColorSchema)),
	light: AppearanceLightSchema,
	/** Integer. Survives split, duplicate and paste; noise layers read it instead of ids (TL-035). */
	seed: z.number().int().min(0).max(0xffff_ffff),
	/** Bottom-first. */
	layers: z.array(AppearanceLayerSchema),
	/** Applied to the text when the look is applied, then not read again. */
	font: LookFontSchema.loose().optional(),
});
export type Appearance = {
	v: 1;
	lookId?: string;
	lookOverrides?: Record<string, unknown>;
	colorwayId?: string;
	palette: Partial<Record<Role, Animatable<RGBA>>>;
	light: AppearanceLight;
	seed: number;
	layers: AppearanceLayer[];
	font?: FontRef | LookFont;
};

/** A named palette (§3): role values only, never structure (TL-051). */
export const ColorwaySchema = z.looseObject({
	id: z.string().min(1),
	name: z.string().min(1).max(MAX_TITLE_LOOK_NAME),
	palette: z.partialRecord(RoleSchema, LookColorSchema),
});
export type Colorway = { id: string; name: string; palette: Partial<Record<Role, RGBA>> };

/**
 * TL-089: a control a look offers in its header: a layer param, found by type and position among that type (`nth`), so
 * it survives overrides and needs no ids in a recipe. Most looks need none: the header then offers each layer's primary.
 */
export const LookQuickControlSchema = z.strictObject({
	label: z.string().min(1).max(MAX_TITLE_LOOK_NAME),
	layerType: z.string().min(1).max(64),
	nth: z.number().int().min(0).max(MAX_APPEARANCE_LAYERS).optional(),
	param: z.string().min(1).max(64),
});
export type LookQuickControl = z.infer<typeof LookQuickControlSchema>;
export const MAX_QUICK_CONTROLS = 6;

/** A look stored in the project (TL-015): an appearance without keyframes or a link, plus its name and colourways. */
export const TitleLookSchema = z.looseObject({
	id: z.string(),
	name: z.string().min(1).max(MAX_TITLE_LOOK_NAME),
	tags: z.array(z.string().max(64)).max(64).optional(),
	category: z.string().max(64).optional(),
	/** The library id this copy came from (absent = made in this project). */
	sourceId: z.string().max(128).optional(),
	colorways: z.array(ColorwaySchema).max(MAX_LOOK_COLORWAYS).optional(),
	/** Unreadable controls are dropped: the header falls back to the layers' primaries. */
	quickControls: z.array(LookQuickControlSchema).max(MAX_QUICK_CONTROLS).optional().catch(undefined),
	appearance: AppearanceSchema,
});
export type TitleLook = {
	id: string;
	name: string;
	tags?: string[];
	category?: string;
	sourceId?: string;
	colorways?: Colorway[];
	quickControls?: LookQuickControl[];
	appearance: Appearance;
};

/** `Sequence.settings.globalLight` (TL-017), keyed in sequence time. */
export const GlobalLightSchema = z.looseObject({
	angle: animatable(z.number()),
	altitude: animatable(z.number()),
});
export type GlobalLight = { angle: Animatable<number>; altitude: Animatable<number> };

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/** An unanimated value. */
export const staticAnim = <T>(value: T): Animatable<T> => ({ value, keyframes: [] });

/** TL-013: serialized size of an appearance in bytes (UTF-8). */
export function appearanceBytes(a: unknown): number {
	const s = JSON.stringify(a) ?? '';
	// UTF-8 length without an encoder: every code unit above 0x7f counts as its worst case of 3 bytes.
	let n = s.length;
	for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) n += 2;
	return n;
}

/** A stable appearance seed from an id (the id is only the source of randomness, not a live dependency). */
export function seedFromId(id: string): number {
	return hashString(id) >>> 0;
}

/** An appearance with no layers. */
export function emptyAppearance(seed = 0): Appearance {
	return {
		v: 1,
		palette: {},
		light: {
			source: 'look',
			angle: staticAnim(DEFAULT_LIGHT_ANGLE),
			altitude: staticAnim(DEFAULT_LIGHT_ALTITUDE),
		},
		seed,
		layers: [],
	};
}

/** A sequence's readable global light, or null (TL-017: absent = looks with `sequence` light use their own values). */
export function globalLightOf(seq: { settings: { globalLight?: unknown } }): GlobalLight | null {
	if (seq.settings.globalLight === undefined) return null;
	const r = GlobalLightSchema.safeParse(seq.settings.globalLight);
	return r.success ? (r.data as GlobalLight) : null;
}

/** The look instance of a clip's effect stack (TL-010: at most one), or null. */
export function clipLook<T extends { effectId: string }>(effects: readonly T[] | undefined): T | null {
	return effects?.find((fx) => fx.effectId === TITLE_LOOK_EFFECT_ID) ?? null;
}
