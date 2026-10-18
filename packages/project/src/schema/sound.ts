// Sound design cues and SFX clip metadata (spec 12 §2.2): `Sequence.soundDesign` and `AudioClip.sfx`. Metadata only,
// never a render input (spec 12 §1: every result is an ordinary clip, gain, pan or effect).
//
// Storage: both fields are accepted as any value by the document schema (`z.custom`, typed as valid data), so a
// malformed value never makes a project fail to load (AGENTS.md §0). The invariants check them against the schemas
// below (INV-SOUND, INV-SFX); `repairDocument` rewrites them with `readSoundDesign` / `readClipSfx` (cue by cue, field
// by field; unknown newer fields kept). References (a cue's anchor and placed clips, a clip's cue) are soft: an edit
// that deletes a clip, transition or marker leaves them dangling, readers ignore dangling ids, and `repairDocument`
// prunes them on load (anchor → null with a report line). No schema bump: every field is optional or loose (v7).
import { z } from 'zod';
import { REFERENCE_PROFILE_ID_RE } from '../sound/profile.ts';
import { StoredSoundTypeSchema } from '../sound/provenance.ts';
import { type DeepStrip, keyframeSchema } from './common.ts';

/** Bounds for untrusted cue data (counts, strings). */
export const SOUND_DESIGN_LIMITS = {
	/** Cues one `soundCue.add` may add. */
	addCues: 2000,
	/** Cues a sequence may hold. */
	cues: 20_000,
	id: 128,
	label: 500,
	reason: 2000,
	types: 16,
	soundIds: 16,
	placedClips: 16,
	/** `AudioClip.sfx.alternatives` (spec 12 §2.2: ≤ 16). */
	alternatives: 16,
	palette: 500,
	sfxTracks: 64,
	/** Placement layers of one cue (`soundDesign.place`: 1…6). */
	layers: 6,
	property: 200,
	/** Largest frame a cue may name (≈ 24 h at 120 fps). */
	maxFrame: 10_368_000,
	/** Largest `SoundCue.anchorOffset` either side (frames; beat snapping moves a cue ≤ 2). */
	anchorOffset: 10,
	/** Acknowledged Sound Check findings a sequence may hold (spec 12 §4 P6-E4). */
	acknowledged: 500,
	/** An acknowledgement's reason (characters). */
	ackReason: 300,
	/** A finding key (`<CODE>:<subject>`). */
	ackKey: 256,
	/** The finding's text kept with its acknowledgement (characters). */
	ackMessage: 500,
} as const;

export const CUE_KINDS = [
	'cut',
	'transition',
	'move',
	'land',
	'appear',
	'exit',
	'emphasis',
	'reveal',
	'beat',
	'manual',
	'silence',
] as const;
export type CueKind = (typeof CUE_KINDS)[number];
export const CUE_WEIGHTS = ['hero', 'support', 'ambient'] as const;
export type CueWeight = (typeof CUE_WEIGHTS)[number];
export const CUE_SOURCES = ['derived', 'user', 'agent', 'marker'] as const;
export type CueSource = (typeof CUE_SOURCES)[number];
export const CUE_ALIGNS = ['peak', 'start', 'end'] as const;
export const SFX_ROLES = ['hero', 'support', 'layer'] as const;
export type SfxRole = (typeof SFX_ROLES)[number];
export const SOUND_DENSITIES = ['sparse', 'balanced', 'rich'] as const;
export type SoundDensity = (typeof SOUND_DENSITIES)[number];
/** Delivery presets (spec 12 §2.4; `packages/project/src/sound/delivery.ts` in P4). */
export const SOUND_DELIVERIES = ['web', 'podcast', 'broadcast-r128', 'atsc-a85'] as const;
export type SoundDelivery = (typeof SOUND_DELIVERIES)[number];
/**
 * Personalities of a sound pass (spec 12 P6-E10; the table is `SOUND_PERSONALITY_PROFILES` in `sound/grammar.ts`):
 * Refine preferences, type boosts and exclusions, preferred materials and a default density.
 */
export const SOUND_PERSONALITIES = ['calm', 'energetic', 'bright', 'precise', 'mechanical', 'warm'] as const;
export type SoundPersonality = (typeof SOUND_PERSONALITIES)[number];
/** Runs of appear / emphasis cues (P6-E10): `climb` +1 st per step (capped +4), or `flat`. */
export const SOUND_RUN_MODES = ['climb', 'flat'] as const;
export type SoundRunMode = (typeof SOUND_RUN_MODES)[number];
/**
 * Typing patterns (P6-E10): `auto` = one key per typed unit up to 25 units/s, one per word start above; `keys` /
 * `words` force one of them; `silent` = no typing cues.
 */
export const SOUND_TYPING_MODES = ['auto', 'keys', 'words', 'silent'] as const;
export type SoundTypingMode = (typeof SOUND_TYPING_MODES)[number];

/**
 * The cue grammar and style of a sequence (spec 12 P6-E10, `SoundDesignSettings.style`): what the plan job (Auto Sound
 * Pass…, Fill Unfilled Cues), Suggest Cues…, MCP place_sound picks and find_sound_cues use when a request names no
 * value. Every field optional; absent = the default (no personality, runs climb, typing auto, music carries the cuts,
 * no duck under typing).
 */
export const SoundDesignStyleSchema = z.looseObject({
	personality: z.enum(SOUND_PERSONALITIES).optional(),
	runs: z.enum(SOUND_RUN_MODES).optional(),
	typing: z.enum(SOUND_TYPING_MODES).optional(),
	musicCarriesCuts: z.boolean().optional(),
	duckUnderTyping: z.boolean().optional(),
});
export type SoundDesignStyle = DeepStrip<z.infer<typeof SoundDesignStyleSchema>>;

