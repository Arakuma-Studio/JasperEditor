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
import { StoredSoundTypeSchema } from '../sound/provenance.ts';
import type { DeepStrip } from './common.ts';

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
 * - `scene`: a media time (seconds) of a media, wherever the sequence shows it; `beat`: a beat of a (music) clip
 *   (`mediaSec`, when known, is the beat's media time);
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
	z.looseObject({ type: z.literal('scene'), mediaId: id(), mediaSec: z.number().min(0).max(864_000) }),
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
});
export type SoundDesignSettings = DeepStrip<z.infer<typeof SoundDesignSettingsSchema>>;

/** Summary of the last Sound Check (P5); stale when `mixHash` differs from the mix's fingerprint. */
export const SoundCheckSummarySchema = z.looseObject({
	mixHash: z.string().max(256),
	verdict: z.string().max(64),
	counts: z.record(z.string().max(64), z.number().int().min(0)),
	at: z.string().max(64),
});
export type SoundCheckSummary = DeepStrip<z.infer<typeof SoundCheckSummarySchema>>;

export const SoundDesignSchema = z.looseObject({
	cues: z.record(z.string(), SoundCueSchema),
	settings: SoundDesignSettingsSchema.optional(),
	lastCheck: SoundCheckSummarySchema.optional(),
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
	const p = issueOf(SoundDesignSchema.safeParse(raw));
	if (p) return p;
	for (const [key, cue] of Object.entries((raw as SoundDesign).cues))
		if (cue.id !== key) return `cues.${key}: key does not match the cue id ${cue.id}`;
	if (Object.keys((raw as SoundDesign).cues).length > SOUND_DESIGN_LIMITS.cues)
		return `more than ${SOUND_DESIGN_LIMITS.cues} cues`;
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
		'pitchSt',
		'stopBefore',
		'build',
		'anchor',
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
	return soundDesignIssue(out) === null ? (out as SoundDesign) : { cues: rec };
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
	const r = ClipSfxSchema.safeParse(out);
	return r.success ? (r.data as ClipSfx) : null;
}

/** A sequence's sound-design settings with read-time defaults (absent = defaults; never throws). */
export function soundDesignSettingsOf(seq: { soundDesign?: unknown }): SoundDesignSettings {
	const sd = seq.soundDesign;
	return readSoundDesignSettings(isRecord(sd) ? sd.settings : undefined);
}
