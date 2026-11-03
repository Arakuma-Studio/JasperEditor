// Spec 19 TL-054: the versioned format of user looks, shared by the engine's library (`<appdir>/presets/title-looks.json`),
// exported `.json` files and agents. A user look is a recipe with metadata: no ids of any project, no keyframes, so it
// moves between projects and machines. The library is never stored in a project (TL-015): applying one copies it in.
//
// Reading is strict and never throws: `parseUserLook` and `parseLookFile` return results. An entry of a newer version is
// refused, not guessed at. Objects are loose, so a field a newer minor write added survives a round trip through this one.
import { z } from 'zod';
import {
	appearanceBytes,
	type Colorway,
	ColorwaySchema,
	MAX_LOOK_COLORWAYS,
	MAX_TITLE_LOOK_NAME,
} from './model.ts';
import { appearanceFromRecipe, type LookRecipe, LookRecipeSchema, MAX_RECIPE_BYTES } from './recipe.ts';
import { appearanceProblem } from './validate.ts';

export const USER_LOOK_VERSION = 1;
/** An exported file of one or more looks. */
export const USER_LOOK_BUNDLE_FORMAT = 'jasper-title-looks';
/** The library file on the engine: an exported file can be its copy. */
export const USER_LOOK_LIBRARY_FORMAT = 'jasper-title-look-library';
/** Most looks the library holds. */
export const MAX_USER_LOOKS = 2000;
/** A file larger than this (UTF-8 JSON) is refused before it is read. */
export const MAX_LOOK_FILE_BYTES = 8 * 1024 * 1024;
/** Most entries a file may hold. */
const MAX_FILE_ENTRIES = MAX_USER_LOOKS;
export const USER_LOOK_ID = /^ulk_[0-9A-Z]{16}$/;

export const UserLookSchema = z.looseObject({
	/** `ulk_…`, assigned by the library. */
	id: z.string().regex(USER_LOOK_ID),
	version: z.literal(USER_LOOK_VERSION),
	name: z.string().trim().min(1).max(MAX_TITLE_LOOK_NAME),
	tags: z.array(z.string().max(64)).max(64).optional(),
	category: z.string().max(64).optional(),
	colorways: z.array(ColorwaySchema).max(MAX_LOOK_COLORWAYS).optional(),
	recipe: LookRecipeSchema,
	createdAt: z.string().max(64),
	updatedAt: z.string().max(64),
});
export type UserLook = z.infer<typeof UserLookSchema>;

export type ParsedUserLook = { ok: true; look: UserLook } | { ok: false; message: string };

/** Why a recipe cannot be stored, or null: it must build a valid appearance within TL-013's limits. */
export function recipeProblem(recipe: unknown): string | null {
	if (appearanceBytes(recipe) > MAX_RECIPE_BYTES) return 'the recipe is too large';
	const r = LookRecipeSchema.safeParse(recipe);
	if (!r.success) {
		const i = r.error.issues[0]!;
		return `${i.path.join('.') || 'recipe'}: ${i.message}`;
	}
	let n = 0;
	try {
		const a = appearanceFromRecipe(r.data, () => `apl_${(++n).toString(16).padStart(16, '0')}`);
		return appearanceProblem(a);
	} catch (e) {
		return (e as Error).message;
	}
}

/** A stored or imported look, or why not. */
export function parseUserLook(raw: unknown): ParsedUserLook {
	const version = (raw as { version?: unknown } | null)?.version;
	if (typeof version === 'number' && version > USER_LOOK_VERSION)
		return { ok: false, message: `made with a newer JasperEditor (version ${version})` };
	const r = UserLookSchema.safeParse(raw);
	if (!r.success) {
		const i = r.error.issues[0]!;
		return { ok: false, message: `${i.path.join('.') || 'look'}: ${i.message}` };
	}
	const bad = recipeProblem(r.data.recipe);
	if (bad) return { ok: false, message: bad };
	return { ok: true, look: r.data };
}

export type ParsedLookFile = { ok: true; entries: unknown[] } | { ok: false; message: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The entries of an imported file: a bundle, a library file, one look or a list. Entries are not checked here: the
 * importer takes the good ones and reports the others by index.
 */
export function parseLookFile(raw: unknown): ParsedLookFile {
	if (appearanceBytes(raw) > MAX_LOOK_FILE_BYTES)
		return { ok: false, message: `A looks file holds at most ${MAX_LOOK_FILE_BYTES} bytes` };
	let entries: unknown[];
	if (Array.isArray(raw)) entries = raw;
	else if (!isObject(raw)) return { ok: false, message: 'Not a looks file' };
	else if (raw.format === USER_LOOK_BUNDLE_FORMAT || raw.format === USER_LOOK_LIBRARY_FORMAT) {
		if (typeof raw.version === 'number' && raw.version > USER_LOOK_VERSION)
			return { ok: false, message: `Made with a newer JasperEditor (version ${raw.version})` };
		if (!Array.isArray(raw.looks)) return { ok: false, message: 'The file holds no looks' };
		entries = raw.looks;
	} else if ('recipe' in raw) entries = [raw];
	else return { ok: false, message: 'Not a looks file' };
	if (entries.length === 0) return { ok: false, message: 'The file holds no looks' };
	if (entries.length > MAX_FILE_ENTRIES)
		return { ok: false, message: `A file holds at most ${MAX_FILE_ENTRIES} looks` };
	return { ok: true, entries };
}

/**
 * What `look.apply {look}` is given for a user look: the look whole, with its id as `sourceId`, so the first use copies it
 * into the project and later uses reuse that copy (TL-015). The Looks tab and agents' `title_look_find` both apply it so.
 */
export function userLookSource(l: UserLook): {
	name: string;
	recipe: LookRecipe;
	sourceId: string;
	tags?: string[];
	category?: string;
	colorways?: Colorway[];
} {
	return {
		name: l.name,
		recipe: l.recipe,
		sourceId: l.id,
		...(l.tags?.length ? { tags: [...l.tags] } : {}),
		...(l.category ? { category: l.category } : {}),
		...(l.colorways?.length ? { colorways: [...(l.colorways as Colorway[])] } : {}),
	};
}

/** The file Export writes. */
export function buildLookBundle(looks: readonly UserLook[]): {
	format: typeof USER_LOOK_BUNDLE_FORMAT;
	version: typeof USER_LOOK_VERSION;
	looks: UserLook[];
} {
	return {
		format: USER_LOOK_BUNDLE_FORMAT,
		version: USER_LOOK_VERSION,
		looks: JSON.parse(JSON.stringify(looks)) as UserLook[],
	};
}
