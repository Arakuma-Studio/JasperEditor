// Keyframe assistant (easing) commands — docs/wp-notes/easing.md. Keyframe ids are global (no clip id); keys are
// grouped by property and processed in document order (property, then time).
import { z } from 'zod';
import { CubicEaseSchema, EaseCurveSchema, EaseSectionSchema, MultiEaseSchema } from '../../ease/curve.ts';
import { cmd, IdRefSchema } from './common.ts';

const KeyIds = z.array(IdRefSchema).min(1).max(100_000);
const Sections = z
	.array(EaseSectionSchema)
	.min(1)
	.max(3)
	.describe(
		'Which segments: "in" (into the first selected key), "middle" (between consecutive selected keys), "out" (after the last). Default: middle for 2+ keys of a property, in + out for one key',
	);
const ClipEaseSchema = z.strictObject({
	influence: z.number().gt(0).max(1),
	slope: z.number().min(-1e6).max(1e6),
});

/**
 * An ease clipboard entry (`copyEase`): one key's two eases, or segment curves (with the whole span as a multi-point
 * curve when it was copied from three or more keys of one property).
 */
export const EaseClipSchema = z.union([
	z.strictObject({ kind: z.literal('key'), easeIn: ClipEaseSchema, easeOut: ClipEaseSchema }),
	z.strictObject({
		kind: z.literal('segments'),
		segments: z.array(CubicEaseSchema).min(1).max(256),
		curve: MultiEaseSchema.optional(),
	}),
]);

/**
 * Applies an ease curve to the selected keys' segments. `cubic` (CSS cubic-bezier) shapes every chosen segment
 * exactly (keys become Bezier; neighbouring segments are kept). `multi` replaces the keys strictly inside each
 * property's span (first … last selected key) with keys at the curve's points — bounces, elastic, anticipation —
 * keeping point properties on their drawn motion path. Result: `{affected, created, removed}` keyframe ids.
 */
export const KeyframeApplyEaseCmd = cmd('keyframe.applyEase', {
	keyframeIds: KeyIds,
	curve: EaseCurveSchema,
	sections: Sections.optional(),
});

/**
 * Pastes an ease clipboard entry: `key` sets both eases of every target key; `segments` goes onto the target
 * segments (one curve → every segment; n curves → in order, property then time); a copied multi-point `curve` is
 * applied like `keyframe.applyEase` unless `mode: "segments"`.
 */
export const KeyframePasteEaseCmd = cmd('keyframe.pasteEase', {
	keyframeIds: KeyIds,
	clip: EaseClipSchema,
	sections: Sections.optional(),
	mode: z.enum(['segments', 'curve']).optional(),
});

/** Pastes copied values onto keys in order (property, then time), keeping their times and eases. */
export const KeyframePasteValuesCmd = cmd('keyframe.pasteValues', {
	keyframeIds: KeyIds,
	values: z.array(z.unknown()).min(1).max(10_000),
});

/**
 * The Keyframe Velocity editor: sets the incoming / outgoing speed (property units per second; sequence px/s along
 * the path for points; signed for numbers) and / or influence (percent) of one key.
 */
export const KeyframeSetVelocityCmd = cmd('keyframe.setVelocity', {
	keyframeId: IdRefSchema,
	side: z.enum(['in', 'out', 'both']),
	speed: z.number().min(-1e9).max(1e9).optional(),
	influence: z.number().min(0.1).max(100).optional(),
});

/**
 * Makes a point property's motion between the first and last selected key slider-driven: the keys between rove
 * (constant speed along the path), a "Path Progress" Slider Control keyed 0 → 100 with Easy Ease is added, and an
 * expression places the property on its path at the slider's progress.
 */
export const KeyframeCreatePathControllerCmd = cmd('keyframe.createPathController', {
	keyframeIds: z.array(IdRefSchema).min(2).max(100_000),
	replaceExpression: z.boolean().optional(),
});

/**
 * Clean Up Path: makes the selected point keys' timing linear and removes every key the drawn motion path does not
 * need (within `tolerance`, default 0.5 px), refitting the path's Bézier handles across removed keys.
 */
export const KeyframesCleanupPathCmd = cmd('keyframes.cleanupPath', {
	keyframeIds: KeyIds,
	tolerance: z.number().positive().max(10_000).optional(),
});

export const EASE_COMMANDS = [
	KeyframeApplyEaseCmd,
	KeyframePasteEaseCmd,
	KeyframePasteValuesCmd,
	KeyframeSetVelocityCmd,
	KeyframeCreatePathControllerCmd,
	KeyframesCleanupPathCmd,
] as const;
