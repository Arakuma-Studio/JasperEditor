// Sound Check route contracts (spec 12 §2.6, §2.8, P5-R1/R2; wp-note "Phase 5 → WP5.1"):
//   POST /api/sound-design/check   a `sound-check` job (202): the final mix (loudness normalised as the export does) and
//                                  its stems rendered in one pass, voice activity, 10 ms curves; every finding with a
//                                  code, severity, translatable message and (where one exists) a machine-actionable fix;
//                                  five listen-here moments; a per-event table; a verdict. `store: true` also writes the
//                                  summary into the sequence (`soundDesign.setCheck`, one undo step).
//   POST /api/sound-design/visual  10 ms loudness curves of the mix and its stems, the mix waveform, cue ticks, the motion
//                                  curve and (from a check job) the findings over a bounded range: what the MCP pictures
//                                  and the web panel draw.
import {
	CUE_KINDS,
	CUE_WEIGHTS,
	SFX_ROLES,
	SOUND_CHECK_CODES,
	SOUND_CHECK_SEVERITIES,
	SOUND_CHECK_TARGET_LIMITS,
	SOUND_CHECK_VERDICTS,
	SOUND_DELIVERIES,
	SOUND_DESIGN_LIMITS,
} from '@jasper/project';
import { z } from 'zod';

const frame = z.number().int().min(0).max(SOUND_DESIGN_LIMITS.maxFrame);
const id = z.string().min(1).max(128);

export const SOUND_CHECK_LIMITS = {
	/** Longest range one visual request renders (seconds). */
	visualMaxSec: 120,
	/** Points of each report curve (the report's curves are max-pooled to at most this). */
	reportCurvePoints: 1200,
	/** Findings and event rows kept in a report. */
	issues: 2000,
	events: 2000,
} as const;

export const SoundCheckRangeSchema = z
	.strictObject({ start: frame, end: frame })
	.refine((r) => r.end > r.start, 'range.end must be after range.start');

export const SoundCheckRequestSchema = z.strictObject({
	projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'a project id'),
	/** Default: the project's first sequence. */
	sequenceId: id.optional(),
	/** Delivery preset the loudness is checked against (default the sequence's). */
	preset: z.enum(SOUND_DELIVERIES).optional(),
	/**
	 * A custom delivery target checked instead of the preset's numbers (integrated LUFS, true-peak ceiling dBTP); the
	 * preset still sets the default sound-effect levels the solver-based checks use.
	 */
	target: z
		.strictObject({
			integratedLufs: z
				.number()
				.min(SOUND_CHECK_TARGET_LIMITS.integratedLufs.min)
				.max(SOUND_CHECK_TARGET_LIMITS.integratedLufs.max),
			truePeakDb: z
				.number()
				.min(SOUND_CHECK_TARGET_LIMITS.truePeakDb.min)
				.max(SOUND_CHECK_TARGET_LIMITS.truePeakDb.max),
		})
		.optional(),
	/** Sequence frames `[start, end)` (default the whole sequence). */
	range: SoundCheckRangeSchema.optional(),
	/** Also store the summary in the sequence (`soundDesign.setCheck`, one undo step "Sound Check Result"). */
	store: z.boolean().optional(),
});
export type SoundCheckRequest = z.infer<typeof SoundCheckRequestSchema>;

/** A translatable text: `key` is the English template (`{0}`… placeholders), `params` fill it, `text` is filled. */
export const SoundCheckMessageSchema = z.object({
	key: z.string(),
	params: z.array(z.union([z.string(), z.number()])),
	text: z.string(),
});
export type SoundCheckMessageJson = z.infer<typeof SoundCheckMessageSchema>;

export const SOUND_CHECK_FIX_KINDS = ['commands', 'job', 'swap'] as const;

