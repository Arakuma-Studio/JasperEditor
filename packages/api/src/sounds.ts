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

/** A pack's id (its folder under `<appdir>/sounds/packs/`): lower-case letters, digits, `.`, `_`, `-`. */
export const SOUND_PACK_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

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
	/** Only sounds of this installed pack (WP6.1). */
	packId: z.string().regex(SOUND_PACK_ID_RE).optional(),
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
	packId?: string;
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
		} else if (typeof v === 'number')
			// The query schema takes up to 6 decimals (a computed 2/3 s would otherwise be refused).
			out[k] = String(Number.isInteger(v) ? v : Number(v.toFixed(6)));
		else out[k] = String(v);
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
	/** Share of the query words its title matches (exact or prefix), ranked before the score; null without a query. */
	titleMatch: fin().nullable().optional(),
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
/** Why a registered sound is not a sample-exact copy (WP6.5b): over 1 h, over the copy size cap, or not enough disk. */
export const SOUND_INEXACT_REASONS = ['too-long', 'too-large', 'disk-space'] as const;

export const RegisterSoundResponseSchema = RegisteredMediaSchema.extend({
	library: LibraryProvenanceSchema,
	existingMediaId: z.string().nullable(),
	/**
	 * Present when the sound needed a sample-exact copy (lead / trailing silence, or a lossy source) but was registered as
	 * it is: its placement is then exact to a frame, a lossy one seeked by an In point may play a few samples off.
	 */
	inexact: z.object({ reason: z.enum(SOUND_INEXACT_REASONS), message: z.string().max(300) }).optional(),
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
	id: z.string().regex(SOUND_PACK_ID_RE),
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
	/**
	 * `false`: an empty `types` stays empty (the file name is not read for types; a jingle in a "Hit jingles" folder is
	 * not a hit). Default true.
	 */
	inferTypes: z.boolean().optional(),
});
export const SoundManifestSchema = z.object({
	version: z.literal(1),
	packs: z.array(SoundManifestPackSchema).max(64),
	sounds: z.array(z.unknown()).max(20_000),
});
export type SoundManifestPack = z.infer<typeof SoundManifestPackSchema>;
export type SoundManifestSound = z.infer<typeof SoundManifestSoundSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Downloadable packs (spec 12 §2.1 source 2, §2.8, P6-R1; wp-note "Phase 6 → WP6.1 sound packs")

/**
 * Licences a catalogue pack may have: the asset allowlist of AGENTS.md §3.2 that sound packs use (CC0, CC BY,
 * CC BY-SA; never NC/ND). WTFPL alone is not on the allowlist (spec 12 §0 decision 5): a pack offered under CC0 *and*
 * WTFPL is catalogued as CC0.
 */
export const SOUND_PACK_LICENSES = [
	'CC0-1.0',
	'CC-BY-3.0',
	'CC-BY-4.0',
	'CC-BY-SA-3.0',
	'CC-BY-SA-4.0',
] as const;
export const SoundPackLicenseSchema = z.enum(SOUND_PACK_LICENSES);
/** Largest archive a pack may download (the archive is read into memory to extract it). */
export const SOUND_PACK_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
/** Largest installed pack (the sum of its files). */
export const SOUND_PACK_MAX_INSTALL_BYTES = 1024 * 1024 * 1024;
/** Most files a pack may install. */
export const SOUND_PACK_MAX_FILES = 5000;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 (64 lower-case hex digits)');
const packUrl = z.string().min(1).max(LIBRARY_LIMITS.url);

/**
 * Where a catalogue says its licence comes from (checked by the curator; repeated in the wp-note): a page or file and
 * the statement it makes, verbatim, and the day it was checked.
 */
export const SoundPackEvidenceSchema = z.object({
	url: packUrl,
	statement: z.string().min(1).max(1000),
	checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
});
export type SoundPackEvidence = z.infer<typeof SoundPackEvidenceSchema>;

/**
 * One file a pack installs: its path in the archive (`zip`) or its own `url` (`files`), the pinned sha256 and size,
 * and its library metadata. `path` is also where it lands under the pack's folder (forward slashes, no `..`, no hidden
 * segment, an audio extension).
 */
