// Effect presets (S03:FX-030, AGT-020; S05:EFX-001 "Presets" bin): the versioned JSON format shared by the
// editor's "Save Preset…", the user library on the engine and agents. A preset holds effect instances with their
// params and keyframes, plus the intrinsic values chosen (Motion, Opacity, Crop, Volume, Panner), and a type that
// decides how key times map onto clips of other durations (Scale / Anchor to In Point / Anchor to Out Point).
//
// Key times inside a preset are NOT content time: they are offsets in flicks from the first frame of the clip the
// preset was saved from, in sequence time (frame index × flicks per frame), so a preset is independent of source
// in-points, clip speed and frame rate. `source.duration` (frames at `source.frameRate`) is the length they refer
// to. Objects are loose (unknown fields survive a round trip, like the document, S01:DOC-005); unknown effect ids
// are kept verbatim and only flagged (`presetIssues`), so presets made with a newer build stay intact.
import { z } from 'zod';
import { utf8Length } from '../clipboard/payload.ts';
import type { Ease, Interpolation, ParamValue, RationalT, Vec2 } from '../schema/common.ts';
import {
	EaseSchema,
	InterpolationSchema,
	ParamValueSchema,
	RationalSchema,
	Vec2Schema,
} from '../schema/common.ts';
import { type BlendMode, BlendModeSchema } from '../schema/sequence.ts';

export const EFFECT_PRESET_FORMAT = 'jasper-effect-preset';
export const EFFECT_PRESET_VERSION = 1;
/** An exported `.json` file with several presets (and their bins). */
export const EFFECT_PRESET_BUNDLE_FORMAT = 'jasper-effect-presets';
/** Presets larger than this (UTF-8 JSON) are refused (agents, imports). */
export const EFFECT_PRESET_MAX_BYTES = 2 * 1024 * 1024;

export const EFFECT_PRESET_TYPES = ['scale', 'anchor-in', 'anchor-out'] as const;
export type EffectPresetType = (typeof EFFECT_PRESET_TYPES)[number];
export const EffectPresetTypeSchema = z.enum(EFFECT_PRESET_TYPES);
/** Premiere's labels of the three types (Save Preset dialog, Effects panel tooltip). */
export const EFFECT_PRESET_TYPE_LABELS: Record<EffectPresetType, string> = {
	scale: 'Scale',
	'anchor-in': 'Anchor to In Point',
	'anchor-out': 'Anchor to Out Point',
};

/**
 * A preset keyframe. `time` = offset in flicks from the first frame (may be negative or past the end: off-clip keys
 * are kept, S01:KF-006). `id`, `interpolation` and the eases are optional so agents can author presets tersely;
 * applying always gives keys new ids.
 */
export const PresetKeyframeSchema = z.looseObject({
	id: z.string().optional(),
	time: z.number().int(),
	value: z.unknown(),
	interpolation: InterpolationSchema.optional(),
	easeIn: EaseSchema.optional(),
	easeOut: EaseSchema.optional(),
});
export type PresetKeyframe<T = unknown> = {
	id?: string;
	time: number;
	value: T;
	interpolation?: Interpolation;
	easeIn?: Ease;
	easeOut?: Ease;
};

function presetAnim<T extends z.ZodType>(value: T) {
	return z.looseObject({
		value,
		keyframes: z.array(PresetKeyframeSchema.extend({ value })).optional(),
	});
}
export type PresetAnim<T> = { value: T; keyframes?: PresetKeyframe<T>[] };

const PresetAnimNumber = presetAnim(z.number());
const PresetAnimVec2 = presetAnim(Vec2Schema);
const PresetAnimParam = presetAnim(ParamValueSchema);

/** Motion (S01 §11.1): any subset of the transform; applying overwrites only the given properties. */
export const PresetMotionSchema = z.looseObject({
	position: PresetAnimVec2.optional(),
	anchor: PresetAnimVec2.optional(),
	scale: PresetAnimNumber.optional(),
	scaleWidth: PresetAnimNumber.optional(),
	uniformScale: z.boolean().optional(),
	rotation: PresetAnimNumber.optional(),
});
export type PresetMotion = {
	position?: PresetAnim<Vec2>;
	anchor?: PresetAnim<Vec2>;
	scale?: PresetAnim<number>;
	scaleWidth?: PresetAnim<number>;
	uniformScale?: boolean;
	rotation?: PresetAnim<number>;
};
export const MOTION_PROPERTIES = ['position', 'anchor', 'scale', 'scaleWidth', 'rotation'] as const;

