// Cached CLAP embeddings (spec 12 P6-E14, WP-E9): one binary file per model revision and embedding recipe, keyed by
// what was embedded — a sound's content fingerprint and the range of it (`keyOf`) — so a renamed or moved file keeps
// its embedding, a changed file (new fingerprint) or a take whose range moved gets a new one, and an upgrade of the
// recipe (`EMBED_RECIPE`) or of the model starts a new file. Written atomically (temp file, fsync, rename); an unreadable
// file is set aside as `<file>.corrupt-<time>` and the embeddings are computed again (AGENTS.md §0.4: nothing a user
// made is lost; these are derived data).
//
// Format: "JCLAPEM1", u32 dim, u32 count, then per record u16 key length, the UTF-8 key, dim × f32 (little-endian).
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWriteFile } from '../../tools/fs.ts';
import { CLAP_EMBED_DIM } from './frontend.ts';

const MAGIC = 'JCLAPEM1';
/** Bump when what an embedding is computed from changes (windows, front end): old files are no longer read. */
export const EMBED_RECIPE = 1;
/** Most records one file holds (a library of 100 000 sounds and takes ≈ 200 MB); past it, new records are not kept. */
const MAX_RECORDS = 100_000;
const MAX_FILE_BYTES = MAX_RECORDS * (2 + 256 + CLAP_EMBED_DIM * 4) + 64;

/** The cache key of a range of a sound's content (`whole`: the sound's whole-sound embedding). */
export function keyOf(fingerprint: string, range: 'whole' | { startSec: number; endSec: number }): string {
	if (range === 'whole') return `${fingerprint}|w`;
	return `${fingerprint}|${range.startSec.toFixed(4)}-${range.endSec.toFixed(4)}`;
}

export class EmbeddingStore {
	private map: Map<string, Float32Array> | null = null;
	private loading: Promise<Map<string, Float32Array>> | null = null;
	private dirty = false;
	/** Changes with every set: callers cache what they derive from the store per version. */
	version = 0;

	constructor(
		readonly file: string,
		private readonly log?: (m: string) => void,
	) {}

	async load(): Promise<Map<string, Float32Array>> {
		if (this.map) return this.map;
		this.loading ??= this.read().then((m) => {
			this.map = m;
			return m;
		});
		return this.loading;
	}

	private async read(): Promise<Map<string, Float32Array>> {
		const map = new Map<string, Float32Array>();
		const st = await stat(this.file).catch(() => null);
		if (!st) return map;
		try {
			if (!st.isFile() || st.size > MAX_FILE_BYTES) throw new Error('not a cache file of a sane size');
			const buf = await readFile(this.file);
			if (buf.byteLength < 16 || buf.toString('latin1', 0, 8) !== MAGIC) throw new Error('bad header');
			const dim = buf.readUInt32LE(8);
			const count = buf.readUInt32LE(12);
			if (dim !== CLAP_EMBED_DIM || count > MAX_RECORDS) throw new Error('bad dimensions');
			let o = 16;
			for (let i = 0; i < count; i++) {
				if (o + 2 > buf.byteLength) throw new Error('truncated');
				const len = buf.readUInt16LE(o);
				o += 2;
				if (len === 0 || len > 256 || o + len + dim * 4 > buf.byteLength) throw new Error('truncated');
				const key = buf.toString('utf8', o, o + len);
				o += len;
				const v = new Float32Array(dim);
				for (let k = 0; k < dim; k++) {
					const x = buf.readFloatLE(o + k * 4);
					if (!Number.isFinite(x)) throw new Error('non-finite value');
					v[k] = x;
				}
				o += dim * 4;
				map.set(key, v);
			}
			if (o !== buf.byteLength) throw new Error('trailing bytes');
		} catch (e) {
			const aside = `${this.file}.corrupt-${Date.now()}`;
			this.log?.(`sound embeddings: ${this.file} is unreadable (${(e as Error).message}); kept as ${aside}`);
			await rename(this.file, aside).catch(() => rm(this.file, { force: true }));
			return new Map();
		}
		return map;
	}

	async get(key: string): Promise<Float32Array | undefined> {
		return (await this.load()).get(key);
	}

	async has(key: string): Promise<boolean> {
		return (await this.load()).has(key);
	}

	/** Remembers an embedding (in memory until `flush`). Refused past MAX_RECORDS. */
	async set(key: string, v: Float32Array): Promise<boolean> {
		const map = await this.load();
		if (v.length !== CLAP_EMBED_DIM || Buffer.byteLength(key) > 256) return false;
		if (!map.has(key) && map.size >= MAX_RECORDS) return false;
		map.set(key, v);
		this.dirty = true;
		this.version++;
		return true;
	}

	get size(): number {
		return this.map?.size ?? 0;
	}

	/** Writes the file when something changed; `keep` (when given) drops every other record first. */
	async flush(keep?: (key: string) => boolean): Promise<void> {
		const map = await this.load();
		if (keep)
			for (const k of [...map.keys()])
				if (!keep(k)) {
					map.delete(k);
					this.dirty = true;
					this.version++;
				}
		if (!this.dirty) return;
		const parts: Buffer[] = [];
		const head = Buffer.alloc(16);
		head.write(MAGIC, 0, 'latin1');
		head.writeUInt32LE(CLAP_EMBED_DIM, 8);
		head.writeUInt32LE(map.size, 12);
		parts.push(head);
		for (const [k, v] of map) {
			const kb = Buffer.from(k, 'utf8');
			const rec = Buffer.alloc(2 + kb.byteLength + v.length * 4);
			rec.writeUInt16LE(kb.byteLength, 0);
			kb.copy(rec, 2);
			for (let i = 0; i < v.length; i++) rec.writeFloatLE(v[i]!, 2 + kb.byteLength + i * 4);
			parts.push(rec);
		}
		await mkdir(dirname(this.file), { recursive: true });
		await atomicWriteFile(this.file, Buffer.concat(parts));
		this.dirty = false;
	}

	/** Deletes the file and forgets everything. */
	async clear(): Promise<number> {
		const n = (await this.load()).size;
		this.map = new Map();
		this.loading = null;
		this.dirty = false;
		this.version++;
		await rm(this.file, { force: true });
		return n;
	}
}
