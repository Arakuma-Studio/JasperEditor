// Essential Sound (audio-fx; ported from filmcraft `crates/project/src/essential.rs`): clip audio types (Dialogue /
// Music / SFX / Ambience), their section settings and presets, and how those settings become ORDINARY clip effects.
//
// The panel never processes audio itself. Like Premiere, it drives effects on the clip "under the hood": Reduce
// Rumble is a Highpass, Reduce Noise a DeNoise, DeHum a DeHummer, DeEss a DeEsser, Reduce Reverb a DeReverb, Dynamics
// a Single-band Compressor, EQ a Simple 3-band EQ, Enhance Speech the Enhance Speech chain, Stereo Width the Stereo
// Width effect, Reverb a Studio Reverb and Mute the Mute effect. These instances carry `EffectInstance.essential` (the
// slot), appear in Effect Controls (keyframable) and render through the normal clip-effect path. Loudness Auto-Match
// writes clip gain, Clip Volume and Pan offset the clip's own Volume and pan (every keyframe; switched off they give
// the clip's levels back, `residual`); Ducking writes Volume keyframes
// (`audio.autoDuck`); Duration remixes the clip (`clip.remix`).
import { z } from 'zod';

export const AUDIO_TYPES = ['dialogue', 'music', 'sfx', 'ambience'] as const;
export type AudioType = (typeof AUDIO_TYPES)[number];
export const AUDIO_TYPE_LABELS: Record<AudioType, string> = {
	dialogue: 'Dialogue',
	music: 'Music',
	sfx: 'SFX',
	ambience: 'Ambience',
};

export const ESSENTIAL_SECTIONS = [
	'loudness',
	'repair',
	'clarity',
	'creative',
	'duration',
	'ducking',
	'pan',
] as const;
export type EssentialSection = (typeof ESSENTIAL_SECTIONS)[number];
export const SECTION_LABELS: Record<EssentialSection, string> = {
	loudness: 'Loudness',
	repair: 'Repair',
	clarity: 'Clarity',
	creative: 'Creative',
	duration: 'Duration',
	ducking: 'Ducking',
	pan: 'Pan',
};

/** The sections the panel shows for each type (Premiere's layout). */
export const TYPE_SECTIONS: Record<AudioType, readonly EssentialSection[]> = {
	dialogue: ['loudness', 'repair', 'clarity', 'creative'],
	music: ['loudness', 'duration', 'ducking'],
	sfx: ['loudness', 'creative', 'pan'],
	ambience: ['loudness', 'creative', 'ducking'],
};

/** Default loudness targets per type (LUFS): −23 LUFS (EBU R128) for every type, like Premiere's default. */
export const DEFAULT_LOUDNESS_TARGET = -23;

const SlotSchema = z.looseObject({ on: z.boolean(), amount: z.number().min(0).max(10) });

/** How an audio type was assigned by Auto Tag: the classifier's confidence (0…1), its scores and why. */
export const AutoTagSchema = z.looseObject({
	by: z.literal('auto'),
	confidence: z.number().min(0).max(1),
	scores: z.partialRecord(z.enum(AUDIO_TYPES), z.number().min(0).max(1)).optional(),
	reasons: z.array(z.string().max(300)).max(6).optional(),
});
export type AutoTag = z.infer<typeof AutoTagSchema>;

/** The Auto Tag marker of a clip's stored settings (null: no type, or a type the user set or confirmed). Never throws. */
export function essentialAutoTag(raw: unknown): AutoTag | null {
	if (!raw || typeof raw !== 'object') return null;
	const t = (raw as { type?: unknown }).type;
	if (typeof t !== 'string' || !(AUDIO_TYPES as readonly string[]).includes(t)) return null;
	const r = AutoTagSchema.safeParse((raw as { tagged?: unknown }).tagged);
	return r.success ? r.data : null;
}
export type Slot = { on: boolean; amount: number };

