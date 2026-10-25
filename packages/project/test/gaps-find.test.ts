import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	findHitKey,
	findProjectItems,
	findTimelineHits,
	matchesOperator,
	nextFindHit,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

function setup() {
	const h = new Harness();
	const a = h.registerVideo({ seconds: 4 });
	const b = h.registerVideo({ seconds: 4, width: 1280, height: 720 });
	const items = Object.values(h.doc.items).filter((i) => i.kind === 'media');
	h.ok([
		{ type: 'item.rename', itemIds: [items[0]!.id], name: 'Interview Wide' },
		{ type: 'item.rename', itemIds: [items[1]!.id], name: 'B-roll street' },
		{ type: 'item.setLabel', itemIds: [items[1]!.id], label: 'rose' },
		{ type: 'clip.place', source: { mediaId: a }, at: 0 },
		{ type: 'clip.place', source: { mediaId: b }, at: 120 },
		{ type: 'marker.add', frame: 60, name: 'Applause', comment: 'big laugh' },
	]);
	return { h, items };
}

describe('find', () => {
	it('operators', () => {
		expect(matchesOperator('Interview Wide', 'contains', 'view')).toBe(true);
		expect(matchesOperator('Interview Wide', 'contains', 'VIEW', true)).toBe(false);
		expect(matchesOperator('Interview Wide', 'begins', 'inter')).toBe(true);
		expect(matchesOperator('Interview Wide', 'ends', 'wide')).toBe(true);
		expect(matchesOperator('Interview Wide', 'matches', 'interview wide')).toBe(true);
		expect(matchesOperator('Interview Wide', 'notContains', 'street')).toBe(true);
	});

	it('finds project items by name, label, type and frame size with all/any', () => {
		const { h, items } = setup();
		const byName = findProjectItems(h.doc, {
			criteria: [{ field: 'name', operator: 'contains', value: 'interview' }],
		});
		expect(byName).toEqual([items[0]!.id]);
		const byLabel = findProjectItems(h.doc, {
			criteria: [{ field: 'label', operator: 'matches', value: 'rose' }],
		});
		expect(byLabel).toEqual([items[1]!.id]);
		const bySize = findProjectItems(h.doc, {
			criteria: [{ field: 'frameSize', operator: 'matches', value: '1280x720' }],
		});
		expect(bySize).toEqual([items[1]!.id]);
		const all = findProjectItems(h.doc, {
			criteria: [
				{ field: 'type', operator: 'matches', value: 'video' },
				{ field: 'name', operator: 'begins', value: 'b-' },
			],
		});
		expect(all).toEqual([items[1]!.id]);
		const any = findProjectItems(h.doc, {
			match: 'any',
			criteria: [
				{ field: 'name', operator: 'begins', value: 'b-' },
				{ field: 'name', operator: 'contains', value: 'wide' },
			],
		});
		expect(new Set(any)).toEqual(new Set([items[0]!.id, items[1]!.id]));
		// Empty criteria find nothing (Premiere disables Find until something is typed).
		expect(
			findProjectItems(h.doc, { criteria: [{ field: 'name', operator: 'contains', value: '' }] }),
		).toEqual([]);
		expect(
			findProjectItems(h.doc, {
				matchCase: true,
				criteria: [{ field: 'name', operator: 'contains', value: 'interview' }],
			}),
		).toEqual([]);
	});

	it('finds timeline clips and markers in frame order and steps with Find Next', () => {
		const { h } = setup();
		const hits = findTimelineHits(h.doc, h.seqId, {
			match: 'any',
			criteria: [
				{ field: 'any', operator: 'contains', value: 'street' },
				{ field: 'marker', operator: 'contains', value: 'laugh' },
			],
		});
		expect(hits.map((x) => x.kind)).toContain('marker');
		expect(hits.map((x) => x.frame)).toEqual([...hits.map((x) => x.frame)].sort((a, b) => a - b));
		const clipHits = hits.filter((x) => x.kind === 'clip');
		expect(clipHits.length).toBeGreaterThanOrEqual(1);
		expect(clipHits.every((c) => c.frame === 120)).toBe(true);
		const first = nextFindHit(hits, 0);
		expect(first?.frame).toBe(60);
		const second = nextFindHit(hits, 0, findHitKey(first!));
		expect(second?.frame).toBe(120);
		const last = hits.at(-1)!;
		expect(nextFindHit(hits, 0, findHitKey(last))).toEqual(hits[0]);
		expect(
			findTimelineHits(h.doc, 'nope', { criteria: [{ field: 'any', operator: 'contains', value: 'x' }] }),
		).toEqual([]);
	});

	it('keeps the first source item name, original filename fallback and mutable renames', () => {
		const { h, items } = setup();
		const doc = structuredClone(h.doc);
		const item = doc.items[items[0]!.id]!;
		if (item.kind !== 'media') throw new Error('Expected a media item');
		doc.items.alias = { ...item, id: 'alias', name: 'Later alias' };
		doc.rootItems.push('alias');
		const findSource = (value: string) =>
			findTimelineHits(doc, h.seqId, {
				criteria: [{ field: 'sourceName', operator: 'contains', value }],
			});
		expect(findSource('Interview Wide').map((hit) => hit.frame)).toEqual([0, 0]);
		expect(findSource('Later alias')).toEqual([]);
		item.name = '';
		expect(findSource('Interview Wide')).toEqual([]);
		expect(findSource('Later alias')).toEqual([]);
		const originalName = doc.media[item.mediaId]!.originalName;
		expect(findSource(originalName).map((hit) => hit.frame)).toEqual([0, 0]);
		delete doc.items[item.id];
		doc.rootItems = doc.rootItems.filter((id) => id !== item.id);
		expect(findSource('Later alias').map((hit) => hit.frame)).toEqual([0, 0]);
		delete doc.items.alias;
		doc.rootItems = doc.rootItems.filter((id) => id !== 'alias');
		expect(findSource(originalName).map((hit) => hit.frame)).toEqual([0, 0]);
	});

	it('keeps nested-sequence source names distinct from media names and combines source criteria', () => {
		const { h } = setup();
		h.ok([
			{
				type: 'clip.nest',
				clipIds: h
					.clips()
					.filter((c) => c.start === 0)
					.map((c) => c.id),
				name: 'Nested source',
			},
		]);
		const doc = structuredClone(h.doc);
		const item = Object.values(doc.items).find((i) => i.kind === 'sequence' && i.name === 'Nested source');
		if (item?.kind !== 'sequence') throw new Error('Expected a nested-sequence item');
		doc.items.alias = { ...item, id: 'alias', name: 'Later nested alias' };
		doc.rootItems.push('alias');
		const hits = (field: 'sourceName' | 'any', value: string) =>
			findTimelineHits(doc, h.seqId, { criteria: [{ field, operator: 'contains', value }] });
		expect(hits('sourceName', 'Nested source').map((hit) => hit.frame)).toEqual([0, 0]);
		expect(hits('sourceName', 'Later nested alias')).toEqual([]);
		expect(hits('any', 'Nested source').map((hit) => hit.frame)).toEqual([0, 0]);
		expect(
			findTimelineHits(doc, h.seqId, {
				criteria: [
					{ field: 'sourceName', operator: 'contains', value: 'Nested' },
					{ field: 'sourceName', operator: 'notContains', value: 'Later' },
				],
			}).map((hit) => hit.frame),
		).toEqual([0, 0]);
		item.name = 'Renamed nested source';
		expect(hits('sourceName', 'Renamed nested source').map((hit) => hit.frame)).toEqual([0, 0]);
	});

	it('never throws on arbitrary queries (property)', () => {
		const { h } = setup();
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						field: fc.constantFrom('name', 'label', 'type', 'path', 'codec', 'frameSize', 'any', 'bogus'),
						operator: fc.constantFrom('contains', 'matches', 'begins', 'ends', 'notContains', 'bogus'),
						value: fc.string(),
					}),
					{ maxLength: 3 },
				),
				fc.boolean(),
				(criteria, matchCase) => {
					const r = findProjectItems(h.doc, { criteria: criteria as never, matchCase });
					const t = findTimelineHits(h.doc, h.seqId, { criteria: criteria as never, matchCase });
					return Array.isArray(r) && Array.isArray(t);
				},
			),
			{ numRuns: 200 },
		);
	});
});