export const SoundPackFileSchema = z.object({
	path: relFile,
	/** `files` packs: where this file downloads from. */
	url: packUrl.optional(),
	sha256: sha256Hex,
	sizeBytes: z.number().int().min(1).max(SOUND_PACK_MAX_ARCHIVE_BYTES),
	title: z.string().min(1).max(LIBRARY_LIMITS.title),
	types: z.array(StoredSoundTypeSchema).max(LIBRARY_LIMITS.types).default([]),
	tags: z.array(z.string().min(1).max(64)).max(64).default([]),
	/** Overrides the pack's author for this file (e.g. the voice actor of a voice line). */
	author: z.string().min(1).max(LIBRARY_LIMITS.author).optional(),
	/** `files` packs: the file's own page (its licence statement). */
	sourceUrl: packUrl.optional(),
	/**
	 * Where this file's own licence was checked (spec 12 §0 decision 5: BigSoundBank items are catalogued only after
	 * their own page was seen to state CC0): normally its `sourceUrl` and the statement it makes, verbatim.
	 */
	licenseEvidence: SoundPackEvidenceSchema.optional(),
	/** `false`: empty `types` stay empty (see `SoundManifestSoundSchema.inferTypes`). */
	inferTypes: z.boolean().optional(),
});
export type SoundPackFile = z.infer<typeof SoundPackFileSchema>;

/** How a pack downloads: one archive (zip) whose listed members are extracted, or one download per file. */
export const SoundPackDownloadSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('zip'),
		url: packUrl,
		sha256: sha256Hex,
		sizeBytes: z.number().int().min(22).max(SOUND_PACK_MAX_ARCHIVE_BYTES),
	}),
	z.object({ type: z.literal('files') }),
]);
export type SoundPackDownload = z.infer<typeof SoundPackDownloadSchema>;

/** A catalogue entry (`apps/engine/src/sounds/packs.json`; same rules as the model catalogue). */
export const SoundPackCatalogEntrySchema = z
	.object({
		id: z.string().regex(SOUND_PACK_ID_RE),
		title: z.string().min(1).max(200),
		author: z.string().min(1).max(LIBRARY_LIMITS.author),
		description: z.string().max(1000).default(''),
		license: SoundPackLicenseSchema,
		licenseUrl: packUrl,
		licenseEvidence: z.array(SoundPackEvidenceSchema).min(1).max(16),
		/** The credit line projects print (required for CC BY / BY-SA; null for CC0). */
		attribution: z.string().min(1).max(LIBRARY_LIMITS.attribution).nullable(),
		/** The pack's page (shown with the licence; each sound's `sourceUrl` unless the file has its own). */
		pageUrl: packUrl,
		download: SoundPackDownloadSchema,
		/** A licence or readme file of the archive installed with the pack and shown in Help ▸ About ▸ Licenses. */
		licenseFile: z
			.object({
				path: z.string().min(1).max(256),
				sha256: sha256Hex,
				sizeBytes: z.number().int().min(1).max(1_048_576),
			})
			.optional(),
		files: z.array(SoundPackFileSchema).min(1).max(SOUND_PACK_MAX_FILES),
		/** Archive members deliberately left out, with the reason (documentation; never installed). */
		skipped: z
			.array(
				z.object({
					path: z.string().min(1).max(LIBRARY_LIMITS.pathPart),
					reason: z.string().min(1).max(300),
				}),
			)
			.max(SOUND_PACK_MAX_FILES)
			.default([]),
	})
	.superRefine((e, ctx) => {
		const seen = new Set<string>();
		for (const [i, f] of e.files.entries()) {
			// case-insensitively unique: two names that differ only in case are one file on macOS and Windows
			const key = f.path.toLowerCase();
			if (seen.has(key))
				ctx.addIssue({ code: 'custom', path: ['files', i, 'path'], message: `"${f.path}" is listed twice` });
			seen.add(key);
			if (!/\.(wav|aif|aiff|flac|mp3|ogg|opus|m4a|aac)$/i.test(f.path))
				ctx.addIssue({ code: 'custom', path: ['files', i, 'path'], message: 'not an audio file' });
			if (f.path.split('/').some((seg) => seg.startsWith('.')))
				ctx.addIssue({ code: 'custom', path: ['files', i, 'path'], message: 'hidden path segment' });
			if (e.download.type === 'files' && !f.url)
				ctx.addIssue({
					code: 'custom',
					path: ['files', i, 'url'],
					message: 'a "files" pack needs a url per file',
				});
			if (e.download.type === 'zip' && f.url)
				ctx.addIssue({
					code: 'custom',
					path: ['files', i, 'url'],
					message: 'a "zip" pack extracts its files',
				});
		}
		const total = e.files.reduce((s, f) => s + f.sizeBytes, 0);
		if (total > SOUND_PACK_MAX_INSTALL_BYTES)
			ctx.addIssue({ code: 'custom', path: ['files'], message: 'the pack is larger than 1 GB' });
		if (e.license !== 'CC0-1.0' && !e.attribution)
			ctx.addIssue({ code: 'custom', path: ['attribution'], message: `${e.license} needs a credit line` });
		if (
			e.licenseFile &&
			(e.download.type !== 'zip' || e.licenseFile.path.includes('..') || e.licenseFile.path.startsWith('/'))
		)
			ctx.addIssue({ code: 'custom', path: ['licenseFile'], message: 'a licence file is an archive member' });
	});
