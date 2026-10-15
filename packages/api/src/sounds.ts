// Sound library contracts (spec 12 §2.1, §2.8; wp-note "WP1.2 engine library"). The engine keeps one library per
// appdir (`<appdir>/sounds/library.json`), shared by every project: the bundled starter kit, installed packs, user
// folders indexed in place and the Jasper Synth fallback. Search ranks with `@jasper/project` `rankSounds`, so a
// `SoundEntry` is a `RankableSound` (checked at compile time below).
import {
	LIBRARY_LIMITS,
	LibraryProvenanceSchema,
	type RankableSound,
	SOUND_FAMILIES,
	StoredSoundTypeSchema,
	VISUAL_KINDS,
} from '@jasper/project';
import { z } from 'zod';
import { EngineJobSchema } from './jobs.ts';
import { RegisteredMediaSchema } from './media.ts';

/** `snd_` + the first 16 hex digits of the file's content fingerprint: the same bytes are the same sound. */
export const SOUND_ID_RE = /^snd_[0-9a-f]{16}$/;
export const SoundIdSchema = z.string().regex(SOUND_ID_RE, 'sound id (snd_ + 16 hex digits)');

/** A user folder's id (`root_` + 12 hex digits), stable across renames of its label. */
export const SOUND_ROOT_ID_RE = /^root_[0-9a-f]{12}$/;

/** Sources in priority order (spec 12 §2.1): the same sound found twice is listed under the first. */
export const SOUND_SOURCE_TYPES = ['starter', 'pack', 'folder', 'synth'] as const;
export type SoundSourceType = (typeof SOUND_SOURCE_TYPES)[number];

/** Audio files the library indexes (by extension, case-insensitive). */
export const SOUND_FILE_EXTENSIONS = [
	'wav',
	'aif',
	'aiff',
	'flac',
	'mp3',
	'ogg',
	'opus',
	'm4a',
	'aac',
] as const;

const relFile = z
	.string()
	.min(1)
	.max(LIBRARY_LIMITS.pathPart)
	.refine(
		(p) =>
			!p.includes('\0') &&
			!p.includes('\\') &&
			!p.startsWith('/') &&
			!/^[A-Za-z]:/.test(p) &&
			p.split('/').every((s) => s !== '' && s !== '.' && s !== '..'),
		'a relative path inside its folder (forward slashes, no "..")',
	);

/**
 * Where a library sound lives (spec 12 §2.1 `SoundEntry.source`). Starter and pack sounds also name their `file`
 * (relative to the kit or pack folder); the project's `LibrarySourceSchema` is loose, so it is kept in provenance.
 */
export const SoundSourceSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('starter'),
		packId: z.string().max(LIBRARY_LIMITS.id).optional(),
		file: relFile,
	}),
	z.object({ type: z.literal('pack'), packId: z.string().min(1).max(LIBRARY_LIMITS.id), file: relFile }),
	z.object({
		type: z.literal('folder'),
		rootId: z.string().regex(SOUND_ROOT_ID_RE),
		relPath: relFile,
	}),
	z.object({
		type: z.literal('synth'),
		recipe: z.string().min(1).max(LIBRARY_LIMITS.id),
		seed: z.number().int().min(0).max(0xffff_ffff),
	}),
]);
export type SoundSource = z.infer<typeof SoundSourceSchema>;

const fin = () => z.number().finite();
/** `@jasper/audio-fx` `SoundDescriptors` (quantised; definitions in the wp-note "WP1.1b"). */
export const SoundDescriptorsSchema = z.object({
	durationSec: fin().min(0),
	peakSec: fin().min(0),
	onsetSec: fin().min(0),
	riseMs: fin().min(0),
	decayMs: fin().min(0),
	decays: z.boolean(),
	tailSec: fin().min(0),
	centroidHz: fin().min(0),
	rolloff85Hz: fin().min(0),
	below150Share: fin().min(0).max(1),
	above6kShare: fin().min(0).max(1),
	flatness: fin().min(0).max(1),
	octaveBandsDb: z.array(fin()).length(7),
	pitchMidi: fin().nullable(),
	pitchConfidence: fin(),
	onsetCount: z.number().int().min(0),
	integratedLufs: fin().nullable(),
	maxMomentaryLufs: fin().nullable(),
	truePeakDb: fin().nullable(),
	stereoWidth: fin().min(0).max(1),
	headQuietSec: fin().min(0),
	loopable: z.boolean(),
});
export type SoundDescriptorsJson = z.infer<typeof SoundDescriptorsSchema>;

