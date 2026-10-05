// Persistent state of the cache registry (M3, S04:CA-011): `<appdir>/engine/cache-index.json` (last access per entry,
// the project ref sets recorded by exports, the last cleaning report) and `<appdir>/engine/cache.json` (the user's
// Media Cache settings). Both are written atomically (tmp + fsync + rename); the index is debounced. A missing or
// corrupt index only loses access times and recorded refs (the next scan rebuilds the entries).
import { type CacheGcReport, type CacheSettings, CacheSettingsSchema } from '@jasper/api';
import { atomicWriteJson, readJsonOrNull } from '../tools/fs.ts';
import { KeyedMutex } from '../tools/mutex.ts';

/** Entries an export (or preview) of a project used, replaced on the next run of the same scope. */
type RefSet = { projectId: string; entries: string[]; updatedAt: number };

type IndexFile = {
	version: 1;
	/** entry id → last access (ms). */
	access: Record<string, number>;
	/** scope (`export:<pid>:<seq>` …) → ref set. */
	refs: Record<string, RefSet>;
	lastGc: CacheGcReport | null;
};

const DEFAULT_CACHE_SETTINGS: CacheSettings = CacheSettingsSchema.parse({});

export class CacheIndexStore {
	access = new Map<string, number>();
	refs = new Map<string, RefSet>();
	lastGc: CacheGcReport | null = null;
	private timer: NodeJS.Timeout | null = null;
	private readonly mutex = new KeyedMutex();
	private dirty = false;

	constructor(
		private readonly file: string,
		private readonly debounceMs = 2000,
	) {}

	async load(): Promise<void> {
		const raw = await readJsonOrNull<Partial<IndexFile>>(this.file);
		if (raw?.version !== 1) return;
		for (const [k, v] of Object.entries(raw.access ?? {})) if (Number.isFinite(v)) this.access.set(k, v);
		for (const [k, v] of Object.entries(raw.refs ?? {})) {
			if (v && typeof v.projectId === 'string' && Array.isArray(v.entries))
				this.refs.set(k, {
					projectId: v.projectId,
					entries: v.entries.filter((e) => typeof e === 'string'),
					updatedAt: Number(v.updatedAt) || 0,
				});
		}
		this.lastGc = raw.lastGc ?? null;
	}

	/** Schedules a write (debounced). */
	changed(): void {
		this.dirty = true;
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.flush().catch(() => undefined);
		}, this.debounceMs);
		this.timer.unref?.();
	}

	/** Writes now when there are pending changes. */
	flush(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		return this.mutex.run('index', async () => {
			if (!this.dirty) return;
			this.dirty = false;
			const out: IndexFile = {
				version: 1,
				access: Object.fromEntries(this.access),
				refs: Object.fromEntries(this.refs),
				lastGc: this.lastGc,
			};
			await atomicWriteJson(this.file, out);
		});
	}
}

export class CacheSettingsStore {
	private readonly mutex = new KeyedMutex();
	private cached: CacheSettings | null = null;
	constructor(private readonly file: string) {}

	async get(): Promise<CacheSettings> {
		if (this.cached) return this.cached;
		const raw = await readJsonOrNull<unknown>(this.file);
		const parsed = CacheSettingsSchema.safeParse(raw ?? {});
		this.cached = parsed.success ? parsed.data : DEFAULT_CACHE_SETTINGS;
		return this.cached;
	}

	/** Forget the cached value (the file was written elsewhere, e.g. by a cache move). */
	invalidate(): void {
		this.cached = null;
	}

	async put(next: CacheSettings): Promise<CacheSettings> {
		const value = CacheSettingsSchema.parse(next);
		return this.mutex.run('settings', async () => {
			await atomicWriteJson(this.file, value, true);
			this.cached = value;
			return value;
		});
	}
}
