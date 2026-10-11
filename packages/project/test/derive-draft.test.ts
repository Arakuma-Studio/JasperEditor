// Immer keeps the clips-record proxy across commands in a transaction; its identity cannot key a clip-index cache.
import { describe, expect, it } from 'vitest';
import { Harness } from './helpers.ts';

describe('derived indexes inside one transaction', () => {
	it('alternating clip.place and transition.add on the clips just placed', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 20, audio: false });
		const commands: unknown[] = [];
		for (let g = 0; g < 5; g++) {
			commands.push({
				type: 'clip.place',
				source: { mediaId: m },
				at: g * 90,
				sourceRange: { in: { sourceFrames: 30 * g }, out: { sourceFrames: 30 * g + 90 } },
				ref: `$m${g}`,
			});
			if (g > 0)
				commands.push({
					type: 'transition.add',
					clipId: `$m${g}`,
					edge: 'in',
					effectId: 'jasper.cross-dissolve',
					duration: 10,
				});
		}
		commands.push({ type: 'marker.add', frame: 440, name: 'end' });
		const r = h.tx(commands);
		expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
		expect(Object.keys(h.seq.transitions)).toHaveLength(4);
		expect(h.spans('V1')).toEqual([0, 1, 2, 3, 4].map((g) => [g * 90, g * 90 + 90]));
	});
});