/** `judgeSound` against the profile of `type` (the first known type of the sound); null for untyped sounds. */
export const SoundJudgeSchema = z.object({
	ok: z.boolean(),
	score: fin().min(0).max(1),
	reasons: z.array(z.string().max(32)).max(16),
	type: z.string().max(LIBRARY_LIMITS.typeId),
});

export const SoundFormatSchema = z.object({
	/** The whole file (descriptors cover at most the first {@link SOUND_ANALYSIS_SECONDS}). */
	durationSec: fin().min(0),
	sampleRate: z.number().int().min(0),
	channels: z.number().int().min(0),
	/** ffprobe format name, e.g. `wav`, `ogg`, `mp3`. */
	container: z.string().max(100),
});

/** Seconds of each file the index decodes and analyses (descriptors and visual data); `format.durationSec` is the whole file. */
export const SOUND_ANALYSIS_SECONDS = 30;

export const SoundEntrySchema = z.object({
	id: SoundIdSchema,
	/** Content fingerprint (`q1:` + sha256 hex, ARCHITECTURE D-09), the media registry's. */
	fingerprint: z.string().max(LIBRARY_LIMITS.hash),
	title: z.string().max(LIBRARY_LIMITS.title),
	/** Taxonomy ids (lower-case; ids of newer builds are kept). */
	types: z.array(StoredSoundTypeSchema).max(LIBRARY_LIMITS.types),
	tags: z.array(z.string().max(64)).max(64),
	source: SoundSourceSchema,
	/** SPDX id, `LicenseRef-UserProvided`, `LicenseRef-UserRoyaltyFree` or `LicenseRef-JasperEditor`. */
	license: z.string().min(1).max(LIBRARY_LIMITS.license),
	licenseUrl: z.string().max(LIBRARY_LIMITS.url).optional(),
	author: z.string().max(LIBRARY_LIMITS.author),
	sourceUrl: z.string().max(LIBRARY_LIMITS.url).optional(),
	/** The credit line the licence asks for; null when none is required. */
	attribution: z.string().max(LIBRARY_LIMITS.attribution).nullable(),
	format: SoundFormatSchema,
	descriptors: SoundDescriptorsSchema,
	judge: SoundJudgeSchema.nullable(),
	indexedAt: z.string().max(40),
	/** Analysis version the descriptors were computed with (a bump re-analyses). */
	analysisVersion: z.number().int().min(0),
});
export type SoundEntry = z.infer<typeof SoundEntrySchema>;

// Compile-time check: the engine's entries are what `rankSounds` ranks (spec 12 §2.1, wp-note WP1.1a).
type AssertRankable<T extends RankableSound> = T;
export type RankableSoundEntry = AssertRankable<SoundEntry>;

// ---------------------------------------------------------------------------------------------------------------
// Search

export const SOUND_SEARCH_MAX_LIMIT = 500;
export const SOUND_SEARCH_DEFAULT_LIMIT = 50;

const csv = (max: number, item: z.ZodType<string>) =>
	z
		.string()
		.max(4000)
		.transform((s, ctx) => {
			const parts = s
				.split(',')
				.map((p) => p.trim())
				.filter(Boolean);
			if (parts.length > max) {
				ctx.addIssue({ code: 'custom', message: `at most ${max} values` });
				return z.NEVER;
			}
			for (const p of parts)
				if (!item.safeParse(p).success) {
					ctx.addIssue({ code: 'custom', message: `invalid value "${p.slice(0, 40)}"` });
					return z.NEVER;
				}
			return parts;
		});

