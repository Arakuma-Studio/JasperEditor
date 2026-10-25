import { describe, expect, it } from 'vitest';
import {
	BUILTIN_EFFECT_PRESETS,
	buildEffectPreset,
	buildPresetBundle,
	builtinEffectPreset,
	type Clip,
	checkInvariants,
	contentTimeOfOffset,
	defaultRegistries,
	type EffectPreset,
	flicksPerFrame,
	mapPresetOffset,
	parseEffectPreset,
	parsePresetFile,
	presetMatches,
	presetOffsetOf,
	presetSummary,
	RATES,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const F30 = flicksPerFrame(RATES.r30);
const F25 = flicksPerFrame({ num: 25, den: 1 });
const src30 = (duration: number) => ({ duration, rate: RATES.r30 });
type Solid = Extract<Clip, { kind: 'solid' }>;
const roundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const ok = (h: Harness) =>
	expect(checkInvariants(h.doc, { effects: defaultRegistries().effects })).toEqual([]);
/** Clip-local frame of each key of an Animatable on a forward clip. */
const frames = (c: Clip, a: { keyframes: { time: number }[] }, F = F30) =>
	a.keyframes.map((k) => (k.time - c.sourceIn) / (F * c.speed.rate));

describe('preset key time mapping (FX-030)', () => {
	it('Anchor to In keeps offsets, Anchor to Out keeps distance to the last frame, Scale stretches', () => {
		const o = 10 * F30;
		expect(mapPresetOffset('anchor-in', o, src30(30), src30(90))).toBe(o);
		// Source last frame = 29: 19 frames before it → target last frame 89 − 19 = 70.
		expect(mapPresetOffset('anchor-out', o, src30(30), src30(90)) / F30).toBe(70);
		// Scale maps first→first and last→last: 10/29 of the way → 10 × 89 / 29.
		expect(mapPresetOffset('scale', o, src30(30), src30(90)) / F30).toBeCloseTo((10 * 89) / 29, 9);
		expect(mapPresetOffset('scale', 29 * F30, src30(30), src30(90)) / F30).toBeCloseTo(89, 9);
		expect(mapPresetOffset('scale', 0, src30(30), src30(90))).toBe(0);
		// A one-frame source has no span to scale: offsets stay.
		expect(mapPresetOffset('scale', o, src30(1), src30(90))).toBe(o);
	});

	it('offsets are frame-rate independent and snap onto the target frame grid', () => {
		// 1 s at 30 fps onto 25 fps: still 1 s (25 frames).
		const off = 30 * F30;
		const timing = { start: 0, duration: 100, sourceIn: 0, speed: { rate: 1, reverse: false } };
		expect(contentTimeOfOffset(off, timing, { num: 25, den: 1 })).toBe(25 * F25);
		expect(contentTimeOfOffset(10.4 * F25, timing, { num: 25, den: 1 })).toBe(10 * F25);
		// Anchor to Out from 30 fps to 25 fps: 1 s before the last frame.
		const mapped = mapPresetOffset('anchor-out', 119 * F30, src30(150), {
			duration: 100,
			rate: { num: 25, den: 1 },
		});
		expect(mapped / F25).toBeCloseTo(99 - 25, 9);
	});

	it('content time ↔ offset round-trips through in point, speed and reverse', () => {
		const rate = RATES.r30;
		for (const speed of [
			{ rate: 1, reverse: false },
			{ rate: 2, reverse: false },
			{ rate: 0.5, reverse: true },
		]) {
			const clip = { start: 40, duration: 60, sourceIn: 15 * F30, speed };
			for (const f of [0, 7, 59]) {
				const content = contentTimeOfOffset(f * F30, clip, rate);
				expect(presetOffsetOf(content, clip, rate)).toBe(f * F30);
			}
		}
		// Reverse: the first frame shows the end of the source range.
		const rev = { start: 0, duration: 10, sourceIn: 0, speed: { rate: 1, reverse: true } };
		expect(contentTimeOfOffset(0, rev, rate)).toBe(9 * F30);
		expect(contentTimeOfOffset(-5 * F30, { ...rev, speed: { rate: 1, reverse: false } }, rate)).toBe(0);
	});
});

/** Source clip A (30 frames): opacity keys at 5 and 25, blurred with keys at 0 and 29, a crop; B 90 f, C 15 f. */
function project() {
	const h = new Harness();
	const r = h.ok([
		{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1], ref: '$a' },
		{ type: 'clip.addSolid', at: 100, duration: 90, track: 'V1', color: [0, 1, 0, 1], ref: '$b' },
		{ type: 'clip.addSolid', at: 300, duration: 15, track: 'V1', color: [0, 0, 1, 1], ref: '$c' },
		{ type: 'keyframe.add', target: ['clip', '$a', 'opacity'], at: { frames: 5 }, value: 0 },
		{ type: 'keyframe.add', target: ['clip', '$a', 'opacity'], at: { frames: 25 }, value: 80 },
		{ type: 'clip.update', clipId: '$a', patch: { blendMode: 'screen' } },
		{ type: 'param.set', target: ['clip', '$a', 'transform', 'rotation'], value: 45 },
		{
			type: 'effect.add',
			target: { clipId: '$a' },
			effectId: 'jasper.crop',
			params: { left: 10 },
			ref: '$crop',
		},
		{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.gaussian-blur', ref: '$blur' },
		{ type: 'keyframe.add', target: ['effect', '$blur', 'radius'], at: { frames: 0 }, value: 40 },
		{ type: 'keyframe.add', target: ['effect', '$blur', 'radius'], at: { frames: 29 }, value: 0 },
		{ type: 'effect.add', target: { clipId: '$c' }, effectId: 'jasper.black-white' },
	]);
	return { h, a: r.refs.$a!, b: r.refs.$b!, c: r.refs.$c!, blur: r.refs.$blur!, crop: r.refs.$crop! };
}

function save(
	h: Harness,
	clipId: string,
	type: EffectPreset['type'],
	sections: Parameters<typeof buildEffectPreset>[2]['sections'],
) {
	const p = buildEffectPreset(h.doc, clipId, { name: 'My Preset', type, sections, id: 'fxp_TEST' });
	const parsed = parseEffectPreset(roundTrip(p));
	if (!parsed.ok) throw new Error(parsed.message);
	return parsed.preset;
}

describe('Save Preset (buildEffectPreset)', () => {
	it('stores offsets from the first frame, the chosen intrinsics and effects in stack order', () => {
		const { h, a, blur } = project();
		const p = save(h, a, 'anchor-in', { opacity: true, crop: true, effectIds: [blur] });
		expect(p.source).toMatchObject({ duration: 30, frameRate: { num: 30, den: 1 }, frame: { width: 1920 } });
		expect(p.intrinsic?.opacity?.keyframes?.map((k) => k.time / F30)).toEqual([5, 25]);
		expect(p.intrinsic?.blendMode).toBe('screen');
		expect(p.intrinsic?.crop?.params.left?.value).toBe(10);
		expect(p.intrinsic?.motion).toBeUndefined();
		expect(p.effects?.map((e) => e.effectId)).toEqual(['jasper.gaussian-blur']);
		expect(p.effects?.[0]?.params.radius?.keyframes?.map((k) => k.time / F30)).toEqual([0, 29]);
	});

	it('crop-order: a crop after other effects is saved as an ordinary effect and re-applied at its place', () => {
		const h = new Harness();
		const r = h.ok([
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1], ref: '$a' },
			{ type: 'clip.addSolid', at: 100, duration: 30, track: 'V1', color: [0, 1, 0, 1], ref: '$b' },
			{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.flip-horizontal', ref: '$f' },
			{
				type: 'effect.add',
				target: { clipId: '$a' },
				effectId: 'jasper.crop',
				params: { left: 30 },
				ref: '$c',
			},
		]);
		const { $a: a, $b: b, $f: f, $c: c } = r.refs as Record<string, string>;
		const p = save(h, a!, 'scale', { crop: true, effectIds: [f!, c!] });
		// No crop at the top of the stack: the pinned Crop is the defaults; the listed crop keeps its place.
		expect(p.intrinsic?.crop?.params.left?.value).toBe(0);
		expect(p.effects?.map((e) => e.effectId)).toEqual(['jasper.flip-horizontal', 'jasper.crop']);
		h.ok([{ type: 'effect.applyPreset', preset: p, clipIds: [b!] }]);
		const B = h.seq.clips[b!] as Solid;
		// Pinned (defaults) crop first, then Flip → Crop as in the source.
		expect(B.effects.map((e) => e.effectId)).toEqual([
			'jasper.crop',
			'jasper.flip-horizontal',
			'jasper.crop',
		]);
		expect(B.effects[2]!.params.left!.value).toBe(30);
		ok(h);
	});

	it('refuses an empty selection and unknown instance ids', () => {
		const { h, a } = project();
		expect(() => buildEffectPreset(h.doc, a, { name: 'x', type: 'scale', sections: {} })).toThrow(
			/at least one/,
		);
		expect(() =>
			buildEffectPreset(h.doc, a, { name: 'x', type: 'scale', sections: { effectIds: ['fx_nope'] } }),
		).toThrow(/no effect instance/);
	});
});

