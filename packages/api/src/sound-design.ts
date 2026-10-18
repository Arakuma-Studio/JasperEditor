// Sound design route contracts (spec 12 §2.8; wp-note "WP2.3 cue route & MCP tools"). `POST /api/sound-design/cues`
// derives cue suggestions from the edit itself with `@jasper/project` `deriveCues`, on the engine because the engine
// has the motion-graphic template registry (intro / outro lengths) the model may not import. The cues are suggestions:
// nothing is stored (store them with `soundCue.add`; `cueInputFromDerived` maps one).
import {
	CUE_ALIGNS,
	CUE_DENSITIES,
	CUE_DERIVE_SOURCES,
	CUE_KINDS,
	CUE_WEIGHTS,
	CueAnchorSchema,
	ENGINE_CUE_SOURCES,
	SFX_ROLES,
	SOUND_DELIVERIES,
	SOUND_DESIGN_LIMITS,
} from '@jasper/project';
import { z } from 'zod';
import { TimeSignatureSchema } from './audio-fx.ts';
import { EnvelopeSchema } from './projects.ts';
import { SOUND_SOURCE_TYPES, SoundRankPartsSchema } from './sounds.ts';

const frame = z.number().int().min(0).max(SOUND_DESIGN_LIMITS.maxFrame);
const id = z.string().min(1).max(128);

/** Options of the derivation (`DeriveCuesOptions` minus what only the engine supplies). */
export const SoundCuesOptionsSchema = z.strictObject({
	/** Sequence frames `[start, end)`; default the whole sequence. */
	range: z
		.strictObject({ start: frame, end: frame })
		.refine((r) => r.end > r.start, 'range.end must be after range.start')
		.optional(),
	/** Sources to use (default every source). */
	sources: z.array(z.enum(CUE_DERIVE_SOURCES)).min(1).max(CUE_DERIVE_SOURCES.length).optional(),
	/** Default: the sequence's sound-design density (balanced when never set). */
	density: z.enum(CUE_DENSITIES).optional(),
	/** No cut cues where dialogue is heard (default true). */
	respectDialogue: z.boolean().optional(),
	minGapFrames: z.number().int().min(0).max(100_000).optional(),
	maxCues: z.number().int().min(1).max(10_000).optional(),
	/** Also return the per-frame motion speed curves (the Cue Seam's), rounded to 0.001. */
	curves: z.boolean().optional(),
	/**
	 * Snap moves, transitions, emphases and reveals to the nearest music beat within 2 frames (the cue keeps following
	 * its picture event at that `anchorOffset`). Analyses the beats of the Essential music clips (`POST /api/audio/beats`)
	 * when needed.
	 */
	snapToBeats: z.boolean().optional(),
	/**
	 * Metre of the music's downbeats for the `beat` source and `snapToBeats` (default `'auto'`: 3 or 4 beats per bar
	 * detected; a number forces it, e.g. 3 for a waltz).
	 */
	timeSignature: TimeSignatureSchema.optional(),
	/**
	 * Engine sources: start the analyses that are missing (default true; they come back as `W_ANALYSIS_PENDING` with
	 * their jobs), or `false` to use only what is already measured (`analysis[source].state` `missing` otherwise) — the
	 * editor's Suggest Cues… asks this way when it opens, and starts the analyses when the user clicks Analyze….
	 */
	analyze: z.boolean().optional(),
	/**
	 * Measure the voice activity of Essential Sound dialogue clips without a transcript (the speech module's energy VAD
	 * over each clip's media, cached per file and range) so dialogue is where they speak, not their whole span (default
	 * true; spec 12 P6-R3). `false` = cached measurements only.
	 */
	voiceActivity: z.boolean().optional(),
});
export type SoundCuesOptions = z.infer<typeof SoundCuesOptionsSchema>;

/**
 * `POST /api/sound-design/cues`: the document inline (`envelope`, like an export) or by `projectId` (the live
 * document: the open editor's when one holds the project, else the saved one). `sequenceId` defaults to the
 * project's first sequence.
 */
export const SoundCuesRequestSchema = z
	.strictObject({
		envelope: EnvelopeSchema.optional(),
		projectId: z
			.string()
			.regex(/^[A-Za-z0-9_-]{1,128}$/, 'a project id')
			.optional(),
		sequenceId: id.optional(),
		opts: SoundCuesOptionsSchema.optional(),
	})
	.refine((r) => (r.envelope === undefined) !== (r.projectId === undefined), 'give envelope or projectId');
export type SoundCuesRequest = z.infer<typeof SoundCuesRequestSchema>;

/** One suggested cue: a `DerivedCue` (spec 12 §2.2) with its time spelled out and the stored cue it matches. */
export const SoundCueSuggestionSchema = z.object({
	/** Stable key of the event (source + anchor): the same edit derives the same key. */
	key: z.string(),
	frame,
	/** Sequence timecode of `frame`. */
	timecode: z.string(),
	seconds: z.number(),
	kind: z.enum(CUE_KINDS),
	weight: z.enum(CUE_WEIGHTS),
	/** Suggested sound types, best first. */
	types: z.array(z.string()),
	align: z.enum(CUE_ALIGNS),
	pan: z.number().optional(),
	panSweep: z.object({ from: z.number(), to: z.number() }).optional(),
	anchor: CueAnchorSchema,
	/** Frames from the anchor's frame to the cue (`snapToBeats` moved it onto a beat); store it with the cue. */
	anchorOffset: z
		.number()
		.int()
		.min(-SOUND_DESIGN_LIMITS.anchorOffset)
		.max(SOUND_DESIGN_LIMITS.anchorOffset)
		.optional(),
	/** Events merged into this cue (within 2 frames). */
	also: z.array(CueAnchorSchema).optional(),
	confidence: z.number(),
	reason: z.string(),
	window: z.object({ start: z.number().int(), end: z.number().int() }).optional(),
	source: z.enum(['derived', 'marker']),
	from: z.enum(CUE_DERIVE_SOURCES),
	group: z.string().optional(),
	score: z.number(),
	/** The sequence's stored cue for the same event (same anchor, or same frame and kind), or null. */
	storedCueId: z.string().nullable(),
});
export type SoundCueSuggestion = z.infer<typeof SoundCueSuggestionSchema>;