const intString = (min: number, max: number) =>
	z
		.string()
		.regex(/^\d{1,9}$/, 'an integer')
		.transform(Number)
		.pipe(z.number().int().min(min).max(max));

/**
 * `GET /api/sounds` query (strings on the wire; lists comma-separated). Every field is optional; without any, the
 * whole library in ranking order (commercial-safe licences only, the panel's default).
 */
export const SoundSearchQuerySchema = z.object({
	/** Free text: titles, tags and types (with synonyms: `swoosh` finds whooshes). */
	q: z.string().max(500).optional(),
	/** Type ids or synonyms, comma-separated. */
	types: csv(32, z.string().min(1).max(32)).optional(),
	/** One panel family (`impacts`, `movement`, `digital`, `tactile`, `tonal`, `beds`). */
	family: z.enum(SOUND_FAMILIES).optional(),
	visualKind: z.enum(VISUAL_KINDS).optional(),
	windowSec: z
		.string()
		.regex(/^\d{1,6}(\.\d{1,6})?$/, 'seconds')
		.transform(Number)
		.pipe(z.number().positive().max(600))
		.optional(),
	align: z.enum(['peak', 'start', 'end']).optional(),
	length: z.enum(['short', 'medium', 'long']).optional(),
	tone: z.enum(['dark', 'bright']).optional(),
	attack: z.enum(['punchy', 'soft']).optional(),
	weight: z.enum(['light', 'heavy']).optional(),
	texture: z.enum(['clean', 'noisy']).optional(),
	/** Default `commercial-safe`. */
	license: z.enum(['any', 'commercial-safe']).optional(),
	/** Source types, comma-separated. */
	sources: csv(4, z.enum(SOUND_SOURCE_TYPES)).optional(),
	/** Only sounds of this user folder. */
	rootId: z.string().regex(SOUND_ROOT_ID_RE).optional(),
	/** Rank by similarity to this sound (left out of the results). */
	similarTo: SoundIdSchema.optional(),
	/** Sounds used near the target, nearest first: they rank lower (rotation). */
	usedNearby: csv(64, SoundIdSchema).optional(),
	limit: intString(1, SOUND_SEARCH_MAX_LIMIT).optional(),
	offset: intString(0, 1_000_000).optional(),
});
export type SoundSearchQuery = z.infer<typeof SoundSearchQuerySchema>;

/** What a client asks for (typed); `soundSearchParams` turns it into the query string. */
export type SoundSearchRequest = {
	q?: string;
	types?: readonly string[];
	family?: (typeof SOUND_FAMILIES)[number];
	visualKind?: (typeof VISUAL_KINDS)[number];
	windowSec?: number;
	align?: 'peak' | 'start' | 'end';
	length?: 'short' | 'medium' | 'long';
	tone?: 'dark' | 'bright';
	attack?: 'punchy' | 'soft';
	weight?: 'light' | 'heavy';
	texture?: 'clean' | 'noisy';
	license?: 'any' | 'commercial-safe';
	sources?: readonly SoundSourceType[];
	rootId?: string;
	similarTo?: string;
	usedNearby?: readonly string[];
	limit?: number;
	offset?: number;
};

/** The query string values of a search (lists joined with commas, absent fields left out). */
export function soundSearchParams(req: SoundSearchRequest): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(req)) {
		if (v === undefined || v === null) continue;
		if (Array.isArray(v)) {
			if (v.length) out[k] = v.join(',');
		} else out[k] = String(v);
	}
	return out;
}

export const SoundRankPartsSchema = z.object({
	text: fin().nullable(),
	typeFit: fin().nullable(),
	durationFit: fin(),
	judge: fin(),
	license: fin(),
	source: fin(),
	similarity: fin().nullable(),
	rotation: fin(),
});

const counts = z.record(z.string(), z.number().int().min(0));

