import type { IdSource } from '../ids.ts';
import type { PresetRegistry } from '../presets.ts';
import type { EffectRegistry } from '../registry/effects.ts';
import type { MgTemplateRegistry } from '../registry/mg.ts';
import type { FontRef } from '../schema/media.ts';
import type { TextBox, TextContent } from '../schema/sequence.ts';

export const TX_PROTOCOL = 'jasper.tx/1';

export type Origin = 'user' | { agent: string; runId?: string } | 'system' | 'migration';

/** Stable error codes (S01:CMD-007 plus ARCHITECTURE §2.3 additions). */
export const ERROR_CODES = [
	'E_NOT_FOUND',
	'E_TRACK_LOCKED',
	'E_TRACK_KIND',
	'E_OVERLAP',
	'E_OUT_OF_MEDIA',
	'E_IN_USE',
	'E_SYNC_CONFLICT',
	'E_SYNC_LOCKED_TRACK',
	'E_INVALID_PARAM',
	'E_UNKNOWN_EFFECT',
	'E_CYCLE',
	'E_REVISION_MISMATCH',
	'E_SCHEMA',
	'E_LIMIT',
	/**
	 * Spec 15 EA-004: a producer's result would not fit the transaction caps (its accept would exceed the command or byte
	 * limit of one transaction); the refusal names a range that fits. Nothing is stored or applied.
	 */
	'E_TOO_LARGE',
	'E_AMBIGUOUS',
	'E_NOT_OWNER',
	'E_NOT_IMPLEMENTED',
	'E_APPROVAL_DENIED',
	/** Only the user can do this (an agent acknowledging a Sound Check error, spec 12 §4 P6-E4): not retryable. */
	'E_APPROVAL_REQUIRED',
	'E_APPROVAL_TIMEOUT',
	'E_NO_SESSION',
	'E_INVARIANT',
	'E_INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const WARNING_CODES = [
	'W_CLIP_COLLAPSED',
	'W_TRANSITION_SHORTENED',
	'W_TRANSITION_REMOVED',
	'W_DURATION_CLAMPED',
	'W_OFFLINE_MEDIA',
	'W_LAYOUT_PENDING',
	'W_DEDUPED',
	'W_VALUE_CLAMPED',
	/** in + out text animators exceed the clip and are scaled at render time. */
	'W_ANIMATION_COMPRESSED',
	/** a template upgrade dropped keyframes of params it removed. */
	'W_KEYFRAMES_DROPPED',
	/** wp-clipboard (S01:CLB-008): a pasted clip, item or keyframe track had nothing to land on and was skipped. */
	'W_CLIP_SKIPPED',
	/** a video transition keeps its length with repeated frames (freeze-frame handles). */
	'W_TRANSITION_FREEZE_FRAMES',
	/** a nested sequence of another frame rate was conformed (cuts move by up to half a frame). */
	'W_CONFORMED',
	/** Unnest copied the nest clip's effects onto each clip it showed. */
	'W_EFFECTS_DISTRIBUTED',
	/** a tracker link between clips that ended up in different sequences was removed. */
	'W_TRACKING_UNLINKED',
	/** edit-structure × wp masks: a Track Matte Key's track did not come along into the other sequence (cleared). */
	'W_TRACK_MATTE_CLEARED',
	/** shape.animateTrim / shape.reversePathDirection: clips that cannot hold paths (or a trim) were left alone. */
	'W_TRIM_SKIPPED',
	/** path-trace: shape.addTrimTracer replaced an expression the follower already had. */
	'W_EXPRESSION_REPLACED',
	/** keyframe assistant: properties an ease command could not apply to (named in the message). */
	'W_EASE_SKIPPED',
	/** keyframe assistant: a curve piece with equal end values cannot hold a shaped ease (made linear). */
	'W_EASE_FLAT_SEGMENT',
	/** keyframe assistant: 3D Orientation clamps progress to [0, 1], so a curve's overshoot is not shown. */
	'W_EASE_CLAMPED',
	/** keyframe assistant: pasted eases / values and target keys differ in number (the first min(n, m) pasted). */
	'W_EASE_COUNT_MISMATCH',
	/** keyframe assistant: keys in an eased / cleaned span stopped roving. */
	'W_EASE_ROVING_CLEARED',
	/** sound design: a cue's stop-before / build skipped a place (its track is locked, or its automation is too dense). */
	'W_MIX_SKIPPED',
] as const;

/** A problem report. `commandIndex` is -1 for transaction-level issues (invariants, revision). */
export type Issue = {
	commandIndex: number;
	code: string;
	message: string;
	path?: string[];
	/** Entities that block the edit (sync conflicts, stale revisions). */
	blocking?: string[];
	/** Invariant id (INV-001…INV-016) for `E_INVARIANT` issues. */
	invariant?: string;
};

export type TransactionResult =
	| {
			ok: true;
			revision: number;
			refs: Record<string, string>;
			created: string[];
			changed: string[];
			deleted: string[];
			warnings: Issue[];
			results: unknown[];
	  }
	| { ok: false; revision: number; errors: Issue[] };

/**
 * Measures laid-out text (S01:ARC-002, KND-006, spec 13 SH-004): the size the text block of `content` takes with the
 * faces the renderers draw it with (`fonts` = the document's font table, which `content.style.fontId` and the runs'
 * fonts name). Point text (`box.autoSize: 'width'`) never wraps; other boxes wrap at `box.width`. The editor session
 * measures in its page, the engine in its headless browser (the same Chromium layout as every renderer).
 * `null` = cannot measure now (fonts loading, no browser): the clip keeps an estimated box and stays `layoutPending`.
 */
export interface TextMeasurer {
	measure(
		content: TextContent,
		box: TextBox,
		fonts: Readonly<Record<string, FontRef>>,
	): { width: number; height: number } | null;
}

export type Registries = {
	effects: EffectRegistry;
	mgTemplates: MgTemplateRegistry;
	presets: PresetRegistry;
};

export interface CommandContext {
	ids: IdSource;
	now(): string;
	/** Current committed revision of the document being edited. */
	revision: number;
	registries: Registries;
	textMeasurer?: TextMeasurer;
	/** Only used to resolve `"$selection"` / `"$selection.primary"` (S01:SEL-009). */
	selection?: { clips: string[]; primaryClip: string | null };
	/** Per-entity last-changed revision kept by the caller, for the fast-forward rule (S01:AGT-010). */
	entityRevisions?: ReadonlyMap<string, number>;
	/** Default 5000 (S01:AGT-011). */
	maxCommands?: number;
	/** Run the invariant checker after the transaction (default true). Gestures may skip it in prod. */
	checkInvariants?: boolean;
	/**
	 * how invariants are checked — `incremental` (only what the transaction changed; production default),
	 * `full`, or `verify` (both, must agree; the default under tests). Default: `invariantMode()`.
	 */
	invariants?: 'full' | 'incremental' | 'verify';
	/**
	 * Called before each command of the transaction runs, with its index. Proposal previews apply many items in one
	 * transaction and switch `ids` to the item a command belongs to (each item keeps its own seeded ids).
	 */
	onCommand?: (index: number) => void;
}

export class CommandError extends Error {
	readonly code: string;
	readonly path?: string[];
	readonly blocking?: string[];
	constructor(code: ErrorCode | string, message: string, opts?: { path?: string[]; blocking?: string[] }) {
		super(message);
		this.name = 'CommandError';
		this.code = code;
		this.path = opts?.path;
		this.blocking = opts?.blocking;
	}
}