/** An engine source's cue (`ExtraCue` of `deriveCues`): measured, not yet merged or budgeted. */
export const EngineCueSchema = z.object({
	key: z.string().max(400),
	frame,
	kind: z.enum(CUE_KINDS),
	weight: z.enum(CUE_WEIGHTS),
	types: z.array(z.string().max(32)).max(SOUND_DESIGN_LIMITS.types),
	align: z.enum(CUE_ALIGNS),
	pan: z.number().min(-100).max(100).optional(),
	panSweep: z.object({ from: z.number().min(-100).max(100), to: z.number().min(-100).max(100) }).optional(),
	anchor: CueAnchorSchema,
	confidence: z.number().min(0).max(1),
	reason: z.string().max(SOUND_DESIGN_LIMITS.reason),
	window: z.object({ start: z.number().int(), end: z.number().int() }).optional(),
	from: z.enum(ENGINE_CUE_SOURCES),
	size: z.number().min(0).max(1).optional(),
});
export type EngineCue = z.infer<typeof EngineCueSchema>;

const SourceStatsSchema = z.object({
	found: z.number().int(),
	kept: z.number().int(),
	merged: z.number().int(),
	droppedByBudget: z.number().int(),
	suppressedByDialogue: z.number().int(),
});

export const SoundCuesResponseSchema = z.object({
	/** Null for an inline envelope. */
	projectId: z.string().nullable(),
	sequenceId: z.string(),
	/** Revision of the document derived from (use it as `expectedRevision` when storing the cues). */
	revision: z.number().int().nullable(),
	frameRate: z.object({ num: z.number(), den: z.number() }),
	durationFrames: z.number().int(),
	/** The density used (the request's, else the sequence's setting). */
	density: z.enum(CUE_DENSITIES),
	respectDialogue: z.boolean(),
	cues: z.array(SoundCueSuggestionSchema),
	stats: z.object({
		bySource: z.record(z.string(), SourceStatsSchema),
		dropped: z.object({
			rate: z.number().int(),
			gap: z.number().int(),
			maxCues: z.number().int(),
			confidence: z.number().int(),
			range: z.number().int(),
		}),
		heroesDemoted: z.number().int(),
		/** Derived heroes made support because dialogue is heard at their frame. */
		heroesUnderDialogue: z.number().int().optional(),
		/** Cues `snapToBeats` moved onto a beat. */
		snappedToBeat: z.number().int().optional(),
		found: z.number().int(),
		kept: z.number().int(),
	}),
	warnings: z.array(
		z.object({
			code: z.string(),
			message: z.string(),
			source: z.string().optional(),
			clipId: z.string().optional(),
			/** `W_ANALYSIS_PENDING`: the jobs measuring the media; ask again when they finish. */
			jobIds: z.array(z.string()).optional(),
		}),
	),
	/**
	 * Frame ranges `[start, end)` where dialogue is heard (`dialogueSpans`: transcript words, else the voice activity of
	 * Essential Sound dialogue clips, else their whole spans), with the clips and tracks speaking and what found them.
	 */
	dialogue: z.array(
		z.object({
			start: z.number().int(),
			end: z.number().int(),
			clipIds: z.array(z.string()).optional(),
			trackIds: z.array(z.string()).optional(),
			sources: z.array(z.enum(['words', 'vad', 'clip'])).optional(),
		}),
	),
	/**
	 * Voiced media seconds of the dialogue clips the engine measured (clip id → `[start, end)` pairs): pass it to
	 * `deriveCues` as `voiceActivity` to derive with the same dialogue ranges (the editor's Suggest Cues…).
	 */
	voiceActivity: z.record(z.string(), z.array(z.tuple([z.number(), z.number()])).max(20_000)).optional(),
	/** The voice measurement: `ready` (every dialogue clip measured), `partial` / `failed` (`message`), `none`. */
	voice: z
		.object({
			state: z.enum(['ready', 'partial', 'none', 'failed']),
			measured: z.number().int(),
			missing: z.number().int(),
			message: z.string().optional(),
		})
		.optional(),
	/** Cues already stored in the sequence. */
	storedCues: z.number().int(),
	/**
	 * Engine sources asked for (`opts.sources` naming scene, beat or pixel, or `snapToBeats`): what each measured.
	 * `pending` = its analysis is running (`jobIds`; a `W_ANALYSIS_PENDING` warning says so too) and its cues are not in
	 * this answer yet; `missing` = not analysed yet (`analyze: false`); `ready` = measured (from the cache or just now);
	 * `none` = nothing to measure (no footage, no Essential music clip); `failed` = the analysis failed (`message`).
	 */
	analysis: z
		.partialRecord(
			z.enum(ENGINE_CUE_SOURCES),
			z.object({
				state: z.enum(['ready', 'pending', 'missing', 'none', 'failed']),
				jobIds: z.array(z.string()),
				/** Cues the source found (before merging). */
				found: z.number().int(),
				message: z.string().optional(),
			}),
		)
		.optional(),
	/**
	 * The engine sources' own cues before merging and budgets (for clients that derive the project sources themselves
	 * and pass these as `extraCues`, like the editor's Suggest Cues…).
	 */
	engineCues: z.array(EngineCueSchema).optional(),
	/** Per-frame motion speed of moving clips (with `opts.curves`). */
	curves: z
		.array(z.object({ clipId: z.string(), start: z.number().int(), speed: z.array(z.number()) }))
		.optional(),
});
export type SoundCuesResponse = z.infer<typeof SoundCuesResponseSchema>;

// ---------------------------------------------------------------------------------------------------------------
// `POST /api/sound-design/plan` (spec 12 §2.8, P3-R3; wp-note "Phase 3 → WP3.2"): a `sound-design` job that turns cues
// into a reviewable proposal (feature `sound-design`): cues → rank → register → place, deterministic by seed.

/** Bounds of a plan (a proposal stays in the hundreds of items: ≈ 5 ms of validation per item on the engine). */
export const SOUND_DESIGN_PLAN_LIMITS = {
	/** Cues placed per plan; more are skipped (`LIMIT`) — plan a later range for them. */
	maxCues: 200,
	/** Alternatives per placed cue (the next ranked sounds). */
	maxAlternatives: 3,
	/** Explicit cue ids per request. */
	maxCueIds: 2000,
	maxPalette: 500,
	/** Skipped cues listed in the report (the count is always complete). */
	maxSkippedListed: 500,
} as const;

const soundId = z.string().regex(/^snd_[0-9a-f]{16}$/, 'a sound id: snd_ + 16 hex digits');