/**
 * Facet counts over the sounds that match the request (disjunctive: the type and family counts ignore the request's
 * own type and family filter, the licence counts its licence filter, the source counts its source filter, so a
 * chip shows how many sounds selecting it would give).
 */
export const SoundFacetsSchema = z.object({
	/** Per taxonomy type id (a sound with two types counts in both). */
	types: counts,
	/** Per panel family. */
	families: counts,
	/** Per licence class (`cc0`, `cc-by`, `user-provided`… of `licenseClass`). */
	licenses: counts,
	/** Per source type. */
	sources: counts,
});
export type SoundFacets = z.infer<typeof SoundFacetsSchema>;

export const SoundSearchResponseSchema = z.object({
	snapshotHash: z.string(),
	/** Sounds in the library. */
	librarySize: z.number().int().min(0),
	/** Sounds that match (before `offset` / `limit`). */
	total: z.number().int().min(0),
	offset: z.number().int().min(0),
	results: z.array(z.object({ sound: SoundEntrySchema, score: fin(), parts: SoundRankPartsSchema })),
	facets: SoundFacetsSchema,
	/** An index job is queued or running: results may change (`sounds.changed` event). */
	indexing: z.boolean(),
});
export type SoundSearchResponse = z.infer<typeof SoundSearchResponseSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Visual data (agents cannot hear: spec 12 §1)

export const SOUND_VISUAL_VERSION = 1;
export const SOUND_PEAKS_PER_SECOND = 100;
export const SOUND_SPECTROGRAM_BINS = 64;
export const SOUND_SPECTROGRAM_FLOOR_DB = -96;

export const SoundVisualSchema = z.object({
	version: z.number().int(),
	soundId: SoundIdSchema,
	fingerprint: z.string(),
	durationSec: fin().min(0),
	/** Seconds the data covers (the first `SOUND_ANALYSIS_SECONDS` of longer files). */
	coveredSec: fin().min(0),
	/** The descriptors' `peakSec` (the line contact sheets draw). */
	peakSec: fin().min(0),
	/** Max |sample| over all channels per 1/`perSecond` s, linear, as u8 (255 = full scale), base64. */
	peaks: z.object({
		perSecond: z.number().int().positive(),
		count: z.number().int().min(0),
		data: z.string(),
	}),
	/**
	 * Mono-mix power spectrogram, `bins` log-spaced bands from `minHz` to `maxHz`, `framesPerSecond` frames: u8 per
	 * cell (0 = `floorDb` dBFS or lower, 255 = 0 dBFS, linear in dB), frame-major (`frame * bins + bin`, bin 0 =
	 * lowest band), base64.
	 */
	spectrogram: z.object({
		bins: z.number().int().positive(),
		frames: z.number().int().min(0),
		framesPerSecond: z.number().positive(),
		minHz: fin().positive(),
		maxHz: fin().positive(),
		floorDb: fin(),
		data: z.string(),
	}),
});
export type SoundVisual = z.infer<typeof SoundVisualSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Register into a project

export const RegisterSoundRequestSchema = z.object({ projectId: z.string().min(1).max(128) });
export type RegisterSoundRequest = z.infer<typeof RegisterSoundRequestSchema>;

/**
 * `RegisteredMedia` of the sound's file (starter, pack and synth sounds are copied into managed media; folder sounds
 * are registered in place, like a path import) plus the provenance to commit with `media.register` (its `library`),
 * into a "Sound Effects" bin. `existingMediaId`: the saved project already has this file (same fingerprint) as
 * that media; reuse it instead of registering a duplicate.
 */
export const RegisterSoundResponseSchema = RegisteredMediaSchema.extend({
	library: LibraryProvenanceSchema,
	existingMediaId: z.string().nullable(),
});
export type RegisterSoundResponse = z.infer<typeof RegisterSoundResponseSchema>;

/** The bin clients put registered library sounds into. */
export const SOUND_EFFECTS_BIN = 'Sound Effects';

