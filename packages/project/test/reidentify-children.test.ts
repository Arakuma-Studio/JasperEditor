import { describe, expect, it } from 'vitest';
import { type Clip, checkInvariants } from '../src/index.ts';
import { Harness } from './helpers.ts';

type Animated = Clip & { animators?: { id: string; selectors: { id: string }[] }[] };
type Puppeted = Clip & {
	effects: { id: string; puppet?: { meshes: { id: string }[]; pins: { id: string; meshId: string }[] } }[];
};

function animatedTitle() {
	const h = new Harness();
	const r = h.ok([
		{ type: 'clip.addText', at: 0, duration: 60, track: 'V1', content: { text: 'Hi' }, ref: '$t' },
	]);
	const clipId = r.refs.$t!;
	h.ok([{ type: 'textAnimator.applyPreset', clipIds: [clipId], preset: 'fade-in' }]);
	return { h, clipId };
}

describe('fresh ids for the children of copied clips', () => {
	it('splitting and duplicating an animated title gives its animators and selectors new ids', () => {
		const { h, clipId } = animatedTitle();
		const before = h.seq.clips[clipId] as Animated;
		expect(before.animators?.length).toBeGreaterThan(0);
		h.ok([{ type: 'clip.split', clipIds: [clipId], at: 30 }]);
		h.ok([{ type: 'clip.duplicate', clipIds: [clipId], tracks: ['V2'], at: 100 }]);
		const all = Object.values(h.seq.clips) as Animated[];
		expect(all).toHaveLength(3);
		const ids = all.flatMap((c) =>
			(c.animators ?? []).flatMap((a) => [a.id, ...a.selectors.map((s) => s.id)]),
		);
		expect(ids.length).toBeGreaterThan(3);
		expect(new Set(ids).size).toBe(ids.length);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('splitting a clip with Puppet pins gives meshes and pins new ids; pins follow their mesh', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 4, audio: false, width: 640, height: 360 });
		h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 0 }]);
		const clipId = h.clips('V1')[0]!.id;
		h.ok([{ type: 'effect.add', target: { clipId }, effectId: 'jasper.puppet' }]);
		const fxId = (h.seq.clips[clipId] as Puppeted).effects[0]!.id;
		h.ok([{ type: 'puppet.addPin', effectInstanceId: fxId, position: [0.2, 0.5] }]);
		h.ok([{ type: 'puppet.addPin', effectInstanceId: fxId, position: [0.8, 0.5] }]);
		h.ok([{ type: 'clip.split', clipIds: [clipId], at: 30 }]);
		const clips = Object.values(h.seq.clips) as Puppeted[];
		expect(clips).toHaveLength(2);
		const puppets = clips.map((c) => c.effects.find((fx) => fx.puppet)!.puppet!);
		const [a, b] = puppets as [NonNullable<(typeof puppets)[0]>, NonNullable<(typeof puppets)[0]>];
		expect(a.pins).toHaveLength(2);
		for (const p of [...a.pins, ...b.pins]) expect(p.id).toMatch(/^ppn_/);
		expect(new Set([...a.pins, ...b.pins].map((p) => p.id)).size).toBe(4);
		expect(new Set([...a.meshes, ...b.meshes].map((x) => x.id)).size).toBe(a.meshes.length + b.meshes.length);
		for (const pu of puppets)
			for (const pin of pu.pins) expect(pu.meshes.map((x) => x.id)).toContain(pin.meshId);
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});
