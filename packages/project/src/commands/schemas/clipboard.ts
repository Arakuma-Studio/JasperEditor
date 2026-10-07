// Clipboard commands (wp-clipboard, S01 §20 CLB-003…008, S03:FX-011/012, EC-023/032). Each takes a clipboard
// payload (format "jasper-clipboard", version 1) as produced by the editor's Copy or the MCP copy tools; the
// handler validates it with the payload schema (CLB-009) before anything is read from it.
import { z } from 'zod';
import {
	cmd,
	EditModeSchema,
	IdListSchema,
	IdRefSchema,
	ParamAtSchema,
	ParamPathSchema,
	RefDeclSchema,
	TimeInputSchema,
	TrackRefSchema,
} from './common.ts';

/** The payload travels as an opaque object here; `parseClipboardPayload` checks it in the handler. */
export const ClipboardPayloadArgSchema = z
	.record(z.string(), z.unknown())
	.describe(
		'A clipboard payload {format: "jasper-clipboard", version: 1, kind, …} as returned by copy_clips / copy_items (or written by the editor on Copy)',
	);

export const ClipPasteCmd = cmd('clip.paste', {
	payload: ClipboardPayloadArgSchema,
	sequenceId: IdRefSchema.optional(),
	/** Where the earliest copied clip lands (the playhead in the editor). */
	at: TimeInputSchema,
	/** `overwrite` (Ctrl/Cmd+V, CLB-003) or `insert` (Paste Insert, CLB-004: ripples, TRK-006). */
	mode: EditModeSchema.optional(),
	/** Lowest destination track per kind (the lowest targeted track; default V1 / A1 / C1). */
	tracks: z
		.strictObject({
			video: TrackRefSchema.optional(),
			audio: TrackRefSchema.optional(),
			caption: TrackRefSchema.optional(),
		})
		.optional(),
	rippleMarkers: z.boolean().optional(),
	ref: RefDeclSchema.optional(),
});

/**
 * Paste Attributes checkboxes (CLB-005, FX-012). Channel Volume (P2) is not modelled. `timeRemapping` (workstream
 * `time`): the copied clip's speed keyframes, from the target's first frame.
 */
export const PasteAttributesSchema = z.strictObject({
	motion: z.boolean().optional(),
	timeRemapping: z.boolean().optional(),
	opacity: z.boolean().optional(),
	volume: z.boolean().optional(),
	panner: z.boolean().optional(),
	/** Copied effect instances to append, by their id in the payload (`"all"` = every copied effect). */
	effects: z.union([z.literal('all'), z.array(z.string().min(1))]).optional(),
	/** M2 text clips: the In / Out animator and the text style. */
	textAnimationIn: z.boolean().optional(),
	textAnimationOut: z.boolean().optional(),
	textStyle: z.boolean().optional(),
	/** M2 shapes: fill, stroke and corner radius. */
	shapeStyle: z.boolean().optional(),
});
export type PasteAttributes = z.infer<typeof PasteAttributesSchema>;

export const ClipPasteAttributesCmd = cmd('clip.pasteAttributes', {
	payload: ClipboardPayloadArgSchema,
	clipIds: IdListSchema,
	attributes: PasteAttributesSchema,
	/** Stretch keyframe times to each target clip's duration (Premiere "Scale Attribute Times"). */
	scaleTimes: z.boolean().optional(),
});

/** Remove Attributes (CLB-005 inverse, S03:FX-011): reset intrinsics, remove effects by registry id. */
export const ClipRemoveAttributesCmd = cmd('clip.removeAttributes', {
	clipIds: IdListSchema,
	attributes: z.strictObject({
		motion: z.boolean().optional(),
		/** Workstream `time`: Time Remapping off (every speed keyframe deleted). */
		timeRemapping: z.boolean().optional(),
		opacity: z.boolean().optional(),
		volume: z.boolean().optional(),
		panner: z.boolean().optional(),
		/** Registry effect ids (e.g. "jasper.gaussian-blur"): every instance of them is removed. */
		effects: z.array(z.string().min(1)).optional(),
		textAnimationIn: z.boolean().optional(),
		textAnimationOut: z.boolean().optional(),
	}),
});

/** Effect Controls paste (CLB-006, EC-032): the copied effects are appended to every target clip. */
export const EffectPasteCmd = cmd('effect.paste', {
	payload: ClipboardPayloadArgSchema,
	clipIds: IdListSchema,
	/** Insert position in each stack (default: appended). */
	index: z.number().int().min(0).optional(),
});

/** Keyframe paste (CLB-006, S03:EC-023): keys land at `at` keeping their relative timing. */
export const KeyframePasteCmd = cmd('keyframe.paste', {
	payload: ClipboardPayloadArgSchema,
	clipId: IdRefSchema,
	/** Time of the earliest copied key (the playhead in the editor). */
	at: ParamAtSchema,
	/** The selected property: used when the clip has no property at the copied path and the kinds match. */
	target: ParamPathSchema.optional(),
	sequenceId: IdRefSchema.optional(),
});

/** Project panel paste (CLB-007): items go into `binId` (default the root); sequences are deep-copied. */
export const ProjectPasteItemsCmd = cmd('project.pasteItems', {
	payload: ClipboardPayloadArgSchema,
	binId: IdRefSchema.nullable().optional(),
	index: z.number().int().min(0).optional(),
});

export const CLIPBOARD_COMMANDS = [
	ClipPasteCmd,
	ClipPasteAttributesCmd,
	ClipRemoveAttributesCmd,
	EffectPasteCmd,
	KeyframePasteCmd,
	ProjectPasteItemsCmd,
] as const;