const id = () => z.string().min(1).max(SOUND_DESIGN_LIMITS.id);
const frame = () => z.number().int().min(0).max(SOUND_DESIGN_LIMITS.maxFrame);

/**
 * What a cue is tied to (spec 12 §2.2), so `soundCue.resync` can follow the edit (`resolveCueAnchor`):
 * - `edit`: the cut between two clips of a track; `transition`: a transition's visual centre;
 * - `keyframe`: a keyframed property of a clip (`property` = path in the clip, e.g. `transform.position`, `opacity`,
 *   `effects.<fxId>.params.<name>`), at one keyframe (`keyframeId`) or the whole run: `start` / `end` / `settle`
 *   (the motion comes to rest) / `peak-speed`;
 * - `text`: a text clip's In or Out animation (`unit` = the 0-based typed unit of a typewriter);
 * - `mg`: a motion graphic's intro end / outro start; `clip`: a clip's first frame or end;
 * - `scene`: a media time (seconds) of a media, wherever the sequence shows it (`clipId`, when given, is the clip that
 *   showed it when the cue was derived: it is preferred while it still shows that media time); `beat`: a beat of a
 *   (music) clip (`mediaSec`, when known, is the beat's media time);
 * - `marker`: a sequence marker (or a clip marker).
 */
export const CueAnchorSchema = z.discriminatedUnion('type', [
	z.looseObject({ type: z.literal('edit'), trackId: id(), outgoingClipId: id(), incomingClipId: id() }),
	z.looseObject({ type: z.literal('transition'), transitionId: id() }),
	z.looseObject({
		type: z.literal('keyframe'),
		clipId: id(),
		property: z.string().min(1).max(SOUND_DESIGN_LIMITS.property),
		keyframeId: id().optional(),
		event: z.enum(['peak-speed', 'settle', 'start', 'end']),
	}),
	z.looseObject({
		type: z.literal('text'),
		clipId: id(),
		side: z.enum(['in', 'out']),
		unit: z.number().int().min(0).max(1_000_000).optional(),
	}),
	z.looseObject({ type: z.literal('mg'), clipId: id(), event: z.enum(['intro-end', 'outro-start']) }),
	z.looseObject({ type: z.literal('clip'), clipId: id(), edge: z.enum(['start', 'end']) }),
	z.looseObject({
		type: z.literal('scene'),
		mediaId: id(),
		mediaSec: z.number().min(0).max(864_000),
		clipId: id().optional(),
	}),
	z.looseObject({
		type: z.literal('beat'),
		clipId: id(),
		beatIndex: z.number().int().min(0).max(10_000_000),
		mediaSec: z.number().min(0).max(864_000).optional(),
	}),
	z.looseObject({ type: z.literal('marker'), markerId: id() }),
]);
export type CueAnchor = DeepStrip<z.infer<typeof CueAnchorSchema>>;
export type CueAnchorType = CueAnchor['type'];
export const CUE_ANCHOR_TYPES: readonly CueAnchorType[] = [
	'edit',
	'transition',
	'keyframe',
	'text',
	'mg',
	'clip',
	'scene',
	'beat',
	'marker',
];

/** The cue fields a caller gives (`soundCue.add`, `deriveCues`); `id` and `placedClipIds` are the model's. */
export const soundCueFields = {
	frame: frame(),
	label: z.string().max(SOUND_DESIGN_LIMITS.label).optional(),
	kind: z.enum(CUE_KINDS),
	weight: z.enum(CUE_WEIGHTS),
	/** Sound types that fit (taxonomy ids, newer builds' ids kept). */
	types: z.array(StoredSoundTypeSchema).max(SOUND_DESIGN_LIMITS.types).optional(),
	/** Library sounds chosen for its layers (`snd_…`), in layer order. */
	soundIds: z.array(id()).max(SOUND_DESIGN_LIMITS.soundIds).optional(),
	align: z.enum(CUE_ALIGNS).optional(),
	/** Static pan −100 (left) … 100 (right), or `auto` (x of the picture event; spec 12 §2.2). */
	pan: z.union([z.number().min(-100).max(100), z.literal('auto')]).optional(),
	/** Pan travelling with the picture (a whoosh across the frame): from → to over the cue's window. */
	panSweep: z
		.looseObject({ from: z.number().min(-100).max(100), to: z.number().min(-100).max(100) })
		.optional(),
	pitchSt: z.number().min(-12).max(12).optional(),
	/** Dip the music before the cue (P4). */
	stopBefore: z
		.looseObject({ seconds: z.number().min(0).max(10), depthDb: z.number().min(-60).max(0) })
		.optional(),
	/** High-pass build into the cue (P4). */
	build: z
		.looseObject({
			seconds: z.number().min(0).max(30),
			fromHz: z.number().min(20).max(20_000),
			toHz: z.number().min(20).max(20_000),
		})
		.optional(),
	anchor: CueAnchorSchema.nullable().optional(),
	/**
	 * Frames between where the anchor resolves and the cue (the cue = anchor frame + offset): a cue snapped to a nearby
	 * music beat (`deriveCues` `snapToBeats`, ≤ 2 frames) keeps following its picture event at that offset. Absent = 0.
	 */
	anchorOffset: z
		.number()
		.int()
		.min(-SOUND_DESIGN_LIMITS.anchorOffset)
		.max(SOUND_DESIGN_LIMITS.anchorOffset)
		.optional(),
	source: z.enum(CUE_SOURCES),
	confidence: z.number().min(0).max(1).optional(),
	reason: z.string().max(SOUND_DESIGN_LIMITS.reason).optional(),
	muted: z.boolean().optional(),
	/** The span the picture event covers (frames), e.g. a push transition a whoosh should fill. */
	window: z
		.looseObject({ start: frame(), end: frame() })
		.refine((w) => w.end >= w.start, 'window.end must be ≥ window.start')
		.optional(),
};

