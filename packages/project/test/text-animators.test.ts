// Text animators in the model (workstream text-animators): commands, property keys through param.set and the
// keyframe commands, presets, conversion of In/Out text animations, Path / More Options, per-character 3D, Source
// Text keys, invariants / repair, snapshot and evaluation.
import { describe, expect, it } from 'vitest';
import {
	ANIMATOR_MENU_IDS,
	buildRenderSnapshot,
	type Clip,
	charTransforms,
	checkInvariants,
	clipLayerId,
	clipPropertiesJsonSchema,
	createCounterIdSource,
	defaultEffectRegistry,
	FLICKS_PER_SECOND,
	propertiesForClip,
	repairDocument,
	resolvePropertySpec,
	TEXT_ANIMATION_SPECS,
	TEXT_ANIMATOR_PRESETS,
	type TextAnimatorGroup,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

type TextClip = Extract<Clip, { kind: 'text' }>;

function withText(h: Harness, text = 'Hello brave world', duration = 150): string {
	const r = h.ok([{ type: 'clip.addText', at: 0, duration, track: 'V1', content: { text }, ref: '$t' }]);
	return r.refs.$t!;
}
const clipOf = (h: Harness, id: string) => h.seq.clips[id] as TextClip;
const err = (r: ReturnType<Harness['tx']>) => (r.ok ? null : r.errors[0]!);
const invariantsOk = (h: Harness) =>
	expect(
		checkInvariants(h.doc, { effects: defaultEffectRegistry }).filter((i) => i.invariant !== 'INV-014'),
	).toEqual([]);

describe('textAnimator.add / properties / selectors', () => {
	it('adds an animator with AE companions and a Range Selector, addressable by ref in the same transaction', () => {
		const h = new Harness();
		const id = withText(h);
		const r = h.ok([
			{
				type: 'textAnimator.add',
				clipId: id,
				properties: ['position', 'skew', 'tracking', 'characterOffset'],
				ref: '$a',
			},
			{
				type: 'param.set',
				target: ['clip', id, 'textAnimators', '$a', 'properties', 'position'],
				value: [0, 40],
			},
		]);
		const a = clipOf(h, id).animators![0]!;
		expect(r.refs.$a).toBe(a.id);
		expect(a.name).toBe('Animator 1');
		expect(Object.keys(a.properties).sort()).toEqual(
			[
				'characterAlignment',
				'characterOffset',
				'characterRange',
				'position',
				'skew',
				'skewAxis',
				'tracking',
				'trackingType',
			].sort(),
		);
		expect(a.properties.position!.value).toEqual([0, 40]);
		expect(a.selectors).toHaveLength(1);
		expect(a.selectors[0]!.kind).toBe('range');
		expect(a.id.startsWith('tan_')).toBe(true);
		expect(a.selectors[0]!.id.startsWith('tsl_')).toBe(true);
		invariantsOk(h);
	});
	it('rejects unknown entries and non-text clips', () => {
		const h = new Harness();
		const id = withText(h);
		expect(err(h.tx([{ type: 'textAnimator.add', clipId: id, properties: ['wobble'] }]))?.code).toBe(
			'E_INVALID_PARAM',
		);
		const s = h.ok([
			{ type: 'clip.addSolid', at: 200, duration: 30, track: 'V1', color: [1, 0, 0, 1], ref: '$s' },
		]).refs.$s!;
		expect(err(h.tx([{ type: 'textAnimator.add', clipId: s, properties: ['opacity'] }]))?.code).toBe(
			'E_INVALID_PARAM',
		);
	});
	it('every menu entry adds properties; per-character 3D adds Z and X/Y rotation companions', () => {
		const h = new Harness();
		const id = withText(h);
		h.ok([{ type: 'textAnimator.add', clipId: id, properties: [...ANIMATOR_MENU_IDS] }]);
		const props = Object.keys(clipOf(h, id).animators![0]!.properties);
		expect(props).not.toContain('positionZ');
		expect(props.length).toBeGreaterThan(25);
		h.ok([{ type: 'text.setPerCharacter3d', clipIds: [id], enabled: true }]);
		const p3 = Object.keys(clipOf(h, id).animators![0]!.properties);
		for (const k of ['positionZ', 'anchorZ', 'scaleZ', 'rotationX', 'rotationY']) expect(p3).toContain(k);
		expect(clipOf(h, id).perCharacter3d).toBe(true);
		invariantsOk(h);
	});
	it('selectors: add / update / reorder / remove; static fields via param.set; values clamp', () => {
		const h = new Harness();
		const id = withText(h);
		const aid = h.ok([{ type: 'textAnimator.add', clipId: id, properties: ['opacity'], ref: '$a' }]).refs.$a!;
		const sid = h.ok([{ type: 'textSelector.add', clipId: id, animatorId: aid, kind: 'wiggly', ref: '$w' }])
			.refs.$w!;
		const a = () => clipOf(h, id).animators![0]!;
		expect(a().selectors.map((s) => s.name)).toEqual(['Range Selector 1', 'Wiggly Selector 1']);
		const w = a().selectors[1]!;
		expect(w.kind === 'wiggly' && w.mode).toBe('intersect');
		const range = a().selectors[0]!.id;
		h.ok([
			{
				type: 'param.set',
				target: ['clip', id, 'textAnimators', aid, 'selectors', range, 'basedOn'],
				value: 'words',
			},
			{
				type: 'param.set',
				target: ['clip', id, 'textAnimators', aid, 'selectors', range, 'shape'],
				value: 'rampUp',
			},
			{
				type: 'param.set',
				target: ['clip', id, 'textAnimators', aid, 'selectors', range, 'randomize'],
				value: true,
			},
		]);
		const sel = a().selectors[0]!;
		expect(sel.kind === 'range' && [sel.basedOn, sel.shape, sel.randomize]).toEqual([
			'words',
			'rampUp',
			true,
		]);
		expect(
			err(
				h.tx([
					{
						type: 'param.set',
						target: ['clip', id, 'textAnimators', aid, 'selectors', range, 'mode'],
						value: 'blend',
					},
				]),
			)?.code,
		).toBe('E_INVALID_PARAM');
		const r = h.ok([
			{
				type: 'param.set',
				target: ['clip', id, 'textAnimators', aid, 'selectors', range, 'amount'],
				value: 250,
			},
		]);
		expect(r.warnings.map((w) => w.code)).toContain('W_VALUE_CLAMPED');
		h.ok([
			{
				type: 'textSelector.update',
				clipId: id,
				animatorId: aid,
				selectorId: sid,
				index: 0,
				name: 'Jitter',
				enabled: false,
			},
		]);
		expect(a().selectors.map((s) => [s.name, s.enabled])).toEqual([
			['Jitter', false],
			['Range Selector 1', true],
		]);
		h.ok([{ type: 'textSelector.remove', clipId: id, animatorId: aid, selectorIds: [sid] }]);
		expect(a().selectors).toHaveLength(1);
		invariantsOk(h);
	});
	it('keyframes on animator properties and selector fields work with the generic keyframe commands', () => {
		const h = new Harness();
		const id = withText(h);
		const aid = h.ok([{ type: 'textAnimator.add', clipId: id, properties: ['opacity'], ref: '$a' }]).refs.$a!;
		const sid = clipOf(h, id).animators![0]!.selectors[0]!.id;
		const start = ['clip', id, 'textAnimators', aid, 'selectors', sid, 'start'];
		h.ok([
			{ type: 'param.setAnimated', target: start, animated: true, at: { frames: 0 } },
			{ type: 'param.set', target: start, value: 100, at: { frames: 60 } },
		]);
		const keys = () => {
			const s = clipOf(h, id).animators![0]!.selectors[0]!;
			return s.kind === 'range' ? s.start.keyframes : [];
		};
		expect(keys().map((k) => k.value)).toEqual([0, 100]);
		h.ok([{ type: 'keyframe.move', keyframeIds: [keys()[1]!.id], delta: { frames: 30 } }]);
		expect(keys()[1]!.time).toBe(90 * (FLICKS_PER_SECOND / 30));
		h.ok([
			{ type: 'keyframe.setInterpolation', keyframeIds: keys().map((k) => k.id), interpolation: 'bezier' },
		]);
		h.ok([{ type: 'keyframe.remove', keyframeIds: [keys()[0]!.id] }]);
		expect(keys()).toHaveLength(1);
		invariantsOk(h);
	});
	it('update, duplicate (fresh ids), remove property and animator', () => {
		const h = new Harness();
		const id = withText(h);
		const aid = h.ok([
			{ type: 'textAnimator.add', clipId: id, properties: ['opacity', 'rotation'], ref: '$a' },
		]).refs.$a!;
		h.ok([
			{
				type: 'param.setAnimated',
				target: ['clip', id, 'textAnimators', aid, 'properties', 'opacity'],
				animated: true,
			},
		]);
		const dup = h.ok([{ type: 'textAnimator.duplicate', clipId: id, animatorId: aid, ref: '$d' }]).refs.$d!;
		const [a, d] = clipOf(h, id).animators!;
		expect(d!.id).toBe(dup);
		expect(d!.name).toBe('Animator 1 copy');
		expect(d!.selectors[0]!.id).not.toBe(a!.selectors[0]!.id);
		expect(d!.properties.opacity!.keyframes[0]!.id).not.toBe(a!.properties.opacity!.keyframes[0]!.id);
		h.ok([{ type: 'textAnimator.update', clipId: id, animatorId: dup, index: 0, enabled: false, name: 'B' }]);
		expect(clipOf(h, id).animators!.map((x) => [x.name, x.enabled])).toEqual([
			['B', false],
			['Animator 1', true],
		]);
		h.ok([{ type: 'textAnimator.removeProperty', clipId: id, animatorId: aid, properties: ['rotation'] }]);
		expect(clipOf(h, id).animators![1]!.properties.rotation).toBeUndefined();
		h.ok([{ type: 'textAnimator.remove', clipId: id, animatorIds: [aid, dup] }]);
		expect(clipOf(h, id).animators).toBeUndefined();
		invariantsOk(h);
	});
	it('variable font axes', () => {
		const h = new Harness();
		const id = withText(h);
		const aid = h.ok([{ type: 'textAnimator.add', clipId: id, axes: ['wght'], ref: '$a' }]).refs.$a!;
		h.ok([
			{
				type: 'param.set',
				target: ['clip', id, 'textAnimators', aid, 'properties', 'axes', 'wght'],
				value: 300,
			},
		]);
		expect(clipOf(h, id).animators![0]!.properties.axes!.wght!.value).toBe(300);
		h.ok([{ type: 'textAnimator.removeProperty', clipId: id, animatorId: aid, properties: ['axes.wght'] }]);
		expect(clipOf(h, id).animators![0]!.properties.axes).toBeUndefined();
	});
	it('the property registry exposes every animator key for the clip', () => {
		const h = new Harness();
		const id = withText(h);
		const aid = h.ok([
			{ type: 'textAnimator.add', clipId: id, properties: ['position', 'fillColor'], ref: '$a' },
		]).refs.$a!;
		const clip = clipOf(h, id);
		const keys = propertiesForClip(clip).map((s) => s.key);
		expect(keys).toContain(`textAnimators.${aid}.properties.position`);
		expect(keys).toContain(`textAnimators.${aid}.selectors.${clip.animators![0]!.selectors[0]!.id}.easeHigh`);
		expect(keys).toContain('textMore.anchorPointGrouping');
		expect(keys).toContain('text.sourceText');
		expect(
			resolvePropertySpec(`textAnimators.${aid}.properties.position`, undefined, undefined, clip)?.spatial,
		).toBe('linear');
		expect(
			resolvePropertySpec(`textAnimators.${aid}.properties.blur`, undefined, undefined, clip),
		).toBeUndefined();
		const schema = clipPropertiesJsonSchema(clip) as { properties: Record<string, unknown> };
		expect(Object.keys(schema.properties)).toContain(`textAnimators.${aid}.properties.fillColor`);
	});
});

describe('presets', () => {
	it('every preset applies cleanly; Out presets end on the clip end, loops cover the clip', () => {
		for (const p of TEXT_ANIMATOR_PRESETS) {
			const h = new Harness();
			const id = withText(h, 'Hello brave\nnew world', 300);
			const r = h.ok([{ type: 'textAnimator.applyPreset', clipIds: [id], preset: p.id }]);
			const groups = clipOf(h, id).animators!;
			expect((r.results[0] as { animatorIds: Record<string, string[]> }).animatorIds[id]).toEqual(
				groups.map((g) => g.id),
			);
			expect(groups.length).toBe(p.animators.length);
			if (p.perCharacter3d) expect(clipOf(h, id).perCharacter3d).toBe(true);
			const times = groups.flatMap((g) =>
				(JSON.stringify(g).match(/"time":-?\d+/g) ?? []).map((m) => Number(m.slice(7))),
			);
			const F = FLICKS_PER_SECOND / 30;
			if (p.phase === 'out' && times.length) expect(Math.max(...times)).toBe(299 * F);
			if (p.phase === 'in' && times.length) expect(Math.min(...times)).toBe(0);
			if (p.phase === 'loop' && times.length) expect(Math.max(...times)).toBeGreaterThan(250 * F);
			invariantsOk(h);
		}
	});
	it('durationFrames scales the keys; replace drops existing animators; unknown preset fails', () => {
		const h = new Harness();
		const id = withText(h);
		h.ok([{ type: 'textAnimator.applyPreset', clipIds: [id], preset: 'typewriter', durationFrames: 30 }]);
		const s = clipOf(h, id).animators![0]!.selectors[0]!;
		expect(s.kind === 'range' && s.start.keyframes.map((k) => k.time)).toEqual([
			0,
			30 * (FLICKS_PER_SECOND / 30),
		]);
		h.ok([{ type: 'textAnimator.applyPreset', clipIds: [id], preset: 'Fade In', replace: true }]);
		expect(clipOf(h, id).animators!.map((a) => a.name)).toEqual(['Fade']);
		expect(err(h.tx([{ type: 'textAnimator.applyPreset', clipIds: [id], preset: 'nope' }]))?.code).toBe(
			'E_UNKNOWN_EFFECT',
		);
	});
	it('works on reversed clips (keys sorted, in range)', () => {
		const h = new Harness();
		const id = withText(h);
		h.ok([{ type: 'clip.setSpeed', clipIds: [id], reverse: true, ripple: false }]);
		h.ok([{ type: 'textAnimator.applyPreset', clipIds: [id], preset: 'fade-up-characters' }]);
		invariantsOk(h);
	});
	it('every shipped In/Out preset converts to animators (textAnimator.convertLegacy)', () => {
		const ids = [...new Set(TEXT_ANIMATION_SPECS.map((s) => s.id))];
		for (const preset of ids) {
			const h = new Harness();
			const id = withText(h);
			h.ok([
				{
					type: 'clip.update',
					clipIds: [id],
					patch: {
						textAnimation: {
							in: { preset },
							out: { preset, params: preset === 'typewriter' ? {} : { unit: 'word' } },
						},
					},
				},
			]);
			const r = h.ok([{ type: 'textAnimator.convertLegacy', clipIds: [id] }]);
			const c = clipOf(h, id);
			expect(c.textAnimation).toBeUndefined();
			expect(
				(r.results[0] as { animatorIds: Record<string, string[]> }).animatorIds[id]!.length,
			).toBeGreaterThanOrEqual(2);
			invariantsOk(h);
		}
	});
});

describe('Path Options, More Options, Source Text', () => {
	const path = {
		closed: false,
		vertices: [
			{ p: [0, 0.5], in: [0, 0], out: [0.25, -0.5] },
			{ p: [1, 0.5], in: [-0.25, -0.5], out: [0, 0] },
		],
	};
	it('text.setPathOptions on a mask; margins keyframable; mask removal resets to Path: None', () => {
		const h = new Harness();
		const id = withText(h);
		const mask = h.ok([{ type: 'mask.add', clipId: id, shape: 'bezier', path, mode: 'none', ref: '$m' }]).refs
			.$m!;
		h.ok([{ type: 'text.setPathOptions', clipIds: [id], maskId: mask, firstMargin: 12 }]);
		expect(clipOf(h, id).pathOptions!.firstMargin.value).toBe(12);
		expect(clipOf(h, id).pathOptions!.perpendicularToPath).toBe(true);
		h.ok([
			{ type: 'param.setAnimated', target: ['clip', id, 'textPath', 'lastMargin'], animated: true },
			{ type: 'param.set', target: ['clip', id, 'textPath', 'reversePath'], value: true },
		]);
		expect(clipOf(h, id).pathOptions!.lastMargin.keyframes).toHaveLength(1);
		expect(clipOf(h, id).pathOptions!.reversePath).toBe(true);
		expect(
			err(h.tx([{ type: 'text.setPathOptions', clipIds: [id], maskId: 'msk_0000000000000ZZZ' }]))?.code,
		).toBe('E_NOT_FOUND');
		invariantsOk(h);
		h.ok([{ type: 'mask.remove', maskIds: [mask] }]);
		expect(clipOf(h, id).pathOptions).toBeUndefined();
		h.ok([
			{ type: 'mask.add', clipId: id, shape: 'bezier', path, mode: 'none', ref: '$m2' },
			{ type: 'text.setPathOptions', clipIds: [id], maskId: '$m2' },
		]);
		h.ok([{ type: 'text.setPathOptions', clipIds: [id], maskId: null }]);
		expect(clipOf(h, id).pathOptions).toBeUndefined();
		invariantsOk(h);
	});
	it('More Options are created on first write', () => {
		const h = new Harness();
		const id = withText(h);
		h.ok([{ type: 'param.set', target: ['clip', id, 'textMore', 'anchorPointGrouping'], value: 'word' }]);
		expect(clipOf(h, id).moreOptions).toMatchObject({
			anchorPointGrouping: 'word',
			fillAndStroke: 'perCharacter',
		});
		h.ok([{ type: 'param.set', target: ['clip', id, 'textMore', 'groupingAlignment'], value: [0, -50] }]);
		expect(clipOf(h, id).moreOptions!.groupingAlignment.value).toEqual([0, -50]);
		invariantsOk(h);
	});
	it('Source Text hold keys: stopwatch, keys at times, validation, snapshot and fonts', () => {
		const h = new Harness();
		const id = withText(h, 'One');
		const target = ['clip', id, 'text', 'sourceText'];
		h.ok([{ type: 'param.setAnimated', target, animated: true, at: { frames: 0 } }]);
		const second = {
			...clipOf(h, id).content,
			text: 'Two',
			style: { ...clipOf(h, id).content.style, italic: true },
		};
		h.ok([{ type: 'param.set', target, value: second, at: { frames: 30 } }]);
		const keys = clipOf(h, id).sourceTextKeyframes!;
		expect(keys.map((k) => [(k.value as { text: string }).text, k.interpolation])).toEqual([
			['One', 'hold'],
			['Two', 'hold'],
		]);
		expect(err(h.tx([{ type: 'param.set', target, value: { text: 3 }, at: { frames: 40 } }]))?.code).toBe(
			'E_INVALID_PARAM',
		);
		const warn = h.ok([{ type: 'clip.update', clipIds: [id], patch: { content: { text: 'base' } } }]);
		expect(warn.warnings.map((w) => w.code)).toContain('W_SOURCE_TEXT_ANIMATED');
		const opts = {
			resolveMedia: () => null,
			resolveFont: (f: { family: string }, w: number, i: boolean) => `font://${f.family}/${w}/${i}`,
		};
		const snap = buildRenderSnapshot(h.doc, h.seqId, opts as never);
		const layer = snap.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === id)!;
		expect('sourceTextKeyframes' in layer.source && layer.source.sourceTextKeyframes).toHaveLength(2);
		expect(snap.fonts.some((f) => f.style === 'italic')).toBe(true);
		h.ok([{ type: 'keyframe.remove', keyframeIds: keys.map((k) => k.id) }]);
		expect(clipOf(h, id).sourceTextKeyframes).toBeUndefined();
		invariantsOk(h);
	});
});

