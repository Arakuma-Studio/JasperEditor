// Security review DATA-2: shortening a nested sequence that is placed elsewhere (lifting or trimming its last clip,
// deleting media used inside it) used to be refused with E_INVARIANT (INV-005 "exceeds its nested sequence"), so
// such edits were impossible. As in Premiere, the nest clip keeps its length and shows nothing past the content;
// its handles still stop at the content's end.
import { describe, expect, it } from 'vitest';
import { applyTransaction, buildRenderSnapshot, checkInvariants, loadProject } from '../src/index.ts';
import { Harness } from './helpers.ts';

function nested() {
	const h = new Harness();
	const m = h.registerVideo({ seconds: 8 });
	h.ok([
		{ type: 'clip.place', source: { mediaId: m }, at: 0 },
		{ type: 'clip.place', source: { mediaId: m }, at: 240 },
	]);
	const r = h.ok([{ type: 'clip.nest', clipIds: h.clips('V1').map((c) => c.id), name: 'Nest' }]);
	const nestSeqId = (r.results[0] as { sequenceId: string }).sequenceId;
	const outer = h.clips('V1').find((c) => c.kind === 'nest-video')!;
	return { h, m, nestSeqId, outer };
}

describe('DATA-2: edits that shorten a placed nested sequence', () => {
	it('lifting the last clip inside the nest is allowed; the nest clip keeps its length', () => {
		const { h, nestSeqId, outer } = nested();
		const inner = Object.values(h.doc.sequences[nestSeqId]!.clips)
			.filter((c) => c.kind === 'video')
			.sort((a, b) => b.start - a.start)[0]!;
		const { document, result } = applyTransaction(
			h.doc,
			{
				label: 'lift',
				origin: 'user',
				sequenceId: nestSeqId,
				commands: [{ type: 'clip.lift', clipIds: [inner.id] }],
			},
			h.ctx(),
		);
		expect(result.ok).toBe(true);
		expect(checkInvariants(document)).toEqual([]);
		const after = Object.values(document.sequences[h.seqId]!.clips).find((c) => c.id === outer.id)!;
		expect(after.duration).toBe(outer.duration);
		// The overhang renders nothing (and does not throw).
		const snap = buildRenderSnapshot(document, h.seqId, {
			resolveMedia: () => null,
			resolveFont: () => null,
		});
		expect(snap).toBeTruthy();
		// It reloads without repairs.
		const loaded = loadProject(JSON.parse(JSON.stringify(document)));
		expect(loaded.repairs).toEqual([]);
		expect(loaded.issues).toEqual([]);
		// Trimming the nest clip's out edge further is still bounded by the content (nothing to extend into).
		h.doc = document;
		const ext = h.tx([
			{ type: 'clip.trim', clipId: outer.id, edge: 'out', deltaFrames: 60, mode: 'regular' },
		]);
		const len = ext.ok ? h.seq.clips[outer.id]!.duration : outer.duration;
		expect(len).toBe(outer.duration);
	});

	it('deleting media used only inside the nest is allowed', () => {
		const { h, m } = nested();
		const item = Object.values(h.doc.items).find((i) => i.kind === 'media' && i.mediaId === m)!;
		const r = h.tx([{ type: 'item.delete', itemIds: [item.id], force: true }]);
		expect(r.ok).toBe(true);
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});
