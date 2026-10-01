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
	it('prints the keyed values, not the stale static value, once a property is keyframed', () => {
		const key = <T>(time: number, value: T) => ({
			id: `kf_${time}`,
			time,
			value,
			interpolation: 'linear' as const,
			easeIn: { influence: 1 / 3, slope: 0 },
			easeOut: { influence: 1 / 3, slope: 0 },
		});
		const s = defaultShape('rect', {
			size: [400, 400],
			stroke: { color: [0, 0, 0, 1], width: 8, position: 'inside' },
		});
		// Keys out of time order on purpose; the static 400×400 is stale.
		s.size.keyframes = [key<[number, number]>(20, [200, 200]), key<[number, number]>(0, [100, 100])];
		s.stroke!.width.keyframes = [key(0, 2), key(10, 2), key(20, 6)];
		s.cornerRadius.keyframes = [key(0, 0), key(20, 12)];
		expect(shapeText(s)).toBe(
			'rect 100×100→200×200 fill #ffffff stroke 2→6px #000000 inside radius 0→12 (animated: size, stroke width, radius)',
		);
		s.fill!.keyframes = [1, 2, 3, 4, 5].map((i) =>
			key<[number, number, number, number]>(i, [i / 5, 0, 0, 1]),
		);
		expect(shapeText(s)).toContain('fill #330000→…→#ff0000 ');
	});
});
