// The Review panel / bar model (WP3.3b, spec 12 §2.7 "Review"): rows grouped by role in time order with setup items
// folded under the row that needs them, counts that leave setup items out, navigation orders, the range Review zooms
// to, what an Apply would remove (named in its confirmation), the proposal card's sentence; hostile item metadata
// never throws.
import type { ReviewItem } from '@jasper/session';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { GhostModel } from '../src/proposals/ghosts.ts';
import {
	buildReviewModel,
	cardSentence,
	proposalCardCounts,
	proposalRange,
	removalsOf,
	reviewCounts,
	stepItem,
} from '../src/proposals/review.ts';
import { proposalFixture } from './proposal-helpers.ts';

function item(id: string, o: Partial<ReviewItem> = {}): ReviewItem {
	return {
		id,
		label: o.label ?? id,
		group: o.group ?? 'support',
		requires: o.requires ?? [],
		setup: o.setup ?? false,
		state: o.state ?? 'pending',
		engineState: o.engineState ?? 'pending',
		alternatives: o.alternatives ?? 1,
		selectedAlternative: o.selectedAlternative ?? 0,
		alternativeLabels: o.alternativeLabels ?? [o.label ?? id],
		meta: o.meta,
		...(o.reason ? { reason: o.reason } : {}),
		...(o.note ? { note: o.note } : {}),
	};
}

const ITEMS: ReviewItem[] = [
	item('bin', { setup: true, group: 'setup', meta: { setup: true } }),
	item('sound:a', { setup: true, group: 'setup', requires: ['bin'], meta: { setup: true, title: 'Crunch' } }),
	item('cue:1', { setup: true, group: 'setup', meta: { setup: true } }),
	item('sfx:002', {
		group: 'support',
		requires: ['cue:1', 'sound:a'],
		meta: {
			frame: 90,
			kind: 'cut',
			role: 'support',
			title: 'Crunch',
			cueReason: 'Cut A → B',
			gainOffsetDb: -0.5,
		},
	}),
	item('sfx:001', {
		group: 'hero',
		requires: ['sound:a'],
		alternatives: 3,
		selectedAlternative: 1,
		alternativeLabels: ['Boom', 'Big boom', 'Low boom'],
		meta: { frame: 200, kind: 'land', role: 'hero', title: 'Boom', why: 'Logo lands' },
	}),
	item('sfx:003', {
		group: 'support',
		state: 'accepted',
		meta: { frame: 30, kind: 'move', role: 'support' },
	}),
	item('amb', { group: 'ambient', meta: { frame: 10, role: 'ambient' } }),
	item('trk', { group: 'tracks', meta: {} }),
	item('orphan', { setup: true, group: 'setup', state: 'rejected', meta: { setup: true } }),
	item('odd', { group: 'Wacky', state: 'stale', reason: 'clp_x changed', meta: { frame: 5 } }),
];

