// The user's transcript cleanup presets (spec 14 TC-030; docs/wp-notes/transcript-cleanup.md "Engine"): one JSON
// file per appdir, `<appdir>/presets/cleanup-presets.json`, shared by every project, editor window and agent, like
// the effect preset library. Writes are serialized and atomic (temp file, fsync, rename, directory fsync); every
// change bumps `revision`. Entries are validated with @jasper/project's `CleanupPresetSchema`; entries that no longer
// validate (a hand-edited file) are kept aside in `invalid` and written back, never dropped; an unreadable file is
// renamed `cleanup-presets.json.corrupt-<time>` before starting empty. Built-ins (`builtin.*`) are never stored.
import { randomBytes } from 'node:crypto';
import { rename } from 'node:fs/promises';
import {
	type CleanupOverrides,
	type CleanupPreset,
	CleanupPresetSchema,
	CROCKFORD_ALPHABET,
} from '@jasper/project';
import { atomicWriteJson, exists, readJsonOrNull } from '../tools/fs.ts';
import { HttpError } from '../tools/reply.ts';

/** Most user presets kept. */
export const MAX_CLEANUP_PRESETS = 500;

type LibraryFile = {
	format: 'jasper-cleanup-preset-library';
	version: 1;
	revision: number;
	presets: CleanupPreset[];
	invalid?: unknown[];
};

function newId(): string {
	let out = '';
	for (const b of randomBytes(16)) out += CROCKFORD_ALPHABET[b & 31];
	return `cup_${out}`;
}

const notFound = (id: string) =>
	new HttpError(
		404,
		'PRESET_NOT_FOUND',
		id.startsWith('builtin.') ? 'Built-in cleanup presets are read-only' : `Cleanup preset not found: ${id}`,
	);

export type CleanupPresetInput = {
	name: string;
	description?: string;
	basedOn?: 'builtin.fast' | 'builtin.natural';
	settings: CleanupOverrides;
};

export class CleanupPresetLibrary {
	private state: LibraryFile | null = null;
	private chain: Promise<void> = Promise.resolve();

	constructor(
		private readonly file: string,
		private readonly opts: { onChange?: (revision: number) => void; log?: (m: string) => void } = {},
	) {}

	private async load(): Promise<LibraryFile> {
		if (this.state) return this.state;
		const empty: LibraryFile = {
			format: 'jasper-cleanup-preset-library',
			version: 1,
			revision: 0,
			presets: [],
		};
		const raw = await readJsonOrNull<Record<string, unknown>>(this.file);
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			if (await exists(this.file)) {
				const aside = `${this.file}.corrupt-${Date.now()}`;
				await rename(this.file, aside).catch(() => undefined);
				this.opts.log?.(`cleanup presets: unreadable library moved to ${aside}`);
			}
			this.state = empty;
			return empty;
		}
		const presets: CleanupPreset[] = [];
		const invalid: unknown[] = Array.isArray(raw.invalid) ? [...raw.invalid] : [];
		const ids = new Set<string>();
		for (const p of Array.isArray(raw.presets) ? raw.presets : []) {
			const r = CleanupPresetSchema.safeParse(p);
			if (r.success && !r.data.id.startsWith('builtin.') && !ids.has(r.data.id)) {
				ids.add(r.data.id);
				const { builtIn: _b, ...rest } = r.data;
				presets.push(rest);
			} else invalid.push(p);
		}
		if (invalid.length) this.opts.log?.(`cleanup presets: ${invalid.length} invalid entries kept aside`);
		this.state = {
			...empty,
			revision:
				typeof raw.revision === 'number' && Number.isInteger(raw.revision) && raw.revision >= 0
					? raw.revision
					: 0,
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
		this.chain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async list(): Promise<{ revision: number; presets: CleanupPreset[] }> {
		await this.chain;
		const s = await this.load();
		return structuredClone({ revision: s.revision, presets: s.presets });
	}

	async get(id: string): Promise<CleanupPreset> {
		const p = (await this.list()).presets.find((x) => x.id === id);
		if (!p) throw notFound(id);
		return p;
	}

	create(input: CleanupPresetInput): Promise<CleanupPreset> {
		return this.mutate((s) => {
			if (s.presets.length >= MAX_CLEANUP_PRESETS)
				throw new HttpError(409, 'LIMIT_REACHED', `At most ${MAX_CLEANUP_PRESETS} cleanup presets`);
			const preset = CleanupPresetSchema.parse({
				format: 'jasper-cleanup-preset',
				version: 1,
				id: newId(),
				name: input.name,
				...(input.description !== undefined ? { description: input.description } : {}),
				...(input.basedOn ? { basedOn: input.basedOn } : {}),
				settings: input.settings,
			});
			s.presets.push(preset);
			return preset;
		});
	}

	update(id: string, patch: Partial<CleanupPresetInput>): Promise<CleanupPreset> {
		return this.mutate((s) => {
			const i = s.presets.findIndex((p) => p.id === id);
			if (i < 0) throw notFound(id);
			const next = CleanupPresetSchema.parse({
				...s.presets[i]!,
				...(patch.name !== undefined ? { name: patch.name } : {}),
				...(patch.description !== undefined ? { description: patch.description } : {}),
				...(patch.basedOn !== undefined ? { basedOn: patch.basedOn } : {}),
				...(patch.settings !== undefined ? { settings: patch.settings } : {}),
			});
			s.presets[i] = next;
			return next;
		});
	}

	remove(id: string): Promise<{ removed: string }> {
		return this.mutate((s) => {
			const i = s.presets.findIndex((p) => p.id === id);
			if (i < 0) throw notFound(id);
			s.presets.splice(i, 1);
			return { removed: id };
		});
	}
}
