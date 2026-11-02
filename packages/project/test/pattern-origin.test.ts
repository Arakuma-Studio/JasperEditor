// Spec 19 TL-121 (TL-035): a razor cut must not change a seeded pattern. `fxSeed` hashed the clip and effect ids, and a
// split gives the right part new ids, so the pattern jumped at the cut; `u_frame` restarted at 0 as well. Both now come
// from the persisted `EffectInstance.patternOrigin`. Regression tests: the split / continuity ones failed before.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type Clip,
	checkInvariants,
	defaultEffectRegistry,
	type EffectInstance,
	type FxFrameContext,
	type FxUniform,
	fxFrameOffset,
	fxOffsetBuiltins,
	fxPatternFrame,
	fxSeed,
	hashString,
	loadProject,
	makeEnvelope,
	PATTERN_ORIGIN_MAX_FRAME,
	readPatternOrigin,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const F = 705_600_000 / 30;
const FX = 'jasper.s.film-damage';
type Visual = Clip & { effects: EffectInstance[] };

function grainedClip() {
	const h = new Harness();
	const m = h.registerVideo({ seconds: 6, audio: false, width: 640, height: 360 });
	h.ok([
		{
			type: 'clip.place',
			source: { mediaId: m },
			at: 0,
			sourceRange: { in: { flicks: 0 }, out: { flicks: 120 * F } },
		},
	]);
	const clipId = h.clips('V1')[0]!.id;
	const fxId = h.ok([{ type: 'effect.add', target: { clipId }, effectId: FX, ref: '$fx' }]).refs.$fx!;
	return { h, clipId, fxId };
}
const parts = (h: Harness) => h.clips('V1') as unknown as Visual[];
const seedOf = (c: Visual) => {
	const fx = c.effects[0]!;
	return fxSeed(c.id, fx.id, undefined, readPatternOrigin(fx.patternOrigin));
};

describe('legacy instances keep their seed (goldens do not move)', () => {
	it('without a patternOrigin the seed is the hash of the clip and effect ids, as before TL-121', () => {
		expect(fxSeed('clp_9', 'fx_3')).toBe(hashString('clp_9\u0000fx_3\u00000') / 4294967296);
		expect(fxSeed('clp_9', 'fx_3', { seed: 4 })).toBe(hashString('clp_9\u0000fx_3\u00004') / 4294967296);
		expect(fxSeed('clp_9', 'fx_3', undefined, null)).toBe(fxSeed('clp_9', 'fx_3'));
		expect(fxFrameOffset(null)).toBe(0);
		expect(fxFrameOffset(undefined)).toBe(0);
	});

	it('an unsplit clip gets no patternOrigin', () => {
		const { h, clipId } = grainedClip();
		const c = h.seq.clips[clipId] as Visual;
		expect(c.effects[0]!.patternOrigin).toBeUndefined();
	});
});