export const SoundCueSchema = z.looseObject({
	/** `cue_` + 16 Crockford base32 characters; unique in the document. */
	id: id(),
	...soundCueFields,
	/** The clips filling the cue (one per layer), in layer order. */
	placedClipIds: z.array(id()).max(SOUND_DESIGN_LIMITS.placedClips).optional(),
});
export type SoundCue = DeepStrip<z.infer<typeof SoundCueSchema>>;

/** Sound credits sidecar formats (`SoundDesignSettings.credits`, spec 12 §2.11 `ExportSettings.credits`). */
export const SOUND_CREDITS_FORMATS = ['txt', 'md', 'csv'] as const;
export type SoundCreditsFormat = (typeof SOUND_CREDITS_FORMATS)[number];

export const SoundDesignSettingsSchema = z.looseObject({
	/** Loudness delivery target (P4 presets). */
	delivery: z.enum(SOUND_DELIVERIES),
	density: z.enum(SOUND_DENSITIES),
	/** Tracks the sound design owns (placement's `auto` prefers them). */
	sfxTrackIds: z.array(id()).max(SOUND_DESIGN_LIMITS.sfxTracks),
	/** The "SFX Room" submix (P4), or null. */
	roomBus: z.string().max(SOUND_DESIGN_LIMITS.id).nullable(),
	/** Seed of rotation and variation (deterministic proposals). */
	seed: z.number().int().min(0).max(0xffff_ffff),
	/** "Allow agents to apply sound proposals" (default off; spec 12 §0). */
	agentsMayApply: z.boolean().optional(),
	/** Preferred library sounds (the Sound Library's Palette collection), most recent last. */
	palette: z.array(id()).max(SOUND_DESIGN_LIMITS.palette).optional(),
	/**
	 * Sound credits go with the sequence's exports as a sidecar file in this format (P5: Sound Check's CREDITS finding
	 * is resolved by setting it; the export dialog's credits option defaults to it). Absent / null = not configured.
	 */
	credits: z.enum(SOUND_CREDITS_FORMATS).nullable().optional(),
	/** The cue grammar and personality (P6-E10; `soundDesign.setSettings {style}`). Absent = every default. */
	style: SoundDesignStyleSchema.optional(),
	/**
	 * The reference profile Sound Check compares the sequence with (P6-E8; `soundDesign.setSettings {referenceProfile}`):
	 * an id of the engine's per-user profile library (`sprf_…`). Absent / null = no comparison.
	 */
	referenceProfile: z.string().regex(REFERENCE_PROFILE_ID_RE).nullable().optional(),
});
export type SoundDesignSettings = DeepStrip<z.infer<typeof SoundDesignSettingsSchema>>;

/**
 * Summary of the last Sound Check (P5, `soundDesign.setCheck`); stale when `mixHash` differs from the mix's fingerprint
 * (`mixFingerprint`) or `inputsHash` from `soundCheckInputsHash` (cues, Mix loudness, preset, credits, density:
 * `soundCheckStatus`).
 * The full report is the `sound-check` job's result (`jobId`).
 */
export const SoundCheckSummarySchema = z.looseObject({
	mixHash: z.string().max(256),
	verdict: z.string().max(64),
	counts: z.record(z.string().max(64), z.number().int().min(0)),
	at: z.string().max(64),
	/** Delivery preset checked against. */
	preset: z.enum(SOUND_DELIVERIES).optional(),
	/** A custom target checked against instead of the preset's numbers (LUFS / dBTP; WP5.2 "Custom…"). */
	target: z
		.looseObject({ integratedLufs: z.number().min(-40).max(-5), truePeakDb: z.number().min(-12).max(0) })
		.optional(),
	/** Hash of the other inputs of the check (`soundCheckInputsHash`). */
	inputsHash: z.string().max(256).optional(),
	/** The `sound-check` job whose result is the full report. */
	jobId: z.string().max(128).optional(),
	/** Sequence frames checked `[start, end)` (absent: the whole sequence). */
	range: z.looseObject({ start: z.number().int().min(0), end: z.number().int().min(0) }).optional(),
});
export type SoundCheckSummary = DeepStrip<z.infer<typeof SoundCheckSummarySchema>>;

/** Bounds of the mix records (`SoundDesign.mix`). */
export const SOUND_MIX_LIMITS = {
	/** Places one realization writes to (music tracks or clips under a cue). */
	writes: 64,
	/** Keyframes one write adds. */
	written: 512,
	/** Keyframes one write replaced (kept to give them back on removal). */
	replaced: 2000,
	/** Room sends recorded. */
	sends: 64,
} as const;

/**
 * One place a realization wrote to (Phase 4 WP4.2a): a music track's volume lane (`trackVolume`), a music clip's Volume
 * (`clipVolume`, the `audio.volumeDip` fallback), or the cutoff of a High Pass build filter on a track (`trackFilter`) or a
 * clip (`clipFilter`). `written` are the keyframe ids it added; `replaced` the keyframes it removed from that range (given
 * back on removal); `createdEffect` — the filter insert was added for it.
 */
export const MixWriteSchema = z.looseObject({
	target: z.enum(['trackVolume', 'clipVolume', 'trackFilter', 'clipFilter']),
	trackId: id().optional(),
	clipId: id().optional(),
	effectInstanceId: id().optional(),
	written: z.array(id()).max(SOUND_MIX_LIMITS.written),
	replaced: z.array(keyframeSchema(z.number())).max(SOUND_MIX_LIMITS.replaced),
});
export type MixWrite = DeepStrip<z.infer<typeof MixWriteSchema>>;