export const EssentialSoundSchema = z.looseObject({
	type: z.enum(AUDIO_TYPES),
	/** Last applied preset ('(Default)' or a name); '' after a manual change. */
	preset: z.string(),
	loudness: z.looseObject({
		enabled: z.boolean(),
		/** Integrated loudness of the clip's own signal measured by the last Auto-Match (LUFS), null = never. */
		measuredLufs: z.number().nullable(),
		targetLufs: z.number().min(-60).max(0).nullable(),
		/** Gain the match applied (dB); part of the clip gain while the section is on. */
		gainDb: z.number(),
	}),
	repair: z.looseObject({
		enabled: z.boolean(),
		noise: SlotSchema,
		rumble: SlotSchema,
		dehum: SlotSchema,
		humHz: z.union([z.literal(50), z.literal(60)]),
		deess: SlotSchema,
		reverb: SlotSchema,
	}),
	clarity: z.looseObject({
		enabled: z.boolean(),
		dynamics: SlotSchema,
		eq: SlotSchema,
		eqPreset: z.string(),
		enhance: SlotSchema,
		enhanceTone: z.enum(['low', 'high']),
	}),
	creative: z.looseObject({
		enabled: z.boolean(),
		reverb: SlotSchema,
		reverbPreset: z.string(),
		/** Stereo Width (Ambience): 0…10 → 100…200 %. */
		width: SlotSchema,
	}),
	duration: z.looseObject({
		method: z.enum(['remix', 'stretch']),
		targetSeconds: z.number().positive().nullable(),
		segments: z.number().min(0).max(100),
		variations: z.number().min(0).max(100),
	}),
	ducking: z.looseObject({
		enabled: z.boolean(),
		/** Duck against clips of these types. */
		against: z.array(z.enum(AUDIO_TYPES)),
		/** Also duck against clips without an audio type. */
		againstUntyped: z.boolean(),
		/** 0…10: how quiet a trigger may be and still count. */
		sensitivity: z.number().min(0).max(10),
		/** Reduction (dB, ≤ 0). */
		reduceDb: z.number().min(-40).max(0),
		/** Fade length (s). */
		fadeSeconds: z.number().min(0).max(5),
		/**
		 * Who set `reduceDb` (Phase 4 verification): `user` (the panel or `essentialSound.set`), `delivery`
		 * (`soundDesign.applyDelivery` chose it). Absent: the type default unless it differs from it (`duckingDepthBy`).
		 * An unreadable value reads as absent.
		 */
		depthBy: z.enum(['delivery', 'user']).optional().catch(undefined),
	}),
	pan: z.looseObject({ enabled: z.boolean(), value: z.number().min(-100).max(100) }),
	/** Clip Volume (panel footer): an offset in dB on the clip's Volume while on. */
	volume: z.looseObject({ on: z.boolean(), levelDb: z.number().min(-96).max(15) }),
	mute: z.boolean(),
	/**
	 * Level the fader ranges clamped away while Clip Volume / Pan offsets were applied (dB / pan units), per value
	 * (`value` or a keyframe id): given back when the offset changes, so switching an offset off restores the clip's
	 * own levels exactly. Managed by the commands, not a setting.
	 */
	residual: z
		.object({ volume: z.record(z.string(), z.number()), pan: z.record(z.string(), z.number()) })
		.optional(),
	/**
	 * The Pan section is an offset on the clip's own pan (sound-design Phase 0). Settings saved without it come from
	 * builds where switching Pan on or changing it wrote the value into the clip's pan (the static value, or one
	 * keyframe at the playhead): `migrateLegacyPan` converts them on load. Bookkeeping, not a setting.
	 */
	panOffset: z.literal(true).optional(),
	/**
	 * Auto Tag (sound design P6-R3): present while the type was chosen by `essentialSound.autoTag` and the user has not
	 * confirmed it (the clip badge is drawn "auto"); `essentialSound.setType` with the same type confirms it (removes
	 * this), another type replaces it. An unreadable value is dropped by `readEssentialSound` / `repairDocument`.
	 */
	tagged: AutoTagSchema.optional(),
});
export type EssentialSound = z.infer<typeof EssentialSoundSchema>;

export const DEFAULT_PRESET = '(Default)';

