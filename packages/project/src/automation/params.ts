// Parameters of the editing-automation passes (spec 15 EA-020…EA-022), as plain JSON data: the same objects travel in
// the editor's dialogs, MCP tools, a proposal's report (the refresher re-plans with them) and style recipes (EA-010,
// which store one parameter object per pass). Every field is optional; `resolve…` fills the defaults measured on the
// user's projects (FINDINGS §3; the aspect of the sequence picks the shorts or the long-form values). Strict: unknown
// keys are refused at the entry points. Pure.
import { z } from 'zod';
import { KitPackSchema } from './kits.ts';

/** The passes this module plans (the recipes work package combines them). */
export const AUTOMATION_PASSES = [
	'decorate-cuts',
	'punch-ins',
	'ken-burns',
	'reactions',
	'slides',
	'music',
	'stingers',
] as const;
export type AutomationPass = (typeof AUTOMATION_PASSES)[number];

/** Review group of each pass's items (declared by feature `edit-automation`, `PROPOSAL_FEATURES`). */
export const AUTOMATION_PASS_GROUP: Record<AutomationPass, string> = {
	'decorate-cuts': 'cut-kits',
	'punch-ins': 'punch-ins',
	'ken-burns': 'ken-burns',
	reactions: 'reactions',
	slides: 'slides',
	music: 'music',
	stingers: 'stingers',
};

const Seed = z.number().int().min(0).max(0xffff_ffff);
const Frame = z.number().int().min(0).max(1e9);
export const AutomationRangeSchema = z
	.strictObject({ start: Frame, end: Frame })
	.refine((r) => r.end > r.start, 'range.end must be after range.start');
export type AutomationRange = z.infer<typeof AutomationRangeSchema>;

/** A track: its id or label (`V1`). */
const TrackRef = z.string().min(1).max(128);

/** Sound types the SFX of a pass may use (taxonomy ids; `whoosh` by default). */
const SoundType = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export const SFX_SOURCE_TYPES = ['starter', 'pack', 'folder', 'synth'] as const;

/**
 * The SFX of a pass through the sound-design cue / placement system: a cue per decoration and `soundDesign.place`
 * with a library sound of `type` (the asset role), from the allowed sources, one installed pack (`packId`) or one of
 * the user's sound folders (`rootId`). `variety` = how many sounds the rotation cycles through.
 */
export const AutomationSfxSchema = z.strictObject({
	enabled: z.boolean().optional(),
	type: SoundType.optional(),
	sources: z.array(z.enum(SFX_SOURCE_TYPES)).min(1).max(4).optional(),
	packId: z.string().min(1).max(64).optional(),
	rootId: z.string().min(1).max(64).optional(),
	/** Clip gain (dB); absent = sound design's default level of a support sound. */
	gainDb: z.number().min(-60).max(12).optional(),
	variety: z.number().int().min(1).max(16).optional(),
});
export type AutomationSfx = z.infer<typeof AutomationSfxSchema>;

export const DecorateCutsParamsSchema = z.strictObject({
	/** A built-in kit pack id or a pack (data). Default: `shorts-shake` for vertical sequences, `long-pack` otherwise. */
	pack: z.union([z.enum(['shorts-shake', 'long-pack']), KitPackSchema]).optional(),
	/** Family weights over the pack's (target shares; 0 turns a family off). */
	families: z.record(z.string(), z.number().min(0).max(1e6)).optional(),
	/** Overrides the pack's repeat penalty (1 = independent choices). */
	repeatPenalty: z.number().min(0).max(1).optional(),
	/** Only cuts on this video track (the A-roll); default every picture cut of the sequence. */
	track: TrackRef.optional(),
	range: AutomationRangeSchema.optional(),
	/** Also decorate where an overlay (B-roll insert) enters or leaves (default false). */
	includeInsertEdges: z.boolean().optional(),
	/** Decorate jump cuts (same source; default true). */
	includeJumpCuts: z.boolean().optional(),
	/** At least this many frames between two decorated cuts (default 0). */
	minSpacingFrames: z.number().int().min(0).max(100_000).optional(),
	/** Share of the cuts that get a kit (default 1: every cut that fits). */
	coverage: z.number().min(0).max(1).optional(),
	/** Skip cuts that already carry an adjustment clip (default true). */
	skipDecorated: z.boolean().optional(),
	/** The video track for the kits (id or label); default an "FX" track above the picture, created when needed. */
	fxTrack: TrackRef.optional(),
	sfx: AutomationSfxSchema.optional(),
	seed: Seed.optional(),
});
export type DecorateCutsParams = z.infer<typeof DecorateCutsParamsSchema>;