// ---------------------------------------------------------------------------------------------------------------
// User folders (local mode only)

/**
 * The licence a user declares for a folder: undeclared (`LicenseRef-UserProvided`, the default: flagged in credits,
 * not commercial-safe), royalty-free for their use (`LicenseRef-UserRoyaltyFree`), or one of the open licences of
 * the asset allowlist (AGENTS.md §3.2).
 */
export const SOUND_ROOT_LICENSES = [
	'LicenseRef-UserProvided',
	'LicenseRef-UserRoyaltyFree',
	'CC0-1.0',
	'CC-BY-3.0',
	'CC-BY-4.0',
	'CC-BY-SA-3.0',
	'CC-BY-SA-4.0',
] as const;
export const SoundRootLicenseSchema = z.enum(SOUND_ROOT_LICENSES);

export const SOUND_ROOTS_MAX = 32;

export const SoundRootSchema = z.object({
	id: z.string().regex(SOUND_ROOT_ID_RE),
	/** Absolute, normalised folder path on the engine host. */
	path: z.string().min(1).max(4096),
	label: z.string().max(200),
	license: SoundRootLicenseSchema,
	/** Credit line for its sounds; `{title}`, `{file}`, `{folder}`, `{author}` and `{license}` are filled in. */
	attributionTemplate: z.string().max(1000).optional(),
	/** Author or copyright holder of the folder's sounds (credits). */
	author: z.string().max(LIBRARY_LIMITS.author).optional(),
	enabled: z.boolean(),
	addedAt: z.string().max(40),
});
export type SoundRoot = z.infer<typeof SoundRootSchema>;

export const SoundRootsResponseSchema = z.object({
	roots: z.array(SoundRootSchema),
	/** Folders can be added on this engine (local mode). */
	local: z.boolean(),
});
export type SoundRootsResponse = z.infer<typeof SoundRootsResponseSchema>;

/** `PUT /api/sounds/roots`: the complete new list. An item without `id` (or with an unknown one) is a new folder. */
export const SoundRootsPutRequestSchema = z.object({
	roots: z
		.array(
			z.object({
				id: z.string().regex(SOUND_ROOT_ID_RE).optional(),
				path: z.string().min(1).max(4096),
				label: z.string().max(200).optional(),
				license: SoundRootLicenseSchema.optional(),
				attributionTemplate: z.string().max(1000).optional(),
				author: z.string().max(LIBRARY_LIMITS.author).optional(),
				enabled: z.boolean().optional(),
			}),
		)
		.max(SOUND_ROOTS_MAX),
});
export type SoundRootsPutRequest = z.infer<typeof SoundRootsPutRequestSchema>;

export const SoundRootsPutResponseSchema = SoundRootsResponseSchema.extend({
	/** The rescan started for added or re-enabled folders (null when nothing needs indexing). */
	job: EngineJobSchema.nullable(),
	/** Sounds of removed or disabled folders taken out of the library. */
	removedSounds: z.number().int().min(0),
});
export type SoundRootsPutResponse = z.infer<typeof SoundRootsPutResponseSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Indexing and status

export const SoundIndexRequestSchema = z.object({
	/** Re-analyse every file even when its cached analysis is current. */
	full: z.boolean().optional(),
});
export type SoundIndexRequest = z.infer<typeof SoundIndexRequestSchema>;

/** `EngineJob.result` of a `sound-index` job. */
export const SoundIndexResultSchema = z.object({
	snapshotHash: z.string(),
	sounds: z.number().int().min(0),
	/** Files seen, analysed now, analysis reused from the cache. */
	files: z.number().int().min(0),
	analysed: z.number().int().min(0),
	reused: z.number().int().min(0),
	added: z.number().int().min(0),
	removed: z.number().int().min(0),
	/** Files that could not be indexed (the first 100). */
	errors: z.array(
		z.object({ source: z.enum(SOUND_SOURCE_TYPES), file: z.string(), code: z.string(), message: z.string() }),
	),
});
export type SoundIndexResult = z.infer<typeof SoundIndexResultSchema>;

