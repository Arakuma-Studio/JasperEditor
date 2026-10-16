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
	SFX_ROLES,
	SOUND_DESIGN_LIMITS,
} from '@jasper/project';
import { z } from 'zod';
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
		found: z.number().int(),
		kept: z.number().int(),
	}),
	warnings: z.array(
		z.object({
			code: z.string(),
			message: z.string(),
			source: z.string().optional(),
			clipId: z.string().optional(),
		}),
	),
	/** Frame ranges `[start, end)` where dialogue is heard (transcript words, Essential Sound dialogue clips). */
	dialogue: z.array(z.object({ start: z.number().int(), end: z.number().int() })),
	/** Cues already stored in the sequence. */
	storedCues: z.number().int(),
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
	/** Rotation and variation seed (default: the sequence's `soundDesign.settings.seed`). */
	seed: z.number().int().min(0).max(0xffff_ffff).optional(),
	/** Alternatives per cue, 0–3 (default 3). */
	alternatives: z.number().int().min(0).max(SOUND_DESIGN_PLAN_LIMITS.maxAlternatives).optional(),
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
	/** Decisions taken for this cue (a hero demoted under dialogue, a sound that failed to register…). */
	notes: z.array(z.string()),
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
