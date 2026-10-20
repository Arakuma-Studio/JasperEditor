// Small JSON caches of Sound Design's media analyses (wp-note "Phase 6 → WP6.2"): picture motion, beats and shot
// changes, under `<appdir>/sounds/analysis/<kind>/`. Keys are content fingerprints (a hash of what was measured and
// how), so an entry never goes stale: an edit or a changed file simply asks for another key. Writes are atomic; the
// newest `max` entries are kept (oldest pruned after a write); a damaged or foreign file reads as a miss. Never throws
// on reads; a failed write is logged by the caller and only costs a re-analysis.
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import { atomicWriteJson, readJsonOrNull } from '../tools/fs.ts';

const KEY = /^[0-9a-z][0-9a-z_.-]{0,159}$/;

export class AnalysisCache<T> {
	private readonly memory = new Map<string, T>();
	private writes = 0;

	constructor(
		readonly dir: string,
		private readonly schema: z.ZodType<T>,
		private readonly opts: { max: number; memory?: number } = { max: 500 },
	) {}

	private file(key: string): string | null {
		return KEY.test(key) ? join(this.dir, `${key}.json`) : null;
	}

	async get(key: string): Promise<T | null> {
		const hit = this.memory.get(key);
		if (hit !== undefined) {
			this.memory.delete(key);
			this.memory.set(key, hit);
			return hit;
		}
		const f = this.file(key);
		if (!f) return null;
		let raw: unknown;
		try {
			raw = await readJsonOrNull(f);
		} catch {
			return null;
		}
		if (raw === null) return null;
		const r = this.schema.safeParse(raw);
		if (!r.success) return null;
		this.remember(key, r.data);
		return r.data;
	}

	/** Keys of the entries on disk whose name starts with `prefix`. */
	async keys(prefix: string): Promise<string[]> {
		try {
			return (await readdir(this.dir))
				.filter((n) => n.endsWith('.json') && n.startsWith(prefix))
				.map((n) => n.slice(0, -5));
		} catch {
			return [];
		}
	}

	async put(key: string, value: T): Promise<void> {
		const f = this.file(key);
		if (!f) return;
		this.remember(key, value);
		await mkdir(this.dir, { recursive: true });
		await atomicWriteJson(f, value);
		if (++this.writes % 16 === 1) await this.prune();
	}

	private remember(key: string, value: T): void {
		this.memory.set(key, value);
		const max = this.opts.memory ?? 16;
		while (this.memory.size > max) this.memory.delete(this.memory.keys().next().value!);
	}

	/** Keeps the newest `max` entries. */
	async prune(): Promise<void> {
		let names: string[];
		try {
			names = (await readdir(this.dir)).filter((n) => n.endsWith('.json'));
		} catch {
			return;
		}
		if (names.length <= this.opts.max) return;
		const dated = await Promise.all(
			names.map(async (n) => {
				try {
					return { n, t: (await stat(join(this.dir, n))).mtimeMs };
				} catch {
					return { n, t: 0 };
				}
			}),
		);
		dated.sort((a, b) => b.t - a.t);
		for (const { n } of dated.slice(this.opts.max)) {
			this.memory.delete(n.slice(0, -5));
			await rm(join(this.dir, n), { force: true });
		}
	}
}
