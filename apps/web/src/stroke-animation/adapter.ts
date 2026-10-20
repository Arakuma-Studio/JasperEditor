// The Stroke Animation UI dispatches its document edits through this adapter (one transaction per click, one undo
// step), so tests can stub the commands and check the payloads. The payload types mirror the `shape.*` Trim Paths
// commands of packages/project.
import type { Command, CubicEase, TransactionResult } from '@jasper/project';
import type { EditorSession } from '@jasper/session';

export const ANIMATE_TRIM_STYLES = [
	'in',
	'out',
	'inOut',
	'middleIn',
	'middleOut',
	'divideIn',
	'divideOut',
] as const;
export type AnimateTrimStyle = (typeof ANIMATE_TRIM_STYLES)[number];

export type AnimateTrimCommand = {
	type: 'shape.animateTrim';
	clipIds: string[];
	style: AnimateTrimStyle;
	reverse?: boolean;
	animateOffset?: boolean;
	durationFrames?: number;
	offsetDegrees?: number;
	copies?: number;
	inOutLag?: number;
	/** Sequence frame of the first key (default: the clip start). */
	at?: number;
	curve?: CubicEase;
};
export type ReversePathDirectionCommand = { type: 'shape.reversePathDirection'; clipIds: string[] };
export type AddLineCommand = {
	type: 'shape.addLine';
	orientation: 'horizontal' | 'vertical';
	length?: number;
	strokeWidth?: number;
	at?: number;
	durationFrames?: number;
	trackId?: string;
};
export type AddTrimTracerCommand = {
	type: 'shape.addTrimTracer';
	clipId: string;
	trimItemId: string;
	pathItemId?: string;
	tip?: 'start' | 'end' | 'auto';
	follower?: { clipId: string };
	orient?: boolean;
	name?: string;
};
export type StrokeCommand =
	| AnimateTrimCommand
	| ReversePathDirectionCommand
	| AddLineCommand
	| AddTrimTracerCommand;

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
			commands: tx.commands as unknown as Command[],
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
