// Ambience beds and room tone (spec 12 §4 P6-E12; wp-note "Phase 6 → WP-E8"): the engine measures the bed recordings
// (the clean window, the loop points) and the dialogue's noise floor, and lays the beds with `soundDesign.layBed`.
//   POST /api/sound-design/beds/plan       the plan (scenes, windows, loop points, the transaction), read-only
//   POST /api/sound-design/beds            a `sound-design` job (202): the beds proposed (default) or applied
//   POST /api/sound-design/room-tone/plan  the room-tone plan (gaps, the dialogue's floor, the candidates), read-only
//   POST /api/sound-design/room-tone       a `sound-design` job (202): room tone proposed (default) or applied
import { BED_PURPOSES, SOUND_DESIGN_LIMITS, SOUND_REF_RE } from '@jasper/project';
import { z } from 'zod';

const frame = z.number().int().min(0).max(SOUND_DESIGN_LIMITS.maxFrame);
const id = z.string().min(1).max(128);
const soundId = z.string().regex(SOUND_REF_RE, 'a sound id (snd_<16 hex>)');
const projectId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'a project id');
const range = z
	.strictObject({ start: frame, end: frame })
	.refine((r) => r.end > r.start, 'range.end must be after range.start');

export const SOUND_BED_LIMITS = { maxScenes: 500, maxGaps: 500, maxCandidates: 8 } as const;
/** Where scenes come from when `scenes` is "auto": cuts to other footage on V1, scene markers, measured shot changes. */
export const BED_SCENE_SOURCES = ['edits', 'markers', 'shots'] as const;

/** One scene of a bed (user-adjusted): frames and, optionally, its own bed sound. */
export const SoundBedSceneInputSchema = z
	.strictObject({
		start: frame,
		end: frame,
		soundId: soundId.optional(),
		mediaId: id.optional(),
	})
	.refine((s) => s.end > s.start, 'end must be after start')
	.refine((s) => !(s.soundId && s.mediaId), 'give soundId or mediaId, not both');

const bedOptions = {
	projectId,
	/** Default: the project's first sequence. */
	sequenceId: id.optional(),
	/** `propose` (default): a proposal to review; `apply`: one undoable transaction. */
	mode: z.enum(['propose', 'apply']).optional(),
	/** Proposal title / History label. */
	label: z.string().min(1).max(200).optional(),
} as const;

/**
 * `POST /api/sound-design/beds` (and `…/beds/plan`): an ambience bed per scene. The bed is a library sound (`soundId`,
 * registered for the project) or a project media (`mediaId`); default: the palette's first ambience. `scenes`:
 * "auto" (default: `bedScenes` from `sources`, default edits + markers, over `range`) or the scenes to lay (each may
 * name its own sound). The engine finds each recording's clean window and loop points; the rest are
 * `soundDesign.layBed`'s options.
 */
export const SoundBedsRequestSchema = z
	.strictObject({
		...bedOptions,
		soundId: soundId.optional(),
		mediaId: id.optional(),
		scenes: z
			.union([z.literal('auto'), z.array(SoundBedSceneInputSchema).min(1).max(SOUND_BED_LIMITS.maxScenes)])
			.optional(),
		sources: z.array(z.enum(BED_SCENE_SOURCES)).max(BED_SCENE_SOURCES.length).optional(),
		range: range.optional(),
		gainDb: z.number().min(-60).max(40).optional(),
		fadeSec: z.number().min(0).max(30).optional(),
		crossfadeSec: z.number().min(0.05).max(30).optional(),
		sceneCrossfadeSec: z.number().min(0).max(10).optional(),
		duckUnder: z.enum(['dialogue', 'heroes']).nullable().optional(),
		track: z.string().min(1).max(64).optional(),
		/** Replace earlier ambience beds over the scenes (default true). */
		replace: z.boolean().optional(),
	})
	.refine((r) => !(r.soundId && r.mediaId), {
		message: 'give soundId or mediaId, not both',
		path: ['mediaId'],
	});
export type SoundBedsRequest = z.infer<typeof SoundBedsRequestSchema>;

/** The measured clean window of a bed recording (seconds of the sound / media). */
export const BedWindowSchema = z.object({
	startSec: z.number(),
	endSec: z.number(),
	levelDb: z.number(),
	levelStdDb: z.number(),
	onsetsPerMin: z.number(),
	spikes: z.number(),
	clean: z.boolean(),
	whole: z.boolean(),
});

/** The measured loop points (seconds of the media laid). */
export const BedLoopSchema = z.object({
	inSec: z.number(),
	outSec: z.number(),
	crossfadeSec: z.number(),
	fade: z.enum(['equal-power', 'equal-gain']),
	levelDiffDb: z.number(),
	spectralDistanceDb: z.number(),
	correlation: z.number(),
	midpointDb: z.number(),
});

export const BedSoundSchema = z.object({
	soundId: z.string().nullable(),
	/** The project media (an id, or the `$ref` the transaction's register command binds). */
	mediaId: z.string(),
	title: z.string(),
	/** The window's integrated loudness (LUFS, as laid: stereo playback). */
	loudnessLufs: z.number().nullable(),
	window: BedWindowSchema,
	loop: BedLoopSchema,
});

