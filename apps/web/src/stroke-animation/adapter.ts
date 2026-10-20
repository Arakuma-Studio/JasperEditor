// The Stroke Animation UI dispatches its document edits through this adapter, so tests can stub the commands and check
// the payloads. The payloads are the `shape.*` Trim Paths commands of packages/project
// (commands/schemas/shape-trim.ts, shape-tracer.ts).
import { type CommandInput, TRIM_ANIMATION_STYLES, type TransactionResult } from '@jasper/project';
import type { EditorSession } from '@jasper/session';

type InputOf<T extends string> = Extract<CommandInput, { type: T }>;

export type AnimateTrimCommand = InputOf<'shape.animateTrim'>;
export type AnimateTrimStyle = AnimateTrimCommand['style'];
export type ReversePathDirectionCommand = InputOf<'shape.reversePathDirection'>;
export type AddLineCommand = InputOf<'shape.addLine'>;
export type AddTrimTracerCommand = InputOf<'shape.addTrimTracer'>;
export type StrokeCommand =
	| AnimateTrimCommand
	| ReversePathDirectionCommand
	| AddLineCommand
	| AddTrimTracerCommand;

/** The styles in panel order (`TRIM_ANIMATION_STYLES` of packages/project). */
export const ANIMATE_TRIM_STYLES: readonly AnimateTrimStyle[] = TRIM_ANIMATION_STYLES;

export type StrokeTx = {
	label: string;
	sequenceId: string;
	commands: StrokeCommand[];
	/** Same key + label within the history window: merged into the previous entry (one undo step). */
	coalesceKey?: string;
	/** Select the clips the transaction creates (a new line). */
	selectCreated?: boolean;
};

export interface StrokeAnimationAdapter {
	apply(session: EditorSession, tx: StrokeTx): TransactionResult;
}

const sessionAdapter: StrokeAnimationAdapter = {
	apply: (session, tx) =>
		session.apply({
			label: tx.label,
			origin: 'user',
			sequenceId: tx.sequenceId,
			commands: tx.commands,
			...(tx.coalesceKey ? { coalesceKey: tx.coalesceKey } : {}),
			// The session keeps only the created ids that are clips.
			...(tx.selectCreated
				? { selectAfter: (r: Extract<TransactionResult, { ok: true }>) => ({ timeline: r.created }) }
				: {}),
		}),
};

let current: StrokeAnimationAdapter = sessionAdapter;

export const strokeAdapter = (): StrokeAnimationAdapter => current;

/** Replaces the adapter (tests); `null` restores the session one. */
export function setStrokeAnimationAdapter(a: StrokeAnimationAdapter | null): void {
	current = a ?? sessionAdapter;
}
