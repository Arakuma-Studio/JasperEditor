// The user's style recipe library (spec 15 EA-010; docs/wp-notes/edit-automation.md "Style recipes"): a directory
// `<appdir>/style-recipes/` shared by every project, editor window and agent — `index.json` (zod-validated:
// `{format, version, revision, recipes: [{id, file, name, updatedAt}]}`) and one `<id>.json` per recipe. Every write is
// atomic (temp file, fsync, rename, directory fsync) and serialized; every change bumps `revision`.
//
// Loading repairs conservatively and reports what it did (`repairs`, shown to the user once): an unreadable index is
// moved aside (`index.json.corrupt-<time>`) and rebuilt from the recipe files; an index entry whose file is gone is
// dropped; a recipe file the index does not list is adopted; a file that is not a readable recipe is moved aside
// (`<file>.invalid-<time>`), never deleted. Recipes of a newer format are listed read-only and never rewritten; a
// library index of a newer version makes the whole library read-only. Order of writes: a new recipe's file, then the
// index (a crash leaves an orphan that the next load adopts); a deletion unlinks the file, then writes the index (a
// crash leaves an entry without a file that the next load drops). Built-ins (`builtin:*`) are code, never stored.
import { randomBytes } from 'node:crypto';
import { readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
	BUILTIN_STYLE_RECIPES,
	builtinStyleRecipe,
	isNewerRecipe,
	parseStyleRecipe,
	STYLE_RECIPE_FORMAT,
	STYLE_RECIPE_VERSION,
	type StyleRecipe,
	styleRecipeIdFrom,
} from '@jasper/project';
import { z } from 'zod';
import { atomicWriteJson, exists, fsyncDir, readJsonOrNull } from '../tools/fs.ts';
import { HttpError } from '../tools/reply.ts';

export const STYLE_RECIPE_LIBRARY_FORMAT = 'jasper-style-recipe-library';
export const STYLE_RECIPE_LIBRARY_VERSION = 1;
/** Most recipes the library holds. */
export const MAX_LIBRARY_RECIPES = 500;

const RECIPE_FILE_RE = /^rcp_[0-9A-HJKMNP-TV-Z]{16}\.json$/;
const RECIPE_ID_RE = /^rcp_[0-9A-HJKMNP-TV-Z]{16}$/;

const IndexEntrySchema = z.strictObject({
	id: z.string().regex(RECIPE_ID_RE),
	file: z.string().regex(RECIPE_FILE_RE),
	name: z.string().max(200),
	updatedAt: z.string().max(40).optional(),
});
const IndexSchema = z.strictObject({
	format: z.literal(STYLE_RECIPE_LIBRARY_FORMAT),
	version: z.number().int().min(1),
	revision: z.number().int().min(0),
	recipes: z.array(IndexEntrySchema).max(MAX_LIBRARY_RECIPES * 2),
});
type Index = z.infer<typeof IndexSchema>;

export type LibraryRepair = { action: string; entity: string; detail: string };

/** A recipe of the library: readable (`recipe`), or made by a newer JasperEditor (`newer`, kept as it is). */
export type LibraryRecipe =
	| { id: string; name: string; recipe: StyleRecipe; newer?: false }
	| { id: string; name: string; newer: true };

export type RecipeListEntry = {
	id: string;
	name: string;
	source: 'builtin' | 'library';
	readOnly: boolean;
	newer?: boolean;
	recipe?: StyleRecipe;
};

type State = { index: Index; recipes: Map<string, LibraryRecipe> };

const notFound = (id: string) =>
	new HttpError(404, 'RECIPE_NOT_FOUND', `Style recipe not found: ${String(id).slice(0, 80)}`, {
		code: 'E_NOT_FOUND',
	});
const builtInReadOnly = () =>
	new HttpError(409, 'RECIPE_READ_ONLY', 'Built-in style recipes are read-only: duplicate one to change it', {
		code: 'E_READ_ONLY',
	});

export class StyleRecipeLibrary {
	private state: State | null = null;
	private readOnly = false;
	private repairs: LibraryRepair[] = [];
	private chain: Promise<void> = Promise.resolve();

	constructor(
		private readonly dir: string,
		private readonly opts: {
			now?: () => string;
			onChange?: (revision: number) => void;
			log?: (m: string) => void;
		} = {},
	) {}

