// Spec 19 TL-054: the user look library, one JSON file per appdir, `<appdir>/presets/title-looks.json`, shared by every
// project, every editor window and agents, in its own file like the other preset libraries, so a build that does not know
// looks never rewrites them. Writes are serialized and atomic (same-directory temp file, fsync, rename, directory fsync);
// every change bumps `revision`. Entries are validated with the @jasper/project format; entries that no longer validate are
// kept aside in `invalid` and written back, never dropped; a file that is not JSON, or JSON this build cannot read as a
// library (`readLookLibrary`), is renamed to `….corrupt-<time>` (logged, and named by `list` as `movedAside`) before
// anything is written; a file of a newer version is read and never written.
import { randomBytes } from 'node:crypto';
import { rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
	buildLookBundle,
	CROCKFORD_ALPHABET,
	MAX_TITLE_LOOK_NAME,
	MAX_USER_LOOKS,
	parseLookFile,
	parseUserLook,
	readLookLibrary,
	USER_LOOK_LIBRARY_FORMAT,
	USER_LOOK_VERSION,
	type UserLook,
} from '@jasper/project';
import { atomicWriteJson, exists, fsyncDir, readJsonOrNull } from '../tools/fs.ts';
import { HttpError } from '../tools/reply.ts';

type LibraryFile = {
	format: typeof USER_LOOK_LIBRARY_FORMAT;
	version: number;
	revision: number;
	looks: UserLook[];
	invalid?: unknown[];
};

type LookInit = {
	name: string;
	recipe: unknown;
	tags?: string[] | undefined;
	category?: string | undefined;
	colorways?: unknown[] | undefined;
};

type LookPatch = { name?: string | undefined; tags?: string[] | undefined; category?: string | undefined };

function newId(): string {
	const bytes = randomBytes(16);
	let out = '';
	for (const b of bytes) out += CROCKFORD_ALPHABET[b & 31];
	return `ulk_${out}`;
}

const notFound = (id: string) => new HttpError(404, 'LOOK_NOT_FOUND', `Look not found: ${id}`);

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** `name`, or the first free `name (n)`. */
function freeName(s: LibraryFile, name: string): string {
	const taken = (n: string) => s.looks.some((l) => sameName(l.name, n));
	if (!taken(name)) return name;
	for (let i = 2; ; i++) {
		const suffix = ` (${i})`;
		const n = `${name.slice(0, MAX_TITLE_LOOK_NAME - suffix.length)}${suffix}`;
		if (!taken(n)) return n;
	}
}

export class UserLookLibrary {
	private state: LibraryFile | null = null;
	private newer = false;
	/** Where an unreadable library file was moved (reported by `list`). */
	private movedAside: string | null = null;
	/** Why an unreadable library file that could not be moved aside makes the library read-only. */
	private stuck: string | null = null;
	private chain: Promise<void> = Promise.resolve();

	constructor(
		private readonly file: string,
		private readonly opts: {
			now?: () => string;
			onChange?: (revision: number) => void;
			log?: (m: string) => void;
		} = {},
	) {}

	private now(): string {
		return this.opts.now?.() ?? new Date().toISOString();
	}

	private async load(): Promise<LibraryFile> {
		if (this.state) return this.state;
		const empty: LibraryFile = {
			format: USER_LOOK_LIBRARY_FORMAT,
			version: USER_LOOK_VERSION,
			revision: 0,
			looks: [],
		};
		const raw = await readJsonOrNull<unknown>(this.file);
		// Invalid JSON, or JSON this build cannot read as a library: moved aside, never overwritten by the next save.
		const read = raw === null ? null : readLookLibrary(raw);
		if (!read?.ok) {
			if (await exists(this.file)) {
				const why = read ? read.message : 'not JSON';
				const aside = `${this.file}.corrupt-${Date.now()}`;
				try {
					await rename(this.file, aside);
					await fsyncDir(dirname(this.file)).catch(() => undefined);
					this.movedAside = aside;
					this.opts.log?.(`title looks: unreadable library (${why}) moved to ${aside}`);
				} catch (e) {
					// It stays where it is, and nothing writes over it.
					this.stuck = `${why}; it could not be moved aside: ${(e as Error).message}`;
					this.opts.log?.(`title looks: unreadable library (${this.stuck})`);
				}
			}
			this.state = empty;
			return empty;
		}
		if (read.newer) {
			this.newer = true;
			this.opts.log?.('title looks: the library was written by a newer JasperEditor (read-only)');
		}
		const { looks, invalid } = read;
		if (invalid.length) this.opts.log?.(`title looks: ${invalid.length} invalid entries kept aside`);
		this.state = {
			...empty,
			version: read.version,
			revision: read.revision,
			looks,
			...(invalid.length ? { invalid } : {}),
		};
		return this.state;
	}