describe('review model', () => {
	it('groups by role (Hero, Support, Bed, …, Tracks) in time order; setup folded under the first row needing it', () => {
		const m = buildReviewModel(ITEMS, null);
		expect(m.groups.map((g) => [g.label, g.rows.map((r) => r.item.id)])).toEqual([
			['Hero', ['sfx:001']],
			['Support', ['sfx:003', 'sfx:002']],
			['Bed', ['amb']],
			['Wacky', ['odd']],
			['Tracks', ['trk']],
		]);
		// bin is needed through sound:a: folded under the first row (proposal order) that needs it
		expect(m.byId['sfx:002']!.setup.map((s) => s.id)).toEqual(['bin', 'sound:a', 'cue:1']);
		expect(m.byId['sfx:001']!.setup).toEqual([]);
		expect(m.orphans.map((s) => s.id)).toEqual(['orphan']);
		expect(m.listOrder).toEqual(['sfx:001', 'sfx:003', 'sfx:002', 'amb', 'odd', 'trk']);
		expect(m.timeOrder).toEqual(['odd', 'amb', 'sfx:003', 'sfx:002', 'sfx:001', 'trk']);
		const r = m.byId['sfx:001']!;
		expect(r).toMatchObject({ frame: 200, kind: 'land', role: 'hero', reason: 'Logo lands' });
		// the chosen alternative's name
		expect(r.sound).toBe('Big boom');
		expect(m.byId['sfx:002']).toMatchObject({ sound: 'Crunch', gainDb: -0.5, reason: 'Cut A → B' });
	});

	it('takes frames and gains from the ghosts when the item carries none', () => {
		const ghost = {
			clips: [{ itemId: 'trk', gainDb: -6 }],
			byItem: { trk: { start: 400, end: 420 } },
			items: [],
		} as unknown as GhostModel;
		const m = buildReviewModel(ITEMS, ghost);
		expect(m.byId.trk).toMatchObject({ frame: 400, gainDb: -6 });
		expect(m.timeOrder.at(-1)).toBe('trk');
	});

	it('counts leave setup items out; open = pending + stale', () => {
		expect(reviewCounts(ITEMS)).toEqual({
			total: 6,
			pending: 4,
			accepted: 1,
			rejected: 0,
			stale: 1,
			invalid: 0,
			applied: 0,
			open: 5,
		});
	});

	it('navigation clamps at the ends and starts at the first / last', () => {
		const order = ['a', 'b', 'c'];
		expect(stepItem(order, null, 1)).toBe('a');
		expect(stepItem(order, null, -1)).toBe('c');
		expect(stepItem(order, 'a', 1)).toBe('b');
		expect(stepItem(order, 'c', 1)).toBe('c');
		expect(stepItem(order, 'a', -1)).toBe('a');
		expect(stepItem(order, 'gone', 1)).toBe('a');
		expect(stepItem([], 'a', 1)).toBeNull();
	});

	it('the range covers every ghost item', () => {
		expect(proposalRange(null)).toBeNull();
		const g = {
			items: [
				{ start: 50, end: 60 },
				{ start: 10, end: 20 },
				{ start: 30, end: 90 },
			],
		} as GhostModel;
		expect(proposalRange(g)).toEqual({ start: 10, end: 90 });
	});

	it('the card sentence counts sounds and new tracks (singular forms too)', () => {
		expect(
			cardSentence('claude', 'Sound design: Main', 'sound-design', { sounds: 12, newTracks: 2, items: 12 }),
		).toBe('claude proposes Sound design: Main: 12 sounds on 2 new tracks');
		expect(cardSentence('claude', 'Pass', 'sound-design', { sounds: 1, newTracks: 1, items: 1 })).toBe(
			'claude proposes Pass: 1 sound on 1 new track',
		);
		expect(cardSentence('claude', 'Pass', 'sound-design', { sounds: 3, newTracks: 0, items: 3 })).toBe(
			'claude proposes Pass: 3 sounds',
		);
		expect(cardSentence('bot', 'Tidy', 'cleanup', { sounds: 0, newTracks: 0, items: 4 })).toBe(
			'bot proposes Tidy: 4 items',
		);
		expect(cardSentence('bot', 'Tidy', 'cleanup', null)).toBe('bot proposes Tidy');
	});

	it('card counts and removals from a real preview: the fixture proposal (a new track, two sounds, a moved bed)', async () => {
		const f = await proposalFixture();
		const p = f.c.getState().proposal!;
		const counts = proposalCardCounts(f.session.getCommitted(), p, {
			registries: f.session.ctx.registries,
			revision: f.session.revision,
		});
		// hit + boom are created clips on the new SFX track; the bed move changes a clip (not a sound it adds)
		expect(counts).toEqual({ sounds: 2, newTracks: 1, items: 5 });
		// nothing the fixture applies deletes a clip
		expect(removalsOf(f.c.getState().preview, ['hit', 'boom', 'move', 'cue'])).toEqual([]);
		f.c.exit();
	});

	it('never throws on hostile items (fuzzed meta, states, requires)', () => {
		const arb = fc.array(
			fc.record({
				id: fc.string({ minLength: 1, maxLength: 8 }),
				group: fc.oneof(fc.constant('hero'), fc.string({ maxLength: 6 })),
				setup: fc.boolean(),
				requires: fc.array(fc.string({ maxLength: 8 }), { maxLength: 4 }),
				state: fc.constantFrom('pending', 'accepted', 'rejected', 'stale', 'invalid', 'applied' as const),
				meta: fc.anything(),
				selectedAlternative: fc.integer({ min: -2, max: 5 }),
			}),
			{ maxLength: 30 },
		);
		fc.assert(
			fc.property(arb, (xs) => {
				const items = xs.map((x) =>
					item(x.id, {
						group: x.group,
						setup: x.setup,
						requires: x.requires,
						state: x.state as ReviewItem['state'],
						meta: x.meta,
						selectedAlternative: x.selectedAlternative,
						alternatives: 3,
					}),
				);
				const m = buildReviewModel(items, null);
				const shown = m.groups.flatMap((g) => g.rows).length;
				expect(shown).toBe(items.filter((i) => !i.setup).length);
				reviewCounts(items);
			}),
			{ numRuns: 300 },
		);
	});
});
