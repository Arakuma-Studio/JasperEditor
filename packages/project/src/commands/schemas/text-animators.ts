// Text animator commands (workstream text-animators; After Effects Animation ▸ Animate Text / Add Text Selector,
// the "Animate:" and "Add:" menus, animator presets, Path Options, per-character 3D). Values of animator
// properties and selector fields are set with `param.set` / keyframe commands on their property keys
// (`["clip", clipId, "textAnimators", animatorId, "properties", "position"]`, …).
import { z } from 'zod';
import { cmd, IdListSchema, IdRefSchema, ParamAtSchema, RefDeclSchema } from './common.ts';

const AnimatorEntries = z
	.array(z.string().min(1))
	.describe(
		'"Animate ▸" entries: anchor, position, scale, skew, rotation, opacity, transformAll, lineAnchor, lineSpacing, characterOffset, characterValue, blur, fillColor, fillHue, fillSaturation, fillBrightness, fillOpacity, strokeColor, strokeHue, strokeSaturation, strokeBrightness, strokeOpacity, strokeWidth, tracking (companions are added like AE: Skew Axis, Tracking Type, Character Alignment / Range, Z and X/Y rotation with per-character 3D)',
	);
const AxisTags = z
	.array(z.string().regex(/^[\x20-\x7e]{4}$/, 'a 4-character OpenType axis tag, e.g. "wght"'))
	.describe('Variable font axes to offset (4-letter tags, e.g. ["wght", "wdth"])');

/** Adds an animator to a text clip (one Range Selector unless `selector: false`). */
export const TextAnimatorAddCmd = cmd('textAnimator.add', {
	clipId: IdRefSchema,
	properties: AnimatorEntries.optional(),
	axes: AxisTags.optional(),
	name: z.string().min(1).max(200).optional(),
	/** Add "Range Selector 1" (default true, as AE). */
	selector: z.boolean().optional(),
	/** Insert position among the clip's animators (default: last). */
	index: z.number().int().min(0).optional(),
	ref: RefDeclSchema.optional(),
});

export const TextAnimatorRemoveCmd = cmd('textAnimator.remove', {
	clipId: IdRefSchema,
	animatorIds: z.array(IdRefSchema).min(1),
});

/** Renames, enables / disables or moves an animator (animators apply top to bottom). */
export const TextAnimatorUpdateCmd = cmd('textAnimator.update', {
	clipId: IdRefSchema,
	animatorId: IdRefSchema,
	name: z.string().min(1).max(200).optional(),
	enabled: z.boolean().optional(),
	index: z.number().int().min(0).optional(),
});

export const TextAnimatorDuplicateCmd = cmd('textAnimator.duplicate', {
	clipId: IdRefSchema,
	animatorId: IdRefSchema,
	ref: RefDeclSchema.optional(),
});

/** "Add ▸ Property" on an animator (existing properties are kept). */
export const TextAnimatorAddPropertyCmd = cmd('textAnimator.addProperty', {
	clipId: IdRefSchema,
	animatorId: IdRefSchema,
	properties: AnimatorEntries.optional(),
	axes: AxisTags.optional(),
});

export const TextAnimatorRemovePropertyCmd = cmd('textAnimator.removeProperty', {
	clipId: IdRefSchema,
	animatorId: IdRefSchema,
	/** Property keys (`position`, `trackingType`, `axes.wght`, …). */
	properties: z.array(z.string().min(1)).min(1),
});

export const TextSelectorAddCmd = cmd('textSelector.add', {
	clipId: IdRefSchema,
	animatorId: IdRefSchema,
	kind: z.enum(['range', 'wiggly', 'expression']),
	name: z.string().min(1).max(200).optional(),
	ref: RefDeclSchema.optional(),
});

export const TextSelectorRemoveCmd = cmd('textSelector.remove', {
	clipId: IdRefSchema,
	animatorId: IdRefSchema,
	selectorIds: z.array(IdRefSchema).min(1),
});

export const TextSelectorUpdateCmd = cmd('textSelector.update', {
	clipId: IdRefSchema,
	animatorId: IdRefSchema,
	selectorId: IdRefSchema,
	name: z.string().min(1).max(200).optional(),
	enabled: z.boolean().optional(),
	index: z.number().int().min(0).optional(),
});

/**
 * Applies an animator preset (`list_text_animator_presets`) to text clips: its animators are appended (or replace
 * the clip's animators with `replace`), keys placed from `at` (In and loop presets: default the clip's first frame;
 * Out presets: default so that they end on the clip's last frame) over `durationFrames` (default the preset's
 * length at the sequence rate; loops repeat until the clip ends).
 */
export const TextAnimatorApplyPresetCmd = cmd('textAnimator.applyPreset', {
	clipIds: IdListSchema,
	preset: z.string().min(1),
	at: ParamAtSchema.optional(),
	durationFrames: z.number().int().min(1).max(100_000).optional(),
	replace: z.boolean().optional(),
});

/**
 * Converts the clips' In/Out text animations (`textAnimation`) into the equivalent animator presets (same windows,
 * Out anchored on the clip's end) and removes them.
 */
export const TextAnimatorConvertLegacyCmd = cmd('textAnimator.convertLegacy', {
	clipIds: IdListSchema,
});

/**
 * Path Options (AE): puts the characters on the path of one of the clip's masks (`maskId`; `null` = Path: None).
 * Give the mask mode "none" so it only guides the text.
 */
export const TextSetPathOptionsCmd = cmd('text.setPathOptions', {
	clipIds: IdListSchema,
	maskId: IdRefSchema.nullable().optional(),
	reversePath: z.boolean().optional(),
	perpendicularToPath: z.boolean().optional(),
	forceAlignment: z.boolean().optional(),
	firstMargin: z.number().optional(),
	lastMargin: z.number().optional(),
});

/** Enable / disable Per-character 3D (Z position / anchor / scale and X / Y rotation take effect). */
export const TextSetPerCharacter3dCmd = cmd('text.setPerCharacter3d', {
	clipIds: IdListSchema,
	enabled: z.boolean(),
});

/**
 * Registers a bundled font family in the project (Character panel font menu; returns the existing font when the
 * family is already registered). Use the id as a text style's `fontId`.
 */
export const FontAddCmd = cmd('font.add', {
	family: z.string().min(1).max(200),
	ref: RefDeclSchema.optional(),
});

export const TEXT_ANIMATOR_COMMANDS = [
	FontAddCmd,
	TextAnimatorAddCmd,
	TextAnimatorRemoveCmd,
	TextAnimatorUpdateCmd,
	TextAnimatorDuplicateCmd,
	TextAnimatorAddPropertyCmd,
	TextAnimatorRemovePropertyCmd,
	TextSelectorAddCmd,
	TextSelectorRemoveCmd,
	TextSelectorUpdateCmd,
	TextAnimatorApplyPresetCmd,
	TextAnimatorConvertLegacyCmd,
	TextSetPathOptionsCmd,
	TextSetPerCharacter3dCmd,
] as const;