/** Fields every realisation record shares (Phase 4 verification; optional, read-time defaults). */
const realisationFields = {
	/** The cue frame it was written for. */
	frame: frame(),
	writes: z.array(MixWriteSchema).max(SOUND_MIX_LIMITS.writes),
	/**
	 * Stacking order of the realisations (later = higher; absent on records of older builds = 0): a removal first
	 * takes out the later writes on the same lane, then writes them again, so overlapping realisations come out exactly.
	 */
	order: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
	/** Muted cue: nothing written (`writes: []`); written again, with the same options, when the cue is unmuted. */
	suspended: z.boolean().optional(),
};

/** What a cue's stop-before / build wrote into the mix (`soundDesign.applyStopBefore` / `applyBuild`), for exact removal. */
export const CueMixSchema = z.looseObject({
	stopBefore: z
		.looseObject({
			seconds: z.number().min(0).max(10),
			depthDb: z.number().min(-60).max(0),
			/** The ambience was dipped too (`applyStopBefore {ambience: true}`; remembered). */
			ambience: z.boolean().optional(),
			...realisationFields,
		})
		.optional(),
	build: z
		.looseObject({
			seconds: z.number().min(0).max(30),
			fromHz: z.number().min(20).max(20_000),
			toHz: z.number().min(20).max(20_000),
			...realisationFields,
		})
		.optional(),
});
export type CueMix = DeepStrip<z.infer<typeof CueMixSchema>>;

/** The "SFX Room" glue (`soundDesign.ensureBus`): the submix, its reverb, the settings and the sends it added. */
export const RoomGlueSchema = z.looseObject({
	busId: id(),
	reverbId: id().nullable(),
	/** The bus (submix) was created by `ensureBus` (removed with the glue), not adopted. */
	createdBus: z.boolean(),
	sendDb: z.number().min(-96).max(15),
	decay: z.number().min(0.1).max(20),
	mix: z.number().min(0).max(100),
	preDelayMs: z.number().min(0).max(200),
	sends: z
		.array(
			z.looseObject({
				trackId: id(),
				sendId: id(),
				/** What adding the send created on the track (`mixer`, or its `sends` list): removed with the send. */
				made: z.enum(['mixer', 'sends']).optional(),
			}),
		)
		.max(SOUND_MIX_LIMITS.sends),
	/**
	 * What `removeBus` gives back (absent on glue of older builds): whether the sequence had a sound design, its
	 * settings and a submix list before, and the settings' room bus.
	 */
	before: z
		.looseObject({
			soundDesign: z.boolean(),
			settings: z.boolean(),
			submixes: z.boolean().optional(),
			roomBus: z.string().max(SOUND_DESIGN_LIMITS.id).nullable(),
		})
		.optional(),
});
export type RoomGlue = DeepStrip<z.infer<typeof RoomGlueSchema>>;

/**
 * What sound design wrote into the mix with ordinary commands (Phase 4), so it can be redone and removed exactly: per cue
 * the stop-before dips and build sweeps, the build filter reused per track / clip, and the room glue. Metadata only.
 */
export const SoundDesignMixSchema = z.looseObject({
	cues: z.record(z.string(), CueMixSchema).optional(),
	/**
	 * Realisations of deleted cues still written on a locked track (keyed by the cue id they had): taken out when the
	 * track is unlocked (`track.update {locked: false}`).
	 */
	orphans: z.record(z.string(), CueMixSchema).optional(),
	/** The build filter (`jasper.audio.scientific-filter` effect instance id) of a music track or clip, by its id. */
	buildFilters: z.record(z.string(), id()).optional(),
	room: RoomGlueSchema.optional(),
});
export type SoundDesignMix = DeepStrip<z.infer<typeof SoundDesignMixSchema>>;

/**
 * A Sound Check finding the user (or an agent, for warnings and infos only) acknowledged as a deliberate exception, with
 * a reason (spec 12 §4 P6-E4; earshot's `qa_ok`). Keyed in `SoundDesign.acknowledged` by the finding's key (its report
 * id: `<CODE>:<subject>` — the code with the clip / cue ids it names, else its frame). `inputsHash`
 * (`soundAckInputsHash`) covers what the finding is about when it was acknowledged: when that changes, the finding is
 * reported again, "acknowledged before the change". `severity` is what was acknowledged: a finding that became worse
 * comes back. The code is stored as a string (a newer build's code survives a repair). Metadata only.
 */
