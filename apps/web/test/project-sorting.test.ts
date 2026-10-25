import { createCounterIdSource, createEmptyProject, type ProjectItem } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { projectRows } from '../src/panels/project/model.ts';

function sortingProject() {
	const doc = createEmptyProject({ ids: createCounterIdSource(), name: 'Sorting', preset: 'hd-1080p-30' });
	const sequence = Object.values(doc.sequences)[0]!;
	const names = ['clip 10', 'Clip 2', 'Árbol 2', 'arbol 2', 'clip 02', '取景 3', 'clip-2', 'CLIP 1'];
	const rates = [100, 30, 25, 24, 120, 60, 50, 30];
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
	for (const key of ['name', 'frameRate'] as const) {
		for (const dir of [1, -1] as const) {
			it(`preserves ${key} ordering (${dir}), folders first and stable equal values`, () => {
				const doc = sortingProject();
				const original = projectRows(doc, {}, { binId: null, search: '', filter: 'all' });
				const expected = [...original].sort((a, b) => {
					if (a.type === 'bin' && b.type !== 'bin') return -1;
					if (b.type === 'bin' && a.type !== 'bin') return 1;
					return (
						(key === 'name'
							? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
							: a.frameRate.localeCompare(b.frameRate, undefined, { numeric: true })) * dir
					);
				});
				expect(projectRows(doc, {}, { binId: null, search: '', filter: 'all', sort: { key, dir } })).toEqual(
					expected,
				);
			});
		}
	}
});