export const SoundDesignPlanStyleSchema = z.strictObject({
	/** Density budget of derived cues (default: the sequence's setting). */
	density: z.enum(CUE_DENSITIES).optional(),
	/** Sounds ranked first when they fit: ids, or "project" (default): the sequence's palette. */
	palette: z
		.union([z.literal('project'), z.array(soundId).max(SOUND_DESIGN_PLAN_LIMITS.maxPalette)])
		.optional(),
	/** Library sources to pick from (default all: starter kit, packs, folders, Jasper Synth — synth ranks last). */
	sources: z.array(z.enum(SOUND_SOURCE_TYPES)).min(1).max(SOUND_SOURCE_TYPES.length).optional(),
	/** No cut cues under dialogue, and no hero under spoken words (default true). */
	respectDialogue: z.boolean().optional(),
	/**
	 * Where derived cues come from (`cues: "auto"`; default every source, as Suggest Cues…). Stored cues are planned
	 * whatever their source.
	 */
	cueSources: z.array(z.enum(CUE_DERIVE_SOURCES)).min(1).max(CUE_DERIVE_SOURCES.length).optional(),
	/**
	 * Snap derived moves, transitions, emphases and reveals to the music's beats within 2 frames (the beats of the
	 * Essential music clips are analysed in the job; default off).
	 */
	snapToBeats: z.boolean().optional(),
	/** Metre of the music's downbeats (default `'auto'`: 3 or 4 beats per bar detected). */
	timeSignature: TimeSignatureSchema.optional(),
	/** Rotation and variation seed (default: the sequence's `soundDesign.settings.seed`). */
	seed: z.number().int().min(0).max(0xffff_ffff).optional(),
	/** Alternatives per cue, 0–3 (default 3). */
	alternatives: z.number().int().min(0).max(SOUND_DESIGN_PLAN_LIMITS.maxAlternatives).optional(),
	/**
	 * Phase 4: the "SFX Room" glue (`soundDesign.ensureBus`) as a setup item the placements require — `true` (−16 dB
	 * sends) or `{sendDb}`. Off by default.
	 */
	roomGlue: z
		.union([z.boolean(), z.strictObject({ sendDb: z.number().min(-96).max(15).optional() })])
		.optional(),
	/** Phase 4: a stop-before dip (0.25 s, −24 dB) for each hero with music under it, one item per hero (default off). */
	stopBefore: z.boolean().optional(),
	/** Phase 4: a High Pass build (2 s, 150 Hz → 2 kHz) for each hero after ≥ 2 s of music (default off). */
	build: z.boolean().optional(),
	/**
	 * Phase 4: a delivery preset (`soundDesign.applyDelivery`, measured like `POST /api/sound-design/delivery`) as a setup
	 * item the placements require; the gains are then solved against that delivery's mix.
	 */
	delivery: z.enum(SOUND_DELIVERIES).optional(),
});
export type SoundDesignPlanStyle = z.infer<typeof SoundDesignPlanStyleSchema>;

export const SoundDesignPlanRequestSchema = z.strictObject({
	projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'a project id'),
	/** Default: the project's first sequence. */
	sequenceId: id.optional(),
	/** Sequence frames `[start, end)` (default the whole sequence). */
	range: z
		.strictObject({ start: frame, end: frame })
		.refine((r) => r.end > r.start, 'range.end must be after range.start')
		.optional(),
	/**
	 * `auto` (default): the sequence's unfilled stored cues plus cues derived from the edit (new ones become setup items
	 * of the proposal); or ids of stored cues to fill (nothing is derived).
	 */
	cues: z.union([z.literal('auto'), z.array(id).min(1).max(SOUND_DESIGN_PLAN_LIMITS.maxCueIds)]).optional(),
	style: SoundDesignPlanStyleSchema.optional(),
	/** At most this many cues get a sound (1–200, default 200). */
	maxCues: z.number().int().min(1).max(SOUND_DESIGN_PLAN_LIMITS.maxCues).optional(),
	/** Proposal title (default "Sound design: <sequence>"). */
	label: z.string().min(1).max(200).optional(),
});
export type SoundDesignPlanRequest = z.infer<typeof SoundDesignPlanRequestSchema>;

const PlanSoundSchema = z.object({
	soundId: z.string(),
	title: z.string(),
	license: z.string(),
	source: z.enum(SOUND_SOURCE_TYPES),
	score: z.number(),
	/** In the palette. */
	palette: z.boolean(),
});

/**
 * A sound effect's level as the masking solver set it (spec 12 §2.4; wp-note "Phase 4 → WP4.1b"): the gain, the lift it
 * reaches over the bed in its dominant octave bands, what held it under the target and why (a why-line naming the
 * dialogue or bed tracks).
 */
export const SfxSolvedLevelSchema = z.object({
	/** The solved clip gain (dB). */
	gainDb: z.number(),
	/** Target lift of the dominant bands over the bed (hero +5, support +3.5, ambient +2 dB). */
	targetLiftDb: z.number(),
	/** Lift reached at the gain (dB); null for a silent sound. */
	achievedLiftDb: z.number().nullable(),
	/** The constraints that held it under its target (empty: target reached). */
	limitedBy: z.array(z.string()),
	/** "−3 dB, limited by dialogue A1". */
	reason: z.string(),
	/** Dominant octave bands (Hz), strongest first. */
	dominantBandsHz: z.array(z.number()),
	/** Its peak loudness over the bed reference at the gain (LU). */
	peakOverBedLu: z.number().nullable(),
	/** Its true peak at the gain (dBTP; pre-master). */
	truePeakDb: z.number().nullable(),
	/** The window overlaps speech (the dialogue guard applies). */
	speech: z.boolean(),
	/** Tracks of the speech under it ("A1"). */
	speechTracks: z.array(z.string()),
	/** Bed tracks with clips under it. */
	bedTracks: z.array(z.string()),
	/** Its active window on the timeline (seconds), where sound and bed were measured. */
	window: z.object({ start: z.number(), end: z.number() }),
	/**
	 * dB the lower-weight sound effects playing under it add to its bed in the dominant bands at the solved gains (an
	 * ambience under a support or hero, a support under a hero; `achievedLiftDb` is over that masked bed). Absent: 0.
	 */
	sfxMaskingDb: z.number().optional(),
	/** Clip ids of those sound effects (≤ 32). */
	maskedBy: z.array(z.string()).optional(),
	/** Summed true peak of it and the sounds playing with it at its worst moment (dBTP, an upper bound; pre-master). */
	overlapTruePeakDb: z.number().optional(),
});
export type SfxSolvedLevel = z.infer<typeof SfxSolvedLevelSchema>;

/** A constraint the solver could not satisfy together with an earlier one (the earlier, safety one is kept). */
export const SfxLevelConflictSchema = z.object({
	clipId: z.string(),
	/** The plan item, for plan reports. */
	itemId: z.string().optional(),
	kept: z.string(),
	lost: z.string(),
	message: z.string(),
});
export type SfxLevelConflict = z.infer<typeof SfxLevelConflictSchema>;

