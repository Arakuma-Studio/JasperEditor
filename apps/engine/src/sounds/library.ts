// The sound library index (spec 12 §2.1; wp-note "WP1.2"): `<appdir>/sounds/library.json`, kept in memory and written
// atomically (temporary file, fsync, rename: a crash leaves the old or the new index, never a torn one).
//
//   { format: 'jasper-sound-library', version: 1, snapshotHash, indexedAt, starterHash, roots: [...], packs: {...},
//     sounds: { <id>: SoundEntry }, files: { <location key>: { size, mtimeMs, fingerprint } } }
//
// `files` lets a rescan skip fingerprinting unchanged files (same size and modification time); analyses are cached
// per fingerprint under `sounds/cache/`, so a rescan only analyses new or changed files. The index is derived data:
// an unreadable file is moved aside (`library.json.corrupt-<time>`) and the library starts empty and asks for a
// rebuild (`needsIndex`); entries that no longer validate are dropped and also ask for a rebuild. Never throws on load.
import { createHash } from 'node:crypto';
import { rename } from 'node:fs/promises';
import { type SoundEntry, SoundEntrySchema, type SoundManifestPack, type SoundRoot } from '@jasper/api';
import { atomicWriteJson, exists, readJsonOrNull } from '../tools/fs.ts';

export const LIBRARY_FORMAT = 'jasper-sound-library';
export const LIBRARY_VERSION = 1;

export type FileRecord = { size: number; mtimeMs: number; fingerprint: string };

export type LibrarySnapshot = {
	snapshotHash: string;
	indexedAt: string | null;
	starterHash: string;
	roots: SoundRoot[];
	packs: Record<string, SoundManifestPack>;
	sounds: Record<string, SoundEntry>;
	files: Record<string, FileRecord>;
};

/**
 * Hash of what a proposal or a registration depends on: every sound's id, fingerprint, licence, attribution, types
 * and analysis version, in id order (16 hex digits of sha256).
 */
export function snapshotHashOf(sounds: Record<string, SoundEntry>): string {
	const h = createHash('sha256');
	for (const id of Object.keys(sounds).sort()) {
		const s = sounds[id]!;
		h.update(
			JSON.stringify([id, s.fingerprint, s.license, s.attribution, s.types, s.analysisVersion, s.title]),
		);
		h.update('\n');
	}
	return h.digest('hex').slice(0, 16);
}

const EMPTY_HASH = snapshotHashOf({});