/** Where a punch-in zooms: the frame centre, the subject (face tracking / saliency), or a point (0…1 of the frame). */
export const PunchTargetSchema = z.union([
	z.literal('center'),
	z.literal('subject'),
	z.strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
]);
export type PunchTarget = z.infer<typeof PunchTargetSchema>;

/** Where a punch-in starts (see `PunchInParamsSchema.start`). */
export const PunchStartSchema = z.enum(['caption', 'midpoint', 'word']);
export type PunchStart = z.infer<typeof PunchStartSchema>;

export const PunchInParamsSchema = z.strictObject({
	/** The A-roll track (id or label); default the video track carrying most of the picture. */
	track: TrackRef.optional(),
	range: AutomationRangeSchema.optional(),
	/** Clips shorter than this get none (default 1.5 s). */
	minClipSeconds: z.number().min(0).max(3600).optional(),
	/** Share of the candidate clips that get a punch-in (default 0.7); "!" / "?" phrases first. */
	density: z.number().min(0).max(1).optional(),
	/** Final scale in % of the clip's own (default 180). */
	scale: z.number().min(101).max(1000).optional(),
	/** Frames of the linear ramp (default 7). */
	rampFrames: z.number().int().min(1).max(600).optional(),
	/**
	 * `midpoint` (default); `word`: the word start nearest the midpoint; `caption` (schema v14): a caption start by the
	 * user's measured rule (punch-caption.ts). `word` and `caption` fall back to the midpoint when they find nothing.
	 */
	start: PunchStartSchema.optional(),
	target: PunchTargetSchema.optional(),
	/** `motion` (default): Motion keys on the clip (native export); `adjustment`: a Transform adjustment clip. */
	method: z.enum(['motion', 'adjustment']).optional(),
	/** Whoosh with the zoom (default on). */
	sfx: AutomationSfxSchema.optional(),
	/** Leave clips with a static reframing (scale / position of their own) alone (default true). */
	skipReframed: z.boolean().optional(),
	/** Clips the pass must leave alone (a style recipe's other passes). */
	excludeClipIds: z.array(z.string().min(1).max(128)).max(10_000).optional(),
	seed: Seed.optional(),
});
export type PunchInParams = z.infer<typeof PunchInParamsSchema>;

export const KenBurnsParamsSchema = z.strictObject({
	track: TrackRef.optional(),
	range: AutomationRangeSchema.optional(),
	/** Share of the A-roll's clips that get a move (default 0.15), chosen among the undecorated ones. */
	share: z.number().min(0).max(1).optional(),
	/** End scale in % (default 118 for vertical sequences, 130 otherwise). */
	scale: z.number().min(101).max(400).optional(),
	/** Zoom-ins per zoom-out (default 2: in : out = 2 : 1). */
	inOutRatio: z.number().min(0).max(100).optional(),
	/** Clips shorter than this get none (default 1 s). */
	minClipSeconds: z.number().min(0).max(3600).optional(),
	excludeClipIds: z.array(z.string().min(1).max(128)).max(10_000).optional(),
	seed: Seed.optional(),
});
export type KenBurnsParams = z.infer<typeof KenBurnsParamsSchema>;

/**
 * An asset role's source (spec 15 EA-011, EA-023, EA-025): the user's own files, never shipped — a project bin (its id
 * or name: recipes store the name), an engine-local folder (absolute path; its files are added to the project when
 * the proposal is made) and / or explicit project media. Several sources add up (bin, then folder, then media).
 */