/** An EQ preset of Clarity ▸ EQ: (frequency Hz, gain dB at full amount) per band (our own values). */
export type EqPreset = {
	name: string;
	low: [number, number];
	mid: [number, number];
	midQ: number;
	high: [number, number];
};
export const EQ_PRESETS: readonly EqPreset[] = [
	{ name: 'Balanced Voice', low: [120, -3], mid: [3000, 3], midQ: 1, high: [10000, 2] },
	{ name: 'Presence Lift', low: [100, 0], mid: [4000, 5], midQ: 0.8, high: [12000, 1] },
	{ name: 'Warm Voice', low: [200, 3], mid: [3500, 1.5], midQ: 1, high: [9000, -2] },
	{ name: 'Clear Muddiness', low: [100, -2], mid: [300, -6], midQ: 1.4, high: [10000, 1] },
	{ name: 'Soften Harshness', low: [100, 0], mid: [3200, -5], midQ: 1.2, high: [9000, -2] },
	{ name: 'Bright Air', low: [100, 0], mid: [3000, 1], midQ: 1, high: [8000, 6] },
	{ name: 'Radio Voice', low: [150, -10], mid: [2500, 6], midQ: 1, high: [6000, -8] },
	{ name: 'Telephone', low: [400, -18], mid: [1500, 6], midQ: 0.7, high: [3500, -18] },
];

/** A reverb preset of Creative ▸ Reverb (Studio Reverb room size %, decay s, damping %, pre-delay ms; ours). */
export type ReverbPreset = { name: string; room: number; decay: number; damping: number; preDelay: number };
export const REVERB_PRESETS: readonly ReverbPreset[] = [
	{ name: 'Small Room', room: 25, decay: 0.6, damping: 60, preDelay: 5 },
	{ name: 'Warm Room', room: 40, decay: 0.9, damping: 80, preDelay: 8 },
	{ name: 'Medium Room', room: 50, decay: 1.2, damping: 50, preDelay: 12 },
	{ name: 'Bright Studio', room: 45, decay: 1, damping: 15, preDelay: 10 },
	{ name: 'Large Hall', room: 85, decay: 2.8, damping: 40, preDelay: 25 },
	{ name: 'Stone Church', room: 100, decay: 4.5, damping: 30, preDelay: 35 },
	{ name: 'Open Air', room: 90, decay: 0.5, damping: 70, preDelay: 0 },
];

const ci = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const eqPreset = (name: string) => EQ_PRESETS.find((p) => ci(p.name, name));
export const reverbPreset = (name: string) => REVERB_PRESETS.find((p) => ci(p.name, name));

const off = (amount: number): Slot => ({ on: false, amount });
const at = (amount: number): Slot => ({ on: true, amount });

/** A type's default settings. */
export function newEssentialSound(type: AudioType): EssentialSound {
	return {
		type,
		preset: DEFAULT_PRESET,
		loudness: { enabled: true, measuredLufs: null, targetLufs: null, gainDb: 0 },
		repair: {
			enabled: true,
			noise: off(5),
			rumble: off(5),
			dehum: off(5),
			humHz: 60,
			deess: off(5),
			reverb: off(5),
		},
		clarity: {
			enabled: true,
			dynamics: off(5),
			eq: off(5),
			eqPreset: EQ_PRESETS[0]!.name,
			enhance: off(10),
			enhanceTone: 'low',
		},
		creative: { enabled: true, reverb: off(5), reverbPreset: REVERB_PRESETS[0]!.name, width: off(5) },
		duration: { method: 'remix', targetSeconds: null, segments: 50, variations: 50 },
		ducking: {
			enabled: false,
			against: ['dialogue'],
			againstUntyped: false,
			sensitivity: 6,
			reduceDb: type === 'ambience' ? -10 : -15,
			fadeSeconds: 0.8,
		},
		pan: { enabled: false, value: 0 },
		volume: { on: false, levelDb: 0 },
		mute: false,
		panOffset: true,
	};
}

/**
 * Settings saved before the Pan section became an offset (no `panOffset` marker) whose Pan the old build wrote into
 * the clip's pan in a way the offset reading would misread: the section is on with a non-zero value for a type that
 * has it, and the clip's pan is not simply that value (it has keyframes, or the user moved it afterwards). Only then
 * does switching Pan off differ: the old build wrote 0 at the playhead, the offset reading would shift every
 * keyframe (and the static value) by the Pan value.
 */
