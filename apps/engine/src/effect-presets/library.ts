// The user effect preset library (S03:FX-030, AGT-020): one JSON file per appdir,
// `<appdir>/presets/effect-presets.json`, shared by every project, every editor window and agents (jasper-mcp).
// Writes are serialized and atomic (tmp + fsync + rename); every change bumps `revision`. Entries are validated
// with the @jasper/project preset schema; unknown fields and unknown effect ids are kept as they are. Entries that
// no longer validate (hand-edited file) are kept aside in `invalid` and written back, never silently dropped; an
// unreadable file is renamed to `effect-presets.json.corrupt-<time>` before starting empty.
import { randomBytes } from 'node:crypto';
import { rename } from 'node:fs/promises';
import {
	CROCKFORD_ALPHABET,
	type EffectPreset,
	type EffectPresetFolder,
	EffectPresetFolderSchema,
	type EffectPresetType,
	parseEffectPreset,
	parsePresetFile,
} from '@jasper/project';
import { atomicWriteJson, exists, readJsonOrNull } from '../tools/fs.ts';
import { HttpError } from '../tools/reply.ts';

type LibraryFile = {
	format: 'jasper-effect-preset-library';
	version: 1;
	revision: number;
	folders: EffectPresetFolder[];
	presets: EffectPreset[];
	invalid?: unknown[];
};

type PresetPatch = {
	name?: string;
	description?: string;
	type?: EffectPresetType;
	folderId?: string | null;
};

function newId(prefix: string): string {
	const bytes = randomBytes(16);
	let out = '';
	for (const b of bytes) out += CROCKFORD_ALPHABET[b & 31];
	return `${prefix}_${out}`;
}

const notFound = (what: string, id: string) =>
	new HttpError(
		404,
		'PRESET_NOT_FOUND',
		id.startsWith('builtin.') ? 'Built-in presets are read-only' : `${what} not found: ${id}`,
	);

