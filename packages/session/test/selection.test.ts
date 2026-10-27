import { createCounterIdSource, createEmptyProject, defaultRegistries } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { combine, emptySelection, expandClipSelection, filterSelection } from '../src/selection.ts';
import { EditorSession } from '../src/session.ts';

function fixture() {
	const ids = createCounterIdSource(1);
	const session = new EditorSession({
		projectId: 'selection-test',
		document: createEmptyProject({ ids, name: 'Selection', preset: 'hd-1080p-30' }),
		ctx: { ids, now: () => '2026-10-06T00:00:00.000Z', registries: defaultRegistries() },
	});
	expect(
		session.apply({
			label: 'Seed',
			origin: 'user',
			commands: [
				{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1] },
				{ type: 'marker.add', frame: 10 },
			],
		}).ok,
	).toBe(true);
	const doc = structuredClone(session.getCommitted());
	const seq = Object.values(doc.sequences)[0]!;
	const clip = Object.values(seq.clips)[0]!;
	seq.transitions.trn_test = {
		id: 'trn_test',
		trackId: clip.trackId,
		effectId: 'jasper.dip-to-black',
		effectVersion: 1,
		outgoingClipId: null,
		incomingClipId: clip.id,
		duration: 10,
		alignment: 'center',
		params: {},
	};
	return { doc, seq, clip };
}

describe('bulk selection', () => {
	it('removes matching IDs while preserving surviving order and duplicates', () => {
		const removed = Object.freeze(Array.from({ length: 20 }, (_, i) => `remove-${i}`));
		const current = Object.freeze(['b', ...removed, 'a', 'b']);
		expect(combine(current, removed, 'remove')).toEqual(['b', 'a', 'b']);
	});

	it('keeps selection and link/group expansion in input order across sequences', () => {
		const { doc, seq, clip } = fixture();
		const other = { ...structuredClone(seq), id: 'seq_other' };
		other.clips = {
			clp_other: { ...clip, id: 'clp_other', linkId: 'lnk_other', groupId: 'grp_other' },
			clp_linked: { ...clip, id: 'clp_linked', start: 30, linkId: 'lnk_other' },
			clp_grouped: { ...clip, id: 'clp_grouped', start: 60, groupId: 'grp_other' },
		};
		other.links = { lnk_other: { id: 'lnk_other', members: ['clp_other', 'clp_linked'] } };
		other.groups = { grp_other: { id: 'grp_other', members: ['clp_grouped', 'clp_other'] } };
		doc.sequences[other.id] = other;
		expect(expandClipSelection(doc, ['clp_other', clip.id, 'clp_other'], true)).toEqual([
			'clp_other',
			'clp_linked',
			'clp_grouped',
			clip.id,
		]);
		expect(expandClipSelection(doc, ['clp_other', clip.id], false, false)).toEqual(['clp_other', clip.id]);
	});

	it('preserves first insertion order when many selected clips share links and groups', () => {
		const { doc, seq, clip } = fixture();
		seq.clips = {
			a: { ...clip, id: 'a', linkId: 'link', groupId: 'group' },
			b: { ...clip, id: 'b', linkId: 'link', groupId: 'group' },
			c: { ...clip, id: 'c', linkId: null, groupId: 'group' },
		};
		seq.links = { link: { id: 'link', members: ['a', 'b'] } };
		seq.groups = { group: { id: 'group', members: ['c', 'a', 'b'] } };
		expect(expandClipSelection(doc, ['b', 'a', 'c', 'b'], true)).toEqual(['b', 'a', 'c']);
		expect(expandClipSelection(doc, ['b', 'a'], false)).toEqual(['b', 'c', 'a']);
		expect(expandClipSelection(doc, ['b', 'a'], true, false)).toEqual(['b', 'a']);
		// Expansion must not recursively select links of members added by a group.
		seq.clips.c!.linkId = 'other';
		seq.links.other = { id: 'other', members: ['c', 'indirect'] };
		expect(expandClipSelection(doc, ['a', 'b'], true)).toEqual(['a', 'b', 'c']);
	});

	it('reads current group membership on each selection call', () => {
		const { doc, seq, clip } = fixture();
		seq.clips = {
			selected: { ...clip, id: 'selected', groupId: 'group' },
			first: { ...clip, id: 'first', start: 30, groupId: 'group' },
			added: { ...clip, id: 'added', start: 60, groupId: null },
		};
		seq.groups = { group: { id: 'group', members: ['selected', 'first'] } };
		expect(expandClipSelection(doc, ['selected', 'selected'], true)).toEqual(['selected', 'first']);
		seq.groups.group!.members.push('added');
		seq.clips.added!.groupId = 'group';
		expect(expandClipSelection(doc, ['selected'], true)).toEqual(['selected', 'first', 'added']);
	});
});

describe('selection pruning', () => {
	it('prunes missing entities, occupied gaps and stale primary ids without changing surviving order', () => {
		const { doc, seq, clip } = fixture();
		const sel = emptySelection();
		sel.timeline.clips = ['missing', clip.id, clip.id];
		sel.timeline.primaryClip = 'missing';
		sel.timeline.transitions = ['missing', 'trn_test'];
		sel.timeline.gaps = [
			{ trackId: clip.trackId, start: 0, end: 10 },
			{ trackId: clip.trackId, start: 30, end: 60 },
			{ trackId: 'missing', start: 30, end: 60 },
		];
		sel.keyframes = { clipOrTrackId: 'missing', keyframeIds: ['kf_test'] };
		sel.markers = ['missing', seq.markers[0]!.id];
		sel.tracks = ['missing', clip.trackId];
		sel.project.items = ['missing', ...Object.keys(doc.items)];
		sel.project.primary = 'missing';
		const actual = filterSelection(sel, doc);
		expect(actual).toEqual({
			...sel,
			timeline: {
				clips: [clip.id, clip.id],
				primaryClip: null,
				transitions: ['trn_test'],
				gaps: [sel.timeline.gaps[1]],
			},
			keyframes: null,
			markers: [seq.markers[0]!.id],
			tracks: [clip.trackId],
			project: { items: Object.keys(doc.items), primary: null },
		});
		expect(sel.timeline.clips).toEqual(['missing', clip.id, clip.id]);
	});

	it('does not treat inherited map properties as existing entities', () => {
		const { doc } = fixture();
		const sel = emptySelection();
		sel.timeline.clips = ['toString'];
		sel.timeline.transitions = ['toString'];
		sel.project.items = ['toString'];
		expect(filterSelection(sel, doc)).toMatchObject({
			timeline: { clips: [], transitions: [] },
			project: { items: [] },
		});
	});
});
