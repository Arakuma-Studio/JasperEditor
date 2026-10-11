import { isDraft, produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { peek, peekKeys } from '../src/commands/handlers/util.ts';
import { Harness } from './helpers.ts';

describe('peek', () => {
	it('reads current draft values without drafting untouched children', () => {
		const base = { a: { x: 1 }, b: { y: 2 } };
		produce(base, (d) => {
			expect(peek(d, 'a')).toBe(base.a);
			expect(isDraft(peek(d, 'a'))).toBe(false);
			d.b.y = 3;
			expect(isDraft(peek(d, 'b'))).toBe(true);
			expect(peek<{ y: number }>(d, 'b')!.y).toBe(3);
			(d as Record<string, unknown>).c = { z: 1 };
			expect(peekKeys(d)).toEqual(['a', 'b', 'c']);
			expect(peek(d, 'constructor')).toBeUndefined();
		});
		expect(peek({}, 'toString')).toBeUndefined();
	});

	it('an effect added and keyframed in one transaction, a shape resized and kept centred', () => {
		const h = new Harness();
		const r = h.ok([
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1], ref: '$s' },
			{ type: 'effect.add', target: { clipId: '$s' }, effectId: 'jasper.gaussian-blur', ref: '$fx' },
			{ type: 'keyframe.add', target: ['effect', '$fx', 'radius'], at: { frames: 0 }, value: 2 },
			{ type: 'keyframe.add', target: ['effect', '$fx', 'radius'], at: { frames: 20 }, value: 9 },
			{ type: 'clip.addShape', at: 0, track: 'V2', shape: { type: 'rect', size: [100, 50] }, ref: '$sh' },
			{ type: 'param.set', target: ['clip', '$sh', 'shape', 'size'], value: [300, 50] },
		]);
		const solid = h.seq.clips[r.refs.$s!] as unknown as {
			effects: { params: { radius: { keyframes: unknown[] } } }[];
		};
		expect(solid.effects[0]!.params.radius.keyframes).toHaveLength(2);
		const shape = h.seq.clips[r.refs.$sh!] as unknown as { transform: { anchor: { value: number[] } } };
		expect(shape.transform.anchor.value).toEqual([150, 25]);
	});
});