describe('effect.applyPreset', () => {
	it('Anchor to In / Anchor to Out / Scale map key times onto clips of other durations', () => {
		const { h, a, b } = project();
		const B = () => h.seq.clips[b] as Solid;
		h.ok([{ type: 'effect.applyPreset', preset: save(h, a, 'anchor-in', { opacity: true }), clipIds: [b] }]);
		expect(frames(B(), B().opacity)).toEqual([5, 25]);
		h.ok([{ type: 'effect.applyPreset', preset: save(h, a, 'anchor-out', { opacity: true }), clipIds: [b] }]);
		// 24 and 4 frames before the source's last frame (29) → 89 − 24, 89 − 4.
		expect(frames(B(), B().opacity)).toEqual([65, 85]);
		h.ok([{ type: 'effect.applyPreset', preset: save(h, a, 'scale', { opacity: true }), clipIds: [b] }]);
		expect(frames(B(), B().opacity)).toEqual([Math.round((5 * 89) / 29), Math.round((25 * 89) / 29)]);
		expect(B().opacity.keyframes.map((k) => k.value)).toEqual([0, 80]);
		ok(h);
	});

	it('overwrites intrinsics, appends effects with new ids, one transaction for N clips', () => {
		const { h, a, b, c, blur, crop } = project();
		const preset = save(h, a, 'anchor-in', { motion: true, opacity: true, crop: true, effectIds: [blur] });
		const before = h.revision;
		const r = h.ok([{ type: 'effect.applyPreset', preset, clipIds: [b, c] }]);
		expect(h.revision).toBe(before + 1);
		const res = r.results[0] as { clipIds: string[]; effectInstanceIds: Record<string, string[]> };
		expect(res.clipIds).toEqual([b, c]);
		const A = h.seq.clips[a] as Solid;
		const C = h.seq.clips[c] as Solid;
		expect(C.transform.rotation.value).toBe(45);
		expect(C.blendMode).toBe('screen');
		// Crop pinned at index 0, the existing Black & White kept, the blur appended with a new id.
		expect(C.effects.map((e) => e.effectId)).toEqual([
			'jasper.crop',
			'jasper.black-white',
			'jasper.gaussian-blur',
		]);
		expect(C.effects[2]!.id).not.toBe(blur);
		expect(C.effects[0]!.id).not.toBe(crop);
		expect(res.effectInstanceIds[c]).toEqual([C.effects[2]!.id]);
		// Anchor to In on a 15-frame clip: blur keys at 0 and 29 stay at 0 and 29 (off-clip keys are kept).
		expect(frames(C, C.effects[2]!.params.radius!)).toEqual([0, 29]);
		const ids = new Set([...A.opacity.keyframes, ...A.effects[1]!.params.radius!.keyframes].map((k) => k.id));
		for (const k of [...C.opacity.keyframes, ...C.effects[2]!.params.radius!.keyframes])
			expect(ids.has(k.id)).toBe(false);
		// Applying again overwrites the pinned crop instead of adding a second one, and appends another blur.
		h.ok([{ type: 'effect.applyPreset', preset, clipIds: [c] }]);
		const C2 = h.seq.clips[c] as Solid;
		expect(C2.effects.filter((e) => e.effectId === 'jasper.crop')).toHaveLength(1);
		expect(C2.effects.filter((e) => e.effectId === 'jasper.gaussian-blur')).toHaveLength(2);
		ok(h);
	});

	it('inserts at `index` and validates / clamps values like effect.add', () => {
		const { h, c } = project();
		const preset = roundTrip(builtinEffectPreset('builtin.blur-in')!) as EffectPreset;
		preset.effects![0]!.params.radius!.value = 99_999; // over the max (500): clamped
		const r = h.ok([{ type: 'effect.applyPreset', preset, clipIds: [c], index: 0 }]);
		const C = h.seq.clips[c] as Solid;
		expect(C.effects.map((e) => e.effectId)).toEqual(['jasper.gaussian-blur', 'jasper.black-white']);
		expect(C.effects[0]!.params.radius!.value).toBeLessThanOrEqual(500);
		expect(r.warnings.some((w) => w.code === 'W_VALUE_CLAMPED')).toBe(true);
		ok(h);
	});

	it('skips unknown effects with a warning and fails when nothing applies', () => {
		const { h, c } = project();
		const preset = roundTrip(builtinEffectPreset('builtin.fade-in')!) as EffectPreset;
		preset.effects = [{ effectId: 'acme.future-glow', params: { amount: { value: 3 } } }];
		const r = h.ok([{ type: 'effect.applyPreset', preset, clipIds: [c] }]);
		expect(r.warnings.map((w) => w.code)).toContain('W_PRESET_UNKNOWN_EFFECT');
		expect((h.seq.clips[c] as Solid).effects.some((e) => e.effectId === 'acme.future-glow')).toBe(false);
		delete preset.intrinsic;
		const bad = h.tx([{ type: 'effect.applyPreset', preset, clipIds: [c] }]);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.errors[0]!.code).toBe('E_INVALID_PARAM');
	});

	it('never treats preset data as temp refs or addressed entities', () => {
		const { h, c } = project();
		const preset = roundTrip(builtinEffectPreset('builtin.blur-in')!) as EffectPreset;
		preset.effects![0]!.id = '$blur';
		preset.folderId = '$selection';
		const r = h.tx([{ type: 'effect.applyPreset', preset, clipIds: [c] }], { origin: { agent: 'test' } });
		expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
	});

	it('rejects invalid presets', () => {
		const { h, c } = project();
		for (const [preset, code] of [
			[{ format: 'nope' }, 'E_SCHEMA'],
			[{ ...builtinEffectPreset('builtin.fade-in')!, version: 2 }, 'E_SCHEMA'],
			[{ ...builtinEffectPreset('builtin.fade-in')!, type: 'sideways' }, 'E_SCHEMA'],
			[{ ...builtinEffectPreset('builtin.fade-in')!, intrinsic: undefined }, 'E_INVALID_PARAM'],
		] as const) {
			const r = h.tx([{ type: 'effect.applyPreset', preset: roundTrip(preset), clipIds: [c] }]);
			expect(r).toMatchObject({ ok: false, errors: [{ code }] });
		}
	});
});