export function legacyPanApplied(
	raw: unknown,
	pan: { value: number; keyframes: readonly unknown[] },
): boolean {
	if (!raw || typeof raw !== 'object' || (raw as { panOffset?: unknown }).panOffset === true) return false;
	const s = readEssentialSound(raw);
	if (!s || !TYPE_SECTIONS[s.type].includes('pan') || !s.pan.enabled || s.pan.value === 0) return false;
	return pan.keyframes.length > 0 || Math.abs(pan.value - s.pan.value) > 1e-9;
}

/**
 * Converts the Essential Sound settings of a clip saved before the Pan section became an offset (read-time
 * migration; optional marker, no schema bump). Nothing audible changes: where the old build's absolute writes cannot
 * be told apart from the user's own pan (`legacyPanApplied`), the Pan section is switched off with its value kept, so
 * the pan stays as saved and switching the section later applies a plain offset. Otherwise the settings already read
 * the same as an offset and only get the marker. Returns a note when the section was switched off.
 */
export function migrateLegacyPan(clip: {
	id: string;
	pan: { value: number; keyframes: readonly unknown[] };
	essential?: unknown;
}): string | null {
	const raw = clip.essential;
	if (!raw || typeof raw !== 'object' || (raw as { panOffset?: unknown }).panOffset === true) return null;
	const applied = legacyPanApplied(raw, clip.pan);
	const r = raw as Record<string, unknown> & { pan?: unknown };
	const pan = r.pan && typeof r.pan === 'object' ? (r.pan as Record<string, unknown>) : null;
	clip.essential = { ...r, ...(applied && pan ? { pan: { ...pan, enabled: false } } : {}), panOffset: true };
	return applied
		? `clip ${clip.id}: Essential Sound Pan (${String(pan?.value)}) was saved by a build that wrote it into the clip's pan; the Pan section is now an offset and is switched off (value kept) so the pan stays as saved`
		: null;
}

/** Reads a stored value with defaults for anything missing or invalid (documents from other versions / agents). */
export function readEssentialSound(raw: unknown): EssentialSound | null {
	if (!raw || typeof raw !== 'object') return null;
	const t = (raw as { type?: unknown }).type;
	if (typeof t !== 'string' || !(AUDIO_TYPES as readonly string[]).includes(t)) return null;
	const defaults = newEssentialSound(t as AudioType) as Record<string, unknown>;
	const merged = deepMerge(defaults, raw) as Record<string, unknown>;
	clampAll(merged as EssentialSound);
	let r = EssentialSoundSchema.safeParse(merged);
	if (!r.success) {
		// Fall back per section: one bad field must not reset the clip's other settings (the gain, Volume and
		// effects they already applied would then be reconciled from the wrong state).
		for (const issue of r.error.issues) {
			const k = String(issue.path[0]);
			if (k in defaults) merged[k] = defaults[k];
			else delete merged[k];
		}
		r = EssentialSoundSchema.safeParse(merged);
	}
	return r.success ? (r.data as EssentialSound) : (defaults as EssentialSound);
}

/**
 * Who owns a clip's Ducking amount: `user` when the user set it (or it differs from the type's default on settings of
 * older builds), `delivery` when a delivery preset chose it, `default` when it is the type's default. Never throws.
 */
export function duckingDepthBy(es: EssentialSound): 'default' | 'delivery' | 'user' {
	const by = (es.ducking as { depthBy?: unknown }).depthBy;
	if (by === 'user' || by === 'delivery') return by;
	return es.ducking.reduceDb === newEssentialSound(es.type).ducking.reduceDb ? 'default' : 'user';
}

/**
 * Strict read of explicit settings (a user preset from an agent or a file): missing fields take the type's defaults
 * and numbers are clamped into range like every other setting, but a field of the wrong type is an error message.
 */
