import { describe, expect, it } from 'vitest';
import { checkInvariants } from '../src/index.ts';
import { Harness } from './helpers.ts';

const F = 705_600_000 / 30;

function ids(clip: unknown): string[] {
	const out: string[] = [];
	const visit = (v: unknown) => {
		if (Array.isArray(v)) return void v.forEach(visit);
		if (!v || typeof v !== 'object') return;
		const o = v as Record<string, unknown>;
		if (typeof o.id === 'string') out.push(o.id);
		Object.values(o).forEach(visit);
	};
	visit(clip);
	return out;
}

describe('DATA-7: copies of a clip re-identify text animators and Puppet meshes and pins', () => {
	it('a text clip with an animator can be split and duplicated', () => {
		const h = new Harness();
		const r = h.ok([
			{ type: 'clip.addText', at: 0, duration: 90, track: 'V1', content: { text: 'split me' }, ref: '$t' },
		]);
		const text = r.refs.$t!;
		h.ok([{ type: 'textAnimator.add', clipId: text, properties: ['position'] }]);
		expect(h.tx([{ type: 'clip.split', at: 30, clipIds: [text] }]).ok).toBe(true);
		expect(checkInvariants(h.doc)).toEqual([]);
		const [left, right] = h.clips('V1') as unknown as {
			animators: { id: string; selectors: { id: string }[] }[];
		}[];
		expect(right!.animators).toHaveLength(1);
		expect(right!.animators[0]!.id).not.toBe(left!.animators[0]!.id);
		expect(right!.animators[0]!.selectors[0]!.id).not.toBe(left!.animators[0]!.selectors[0]!.id);
		expect(h.tx([{ type: 'clip.duplicate', clipIds: [text], at: 200 }]).ok).toBe(true);
		expect(checkInvariants(h.doc)).toEqual([]);
		const all = h.clips('V1').flatMap(ids);
		expect(new Set(all).size).toBe(all.length);
	});

	it('a clip with Puppet pins can be split; the copy’s pins point at the copy’s meshes', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 4, audio: false, width: 640, height: 360 });
		h.ok([
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: 0,
				sourceRange: { in: { flicks: 0 }, out: { flicks: 60 * F } },
			},
		]);
		const clipId = h.clips('V1')[0]!.id;
		const fxId = h.ok([{ type: 'effect.add', target: { clipId }, effectId: 'jasper.puppet', ref: '$fx' }])
			.refs.$fx!;
		h.ok([
			{ type: 'puppet.addPin', effectInstanceId: fxId, position: [0.2, 0.5] },
			{ type: 'puppet.addPin', effectInstanceId: fxId, position: [0.8, 0.5] },
		]);
		expect(h.tx([{ type: 'clip.split', at: 30, clipIds: [clipId] }]).ok).toBe(true);
		expect(checkInvariants(h.doc)).toEqual([]);
		type Pup = { puppet: { meshes: { id: string }[]; pins: { id: string; meshId: string }[] } };
		const [left, right] = h
			.clips('V1')
			.map((c) => (c as unknown as { effects: Pup[] }).effects.find((e) => e.puppet)!.puppet);
		expect(right!.pins).toHaveLength(2);
		expect(right!.meshes[0]!.id).not.toBe(left!.meshes[0]!.id);
		for (const pin of right!.pins) {
			expect(left!.pins.map((p) => p.id)).not.toContain(pin.id);
			expect(right!.meshes.map((x) => x.id)).toContain(pin.meshId);
		}
	});
});
