// Stroke Animation transaction types and the session dispatch shared by its UI commands.
import type { CommandInput, TransactionResult } from '@jasper/project';
import type { EditorSession } from '@jasper/session';

type InputOf<T extends string> = Extract<CommandInput, { type: T }>;

export type AnimateTrimCommand = InputOf<'shape.animateTrim'>;
export type AnimateTrimStyle = AnimateTrimCommand['style'];
type ReversePathDirectionCommand = InputOf<'shape.reversePathDirection'>;
type AddLineCommand = InputOf<'shape.addLine'>;
export type AddTrimTracerCommand = InputOf<'shape.addTrimTracer'>;
export type StrokeCommand =
	| AnimateTrimCommand
	| ReversePathDirectionCommand
	| AddLineCommand
	| AddTrimTracerCommand;

type StrokeTx = {
	label: string;
	sequenceId: string;
	commands: StrokeCommand[];
	/** Validate and compute the results without changing the document (no History entry). */
	dryRun?: boolean;
	/** Select the clips the transaction creates (a new line). */
	selectCreated?: boolean;
};

export function applyStrokeTransaction(session: EditorSession, tx: StrokeTx): TransactionResult {
	return session.apply({
		label: tx.label,
		origin: 'user',
		sequenceId: tx.sequenceId,
		commands: tx.commands,
		...(tx.dryRun ? { dryRun: true } : {}),
		// The session keeps only the created ids that are clips.
		...(tx.selectCreated
			? { selectAfter: (r: Extract<TransactionResult, { ok: true }>) => ({ timeline: r.created }) }
			: {}),
	});
}