export function parseEssentialSound(raw: unknown): EssentialSound | string {
	if (!raw || typeof raw !== 'object') return 'settings must be an object';
	const t = (raw as { type?: unknown }).type;
	if (typeof t !== 'string' || !(AUDIO_TYPES as readonly string[]).includes(t))
		return 'settings need a valid "type" (dialogue, music, sfx, ambience)';
	const merged = deepMerge(newEssentialSound(t as AudioType), raw) as EssentialSound;
	clampAll(merged);
	const r = EssentialSoundSchema.safeParse(merged);
	if (r.success) return r.data as EssentialSound;
	const i = r.error.issues[0];
	return `settings.${i?.path.join('.') ?? ''}: ${i?.message ?? 'invalid value'}`;
}

function deepMerge(base: unknown, over: unknown): unknown {
	if (
		!over ||
		typeof over !== 'object' ||
		Array.isArray(over) ||
		!base ||
		typeof base !== 'object' ||
		Array.isArray(base)
	)
		return over === undefined ? base : over;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [k, v] of Object.entries(over as Record<string, unknown>))
		out[k] = deepMerge((base as Record<string, unknown>)[k], v);
	return out;
}

export class EssentialSoundError extends Error {}

/** Every settable dotted key (for validation messages and the agent catalogue). */
export function essentialKeys(s: EssentialSound = newEssentialSound('dialogue')): string[] {
	const out: string[] = [];
	const walk = (v: unknown, p: string) => {
		if (v && typeof v === 'object' && !Array.isArray(v)) {
			for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
		} else out.push(p);
	};
	walk(s, '');
	return out.filter(
		(k) => k !== 'type' && k !== 'residual' && !k.startsWith('residual.') && k !== 'panOffset',
	);
}

/**
 * Sets one setting by dotted key (`repair.noise.amount`, `clarity.eqPreset`, a whole slot `repair.noise`, a section
 * object…). Values are validated (type, range, preset names); the audio type cannot change here. A manual change
 * clears `preset` (except preset, volume and mute).
 */
export function setEssentialValue(s: EssentialSound, key: string, value: unknown): EssentialSound {
	const parts = key.split('.').filter(Boolean);
	if (parts.length === 0) throw new EssentialSoundError('empty setting key');
	if (parts[0] === 'type')
		throw new EssentialSoundError('the audio type is changed with essentialSound.setType');
	if (parts[0] === 'residual')
		throw new EssentialSoundError(
			'"residual" is kept by the commands (clamped Clip Volume / Pan), not a setting',
		);
	if (parts[0] === 'panOffset')
		throw new EssentialSoundError(
			'"panOffset" marks how Pan is applied (kept by the commands), not a setting',
		);
	const next = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
	let cur: Record<string, unknown> = next;
	for (const p of parts.slice(0, -1)) {
		const v = cur[p];
		if (!v || typeof v !== 'object' || Array.isArray(v))
			throw new EssentialSoundError(`unknown Essential Sound setting "${key}"`);
		cur = v as Record<string, unknown>;
	}
	const last = parts[parts.length - 1]!;
	if (!(last in cur)) throw new EssentialSoundError(`unknown Essential Sound setting "${key}"`);
	const prev = cur[last];
	const kind = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
	const pk = kind(prev);
	const vk = kind(value);
	const okNull = pk === 'null' && vk === 'number';
	const okToNull =
		pk === 'number' &&
		vk === 'null' &&
		['loudness.measuredLufs', 'loudness.targetLufs', 'duration.targetSeconds'].includes(key);
	if (pk !== vk && !okNull && !okToNull && !(key.endsWith('Lufs') && vk === 'null'))
		throw new EssentialSoundError(`"${key}": expected ${pk === 'object' ? 'an object' : `a ${pk}`}`);
	cur[last] = pk === 'object' ? deepMerge(prev, value) : value;
	// clamp numbers into the schema's ranges
	clampAll(next as EssentialSound);
	const parsed = EssentialSoundSchema.safeParse(next);
	if (!parsed.success)
		throw new EssentialSoundError(`"${key}": ${parsed.error.issues[0]?.message ?? 'invalid value'}`);
	const out = parsed.data as EssentialSound;
	if (parts[0] === 'clarity' && parts[1] === 'eqPreset' && !eqPreset(out.clarity.eqPreset))
		throw new EssentialSoundError(
			`unknown EQ preset "${out.clarity.eqPreset}" (${EQ_PRESETS.map((p) => p.name).join(', ')})`,
		);
	if (parts[0] === 'creative' && parts[1] === 'reverbPreset' && !reverbPreset(out.creative.reverbPreset))
		throw new EssentialSoundError(
			`unknown reverb preset "${out.creative.reverbPreset}" (${REVERB_PRESETS.map((p) => p.name).join(', ')})`,
		);
	out.type = s.type;
	if (!['preset', 'volume', 'mute'].includes(parts[0]!)) out.preset = '';
	return out;
}