/**
 * A fix that resolves a finding, ready to run:
 * - `commands`: ONE transaction of these commands (`POST /api/agent/tx`, MCP `apply_commands`);
 * - `job`: an engine job — `rebalance` (`POST /api/sound-design/rebalance`) or `delivery` (`…/delivery`) with `body`;
 * - `swap`: register library sound `soundId` in the project and swap clip `clipId` to it (MCP `swap_sound`).
 * `tool` + `args` is the same as one MCP tool call. `safe`: it only changes what the finding is about, is one undo step
 * and resolves the finding on a re-check (checked by simulation where the outcome is predictable); unsafe fixes need
 * the user's judgement (`why`).
 */
export const SoundCheckFixSchema = z.object({
	kind: z.enum(SOUND_CHECK_FIX_KINDS),
	label: SoundCheckMessageSchema,
	safe: z.boolean(),
	why: z.string().optional(),
	/** `why` as a translatable message (template + params), when the engine gives one. */
	whyMessage: SoundCheckMessageSchema.optional(),
	tool: z.string(),
	args: z.record(z.string(), z.unknown()),
	commands: z.array(z.looseObject({ type: z.string() })).optional(),
	job: z
		.object({ route: z.enum(['rebalance', 'delivery']), body: z.record(z.string(), z.unknown()) })
		.optional(),
	swap: z.object({ clipId: z.string(), soundId: z.string() }).optional(),
	/**
	 * Safe on its own but not applied with the safe fixes before it (`planSoundCheckFixes`): the findings whose fixes it
	 * conflicts with (`safe` is then false and `why` says what it would do). Absent when it is not safe on its own.
	 */
	conflictsWith: z.array(z.string()).optional(),
});
export type SoundCheckFix = z.infer<typeof SoundCheckFixSchema>;

/** What the check measured about one sound effect, linear in its clip gain (`SoundCheckLevelModel`). */
export const SoundCheckLevelModelSchema = z.object({
	clipId: z.string(),
	title: z.string(),
	gainDb: z.number(),
	liftAt0Db: z.number().nullable(),
	peakOverBedAt0Lu: z.number().nullable(),
	truePeakAt0Db: z.number().nullable(),
	mixTruePeakDb: z.number().nullable(),
	start: z.number(),
	end: z.number(),
	speech: z.boolean(),
	/**
	 * The sound effects overlapping it (WP6.5b, the solver's inter-SFX masking): `liftAt0Db` is over the bed plus those of
	 * a lower weight (`weight`, the sound's own at the check) at their checked gains; with other gains or weights the
	 * masked bed is max(floor, 10·log10(10^(bedDomDb/10) + Σ 10^((at0Db + gain)/10))) over the terms whose weight ranks
	 * under the sound's. Absent: no overlapping sound effect (or a report before it).
	 */
	masking: z
		.object({
			weight: z.enum(['hero', 'support', 'ambient']),
			bedDomDb: z.number(),
			terms: z
				.array(
					z.object({
						clipId: z.string(),
						weight: z.enum(['hero', 'support', 'ambient']),
						gainDb: z.number(),
						at0Db: z.number(),
					}),
				)
				.max(64),
		})
		.optional(),
});

/**
 * The numbers safe fixes are judged by together (`planSoundCheckFixes`, WP6.5b): the delivery's and the solver's
 * true-peak ceilings, the bed caps by weight and each measured sound effect. Absent from reports before WP6.5b.
 */
export const SoundCheckLevelGuardSchema = z.object({
	ceilingDb: z.number(),
	eventCeilingDb: z.number(),
	bedCapLu: z.object({ hero: z.number(), support: z.number(), ambient: z.number() }),
	capToleranceLu: z.number(),
	levels: z.array(SoundCheckLevelModelSchema).max(2000),
});
export type SoundCheckLevelGuardJson = z.infer<typeof SoundCheckLevelGuardSchema>;

