// Fix Transcript (spec 17 SC-090; docs/wp-notes/script-correction.md "Fix job, API and MCP"):
//   POST /api/projects/:projectId/sequences/:sequenceId/transcript-fix[?wait=1]
//     → 202 a `transcript-fix` job (identical requests while one runs return that job); its result is
//       `TranscriptFixResult`. `mode: 'dryRun'` = the fast pre-run (alignment, candidates, the fixes decided without
//       audio, the patch report, the windows to score and an estimated scoring time; nothing stored); `propose` = the
//       full run (the audio decides each candidate) storing ONE proposal of feature `transcript-correction`;
//       `rebuild` = Rebuild from script for the kept speech: the media spans the sequence's audio clips play are
//       transcribed again from the raw audio (VAD chunks, best accuracy), aligned to the script span by span, and
//       ONE proposal writes them back (an item per span, each one `transcript.replaceWords`).
// Unset fields take the sequence's stored Fix Transcript settings (`Sequence.scriptFix.settings`, SC-055), else the
// defaults (script + glossary, whole recordings, Standard).
import { z } from 'zod';

export const TRANSCRIPT_FIX_SOURCES = ['script', 'glossary'] as const;
/** SC-063: whole recordings / only the words the sequence uses / the words used inside In–Out. */
export const TRANSCRIPT_FIX_SCOPES = ['recordings', 'used', 'inOut'] as const;
export const TRANSCRIPT_FIX_STRICTNESS = ['careful', 'standard', 'generous'] as const;
export const TRANSCRIPT_FIX_MODES = ['propose', 'dryRun', 'rebuild'] as const;
/** Rebuild: words heard that the script does not have are dropped (default) or kept as heard. */
export const TRANSCRIPT_FIX_OFF_SCRIPT = ['drop', 'keep'] as const;

export const TranscriptFixRequestSchema = z.strictObject({
	sources: z
		.array(z.enum(TRANSCRIPT_FIX_SOURCES))
		.min(1)
		.max(2)
		.refine((l) => new Set(l).size === l.length, 'sources are listed once')
		.optional(),
	scope: z.enum(TRANSCRIPT_FIX_SCOPES).optional(),
	strictness: z.enum(TRANSCRIPT_FIX_STRICTNESS).optional(),
	/** Offer the fixes the user rejected before (SC-055), unselected. */
	showRejected: z.boolean().optional(),
	mode: z.enum(TRANSCRIPT_FIX_MODES).optional(),
	/** `rebuild` only: heard words the script does not have are dropped (default) or kept (off-script speech). */
	offScript: z.enum(TRANSCRIPT_FIX_OFF_SCRIPT).optional(),
	/** Speech processor for the audio check (default: the Transcription preference). */
	device: z.enum(['auto', 'cpu', 'gpu']).optional(),
});
export type TranscriptFixRequest = z.infer<typeof TranscriptFixRequestSchema>;

const Counts = z.record(z.string(), z.number().int().min(0));
const Warning = z.object({ code: z.string(), message: z.string() });