/** How the levels were measured: the delivery, the clusters rendered, renders and cache hits. */
export const SfxLevelsMeasureSchema = z.object({
	delivery: z.enum(SOUND_DELIVERIES),
	programLufs: z.number(),
	truePeakCeilingDb: z.number(),
	/** Bed clusters rendered (merged event windows with their margins) and their total length (seconds). */
	clusters: z.number().int(),
	clusterSeconds: z.number(),
	renders: z.object({
		bed: z.number().int(),
		sound: z.number().int(),
		voice: z.number().int(),
		cached: z.number().int(),
	}),
	/** Milliseconds measuring and solving. */
	ms: z.number(),
});
export type SfxLevelsMeasure = z.infer<typeof SfxLevelsMeasureSchema>;

/** One placed cue of a plan. */
export const SoundDesignPlanEventSchema = z.object({
	/** The proposal item that places it. */
	itemId: z.string(),
	/** The stored cue, or null for a new (derived) cue … */
	cueId: z.string().nullable(),
	/** … whose derivation key this is, stored by the setup item `cueItemId`. */
	cueKey: z.string().nullable(),
	cueItemId: z.string().nullable(),
	frame,
	timecode: z.string(),
	seconds: z.number(),
	kind: z.enum(CUE_KINDS),
	weight: z.enum(CUE_WEIGHTS),
	role: z.enum(SFX_ROLES),
	align: z.enum(CUE_ALIGNS),
	/** The cue's reason (what happens in the picture). */
	cueReason: z.string(),
	/** The why-line: "<sound> on <cue reason> at <tc> · <role> · <align>". */
	why: z.string(),
	types: z.array(z.string()),
	sound: PlanSoundSchema,
	parts: SoundRankPartsSchema,
	/** Seeded varispeed (±2 %). */
	rate: z.number(),
	/** Seeded gain variation (±1 dB) the placement adds to the default level. */
	gainOffsetDb: z.number(),
	alternatives: z.array(PlanSoundSchema),
	/** Further layers on the same cue (a marker naming several types: "sfx: boom+whoosh"). */
	extraLayers: z.array(PlanSoundSchema),
	/** Decisions taken for this cue (a hero demoted under dialogue, a sound that failed to register…). */
	notes: z.array(z.string()),
	/**
	 * The solved level of the chosen sound (layer 0) against the bed (Phase 4); absent when the levels could not be
	 * measured (the placement's default level applies: see the report's warnings).
	 */
	level: SfxSolvedLevelSchema.optional(),
	/** Solved levels of the further layers, in order. */
	layerLevels: z.array(SfxSolvedLevelSchema).optional(),
	/** Solved gain of each alternative sound (same order as `alternatives`). */
	alternativeLevels: z.array(SfxSolvedLevelSchema.nullable()).optional(),
	/** Phase 4: the items that dip the music before it / build into it (style `stopBefore` / `build`). */
	stopBeforeItemId: z.string().optional(),
	buildItemId: z.string().optional(),
});
export type SoundDesignPlanEvent = z.infer<typeof SoundDesignPlanEventSchema>;

export const SOUND_DESIGN_SKIP_CODES = [
	'FILLED',
	'MUTED',
	'SILENCE',
	'DIALOGUE',
	'NO_TYPES',
	'NO_SOUND',
	'REGISTER_FAILED',
	'LIMIT',
	'NEAR_STORED',
	'STORED',
	'OUT_OF_RANGE',
] as const;

export const SoundDesignPlanSkipSchema = z.object({
	cueId: z.string().nullable(),
	cueKey: z.string().nullable(),
	frame,
	timecode: z.string(),
	kind: z.enum(CUE_KINDS),
	code: z.enum(SOUND_DESIGN_SKIP_CODES),
	reason: z.string(),
});
export type SoundDesignPlanSkip = z.infer<typeof SoundDesignPlanSkipSchema>;

export const SoundDesignPlanReportSchema = z.object({
	version: z.literal(1),
	sequenceId: z.string(),
	seed: z.number().int(),
	density: z.enum(CUE_DENSITIES),
	respectDialogue: z.boolean(),
	sources: z.array(z.enum(SOUND_SOURCE_TYPES)),
	cues: z.enum(['auto', 'ids']),
	range: z.object({ start: z.number().int(), end: z.number().int() }).nullable(),
	/** The library snapshot ranked (same snapshot + document + seed = same plan). */
	snapshotHash: z.string(),
	librarySize: z.number().int(),
	palette: z.object({ size: z.number().int(), used: z.number().int() }),
	events: z.array(SoundDesignPlanEventSchema),
	skipped: z.array(SoundDesignPlanSkipSchema),
	counts: z.object({
		/** Cues considered (stored and derived, after the range). */
		cues: z.number().int(),
		placed: z.number().int(),
		newCues: z.number().int(),
		skipped: z.number().int(),
		/** Distinct library sounds registered (chosen and alternatives). */
		sounds: z.number().int(),
		items: z.number().int(),
	}),
	warnings: z.array(z.object({ code: z.string(), message: z.string() })),
	/** Phase 4: constraints in conflict per event (the earlier one kept). */
	conflicts: z.array(SfxLevelConflictSchema).optional(),
	/** Phase 4: how the levels were measured (absent when they could not be). */
	levels: SfxLevelsMeasureSchema.optional(),
	/** Phase 4: the mixing items (room glue, delivery, stop-before dips, builds). */
	mix: z
		.object({
			roomItemId: z.string().nullable(),
			deliveryItemId: z.string().nullable(),
			delivery: z.enum(SOUND_DELIVERIES).nullable(),
			stopBefore: z.number().int(),
			build: z.number().int(),
		})
		.optional(),
});
export type SoundDesignPlanReport = z.infer<typeof SoundDesignPlanReportSchema>;

/** The `sound-design` job's result. */
export const SoundDesignPlanResultSchema = z.object({
	/** The proposal to review (null when no cue got a sound: nothing was stored). */
	proposalId: z.string().nullable(),
	projectId: z.string(),
	sequenceId: z.string(),
	/** Document revision the proposal was validated against. */
	revision: z.number().int().nullable(),
	itemCount: z.number().int(),
	/** Item states after validation. */
	counts: z
		.object({
			pending: z.number().int(),
			accepted: z.number().int(),
			rejected: z.number().int(),
			stale: z.number().int(),
			invalid: z.number().int(),
		})
		.nullable(),
	/** Items that do not apply to the document (with why). */
	invalid: z.array(z.object({ itemId: z.string(), reason: z.string() })),
	report: SoundDesignPlanReportSchema,
});
export type SoundDesignPlanResult = z.infer<typeof SoundDesignPlanResultSchema>;

