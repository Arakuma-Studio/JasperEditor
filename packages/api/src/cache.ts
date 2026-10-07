// Media cache contracts (M3, S04 §7.5 CA-003/CA-010…CA-019, ARCHITECTURE §19.7). Owner: wp-m3-cachegc.
// The engine keeps every regenerable file it writes (derivatives, proxies, baked LUTs, warped layers, layer bakes,
// motion-graphics renders, export/still outputs, build caches) in one cache registry: usage per kind, reference-aware
// cleaning ("Clean Unused", "Clean All (not in use)") and budgets (size per kind / total, age) — Premiere's
// Preferences ▸ Media Cache.
import { z } from 'zod';

/** Cache kinds (one row each in Preferences ▸ Media Cache). */
export const CACHE_KINDS = [
	'media-cache',
	'proxies',
	'luts',
	'warp',
	'layers',
	'mg-renders',
	'mg-posters',
	'exports',
	'stills',
	'bundles',
	// parity (roto): computed object mattes (Roto Brush, faces) and the reusable frame pool
	'roto',
] as const;
export const CacheKindSchema = z.enum(CACHE_KINDS);
export type CacheKind = z.infer<typeof CacheKindSchema>;

/** Per-kind overrides: `undefined` = the kind's default, `null` = no limit. */
export const CacheKindLimitsSchema = z.object({
	maxBytes: z.number().int().positive().nullable().optional(),
	maxAgeDays: z.number().positive().max(3650).nullable().optional(),
});
export type CacheKindLimits = z.infer<typeof CacheKindLimitsSchema>;

/**
 * `GET`/`PUT /api/cache/settings` (stored in `<appdir>/engine/cache.json`). Budgets and ages only ever remove entries
 * that no saved or open project references and no job uses; the user's "Clean" buttons go further.
 */
export const CacheSettingsSchema = z.object({
	/** Automatic cleaning at start-up, hourly and after renders (age + budgets). */
	autoClean: z.boolean().default(true),
	/** Total budget in bytes; null = automatic (CA-003: 25 GB or 15 % of the free disk at start, the smaller). */
	maxTotalBytes: z.number().int().positive().nullable().default(null),
	/** Unused entries older than this are removed; null = never. Kinds may override it (`kinds`). */
	maxAgeDays: z.number().positive().max(3650).nullable().default(30),
	kinds: z.partialRecord(CacheKindSchema, CacheKindLimitsSchema).default({}),
	/**
	 * Engine logs and the job journal (S04:CA-020; not caches): log files older than `maxAgeDays` go, then the oldest
	 * while the folder exceeds `maxBytes`. null = no limit.
	 */
	logs: z
		.object({
			maxAgeDays: z.number().positive().max(3650).nullable().default(30),
			maxBytes: z
				.number()
				.int()
				.positive()
				.nullable()
				.default(256 * 1024 * 1024),
		})
		.default({ maxAgeDays: 30, maxBytes: 256 * 1024 * 1024 }),
	/**
	 * Cache folder (S04:CA-021); null = inside the engine's data folder. Read-only here: it changes through
	 * `POST /api/cache/location` (a `cache-move` job); a PUT keeps the current value.
	 */
	location: z.string().nullable().default(null),
});
export type CacheSettings = z.infer<typeof CacheSettingsSchema>;

/** `POST /api/cache/location/check` and the `path` of a move: an absolute folder, or null = the default location. */
export const CacheLocationRequestSchema = z.object({ path: z.string().min(1).nullable() });

/** What a move to a folder would need, and whether it can go there. */
export const CacheLocationCheckSchema = z.object({
	/** Resolved absolute folder (the cache keeps `cache/`, `mg/`, `renders/` and `tmp/` in it). */
	path: z.string(),
	isDefault: z.boolean(),
	ok: z.boolean(),
	/** Why not (or a warning when ok). */
	message: z.string().nullable(),
	exists: z.boolean(),
	writable: z.boolean(),
	freeBytes: z.number().int().min(0).nullable(),
	/** Bytes a move copies (the current cache; 0 when the folder is on the same disk: it is renamed). */
	requiredBytes: z.number().int().min(0),
	sameDevice: z.boolean(),
	sameAsCurrent: z.boolean(),
});
export type CacheLocationCheck = z.infer<typeof CacheLocationCheckSchema>;

