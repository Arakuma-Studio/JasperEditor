// Session preview support (spec 12 §2.5, P3-R4): `createSeededIdSource` is deterministic and well-formed, and
// `previewProposal`'s `idsFor` keeps every item's created entities on the same ids whatever else the preview applies,
// so a recomputed preview document keeps its clips (the Program monitor keeps playing them).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	createProposal,
	createSeededIdSource,
	defaultRegistries,
	type Proposal,
	type ProposalContext,
	previewProposal,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const NOW = '2026-10-16T10:00:00.000Z';
const CTX: ProposalContext = { registries: defaultRegistries(), now: () => NOW };

describe('createSeededIdSource', () => {
	it('gives the same well-formed ids for the same seed', () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 40 }), (a) => {
				const s1 = createSeededIdSource(a);
				const s2 = createSeededIdSource(a);
				const ids1 = [s1.next('clp'), s1.next('trk'), s1.next('clp')];
				const ids2 = [s2.next('clp'), s2.next('trk'), s2.next('clp')];
				expect(ids1).toEqual(ids2);
				for (const id of ids1) expect(id).toMatch(/^(clp|trk)_[0-9A-HJKMNP-TV-Z]{16}$/);
				expect(new Set(ids1).size).toBe(3);
			}),
			{ numRuns: 300 },
		);
	});

	it('does not repeat within a long stream', () => {
		const s = createSeededIdSource('prp_X:item');
		const seen = new Set<string>();
		for (let i = 0; i < 20_000; i++) seen.add(s.next('clp'));
		expect(seen.size).toBe(20_000);
	});
});

describe('previewProposal idsFor', () => {
	function setup(): { h: Harness; p: Proposal } {
		const h = new Harness();
		const r = createProposal(
			h.doc,
			{
				feature: 'sound-design',
				title: 'Pass',
				sequenceId: h.seqId,
				items: [
					{ id: 'a', label: 'A', commands: [{ type: 'marker.add', frame: 10, name: 'a' }] },
					{ id: 'b', label: 'B', commands: [{ type: 'marker.add', frame: 20, name: 'b' }] },
					{ id: 'c', label: 'C', commands: [{ type: 'marker.add', frame: 30, name: 'c' }] },
				],
			},
			{ id: 'prp_0000000000000001', projectId: h.doc.projectId, author: 'user', now: NOW, revision: 0 },
			CTX,
		);
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		return { h, p: r.proposal };
	}
	const idsFor = (it: { id: string }) => createSeededIdSource(`prp_0000000000000001:${it.id}`);

	it("keeps an item's created ids whatever other items are applied", () => {
		const { h, p } = setup();
		const all = previewProposal(h.doc, p, ['a', 'b', 'c'], CTX, { idsFor });
		const onlyC = previewProposal(h.doc, p, ['c'], CTX, { idsFor });
		const again = previewProposal(h.doc, p, ['a', 'b', 'c'], CTX, { idsFor });
		expect(all.items.c!.created).toEqual(onlyC.items.c!.created);
		expect(all.ghost.created).toEqual(again.ghost.created);
		expect(all.ghost.created).toHaveLength(3);
		expect(h.doc.sequences[h.seqId]!.markers).toHaveLength(0);
	});

	it('uses ctx.ids (random by default) without idsFor', () => {
		const { h, p } = setup();
		const x = previewProposal(h.doc, p, ['a'], CTX);
		const y = previewProposal(h.doc, p, ['a'], CTX);
		expect(x.items.a!.created).not.toEqual(y.items.a!.created);
	});
});