export type SoundPackCatalogEntry = z.infer<typeof SoundPackCatalogEntrySchema>;

export const SoundPackCatalogSchema = z.object({
	$comment: z.string().optional(),
	version: z.literal(1),
	packs: z.array(z.unknown()).max(500),
});

/** A pack's state on this engine. */
export const SOUND_PACK_STATES = ['available', 'installed', 'outdated', 'damaged'] as const;

/** `GET /api/sounds/packs` item: a catalogue pack and what is installed of it (or an installed pack the catalogue no longer lists). */
export const SoundPackInfoSchema = z.object({
	id: z.string().regex(SOUND_PACK_ID_RE),
	title: z.string(),
	author: z.string(),
	description: z.string(),
	license: z.string(),
	licenseUrl: z.string().nullable(),
	licenseEvidence: z.array(SoundPackEvidenceSchema),
	attribution: z.string().nullable(),
	pageUrl: z.string().nullable(),
	/** The archive URL (`zip` packs), else null. */
	downloadUrl: z.string().nullable(),
	/** sha256 of the archive (`zip`) or of the file list (`files`). */
	sha256: z.string(),
	/** Bytes to download (the archive, or the sum of the files). */
	downloadBytes: z.number().int().min(0),
	/** Bytes on disk once installed (the listed files). */
	installBytes: z.number().int().min(0),
	/** Sounds the pack installs. */
	sounds: z.number().int().min(0),
	/** Listed by the engine's catalogue (an installed pack that is not can only be removed). */
	inCatalog: z.boolean(),
	/**
	 * `available` (not installed), `installed`, `outdated` (installed from another catalogue revision: install again to
	 * update), `damaged` (its pack.json is unreadable or files are missing: install again or remove it).
	 */
	state: z.enum(SOUND_PACK_STATES),
	installedAt: z.string().nullable(),
	/** Bytes of the installed folder's files, when installed. */
	installedBytes: z.number().int().min(0).nullable(),
	/** Sounds of this pack in the library index now. */
	indexedSounds: z.number().int().min(0),
	/** The queued or running `sound-pack-install` job of this pack. */
	job: EngineJobSchema.nullable(),
});
export type SoundPackInfo = z.infer<typeof SoundPackInfoSchema>;

export const SoundPacksResponseSchema = z.object({
	packs: z.array(SoundPackInfoSchema),
	/** Catalogue entries that did not validate (skipped), e.g. from a `JASPER_SOUND_CATALOG` override. */
	catalogErrors: z.array(z.string()),
});
export type SoundPacksResponse = z.infer<typeof SoundPacksResponseSchema>;

/** `EngineJob.result` of a `sound-pack-install` job. */
export const SoundPackInstallResultSchema = z.object({
	packId: z.string(),
	alreadyInstalled: z.boolean(),
	sounds: z.number().int().min(0),
	installedBytes: z.number().int().min(0),
	downloadedBytes: z.number().int().min(0),
	/** The `sound-index` job that adds the pack's sounds to the library (follow it to know when they are searchable). */
	indexJobId: z.string().nullable(),
});
export type SoundPackInstallResult = z.infer<typeof SoundPackInstallResultSchema>;

export const SoundPackRemoveResponseSchema = z.object({
	packId: z.string(),
	/** false: the pack was not installed (nothing changed). */
	removed: z.boolean(),
	removedSounds: z.number().int().min(0),
	freedBytes: z.number().int().min(0),
	/** The `sound-index` job started afterwards (a sound also found in a folder comes back under that folder). */
	job: EngineJobSchema.nullable(),
});
export type SoundPackRemoveResponse = z.infer<typeof SoundPackRemoveResponseSchema>;