export const SoundLibraryStatusSchema = z.object({
	snapshotHash: z.string(),
	sounds: z.number().int().min(0),
	bySource: z.record(z.enum(SOUND_SOURCE_TYPES), z.number().int().min(0)),
	packs: z.number().int().min(0),
	roots: z.number().int().min(0),
	/** The bundled starter kit: its manifest is missing (`absent`), unreadable (`invalid`) or read (`ok`). */
	starter: z.object({
		status: z.enum(['ok', 'absent', 'invalid']),
		sounds: z.number().int().min(0),
		/** Manifest problems (invalid entries are skipped). */
		errors: z.array(z.string()),
	}),
	indexedAt: z.string().nullable(),
	/** The library was never indexed, the index was rebuilt after damage, or the starter kit changed. */
	needsIndex: z.boolean(),
	/** The index file was unreadable and was rebuilt (the damaged file is kept as `library.json.corrupt-<time>`). */
	recovered: z.boolean(),
	indexing: EngineJobSchema.nullable(),
	/** Jasper Synth (procedural fallback) is available. */
	synth: z.boolean(),
	/** User folders can be added (local mode). */
	local: z.boolean(),
});
export type SoundLibraryStatus = z.infer<typeof SoundLibraryStatusSchema>;

/** `features.sound` of `GET /api/capabilities` (spec 12 §2.8). */
export const SoundCapabilitiesSchema = z.object({
	library: z.object({ sounds: z.number().int().min(0), packs: z.number().int().min(0) }),
	synth: z.boolean(),
});

// ---------------------------------------------------------------------------------------------------------------
// Bundled starter kit and installed packs

/**
 * `apps/engine/sounds/starter/manifest.json` (the bundled starter kit) and `<appdir>/sounds/packs/<id>/pack.json`
 * (an installed pack, one entry in `packs`). `file` is relative to the manifest's folder. Licences must be on the
 * asset allowlist; every bundled file also has its `.attribution` sidecar (AGENTS.md §3).
 */
export const SoundManifestPackSchema = z.object({
	id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
	title: z.string().min(1).max(200),
	/** Where the pack was downloaded from. */
	url: z.string().max(LIBRARY_LIMITS.url),
	/** sha256 of the downloaded archive (hex). */
	sha256: z.string().regex(/^[0-9a-f]{64}$/),
	license: z.string().min(1).max(LIBRARY_LIMITS.license),
	licenseUrl: z.string().max(LIBRARY_LIMITS.url).optional(),
	author: z.string().max(LIBRARY_LIMITS.author),
});
export const SoundManifestSoundSchema = z.object({
	file: relFile,
	title: z.string().min(1).max(LIBRARY_LIMITS.title),
	/** Taxonomy ids; empty = inferred from the file name. */
	types: z.array(StoredSoundTypeSchema).max(LIBRARY_LIMITS.types).default([]),
	tags: z.array(z.string().min(1).max(64)).max(64).default([]),
	author: z.string().max(LIBRARY_LIMITS.author),
	license: z.string().min(1).max(LIBRARY_LIMITS.license),
	licenseUrl: z.string().max(LIBRARY_LIMITS.url).optional(),
	sourceUrl: z.string().max(LIBRARY_LIMITS.url).optional(),
	/** A `packs[].id` of the same manifest. */
	packId: z.string().max(64).optional(),
	/** A credit line to use verbatim (else one is generated when the licence requires attribution). */
	attribution: z.string().max(LIBRARY_LIMITS.attribution).optional(),
});
export const SoundManifestSchema = z.object({
	version: z.literal(1),
	packs: z.array(SoundManifestPackSchema).max(64),
	sounds: z.array(z.unknown()).max(20_000),
});
export type SoundManifestPack = z.infer<typeof SoundManifestPackSchema>;
export type SoundManifestSound = z.infer<typeof SoundManifestSoundSchema>;