// ── Rebalance SFX levels (spec 12 §2.10 `rebalance_sfx`, P4-R2) ────────────────────────────────────────────────────

export const SFX_REBALANCE_LIMITS = { maxClipIds: 2000, maxEvents: 2000 } as const;

export const SfxRebalanceRequestSchema = z
	.strictObject({
		projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'a project id'),
		/** Default: the project's first sequence. */
		sequenceId: id.optional(),
		/** Only these sound effect clips (default: every sound effect of the sequence, in `range`). */
		clipIds: z.array(id).min(1).max(SFX_REBALANCE_LIMITS.maxClipIds).optional(),
		/** Sequence frames `[start, end)`: sound effects overlapping it (default the whole sequence). */
		range: z
			.strictObject({ start: frame, end: frame })
			.refine((r) => r.end > r.start, 'range.end must be after range.start')
			.optional(),
		/** Delivery preset whose loudness and true peak the solver uses (default the sequence's). */
		delivery: z.enum(SOUND_DELIVERIES).optional(),
		/** `propose` (default): a proposal to review, one item per clip; `apply`: one undoable transaction. */
		mode: z.enum(['propose', 'apply']).optional(),
		/**
		 * Gains the user set by hand (not the default level or an earlier solve): `keep` (default) leaves them; `replace`
		 * solves them too. Clips named in `clipIds` are always solved.
		 */
		userGains: z.enum(['keep', 'replace']).optional(),
		/** Proposal title (default "Rebalance SFX Levels: <sequence>"). */
		label: z.string().min(1).max(200).optional(),
		/**
		 * Essential Sound ▸ Auto gain on (WP6.5b): the named clips are handed back to the solver in the SAME transaction
		 * (`soundDesign.setAutoGain {auto: true}` first, then the solved gains): one undo step. Clips the solve leaves
		 * unchanged lose their Auto gain off mark too; named clips it cannot measure take their recorded level. Needs
		 * `mode: 'apply'` and `clipIds`.
		 */
		autoGain: z.literal(true).optional(),
	})
	.refine((r) => r.autoGain !== true || (r.mode === 'apply' && !!r.clipIds?.length), {
		message: 'autoGain needs mode "apply" and clipIds',
		path: ['autoGain'],
	});
export type SfxRebalanceRequest = z.infer<typeof SfxRebalanceRequestSchema>;

/** One solved sound effect of a rebalance. */
export const SfxRebalanceEventSchema = SfxSolvedLevelSchema.extend({
	clipId: z.string(),
	/** The proposal item (propose mode). */
	itemId: z.string().nullable(),
	title: z.string(),
	soundId: z.string().nullable(),
	track: z.string(),
	frame,
	timecode: z.string(),
	role: z.enum(SFX_ROLES).nullable(),
	weight: z.enum(['hero', 'support', 'ambient']),
	/** Its gain before (dB) and who owned it: the default level, an earlier solve, or the user. */
	fromDb: z.number(),
	owner: z.enum(['default', 'solver', 'user']),
	/** gainDb − fromDb. */
	changeDb: z.number(),
});
export type SfxRebalanceEvent = z.infer<typeof SfxRebalanceEventSchema>;

export const SFX_REBALANCE_SKIP_CODES = ['USER_GAIN', 'LOCKED', 'NOT_IN_MIX', 'OFFLINE', 'LIMIT'] as const;

export const SfxRebalanceReportSchema = z.object({
	version: z.literal(1),
	sequenceId: z.string(),
	events: z.array(SfxRebalanceEventSchema),
	skipped: z.array(
		z.object({ clipId: z.string(), code: z.enum(SFX_REBALANCE_SKIP_CODES), reason: z.string() }),
	),
	conflicts: z.array(SfxLevelConflictSchema),
	warnings: z.array(z.object({ code: z.string(), message: z.string(), clipId: z.string().optional() })),
	counts: z.object({
		/** Sound effects considered. */
		clips: z.number().int(),
		solved: z.number().int(),
		/** Solved clips whose gain changes (≥ 0.01 dB). */
		changed: z.number().int(),
		/** Solved clips held under their target (limitedBy not empty). */
		limited: z.number().int(),
		skipped: z.number().int(),
	}),
	levels: SfxLevelsMeasureSchema,
});
export type SfxRebalanceReport = z.infer<typeof SfxRebalanceReportSchema>;

/** The rebalance job's result. */
export const SfxRebalanceResultSchema = z.object({
	projectId: z.string(),
	sequenceId: z.string(),
	mode: z.enum(['propose', 'apply']),
	/** Apply mode: the transaction ran (false when nothing changed). */
	applied: z.boolean(),
	/** The document revision after applying (apply) or the one measured (propose). */
	revision: z.number().int().nullable(),
	/** Propose mode: the stored proposal (null when nothing changes). */
	proposalId: z.string().nullable(),
	report: SfxRebalanceReportSchema,
	/** `autoGain` requests: the clips handed back to Auto gain in the transaction (absent from older engines). */
	autoGain: z.object({ clipIds: z.array(z.string()) }).optional(),
});
export type SfxRebalanceResult = z.infer<typeof SfxRebalanceResultSchema>;

// ── Delivery presets (spec 12 §2.4 "Delivery presets", P4-R4; wp-note "Phase 4 → WP4.2a") ─────────────────────────

/**
 * `POST /api/sound-design/delivery`: a `sound-design` job that measures the sequence and applies (or proposes) a delivery
 * preset — Mix loudness normalisation at the preset, Essential Sound Auto-Match by type (dialogue at the target, music
 * 8 LU and ambience 10 LU under it), music / ambience ducked under dialogue, sound effects solved again against the new
 * bed — as ONE transaction "Apply Delivery Preset" (`soundDesign.applyDelivery` + `soundDesign.applyGains`) or a proposal.
 */
export const SoundDeliveryRequestSchema = z.strictObject({
	projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'a project id'),
	sequenceId: id.optional(),
	delivery: z.enum(SOUND_DELIVERIES),
	/** `propose` (default): a proposal to review; `apply`: one undoable transaction. */
	mode: z.enum(['propose', 'apply']).optional(),
	/** Mix loudness normalisation at the preset (default true). */
	loudness: z.boolean().optional(),
	/** Auto-Match dialogue, music and ambience clips by type (default true). */
	autoMatch: z.boolean().optional(),
	/** Duck music and ambience under their "Duck against" clips (dialogue by default; default true). */
	ducking: z.boolean().optional(),
	/** Solve the sound effects again against the new bed (default true). */
	rebalance: z.boolean().optional(),
	label: z.string().min(1).max(200).optional(),
});
export type SoundDeliveryRequest = z.infer<typeof SoundDeliveryRequestSchema>;

