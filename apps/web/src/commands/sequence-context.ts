import type { Clip, ProjectDocument, Sequence } from '@jasper/project';
import type { EditorSession, SessionTxInput } from '@jasper/session';
import { activeTimeline, type TimelineHandle } from '../panels/timeline/env.tsx';
import type { CommandCtx } from './types.ts';

export type SequenceCommandContext = {
	session: EditorSession;
	seq: Sequence;
	playhead: number;
};

export type ResolvedSequenceCommandContext = SequenceCommandContext & {
	doc: ProjectDocument;
	handle: TimelineHandle | null;
};

export function sequenceContext(ctx: CommandCtx): ResolvedSequenceCommandContext | null {
	const session = ctx.session;
	if (!session) return null;
	const handle = activeTimeline(ctx.services);
	const sequenceId = handle?.sequenceId() ?? session.getState().activeSequenceId;
	const doc = session.getCommitted();
	const seq = sequenceId ? doc.sequences[sequenceId] : undefined;
	return seq ? { session, seq, doc, handle, playhead: session.transport.getState().frame } : null;
}

export function selectedSequenceClips(e: Pick<SequenceCommandContext, 'session' | 'seq'>): Clip[] {
	return e.session
		.getState()
		.selection.timeline.clips.map((id) => e.seq.clips[id])
		.filter((clip): clip is Clip => !!clip);
}

export function applySequenceCommands(
	ctx: CommandCtx,
	e: Pick<SequenceCommandContext, 'session' | 'seq'>,
	label: string,
	commands: SessionTxInput['commands'],
	selectAfter?: SessionTxInput['selectAfter'],
) {
	const result = e.session.apply({ label, origin: 'user', sequenceId: e.seq.id, commands, selectAfter });
	if (!result.ok)
		ctx.ui.toast({ kind: 'warning', message: `${label}: not possible`, detail: result.errors[0]?.message });
	else if (result.warnings.length) ctx.ui.toast({ kind: 'info', message: result.warnings[0]!.message });
	return result;
}