export class EffectPresetLibrary {
	private state: LibraryFile | null = null;
	private chain: Promise<unknown> = Promise.resolve();

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
			format: 'jasper-effect-preset-library',
			version: 1,
			revision: 0,
			folders: [],
			presets: [],
		};
		const raw = await readJsonOrNull<Record<string, unknown>>(this.file);
		if (!raw) {
			if (await exists(this.file)) {
				const aside = `${this.file}.corrupt-${Date.now()}`;
				await rename(this.file, aside).catch(() => undefined);
				this.opts.log?.(`effect presets: unreadable library moved to ${aside}`);
			}
			this.state = empty;
			return empty;
		}
		const presets: EffectPreset[] = [];
		const folders: EffectPresetFolder[] = [];
		const invalid: unknown[] = Array.isArray(raw.invalid) ? [...raw.invalid] : [];
		for (const p of Array.isArray(raw.presets) ? raw.presets : []) {
			const r = parseEffectPreset(p);
			if (r.ok) presets.push(r.preset);
			else invalid.push(p);
		}
		for (const f of Array.isArray(raw.folders) ? raw.folders : []) {
			const r = EffectPresetFolderSchema.safeParse(f);
			if (r.success) folders.push(r.data as EffectPresetFolder);
			else invalid.push(f);
		}
		if (invalid.length) this.opts.log?.(`effect presets: ${invalid.length} invalid entries kept aside`);
		this.state = {
			...empty,
			revision: typeof raw.revision === 'number' && Number.isInteger(raw.revision) ? raw.revision : 0,
			folders,
			presets,
			...(invalid.length ? { invalid } : {}),
		};
		return this.state;
	}

	/** Runs a mutation alone, persists it and announces the new revision. */
	private mutate<T>(fn: (s: LibraryFile) => T): Promise<T> {
		const run = this.chain.then(async () => {
			const s = await this.load();
			const next = structuredClone(s);
			const out = fn(next);
			next.revision = s.revision + 1;
			await atomicWriteJson(this.file, next, true);
			this.state = next;
			this.opts.onChange?.(next.revision);
			return out;
		});
		this.chain = run.catch(() => undefined);
		return run;
	}

	async list(): Promise<{ revision: number; folders: EffectPresetFolder[]; presets: EffectPreset[] }> {
		await this.chain;
		const s = await this.load();
		return structuredClone({ revision: s.revision, folders: s.folders, presets: s.presets });
	}

	async get(id: string): Promise<EffectPreset> {
		const p = (await this.list()).presets.find((x) => x.id === id);
		if (!p) throw notFound('Preset', id);
		return p;
	}

	private assertFolder(s: LibraryFile, id: string | null | undefined): void {
		if (id && !s.folders.some((f) => f.id === id)) throw notFound('Preset bin', id);
	}

	/** Stores a new preset (fresh id and timestamps; a copy of a built-in becomes a user preset). */
	create(raw: Record<string, unknown>, folderId?: string | null): Promise<EffectPreset> {
		return this.mutate((s) => {
			const now = this.now();
			const { builtIn: _b, category: _c, ...rest } = raw;
			const candidate = { ...rest, id: newId('fxp'), createdAt: now, updatedAt: now };
			if (folderId !== undefined) (candidate as Record<string, unknown>).folderId = folderId;
			const r = parseEffectPreset(candidate);
			if (!r.ok) throw new HttpError(400, 'PRESET_INVALID', r.message);
			this.assertFolder(s, r.preset.folderId);
			s.presets.push(r.preset);
			return r.preset;
		});
	}

	update(id: string, patch: PresetPatch): Promise<EffectPreset> {
		return this.mutate((s) => {
			const p = s.presets.find((x) => x.id === id);
			if (!p) throw notFound('Preset', id);
			if (patch.folderId !== undefined) this.assertFolder(s, patch.folderId);
			if (patch.name !== undefined) p.name = patch.name.trim();
			if (patch.type !== undefined) p.type = patch.type;
			if (patch.description !== undefined) {
				const d = patch.description.trim();
				if (d) p.description = d;
				else delete p.description;
			}
			if (patch.folderId !== undefined) {
				if (patch.folderId) p.folderId = patch.folderId;
				else delete p.folderId;
			}
			p.updatedAt = this.now();
			return p;
		});
	}

	remove(id: string): Promise<{ removedPresets: string[]; removedFolders: string[] }> {
		return this.mutate((s) => {
			if (!s.presets.some((x) => x.id === id)) throw notFound('Preset', id);
			s.presets = s.presets.filter((x) => x.id !== id);
			return { removedPresets: [id], removedFolders: [] };
		});
	}

	createFolder(name: string, parentId?: string | null): Promise<EffectPresetFolder> {
		return this.mutate((s) => {
			this.assertFolder(s, parentId);
			const f: EffectPresetFolder = {
				id: newId('fxb'),
				name: name.trim(),
				...(parentId ? { parentId } : {}),
			};
			s.folders.push(f);
			return f;
		});
	}

	updateFolder(id: string, patch: { name?: string; parentId?: string | null }): Promise<EffectPresetFolder> {
		return this.mutate((s) => {
			const f = s.folders.find((x) => x.id === id);
			if (!f) throw notFound('Preset bin', id);
			if (patch.parentId !== undefined) {
				this.assertFolder(s, patch.parentId);
				// No cycles: the new parent must not be the bin itself or inside it.
				for (let p = patch.parentId ?? null; p; p = s.folders.find((x) => x.id === p)?.parentId ?? null)
					if (p === id) throw new HttpError(400, 'VALIDATION_FAILED', 'A bin cannot move into itself');
				if (patch.parentId) f.parentId = patch.parentId;
				else delete f.parentId;
			}
			if (patch.name !== undefined) f.name = patch.name.trim();
			return f;
		});
	}

	/** Deletes a bin with its sub-bins and every preset inside them. */
	removeFolder(id: string): Promise<{ removedPresets: string[]; removedFolders: string[] }> {
		return this.mutate((s) => {
			if (!s.folders.some((x) => x.id === id)) throw notFound('Preset bin', id);
			const gone = new Set([id]);
			for (let grew = true; grew; ) {
				grew = false;
				for (const f of s.folders)
					if (f.parentId && gone.has(f.parentId) && !gone.has(f.id)) {
						gone.add(f.id);
						grew = true;
					}
			}
			const removedPresets = s.presets.filter((p) => p.folderId && gone.has(p.folderId)).map((p) => p.id);
			s.folders = s.folders.filter((f) => !gone.has(f.id));
			s.presets = s.presets.filter((p) => !removedPresets.includes(p.id));
			return { removedPresets, removedFolders: [...gone] };
		});
	}

	/** Import…: every valid preset of the file gets a new id; the file's bins come along under `folderId`. */
	import(
		file: unknown,
		folderId?: string | null,
	): Promise<{
		presets: EffectPreset[];
		folders: EffectPresetFolder[];
		errors: { index: number; message: string }[];
	}> {
		const read = parsePresetFile(file);
		if (!read.ok) return Promise.reject(new HttpError(400, 'PRESET_INVALID', read.message));
		return this.mutate((s) => {
			this.assertFolder(s, folderId);
			const now = this.now();
			const folderMap = new Map<string, string>();
			const folders: EffectPresetFolder[] = [];
			// Parents first (a bin's parent may come later in the file).
			const pending = [...read.folders];
			while (pending.length) {
				const i = pending.findIndex(
					(f) => !f.parentId || folderMap.has(f.parentId) || !read.folders.some((x) => x.id === f.parentId),
				);
				const f = pending.splice(Math.max(0, i), 1)[0]!;
				const parent = f.parentId ? (folderMap.get(f.parentId) ?? folderId ?? null) : (folderId ?? null);
				const nf: EffectPresetFolder = {
					id: newId('fxb'),
					name: f.name,
					...(parent ? { parentId: parent } : {}),
				};
				folderMap.set(f.id, nf.id);
				folders.push(nf);
			}
			const presets: EffectPreset[] = [];
			const errors: { index: number; message: string }[] = [];
			read.presets.forEach((raw, index) => {
				if (!raw || typeof raw !== 'object') {
					errors.push({ index, message: 'not a JSON object' });
					return;
				}
				const { builtIn: _b, category: _c, ...rest } = raw as Record<string, unknown>;
				const target =
					(typeof rest.folderId === 'string' ? folderMap.get(rest.folderId) : undefined) ?? folderId ?? null;
				const r = parseEffectPreset({
					...rest,
					id: newId('fxp'),
					folderId: target,
					createdAt: typeof rest.createdAt === 'string' ? rest.createdAt : now,
					updatedAt: now,
				});
				if (!r.ok) errors.push({ index, message: r.message });
				else presets.push(r.preset);
			});
			if (!presets.length)
				throw new HttpError(400, 'PRESET_INVALID', errors[0]?.message ?? 'The file holds no presets');
			s.folders.push(...folders);
			s.presets.push(...presets);
			return { presets, folders, errors };
		});
	}
}