export const SoundDeliveryClipSchema = z.object({
	clipId: z.string(),
	track: z.string(),
	type: z.string(),
	/** Integrated loudness of the clip's own signal (LUFS); null: silent or shorter than 400 ms. */
	measuredLufs: z.number().nullable(),
	targetLufs: z.number().nullable(),
	/** The Auto-Match gain (dB), or null when the clip is left as it is (`skipped` says why). */
	gainDb: z.number().nullable(),
	skipped: z.string().optional(),
});
export type SoundDeliveryClip = z.infer<typeof SoundDeliveryClipSchema>;

/** Loudness of the resulting mix (measured on the engine's export mixer). */
export const SoundDeliveryMeasureSchema = z.object({
	/** Integrated loudness / true peak before the Mix normalisation (LUFS / dBTP). */
	mixLufs: z.number().nullable(),
	mixTruePeakDb: z.number().nullable(),
	/** After the normalisation the export applies: the preset's target, and the peak under the limiter's ceiling. */
	expectedLufs: z.number().nullable(),
	expectedTruePeakDb: z.number().nullable(),
	/** Seconds of speech found (dialogue louder than −60 LUFS and within 20 LU of its loudest moment). */
	speechSeconds: z.number(),
	/** How far under the voice the music / ambience is during speech (LU; null without speech or without them). */
	musicUnderVoiceLu: z.number().nullable(),
	ambienceUnderVoiceLu: z.number().nullable(),
});
export type SoundDeliveryMeasure = z.infer<typeof SoundDeliveryMeasureSchema>;

export const SoundDeliveryReportSchema = z.object({
	version: z.literal(1),
	sequenceId: z.string(),
	delivery: z.enum(SOUND_DELIVERIES),
	preset: z.object({
		label: z.string(),
		integratedLufs: z.number(),
		truePeakDb: z.number(),
		source: z.string(),
	}),
	hasDialogue: z.boolean(),
	clips: z.array(SoundDeliveryClipSchema),
	ducking: z.array(
		z.object({ clipIds: z.array(z.string()), triggers: z.array(z.string()), regions: z.number().int() }),
	),
	/** The sound effects solved again against the new bed (null: not asked, or none). */
	sfx: z
		.object({
			solved: z.number().int(),
			changed: z.number().int(),
			limited: z.number().int(),
			skipped: z.number().int(),
		})
		.nullable(),
	measure: SoundDeliveryMeasureSchema.nullable(),
	/** Warnings, the masking solver's included (W_DIALOGUE_BAND, W_UNRESOLVED…; `clipId` names the sound effect). */
	warnings: z.array(z.object({ code: z.string(), message: z.string(), clipId: z.string().optional() })),
	/** The sound effects' constraints in conflict (the earlier, safety one kept), as rebalance_sfx reports them. */
	conflicts: z.array(SfxLevelConflictSchema).optional(),
	ms: z.number(),
});
export type SoundDeliveryReport = z.infer<typeof SoundDeliveryReportSchema>;

export const SoundDeliveryResultSchema = z.object({
	projectId: z.string(),
	sequenceId: z.string(),
	mode: z.enum(['propose', 'apply']),
	applied: z.boolean(),
	revision: z.number().int().nullable(),
	proposalId: z.string().nullable(),
	report: SoundDeliveryReportSchema,
});
export type SoundDeliveryResult = z.infer<typeof SoundDeliveryResultSchema>;

// ---------------------------------------------------------------------------------------------------------------
// `POST /api/sound-design/motion` (spec 12 §2.8, P6-R2; wp-note "Phase 6 → WP6.2"): a `motion-analysis` job that renders
// the sequence's picture small through the export planner and measures its motion frame by frame (pixel motion curve:
// the cue source for footage, Sound Check's NO_PICTURE_EVENT, `analyze_picture_motion`). Cached by the picture's
// fingerprint; nothing is stored in the project.

/** Bounds of a motion analysis. */
export const MOTION_ANALYSIS_LIMITS = {
	/** Longest range analysed at once (seconds of sequence time): analyse a longer sequence by ranges. */
	maxSeconds: 600,
	/** Long side of the analysed picture (pixels). */
	size: 128,
} as const;

export const MotionAnalysisRequestSchema = z.strictObject({
	projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'a project id'),
	/** Default: the project's first sequence. */
	sequenceId: id.optional(),
	/** Sequence frames `[start, end)` (default the whole sequence; at most 10 min). */
	range: z
		.strictObject({ start: frame, end: frame })
		.refine((r) => r.end > r.start, 'range.end must be after range.start')
		.optional(),
});
export type MotionAnalysisRequest = z.infer<typeof MotionAnalysisRequestSchema>;

/** The measured curve: index i is sequence frame `startFrame + i`, measured against the frame before it. */
export const MotionCurveSchema = z.object({
	startFrame: z.number().int(),
	fps: z.number(),
	/** Analysis picture size (pixels). */
	width: z.number().int(),
	height: z.number().int(),
	/** Speed of the moving parts (screen diagonals per second; the keyframe source's unit). */
	speed: z.array(z.number()),
	/** Mean signed velocity of the moving parts (diagonals per second; x right, y down). */
	vx: z.array(z.number()),
	vy: z.array(z.number()),
	/** Share of the frame that moves (0…1). */
	area: z.array(z.number()),
	/** Centre x of the moving parts (0 = left … 1 = right). */
	cx: z.array(z.number()),
	/** Change motion does not explain (0…1): cuts, flashes. */
	residual: z.array(z.number()),
	/** Mean absolute frame difference (0…1). */
	diff: z.array(z.number()),
});
export type MotionCurve = z.infer<typeof MotionCurveSchema>;

export const MotionEventSchema = z.object({
	kind: z.enum(['move', 'land', 'cut']),
	frame,
	timecode: z.string(),
	/** move: first frame that shows it … the frame after it arrives (exclusive). */
	start: z.number().int().optional(),
	end: z.number().int().optional(),
	peakSpeed: z.number().optional(),
	area: z.number().optional(),
	/** move: a camera move (≥ half the frame moves). */
	global: z.boolean().optional(),
	direction: z.enum(['left', 'right', 'up', 'down']).optional(),
	pan: z.number().optional(),
	panSweep: z.object({ from: z.number(), to: z.number() }).optional(),
	/** land: how it settles. */
	how: z.enum(['overshoot', 'bounce', 'abrupt stop']).optional(),
	energy: z.number().optional(),
	/** cut: the unexplained change. */
	residual: z.number().optional(),
});
export type MotionEvent = z.infer<typeof MotionEventSchema>;

