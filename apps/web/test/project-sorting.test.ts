import { createCounterIdSource, createEmptyProject, type ProjectItem } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { projectRows } from '../src/panels/project/model.ts';

function sortingProject() {
	const doc = createEmptyProject({ ids: createCounterIdSource(), name: 'Sorting', preset: 'hd-1080p-30' });
	const sequence = Object.values(doc.sequences)[0]!;
	const names = ['clip 10', 'Clip 2', 'Árbol 2', 'arbol 2', 'clip 02', 'CLIP 1'];
	const rates = [100, 30, 25, 24, 120, 30];
	doc.items = {};
	doc.rootItems = [];
	for (let i = 0; i < names.length; i++) {
		const id = `item-${i}`;
		const sequenceId = `sequence-${i}`;
		doc.sequences[sequenceId] = {
			...sequence,
			id: sequenceId,
			settings: { ...sequence.settings, frameRate: { num: rates[i]!, den: 1 } },
		};
		doc.items[id] = {
			id,
			name: names[i]!,
			kind: 'sequence',
			sequenceId,
			label: 'iris',
		};
		doc.rootItems.push(id);
	}
	const bins: ProjectItem[] = [
		{ id: 'bin-10', name: 'Bin 10', kind: 'bin', label: 'iris', children: [] },
		{ id: 'bin-2', name: 'Bin 2', kind: 'bin', label: 'iris', children: [] },
	];
	for (const bin of bins) {
		doc.items[bin.id] = bin;
		doc.rootItems.push(bin.id);
	}
	return doc;
}

describe('Project panel collation', () => {
	it.each([
		['name', 1, ['bin-2', 'bin-10', 'item-2', 'item-3', 'item-5', 'item-1', 'item-4', 'item-0']],
		['name', -1, ['bin-10', 'bin-2', 'item-0', 'item-1', 'item-4', 'item-5', 'item-2', 'item-3']],
		['frameRate', 1, ['bin-10', 'bin-2', 'item-3', 'item-2', 'item-1', 'item-5', 'item-0', 'item-4']],
		['frameRate', -1, ['bin-10', 'bin-2', 'item-4', 'item-0', 'item-1', 'item-5', 'item-2', 'item-3']],
	] as const)('sorts %s (%s), with folders first and equal values in user order', (key, dir, expected) => {
		const rows = projectRows(
			sortingProject(),
			{},
			{
				binId: null,
				search: '',
				filter: 'all',
				sort: { key, dir },
			},
		);
		expect(rows.map((row) => row.id)).toEqual(expected);
	});
});