export const AutomationAssetsSchema = z
	.strictObject({
		bin: z.string().min(1).max(256).optional(),
		folder: z.string().min(1).max(4096).optional(),
		mediaIds: z.array(z.string().min(1).max(128)).min(1).max(256).optional(),
	})
	.refine((a) => a.bin !== undefined || a.folder !== undefined || a.mediaIds !== undefined, {
		message: 'choose a bin, a folder or media',
	});
export type AutomationAssets = z.infer<typeof AutomationAssetsSchema>;

/** A reaction slot: the picture's centre (0…1 of the frame), flipped horizontally (left slots) and its weight. */
export const ReactionSlotSchema = z.strictObject({
	x: z.number().min(0).max(1),
	y: z.number().min(0).max(1),
	flip: z.boolean().optional(),
	weight: z.number().min(0).max(1e6).optional(),
	name: z.string().min(1).max(40).optional(),
});
export type ReactionSlot = z.infer<typeof ReactionSlotSchema>;

const WordList = z.array(z.string().min(1).max(80)).max(500);
/** Editable trigger word lists (per language; a phrase of several words matches consecutive words). */
export const ReactionWordsSchema = z.strictObject({
	/** `auto` (default): the transcript's language; else a language code whose built-in lists are used. */
	language: z.string().min(2).max(16).optional(),
	cta: WordList.optional(),
	exclamations: WordList.optional(),
});

export const ReactionParamsSchema = z.strictObject({
	/** The reaction images (asset role "reaction images"): a bin, a folder or media of the user's. */
	assets: AutomationAssetsSchema,
	/** The A-roll track (cuts to snap to, the speaker's faces); default the video track carrying most picture. */
	track: TrackRef.optional(),
	range: AutomationRangeSchema.optional(),
	/** The video track for the reactions; default a "Reactions" track at the top, created when needed. */
	reactionTrack: TrackRef.optional(),
	/** Where reactions sit; default the measured slots of the aspect (shorts bottom, long form mid height). */
	slots: z.array(ReactionSlotSchema).min(1).max(12).optional(),
	/** How long a reaction stays (default 2.1 s vertical, 2.6 s landscape: the measured medians). */
	durationSeconds: z.number().min(0.2).max(60).optional(),
	/** A reaction starts on a cut this close to its trigger (default 0.5 s). */
	snapSeconds: z.number().min(0).max(5).optional(),
	/** Motion scale in % of the picture's own size, drawn per item in [min, max] (default 60…65). */
	scale: z
		.strictObject({ min: z.number().min(1).max(1000), max: z.number().min(1).max(1000) })
		.refine((s) => s.max >= s.min, 'scale.max must be at least scale.min')
		.optional(),
	/** At most this share of the frame height (large pictures are scaled down to it; default 0.45). */
	maxHeight: z.number().min(0.02).max(1).optional(),
	/** S_Shake wobble (default on, Amplitude 0.8, Frequency 2). */
	wobble: z
		.strictObject({
			enabled: z.boolean().optional(),
			amplitude: z.number().min(0).max(5).optional(),
			frequency: z.number().min(0).max(30).optional(),
		})
		.optional(),
	triggers: z
		.strictObject({
			/** Transcript words: calls to action and exclamations (default on). */
			words: z.boolean().optional(),
			/** Sequence markers whose name contains `markerMatch` or names a reaction picture (default on). */
			markers: z.boolean().optional(),
			/** Where face tracking finds no face on the A-roll (default off; needs Track Faces). */
			speakerNotVisible: z.boolean().optional(),
		})
		.optional(),
	words: ReactionWordsSchema.optional(),
	/** Markers whose name contains this (case-insensitive) are triggers (default "reaction"). */
	markerMatch: z.string().min(1).max(80).optional(),
	/** A face-less stretch at least this long triggers a reaction (default 1.5 s). */
	notVisibleSeconds: z.number().min(0.2).max(60).optional(),
	/** At most this many reactions in any minute (default 12 vertical, 1 landscape). */
	maxPerMinute: z.number().min(0).max(120).optional(),
	/** At least this long between two reactions (default 0.5 s). */
	minGapSeconds: z.number().min(0).max(600).optional(),
	/** Other pictures offered per item in review (default 3). */
	alternatives: z.number().int().min(0).max(3).optional(),
	seed: Seed.optional(),
});
export type ReactionParams = z.infer<typeof ReactionParamsSchema>;

