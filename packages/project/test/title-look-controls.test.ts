// Spec 19 §10: what the people-facing controls need from the model: Intensity (TL-089), quick controls (TL-089), posters
// of project looks (TL-087), the paint control (TL-091) and on-canvas handles (TL-092).
import { describe, expect, it } from 'vitest';
import {
	type Appearance,
	appearancePropertySpecs,
	clipLook,
	defaultEffectRegistry,
	type EffectInstance,
	layerHandles,
	type LookRecipe,
	recipeOfAppearance,
	TITLE_LOOK_EFFECT_ID,
	TITLE_LOOK_INTENSITY,
	TitleLookSchema,
	titleLayerType,
	titleLooksOf,
	withDefaults,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const recipe: LookRecipe = {
	palette: { face: [1, 0.8, 0.2, 1] },
	light: { source: 'look', angle: 200, altitude: 30 },
	layers: [
		{ type: 'shadow', params: { distance: 8 } },
		{ type: 'rim', name: 'Outline', params: { width: 5 } },
		{ type: 'face', enabled: false },
	],
	font: { family: 'Inter' },
};

function applied(extra: Record<string, unknown> = {}) {
	const h = new Harness();
	const r = h.ok([
		{ type: 'clip.addText', at: 0, duration: 60, track: 'V2', content: { text: 'Title' }, ref: '$t' },
		{ type: 'look.apply', clipIds: ['$t'], look: { name: 'Gold', recipe, ...extra } },
	]);
	const t = r.refs.$t!;
	const fx = () => clipLook((h.seq.clips[t] as unknown as { effects: EffectInstance[] }).effects)!;
	return { h, t, fx };
}

describe('Intensity (TL-089)', () => {
	it('is the look effect\'s one param: it animates like any effect param, and Reset clears it', () => {
		const spec = defaultEffectRegistry.get(TITLE_LOOK_EFFECT_ID)!;
		expect(spec.params.map((p) => p.name)).toEqual([TITLE_LOOK_INTENSITY]);
		expect(spec.params[0]!.default).toBe(100);
		expect(spec.params[0]!.animatable).toBe(true);
		const { h, t, fx } = applied();
		// A look starts with nothing stored: the default applies, and old instances read the same.
		expect(fx().params).toEqual({});
		const path = ['effect', fx().id, TITLE_LOOK_INTENSITY];
		h.ok([{ type: 'param.set', target: path, value: 40 }]);
		expect(fx().params[TITLE_LOOK_INTENSITY]!.value).toBe(40);
		h.ok([{ type: 'look.reset', clipIds: [t] }]);
		expect(fx().params[TITLE_LOOK_INTENSITY]).toBeUndefined();
	});

	it('resetting one layer leaves Intensity alone', () => {
		const { h, t, fx } = applied();
		h.ok([{ type: 'param.set', target: ['effect', fx().id, TITLE_LOOK_INTENSITY], value: 40 }]);
		const layer = (fx().appearance as Appearance).layers[0]!.id;
		h.ok([{ type: 'look.reset', clipIds: [t], layerIds: [layer] }]);
		expect(fx().params[TITLE_LOOK_INTENSITY]!.value).toBe(40);
	});

	it('counts the keys Reset drops', () => {
		const { h, t, fx } = applied();
		const path = ['effect', fx().id, TITLE_LOOK_INTENSITY];
		h.ok([{ type: 'param.setAnimated', target: path, animated: true, at: { sequenceFrame: 5 } }]);
		const r = h.ok([{ type: 'look.reset', clipIds: [t] }]);
		expect((r.results[0] as { droppedKeyframes: number }).droppedKeyframes).toBe(1);
	});
});

describe('quick controls (TL-089)', () => {
	const quickControls = [{ label: 'Outline', layerType: 'rim', param: 'width' }];

	it('travel with the look into the project', () => {
		const { h } = applied({ quickControls });
		expect(titleLooksOf(h.doc)[0]!.quickControls).toEqual(quickControls);
	});

	it('are optional, and unreadable ones never stop a look loading', () => {
		const { h } = applied();
		const look = titleLooksOf(h.doc)[0]!;
		expect(look.quickControls).toBeUndefined();
		const r = TitleLookSchema.safeParse({ ...look, quickControls: [{ label: 3 }] });
		expect(r.success).toBe(true);
		expect((r as { data: { quickControls?: unknown } }).data.quickControls).toBeUndefined();
	});

	it('refuses unreadable ones in a command', () => {
		const h = new Harness();
		const r = h.ok([{ type: 'clip.addText', at: 0, duration: 60, track: 'V2', content: { text: 'T' }, ref: '$t' }]);
		const out = h.tx([
			{
				type: 'look.apply',
				clipIds: [r.refs.$t!],
				look: { name: 'Bad', recipe, quickControls: [{ label: 'x' }] },
			},
		]);
		expect(out.ok).toBe(false);
	});
});

describe('recipeOfAppearance (TL-087)', () => {
	it('gives back what the look was made from', () => {
		const { h, t } = applied();
		const a = (clipLook((h.seq.clips[t] as unknown as { effects: EffectInstance[] }).effects)!
			.appearance as Appearance)!;
		const r = recipeOfAppearance(a);
		expect(r.palette).toEqual(recipe.palette);
		expect(r.light).toEqual(recipe.light);
		expect(r.font).toEqual(recipe.font);
		expect(r.layers.map((l) => [l.type, l.name, l.enabled])).toEqual([
			['shadow', undefined, true],
			['rim', 'Outline', true],
			['face', undefined, false],
		]);
		expect(r.layers[1]!.params!.width).toBe(5);
	});

	it('makes a recipe `look.apply` takes again, with the same values', () => {
		const { h, t } = applied();
		const a = clipLook((h.seq.clips[t] as unknown as { effects: EffectInstance[] }).effects)!
			.appearance as Appearance;
		const again = applied();
		again.h.ok([{ type: 'look.apply', clipIds: [again.t], look: { name: 'Again', recipe: recipeOfAppearance(a) } }]);
		const b = again.fx().appearance as Appearance;
		expect(recipeOfAppearance(b)).toEqual(recipeOfAppearance(a));
	});

	it('drops params of another finish and layers this build does not know', () => {
		const a = {
			...(applied().fx().appearance as Appearance),
		};
		const layers = [
			{ id: 'apl_x', type: 'gone', enabled: true, params: {} },
			{
				id: 'apl_y',
				type: 'face',
				enabled: true,
				params: { paint: { value: { kind: 'source' }, keyframes: [] }, stale: { value: 1, keyframes: [] } },
			},
		];
		const r = recipeOfAppearance({ ...a, layers } as Appearance);
		expect(r.layers.map((l) => l.type)).toEqual(['face']);
		expect(r.layers[0]!.params).toEqual({ paint: { kind: 'source' } });
	});
});

describe('light source (TL-017)', () => {
	it('follows the sequence or keeps its own light, one undo step, and shows as an override', () => {
		const { h, fx } = applied();
		const before = h.doc;
		h.ok([{ type: 'appearance.setLightSource', effectInstanceId: fx().id, source: 'sequence' }]);
		const a = fx().appearance as Appearance;
		expect(a.light.source).toBe('sequence');
		expect(a.lookOverrides?.$light).toEqual(['source']);
		expect(
			(
				clipLook(
					(Object.values(Object.values(before.sequences)[0]!.clips)[0] as unknown as { effects: EffectInstance[] })
						.effects,
				)!.appearance as Appearance
			).light.source,
		).toBe('look');
	});

	it('refuses an instance that is not a look', () => {
		const { h } = applied();
		expect(h.tx([{ type: 'appearance.setLightSource', effectInstanceId: 'fx_none', source: 'look' }]).ok).toBe(
			false,
		);
	});
});

describe('paint control (TL-091)', () => {
	it('paint params reach the inspector as the paint control, hold-only', () => {
		const { fx } = applied();
		const specs = appearancePropertySpecs(fx(), fx().appearance as Appearance);
		const paints = specs.filter((s) => s.ui.control === 'paint');
		expect(paints.length).toBeGreaterThan(2);
		for (const p of paints) expect(p.animatable).toBe('hold-only');
	});
});

describe('layer handles (TL-092)', () => {
	const of = (type: string, stored: Record<string, never> = {}) => {
		const t = titleLayerType(type)!;
		return layerHandles(t, withDefaults(t, stored));
	};

	it('come from the layer type', () => {
		expect(of('rim')).toEqual([{ kind: 'distance', params: ['width'] }]);
		expect(of('shadow')).toEqual([{ kind: 'offset', params: ['angle', 'distance'] }]);
	});

	it('add the angle of a gradient paint, only while the paint is a gradient', () => {
		const gradient = {
			kind: 'gradient',
			gradient: {
				type: 'linear',
				span: 'block',
				angle: 0,
				stops: [
					{ at: 0, paint: { role: 'face' } },
					{ at: 1, paint: { role: 'base' } },
				],
			},
		};
		expect(of('face')).toEqual([]);
		expect(of('face', { paint: gradient as never })).toEqual([{ kind: 'angle', params: ['paintAngle'] }]);
	});
});