export const PresetEffectSchema = z.looseObject({
	/** The instance id it had when saved (informational; applying gives new ids). */
	id: z.string().optional(),
	effectId: z.string().min(1),
	effectVersion: z.number().int().min(1).optional(),
	enabled: z.boolean().optional(),
	params: z.record(z.string(), PresetAnimParam),
});
export type PresetEffect = {
	id?: string;
	effectId: string;
	effectVersion?: number;
	enabled?: boolean;
	params: Record<string, PresetAnim<ParamValue>>;
};

export const PresetIntrinsicSchema = z.looseObject({
	motion: PresetMotionSchema.optional(),
	opacity: PresetAnimNumber.optional(),
	blendMode: BlendModeSchema.optional(),
	/** The pinned Crop (the clip's first `jasper.crop`): applying overwrites it (or creates it at index 0). */
	crop: z
		.looseObject({ enabled: z.boolean().optional(), params: z.record(z.string(), PresetAnimParam) })
		.optional(),
	/** Volume (Level, `volumeDb`) and Panner (Balance, `pan`) of audio clips. */
	volume: PresetAnimNumber.optional(),
	pan: PresetAnimNumber.optional(),
});
export type PresetIntrinsic = {
	motion?: PresetMotion;
	opacity?: PresetAnim<number>;
	blendMode?: BlendMode;
	crop?: { enabled?: boolean; params: Record<string, PresetAnim<ParamValue>> };
	volume?: PresetAnim<number>;
	pan?: PresetAnim<number>;
};

const BoxSchema = z.looseObject({ width: z.number().positive(), height: z.number().positive() });

export const EffectPresetSchema = z.looseObject({
	format: z.literal(EFFECT_PRESET_FORMAT),
	version: z.literal(EFFECT_PRESET_VERSION),
	id: z.string().min(1).max(80),
	name: z.string().trim().min(1).max(120),
	description: z.string().max(2000).optional(),
	type: EffectPresetTypeSchema,
	/** User bin (`EffectPresetFolder.id`); absent/null = the root of the Presets bin. */
	folderId: z.string().nullable().optional(),
	/** Read-only presets shipped with the app (Effects ▸ Presets ▸ <category>). */
	builtIn: z.boolean().optional(),
	/** Built-ins: the sub-bin they show in ("Blurs", "Fades", …). */
	category: z.string().optional(),
	createdAt: z.string().optional(),
	updatedAt: z.string().optional(),
	/**
	 * `absolute` (default, Premiere): values apply as saved. `relative`: Motion values are fractions of the source
	 * frame (position), of the source layer box (anchor) and of "fit to frame" (scale), re-expressed on each target —
	 * the built-in Motion presets use it so they work on any frame size and media size.
	 */
	spatial: z.enum(['absolute', 'relative']).optional(),
	source: z.looseObject({
		/** Kind of the clip it was saved from (`video`, `text`, …). */
		clipKind: z.string().optional(),
		/** Length of the source clip in frames at `frameRate` (what Scale / Anchor to Out Point map from). */
		duration: z.number().int().min(1),
		frameRate: RationalSchema,
		/** Sequence frame size and layer box (`relative` Motion). */
		frame: BoxSchema.optional(),
		box: BoxSchema.optional(),
	}),
	intrinsic: PresetIntrinsicSchema.optional(),
	effects: z.array(PresetEffectSchema).optional(),
});

export type EffectPreset = {
	format: typeof EFFECT_PRESET_FORMAT;
	version: typeof EFFECT_PRESET_VERSION;
	id: string;
	name: string;
	description?: string;
	type: EffectPresetType;
	folderId?: string | null;
	builtIn?: boolean;
	category?: string;
	createdAt?: string;
	updatedAt?: string;
	spatial?: 'absolute' | 'relative';
	source: {
		clipKind?: string;
		duration: number;
		frameRate: RationalT;
		frame?: { width: number; height: number };
		box?: { width: number; height: number };
	};
	intrinsic?: PresetIntrinsic;
	effects?: PresetEffect[];
};

/** A user bin inside Effects ▸ Presets (nestable). */
export const EffectPresetFolderSchema = z.looseObject({
	id: z.string().min(1).max(80),
	name: z.string().trim().min(1).max(120),
	parentId: z.string().nullable().optional(),
});
export type EffectPresetFolder = { id: string; name: string; parentId?: string | null };

/** The user library: what the engine stores and serves (built-ins are not stored, they ship with the app). */
export const EffectPresetLibrarySchema = z.looseObject({
	format: z.literal('jasper-effect-preset-library'),
	version: z.literal(1),
	folders: z.array(EffectPresetFolderSchema),
	presets: z.array(EffectPresetSchema),
});
export type EffectPresetLibrary = {
	format: 'jasper-effect-preset-library';
	version: 1;
	folders: EffectPresetFolder[];
	presets: EffectPreset[];
};