export const SLIDE_DIRECTIONS = ['down', 'up', 'left', 'right'] as const;
export const SLIDE_EASINGS = ['easeInOutQuad', 'easeInOutCubic'] as const;

export const SlideParamsSchema = z.strictObject({
	/** The A-roll track; overlays are the picture clips on the video tracks above it. */
	track: TrackRef.optional(),
	range: AutomationRangeSchema.optional(),
	/** Only overlays on these video tracks (default every video track above the A-roll). */
	overlayTracks: z.array(TrackRef).min(1).max(64).optional(),
	/** Length of each slide in frames (default 30). */
	frames: z.number().int().min(2).max(600).optional(),
	/** Share of overlay heads that slide in (default 0.53) and of tails that slide out (default 0.18). */
	heads: z.number().min(0).max(1).optional(),
	tails: z.number().min(0).max(1).optional(),
	/** Direction weights (default down 33, up 47, left 13, right 8). */
	directions: z.record(z.enum(SLIDE_DIRECTIONS), z.number().min(0).max(1e6)).optional(),
	/** Easing weights (default ease in-out quad 68, cubic 32). */
	easings: z.record(z.enum(SLIDE_EASINGS), z.number().min(0).max(1e6)).optional(),
	/** Smooth Slide motion blur (default high, 360° shutter). */
	motionBlur: z.enum(['off', 'low', 'medium', 'high']).optional(),
	shutterAngle: z.number().min(90).max(720).optional(),
	seed: Seed.optional(),
});
export type SlideParams = z.infer<typeof SlideParamsSchema>;

export const MusicParamsSchema = z.strictObject({
	/** The playlist (asset role "music folder"): a bin, a folder or media of the user's. */
	assets: AutomationAssetsSchema,
	range: AutomationRangeSchema.optional(),
	/** `playlist` (default): in the source's order; `shuffle`: a seeded order. */
	order: z.enum(['playlist', 'shuffle']).optional(),
	/** Switch to the next bed at the first cut after this long (default 52 s landscape; vertical: null = one bed per song). */
	bedSeconds: z.number().min(5).max(3600).nullable().optional(),
	/** Wait at most this long after `bedSeconds` for a cut (default 15 s); no cut → the switch is at `bedSeconds`. */
	maxSwitchDelaySeconds: z.number().min(0).max(600).optional(),
	/** The A-roll track whose cuts the beds switch on (default every picture cut). */
	track: TrackRef.optional(),
	/** Clip gain of the beds (default −33 dB). */
	gainDb: z.number().min(-60).max(12).optional(),
	/** Shorts intro step: the first bed at `gainDb` (−25) until the first cut (default on for vertical sequences). */
	intro: z
		.strictObject({ enabled: z.boolean().optional(), gainDb: z.number().min(-60).max(12).optional() })
		.optional(),
	/** Duck the beds under dialogue with the Essential Sound ducking (default off; 18 dB, 800 ms fades). */
	duck: z
		.strictObject({
			enabled: z.boolean().optional(),
			amountDb: z.number().min(0).max(48).optional(),
			fadeMs: z.number().min(0).max(10_000).optional(),
		})
		.optional(),
	/** The audio track for the beds; default a "Music" track, created when needed. */
	musicTrack: TrackRef.optional(),
	seed: Seed.optional(),
});
export type MusicParams = z.infer<typeof MusicParamsSchema>;

