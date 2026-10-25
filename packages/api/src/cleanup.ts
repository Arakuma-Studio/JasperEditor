// Transcript cleanup over HTTP (spec 14; docs/wp-notes/transcript-cleanup.md "Engine"): the `cleanup-analysis` job
// (voice analyses of a sequence's speech media + detector + planner → findings, retake groups, plan, statistics) and
// the user's cleanup presets (one library per appdir, like the effect presets).
import {
	CleanupAnalysisSchema,
	CleanupOverridesSchema,
	CleanupPresetSchema,
	CleanupStatsSchema,
	FINDING_KINDS,
} from '@jasper/project';
import { z } from 'zod';

const Kind = z.enum(FINDING_KINDS);

/** `POST /api/cleanup/analyze[?wait=1]` → a `cleanup-analysis` job (result `CleanupAnalysisJobResult`). */
export const CleanupAnalyzeRequestSchema = z
	.object({
		projectId: z.string().min(1).max(200),
		/** Default: the project's only sequence. */
		sequenceId: z.string().min(1).max(200).optional(),
		/**
		 * The project as the caller sees it (an envelope or a bare document: an editor or agent with unsaved edits);
		 * default: the saved project.
		 */
		document: z.unknown().optional(),
		/** Scope: these clips (with their linked partners and groups) and / or this frame range. */
		clipIds: z.array(z.string().min(1).max(200)).max(10_000).optional(),
		range: z
			.object({ from: z.number().int().min(0), to: z.number().int().min(1) })
			.strict()
			.optional(),
		/** Preset (`builtin.fast`, `builtin.natural` or a user preset id) and overrides; default the sequence's. */
		presetId: z.string().min(1).max(200).optional(),
		overrides: CleanupOverridesSchema.optional(),
		/** Script text; null = none; default the sequence's attached script. */
		script: z.string().max(262_144).nullable().optional(),
		language: z.string().min(1).max(35).optional(),
		decisions: z
			.object({
				accept: z.array(z.string().max(300)).max(100_000).optional(),
				reject: z.array(z.string().max(300)).max(100_000).optional(),
				acceptKinds: z.array(Kind).optional(),
				rejectKinds: z.array(Kind).optional(),
				retakes: z.record(z.string().max(50), z.number().int().min(0)).optional(),
			})
			.strict()
			.optional(),
		/** Run missing voice analyses (default true); false = media without one are planned in word mode. */
		analyzeVoice: z.boolean().optional(),
	})
	.strict();
export type CleanupAnalyzeRequest = z.infer<typeof CleanupAnalyzeRequestSchema>;

/** The `cleanup-analysis` job's result: totals and where the full analysis is (`GET` its `url`). */
export const CleanupAnalysisJobResultSchema = z.object({
	analysisId: z.string(),
	url: z.string(),
	projectId: z.string(),
	sequenceId: z.string(),
	findings: z.number().int().min(0),
	byKind: z.partialRecord(Kind, z.number().int().min(0)),
	groups: z.number().int().min(0),
	ranges: z.number().int().min(0),
	stats: CleanupStatsSchema,
	/** Media whose voice analysis was read from the cache / computed now / unavailable (planned in word mode). */
	voice: z.object({
		cached: z.array(z.string()),
		analysed: z.array(z.string()),
		missing: z.array(z.object({ mediaId: z.string(), reason: z.string() })),
	}),
	elapsedMs: z.number().min(0),
});
export type CleanupAnalysisJobResult = z.infer<typeof CleanupAnalysisJobResultSchema>;

/** `GET /api/cleanup/analyses/:analysisId` → the analysis (kept in memory for the 16 newest jobs). */
export const CleanupAnalysisFileSchema = z.object({
	format: z.literal('jasper-cleanup-analysis'),
	version: z.literal(1),
	analysisId: z.string(),
	projectId: z.string(),
	sequenceId: z.string(),
	/** Document revision analysed (−1 for a document sent with the request). */
	revision: z.number().int(),
	createdAt: z.string(),
	analysis: CleanupAnalysisSchema,
});
export type CleanupAnalysisFile = z.infer<typeof CleanupAnalysisFileSchema>;

export const CleanupPresetLibraryResponseSchema = z.object({
	/** Bumped on every change (the `cleanupPresets.changed` event carries it). */
	revision: z.number().int().min(0),
	/** User presets (the built-ins, `builtin.fast` / `builtin.natural`, come from @jasper/project). */
	presets: z.array(CleanupPresetSchema),
});
export type CleanupPresetLibraryResponse = z.infer<typeof CleanupPresetLibraryResponseSchema>;

/** A new user preset: the engine assigns its id (`cup_…`). */
export const CleanupPresetCreateRequestSchema = z
	.object({
		name: z.string().trim().min(1).max(200),
		description: z.string().max(2000).optional(),
		basedOn: z.enum(['builtin.fast', 'builtin.natural']).optional(),
		settings: CleanupOverridesSchema,
	})
	.strict();
export const CleanupPresetUpdateRequestSchema = z
	.object({
		name: z.string().trim().min(1).max(200).optional(),
		description: z.string().max(2000).optional(),
		basedOn: z.enum(['builtin.fast', 'builtin.natural']).optional(),
		settings: CleanupOverridesSchema.optional(),
	})
	.strict();
export const CleanupPresetDeleteResponseSchema = z.object({ ok: z.literal(true), removed: z.string() });
