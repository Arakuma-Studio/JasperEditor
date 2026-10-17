// The batched review preview (WP6.5b items 14 and 15): `previewProposal` applies up to 32 items in one transaction
// and attributes every ghost to its item; it must give exactly what one transaction per item gives (the reference,
// `batch: 1`) — the document, the items applied, the failures and every item's ghosts — on random proposals with
// requirements, refs, failing items, entities two items touch, and items that only break an invariant together.
// Invariant-only conflicts are found in a proposal of any size, and the batched build takes far fewer transactions.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	createProposal,
	createSeededIdSource,
	defaultRegistries,
	type Proposal,
	type ProposalContext,
	type ProposalItem,
	type ProposalPreview,
	previewProposal,
	previewStats,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const NOW = '2026-10-16T10:00:00.000Z';
const CTX: ProposalContext = { registries: defaultRegistries(), now: () => NOW, invariants: 'incremental' };
const DUP = ['mrk_00000000000000D1', 'mrk_00000000000000D2'];

function setup() {
	const h = new Harness();
	const mediaId = h.registerVideo({ seconds: 10 });
	h.ok([{ type: 'clip.place', source: { mediaId }, at: 0, tracks: { video: 'V1', audio: 'A1' } }]);
	h.ok([{ type: 'marker.add', frame: 7, name: 'existing' }]);
	const clipId = h.clips('V1')[0]!.id;
	const markerId = h.doc.sequences[h.seqId]!.markers[0]!.id;
	return { h, clipId, markerId };
}

/** A stored proposal holding exactly `items` (all pending): what the preview is given, however it was made. */
function proposalOf(h: Harness, items: { id: string; commands: unknown[]; requires?: string[] }[]): Proposal {
	const r = createProposal(
		h.doc,
		{
			feature: 'sound-design',
			title: 'Batch',
			sequenceId: h.seqId,
			items: [{ id: 'seed', label: 'seed', commands: [{ type: 'marker.add', frame: 1 }] }],
		},
		{ id: 'prp_00000000000000B1', projectId: h.doc.projectId, author: 'user', now: NOW, revision: 0 },
		CTX,
	);
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const proto = r.proposal.items[0]!;
	return {
		...r.proposal,
		items: items.map(
			(it): ProposalItem => ({
				...proto,
				id: it.id,
				label: it.id,
				commands: it.commands as ProposalItem['commands'],
				requires: it.requires ?? [],
				state: 'pending',
				anchors: {},
			}),
		),
	};
}

type Kind = { k: number; a: number; b: number };
const kindArb = fc.record({ k: fc.integer({ min: 0, max: 9 }), a: fc.nat(1000), b: fc.nat(1000) });

function itemsOf(kinds: Kind[], clipId: string, markerId: string) {
	const tracks: string[] = [];
	return kinds.map(({ k, a, b }, i) => {
		const id = `i${i}`;
		switch (k) {
			case 0:
				return { id, commands: [{ type: 'marker.add', frame: 20 + (a % 300), name: `n${i}` }] };
			case 1: // a supplied id: two of these with the same id only conflict together (INV-001)
				return { id, commands: [{ type: 'marker.add', frame: 20 + (a % 300), id: DUP[b % 2] }] };
			case 2:
				return { id, commands: [{ type: 'marker.update', markerId, name: `r${i}` }] };
			case 3:
				tracks.push(id);
				return { id, commands: [{ type: 'track.add', kind: 'audio', name: `T${i}`, ref: `$t${i}` }] };
			case 4: {
				if (!tracks.length) return { id, commands: [{ type: 'marker.add', frame: 5 + (a % 50) }] };
				const t = tracks[b % tracks.length]!;
				return {
					id,
					requires: [t],
					commands: [{ type: 'track.update', trackId: `$t${t.slice(1)}`, patch: { mute: a % 2 === 0 } }],
				};
			}
			case 5:
				return { id, commands: [{ type: 'clip.update', clipId, patch: { name: `c${i}` } }] };
			case 6:
				return {
					id,
					commands: [
						{
							type: 'soundCue.add',
							cues: [{ frame: 10 + (a % 200), kind: 'cut', weight: 'support', source: 'agent' }],
						},
					],
				};
			case 7: // fails: no such track (and so does what requires it)
				return { id, commands: [{ type: 'track.update', trackId: 'A9', patch: { name: 'x' } }] };
			case 8: // moves the video clip and, through its link, the audio clip it never names
				return { id, commands: [{ type: 'clip.move', clipIds: [clipId], deltaFrames: 1 + (a % 4) }] };
			default:
				return {
					id,
					commands: [{ type: 'marker.add', frame: 400 + (a % 100), name: `z${i}` }],
					requires: i > 0 ? [`i${b % i}`] : [],
				};
		}
	});
}

