// S09:TRK-012 / wp-m2-track acceptance: prefer the selected screen edge and
// preserve an invisible side. Fixture pixels and expected edges are independent
// of the tracker's line/intersection helpers.
import { describe, expect, it } from 'vitest';
import { chooseEdgeModes, refineQuadEdges } from '../src/tracking/geometry.ts';

const W = 320;
const H = 240;
const EDGE = { band: 4, n: 48, maxShift: 3, maxResidual: 0.75, minFraction: 0.35, minContrast: 2 };
const REFERENCE = { ...EDGE, band: 6, maxShift: 6, maxResidual: 1 };

function rectangle(bottom: number, value: (distance: number) => number): Uint8Array {
	const image = new Uint8Array(W * H);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) image[y * W + x] = value(Math.min(x - 60, 260 - x, y - 50, bottom - y));
	return image;
}

describe('planar edge refinement', () => {
	it('snaps to the edge nearest to the given side, never across the bezel (wall → bezel → mask → screen)', () => {
		// The selected mask/screen boundary is weaker than the nearby bezel/mask edge.
		const image = rectangle(190, (d) => (d < -10 ? 130 : d < 0 ? 177 : d < 3 ? 21 : 35));
		const given = [62.2, 52.2, 257.8, 52.2, 257.8, 187.8, 62.2, 187.8];
		const modes = chooseEdgeModes(image, W, H, given, REFERENCE);
		const { quad } = refineQuadEdges(image, W, H, given, modes, REFERENCE);
		// Dark mask occupies integer samples 60..62; the screen begins at 63.
		// Its boundary is therefore halfway between samples 62 and 63.
		const screen = [62.5, 52.5, 257.5, 52.5, 257.5, 187.5, 62.5, 187.5];
		for (let i = 0; i < screen.length; i++) expect(Math.abs(quad[i]! - screen[i]!)).toBeLessThan(0.15);
	});

	it('keeps the predicted line for sides outside the frame and rejects far edges', () => {
		const image = rectangle(300, (d) => (d < 0 ? 60 : 200));
		const predicted = [61, 51, 261, 51, 260.8, 300.8, 60.8, 300.8];
		const modes = chooseEdgeModes(image, W, H, predicted, REFERENCE);
		const { quad } = refineQuadEdges(image, W, H, predicted, modes, EDGE);
		expect(Math.abs(quad[1]! - 50)).toBeLessThan(1);
		expect(quad[5]).toBeCloseTo(300.8, 6);
		expect(quad[7]).toBeCloseTo(300.8, 6);
		// The only visible horizontal edge is beyond the search band.
		const far = [60, 57, 260, 57, 260, 307, 60, 307];
		expect(refineQuadEdges(image, W, H, far, ['rise', null, null, null], EDGE).quad).toEqual(far);
	});
});