function clampAll(s: EssentialSound): void {
	const c = (v: number, lo: number, hi: number, d: number) =>
		Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : d;
	for (const slot of [
		s.repair?.noise,
		s.repair?.rumble,
		s.repair?.dehum,
		s.repair?.deess,
		s.repair?.reverb,
		s.clarity?.dynamics,
		s.clarity?.eq,
		s.clarity?.enhance,
		s.creative?.reverb,
		s.creative?.width,
	])
		if (slot && typeof slot.amount === 'number') slot.amount = c(slot.amount, 0, 10, 5);
	if (s.repair && typeof s.repair.humHz === 'number') s.repair.humHz = s.repair.humHz < 55 ? 50 : 60;
	if (s.ducking) {
		if (typeof s.ducking.sensitivity === 'number') s.ducking.sensitivity = c(s.ducking.sensitivity, 0, 10, 6);
		if (typeof s.ducking.reduceDb === 'number') s.ducking.reduceDb = c(s.ducking.reduceDb, -40, 0, -15);
		if (typeof s.ducking.fadeSeconds === 'number')
			s.ducking.fadeSeconds = c(s.ducking.fadeSeconds, 0, 5, 0.8);
		if (Array.isArray(s.ducking.against)) s.ducking.against = [...new Set(s.ducking.against)];
	}
	if (s.pan && typeof s.pan.value === 'number') s.pan.value = c(s.pan.value, -100, 100, 0);
	if (s.volume && typeof s.volume.levelDb === 'number') s.volume.levelDb = c(s.volume.levelDb, -96, 15, 0);
	if (s.loudness && typeof s.loudness.targetLufs === 'number')
		s.loudness.targetLufs = c(s.loudness.targetLufs, -60, 0, DEFAULT_LOUDNESS_TARGET);
	if (s.loudness && typeof s.loudness.gainDb === 'number')
		s.loudness.gainDb = c(s.loudness.gainDb, -96, 96, 0);
	if (s.duration) {
		if (typeof s.duration.segments === 'number') s.duration.segments = c(s.duration.segments, 0, 100, 50);
		if (typeof s.duration.variations === 'number')
			s.duration.variations = c(s.duration.variations, 0, 100, 50);
	}
}

/** Clip gain this state contributes (the Auto-Match gain while Loudness is on). */
export const loudnessGainDb = (s: EssentialSound | null) => (s?.loudness.enabled ? s.loudness.gainDb : 0);
/** Offset this state adds to the Volume level. */
export const volumeOffsetDb = (s: EssentialSound | null) => (s?.volume.on ? s.volume.levelDb : 0);
/** Offset this state adds to the clip pan (Pan section on, for the types that have one). */
export const panOffset = (s: EssentialSound | null) =>
	s && TYPE_SECTIONS[s.type].includes('pan') && s.pan.enabled ? s.pan.value : 0;

/** Reduce Rumble amount (0…10) → Highpass cutoff (30…150 Hz). */
export const rumbleCutoff = (amount: number) => 30 + amount * 12;

/** The essential effect slots, in canonical processing order. */
export const ESSENTIAL_SLOTS = [
	'rumble',
	'noise',
	'dehum',
	'deess',
	'reverbReduce',
	'dynamics',
	'eq',
	'enhance',
	'width',
	'reverb',
	'mute',
] as const;
export type EssentialSlot = (typeof ESSENTIAL_SLOTS)[number];