/** An exported file (Export…): presets plus the bins they sit in. */
export const EffectPresetBundleSchema = z.looseObject({
	format: z.literal(EFFECT_PRESET_BUNDLE_FORMAT),
	version: z.literal(1),
	exportedAt: z.string().optional(),
	folders: z.array(EffectPresetFolderSchema).optional(),
	presets: z.array(EffectPresetSchema),
});
export type EffectPresetBundle = {
	format: typeof EFFECT_PRESET_BUNDLE_FORMAT;
	version: 1;
	exportedAt?: string;
	folders?: EffectPresetFolder[];
	presets: EffectPreset[];
};

export type PresetParseResult =
	| { ok: true; preset: EffectPreset }
	| { ok: false; code: 'E_SCHEMA' | 'E_INVALID_PARAM'; message: string };

function issueText(e: z.ZodError): string {
	const first = e.issues[0];
	return first ? `${first.path.join('.') || 'preset'}: ${first.message}` : 'invalid preset';
}

function sizeOk(raw: unknown): boolean {
	try {
		return utf8Length(JSON.stringify(raw)) <= EFFECT_PRESET_MAX_BYTES;
	} catch {
		return false;
	}
}

/** Validates one preset (inline agent JSON, a library entry, an imported file). Never throws. */
export function parseEffectPreset(raw: unknown): PresetParseResult {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw))
		return { ok: false, code: 'E_SCHEMA', message: 'An effect preset must be a JSON object' };
	const r = raw as Record<string, unknown>;
	if (r.format !== EFFECT_PRESET_FORMAT)
		return {
			ok: false,
			code: 'E_SCHEMA',
			message: `Not an effect preset (format must be "${EFFECT_PRESET_FORMAT}")`,
		};
	if (typeof r.version === 'number' && r.version > EFFECT_PRESET_VERSION)
		return {
			ok: false,
			code: 'E_SCHEMA',
			message: `Effect preset version ${r.version} is newer than this app supports (${EFFECT_PRESET_VERSION})`,
		};
	if (!sizeOk(raw))
		return { ok: false, code: 'E_INVALID_PARAM', message: 'The effect preset is larger than 2 MB' };
	const p = EffectPresetSchema.safeParse(raw);
	if (!p.success) return { ok: false, code: 'E_SCHEMA', message: issueText(p.error) };
	const preset = p.data as unknown as EffectPreset;
	if (!preset.intrinsic && !preset.effects?.length)
		return { ok: false, code: 'E_INVALID_PARAM', message: 'The preset holds no effects or properties' };
	return { ok: true, preset };
}

/** Reads an imported `.json`: a bundle, one preset, a library file or an array of presets. */
export function parsePresetFile(
	raw: unknown,
): { ok: true; presets: unknown[]; folders: EffectPresetFolder[] } | { ok: false; message: string } {
	if (Array.isArray(raw)) return { ok: true, presets: raw, folders: [] };
	if (!raw || typeof raw !== 'object') return { ok: false, message: 'The file is not a JSON object' };
	const r = raw as Record<string, unknown>;
	if (r.format === EFFECT_PRESET_FORMAT) return { ok: true, presets: [raw], folders: [] };
	if (r.format === EFFECT_PRESET_BUNDLE_FORMAT || r.format === 'jasper-effect-preset-library') {
		if (!Array.isArray(r.presets)) return { ok: false, message: 'The file has no presets list' };
		const folders = z.array(EffectPresetFolderSchema).safeParse(r.folders ?? []);
		return {
			ok: true,
			presets: r.presets,
			folders: folders.success ? (folders.data as EffectPresetFolder[]) : [],
		};
	}
	return { ok: false, message: 'Not a JasperEditor effect preset file' };
}

/** An exported file for presets (and the bins they use). */
export function buildPresetBundle(
	presets: readonly EffectPreset[],
	folders: readonly EffectPresetFolder[] = [],
	now?: string,
): EffectPresetBundle {
	const used = new Set<string>();
	const byId = new Map(folders.map((f) => [f.id, f]));
	for (const p of presets) {
		let id = p.folderId ?? null;
		while (id && !used.has(id) && byId.has(id)) {
			used.add(id);
			id = byId.get(id)!.parentId ?? null;
		}
	}
	return {
		format: EFFECT_PRESET_BUNDLE_FORMAT,
		version: 1,
		...(now ? { exportedAt: now } : {}),
		folders: folders.filter((f) => used.has(f.id)).map((f) => ({ ...f })),
		presets: presets.map((p) => {
			const { builtIn: _b, ...rest } = JSON.parse(JSON.stringify(p)) as EffectPreset;
			return rest;
		}),
	};
}