	private now(): string {
		return this.opts.now?.() ?? new Date().toISOString();
	}

	private get indexFile() {
		return join(this.dir, 'index.json');
	}

	private note(action: string, entity: string, detail: string) {
		this.repairs.push({ action, entity, detail });
		this.opts.log?.(`style recipes: ${action} ${entity}: ${detail}`);
	}

	private async setAside(file: string, why: string, kind: 'corrupt' | 'invalid'): Promise<string> {
		const aside = `${file}.${kind}-${Date.now()}`;
		try {
			await rename(file, aside);
			await fsyncDir(this.dir);
		} catch {
			// it may be gone already
		}
		return `${why}: moved aside to ${aside.split(/[\\/]/).pop()}`;
	}

	/** Reads one recipe file: the recipe, a newer one, or null (moved aside, reported). */
	private async readRecipe(file: string, id: string): Promise<LibraryRecipe | null> {
		const path = join(this.dir, file);
		const raw = await readJsonOrNull<unknown>(path);
		if (raw === null) {
			if (await exists(path))
				this.note('set-aside', id, await this.setAside(path, 'unreadable JSON', 'invalid'));
			return null;
		}
		if (isNewerRecipe(raw)) {
			const name = typeof (raw as { name?: unknown }).name === 'string' ? (raw as { name: string }).name : id;
			return { id, name: name.slice(0, 120), newer: true };
		}
		const r = parseStyleRecipe(raw);
		if (!r.ok || r.recipe.id !== id) {
			const why = r.ok ? `its id ${r.recipe.id} is not its file name` : r.message;
			if (!this.readOnly)
				this.note(
					'set-aside',
					id,
					await this.setAside(path, `not a readable recipe (${why})`.slice(0, 300), 'invalid'),
				);
			else this.note('skip', id, `not a readable recipe (${why})`.slice(0, 300));
			return null;
		}
		const { builtIn: _b, ...recipe } = r.recipe;
		return { id, name: recipe.name, recipe };
	}

	private async load(): Promise<State> {
		if (this.state) return this.state;
		const empty: Index = {
			format: STYLE_RECIPE_LIBRARY_FORMAT,
			version: STYLE_RECIPE_LIBRARY_VERSION,
			revision: 0,
			recipes: [],
		};
		let index = empty;
		let dirty = false;
		const raw = await readJsonOrNull<unknown>(this.indexFile);
		if (raw === null) {
			if (await exists(this.indexFile)) {
				this.note(
					'rebuild-index',
					'index.json',
					await this.setAside(this.indexFile, 'unreadable index', 'corrupt'),
				);
				dirty = true;
			}
		} else {
			const v = (raw as { version?: unknown }).version;
			if (typeof v === 'number' && v > STYLE_RECIPE_LIBRARY_VERSION) {
				this.readOnly = true;
				this.opts.log?.('style recipes: the library was written by a newer JasperEditor (read-only)');
			}
			const p = IndexSchema.safeParse(raw);
			if (p.success) index = p.data;
			else if (this.readOnly) {
				// a newer index we cannot read: list what its files say, change nothing
				index = empty;
			} else {
				this.note(
					'rebuild-index',
					'index.json',
					await this.setAside(
						this.indexFile,
						`index not readable (${p.error.issues[0]?.message ?? 'schema'})`,
						'corrupt',
					),
				);
				dirty = true;
			}
		}
		const recipes = new Map<string, LibraryRecipe>();
		const kept: Index['recipes'] = [];
		for (const e of index.recipes) {
			if (recipes.has(e.id) || e.file !== `${e.id}.json`) {
				this.note('drop-entry', e.id, 'a duplicate or malformed index entry was removed');
				dirty = true;
				continue;
			}
			if (!(await exists(join(this.dir, e.file)))) {
				this.note('drop-entry', e.id, `the recipe file ${e.file} is missing: removed from the index`);
				dirty = true;
				continue;
			}
			const r = await this.readRecipe(e.file, e.id);
			if (!r) {
				dirty = true;
				continue;
			}
			recipes.set(e.id, r);
			kept.push({ ...e, name: r.name });
		}
		// recipe files the index does not list (a crash between a write and the index, a copied file)
		let files: string[] = [];
		try {
			files = (await readdir(this.dir)).filter((f) => RECIPE_FILE_RE.test(f)).sort();
		} catch {
			files = [];
		}
		for (const f of files) {
			const id = f.slice(0, -5);
			if (recipes.has(id)) continue;
			if (recipes.size >= MAX_LIBRARY_RECIPES) {
				this.note('skip', id, `more than ${MAX_LIBRARY_RECIPES} recipes: not listed`);
				continue;
			}
			const r = await this.readRecipe(f, id);
			if (!r) continue;
			recipes.set(id, r);
			kept.push({ id, file: f, name: r.name, ...(r.newer ? {} : { updatedAt: r.recipe.updatedAt }) });
			this.note('adopt', id, `a recipe file the index did not list was added back (${r.name})`);
			dirty = true;
		}
		const next: Index = { ...index, recipes: kept };
		if (dirty && !this.readOnly) {
			next.revision = index.revision + 1;
			await atomicWriteJson(this.indexFile, next, true);
		}
		this.state = { index: next, recipes };
		return this.state;
	}