describe('invariants, repair and evaluation', () => {
	it('flags and repairs malformed animator data', () => {
		const h = new Harness();
		const id = withText(h);
		h.ok([{ type: 'textAnimator.add', clipId: id, properties: ['opacity'] }]);
		const bad = JSON.parse(JSON.stringify(h.doc));
		const c = bad.sequences[h.seqId].clips[id];
		c.animators.push({ id: 'tan_X', name: 1 });
		c.animators[0].properties.opacity.value = 400;
		c.sourceTextKeyframes = [
			{
				id: 'kf_0000000000000ZZZ',
				time: 0,
				value: { text: 1 },
				interpolation: 'hold',
				easeIn: { influence: 0.3, slope: 0 },
				easeOut: { influence: 0.3, slope: 0 },
			},
		];
		const issues = checkInvariants(bad, { effects: defaultEffectRegistry }).filter(
			(i) => i.invariant === 'INV-012',
		);
		expect(issues.length).toBeGreaterThanOrEqual(3);
		const { document, report } = repairDocument(bad, createCounterIdSource(900));
		expect(report.filter((r) => r.action === 'repair-text-animators').length).toBeGreaterThanOrEqual(3);
		const fixed = document.sequences[h.seqId]!.clips[id] as TextClip;
		expect(fixed.animators).toHaveLength(1);
		expect(fixed.animators![0]!.properties.opacity!.value).toBe(100);
		expect(fixed.sourceTextKeyframes).toBeUndefined();
	});
	it('a typewriter preset evaluates to a left-to-right reveal', () => {
		const h = new Harness();
		const id = withText(h, 'abcd');
		h.ok([{ type: 'textAnimator.applyPreset', clipIds: [id], preset: 'typewriter', durationFrames: 60 }]);
		const animators = clipOf(h, id).animators as TextAnimatorGroup[];
		const glyphs = [...'abcd'].map((_, i) => ({
			charIndex: i,
			charIndexNoSpace: i,
			wordIndex: 0,
			lineIndex: 0,
			isSpace: false,
		}));
		const counts = { chars: 4, charsNoSpace: 4, words: 1, lines: 1 };
		const at = (frame: number) =>
			charTransforms(animators, glyphs, counts, {
				time: frame * (FLICKS_PER_SECOND / 30),
				layerId: clipLayerId(id),
			}).map((x) => Math.round(x.opacity));
		expect(at(0)).toEqual([0, 0, 0, 0]);
		expect(at(30)).toEqual([100, 100, 0, 0]);
		expect(at(60)).toEqual([100, 100, 100, 100]);
	});
});