describe('razor cut', () => {
	it('both parts draw the same seed, with new effect ids', () => {
		const { h, clipId } = grainedClip();
		const before = seedOf(parts(h)[0]!);
		expect(h.tx([{ type: 'clip.split', at: 40, clipIds: [clipId] }]).ok).toBe(true);
		const [left, right] = parts(h);
		expect(right!.effects[0]!.id).not.toBe(left!.effects[0]!.id);
		expect(right!.id).not.toBe(left!.id);
		expect(seedOf(left!)).toBe(before);
		expect(seedOf(right!)).toBe(before);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('the right part counts frames on from the cut (u_frame continuity)', () => {
		const { h, clipId } = grainedClip();
		h.ok([{ type: 'clip.split', at: 40, clipIds: [clipId] }]);
		const [left, right] = parts(h);
		expect(left!.effects[0]!.patternOrigin).toBeUndefined();
		expect(right!.effects[0]!.patternOrigin).toMatchObject({ frame: 40 });
		// timeline frame 40 is clip-local frame 0 of the right part and frame 40 of the unsplit clip.
		expect(fxFrameOffset(readPatternOrigin(right!.effects[0]!.patternOrigin)) + 0).toBe(40);
	});

	it('splits again: the offsets add up and the seed never changes', () => {
		const { h, clipId } = grainedClip();
		const before = seedOf(parts(h)[0]!);
		h.ok([{ type: 'clip.split', at: 40, clipIds: [clipId] }]);
		const rightId = parts(h)[1]!.id;
		h.ok([{ type: 'clip.split', at: 100, clipIds: [rightId] }]);
		const [a, b, c] = parts(h);
		expect([a, b, c].map(seedOf)).toEqual([before, before, before]);
		expect(c!.effects[0]!.patternOrigin).toMatchObject({ frame: 100 });
		// splitting the left part again keeps the origin of the first piece.
		h.ok([{ type: 'clip.split', at: 20, clipIds: [a!.id] }]);
		const all = parts(h);
		expect(all.map(seedOf)).toEqual(all.map(() => before));
		expect(all.map((x) => readPatternOrigin(x.effects[0]!.patternOrigin)?.frame ?? 0)).toEqual([
			0, 20, 40, 100,
		]);
	});

	it('survives save and reload', () => {
		const { h, clipId } = grainedClip();
		h.ok([{ type: 'clip.split', at: 40, clipIds: [clipId] }]);
		const envelope = makeEnvelope(h.doc, {
			revision: 1,
			savedAt: '2026-11-02T10:00:00.000Z',
			platform: 'web',
		});
		const loaded = loadProject(JSON.parse(JSON.stringify(envelope)), { ids: h.ids });
		expect(loaded.readOnly).toBe(false);
		const clips = Object.values(loaded.document.sequences[h.seqId]!.clips) as Visual[];
		const right = clips.find((c) => c.start === 40)!;
		expect(right.effects[0]!.patternOrigin).toMatchObject({ frame: 40 });
	});
});

describe('duplicate and paste are identical copies', () => {
	it('a duplicate draws the pattern of the instance it copies', () => {
		const { h, clipId } = grainedClip();
		const before = seedOf(parts(h)[0]!);
		h.ok([{ type: 'clip.duplicate', clipIds: [clipId], at: 300 }]);
		const copies = parts(h);
		expect(copies).toHaveLength(2);
		expect(new Set(copies.map((c) => c.id)).size).toBe(2);
		expect(copies.map(seedOf)).toEqual([before, before]);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('a copy of a right part keeps its offset', () => {
		const { h, clipId } = grainedClip();
		h.ok([{ type: 'clip.split', at: 40, clipIds: [clipId] }]);
		const rightId = parts(h)[1]!.id;
		h.ok([{ type: 'clip.duplicate', clipIds: [rightId], at: 400 }]);
		const copy = parts(h).find((c) => c.start === 400)!;
		expect(copy.effects[0]!.patternOrigin).toMatchObject({ frame: 40 });
	});
});

describe('hooks read the continued frame', () => {
	const spec = defaultEffectRegistry.get(FX)!;
	const params = Object.fromEntries(spec.params.map((p) => [p.name, p.default]));
	const ctx = (over: Partial<FxFrameContext>): FxFrameContext => ({
		width: 1920,
		height: 1080,
		pxScale: 1,
		fps: 30,
		frame: 0,
		duration: 100,
		seed: 0.37,
		progress: 0,
		...over,
	});
	const noise = (c: FxFrameContext) => {
		const u = spec.gpu!.uniforms!(params, c) as Record<string, unknown>;
		return { dust: u.u_dustProb, stains: u.u_stainCount, grain: u.u_grainFrame };
	};

	it('per-frame noise at the right part’s frame k equals the unsplit clip’s frame 40 + k', () => {
		for (const k of [0, 1, 7]) {
			const unsplit = noise(ctx({ frame: 40 + k }));
			const right = noise(ctx({ frame: k, patternFrame: 40 + k }));
			expect(right).toEqual(unsplit);
		}
		// …and without the continued frame it differs: this is the jump the fix removes.
		expect(noise(ctx({ frame: 0 }))).not.toEqual(noise(ctx({ frame: 40 })));
	});

	it('fxPatternFrame falls back to the clip-local frame', () => {
		expect(fxPatternFrame({ frame: 12 })).toBe(12);
		expect(fxPatternFrame({ frame: 12, patternFrame: 52 })).toBe(52);
	});

	it('fxOffsetBuiltins advances u_frame and u_time and nothing else', () => {
		const builtins: FxUniform[] = [
			{ name: 'u_frame', type: 'float', value: [3] },
			{ name: 'u_time', type: 'float', value: [0.1] },
			{ name: 'u_fps', type: 'float', value: [30] },
		];
		expect(fxOffsetBuiltins(builtins, 0)).toBe(builtins);
		const out = fxOffsetBuiltins(builtins, 30);
		expect(out.find((u) => u.name === 'u_frame')!.value).toEqual([33]);
		expect(out.find((u) => u.name === 'u_time')!.value[0]).toBeCloseTo(1.1);
		expect(out.find((u) => u.name === 'u_fps')!.value).toEqual([30]);
		expect(builtins[0]!.value).toEqual([3]);
	});
});

describe('readPatternOrigin is lenient and bounded', () => {
	it('reads good values, ignores damaged ones', () => {
		expect(readPatternOrigin({ clipId: 'a', effectId: 'b', frame: 7 })).toEqual({
			clipId: 'a',
			effectId: 'b',
			frame: 7,
		});
		expect(readPatternOrigin({ clipId: 'a', effectId: 'b' })?.frame).toBe(0);
		expect(readPatternOrigin({ clipId: '', effectId: 'b', frame: 1 })).toBeNull();
		expect(readPatternOrigin({ clipId: 'a', effectId: 3, frame: 1 })).toBeNull();
		expect(readPatternOrigin('x')).toBeNull();
		expect(readPatternOrigin(null)).toBeNull();
		expect(readPatternOrigin({ clipId: 'a', effectId: 'b', frame: Number.NaN })?.frame).toBe(0);
		expect(readPatternOrigin({ clipId: 'a', effectId: 'b', frame: -5 })?.frame).toBe(0);
		expect(readPatternOrigin({ clipId: 'a', effectId: 'b', frame: 1e12 })?.frame).toBe(
			PATTERN_ORIGIN_MAX_FRAME,
		);
	});

	it('never throws and always yields a bounded origin or null (fuzz)', () => {
		fc.assert(
			fc.property(fc.anything(), (v) => {
				const o = readPatternOrigin(v);
				if (o === null) return true;
				return (
					o.clipId !== '' &&
					o.effectId !== '' &&
					Number.isInteger(o.frame) &&
					o.frame >= 0 &&
					o.frame <= PATTERN_ORIGIN_MAX_FRAME
				);
			}),
		);
	});
});