const idsFor = (p: Proposal) => (it: ProposalItem) =>
	createSeededIdSource(`${p.id}:${it.id}:${it.selectedAlternative ?? 0}`);
const ghostSets = (r: ProposalPreview) =>
	Object.fromEntries(
		Object.entries(r.items).map(([id, g]) => [
			id,
			{ c: [...g.created].sort(), ch: [...g.changed].sort(), d: [...g.deleted].sort() },
		]),
	);
const failures = (r: ProposalPreview) =>
	Object.fromEntries(Object.entries(r.failed).map(([id, e]) => [id, e.map((x) => `${x.code}:${x.message}`)]));

describe('batched preview ≡ one transaction per item', () => {
	it('same document, items applied, failures and per-item ghosts (random proposals, invariant check on and off)', () => {
		const { h, clipId, markerId } = setup();
		fc.assert(
			fc.property(
				fc.array(kindArb, { minLength: 1, maxLength: 40 }),
				fc.integer({ min: 2, max: 9 }),
				fc.boolean(),
				(kinds, batch, check) => {
					const p = proposalOf(h, itemsOf(kinds, clipId, markerId));
					const ctx = { ...CTX, checkInvariants: check };
					const ref = previewProposal(h.doc, p, 'undecided', ctx, { idsFor: idsFor(p), batch: 1 });
					const got = previewProposal(h.doc, p, 'undecided', ctx, { idsFor: idsFor(p), batch });
					expect(JSON.stringify(got.document)).toBe(JSON.stringify(ref.document));
					expect(got.applied).toEqual(ref.applied);
					expect(failures(got)).toEqual(failures(ref));
					expect(ghostSets(got)).toEqual(ghostSets(ref));
					expect(got.ghost).toEqual(ref.ghost);
					// the invariant check finds what Apply would refuse: never two markers with one id
					if (check)
						for (const id of DUP)
							expect(
								got.document.sequences[h.seqId]!.markers.filter((m) => m.id === id).length,
							).toBeLessThanOrEqual(1);
				},
			),
			{ numRuns: 120, seed: 4242 },
		);
	});

	it('reuses the shared prefix of a preview of the same document (what Hear plays after a reject)', () => {
		const { h, clipId, markerId } = setup();
		const kinds = Array.from({ length: 100 }, (_, i) => ({ k: i % 7 === 3 ? 3 : 0, a: i * 7, b: i }));
		const p = proposalOf(h, itemsOf(kinds, clipId, markerId));
		const all = previewProposal(h.doc, p, 'undecided', CTX, { idsFor: idsFor(p) });
		const without = p.items.map((it) => it.id).filter((id) => id !== 'i90');
		const run = (reuse: ProposalPreview | null) => {
			previewStats(true);
			const r = previewProposal(h.doc, p, without, CTX, { idsFor: idsFor(p), reuse });
			return { r, items: previewStats().items };
		};
		const fresh = run(null);
		const reused = run(all);
		expect(JSON.stringify(reused.r.document)).toBe(JSON.stringify(fresh.r.document));
		expect(reused.r.applied).toEqual(fresh.r.applied);
		expect(ghostSets(reused.r)).toEqual(ghostSets(fresh.r));
		expect(failures(reused.r)).toEqual(failures(fresh.r));
		// only the batches from the one that holds i90 on (items 64…) are applied again
		expect(fresh.items).toBe(99);
		expect(reused.items).toBe(99 - 64);
	});
});

describe('invariant-only conflicts in a large proposal', () => {
	it('120 items, two of which add a marker with one id: the later one fails with the issue, the rest apply', () => {
		const { h, clipId, markerId } = setup();
		const kinds: Kind[] = Array.from({ length: 120 }, (_, i) => ({ k: 0, a: i, b: 0 }));
		kinds[30] = { k: 1, a: 3, b: 0 };
		kinds[101] = { k: 1, a: 9, b: 0 };
		const p = proposalOf(h, itemsOf(kinds, clipId, markerId));
		for (const batch of [1, 32]) {
			const r = previewProposal(h.doc, p, 'undecided', CTX, { idsFor: idsFor(p), batch });
			expect(Object.keys(r.failed)).toEqual(['i101']);
			expect(r.failed.i101![0]).toMatchObject({ code: 'E_INVARIANT', invariant: 'INV-001' });
			expect(r.failed.i101![0]!.message).toMatch(
				/^conflicts with the items before it: INV-001: Duplicate id mrk_00000000000000D1/,
			);
			expect(r.applied).toHaveLength(119);
			expect(r.document.sequences[h.seqId]!.markers.filter((m) => m.id === DUP[0])).toHaveLength(1);
		}
		// without the check (a caller that only counts), both apply
		const off = previewProposal(
			h.doc,
			p,
			'undecided',
			{ ...CTX, checkInvariants: false },
			{ idsFor: idsFor(p) },
		);
		expect(off.applied).toHaveLength(120);
	});
});