/**
 * `POST /api/cache/location` → EngineJob (kind `cache-move`). `move` brings the current cache along (renamed on the
 * same disk, copied with progress otherwise); `fresh` starts empty there and removes the old files unless
 * `keepOld`. The job waits for running jobs and runs alone; the engine switches when it succeeds.
 */
export const CacheMoveRequestSchema = CacheLocationRequestSchema.extend({
	mode: z.enum(['move', 'fresh']),
	keepOld: z.boolean().optional(),
});
export type CacheMoveRequest = z.infer<typeof CacheMoveRequestSchema>;

/** One kind's usage (bytes are what is on disk now). */
export const CacheKindUsageSchema = z.object({
	kind: CacheKindSchema,
	label: z.string(),
	description: z.string(),
	entries: z.number().int().min(0),
	bytes: z.number().int().min(0),
	/** In use: held by a running job, referenced by an open project, or written in the last minutes. */
	inUseBytes: z.number().int().min(0),
	/** Referenced by a saved (not open) project: kept by automatic cleaning and by "Clean Unused". */
	referencedBytes: z.number().int().min(0),
	/** Neither: removed by "Clean Unused", the age limit and the budgets. */
	unusedBytes: z.number().int().min(0),
	/** Effective limits (settings or defaults); null = none. */
	maxBytes: z.number().int().positive().nullable(),
	maxAgeDays: z.number().positive().nullable(),
	/** The kind's default age limit (shown as placeholder). */
	defaultMaxAgeDays: z.number().positive().nullable(),
	/** ISO time of the least recently used entry. */
	oldestAccess: z.string().nullable(),
});
export type CacheKindUsage = z.infer<typeof CacheKindUsageSchema>;

/** Engine data that is not a cache (reported for context; never cleaned from here). */
export const CacheOtherUsageSchema = z.object({
	id: z.string(),
	label: z.string(),
	bytes: z.number().int().min(0),
});

export const CacheGcReportSchema = z.object({
	at: z.string(),
	mode: z.enum(['auto', 'unused', 'all']),
	removedEntries: z.number().int().min(0),
	removedBytes: z.number().int().min(0),
	/** Orphaned temporary files (crashed writes) removed. */
	removedOrphans: z.number().int().min(0),
	/** Entries kept because a job or an open project uses them / a saved project references them. */
	keptInUse: z.number().int().min(0),
	keptReferenced: z.number().int().min(0),
	/** Removals that failed (file busy on Windows, permissions); retried by the next pass. */
	failed: z.number().int().min(0),
	byKind: z.partialRecord(CacheKindSchema, z.object({ entries: z.number().int(), bytes: z.number().int() })),
});
export type CacheGcReport = z.infer<typeof CacheGcReportSchema>;

/** `GET /api/cache` */
export const CacheUsageSchema = z.object({
	/** Cache location (local mode only; null on a remote engine). */
	location: z.string().nullable(),
	/** M3 (CA-021): the cache is in the engine's data folder (no custom location). */
	locationIsDefault: z.boolean().optional(),
	/** M3 (CA-020): engine logs + job journal (not cache; retention in `settings.logs`). */
	logs: z
		.object({
			bytes: z.number().int().min(0),
			files: z.number().int().min(0),
			journalBytes: z.number().int().min(0),
		})
		.optional(),
	totalBytes: z.number().int().min(0),
	inUseBytes: z.number().int().min(0),
	referencedBytes: z.number().int().min(0),
	unusedBytes: z.number().int().min(0),
	/** Effective total budget and whether it is the automatic one. */
	maxTotalBytes: z.number().int().positive().nullable(),
	automaticBudget: z.boolean(),
	freeDiskBytes: z.number().int().min(0).nullable(),
	kinds: z.array(CacheKindUsageSchema),
	other: z.array(CacheOtherUsageSchema),
	settings: CacheSettingsSchema,
	lastGc: CacheGcReportSchema.nullable(),
	scannedAt: z.string(),
});
export type CacheUsage = z.infer<typeof CacheUsageSchema>;

/**
 * `POST /api/cache/clean`. `unused` = everything no project (saved or open) references and nothing uses (Premiere's
 * "Delete Unused"); `all` = everything not in use right now (running jobs, open projects), including what saved
 * projects reference — it is regenerated on demand; `auto` = one automatic pass (age + budgets).
 */
export const CacheCleanRequestSchema = z.object({
	mode: z.enum(['auto', 'unused', 'all']),
	kinds: z.array(CacheKindSchema).min(1).optional(),
});
export type CacheCleanRequest = z.infer<typeof CacheCleanRequestSchema>;