export const SoundCheckIssueSchema = z.object({
	/** Stable within a report (`<code>:<subject>`), e.g. `OUT_OF_SYNC:clp_…`. */
	id: z.string(),
	code: z.enum(SOUND_CHECK_CODES),
	severity: z.enum(SOUND_CHECK_SEVERITIES),
	category: z.enum(['loudness', 'sync', 'mix', 'cues', 'licence']),
	/** Where to look (sequence frame) and its timecode. */
	frame: frame.optional(),
	timecode: z.string().optional(),
	/** Sequence frames `[start, end)` the finding spans. */
	range: z.object({ start: frame, end: frame }).optional(),
	clipIds: z.array(z.string()).optional(),
	cueId: z.string().optional(),
	message: SoundCheckMessageSchema,
	/** The measured numbers behind it (offsetMs, liftDb, underLu…). */
	measured: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()])).optional(),
	fix: SoundCheckFixSchema.optional(),
});
export type SoundCheckIssue = z.infer<typeof SoundCheckIssueSchema>;

/** One row of the per-event table: a sound effect of the sequence and what was measured about it. */
export const SoundCheckEventSchema = z.object({
	clipId: z.string(),
	cueId: z.string().nullable(),
	title: z.string(),
	track: z.string(),
	role: z.enum(SFX_ROLES).nullable(),
	weight: z.enum(CUE_WEIGHTS),
	soundId: z.string().nullable(),
	license: z.string().nullable(),
	/** The frame it should land on (its cue's), else its aligned point / start. */
	frame,
	timecode: z.string(),
	cueKind: z.enum(CUE_KINDS).nullable(),
	align: z.enum(['peak', 'start', 'end']).nullable(),
	/** Sync: tolerance (frames), measured offset of its aligned point from the cue (ms, + = late), correlation. */
	toleranceFrames: z.number().nullable(),
	offsetMs: z.number().nullable(),
	located: z.enum(['found', 'not-found', 'not-measured']),
	correlation: z.number().nullable(),
	/** Level: clip gain, dominant-band lift over the bed (solver definition), the minimum and the solver's target. */
	gainDb: z.number(),
	liftDb: z.number().nullable(),
	minLiftDb: z.number().nullable(),
	targetLiftDb: z.number().nullable(),
	peakOverBedLu: z.number().nullable(),
	bedCapLu: z.number().nullable(),
	speech: z.boolean(),
	status: z.enum(['pass', 'warn', 'fail']),
	/** Codes of the findings about this clip. */
	codes: z.array(z.enum(SOUND_CHECK_CODES)),
});
export type SoundCheckEvent = z.infer<typeof SoundCheckEventSchema>;

export const SOUND_CHECK_LISTEN_SLOTS = ['worst', 'hero', 'loudest', 'densest', 'passing'] as const;

/** A moment the user should listen to (spec 12 §2.6 listen[5]). */
export const SoundCheckListenSchema = z.object({
	slot: z.enum(SOUND_CHECK_LISTEN_SLOTS),
	frame,
	timecode: z.string(),
	seconds: z.number(),
	why: SoundCheckMessageSchema,
	issueId: z.string().optional(),
	clipId: z.string().optional(),
	cueId: z.string().optional(),
});
export type SoundCheckListen = z.infer<typeof SoundCheckListenSchema>;

/** Momentary loudness curves (LUFS, centred 400 ms windows) max-pooled to ≤ 1200 points, as delivered. */
export const SoundCheckCurvesSchema = z.object({
	/** Seconds between points (a multiple of 0.01) and the sequence time of the first point. */
	hopSec: z.number(),
	startSec: z.number(),
	points: z.number().int(),
	window: z.literal('momentary'),
	mix: z.array(z.number()),
	bed: z.array(z.number()),
	sfx: z.array(z.number()),
	music: z.array(z.number()),
	dialogue: z.array(z.number()),
	ambience: z.array(z.number()),
	/** Gain reduction of the export's limiter (dB ≥ 0); empty without loudness normalisation. */
	limiterGrDb: z.array(z.number()),
});
export type SoundCheckCurves = z.infer<typeof SoundCheckCurvesSchema>;

