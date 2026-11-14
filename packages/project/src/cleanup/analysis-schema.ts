// zod schemas of a cleanup analysis (`analyzeSequenceCleanup`'s result, spec 14 TC-010 / TC-026) for the engine's
// `cleanup-analysis` job file and the clients that read it (docs/wp-notes/transcript-cleanup.md "Engine").
import { z } from 'zod';
import { CleanupSettingsSchema, FINDING_KINDS } from './schema.ts';

const Kind = z.enum(FINDING_KINDS);
const Flicks = z.number().int().min(0);

export const CleanupFindingSchema = z.object({
	id: z.string(),
	kind: Kind,
	range: z.object({ start: Flicks, end: Flicks }),
	words: z.tuple([z.number().int().min(0), z.number().int().min(0)]).nullable(),
	confidence: z.number().min(0).max(1),
	reason: z.object({ key: z.string(), params: z.record(z.string(), z.union([z.string(), z.number()])) }),
	suggested: z.enum(['remove', 'review', 'keep']),
	group: z.string().optional(),
	fingerprint: z.string(),
});

export const RetakeGroupSchema = z.object({
	id: z.string(),
	takes: z.array(
		z.object({
			range: z.object({ start: Flicks, end: Flicks }),
			words: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
			text: z.string(),
			scriptLine: z.number().int().min(0).optional(),
			meanProb: z.number().nullable(),
			complete: z.boolean(),
			coverage: z.number().optional(),
		}),
	),
	chosen: z.number().int().min(0),
});

export const CleanupStatsSchema = z.object({
	inputDuration: z.number().min(0),
	outputDuration: z.number(),
	removedByKind: z.partialRecord(Kind, z.number()),
	joins: z.number().int().min(0),
	cutsPerMinute: z.number().min(0),
	deadAirPerMinute: z.number().nullable(),
	largestSilenceLeft: z.number().nullable(),
});

export const CleanupPlanSchema = z.object({
	sequenceId: z.string(),
	clipIds: z.array(z.string()),
	ranges: z.array(z.object({ start: z.number().int(), end: z.number().int(), reasons: z.array(Kind) })),
	kept: z.array(z.object({ clipId: z.string(), start: z.number().int(), end: z.number().int() })),
	stats: CleanupStatsSchema,
	skipped: z.array(z.object({ findingId: z.string(), reason: z.literal('harsh-cut') })),
	fadeMs: z.number(),
	jlFrames: z.number().int(),
});

/** A repeat in the edit (`EditRepeat`, `edit-repeats.ts`). */
export const EditRepeatSchema = z.object({
	source: z.enum(['spans', 'mix']),
	where: z.enum(['cut', 'span']),
	kind: z.enum(['restart', 'false-start', 'retake', 'stutter']),
	suggested: z.enum(['remove', 'review']),
	text: z.string().max(2000),
	kept: z.string().max(2000),
	range: z.tuple([z.number().int(), z.number().int()]),
	cuts: z
		.array(
			z.object({
				clipId: z.string(),
				mediaId: z.string(),
				stream: z.number().int().min(0),
				start: Flicks,
				end: Flicks,
			}),
		)
		.max(1000),
	confidence: z.number().min(0).max(1),
	held: z.enum(['decode', 'closure']).optional(),
	copy: z.literal('later').optional(),
});

export const CleanupAnalysisSchema = z.object({
	ok: z.literal(true),
	settings: CleanupSettingsSchema,
	findings: z.array(CleanupFindingSchema),
	groups: z.array(RetakeGroupSchema),
	script: z
		.array(
			z.object({ index: z.number().int(), text: z.string(), said: z.boolean(), takes: z.number().int() }),
		)
		.nullable(),
	media: z.array(
		z.object({
			mediaId: z.string(),
			stream: z.number().int(),
			transcriptId: z.string(),
			language: z.string().nullable(),
			voice: z.boolean(),
			edgeMode: z.enum(['level', 'speech', 'word']),
			clipIds: z.array(z.string()),
		}),
	),
	plan: CleanupPlanSchema,
	/** Absent in analyses of older builds. */
	cutEdges: z
		.array(
			z.object({
				clipId: z.string(),
				trackId: z.string(),
				side: z.enum(['in', 'out']),
				frame: z.number().int(),
				mediaId: z.string(),
				mediaSeconds: z.number(),
				reason: z.enum(['speech', 'sound', 'inside-word']),
				awayDb: z.number(),
				word: z.string().nullable(),
				fixFrame: z.number().int().nullable(),
			}),
		)
		.optional(),
	editRepeats: z.array(EditRepeatSchema).max(100_000).optional(),
});
