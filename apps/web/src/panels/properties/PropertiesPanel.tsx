// Properties panel — JasperEditor's primary inspector (S03 §14, S05:PRP-001…004). Nothing selected →
// sequence settings; clips selected → the clip sections. Same registry and write path as Effect
// Controls, with a ◆ toggle per property instead of the mini-timeline.
import type { EditorSession } from '@jasper/session';
import { useSessionOrNull, useSessionState, useTransportFrame } from '@jasper/session/react';
import { TransitionSection } from '../effectControls/TransitionSection.tsx';
import type { PanelProps } from '../types.ts';
import { ClipProperties } from './ClipProperties.tsx';
import { useNotices } from './controls/Notices.tsx';
import type { RowContext } from './controls/PropertyRow.tsx';
import { useInspectorData } from './lib/hooks.ts';
import { useInspectorOps } from './lib/ops.ts';
import { SequenceProperties } from './SequenceProperties.tsx';

export function PropertiesPanel(props: PanelProps) {
	const session = useSessionOrNull();
	return (
		<div
			className="flex h-full min-h-0 flex-col overflow-y-auto bg-pr-panel font-pr text-pr-ui text-pr-text"
			data-panel-kind="properties"
			data-instance-id={props.instanceId}
			data-testid="properties-panel"
		>
			{session ? <PropertiesBody session={session} /> : <Empty text="No project open." />}
		</div>
	);
}

function Empty({ text }: { text: string }) {
	return <p className="p-3 text-pr-small text-pr-muted">{text}</p>;
}

function PropertiesBody({ session }: { session: EditorSession }) {
	const data = useInspectorData();
	const frame = useTransportFrame(66).frame;
	const ops = useInspectorOps(session);
	const notices = useNotices();
	const selectedTransitions = useSessionState((s) => s.selection.timeline.transitions.length);
	const seqName = useSessionState((s) => {
		const seqId = s.activeSequenceId;
		const item = Object.values(s.document.items).find((i) => i.kind === 'sequence' && i.sequenceId === seqId);
		return item?.name ?? 'Sequence';
	});
	if (!data.selection) return <Empty text="Open a sequence to see its properties." />;
	if (data.selection.clips.length === 0 && selectedTransitions > 0)
		return <TransitionSection session={session} host="properties" />;
	const { seq, clips } = data.selection;
	const ctx: RowContext = {
		doc: data.doc,
		seq,
		frame,
		ops,
		transport: session.transport,
		mode: 'properties',
		hint: notices.hint,
		confirmStopwatchOff: notices.confirmStopwatchOff,
	};
	return (
		<>
			{notices.element}
			{clips.length === 0 ? (
				<SequenceProperties seq={seq} name={seqName} ops={ops} notices={notices} />
			) : (
				<ClipProperties session={session} clips={clips} ctx={ctx} />
			)}
		</>
	);
}