export const SoundAcknowledgementSchema = z.looseObject({
	code: z.string().regex(/^[A-Z][A-Z0-9_]{0,31}$/),
	severity: z.enum(['error', 'warning', 'info']),
	reason: z.string().min(1).max(SOUND_DESIGN_LIMITS.ackReason),
	by: z.enum(['user', 'agent']),
	/** The agent's name when `by` is 'agent'. */
	agent: z.string().min(1).max(64).optional(),
	at: z.string().min(1).max(64),
	target: z.looseObject({
		clipIds: z.array(id()).max(SOUND_DESIGN_LIMITS.placedClips).optional(),
		cueId: id().optional(),
		frame: frame().optional(),
	}),
	inputsHash: z.string().min(1).max(256),
	/** The finding's English text when it was acknowledged (shown when the finding is no longer reported). */
	message: z.string().max(SOUND_DESIGN_LIMITS.ackMessage).optional(),
});
export type SoundAcknowledgement = DeepStrip<z.infer<typeof SoundAcknowledgementSchema>>;
/** A finding key: `<CODE>:<subject>` (letters, digits and `_ : . # | -`), at most `ackKey` characters. */
export const SOUND_ACK_KEY_RE = /^[A-Z][A-Z0-9_]{0,31}:[A-Za-z0-9_:.#|-]{1,222}$/;

export const SoundDesignSchema = z.looseObject({
	cues: z.record(z.string(), SoundCueSchema),
	settings: SoundDesignSettingsSchema.optional(),
	lastCheck: SoundCheckSummarySchema.optional(),
	/** Phase 4: what stop-before, build and room glue wrote (absent = nothing). */
	mix: SoundDesignMixSchema.optional(),
	/** P6-E4: acknowledged Sound Check findings by finding key (≤ 500; absent = none). */
	acknowledged: z.record(z.string().regex(SOUND_ACK_KEY_RE), SoundAcknowledgementSchema).optional(),
});
export type SoundDesign = DeepStrip<z.infer<typeof SoundDesignSchema>>;

/** `AudioClip.sfx.placement`: what aligned the clip (spec 12 §2.3). */
export const SfxPlacementSchema = z.looseObject({
	align: z.enum(CUE_ALIGNS),
	/** The aligned point in the media (content flicks from the file start). */
	peakFlicks: z.number().int().min(0),
	/** How late the aligned point plays, sequence flicks (0 = exact; < 1 frame). */
	errorFlicks: z.number().int().min(0),
});
export type SfxPlacement = DeepStrip<z.infer<typeof SfxPlacementSchema>>;

/**
 * `AudioClip.sfx.level`: the clip gain placement chose from the sound's descriptors (`defaultSfxLevel`, spec 12 §2.3,
 * Phase 2 verification B), written only when no gain was given. While `gainDb` still equals the clip's gain the gain
 * is that default (a swap or a role change recomputes it; Phase 4's masking solver replaces it); a gain the user set
 * since is theirs.
 */
export const SfxDefaultLevelSchema = z.looseObject({
	by: z.literal('default'),
	/** The clip gain applied (dB): the default plus `offsetDb`. */
	gainDb: z.number().min(-96).max(96),
	/** Added to the default (the seeded ±1 dB variation of a fill), dB. */
	offsetDb: z.number().min(-12).max(12).optional(),
	/** Momentary-loudness target of the role at the sequence's delivery (LUFS). */
	targetLufs: z.number().min(-100).max(0),
	/** What set it: the loudness target, the true-peak ceiling, the gain range, or no loudness descriptor. */
	limitedBy: z.enum(['loudness', 'peak', 'range', 'unmeasured']),
	/** Auto gain turned off (`soundDesign.setAutoGain`): the gain is the user's, the record stays for display. */
	manual: z.boolean().optional(),
});

/** Most `limitedBy` entries and their length in a solver level (the solver reports a handful). */
export const SFX_SOLVER_LEVEL_LIMITS = { limitedBy: 16, limit: 64, reason: 300 } as const;

/**
 * `AudioClip.sfx.level` written by the masking solver (`soundDesign.applyGains`, spec 12 §2.4 / §2.9; Phase 4 WP4.1b):
 * the gain that clears the bed by the role's target lift under the ordered constraints, and why it is what it is.
 * Like a default level it stays the solver's while `gainDb` equals the clip's gain (a rebalance may replace it; a swap
 * or role change returns it to the default level of the new sound or role); a gain the user set since is theirs.
 */
export const SfxSolverLevelSchema = z.looseObject({
	by: z.literal('solver'),
	/** The clip gain applied (dB): the solved gain, `offsetDb` included. */
	gainDb: z.number().min(-96).max(96),
	/** The variation offset carried over from the default level (the solver adds it), dB. */
	offsetDb: z.number().min(-12).max(12).optional(),
	/** Target lift of the dominant band over the bed (dB): hero +5, support +3.5, ambient +2. */
	targetLiftDb: z.number().min(-100).max(100).optional(),
	/** Lift reached at this gain (dB; null: a silent sound). */
	achievedLiftDb: z.number().min(-400).max(400).nullable().optional(),
	/** The constraints that held it under its target (`dialogue`, `bed-cap`, `conflict:bed-cap/consistency`…). */
	limitedBy: z
		.array(z.string().min(1).max(SFX_SOLVER_LEVEL_LIMITS.limit))
		.max(SFX_SOLVER_LEVEL_LIMITS.limitedBy),
	/** Human summary ("−3 dB, limited by dialogue A1"). */
	reason: z.string().max(SFX_SOLVER_LEVEL_LIMITS.reason).optional(),
	/** Auto gain turned off (`soundDesign.setAutoGain`): the gain is the user's, the record stays for display. */
	manual: z.boolean().optional(),
});

export const SfxLevelSchema = z.union([SfxDefaultLevelSchema, SfxSolverLevelSchema]);
export type SfxLevelDefault = DeepStrip<z.infer<typeof SfxDefaultLevelSchema>>;
export type SfxLevelSolver = DeepStrip<z.infer<typeof SfxSolverLevelSchema>>;
export type SfxLevel = SfxLevelDefault | SfxLevelSolver;

/** `AudioClip.sfx.pitch`: the applied pitch shift and the speed under it (see `ClipSfxSchema`). */
export const SfxPitchSchema = z.looseObject({
	st: z.number().min(-12).max(12),
	baseRate: z.number().min(0.01).max(100),
});
export type SfxPitch = DeepStrip<z.infer<typeof SfxPitchSchema>>;

/** `AudioClip.sfx`: a clip placed by sound design (spec 12 §2.2). */
export const ClipSfxSchema = z.looseObject({
	/** The cue it fills (null = placed at a frame without a cue). */
	cueId: id().nullable(),
	/** The library sound (`snd_…`), from the media's provenance; null for media that is not a library sound. */
	soundId: id().nullable(),
	/** 0-based layer of its cue. */
	layer: z
		.number()
		.int()
		.min(0)
		.max(SOUND_DESIGN_LIMITS.layers - 1),
	role: z.enum(SFX_ROLES),
	/** Alternatives the agent or the ranking offered (variation cycling), ≤ 16. */
	alternatives: z.array(id()).max(SOUND_DESIGN_LIMITS.alternatives).optional(),
	placement: SfxPlacementSchema,
	/** The default level placement gave it (absent: a gain was given, or placed before default levels). */
	level: SfxLevelSchema.optional(),
	/**
	 * The pitch shift placement or a swap applied (`st`, semitones) and the clip speed under it (`baseRate`: the caller's
	 * rate, i.e. the seeded ±2 % variation of a fill): speed = `baseRate · 2^(st/12)` for |st| ≤ 3 (varispeed), else
	 * `baseRate` with the Pitch Shifter carrying `st`. A fractional shift and the variation cannot be told apart from the
	 * speed alone, so a pitch reset reads this (`clipPitchOf`). Absent (placed before WP6.5b) or no longer matching the
	 * clip's speed (changed by another command): the speed is read as whole semitones plus the variation.
	 */
	pitch: SfxPitchSchema.optional(),
});
export type ClipSfx = DeepStrip<z.infer<typeof ClipSfxSchema>>;

/** Settings with their read-time defaults (absent settings, or a document written before the field existed). */
export const DEFAULT_SOUND_DESIGN_SETTINGS: SoundDesignSettings = {
	delivery: 'web',
	density: 'balanced',
	sfxTrackIds: [],
	roomBus: null,
	seed: 0,
	agentsMayApply: false,
	palette: [],
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === 'object' && !Array.isArray(v);

/** The first problem of a zod parse as one line. */
function issueOf(r: { success: boolean; error?: z.ZodError }): string | null {
	if (r.success) return null;
	const i = r.error!.issues[0]!;
	return `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`;
}

/** The problem with a stored `Sequence.soundDesign`, or null when it is valid (INV-SOUND). */
export function soundDesignIssue(raw: unknown): string | null {
	const parsed = SoundDesignSchema.safeParse(raw);
	const p = issueOf(parsed);
	if (p) return p;
	// zod's record parser skips a `__proto__` key (it never reaches the parsed value), so such a cue was never checked:
	// every own key must have come through.
	const rawCues = (raw as SoundDesign).cues;
	if (parsed.success && Object.keys(parsed.data.cues).length !== Object.keys(rawCues).length)
		return 'cues: a cue key the schema cannot read (e.g. __proto__)';
	for (const [key, cue] of Object.entries(rawCues))
		if (cue.id !== key) return `cues.${key}: key does not match the cue id ${cue.id}`;
	if (Object.keys((raw as SoundDesign).cues).length > SOUND_DESIGN_LIMITS.cues)
		return `more than ${SOUND_DESIGN_LIMITS.cues} cues`;
	const ack = (raw as SoundDesign).acknowledged;
	if (ack !== undefined) {
		const n = Object.keys(ack).length;
		if (parsed.success && Object.keys(parsed.data.acknowledged ?? {}).length !== n)
			return 'acknowledged: a key the schema cannot read (e.g. __proto__)';
		if (n > SOUND_DESIGN_LIMITS.acknowledged)
			return `more than ${SOUND_DESIGN_LIMITS.acknowledged} acknowledged findings`;
		for (const [key, a] of Object.entries(ack))
			if (!key.startsWith(`${a.code}:`))
				return `acknowledged.${key}: the key does not start with its code ${a.code}`;
	}
	return null;
}

/** The problem with a stored `AudioClip.sfx`, or null when it is valid (INV-SFX). */
export function clipSfxIssue(raw: unknown): string | null {
	return issueOf(ClipSfxSchema.safeParse(raw));
}

/** Keeps the fields of `raw` that `shape` does not know (newer builds' fields survive a repair, S01:DOC-005). */
function unknownFields(raw: Record<string, unknown>, shape: object): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(raw)) if (!Object.hasOwn(shape, k)) out[k] = v;
	return out;
}