	/** Runs a mutation alone, persists it and announces the new revision. A failed write changes nothing. */
	private mutate<T>(fn: (s: LibraryFile) => T): Promise<T> {
		const run = this.chain.then(async () => {
			const s = await this.load();
			if (this.newer)
				throw new HttpError(
					409,
					'LOOK_LIBRARY_NEWER',
					'The look library was written by a newer JasperEditor and is read-only here',
				);
			if (this.stuck)
				throw new HttpError(
					409,
					'LOOK_LIBRARY_UNREADABLE',
					`The look library file is unreadable (${this.stuck})`,
				);
			const next = structuredClone(s);
			const out = fn(next);
			next.revision = s.revision + 1;
			await atomicWriteJson(this.file, next, true);
			this.state = next;
			this.opts.onChange?.(next.revision);
			return out;
		});
		this.chain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async list(): Promise<{ revision: number; readOnly: boolean; looks: UserLook[]; movedAside?: string }> {
		await this.chain;
		const s = await this.load();
		return structuredClone({
			revision: s.revision,
			readOnly: this.newer || this.stuck !== null,
			looks: s.looks,
			...(this.movedAside ? { movedAside: this.movedAside } : {}),
		});
	}

	async get(id: string): Promise<UserLook> {
		const l = (await this.list()).looks.find((x) => x.id === id);
		if (!l) throw notFound(id);
		return l;
	}

	private assertRoom(s: LibraryFile, n = 1): void {
		if (s.looks.length + n > MAX_USER_LOOKS)
			throw new HttpError(413, 'LOOK_LIBRARY_FULL', `The library holds at most ${MAX_USER_LOOKS} looks`);
	}

	private entry(init: LookInit, now: string): ReturnType<typeof parseUserLook> {
		return parseUserLook({
			version: USER_LOOK_VERSION,
			id: newId(),
			name: init.name,
			...(init.tags?.length ? { tags: init.tags } : {}),
			...(init.category ? { category: init.category } : {}),
			...(init.colorways?.length ? { colorways: init.colorways } : {}),
			recipe: init.recipe,
			createdAt: now,
			updatedAt: now,
		});
	}

	/** Save Look: a new entry, with a fresh id and timestamps. */
	save(init: LookInit): Promise<UserLook> {
		return this.mutate((s) => {
			this.assertRoom(s);
			const r = this.entry(init, this.now());
			if (!r.ok) throw new HttpError(400, 'LOOK_INVALID', r.message);
			if (s.looks.some((l) => sameName(l.name, r.look.name)))
				throw new HttpError(409, 'LOOK_NAME_TAKEN', `A look named "${r.look.name}" already exists`);
			s.looks.push(r.look);
			return r.look;
		});
	}

	update(id: string, patch: LookPatch): Promise<UserLook> {
		return this.mutate((s) => {
			const l = s.looks.find((x) => x.id === id);
			if (!l) throw notFound(id);
			if (patch.name !== undefined) {
				const name = patch.name.trim();
				if (s.looks.some((x) => x.id !== id && sameName(x.name, name)))
					throw new HttpError(409, 'LOOK_NAME_TAKEN', `A look named "${name}" already exists`);
				l.name = name;
			}
			if (patch.tags !== undefined) {
				if (patch.tags.length) l.tags = patch.tags;
				else delete l.tags;
			}
			if (patch.category !== undefined) {
				if (patch.category) l.category = patch.category;
				else delete l.category;
			}
			l.updatedAt = this.now();
			return l;
		});
	}

	remove(id: string): Promise<{ removed: string }> {
		return this.mutate((s) => {
			if (!s.looks.some((x) => x.id === id)) throw notFound(id);
			s.looks = s.looks.filter((x) => x.id !== id);
			return { removed: id };
		});
	}

	/** Import: every valid look of the file gets a new id, and a name that is free. Bad entries are reported by index. */
	import(file: unknown): Promise<{ looks: UserLook[]; errors: { index: number; message: string }[] }> {
		const read = parseLookFile(file);
		if (!read.ok) return Promise.reject(new HttpError(400, 'LOOK_INVALID', read.message));
		return this.mutate((s) => {
			const now = this.now();
			const looks: UserLook[] = [];
			const errors: { index: number; message: string }[] = [];
			read.entries.forEach((raw, index) => {
				if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
					errors.push({ index, message: 'not a JSON object' });
					return;
				}
				const given = raw as Record<string, unknown>;
				const version = given.version ?? USER_LOOK_VERSION;
				const r = parseUserLook({
					...given,
					version,
					id: newId(),
					createdAt: typeof given.createdAt === 'string' ? given.createdAt : now,
					updatedAt: now,
				});
				if (!r.ok) {
					errors.push({ index, message: r.message });
					return;
				}
				this.assertRoom(s);
				r.look.name = freeName(s, r.look.name);
				s.looks.push(r.look);
				looks.push(r.look);
			});
			if (!looks.length)
				throw new HttpError(400, 'LOOK_INVALID', errors[0]?.message ?? 'The file holds no looks');
			return { looks, errors };
		});
	}

	/** Export: the chosen looks (default all) as a file `import` reads back. */
	async export(ids?: readonly string[]): Promise<ReturnType<typeof buildLookBundle>> {
		const { looks } = await this.list();
		if (!ids) return buildLookBundle(looks);
		const chosen = ids.map((id) => {
			const l = looks.find((x) => x.id === id);
			if (!l) throw notFound(id);
			return l;
		});
		return buildLookBundle(chosen);
	}
}
