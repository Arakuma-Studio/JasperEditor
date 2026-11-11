// The sequence a scene file describes: found by the name of its project item (sequences carry no name of their own).
import type { ProjectDocument } from '../schema/document.ts';
import type { Sequence } from '../schema/sequence.ts';

/** The sequence named `name`, none, or an error when several share the name. */
export function findSceneSequence(
	doc: Pick<ProjectDocument, 'items' | 'sequences'>,
	name: string,
): { seq?: Sequence; error?: string } {
	const ids = [
		...new Set(
			Object.values(doc.items)
				.filter((it) => it.kind === 'sequence' && it.name === name && doc.sequences[it.sequenceId])
				.map((it) => (it as { sequenceId: string }).sequenceId),
		),
	];
	if (ids.length > 1)
		return {
			error: `${ids.length} sequences are named "${name}" (${ids.join(', ')}): rename one in the project`,
		};
	return ids.length ? { seq: doc.sequences[ids[0]!]! } : {};
}

/** The name of a sequence's project item, or null. */
export function sceneSequenceName(doc: Pick<ProjectDocument, 'items'>, sequenceId: string): string | null {
	for (const it of Object.values(doc.items))
		if (it.kind === 'sequence' && it.sequenceId === sequenceId) return it.name;
	return null;
}