/** Parses one optional field: its value when valid, else undefined (dropped). */
function opt<T>(schema: z.ZodType<T>, v: unknown): T | undefined {
	if (v === undefined) return undefined;
	const r = schema.safeParse(v);
	return r.success ? r.data : undefined;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Lenient read of one stored cue: valid cues as they are; otherwise each field on its own (bad optional fields
 * dropped, the frame clamped to 0…max, an unknown kind / weight / source → `manual` / `support` / `user`). Null when
 * it has no usable id or frame. Pure; never throws.
 */
export function readSoundCue(raw: unknown, key?: string): SoundCue | null {
	if (!isRecord(raw)) return null;
	const ok = SoundCueSchema.safeParse(raw);
	if (ok.success && (key === undefined || ok.data.id === key)) return ok.data as SoundCue;
	const cueId =
		typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= SOUND_DESIGN_LIMITS.id ? raw.id : key;
	if (!cueId || cueId.length > SOUND_DESIGN_LIMITS.id || !finite(raw.frame)) return null;
	const shape = SoundCueSchema.shape;
	const out: Record<string, unknown> = { ...unknownFields(raw, shape), id: cueId };
	out.frame = Math.min(SOUND_DESIGN_LIMITS.maxFrame, Math.max(0, Math.round(raw.frame)));
	out.kind = opt(shape.kind, raw.kind) ?? 'manual';
	out.weight = opt(shape.weight, raw.weight) ?? 'support';
	out.source = opt(shape.source, raw.source) ?? 'user';
	for (const k of [
		'label',
		'align',
		'pan',
		'panSweep',
		'pitchSt',
		'stopBefore',
		'build',
		'anchor',
		'anchorOffset',
		'confidence',
		'reason',
		'muted',
		'window',
	] as const) {
		const v = opt(shape[k] as z.ZodType<unknown>, raw[k]);
		if (v !== undefined) out[k] = v;
	}
	for (const k of ['types', 'soundIds', 'placedClipIds'] as const) {
		if (!Array.isArray(raw[k])) continue;
		const item = k === 'types' ? StoredSoundTypeSchema : id();
		const max = k === 'types' ? SOUND_DESIGN_LIMITS.types : SOUND_DESIGN_LIMITS.soundIds;
		const list = [...new Set((raw[k] as unknown[]).filter((x) => item.safeParse(x).success))].slice(0, max);
		out[k] = list;
	}
	const r = SoundCueSchema.safeParse(out);
	return r.success ? (r.data as SoundCue) : null;
}

/**
 * Lenient read of a stored `SoundDesignSettings.style`: valid as it is; otherwise field by field (unreadable fields
 * dropped, unknown newer ones kept). Null when it is not an object. Pure; never throws.
 */
export function readSoundDesignStyle(raw: unknown): SoundDesignStyle | null {
	if (!isRecord(raw)) return null;
	const ok = SoundDesignStyleSchema.safeParse(raw);
	if (ok.success) return ok.data as SoundDesignStyle;
	const shape = SoundDesignStyleSchema.shape;
	const out: Record<string, unknown> = { ...unknownFields(raw, shape) };
	for (const k of ['personality', 'runs', 'typing', 'musicCarriesCuts', 'duckUnderTyping'] as const) {
		const v = opt(shape[k] as z.ZodType<unknown>, raw[k]);
		if (v !== undefined) out[k] = v;
	}
	const r = SoundDesignStyleSchema.safeParse(out);
	return r.success ? (r.data as SoundDesignStyle) : {};
}

/** Lenient read of stored settings: each field on its own, defaults for the unreadable ones. */
export function readSoundDesignSettings(raw: unknown): SoundDesignSettings {
	if (!isRecord(raw)) return { ...DEFAULT_SOUND_DESIGN_SETTINGS, sfxTrackIds: [], palette: [] };
	const ok = SoundDesignSettingsSchema.safeParse(raw);
	if (ok.success) return ok.data as SoundDesignSettings;
	const shape = SoundDesignSettingsSchema.shape;
	const out: Record<string, unknown> = { ...unknownFields(raw, shape) };
	const d = DEFAULT_SOUND_DESIGN_SETTINGS;
	out.delivery = opt(shape.delivery, raw.delivery) ?? d.delivery;
	out.density = opt(shape.density, raw.density) ?? d.density;
	out.roomBus = opt(shape.roomBus, raw.roomBus) ?? null;
	out.seed = finite(raw.seed) ? Math.min(0xffff_ffff, Math.max(0, Math.floor(raw.seed))) : d.seed;
	const ag = opt(shape.agentsMayApply, raw.agentsMayApply);
	if (ag !== undefined) out.agentsMayApply = ag;
	const ids = (v: unknown, max: number) =>
		Array.isArray(v) ? [...new Set(v.filter((x) => id().safeParse(x).success))].slice(0, max) : [];
	out.sfxTrackIds = ids(raw.sfxTrackIds, SOUND_DESIGN_LIMITS.sfxTracks);
	if (raw.palette !== undefined) out.palette = ids(raw.palette, SOUND_DESIGN_LIMITS.palette);
	const cr = opt(shape.credits, raw.credits);
	if (cr !== undefined) out.credits = cr;
	const rp = opt(shape.referenceProfile, raw.referenceProfile);
	if (rp !== undefined) out.referenceProfile = rp;
	else delete out.referenceProfile;
	if (raw.style !== undefined) {
		const st = readSoundDesignStyle(raw.style);
		if (st) out.style = st;
		else delete out.style;
	}
	const r = SoundDesignSettingsSchema.safeParse(out);
	return r.success ? (r.data as SoundDesignSettings) : { ...d, sfxTrackIds: [], palette: [] };
}

/**
 * Lenient read of a stored `Sequence.soundDesign`: valid data as is; otherwise cue by cue (`readSoundCue`; unreadable
 * cues dropped, keys set to the cue ids, at most `SOUND_DESIGN_LIMITS.cues` kept by frame), settings field by field,
 * an unreadable `lastCheck` dropped. Null when it is not an object. Pure; never throws.
 */
export function readSoundDesign(raw: unknown): SoundDesign | null {
	if (!isRecord(raw)) return null;
	if (soundDesignIssue(raw) === null) return raw as SoundDesign;
	const out: Record<string, unknown> = { ...unknownFields(raw, SoundDesignSchema.shape) };
	const cues: SoundCue[] = [];
	const seen = new Set<string>();
	if (isRecord(raw.cues))
		for (const [key, v] of Object.entries(raw.cues)) {
			const c = readSoundCue(v, key);
			if (!c || seen.has(c.id)) continue;
			seen.add(c.id);
			cues.push(c);
		}
	cues.sort((a, b) => a.frame - b.frame || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const rec: Record<string, SoundCue> = Object.create(null);
	for (const c of cues.slice(0, SOUND_DESIGN_LIMITS.cues)) rec[c.id] = c;
	out.cues = rec;
	if (raw.settings !== undefined) out.settings = readSoundDesignSettings(raw.settings);
	const lc = opt(SoundCheckSummarySchema, raw.lastCheck);
	if (lc !== undefined) out.lastCheck = lc;
	const mix = readSoundDesignMix(raw.mix);
	if (mix) out.mix = mix;
	else delete out.mix;
	const ack = readSoundAcknowledgements(raw.acknowledged);
	if (ack) out.acknowledged = ack;
	else delete out.acknowledged;
	return soundDesignIssue(out) === null ? (out as SoundDesign) : { cues: rec };
}

/**
 * Lenient read of `SoundDesign.acknowledged`: each entry on its own (a malformed one, a key that is not a finding key or
 * does not start with its code, dropped), at most `SOUND_DESIGN_LIMITS.acknowledged` kept — the most recent by `at`.
 * Null when nothing readable is left. Pure; never throws.
 */
export function readSoundAcknowledgements(raw: unknown): Record<string, SoundAcknowledgement> | null {
	if (!isRecord(raw)) return null;
	const list: [string, SoundAcknowledgement][] = [];
	for (const [key, v] of Object.entries(raw)) {
		if (key.length > SOUND_DESIGN_LIMITS.ackKey || !SOUND_ACK_KEY_RE.test(key)) continue;
		const r = SoundAcknowledgementSchema.safeParse(v);
		if (!r.success || !key.startsWith(`${r.data.code}:`)) continue;
		list.push([key, r.data as SoundAcknowledgement]);
	}
	if (!list.length) return null;
	list.sort((a, b) => (a[1].at > b[1].at ? -1 : a[1].at < b[1].at ? 1 : a[0] < b[0] ? -1 : 1));
	const out: Record<string, SoundAcknowledgement> = Object.create(null);
	for (const [k, v] of list.slice(0, SOUND_DESIGN_LIMITS.acknowledged)) out[k] = v;
	return out;
}

/**
 * Lenient read of `SoundDesign.mix`: each cue record, build filter and the room glue on its own (unreadable ones
 * dropped: the automation they wrote stays in the mix as ordinary keyframes, it can no longer be removed as a unit).
 * Null when nothing readable is left. Pure; never throws.
 */
export function readSoundDesignMix(raw: unknown): SoundDesignMix | null {
	if (!isRecord(raw)) return null;
	const ok = SoundDesignMixSchema.safeParse(raw);
	if (ok.success) return ok.data as SoundDesignMix;
	const out: Record<string, unknown> = { ...unknownFields(raw, SoundDesignMixSchema.shape) };
	for (const bucket of ['cues', 'orphans'] as const) {
		const rawBucket = raw[bucket];
		if (!isRecord(rawBucket)) continue;
		const cues: Record<string, CueMix> = Object.create(null);
		for (const [k, v] of Object.entries(rawBucket)) {
			if (!isRecord(v)) continue;
			const c: Record<string, unknown> = { ...unknownFields(v, CueMixSchema.shape) };
			const sb = opt(CueMixSchema.shape.stopBefore, v.stopBefore);
			if (sb) c.stopBefore = sb;
			const b = opt(CueMixSchema.shape.build, v.build);
			if (b) c.build = b;
			if (c.stopBefore || c.build) cues[k] = c as CueMix;
		}
		out[bucket] = cues;
	}
	if (isRecord(raw.buildFilters)) {
		const f: Record<string, string> = Object.create(null);
		for (const [k, v] of Object.entries(raw.buildFilters)) if (id().safeParse(v).success) f[k] = v as string;
		out.buildFilters = f;
	}
	const room = opt(RoomGlueSchema, raw.room);
	if (room) out.room = room;
	const r = SoundDesignMixSchema.safeParse(out);
	return r.success ? (r.data as SoundDesignMix) : null;
}

/**
 * Whether a cue's realisation record is written into the mix (Cue Seam "written" spans, delivery re-dips): a record of
 * a muted cue (`suspended`, `writes: []`) is not. Never throws.
 */
export function cueMixWritten(
	rec: { writes?: readonly unknown[]; suspended?: boolean } | null | undefined,
): boolean {
	return !!rec && rec.suspended !== true && Array.isArray(rec.writes) && rec.writes.length > 0;
}

/** Lenient read of a stored `AudioClip.sfx` (field by field); null when it is not an object. Pure; never throws. */
export function readClipSfx(raw: unknown): ClipSfx | null {
	if (!isRecord(raw)) return null;
	const ok = ClipSfxSchema.safeParse(raw);
	if (ok.success) return ok.data as ClipSfx;
	const soundId = opt(id(), raw.soundId) ?? null;
	const shape = ClipSfxSchema.shape;
	const out: Record<string, unknown> = { ...unknownFields(raw, shape), soundId };
	out.cueId = opt(shape.cueId, raw.cueId) ?? null;
	out.layer = finite(raw.layer)
		? Math.min(SOUND_DESIGN_LIMITS.layers - 1, Math.max(0, Math.round(raw.layer)))
		: 0;
	out.role = opt(shape.role, raw.role) ?? 'support';
	if (Array.isArray(raw.alternatives))
		out.alternatives = [...new Set(raw.alternatives.filter((x) => id().safeParse(x).success))].slice(
			0,
			SOUND_DESIGN_LIMITS.alternatives,
		);
	const p = isRecord(raw.placement) ? raw.placement : {};
	out.placement = {
		...unknownFields(p, SfxPlacementSchema.shape),
		align: opt(SfxPlacementSchema.shape.align, p.align) ?? 'peak',
		peakFlicks: finite(p.peakFlicks) ? Math.max(0, Math.round(p.peakFlicks)) : 0,
		errorFlicks: finite(p.errorFlicks) ? Math.max(0, Math.round(p.errorFlicks)) : 0,
	};
	// a level that does not read is dropped (the clip keeps its gain; it no longer counts as a default)
	const level = opt(SfxLevelSchema, raw.level);
	if (level !== undefined) out.level = level;
	else delete out.level;
	// a pitch record that does not read is dropped (the clip's speed is then read as before the record existed)
	const pitch = opt(SfxPitchSchema, raw.pitch);
	if (pitch !== undefined) out.pitch = pitch;
	else delete out.pitch;
	const r = ClipSfxSchema.safeParse(out);
	return r.success ? (r.data as ClipSfx) : null;
}

/** A sequence's sound-design settings with read-time defaults (absent = defaults; never throws). */
export function soundDesignSettingsOf(seq: { soundDesign?: unknown }): SoundDesignSettings {
	const sd = seq.soundDesign;
	return readSoundDesignSettings(isRecord(sd) ? sd.settings : undefined);
}