	/** Runs a mutation alone, persists it (files first, then the index) and announces the new revision. */
	private mutate<T>(fn: (s: State) => Promise<T>): Promise<T> {
		const run = this.chain.then(async () => {
			const s = await this.load();
			if (this.readOnly)
				throw new HttpError(
					409,
					'LIBRARY_READ_ONLY',
					'The style recipe library was written by a newer JasperEditor and is read-only',
					{ code: 'E_READ_ONLY' },
				);
			const out = await fn(s);
			s.index = { ...s.index, revision: s.index.revision + 1 };
			await atomicWriteJson(this.indexFile, s.index, true);
			this.opts.onChange?.(s.index.revision);
			return out;
		});
		this.chain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** Built-ins first, then the library (by name). */
	async list(): Promise<{
		revision: number;
		recipes: RecipeListEntry[];
		repairs: LibraryRepair[];
		readOnly: boolean;
	}> {
		await this.chain;
		const s = await this.load();
		const lib = [...s.recipes.values()].sort(
			(a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
		);
		return {
			revision: s.index.revision,
			recipes: [
				...BUILTIN_STYLE_RECIPES.map((r) => ({
					id: r.id,
					name: r.name,
					source: 'builtin' as const,
					readOnly: true,
					recipe: structuredClone(r),
				})),
				...lib.map((r) =>
					r.newer
						? { id: r.id, name: r.name, source: 'library' as const, readOnly: true, newer: true }
						: {
								id: r.id,
								name: r.name,
								source: 'library' as const,
								readOnly: this.readOnly,
								recipe: structuredClone(r.recipe),
							},
				),
			],
			repairs: [...this.repairs],
			readOnly: this.readOnly,
		};
	}

	/** A recipe ready to use (built-in or library); newer ones are refused with the reason. */
	async get(id: string): Promise<StyleRecipe> {
		const b = builtinStyleRecipe(id);
		if (b) return b;
		await this.chain;
		const r = (await this.load()).recipes.get(id);
		if (!r) throw notFound(id);
		if (r.newer)
			throw new HttpError(
				409,
				'RECIPE_NEWER',
				`The style recipe “${r.name}” was made by a newer JasperEditor: update JasperEditor to use it`,
				{ code: 'E_NEWER_VERSION' },
			);
		return structuredClone(r.recipe);
	}

	async entry(id: string): Promise<RecipeListEntry> {
		const all = await this.list();
		const e = all.recipes.find((x) => x.id === id);
		if (!e) throw notFound(id);
		return e;
	}

	private newId(s: State): string {
		for (;;) {
			const id = styleRecipeIdFrom(randomBytes(16));
			if (!s.recipes.has(id)) return id;
		}
	}

	private async writeRecipe(s: State, recipe: StyleRecipe): Promise<void> {
		await atomicWriteJson(join(this.dir, `${recipe.id}.json`), recipe, true);
		s.recipes.set(recipe.id, { id: recipe.id, name: recipe.name, recipe });
		const entry = {
			id: recipe.id,
			file: `${recipe.id}.json`,
			name: recipe.name,
			updatedAt: recipe.updatedAt,
		};
		const i = s.index.recipes.findIndex((e) => e.id === recipe.id);
		const list = [...s.index.recipes];
		if (i >= 0) list[i] = entry;
		else list.push(entry);
		s.index = { ...s.index, recipes: list };
	}

	private checked(raw: unknown): StyleRecipe {
		const r = parseStyleRecipe(raw);
		if (!r.ok)
			throw new HttpError(r.code === 'E_NEWER_VERSION' ? 409 : 400, 'RECIPE_INVALID', r.message, {
				code: r.code === 'E_TOO_LARGE' ? 'E_LIMIT' : r.code,
			});
		const { builtIn: _b, ...recipe } = r.recipe;
		return recipe;
	}

	/** Saves a new recipe: a new id, revision 1, the times; `basedOn` = the recipe it came from. */
	create(raw: Record<string, unknown>): Promise<RecipeListEntry> {
		return this.mutate(async (s) => {
			if (s.recipes.size >= MAX_LIBRARY_RECIPES)
				throw new HttpError(
					409,
					'LIBRARY_FULL',
					`The library holds at most ${MAX_LIBRARY_RECIPES} style recipes`,
					{
						code: 'E_LIMIT',
					},
				);
			const now = this.now();
			const from = typeof raw.id === 'string' ? raw.id : undefined;
			const { builtIn: _b, ...rest } = raw;
			const recipe = this.checked({
				format: STYLE_RECIPE_FORMAT,
				version: STYLE_RECIPE_VERSION,
				...rest,
				id: this.newId(s),
				revision: 1,
				...(from && (from.startsWith('builtin:') || RECIPE_ID_RE.test(from)) && raw.basedOn === undefined
					? { basedOn: from }
					: {}),
				createdAt: now,
				updatedAt: now,
			});
			await this.writeRecipe(s, recipe);
			return { id: recipe.id, name: recipe.name, source: 'library' as const, readOnly: false, recipe };
		});
	}

	/** Renames / replaces a library recipe (its id stays; revision + 1). */
	update(
		id: string,
		patch: { name?: string; description?: string; recipe?: Record<string, unknown> },
	): Promise<RecipeListEntry> {
		if (builtinStyleRecipe(id)) return Promise.reject(builtInReadOnly());
		return this.mutate(async (s) => {
			const cur = s.recipes.get(id);
			if (!cur) throw notFound(id);
			if (cur.newer)
				throw new HttpError(
					409,
					'RECIPE_NEWER',
					`“${cur.name}” was made by a newer JasperEditor and is read-only`,
					{
						code: 'E_NEWER_VERSION',
					},
				);
			const base = patch.recipe ? { ...patch.recipe } : { ...cur.recipe };
			const recipe = this.checked({
				...base,
				format: STYLE_RECIPE_FORMAT,
				version: STYLE_RECIPE_VERSION,
				id,
				revision: cur.recipe.revision + 1,
				...(patch.name !== undefined ? { name: patch.name } : {}),
				...(patch.description !== undefined ? { description: patch.description } : {}),
				createdAt: cur.recipe.createdAt ?? this.now(),
				updatedAt: this.now(),
			});
			await this.writeRecipe(s, recipe);
			return { id, name: recipe.name, source: 'library' as const, readOnly: false, recipe };
		});
	}

	/** A copy (of a built-in or library recipe) saved as a new library recipe. */
	async duplicate(id: string, name?: string): Promise<RecipeListEntry> {
		const src = await this.get(id);
		const copyName = (name ?? `${src.name} copy`).slice(0, 120);
		return this.create({ ...src, name: copyName, basedOn: src.id, id: src.id });
	}

	remove(id: string): Promise<{ removed: string }> {
		if (builtinStyleRecipe(id)) return Promise.reject(builtInReadOnly());
		return this.mutate(async (s) => {
			if (!s.recipes.has(id)) throw notFound(id);
			try {
				await unlink(join(this.dir, `${id}.json`));
				await fsyncDir(this.dir);
			} catch (e) {
				if ((e as { code?: string }).code !== 'ENOENT') throw e;
			}
			s.recipes.delete(id);
			s.index = { ...s.index, recipes: s.index.recipes.filter((e) => e.id !== id) };
			return { removed: id };
		});
	}
}
