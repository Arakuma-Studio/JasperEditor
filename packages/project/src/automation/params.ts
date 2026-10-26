// Parameters of the editing-automation passes (spec 15 EA-020…EA-022), as plain JSON data: the same objects travel in
// the editor's dialogs, MCP tools, a proposal's report (the refresher re-plans with them) and style recipes (EA-010,
// which store one parameter object per pass). Every field is optional; `resolve…` fills the defaults measured on the
// user's projects (FINDINGS §3; the aspect of the sequence picks the shorts or the long-form values). Strict: unknown
// keys are refused at the entry points. Pure.
import { z } from 'zod';
import { KitPackSchema } from './kits.ts';

/** The passes this module plans (the overlays / recipes work packages add theirs). */
export const AUTOMATION_PASSES = ['decorate-cuts', 'punch-ins', 'ken-burns'] as const;
export type AutomationPass = (typeof AUTOMATION_PASSES)[number];

/** Review group of each pass's items (declared by feature `edit-automation`, `PROPOSAL_FEATURES`). */
export const AUTOMATION_PASS_GROUP: Record<AutomationPass, string> = {
	'decorate-cuts': 'cut-kits',
	'punch-ins': 'punch-ins',
	'ken-burns': 'ken-burns',
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
	/** `midpoint` (default) or `word`: the word start nearest the midpoint when the transcript has words. */
	start: z.enum(['midpoint', 'word']).optional(),
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
	/** Share of the candidate clips that get a move (default 0.15). */
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

export const AUTOMATION_PARAM_SCHEMAS = {
	'decorate-cuts': DecorateCutsParamsSchema,
	'punch-ins': PunchInParamsSchema,
	'ken-burns': KenBurnsParamsSchema,
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
} as const;
