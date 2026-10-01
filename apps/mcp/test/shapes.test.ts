// get_timeline / clip summaries for shapes (S11:SHP-008, ANA-008, wp-m2-shapes); add_shape end to end is in
// integration.test.ts.
import { anim, defaultShape } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { shapeText } from '../src/format.ts';

describe('shapeText', () => {
	it('describes geometry and paint compactly', () => {
		expect(shapeText(defaultShape('rect'))).toBe('rect 400×400 fill #ffffff');
		expect(
			shapeText(
				defaultShape('rect', {
					size: [640.25, 160],
					fill: null,
					stroke: { color: [1, 0.8, 0, 0.5], width: 6, position: 'outside' },
					cornerRadius: 24,
				}),
			),
		).toBe('rect 640.25×160 no fill stroke 6px #ffcc0080 outside radius 24');
	});
	it('lists keyframed properties', () => {
		const s = defaultShape('ellipse', { cornerRadius: 0 });
		s.size = {
			...anim<[number, number]>([10, 10]),
			keyframes: [
				{
					id: 'kf_1',
					time: 0,
					value: [10, 10],
					interpolation: 'linear',
					easeIn: { influence: 1 / 3, slope: 0 },
					easeOut: { influence: 1 / 3, slope: 0 },
				},
			],
		};
		expect(shapeText(s)).toBe('ellipse 10×10 fill #ffffff (animated: size)');
	});
});
