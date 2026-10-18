// Reference sound profiles (spec 12 §4 P6-E8; wp-note "Phase 6 → WP-E4"): the engine's per-user library of profiles
// built from the user's own reference media or sequences (numbers only, never audio), and the Sound Check comparison.
//   GET    /api/sound-design/profiles              every profile (summaries)
//   GET    /api/sound-design/profiles/:profileId   one profile: the file (references' numbers and the aggregate) — what
//                                                  "Export…" saves and "Import…" reads back
//   POST   /api/sound-design/profiles              a `sound-profile` job (202) that measures 1–20 references (project
//                                                  media, sequences, or absolute paths on a local engine) and stores
//                                                  the profile; result `SoundProfileBuildResult`
//   PUT    /api/sound-design/profiles/:profileId/name  rename
//   DELETE /api/sound-design/profiles/:profileId   delete (an agent's request waits for the user's approval: user data)
//   POST   /api/sound-design/profiles/import       a profile file (validated, its aggregate recomputed) under a new id
// Sound Check compares with the sequence's profile (`soundDesign.setSettings {referenceProfile}`) or the request's
// `profileId` (`report.reference`; findings of code REFERENCE, warnings and infos only).
import {
	REFERENCE_KINDS,
	REFERENCE_METRIC_GROUPS,
	REFERENCE_PROFILE_ID_RE,
	REFERENCE_PROFILE_LIMITS,
} from '@jasper/project';
import { z } from 'zod';

const projectId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'a project id');
export const SoundProfileIdSchema = z.string().regex(REFERENCE_PROFILE_ID_RE, 'a profile id (sprf_…)');
const name = z.string().trim().min(1).max(REFERENCE_PROFILE_LIMITS.name);

export const SOUND_PROFILE_LIMITS = {
	references: REFERENCE_PROFILE_LIMITS.references,
	name: REFERENCE_PROFILE_LIMITS.name,
	profiles: REFERENCE_PROFILE_LIMITS.profiles,
	fileBytes: REFERENCE_PROFILE_LIMITS.fileBytes,
	/** Longest stretch of a reference measured (s). */
	maxSecondsPerReference: REFERENCE_PROFILE_LIMITS.maxSec,
	minSeconds: REFERENCE_PROFILE_LIMITS.minSec,
} as const;

/**
 * Build a profile from references (1–20 in all): media of `projectId` (`mediaIds`), its sequences (`sequenceIds`: their
 * delivered mix and their cuts), or engine-local files (`paths`, absolute, local engines only).
 */
export const SoundProfileBuildRequestSchema = z
	.strictObject({
		name,
		projectId: projectId.optional(),
		mediaIds: z.array(z.string().min(1).max(128)).max(REFERENCE_PROFILE_LIMITS.references).optional(),
		sequenceIds: z.array(z.string().min(1).max(128)).max(REFERENCE_PROFILE_LIMITS.references).optional(),
		paths: z.array(z.string().min(1).max(4096)).max(REFERENCE_PROFILE_LIMITS.references).optional(),
	})
	.refine(
		(r) => {
			const n = (r.mediaIds?.length ?? 0) + (r.sequenceIds?.length ?? 0) + (r.paths?.length ?? 0);
			return n >= 1 && n <= REFERENCE_PROFILE_LIMITS.references;
		},
		{ message: `Give 1–${REFERENCE_PROFILE_LIMITS.references} references (mediaIds, sequenceIds or paths)` },
	)
	.refine((r) => !(r.mediaIds?.length || r.sequenceIds?.length) || !!r.projectId, {
		message: 'mediaIds and sequenceIds need projectId',
		path: ['projectId'],
	});
export type SoundProfileBuildRequest = z.infer<typeof SoundProfileBuildRequestSchema>;

export const SoundProfileRenameRequestSchema = z.strictObject({ name });
export type SoundProfileRenameRequest = z.infer<typeof SoundProfileRenameRequestSchema>;

/** A profile file to import (`GET …/profiles/:id`'s body as saved), optionally under another name. */
export const SoundProfileImportRequestSchema = z.strictObject({
	profile: z.unknown(),
	name: name.optional(),
});
export type SoundProfileImportRequest = z.infer<typeof SoundProfileImportRequestSchema>;

const stats = z.object({
	n: z.number().int(),
	median: z.number().nullable(),
	p10: z.number().nullable(),
	p90: z.number().nullable(),
	min: z.number().nullable(),
	max: z.number().nullable(),
});

export const SoundProfileReferenceSchema = z.object({
	id: z.string(),
	title: z.string(),
	kind: z.enum(REFERENCE_KINDS),
	fingerprint: z.string(),
	durationSec: z.number(),
	hasPicture: z.boolean(),
	fps: z.number().nullable(),
	mono: z.boolean(),
	metrics: z.record(z.string(), z.number().nullable()),
	chance: z.record(z.string(), z.number().nullable()),
	arc: z.array(z.number().nullable()).nullable(),
});