export const StingerParamsSchema = z.strictObject({
	/** The A-roll track (cuts to snap to). */
	track: TrackRef.optional(),
	range: AutomationRangeSchema.optional(),
	/** What marks a shouted punchline: a loudness peak, a "!" phrase, both (default) or either. */
	match: z.enum(['both', 'either', 'loudness', 'exclamation']).optional(),
	/** A peak is at least this many LU over the local median of the momentary loudness (default 6). */
	thresholdLu: z.number().min(1).max(40).optional(),
	/** Width of the local median window (default 10 s). */
	medianWindowSeconds: z.number().min(1).max(120).optional(),
	/** Length of a stinger in frames (default 29). */
	frames: z.number().int().min(1).max(600).optional(),
	/** A stinger starts on a cut this close after the punchline (default 0.5 s). */
	snapSeconds: z.number().min(0).max(5).optional(),
	maxPerMinute: z.number().min(0).max(60).optional(),
	minGapSeconds: z.number().min(0).max(600).optional(),
	/** Clip gain of the noise sound (default −18 dB). */
	gainDb: z.number().min(-60).max(12).optional(),
	/** `generated` (default): Jasper Synth's TV static; `library`: sounds of `sfx` from the library. */
	sound: z.enum(['generated', 'library', 'none']).optional(),
	sfx: AutomationSfxSchema.optional(),
	/** The video track for the noise pictures; default a "Stingers" track at the top, created when needed. */
	stingerTrack: TrackRef.optional(),
	seed: Seed.optional(),
});
export type StingerParams = z.infer<typeof StingerParamsSchema>;

export const AUTOMATION_PARAM_SCHEMAS = {
	'decorate-cuts': DecorateCutsParamsSchema,
	'punch-ins': PunchInParamsSchema,
	'ken-burns': KenBurnsParamsSchema,
	reactions: ReactionParamsSchema,
	slides: SlideParamsSchema,
	music: MusicParamsSchema,
	stingers: StingerParamsSchema,
} as const;

/** Defaults (the measured values). */
export const AUTOMATION_DEFAULTS = {
	seed: 1,
	sfxType: 'whoosh',
	sfxVariety: 12,
	coverage: 1,
	punchMinClipSeconds: 1.5,
	punchDensity: 0.7,
	punchScale: 180,
	punchRampFrames: 7,
	kenBurnsShare: 0.15,
	kenBurnsScaleVertical: 118,
	kenBurnsScaleLandscape: 130,
	kenBurnsInOutRatio: 2,
	kenBurnsMinClipSeconds: 1,
	reactionSecondsVertical: 2.1,
	reactionSecondsLandscape: 2.6,
	reactionSnapSeconds: 0.5,
	reactionScaleMin: 60,
	reactionScaleMax: 65,
	reactionMaxHeight: 0.45,
	reactionWobbleAmplitude: 0.8,
	reactionWobbleFrequency: 2,
	reactionMarkerMatch: 'reaction',
	reactionNotVisibleSeconds: 1.5,
	reactionMaxPerMinuteVertical: 12,
	reactionMaxPerMinuteLandscape: 1,
	reactionMinGapSeconds: 0.5,
	reactionAlternatives: 3,
	slideFrames: 30,
	slideHeads: 0.53,
	slideTails: 0.18,
	slideDirections: { down: 33, up: 47, left: 13, right: 8 },
	slideEasings: { easeInOutQuad: 68, easeInOutCubic: 32 },
	slideMotionBlur: 'high',
	slideShutterAngle: 360,
	musicBedSeconds: 52,
	musicMaxSwitchDelaySeconds: 15,
	musicGainDb: -33,
	musicIntroGainDb: -25,
	musicDuckDb: 18,
	musicDuckFadeMs: 800,
	stingerThresholdLu: 6,
	stingerMedianWindowSeconds: 10,
	stingerFrames: 29,
	stingerSnapSeconds: 0.5,
	stingerMaxPerMinute: 1,
	stingerMinGapSeconds: 10,
	stingerGainDb: -18,
} as const;