/** Per media transcript in scope: the aligner's report (SC-016) and what the job did with it. */
export const TranscriptFixMediaReportSchema = z.looseObject({
	mediaId: z.string(),
	transcriptId: z.string(),
	name: z.string(),
	language: z.string(),
	/** Transcript words / words in scope. */
	words: z.number().int().min(0),
	wordsInScope: z.number().int().min(0),
	/** The aligner's report (null: no script source, or the alignment was refused). */
	alignment: z
		.looseObject({
			transcriptTokens: z.number(),
			scriptTokens: z.number(),
			alignedShare: z.number(),
			offScriptShare: z.number(),
			retakeJumps: z.number(),
			unusedLines: z.array(z.number()),
		})
		.nullable(),
	candidates: z.number().int().min(0),
	/** Windows sent to the audio check (dry run: that would be sent) and their readings. */
	windows: z.number().int().min(0),
	readings: z.number().int().min(0),
	/** Why the audio check could not run for this media (offline, no audio…): its candidates stay unscored. */
	unscored: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type TranscriptFixMediaReport = z.infer<typeof TranscriptFixMediaReportSchema>;

/** One decided candidate (the list is capped; the counts are not). */
export const TranscriptFixDecisionSchema = z.object({
	itemId: z.string().optional(),
	candidateId: z.string(),
	fingerprint: z.string(),
	mediaId: z.string(),
	kind: z.string(),
	category: z.string(),
	asr: z.array(z.string()),
	script: z.array(z.string()),
	/** fix | maybe | keep | pending (dry run: needs the audio check). */
	decision: z.string(),
	group: z.string().nullable(),
	rule: z.string(),
	deltaTok: z.number().nullable(),
	start: z.number(),
	end: z.number(),
	rejected: z.boolean().optional(),
});
export type TranscriptFixDecisionJson = z.infer<typeof TranscriptFixDecisionSchema>;

export const TranscriptFixReportSchema = z.object({
	settings: z.object({
		sources: z.array(z.enum(TRANSCRIPT_FIX_SOURCES)),
		scope: z.enum(TRANSCRIPT_FIX_SCOPES),
		strictness: z.enum(TRANSCRIPT_FIX_STRICTNESS),
		showRejected: z.boolean(),
	}),
	/** The sources that really took part (script attached, glossary entries present). */
	sourcesUsed: z.array(z.enum(TRANSCRIPT_FIX_SOURCES)),
	perMedia: z.array(TranscriptFixMediaReportSchema),
	/** Counts of the candidates by group (fix, spelling, maybe, keep, pending), category and kind. */
	candidates: z.object({ total: z.number().int(), byGroup: Counts, byCategory: Counts, byKind: Counts }),
	decisions: z.array(TranscriptFixDecisionSchema),
	decisionsTruncated: z.boolean(),
	/** Regions not offered, by reason (SC-021/022 reasons, `rejected`, `overlap`, `unplaced`, `scope`, `limit`). */
	skipped: Counts,
	/** Script lines (0-based) none of whose words were heard in any media. */
	unusedLines: z.array(z.number().int()),
	/** The patch report of the fixes (`planReplaceWords`, SC-053): subtitles / caption clips patched or skipped. */
	patch: z.object({
		edits: z.number().int(),
		patched: z.number().int(),
		skipped: z.array(
			z.object({ clipId: z.string(), sequenceId: z.string(), kind: z.string(), reason: z.string() }),
		),
		stale: z.number().int(),
	}),
	speech: z.object({
		model: z.string().nullable(),
		/** Why there is no usable model (dry run: reported; propose: refused). */
		problem: z.string().optional(),
	}),
	/** Processor used for the audio check (propose; null when nothing was scored). */
	device: z.unknown().nullable(),
	fallback: z.unknown().optional(),
	/** Dry run: ≈ seconds the audio check would take here, and the basis of the estimate. */
	estimate: z
		.object({
			seconds: z.number(),
			windows: z.number().int(),
			readings: z.number().int(),
			basis: z.enum(['measured', 'reference']),
			note: z.string(),
		})
		.optional(),
	timings: z.object({
		readMs: z.number(),
		alignMs: z.number(),
		scoreMs: z.number(),
		decideMs: z.number(),
		totalMs: z.number(),
		/** Seconds of speech in scope (sum of the words' spans). */
		speechSeconds: z.number(),
		/**
		 * The speech worker's split of the audio check (ms, summed over the media; one worker call per media): model load,
		 * media decode, encoder and decoder time, the worker's scoring wall time, encoder passes, decoder runs, readings,
		 * seconds of encoded audio.
		 */
		speech: z
			.object({
				loadMs: z.number(),
				decodeMs: z.number(),
				encoderMs: z.number(),
				decoderMs: z.number(),
				workerScoreMs: z.number(),
				encoderPasses: z.number().int(),
				decoderRuns: z.number().int(),
				readings: z.number().int(),
				windowSec: z.number(),
				calls: z.number().int(),
			})
			.optional(),
	}),
	/** `rebuild`: what was transcribed again and written from the script. */
	rebuild: z
		.object({
			offScript: z.enum(TRANSCRIPT_FIX_OFF_SCRIPT),
			/** Kept spans (merged per media) and how many change. */
			spans: z.number().int().min(0),
			changedSpans: z.number().int().min(0),
			/** Seconds of kept speech transcribed again. */
			seconds: z.number(),
			/** Words heard / written; per rule (exact, replaced, inserted, emoticons, dropped, kept). */
			heardWords: z.number().int().min(0),
			writtenWords: z.number().int().min(0),
			counts: Counts,
			/** Spans with nothing of the script heard (their heard words are written as heard). */
			offScriptSpans: z.number().int().min(0),
			/** Spans where nothing was heard (their words are left as they are). */
			silentSpans: z.number().int().min(0),
			/** Spans that could not be written in ≤ 64-word edits (left as they are). */
			unwritableSpans: z.number().int().min(0),
			/** Speech model, language and device of the re-transcription. */
			model: z.string().nullable(),
		})
		.optional(),
	/** What the bounded-memory caps cut short (absent when nothing was). */
	guard: z
		.object({
			candidatesCapped: z.number().int(),
			itemsCapped: z.number().int(),
		})
		.optional(),
	warnings: z.array(Warning),
});
export type TranscriptFixReport = z.infer<typeof TranscriptFixReportSchema>;

export const TranscriptFixResultSchema = z.object({
	mode: z.enum(TRANSCRIPT_FIX_MODES),
	projectId: z.string(),
	sequenceId: z.string(),
	/** The stored proposal (propose with something to fix), else null. */
	proposalId: z.string().nullable(),
	itemCount: z.number().int().min(0),
	revision: z.number().int().nullable(),
	report: TranscriptFixReportSchema,
});
export type TranscriptFixResult = z.infer<typeof TranscriptFixResultSchema>;