/** A whole profile: what the store keeps and what Export saves (numbers, titles and fingerprints; never audio). */
export const SoundProfileSchema = z.object({
	format: z.literal('jasper-sound-profile'),
	version: z.literal(1),
	metricsVersion: z.number().int(),
	id: z.string(),
	name: z.string(),
	createdAt: z.string(),
	updatedAt: z.string(),
	n: z.number().int(),
	references: z.array(SoundProfileReferenceSchema),
	metrics: z.record(z.string(), stats),
	chance: z.record(z.string(), stats),
	arc: z
		.object({
			median: z.array(z.number().nullable()),
			p10: z.array(z.number().nullable()),
			p90: z.array(z.number().nullable()),
		})
		.nullable(),
	warnings: z.array(z.string()),
});
export type SoundProfileJson = z.infer<typeof SoundProfileSchema>;

export const SoundProfileSummarySchema = z.object({
	id: z.string(),
	name: z.string(),
	n: z.number().int(),
	createdAt: z.string(),
	updatedAt: z.string(),
	references: z.array(
		z.object({
			id: z.string(),
			title: z.string(),
			kind: z.enum(REFERENCE_KINDS),
			durationSec: z.number(),
			hasPicture: z.boolean(),
		}),
	),
	warnings: z.array(z.string()),
});
export type SoundProfileSummary = z.infer<typeof SoundProfileSummarySchema>;

export const SoundProfilesResponseSchema = z.object({
	profiles: z.array(SoundProfileSummarySchema),
	/** Files in the profile folder that could not be read (moved aside), with why. */
	unreadable: z.array(z.object({ file: z.string(), error: z.string() })),
	/** Absolute paths are accepted as references (local engine). */
	paths: z.boolean(),
});
export type SoundProfilesResponse = z.infer<typeof SoundProfilesResponseSchema>;

/** The `sound-profile` job's result. */
export const SoundProfileBuildResultSchema = z.object({
	profile: SoundProfileSummarySchema,
	/** References that were not measured (missing, no audio, under 3 s, silent), with why. */
	skipped: z.array(z.object({ title: z.string(), reason: z.string() })),
	warnings: z.array(z.string()),
	timings: z.record(z.string(), z.number()),
});
export type SoundProfileBuildResult = z.infer<typeof SoundProfileBuildResultSchema>;

export const SoundProfileDeleteResponseSchema = z.object({ deleted: z.literal(true), id: z.string() });

const message = z.object({
	key: z.string(),
	params: z.array(z.union([z.string(), z.number()])),
	text: z.string(),
});

/** One Reference row of a Sound Check (P6-E8): a metric of the sequence against the profile. */
export const SoundCheckReferenceRowSchema = z.object({
	metric: z.string(),
	group: z.enum(REFERENCE_METRIC_GROUPS),
	label: z.string(),
	unit: z.string(),
	decimals: z.number().int(),
	value: z.number().nullable(),
	/** The judged window (references' min–max widened by the metric's tolerance; null = open). */
	range: z.tuple([z.number().nullable(), z.number().nullable()]),
	typical: z.tuple([z.number().nullable(), z.number().nullable()]).nullable(),
	median: z.number().nullable(),
	n: z.number().int(),
	status: z.enum(['ok', 'low', 'high', 'n.a.']),
	/** major → a warning when out of range, minor → an info, info → shown only. */
	weight: z.enum(['major', 'minor', 'info']),
	basis: z.enum(['references', 'delivery', 'no reference data']),
	chance: z.number().nullable().optional(),
	refChance: z.number().nullable().optional(),
	why: z.string(),
	/** The finding's text and what to do (with timecodes), when out of range. */
	message: message.optional(),
	advice: z.array(message).optional(),
	/** The finding's id (`REFERENCE:<metric>`) when the row is one. */
	issueId: z.string().optional(),
});
export type SoundCheckReferenceRow = z.infer<typeof SoundCheckReferenceRowSchema>;

/** The Reference comparison of a Sound Check report. */
export const SoundCheckReferenceSchema = z.object({
	profileId: z.string(),
	name: z.string(),
	n: z.number().int(),
	scoredAgainst: z.number().int(),
	leaveOneOut: z
		.object({ referenceId: z.string(), title: z.string(), by: z.enum(['identity', 'measurements']) })
		.nullable(),
	/** Picked by the request (`profileId`) or the sequence's setting. */
	source: z.enum(['request', 'sequence']),
	rows: z.array(SoundCheckReferenceRowSchema),
	arc: z.object({
		value: z.array(z.number().nullable()).nullable(),
		median: z.array(z.number().nullable()).nullable(),
		p10: z.array(z.number().nullable()).nullable(),
		p90: z.array(z.number().nullable()).nullable(),
	}),
	counts: z.object({
		ok: z.number().int(),
		low: z.number().int(),
		high: z.number().int(),
		na: z.number().int(),
		scored: z.number().int(),
	}),
	/** Not measured on the range: a range that is not the whole sequence is judged as a piece of its own. */
	wholeSequence: z.boolean(),
});
export type SoundCheckReference = z.infer<typeof SoundCheckReferenceSchema>;
