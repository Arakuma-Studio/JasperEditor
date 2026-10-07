// The roto matte store (`<appdir>/cache/roto/`), content-addressed so undo, redo, corrections and re-propagation
// reuse every frame whose inputs did not change:
//
// - `pool/seg/<chainKey>.seg`: a frame's segmentation (binary matte, Refine Edge band, colour models). The chain key
//   of a frame hashes everything its segmentation depends on: the media, the segmentation settings and model, and
//   the strokes / boxes of every frame from the base frame out to it (worker/run.ts `chainKeys`) — a correction
//   stroke on frame 50 changes the keys of frames 50… only.
// - `pool/png/<matteKey>.png`: a frame's final 8-bit matte (edge refinement applied); matteKey = chain key + edge
//   settings (faces: per frame of the tracked span).
// - `sets/<key>/`: a computed roto (`RotoResult.key`): `set.json` and frame n's matte as `<n>.png` (a hard link to
//   the pool file, a copy where links are not possible). Served at `GET /mg/roto/<key>?n=<n>` (signable for
//   headless renders).
//
// Writes are atomic (temp file + rename). The cache registry (cache/layout.ts kind `roto`) cleans sets that no
// project references and the pool (a reuse accelerator: losing it only costs recomputation).
import { createHash } from 'node:crypto';
import { copyFile, link, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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

const KEY_RE = /^[a-f0-9]{32}$/;

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
		return join(this.root, 'pool', 'seg', `${chainKey}.seg`);
	}
	pngPath(matteKey: string): string {
		return join(this.root, 'pool', 'png', `${matteKey}.png`);
	}
	setDir(key: string): string {
		return join(this.root, 'sets', key);
	}
	setPath(key: string): string {
		return join(this.setDir(key), 'set.json');
	}
	setFramePath(key: string, n: number): string {
		return join(this.setDir(key), `${n}.png`);
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
		if (s?.v !== 1 || !Array.isArray(s.frames)) return null;
		this.sets.set(key, s);
		if (this.sets.size > 256) this.sets.delete(this.sets.keys().next().value!);
		return s;
	}

	/**
	 * Publishes a set: links every frame's pool matte into `sets/<key>/` (frames already there are kept), then writes
	 * `set.json` (last, atomically: readers never see a set with missing frames).
	 */
	async writeSet(s: RotoSet): Promise<void> {
		const dir = this.setDir(s.key);
		await mkdir(dir, { recursive: true });
		for (let n = s.start; n <= s.end; n++) {
			const mk = s.frames[n - s.start]!;
			const dest = this.setFramePath(s.key, n);
			const tmp = `${dest}.${process.pid}.tmp`;
			await rm(tmp, { force: true });
			await link(this.pngPath(mk), tmp).catch(() => copyFile(this.pngPath(mk), tmp));
			await rename(tmp, dest);
		}
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
		const p = this.setFramePath(key, n);
		return (await this.has(p)) ? p : null;
	}
}
