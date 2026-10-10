// polish: item.setPoster — Set / Clear Poster Frame of a media item (Project panel thumbnails).
import { describe, expect, it } from 'vitest';
import { checkInvariants, flicksPerFrame, type MediaItem, RATES } from '../src/index.ts';
import { Harness } from './helpers.ts';

const F = flicksPerFrame(RATES.r30);

function mediaItem(h: Harness, seconds = 10) {
	const mediaId = h.registerVideo({ seconds, audio: true });
	const itemId = Object.values(h.doc.items).find((i) => i.kind === 'media' && i.mediaId === mediaId)!.id;
	return { itemId, mediaId };
}
const poster = (h: Harness, itemId: string) => (h.doc.items[itemId] as MediaItem).poster;
function refused(h: Harness, commands: unknown[]) {
	const r = h.tx(commands);
	if (r.ok) throw new Error('expected the transaction to be refused');
	return r;
}

describe('item.setPoster', () => {
	it('sets the poster frame in content time (flicks, seconds or source frames), and clears it', () => {
		const h = new Harness();
		const { itemId } = mediaItem(h);
		expect(poster(h, itemId)).toBeUndefined();
		h.ok([{ type: 'item.setPoster', itemId, time: { flicks: 45 * F } }]);
		expect(poster(h, itemId)).toEqual({ flicks: 45 * F });
		h.ok([{ type: 'item.setPoster', itemId, time: { seconds: 2 } }]);
		expect(poster(h, itemId)).toEqual({ flicks: 60 * F });
		h.ok([{ type: 'item.setPoster', itemId, time: { sourceFrames: 7 } }]);
		expect(poster(h, itemId)).toEqual({ flicks: 7 * F });
		h.ok([{ type: 'item.setPoster', itemId, time: null }]);
		expect(poster(h, itemId)).toBeUndefined();
		// clearing again is not an error
		h.ok([{ type: 'item.setPoster', itemId, time: null }]);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('is one undoable step', () => {
		const h = new Harness();
		const { itemId } = mediaItem(h);
		const before = h.doc;
		const r = h.ok([{ type: 'item.setPoster', itemId, time: { seconds: 3 } }]);
		expect(r.ok).toBe(true);
		const after = h.doc;
		expect((after.items[itemId] as MediaItem).poster).toEqual({ flicks: 90 * F });
		// the transaction replaced the item and left the previous document untouched (undo restores it)
		expect((before.items[itemId] as MediaItem).poster).toBeUndefined();
		expect(after.items[itemId]).not.toBe(before.items[itemId]);
	});

	it('refuses a frame past the end of the media, other item kinds and unknown items', () => {
		const h = new Harness();
		const { itemId } = mediaItem(h, 4);
		expect(refused(h, [{ type: 'item.setPoster', itemId, time: { seconds: 4 } }]).errors[0]!.code).toBe(
			'E_OUT_OF_MEDIA',
		);
		expect(refused(h, [{ type: 'item.setPoster', itemId, time: { seconds: 400 } }]).errors[0]!.code).toBe(
			'E_OUT_OF_MEDIA',
		);
		h.ok([{ type: 'bin.create', name: 'Bin', ref: '$b' }]);
		const bin = Object.values(h.doc.items).find((i) => i.kind === 'bin')!.id;
		expect(refused(h, [{ type: 'item.setPoster', itemId: bin, time: { seconds: 1 } }]).errors[0]!.code).toBe(
			'E_INVALID_PARAM',
		);
		expect(refused(h, [{ type: 'item.setPoster', itemId: 'itm_missing', time: null }]).errors.length).toBe(1);
		expect(
			refused(h, [{ type: 'item.setPoster', itemId, time: { seconds: -1 } } as never]).errors[0]!.code,
		).toMatch(/E_/);
		expect(poster(h, itemId)).toBeUndefined();
	});
});
