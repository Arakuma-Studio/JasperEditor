// The Review panel / bar model (WP3.3b, spec 12 §2.7 "Review"): rows grouped by role in time order with setup items
// folded under the row that needs them, counts that leave setup items out, navigation orders, the range Review zooms
// to, what an Apply would remove (named in its confirmation), the proposal card's sentence; hostile item metadata
// never throws.
import type { ReviewItem } from '@jasper/session';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildGhostModel, type GhostModel, whyLines } from '../src/proposals/ghosts.ts';
import {
	buildReviewModel,
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
		selected: o.selected ?? true,
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
			clips: [{ itemId: 'trk', sourceItemId: 'trk', change: 'created', gainDb: -6 }],
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

describe('approvalNeeds (Apply names what an agent could not do unasked)', () => {
	it('destructive commands, force and the agents-may-apply grant, through the accept closure, once each', async () => {
		const { approvalNeeds } = await import('../src/proposals/review.ts');
		const p = {
			id: 'prp_0000000000000001',
			items: [
				{
					id: 'a',
					label: 'a',
					group: 'g',
					requires: [],
					state: 'pending',
					commands: [{ type: 'marker.add', frame: 1 }],
				},
				{
					id: 'b',
					label: 'b',
					group: 'g',
					requires: ['a'],
					state: 'pending',
					commands: [{ type: 'soundDesign.setSettings', agentsMayApply: true }],
				},
				{
					id: 'c',
					label: 'c',
					group: 'g',
					requires: ['b'],
					state: 'pending',
					commands: [
						{ type: 'track.remove', trackIds: ['A2'] },
						{ type: 'clip.move', clipIds: ['x'], deltaFrames: 1, force: true },
						{ type: 'track.remove', trackIds: ['A3'] },
					],
				},
			],
		} as never;
		expect(approvalNeeds(p, ['a'])).toEqual([]);
		expect(approvalNeeds(p, ['b'])).toEqual([{ kind: 'agentsMayApply' }]);
		const c = approvalNeeds(p, ['c']);
		expect(c.map((x) => x.kind)).toEqual(['agentsMayApply', 'command', 'force']);
		expect(approvalNeeds(null, ['c'])).toEqual([]);
		expect(approvalNeeds({ items: 'nope' } as never, ['c'])).toEqual([]);
	});
});

describe('an item shows its own gain and why-line (its chosen command set), not a setup item folded under it', () => {
	it("the delivery setup re-levels the music: the row keeps the placement's gain; an alternative shows its own", async () => {
		const f = await proposalFixture();
		f.c.exit();
		const place = (gainDb: number) => [
			{ type: 'clip.place', source: { mediaId: f.mediaId }, at: 30, tracks: { audio: '$sfx2' }, ref: '$h0' },
			{ type: 'clip.update', clipIds: ['$h0'], patch: { gainDb } },
		];
		const p = f.engine.create({
			feature: 'sound-design',
			title: 'Mix pass',
			sequenceId: f.seqId,
			items: [
				{
					id: 'trk',
					label: 'SFX track',
					group: 'setup',
					commands: [{ type: 'track.add', kind: 'audio', name: 'SFX 2', ref: '$sfx2' }],
					meta: { setup: true },
				},
				{
					id: 'delivery',
					label: 'Web: loudness, Auto-Match, ducking',
					group: 'setup',
					commands: [{ type: 'clip.update', clipIds: [f.bed.id], patch: { gainDb: 14.6 } }],
					meta: { setup: true, kind: 'delivery' },
				},
				{
					id: 'hit',
					label: 'Hit A · cut',
					group: 'support',
					requires: ['trk', 'delivery'],
					commands: place(-11),
					meta: { frame: 30, kind: 'cut', role: 'support', why: 'Hit A on the cut' },
					alternatives: [{ label: 'Hit B', commands: place(-7), meta: { why: 'Hit B on the cut' } }],
				},
			],
		});
		await f.c.setActive(p.id);
		f.flush();
		const look = () => {
			const st = f.c.getState();
			const ghost = buildGhostModel({
				preview: st.preview!,
				committed: f.session.getCommitted(),
				sequenceId: f.seqId,
				items: st.items,
				agent: true,
			});
			const hit = st.items.find((i) => i.id === 'hit')!;
			return {
				ghost,
				row: buildReviewModel(st.items, ghost).byId.hit!,
				lines: whyLines(hit, ghost, f.seq(), st.preview!.result.document.sequences[f.seqId]),
			};
		};
		let v = look();
		// the music clip's ghost is shown under "hit" (it requires the delivery setup) but it is the setup's change
		const music = v.ghost.clips.find((c) => c.clipId === f.bed.id)!;
		expect(music).toMatchObject({ itemId: 'hit', sourceItemId: 'delivery', gainDb: 14.6 });
		expect(v.row.gainDb).toBe(-11);
		expect(v.lines.why).toBe('Hit A on the cut');
		expect(v.lines.facts.join(' · ')).toContain('-11.0 dB');
		expect(v.lines.facts.join(' · ')).not.toContain('14.6');
		// the user picks the alternative: its own clip's gain and its own why-line
		expect((await f.c.selectAlternative('hit', 1)).ok).toBe(true);
		f.flush();
		v = look();
		expect(v.row.gainDb).toBe(-7);
		expect(v.row.reason).toBe('Hit B on the cut');
		expect(v.lines.why).toBe('Hit B on the cut');
		expect(v.lines.facts.join(' · ')).toContain('-7.0 dB');
		expect(v.lines.facts.join(' · ')).not.toContain('14.6');
		f.c.exit();
	});
});