export const SLOT_EFFECTS: Record<EssentialSlot, string> = {
	rumble: 'jasper.audio.highpass',
	noise: 'jasper.audio.denoise',
	dehum: 'jasper.audio.dehummer',
	deess: 'jasper.audio.deesser',
	reverbReduce: 'jasper.audio.dereverb',
	dynamics: 'jasper.audio.single-band-compressor',
	eq: 'jasper.audio.simple-3-band-eq',
	enhance: 'jasper.audio.enhance-speech',
	width: 'jasper.audio.stereo-width',
	reverb: 'jasper.audio.studio-reverb',
	mute: 'jasper.audio.mute',
};

/** One effect these settings call for: slot, effect, enabled, static parameter values. */
export type EssentialEffect = {
	slot: EssentialSlot;
	effectId: string;
	enabled: boolean;
	params: Record<string, number | string | boolean>;
};

/** The clip effects the settings call for, in processing order. */
export function essentialEffects(s: EssentialSound | null): EssentialEffect[] {
	if (!s) return [];
	const out: EssentialEffect[] = [];
	const has = (sec: EssentialSection) => TYPE_SECTIONS[s.type].includes(sec);
	const push = (slot: EssentialSlot, enabled: boolean, params: EssentialEffect['params']) =>
		out.push({ slot, effectId: SLOT_EFFECTS[slot], enabled, params });
	if (has('repair')) {
		const r = s.repair;
		if (r.rumble.on) push('rumble', r.enabled, { cutoff: rumbleCutoff(r.rumble.amount) });
		if (r.noise.on) push('noise', r.enabled, { reduction: r.noise.amount * 3, threshold: 6 });
		if (r.dehum.on) push('dehum', r.enabled, { frequency: String(r.humHz), amount: r.dehum.amount * 10 });
		if (r.deess.on) {
			const a = r.deess.amount;
			push('deess', r.enabled, { threshold: -6 - a * 1.2, reduction: a * 2.4 });
		}
		if (r.reverb.on) push('reverbReduce', r.enabled, { amount: r.reverb.amount * 10 });
	}
	if (has('clarity')) {
		const c = s.clarity;
		if (c.dynamics.on) {
			const a = c.dynamics.amount;
			push('dynamics', c.enabled, {
				threshold: -12 - a * 2.4,
				ratio: 1.5 + a * 0.45,
				attack: 5,
				release: 120,
			});
		}
		if (c.eq.on) {
			const p = eqPreset(c.eqPreset) ?? EQ_PRESETS[0]!;
			const k = c.eq.amount / 10;
			push('eq', c.enabled, {
				lowFreq: p.low[0],
				low: p.low[1] * k,
				midFreq: p.mid[0],
				mid: p.mid[1] * k,
				midQ: p.midQ,
				highFreq: p.high[0],
				high: p.high[1] * k,
			});
		}
		if (c.enhance.on) push('enhance', c.enabled, { mix: c.enhance.amount * 10, tone: c.enhanceTone });
	}
	if (has('creative')) {
		const c = s.creative;
		if (c.width.on && s.type === 'ambience') push('width', c.enabled, { width: 100 + c.width.amount * 10 });
		if (c.reverb.on) {
			const p = reverbPreset(c.reverbPreset) ?? REVERB_PRESETS[0]!;
			push('reverb', c.enabled, {
				roomSize: p.room,
				decay: p.decay,
				damping: p.damping,
				preDelay: p.preDelay,
				mix: c.reverb.amount * 8,
			});
		}
	}
	if (s.mute) push('mute', true, { mute: true });
	return out;
}

/** A named preset for one audio type: settings applied on top of the type's defaults. */
export type EssentialPreset = { name: string; type: AudioType; settings: EssentialSound; builtin: boolean };