describe('preset format', () => {
	it('keeps unknown fields and unknown effect ids, and flags them in the summary', () => {
		const raw = {
			...roundTrip(builtinEffectPreset('builtin.blur-in')!),
			futureField: { x: 1 },
			effects: [{ effectId: 'acme.glow', params: { amount: { value: 2 } } }],
		};
		const r = parseEffectPreset(raw);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect((r.preset as unknown as { futureField: unknown }).futureField).toEqual({ x: 1 });
		const s = presetSummary(r.preset, defaultRegistries().effects);
		expect(s.unknownEffects).toEqual(['acme.glow']);
		expect(s.realtime).toBe(false);
		expect(s.native).toBe(false);
	});

	it('summaries drive search and badge filters', () => {
		const reg = defaultRegistries().effects;
		const blur = presetSummary(builtinEffectPreset('builtin.blur-in')!, reg);
		const fade = presetSummary(builtinEffectPreset('builtin.fade-in')!, reg);
		expect(blur.realtime && blur.native).toBe(true);
		expect(presetMatches(blur, 'gaussian')).toBe(true);
		expect(presetMatches(blur, 'blur in')).toBe(true);
		expect(presetMatches(fade, 'blur')).toBe(false);
	});

	it('bundles export presets with the bins they use, and imports read every file shape', () => {
		const p = {
			...roundTrip(builtinEffectPreset('builtin.fade-in')!),
			id: 'fxp_A',
			folderId: 'b2',
			builtIn: undefined,
		};
		const folders = [
			{ id: 'b1', name: 'Mine', parentId: null },
			{ id: 'b2', name: 'Fades', parentId: 'b1' },
			{ id: 'b3', name: 'Unused', parentId: null },
		];
		const bundle = buildPresetBundle([p as EffectPreset], folders, '2026-10-05T00:00:00.000Z');
		expect(bundle.folders?.map((f) => f.id).sort()).toEqual(['b1', 'b2']);
		expect(parsePresetFile(roundTrip(bundle))).toMatchObject({ ok: true, presets: [{ id: 'fxp_A' }] });
		expect(parsePresetFile(p)).toMatchObject({ ok: true, presets: [p] });
		expect(parsePresetFile([p, p])).toMatchObject({ ok: true });
		expect(parsePresetFile({ format: 'other' }).ok).toBe(false);
	});
});

