import type { IdSource } from '../ids.ts';
import type { PresetRegistry } from '../presets.ts';
import type { EffectRegistry } from '../registry/effects.ts';
import type { MgTemplateRegistry } from '../registry/mg.ts';
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
	'E_AMBIGUOUS',
	'E_NOT_OWNER',
	'E_NOT_IMPLEMENTED',
	'E_APPROVAL_DENIED',
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

/** Measures text in the browser (S01:ARC-002, KND-006). Headless contexts omit it (layoutPending). */
export interface TextMeasurer {
	measure(content: TextContent, box: TextBox): { width: number; height: number };
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