export const SoundCheckLoudnessSchema = z.object({
	/** Of the delivered mix (normalised and limited when the Mix normalises; else the mix itself). */
	integratedLufs: z.number().nullable(),
	truePeakDb: z.number().nullable(),
	samplePeakDb: z.number().nullable(),
	lra: z.number().nullable(),
	maxMomentaryLufs: z.number().nullable(),
	maxShortTermLufs: z.number().nullable(),
	/** Seconds of audible (gated-in) audio; under 0.4 s the integrated loudness is not measurable. */
	measurable: z.boolean(),
	normalization: z.object({
		enabled: z.boolean(),
		targetLufs: z.number().nullable(),
		truePeakDb: z.number().nullable(),
		gainDb: z.number().nullable(),
	}),
	limiterMaxGrDb: z.number().nullable(),
	/** Channel layout the mix was checked in: the Mix's own (WP6.5b; absent from older reports: stereo or 5.1). */
	layout: z.enum(['mono', 'stereo', '5.1']).optional(),
	before: z.object({
		integratedLufs: z.number().nullable(),
		truePeakDb: z.number().nullable(),
		samplePeakDb: z.number().nullable(),
	}),
});
export type SoundCheckLoudness = z.infer<typeof SoundCheckLoudnessSchema>;

export const SoundCheckReportSchema = z.object({
	version: z.literal(1),
	projectId: z.string(),
	sequenceId: z.string(),
	/** Document revision checked. */
	revision: z.number().int().nullable(),
	/** `mixFingerprint` and `soundCheckInputsHash` of what was checked (staleness, `soundCheckStatus`). */
	mixHash: z.string(),
	inputsHash: z.string(),
	preset: z.object({
		id: z.enum(SOUND_DELIVERIES),
		label: z.string(),
		integratedLufs: z.number(),
		truePeakDb: z.number(),
		source: z.string(),
		/** Checked against a custom target (`request.target`): the numbers above are it, `id` the preset behind it. */
		custom: z.boolean().optional(),
	}),
	range: z.object({ start: frame, end: frame }),
	rangeTimecode: z.object({ start: z.string(), end: z.string() }),
	wholeSequence: z.boolean(),
	fps: z.object({ num: z.number().int(), den: z.number().int() }),
	durationSec: z.number(),
	verdict: z.enum(SOUND_CHECK_VERDICTS),
	counts: z.record(z.string(), z.number().int()),
	issues: z.array(SoundCheckIssueSchema),
	events: z.array(SoundCheckEventSchema),
	listen: z.array(SoundCheckListenSchema),
	loudness: SoundCheckLoudnessSchema,
	curves: SoundCheckCurvesSchema,
	speech: z.object({ seconds: z.number(), segments: z.array(z.tuple([z.number(), z.number()])) }),
	/** Clips per stem (sfx, dialogue, music, ambience, bed = everything that is not a sound effect). */
	stems: z.record(z.string(), z.number().int()),
	warnings: z.array(z.object({ code: z.string(), message: z.string() })),
	timings: z.record(z.string(), z.number()),
	levelGuard: SoundCheckLevelGuardSchema.optional(),
});
export type SoundCheckReport = z.infer<typeof SoundCheckReportSchema>;

/** The `sound-check` job's result. */
export const SoundCheckResultSchema = z.object({
	projectId: z.string(),
	sequenceId: z.string(),
	/** The summary was stored (`store: true`) and the document revision after it. */
	stored: z.boolean(),
	revision: z.number().int().nullable(),
	report: SoundCheckReportSchema,
});
export type SoundCheckResult = z.infer<typeof SoundCheckResultSchema>;

/**
 * The last full Sound Check report of a sequence, kept by the engine across restarts (Phase 5 verification, follow-up
 * (e)): `POST /api/sound-design/check/last`. `state` compares the report with the live document — `stale` when the mix
 * (`mixFingerprint`) or the other inputs (`soundCheckInputsHash`: cues, loudness settings, credits, the target) changed.
 */
export const SoundCheckLastRequestSchema = z.strictObject({
	projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'a project id'),
	/** Default: the project's first sequence. */
	sequenceId: id.optional(),
});
export type SoundCheckLastRequest = z.infer<typeof SoundCheckLastRequestSchema>;