export const MotionAnalysisResultSchema = z.object({
	projectId: z.string(),
	sequenceId: z.string(),
	/** The picture's fingerprint over the range (the cache key: any picture edit changes it). */
	fingerprint: z.string(),
	range: z.object({ start: z.number().int(), end: z.number().int() }),
	frameRate: z.object({ num: z.number(), den: z.number() }),
	frames: z.number().int(),
	/** Served from the cache (no render). */
	cached: z.boolean(),
	/** The export path that rendered the picture (`native`, `hybrid`, `remotion`, `copy`), null when cached. */
	renderPath: z.string().nullable(),
	curve: MotionCurveSchema,
	/** Moves, landings and cuts the curve shows (pixelMotionEvents; edit points are not repeated as cuts). */
	events: z.array(MotionEventSchema),
	/** Sequence frames of the edit points in the range (motion never spans them). */
	edits: z.array(z.number().int()),
	timings: z.object({ renderMs: z.number(), analyseMs: z.number(), totalMs: z.number() }),
	warnings: z.array(z.object({ code: z.string(), message: z.string() })),
});
export type MotionAnalysisResult = z.infer<typeof MotionAnalysisResultSchema>;

// ---------------------------------------------------------------------------------------------------------------
// `POST /api/sound-design/listen` (spec 12 §4 P6-E6; wp-note "Phase 6 → WP-E3"): a `sound-listen` job — the listening
// transcript of a range: the mix and every clip rendered (`stems.ts`), the events of the mix (onsets refined to the
// attack, swells) each attributed to the clip whose own event explains it and the cue it fills, sections by Essential
// Sound / Auto Tag class, silences, the picture events (edits, transitions, cues, cached measured motion) matched to the
// event that answers them with the CHANCE level of every sync share, and the same as chronological text lines. Nothing
// is stored in the project.

/** Bounds of a listen. */
export const SOUND_LISTEN_LIMITS = {
	/** Longest range listened to at once (seconds of sequence time). */
	maxSeconds: 600,
	/** Most transcript lines and events returned. */
	lines: 3000,
	events: 5000,
	/** Most clip lanes rendered (clips that never overlap share a lane). */
	lanes: 24,
} as const;

/**
 * How much the transcript says: `low` — sections, silences, sync, accents and picture events with no sound; `normal`
 * (default) — also every event of a placed sound and every event that answers a picture event; `high` — every event.
 */
export const SOUND_LISTEN_DETAILS = ['low', 'normal', 'high'] as const;
export type SoundListenDetail = (typeof SOUND_LISTEN_DETAILS)[number];

export const SoundListenRequestSchema = z.strictObject({
	projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'a project id'),
	/** Default: the project's first sequence. */
	sequenceId: id.optional(),
	/** Sequence frames `[start, end)` (default the whole sequence; at most 10 min). */
	range: z
		.strictObject({ start: frame, end: frame })
		.refine((r) => r.end > r.start, 'range.end must be after range.start')
		.optional(),
	detail: z.enum(SOUND_LISTEN_DETAILS).optional(),
});
export type SoundListenRequest = z.infer<typeof SoundListenRequestSchema>;

export const SOUND_LISTEN_STEMS = ['sfx', 'dialogue', 'music', 'ambience', 'other'] as const;
export const SOUND_LISTEN_PICTURE_KINDS = ['cut', 'transition', 'cue', 'motion'] as const;
export const SOUND_LISTEN_STATUSES = ['ok', 'near', 'swell', 'none'] as const;
export const SOUND_LISTEN_CLASSES = ['dialogue', 'music', 'ambience', 'effects', 'other', 'silence'] as const;
export const SOUND_LISTEN_LINE_KINDS = [
	'summary',
	'sync',
	'section',
	'event',
	'unanswered',
	'silence',
	'note',
] as const;

const ms = z.number();

/** A picture event this sound answers (`answers`) or one the transcript checks (`pictureEvents`). */
export const SoundListenPictureEventSchema = z.object({
	kind: z.enum(SOUND_LISTEN_PICTURE_KINDS),
	/** Stable key: `edit:<track>:<out>><in>`, `transition:<id>`, `cue:<id>`, `motion:<kind>:<frame>`. */
	key: z.string(),
	frame,
	timecode: z.string(),
	/** "Cut V1 "A"→"B"", "Cross Dissolve on V1", "cue cut (hero)", "picture lands (abrupt stop)". */
	label: z.string(),
	status: z.enum(SOUND_LISTEN_STATUSES),
	/** Sound − picture (ms; negative = early); null when nothing answers. */
	offsetMs: z.number().nullable(),
	/** Index into `events` of the event that answers it. */
	event: z.number().int().nullable(),
	/** Unanswered: the nearest strong onset within 250 ms (sound − picture, ms). */
	nearestStrongMs: z.number().nullable(),
	cueId: z.string().optional(),
	weight: z.enum(CUE_WEIGHTS).optional(),
});
export type SoundListenPictureEvent = z.infer<typeof SoundListenPictureEventSchema>;

export const SoundListenEventSchema = z.object({
	/** Sequence frame of the attack (onsets) or peak (swells), and the same in ms of sequence time. */
	frame,
	timecode: z.string(),
	ms,
	/**
	 * The attack as the mix shows it (ms). An event attributed by an event of its clip's own (`explainedBy: 'event'`)
	 * starts (`ms`) at the earlier of that own attack — measured without the other clips, whose bed can hide the first
	 * milliseconds — and this one.
	 */
	mixMs: ms,
	peakMs: ms,
	shape: z.enum(['hit', 'swell']),
	band: z.enum(['full', 'low', 'high']),
	/** Rise over the K-weighted bed just before (dB) and that bed (≈ LUFS as delivered; swells: dBFS RMS). */
	prominenceDb: z.number(),
	bedDb: z.number(),
	contrastDb: z.number(),
	lengthMs: z.number(),
	/** Sample peak over its first 50–300 ms (dBFS, as delivered). */
	peakDb: z.number(),
	riseMs: z.number().optional(),
	accent: z.boolean(),
	/**
	 * Found where the clip rendered alone has its own onset although the mix's onset curve does not stand out there (the
	 * mix still rises ≥ 3 dB over its bed in some band at that attack): heard, but masked more than a blind listener
	 * would notice.
	 */
	guided: z.boolean(),
	/** What plays it: the clip whose own event explains it (or, failing that, the loudest clip there). */
	stem: z.enum(SOUND_LISTEN_STEMS).nullable(),
	clipId: z.string().nullable(),
	track: z.string().nullable(),
	clipName: z.string().nullable(),
	/** The cue the clip fills (two-way link) and its role. */
	cueId: z.string().nullable(),
	cueKind: z.enum(CUE_KINDS).nullable(),
	role: z.enum(SFX_ROLES).nullable(),
	/** `event`: the clip's own event is there; `level`: no own event, the loudest clip at that moment; `none`. */
	explainedBy: z.enum(['event', 'level', 'none']),
	/** Picture events this event answers (ok / near / swell). */
	answers: z.array(
		z.object({ key: z.string(), status: z.enum(SOUND_LISTEN_STATUSES), offsetMs: z.number() }),
	),
});
export type SoundListenEvent = z.infer<typeof SoundListenEventSchema>;

