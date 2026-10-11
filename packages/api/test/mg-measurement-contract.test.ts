import type { MgTextMeasurement } from '@jasper/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MgTextMeasureResultSchema } from '../src/mg-bundles.ts';

const measured: MgTextMeasurement = {
	id: 'title',
	found: true,
	visible: true,
	rect: { x: -2.5, y: 10.25, width: 120, height: 30 },
	lines: [{ x: -2.5, y: 10.25, width: 120, height: 30 }],
	clippedBy: { x: 0, y: 0, width: 100, height: 100 },
	truncated: true,
	style: {
		fontFamily: 'sans-serif',
		fontSize: 24,
		fontWeight: '400',
		fontStyle: 'normal',
		color: 'rgb(0, 0, 0)',
		lineHeight: null,
		letterSpacing: -0.5,
		textAlign: 'left',
		textTransform: 'none',
		whiteSpace: 'normal',
	},
};

describe('text measurement response contract', () => {
	it('preserves layout and computed styles from the text probe', () => {
		const response = { measurements: [measured], fonts: ['sans-serif'] };
		expect(MgTextMeasureResultSchema.parse(response)).toEqual(response);
	});

	it('accepts missing and invisible text without requiring layout or styles', () => {
		const measurements = [false, true].map((found) => ({
			id: 'title',
			found,
			visible: false,
			rect: null,
			lines: [],
			clippedBy: null,
			truncated: false,
			style: null,
		}));
		expect(MgTextMeasureResultSchema.parse({ measurements, fonts: [] }).measurements).toEqual(measurements);
	});

	it.each([
		['missing layout fields', { id: 'title', found: true }],
		['invalid visibility', { ...measured, visible: 'yes' }],
		['incomplete rectangle', { ...measured, rect: { x: 0, y: 0 } }],
		['invalid lines', { ...measured, lines: [null] }],
		['incomplete style', { ...measured, style: { fontSize: 24 } }],
		['non-finite rectangle', { ...measured, rect: { ...measured.rect, x: Infinity } }],
		['non-finite line', { ...measured, lines: [{ ...measured.rect, width: NaN }] }],
		['non-finite style', { ...measured, style: { ...measured.style, fontSize: -Infinity } }],
	])('rejects %s before consumers inspect it', (_label, measurement) => {
		expect(MgTextMeasureResultSchema.safeParse({ measurements: [measurement], fonts: [] }).success).toBe(
			false,
		);
	});

	it('preserves finite layout coordinates without rounding or clamping', () => {
		const coordinate = fc.double({ noNaN: true, noDefaultInfinity: true });
		fc.assert(
			fc.property(
				fc.record({ x: coordinate, y: coordinate, width: coordinate, height: coordinate }),
				(rect) => {
					const response = {
						measurements: [{ ...measured, rect, lines: [rect], clippedBy: rect }],
						fonts: [],
					};
					expect(MgTextMeasureResultSchema.parse(response)).toEqual(response);
				},
			),
			{ numRuns: 200 },
		);
	});
});