export const SoundCheckLastResponseSchema = z.object({
	projectId: z.string(),
	sequenceId: z.string(),
	/** The job that produced it (the engine may have forgotten the job since). */
	jobId: z.string().nullable(),
	savedAt: z.string(),
	state: z.enum(['current', 'stale']),
	reasons: z.array(z.enum(['mix', 'inputs'])),
	result: SoundCheckResultSchema,
});
export type SoundCheckLastResponse = z.infer<typeof SoundCheckLastResponseSchema>;

export const SoundVisualRequestSchema = z.strictObject({
	projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'a project id'),
	sequenceId: id.optional(),
	/** Sequence frames `[start, end)`: at most 120 s. */
	range: SoundCheckRangeSchema,
	/** A finished `sound-check` job whose findings are flagged over the range. */
	checkJobId: z.string().min(1).max(128).optional(),
});
export type SoundVisualRequest = z.infer<typeof SoundVisualRequestSchema>;

const StemCurveSchema = z.object({ momentary: z.array(z.number()), shortTerm: z.array(z.number()) });

export const SoundVisualResponseSchema = z.object({
	projectId: z.string(),
	sequenceId: z.string(),
	range: z.object({ start: frame, end: frame }),
	rangeTimecode: z.object({ start: z.string(), end: z.string() }),
	fps: z.object({ num: z.number().int(), den: z.number().int() }),
	/** 0.01 s; point i is at `startSec + i · hopSec`. */
	hopSec: z.number(),
	startSec: z.number(),
	points: z.number().int(),
	/**
	 * Curves are shown as delivered when the Mix normalises and its stored analysis is current (`gainDb` added to every
	 * stem); otherwise as mixed (`applied: false`, `reason`).
	 */
	normalization: z.object({ applied: z.boolean(), gainDb: z.number(), reason: z.string().optional() }),
	/** LUFS per stem (floored at −120): momentary (400 ms) and short-term (3 s), centred windows. */
	curves: z.object({
		mix: StemCurveSchema,
		bed: StemCurveSchema,
		sfx: StemCurveSchema,
		music: StemCurveSchema,
		dialogue: StemCurveSchema,
		ambience: StemCurveSchema,
	}),
	/** Mix waveform per 10 ms: the sample peak (dBFS, floored at −120). */
	waveformPeakDb: z.array(z.number()),
	/**
	 * The same 10 ms sample peaks of the sound-effects stem and of the bed (everything else), as delivered — the sync
	 * strip draws the sound effects over the bed. Absent from engines before the Phase 5 verification.
	 */
	stemPeakDb: z.object({ sfx: z.array(z.number()), bed: z.array(z.number()) }).optional(),
	/** Motion speed per video frame from `motion.startFrame` (screen diagonals / s; the fastest moving layer). */
	motion: z.object({ startFrame: frame, speed: z.array(z.number()) }),
	cues: z.array(
		z.object({
			cueId: z.string(),
			frame,
			timecode: z.string(),
			kind: z.enum(CUE_KINDS),
			weight: z.enum(CUE_WEIGHTS),
			filled: z.boolean(),
			muted: z.boolean(),
			label: z.string().nullable(),
		}),
	),
	/** Sound effect clips over the range (frames; peak = where the aligned point plays, fractional). */
	clips: z.array(
		z.object({
			clipId: z.string(),
			start: z.number(),
			end: z.number(),
			alignedFrame: z.number().nullable(),
			title: z.string(),
		}),
	),
	speech: z.array(z.tuple([z.number(), z.number()])),
	issues: z.array(
		z.object({
			id: z.string(),
			code: z.enum(SOUND_CHECK_CODES),
			severity: z.enum(SOUND_CHECK_SEVERITIES),
			frame: frame.optional(),
			range: z.object({ start: frame, end: frame }).optional(),
			text: z.string(),
		}),
	),
});
export type SoundVisualResponse = z.infer<typeof SoundVisualResponseSchema>;