export const SoundListenSectionSchema = z.object({
	start: frame,
	end: frame,
	startTimecode: z.string(),
	endTimecode: z.string(),
	classes: z.array(z.enum(SOUND_LISTEN_CLASSES)),
	label: z.string(),
	/** Energy-mean momentary loudness of the mix over it (LUFS as delivered; null: silent). */
	lufs: z.number().nullable(),
	/** Music in it: its Essential Sound ducking depth (dB, null: no ducking) and how far it sits under the voice (LU). */
	music: z.object({ duckDb: z.number().nullable(), underVoiceLu: z.number().nullable() }).optional(),
});
export type SoundListenSection = z.infer<typeof SoundListenSectionSchema>;

export const SoundListenSyncStatsSchema = z.object({
	n: z.number().int(),
	ok: z.number().int(),
	near: z.number().int(),
	swell: z.number().int(),
	none: z.number().int(),
	okShare: z.number(),
	okChance: z.number(),
	within100Share: z.number(),
	within100Chance: z.number(),
	accentOkShare: z.number().nullable(),
	accentOkChance: z.number().nullable(),
	accent100Share: z.number().nullable(),
	accent100Chance: z.number().nullable(),
	onBeatShare: z.number().nullable(),
	onBeatChance: z.number().nullable(),
	medianAbsOffsetMs: z.number().nullable(),
	frameMs: z.number(),
	spanMs: z.tuple([z.number(), z.number()]),
});
export type SoundListenSyncStats = z.infer<typeof SoundListenSyncStatsSchema>;

export const SoundListenLineSchema = z.object({
	frame,
	timecode: z.string(),
	kind: z.enum(SOUND_LISTEN_LINE_KINDS),
	/** The line as the transcript prints it (after the timecode). */
	text: z.string(),
	/** Index into `events` (event lines). */
	event: z.number().int().optional(),
	/** Picture event key (unanswered lines). */
	key: z.string().optional(),
});
export type SoundListenLine = z.infer<typeof SoundListenLineSchema>;

export const SoundListenPlacedSchema = z.object({
	clipId: z.string(),
	title: z.string(),
	track: z.string(),
	/** Where its aligned point plays (sequence ms) and its alignment. */
	alignedMs: z.number().nullable(),
	align: z.enum(CUE_ALIGNS).nullable(),
	cueId: z.string().nullable(),
	role: z.enum(SFX_ROLES).nullable(),
	/** Its own event (the clip rendered alone), relative to the aligned point (ms). */
	ownEventMs: z.number().nullable(),
	ownOffsetMs: z.number().nullable(),
	/** An event of the MIX is attributed to it within 30 ms of its own event (heard in the mix). */
	heard: z.boolean(),
	mixEvent: z.number().int().nullable(),
	prominenceDb: z.number().nullable(),
});
export type SoundListenPlaced = z.infer<typeof SoundListenPlacedSchema>;

export const SoundListenResultSchema = z.object({
	projectId: z.string(),
	sequenceId: z.string(),
	revision: z.number().int().nullable(),
	range: z.object({ start: frame, end: frame }),
	rangeTimecode: z.object({ start: z.string(), end: z.string() }),
	wholeSequence: z.boolean(),
	fps: z.object({ num: z.number().int(), den: z.number().int() }),
	detail: z.enum(SOUND_LISTEN_DETAILS),
	lines: z.array(SoundListenLineSchema),
	/** All the transcript text: one line per entry of `lines` (timecode, two spaces, text). */
	text: z.string(),
	events: z.array(SoundListenEventSchema),
	sections: z.array(SoundListenSectionSchema),
	silences: z.array(
		z.object({
			start: frame,
			end: frame,
			startTimecode: z.string(),
			kind: z.enum(['digital silence', 'near silence', 'drop']),
			levelLufs: z.number(),
			seconds: z.number(),
		}),
	),
	pictureEvents: z.array(SoundListenPictureEventSchema),
	unanswered: z.array(SoundListenPictureEventSchema),
	sync: z.object({
		cuts: SoundListenSyncStatsSchema.nullable(),
		transitions: SoundListenSyncStatsSchema.nullable(),
		cues: SoundListenSyncStatsSchema.nullable(),
		motion: SoundListenSyncStatsSchema.nullable(),
		all: SoundListenSyncStatsSchema.nullable(),
		/** Beats of the music were known (cached beat analysis): the on-beat stats are filled. */
		beatsKnown: z.boolean(),
		/** Measured picture motion was cached for the range (`analyze_picture_motion`). */
		motionAnalysed: z.boolean(),
	}),
	placed: z.array(SoundListenPlacedSchema),
	loudness: z.object({
		integratedLufs: z.number().nullable(),
		maxMomentaryLufs: z.number().nullable(),
		maxMomentaryFrame: frame.nullable(),
		maxShortTermLufs: z.number().nullable(),
		maxShortTermFrame: frame.nullable(),
		normalization: z.object({ applied: z.boolean(), gainDb: z.number(), reason: z.string().optional() }),
	}),
	counts: z.object({
		events: z.number().int(),
		accents: z.number().int(),
		swells: z.number().int(),
		sections: z.number().int(),
		silences: z.number().int(),
		pictureEvents: z.number().int(),
		unanswered: z.number().int(),
		lanes: z.number().int(),
		/** Events left out of `events` by the limit. */
		eventsDropped: z.number().int(),
	}),
	warnings: z.array(z.object({ code: z.string(), message: z.string() })),
	timings: z.record(z.string(), z.number()),
});
export type SoundListenResult = z.infer<typeof SoundListenResultSchema>;
