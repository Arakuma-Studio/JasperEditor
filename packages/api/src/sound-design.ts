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
	SOUND_DESIGN_LIMITS,
} from '@jasper/project';
import { z } from 'zod';
import { EnvelopeSchema } from './projects.ts';

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