describe('built-in presets', () => {
	it('all validate and apply to a video clip', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 10 });
		const placed = h.ok([
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: 0,
				tracks: { video: 'V1' },
				sourceRange: { in: { seconds: 1 }, out: { seconds: 4 } },
			},
		]);
		const v = (placed.results[0] as { clipIds: string[] }).clipIds[0]!;
		expect(new Set(BUILTIN_EFFECT_PRESETS.map((p) => p.id)).size).toBe(BUILTIN_EFFECT_PRESETS.length);
		for (const p of BUILTIN_EFFECT_PRESETS) {
			expect(parseEffectPreset(roundTrip(p)).ok).toBe(true);
			expect(p.builtIn).toBe(true);
			const r = h.tx([{ type: 'effect.applyPreset', preset: roundTrip(p), clipIds: [v] }]);
			expect(r.ok, `${p.id}: ${JSON.stringify(!r.ok && r.errors)}`).toBe(true);
		}
		ok(h);
	});

	it('Fade Out ends transparent on the last frame; relative PiP fits a 4K sequence and 4K media', () => {
		const h = new Harness({ preset: 'uhd-2160p-30' });
		const m = h.registerVideo({ seconds: 10, width: 3840, height: 2160 });
		const placed = h.ok([
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: 0,
				tracks: { video: 'V1' },
				sourceRange: { in: { seconds: 0 }, out: { seconds: 3 } },
			},
		]);
		const v = (placed.results[0] as { clipIds: string[] }).clipIds[0]!;
		h.ok([{ type: 'effect.applyPreset', preset: builtinEffectPreset('builtin.fade-out'), clipIds: [v] }]);
		const clip = () => h.seq.clips[v] as Extract<Clip, { kind: 'video' }>;
		expect(frames(clip(), clip().opacity)).toEqual([89 - 30, 89]);
		expect(clip().opacity.keyframes.map((k) => k.value)).toEqual([100, 0]);
		h.ok([{ type: 'effect.applyPreset', preset: builtinEffectPreset('builtin.pip-25-lr'), clipIds: [v] }]);
		const t = clip().transform;
		expect(t.scale.value).toBeCloseTo(25, 6);
		expect(t.position.value[0]).toBeCloseTo(3840 - 3840 * 0.05 - (3840 * 0.25) / 2, 6);
		expect(t.position.value[1]).toBeCloseTo(2160 - 2160 * 0.05 - (2160 * 0.25) / 2, 6);
		ok(h);
	});
});