export const SoundBedSceneReportSchema = z.object({
	start: z.number(),
	end: z.number(),
	timecode: z.string(),
	endTimecode: z.string(),
	reason: z.enum(['start', 'edit', 'marker', 'shot', 'user']),
	label: z.string(),
	sound: BedSoundSchema,
	gainDb: z.number(),
});

export const SoundBedWarningSchema = z.object({ code: z.string(), message: z.string() });

export const SoundBedsPlanSchema = z.object({
	sequenceId: z.string(),
	purpose: z.enum(BED_PURPOSES),
	scenes: z.array(SoundBedSceneReportSchema),
	/** The ONE transaction that lays it: registering the library sounds, then `soundDesign.layBed`. */
	commands: z.array(z.looseObject({ type: z.string() })),
	warnings: z.array(SoundBedWarningSchema),
	/** Which scene sources were used and which measured ones were missing (shots not analysed). */
	sources: z.array(z.string()),
});
export type SoundBedsPlan = z.infer<typeof SoundBedsPlanSchema>;

export const SoundBedsResultSchema = z.object({
	projectId: z.string(),
	sequenceId: z.string(),
	mode: z.enum(['propose', 'apply']),
	applied: z.boolean(),
	revision: z.number().int().nullable(),
	proposalId: z.string().nullable(),
	plan: SoundBedsPlanSchema,
});
export type SoundBedsResult = z.infer<typeof SoundBedsResultSchema>;

/**
 * `POST /api/sound-design/room-tone` (and `…/room-tone/plan`): room tone in the holes between dialogue clips (spec 12
 * P6-E12). `gaps`: the frames to fill (default every hole between dialogue clips under 10 s, in `range`); `cover:
 * 'regions'` lays it under the whole of each dialogue region instead (under J- and L-cuts). The tone: `soundId` /
 * `mediaId` (+ `loop`), else (`source` auto) the palette's or library's room tone whose spectrum is closest to the
 * dialogue's noise floor (within 6 dB of shape), else the quietest 0.5–3 s without speech in the dialogue's own media,
 * looped; `source: 'library' | 'dialogue'` forces one. Its gain puts it at the floor's level (never under −56 dBFS).
 */
export const SoundRoomToneRequestSchema = z
	.strictObject({
		...bedOptions,
		gaps: z.array(range).min(1).max(SOUND_BED_LIMITS.maxGaps).optional(),
		range: range.optional(),
		cover: z.enum(['gaps', 'regions']).optional(),
		source: z.enum(['auto', 'library', 'dialogue']).optional(),
		soundId: soundId.optional(),
		mediaId: id.optional(),
		gainDb: z.number().min(-60).max(40).optional(),
	})
	.refine((r) => !(r.soundId && r.mediaId), {
		message: 'give soundId or mediaId, not both',
		path: ['mediaId'],
	});
export type SoundRoomToneRequest = z.infer<typeof SoundRoomToneRequestSchema>;

export const RoomToneCandidateSchema = z.object({
	source: z.enum(['palette', 'library', 'dialogue', 'given']),
	soundId: z.string().nullable(),
	mediaId: z.string().nullable(),
	title: z.string(),
	/** Shape distance of its clean window's octave bands to the dialogue's noise floor (dB; lower = closer). */
	distanceDb: z.number().nullable(),
	levelDb: z.number(),
});

export const SoundRoomTonePlanSchema = z.object({
	sequenceId: z.string(),
	gaps: z.array(
		z.object({
			start: z.number(),
			end: z.number(),
			timecode: z.string(),
			/** What the fill covers (padded under the dialogue). */
			fill: z.object({ start: z.number(), end: z.number() }),
		}),
	),
	/** The dialogue's noise floor: the quietest 20 % of its 100 ms frames outside speech. */
	floor: z
		.object({
			levelDb: z.number(),
			bandsDb: z.array(z.number()),
			clipIds: z.array(z.string()),
			seconds: z.number(),
		})
		.nullable(),
	candidates: z.array(RoomToneCandidateSchema),
	chosen: z
		.object({
			source: z.enum(['palette', 'library', 'dialogue', 'given']),
			sound: BedSoundSchema,
			distanceDb: z.number().nullable(),
			gainDb: z.number(),
			why: z.string(),
		})
		.nullable(),
	commands: z.array(z.looseObject({ type: z.string() })),
	warnings: z.array(SoundBedWarningSchema),
});
export type SoundRoomTonePlan = z.infer<typeof SoundRoomTonePlanSchema>;

export const SoundRoomToneResultSchema = z.object({
	projectId: z.string(),
	sequenceId: z.string(),
	mode: z.enum(['propose', 'apply']),
	applied: z.boolean(),
	revision: z.number().int().nullable(),
	proposalId: z.string().nullable(),
	plan: SoundRoomTonePlanSchema,
});
export type SoundRoomToneResult = z.infer<typeof SoundRoomToneResultSchema>;