function emptySnapshot(): LibrarySnapshot {
	return {
		snapshotHash: EMPTY_HASH,
		indexedAt: null,
		starterHash: '',
		roots: [],
		packs: {},
		sounds: {},
		files: {},
	};
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === 'object' && !Array.isArray(v);

export class SoundLibrary {
	private state: LibrarySnapshot | null = null;
	private chain: Promise<unknown> = Promise.resolve();
	/** The index was never written (no file). */
	private missing = false;
	/** The index file was unreadable and has been moved aside, or entries were dropped: a rebuild is due. */
	recovered = false;

	constructor(
		private readonly file: string,
		private readonly opts: {
			onChange?: (s: { snapshotHash: string; sounds: number }) => void;
			log?: (m: string) => void;
		} = {},
	) {}

	/** Loads the index once (later calls return the memory copy). */
	async load(): Promise<LibrarySnapshot> {
		if (this.state) return this.state;
		let raw: unknown = null;
		let unreadable = false;
		try {
			raw = await readJsonOrNull(this.file);
		} catch (e) {
			unreadable = true;
			this.opts.log?.(`sound library: index cannot be read (${(e as Error).message})`);
		}
		if (raw === null && !unreadable && !(await exists(this.file))) {
			this.missing = true;
			this.state = emptySnapshot();
			return this.state;
		}
		const ok =
			isRecord(raw) &&
			raw.format === LIBRARY_FORMAT &&
			raw.version === LIBRARY_VERSION &&
			isRecord(raw.sounds) &&
			isRecord(raw.files);
		if (!ok) {
			// Damaged, from another build or unreadable: keep it aside, start empty, rebuild.
			if (!unreadable) {
				const aside = `${this.file}.corrupt-${Date.now()}`;
				await rename(this.file, aside).catch(() => undefined);
				this.opts.log?.(`sound library: unreadable index moved to ${aside}; it will be rebuilt`);
			}
			this.recovered = true;
			this.state = emptySnapshot();
			return this.state;
		}
		const r = raw as Record<string, unknown>;
		const sounds: Record<string, SoundEntry> = {};
		let dropped = 0;
		for (const [id, v] of Object.entries(r.sounds as Record<string, unknown>)) {
			const p = SoundEntrySchema.safeParse(v);
			if (p.success && p.data.id === id) sounds[id] = p.data;
			else dropped++;
		}
		const files: Record<string, FileRecord> = {};
		for (const [k, v] of Object.entries(r.files as Record<string, unknown>)) {
			if (
				isRecord(v) &&
				typeof v.fingerprint === 'string' &&
				Number.isFinite(v.size) &&
				Number.isFinite(v.mtimeMs) &&
				k.length <= 8192
			)
				files[k] = { size: v.size as number, mtimeMs: v.mtimeMs as number, fingerprint: v.fingerprint };
		}
		if (dropped) {
			this.recovered = true;
			this.opts.log?.(`sound library: ${dropped} invalid entries dropped; the index will be rebuilt`);
		}
		this.state = {
			snapshotHash: snapshotHashOf(sounds),
			indexedAt: typeof r.indexedAt === 'string' ? r.indexedAt : null,
			starterHash: typeof r.starterHash === 'string' ? r.starterHash : '',
			roots: Array.isArray(r.roots) ? (r.roots as SoundRoot[]) : [],
			packs: isRecord(r.packs) ? (r.packs as Record<string, SoundManifestPack>) : {},
			sounds,
			files,
		};
		return this.state;
	}

	/** The index was never built, or was rebuilt empty after damage. */
	async neverIndexed(): Promise<boolean> {
		await this.load();
		return this.missing || this.recovered;
	}

	async snapshot(): Promise<LibrarySnapshot> {
		await this.chain.catch(() => undefined);
		return this.load();
	}

	async entries(): Promise<SoundEntry[]> {
		const s = await this.snapshot();
		return Object.keys(s.sounds)
			.sort()
			.map((id) => s.sounds[id]!);
	}

	async get(id: string): Promise<SoundEntry | null> {
		const s = await this.snapshot();
		return Object.hasOwn(s.sounds, id) ? s.sounds[id]! : null;
	}

	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.chain.catch(() => undefined).then(fn);
		this.chain = run;
		return run;
	}

	private async write(next: Omit<LibrarySnapshot, 'snapshotHash'>): Promise<LibrarySnapshot> {
		const snapshot: LibrarySnapshot = { ...next, snapshotHash: snapshotHashOf(next.sounds) };
		await atomicWriteJson(this.file, { format: LIBRARY_FORMAT, version: LIBRARY_VERSION, ...snapshot });
		this.state = snapshot;
		this.missing = false;
		this.recovered = false;
		this.opts.onChange?.({
			snapshotHash: snapshot.snapshotHash,
			sounds: Object.keys(snapshot.sounds).length,
		});
		return snapshot;
	}

	/** Replaces the index (serialized, atomic) and announces it. */
	commit(next: Omit<LibrarySnapshot, 'snapshotHash'>): Promise<LibrarySnapshot> {
		return this.serialize(() => this.write(next));
	}

	/**
	 * Replaces the index with what `make` returns, run in turn with the other writes (after a removal queued before
	 * it, so it can see the folder list that removal belongs to).
	 */
	commitFrom(make: () => Promise<Omit<LibrarySnapshot, 'snapshotHash'>>): Promise<LibrarySnapshot> {
		return this.serialize(async () => this.write(await make()));
	}

	/**
	 * Takes out the sounds (and file records) a predicate selects, and the named installed packs; returns how many
	 * sounds went.
	 */
	remove(
		pred: (e: SoundEntry) => boolean,
		fileKeyPrefixes: readonly string[],
		packIds: readonly string[] = [],
	): Promise<number> {
		return this.serialize(async () => {
			const s = await this.load();
			const packs: Record<string, SoundManifestPack> = {};
			for (const [id, p] of Object.entries(s.packs)) if (!packIds.includes(id)) packs[id] = p;
			const packsChanged = Object.keys(packs).length !== Object.keys(s.packs).length;
			const sounds: Record<string, SoundEntry> = {};
			let removed = 0;
			for (const [id, e] of Object.entries(s.sounds)) {
				if (pred(e)) removed++;
				else sounds[id] = e;
			}
			const files: Record<string, FileRecord> = {};
			for (const [k, v] of Object.entries(s.files))
				if (!fileKeyPrefixes.some((p) => k.startsWith(p))) files[k] = v;
			if (removed === 0 && !packsChanged && Object.keys(files).length === Object.keys(s.files).length)
				return 0;
			await this.write({ ...s, sounds, files, packs });
			return removed;
		});
	}
}
