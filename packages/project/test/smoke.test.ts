import { describe, expect, it } from 'vitest';
import { checkInvariants } from '../src/index.ts';
import { Harness } from './helpers.ts';

describe('smoke', () => {
	it('creates a project and places a clip', () => {
		const h = new Harness();
		expect(checkInvariants(h.doc)).toEqual([]);
		const mediaId = h.registerVideo();
		const r = h.ok([{ type: 'clip.place', source: { mediaId }, at: 0, tracks: { video: 'V1' } }]);
		expect(r.created.length).toBeGreaterThan(0);
		expect(h.spans('V1')).toEqual([[0, 300]]);
		expect(h.spans('A1')).toEqual([[0, 300]]);
	});
});