/** Built-in presets (our own names and values), "(Default)" first for each type. */
export function builtinEssentialPresets(): EssentialPreset[] {
	const mk = (type: AudioType, name: string, f: (s: EssentialSound) => void): EssentialPreset => {
		const s = newEssentialSound(type);
		f(s);
		s.preset = name;
		return { name, type, settings: s, builtin: true };
	};
	return [
		mk('dialogue', DEFAULT_PRESET, () => {}),
		mk('dialogue', 'Balanced Voice', (s) => {
			s.repair.rumble = at(4);
			s.clarity.dynamics = at(4);
			s.clarity.eq = at(5);
			s.clarity.eqPreset = 'Balanced Voice';
		}),
		mk('dialogue', 'Clean Up Noisy Dialogue', (s) => {
			s.repair.noise = at(6);
			s.repair.rumble = at(5);
			s.repair.dehum = at(5);
			s.clarity.dynamics = at(3);
		}),
		mk('dialogue', 'Podcast Voice', (s) => {
			s.repair.rumble = at(5);
			s.repair.deess = at(4);
			s.clarity.dynamics = at(6);
			s.clarity.eq = at(6);
			s.clarity.eqPreset = 'Presence Lift';
			s.clarity.enhance = at(7);
		}),
		mk('dialogue', 'Dry Up a Roomy Voice', (s) => {
			s.repair.reverb = at(6);
			s.repair.rumble = at(4);
			s.clarity.eq = at(4);
			s.clarity.eqPreset = 'Clear Muddiness';
		}),
		mk('dialogue', 'Phone Call', (s) => {
			s.clarity.eq = at(10);
			s.clarity.eqPreset = 'Telephone';
			s.clarity.dynamics = at(5);
		}),
		mk('dialogue', 'Radio Announcer', (s) => {
			s.clarity.eq = at(8);
			s.clarity.eqPreset = 'Radio Voice';
			s.clarity.dynamics = at(8);
			s.repair.deess = at(5);
		}),
		mk('dialogue', 'Voice in a Hall', (s) => {
			s.creative.reverb = at(5);
			s.creative.reverbPreset = 'Large Hall';
		}),
		mk('music', DEFAULT_PRESET, () => {}),
		mk('music', 'Duck Under Dialogue', (s) => {
			s.ducking.enabled = true;
		}),
		mk('music', 'Duck Deep Under Dialogue', (s) => {
			s.ducking.enabled = true;
			s.ducking.reduceDb = -24;
			s.ducking.fadeSeconds = 1.2;
		}),
		mk('music', 'Duck Under Voice and Effects', (s) => {
			s.ducking.enabled = true;
			s.ducking.against = ['dialogue', 'sfx'];
			s.ducking.reduceDb = -12;
		}),
		mk('sfx', DEFAULT_PRESET, () => {}),
		mk('sfx', 'From the Left', (s) => {
			s.pan = { enabled: true, value: -60 };
		}),
		mk('sfx', 'From the Right', (s) => {
			s.pan = { enabled: true, value: 60 };
		}),
		mk('sfx', 'In a Room', (s) => {
			s.creative.reverb = at(4);
			s.creative.reverbPreset = 'Small Room';
		}),
		mk('sfx', 'Far Away', (s) => {
			s.creative.reverb = at(8);
			s.creative.reverbPreset = 'Open Air';
		}),
		mk('ambience', DEFAULT_PRESET, () => {}),
		mk('ambience', 'Wide Outdoor', (s) => {
			s.creative.width = at(7);
		}),
		mk('ambience', 'Interior Room Tone', (s) => {
			s.creative.reverb = at(3);
			s.creative.reverbPreset = 'Warm Room';
		}),
		mk('ambience', 'Duck Under Dialogue', (s) => {
			s.ducking.enabled = true;
		}),
	];
}

/**
 * Applies a preset's settings, keeping what a preset does not own (the measured loudness and its match gain, Clip
 * Volume, Mute) when the clip already has the same type.
 */
export function withPreset(
	current: EssentialSound | null,
	preset: { name: string; settings: EssentialSound },
): EssentialSound {
	const s = JSON.parse(JSON.stringify(preset.settings)) as EssentialSound;
	s.preset = preset.name;
	// a preset never carries an Auto Tag marker; the clip keeps its own while the type stays
	delete s.tagged;
	if (current && current.type === s.type && current.tagged) s.tagged = { ...current.tagged };
	if (current && current.type === s.type) {
		s.loudness = {
			...s.loudness,
			measuredLufs: current.loudness.measuredLufs,
			targetLufs: current.loudness.targetLufs,
			gainDb: current.loudness.gainDb,
		};
		s.volume = { ...current.volume };
		s.mute = current.mute;
	}
	return s;
}
