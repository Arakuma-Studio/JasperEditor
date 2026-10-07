// The roto matte store (`<appdir>/cache/roto/`), content-addressed so undo, redo, corrections and re-propagation
// reuse every frame whose inputs did not change:
//
// - `seg/<chainKey>.seg`: a frame's segmentation (binary matte, Refine Edge band, colour models). The chain key of a
//   frame hashes everything its segmentation depends on: the media, the segmentation settings and model, and the
//   strokes / boxes of every frame from the base frame out to it (`chainKeys`) — a correction stroke on frame 50
//   changes the keys of frames 50… only.
// - `png/<matteKey>.png`: the frame's final 8-bit matte (edge refinement applied); matteKey = chain key + edge
//   settings. Faces rotos write mattes keyed per frame by their inputs.
// - `set/<key>.json`: a computed roto (`RotoResult.key`): frame → matte key over [start, end] and the size. The
//   engine serves frame n of a set at `GET /roto/<key>?n=<n>` (signable for headless renders).
//
// Writes are atomic (temp file + rename). The cache layer (cache/layout.ts kind `roto`) cleans sets, and the
// frames only they reference, like other caches; saved projects keep the sets of their rotos.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type RotoSet = {
	v: 1;
	key: string;
	width: number;
	height: number;
	start: number;
	end: number;
	/** Matte key of each frame, index = frame − start. */
	frames: string[];
	/** Media key the set belongs to (cache refs, diagnostics). */
	mediaKey: string;
	createdAt: string;
};

const KEY_RE = /^[a-f0-9]{16,64}$/;

export function isRotoKey(k: string): boolean {
	return KEY_RE.test(k);
}

export function hashKey(...parts: unknown[]): string {
	const h = createHash('sha256');
	for (const p of parts) h.update(typeof p === 'string' ? p : JSON.stringify(p)).update('\u0000');
	return h.digest('hex').slice(0, 32);
}

export class RotoStore {
	private readonly sets = new Map<string, RotoSet>();

	constructor(readonly root: string) {}

	segPath(chainKey: string): string {
		return join(this.root, 'seg', `${chainKey}.seg`);
	}
	pngPath(matteKey: string): string {
		return join(this.root, 'png', `${matteKey}.png`);
	}
	setPath(key: string): string {
		return join(this.root, 'set', `${key}.json`);
	}

	async has(path: string): Promise<boolean> {
		return !!(await stat(path).catch(() => null))?.isFile();
	}

	async write(path: string, data: Uint8Array | string): Promise<void> {
		await mkdir(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		await writeFile(tmp, data);
		await rename(tmp, path);
	}

	async readSet(key: string): Promise<RotoSet | null> {
		if (!isRotoKey(key)) return null;
		const hit = this.sets.get(key);
		if (hit) return hit;
		const s = await readFile(this.setPath(key), 'utf8')
			.then((t) => JSON.parse(t) as RotoSet)
			.catch(() => null);
		if (!s || s.v !== 1 || !Array.isArray(s.frames)) return null;
		this.sets.set(key, s);
		if (this.sets.size > 256) this.sets.delete(this.sets.keys().next().value!);
		return s;
	}

	async writeSet(s: RotoSet): Promise<void> {
		await this.write(this.setPath(s.key), JSON.stringify(s));
		this.sets.set(s.key, s);
	}

	/** Forget cached set metadata (after the cache layer removed files). */
	forget(key?: string): void {
		if (key) this.sets.delete(key);
		else this.sets.clear();
	}

	/** Path of frame `n`'s matte in set `key` (null when the set or the frame is not there). */
	async framePath(key: string, n: number): Promise<string | null> {
		const s = await this.readSet(key);
		if (!s || !Number.isInteger(n) || n < s.start || n > s.end) return null;
		const mk = s.frames[n - s.start];
		if (!mk || !isRotoKey(mk)) return null;
		const p = this.pngPath(mk);
		return (await this.has(p)) ? p : null;
	}
}
