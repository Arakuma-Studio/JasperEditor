// Inspector selection reads the drawn document so scrubs preview live.
import type { ProjectDocument } from '@jasper/project';
import { useSessionState } from '@jasper/session/react';
import { type InspectorSelection, selectInspector } from './model.ts';

const sameList = (a: readonly string[], b: readonly string[]) =>
	a === b || (a.length === b.length && a.every((x, i) => x === b[i]));

type InspectorData = {
	doc: ProjectDocument;
	selection: InspectorSelection | null;
};

/** Drawn document + timeline selection of the active sequence. */
export function useInspectorData(): InspectorData {
	const doc = useSessionState((s) => s.transient ?? s.document);
	const activeSequenceId = useSessionState((s) => s.activeSequenceId);
	const clipIds = useSessionState((s) => s.selection.timeline.clips, sameList);
	const primary = useSessionState((s) => s.selection.timeline.primaryClip);
	return { doc, selection: selectInspector(doc, activeSequenceId, clipIds, primary) };
}
