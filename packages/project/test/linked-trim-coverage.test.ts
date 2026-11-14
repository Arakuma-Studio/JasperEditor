// Linked trims keep picture and sound edges together, and edits that leave video uncovered under kept audio say so
// (docs/wp-notes/edit-ux.md "Uncovered video"). Reported on a real cut (≈ 6:48, rev 479): a V1 sliver was lifted
// (range.lift tracks: ["V1"]) and the clip before it extended with clip.trim linked: false; later ripple trims with
// linked: true on the A1 sounds (+7 frames tail, −5 frames onset) grew and rippled the sound but not its picture,
// leaving two 7-frame holes on V1 that exported as the subtitle over black.
import { describe, expect, it } from 'vitest';
import { type Clip, checkInvariants, uncoveredPicture } from '../src/index.ts';
import { Harness } from './helpers.ts';

/** Two linked A/V clips in a row on V1 / A1, 100 frames each, with media handles on both sides. */
function twoShots(h: Harness) {
	const m = h.registerVideo({ seconds: 30 });
	const place = (at: number, fromSec: number) => {
		const r = h.ok([
			{
				type: 'clip.place',
				source: { mediaId: m },
				at,
				sourceRange: { in: { seconds: fromSec }, out: { seconds: fromSec + 100 / 30 } },
			},
		]);
		return (r.results[0] as { clipIds: string[] }).clipIds as [string, string];
	};
	const [xv, xa] = place(0, 2);
	const [yv, ya] = place(100, 10);
	return { xv, xa, yv, ya };
}

const span = (h: Harness, id: string) => {
	const c = h.seq.clips[id] as Clip;
	return [c.start, c.start + c.duration];
};
const holes = (h: Harness) => uncoveredPicture(h.doc, h.seq).filter((r) => r.audible);

describe('linked trims keep the picture over its sound', () => {
	it('ripple trims of a sound whose picture edge moved apart trim the picture too: no black under the sound', () => {
		const h = new Harness();
		const { xv, xa, yv, ya } = twoShots(h);
		// hide a 7-frame V1 sliver, then extend the picture before it over the hole (sound unchanged)
		const lift = h.ok([{ type: 'range.lift', from: 100, to: 107, tracks: ['V1'] }]);
		expect(lift.warnings.map((w) => w.code)).toContain('W_UNCOVERED_VIDEO');
		h.ok([{ type: 'clip.trim', clipId: xv, edge: 'out', deltaFrames: 7, linked: false }]);
		expect(holes(h)).toEqual([]);
		// +7 on the first sound's tail, then −5 (5 frames earlier) on the second sound's onset, both linked ripples
		h.ok([{ type: 'clip.trim', clipId: xa, edge: 'out', deltaFrames: 7, mode: 'ripple', linked: true }]);
		h.ok([{ type: 'clip.trim', clipId: ya, edge: 'in', deltaFrames: -5, mode: 'ripple', linked: true }]);
		expect(holes(h)).toEqual([]);
		expect(span(h, xv)).toEqual([0, 114]);
		expect(span(h, xa)).toEqual([0, 107]);
		// the second shot's picture still starts 7 frames into its sound (the split edit kept its offset)
		expect(span(h, yv)[0] - span(h, ya)[0]).toBe(7);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('a regular trim of the picture alone that opens black under its sound warns', () => {
		const h = new Harness();
		const { xv } = twoShots(h);
		const r = h.ok([{ type: 'clip.trim', clipId: xv, edge: 'out', deltaFrames: -10, linked: false }]);
		expect(r.warnings.find((w) => w.code === 'W_UNCOVERED_VIDEO')?.message).toMatch(/90–100/);
		const both = h.ok([{ type: 'clip.trim', clipId: h.clips('A1')[1]!.id, edge: 'in', deltaFrames: 5 }]);
		expect(both.warnings.map((w) => w.code)).not.toContain('W_UNCOVERED_VIDEO');
	});
});