describe('typography properties (Character / Paragraph)', () => {
	it('param.set writes the style through clip.update with read-time defaults', () => {
		const h = new Harness();
		const id = withText(h);
		const clip = () => clipOf(h, id);
		const read = (key: string) => {
			const spec = resolvePropertySpec(key, undefined, undefined, clip())!;
			return spec;
		};
		expect(read('text.kerning').kind).toBe('enum');
		h.ok([
			{ type: 'param.set', target: ['clip', id, 'text', 'kerning'], value: 'optical' },
			{ type: 'param.set', target: ['clip', id, 'text', 'smallCaps'], value: true },
			{ type: 'param.set', target: ['clip', id, 'text', 'stylisticSets'], value: '3, 1, 1' },
			{ type: 'param.set', target: ['clip', id, 'text', 'fractions'], value: true },
			{ type: 'param.set', target: ['clip', id, 'text', 'fontVariations'], value: 'wght 650, wdth 80' },
			{ type: 'param.set', target: ['clip', id, 'text', 'indentFirstLinePx'], value: 24 },
		]);
		const st = clip().content.style;
		expect(st.kerning).toBe('optical');
		expect(st.smallCaps).toBe(true);
		expect(st.openType).toEqual({ stylisticSets: [3, 1], fractions: true });
		expect(st.fontVariations).toEqual({ wght: 650, wdth: 80 });
		expect(st.indentFirstLinePx).toBe(24);
		h.ok([{ type: 'param.set', target: ['clip', id, 'text', 'kerningAmount'], value: -40 }]);
		expect(clip().content.style.kerning).toBe(-40);
		expect(
			err(h.tx([{ type: 'param.set', target: ['clip', id, 'text', 'script'], value: 'wavy' }]))?.code,
		).toBe('E_INVALID_PARAM');
		invariantsOk(h);
	});
});

describe('font.add', () => {
	it('registers a family once and is usable as a fontId ref', () => {
		const h = new Harness();
		const id = withText(h);
		const r = h.ok([
			{ type: 'font.add', family: 'Inter Variable', ref: '$f' },
			{
				type: 'clip.update',
				clipIds: [id],
				patch: { content: { style: { fontId: '$f', fontVariations: { wght: 720 } } } },
			},
		]);
		const fid = r.refs.$f!;
		expect(h.doc.fonts[fid]!.family).toBe('Inter Variable');
		expect(clipOf(h, id).content.style.fontId).toBe(fid);
		const again = h.ok([{ type: 'font.add', family: 'inter variable' }]);
		expect((again.results[0] as { fontId: string; added: boolean }).added).toBe(false);
		invariantsOk(h);
	});
});
