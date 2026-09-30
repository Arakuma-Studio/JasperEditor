// React glue shared by the inspector panels: the inspected selection from the drawn document (so
// scrubs preview live), the throttled playhead (S03:EC-006) and the injected registries.
import type { ProjectDocument } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSessionState, useTransportFrame } from '@jasper/session/react';
import { type InspectorSelection, selectInspector } from './model.ts';

const sameList = (a: readonly string[], b: readonly string[]) =>
	a === b || (a.length === b.length && a.every((x, i) => x === b[i]));

export type InspectorData = {
	doc: ProjectDocument;
	selection: InspectorSelection | null;
	activeSequenceId: string | null;
};

/** Drawn document + timeline selection of the active sequence. */
export function useInspectorData(): InspectorData {
	const doc = useSessionState((s) => s.transient ?? s.document);
	const activeSequenceId = useSessionState((s) => s.activeSequenceId);
	const clipIds = useSessionState((s) => s.selection.timeline.clips, sameList);
	const primary = useSessionState((s) => s.selection.timeline.primaryClip);
	return { doc, activeSequenceId, selection: selectInspector(doc, activeSequenceId, clipIds, primary) };
}

/** Playhead frame, re-rendering at most every `ms` (values only; the playhead line writes the DOM). */
export function usePlayheadFrame(ms = 66): number {
	return useTransportFrame(ms).frame;
}

export function registriesOf(session: EditorSession) {
	return { effects: session.ctx.registries.effects, mg: session.ctx.registries.mgTemplates };
}
