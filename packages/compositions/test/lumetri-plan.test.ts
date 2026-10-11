import {
	defaultEffectRegistry,
	expandLumetriSpatial,
	LUMETRI_EFFECT_ID,
	LUMETRI_SPATIAL_EFFECT_ID,
	type ResolvedEffect,
	type ResolvedMask,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { planLayerFx } from '../src/fx/plan.ts';

const opts = {
	registry: defaultEffectRegistry,
	gpu: 'ok' as const,
	ctx: { width: 100, height: 50, pxScale: 1, fps: 30 },
};
const A = (v: unknown) => ({ value: v, keyframes: [] });
const v = (x: number, y: number) => ({ p: [x, y], in: [0, 0], out: [0, 0] });
const mask = {
	id: 'm1',
	mode: 'add',
	inverted: false,
	path: { closed: true, vertices: [v(0.2, 0.2), v(0.8, 0.2), v(0.8, 0.8), v(0.2, 0.8)] },
	opacity: 100,
	feather: 20,
	expansion: 0,
	falloff: 'smooth',
} as never as ResolvedMask;

function resolved(params: Record<string, unknown>, masks?: ResolvedMask[]): ResolvedEffect[] {
	const inst = {
		id: 'fx1',
		effectId: LUMETRI_EFFECT_ID,
		effectVersion: 1,
		enabled: true,
		params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, A(v)])),
	};
	return expandLumetriSpatial([inst as Parameters<typeof expandLumetriSpatial>[0][number]]).map((e) => ({
		id: e.id,
		effectId: e.effectId,
		effectVersion: e.effectVersion,
		enabled: e.enabled,
		params: Object.fromEntries(
			Object.entries(e.params).map(([k, a]) => [k, (a as { value: unknown }).value]),
		) as never,
		...(masks ? { masks } : {}),
	}));
}

describe('Lumetri spatial stage in the fx chain', () => {
	it('runs the LUT step, then the spatial GPU stage', () => {
		const p = planLayerFx(resolved({ exposure: 1, vignetteAmount: -2 }), opts)!;
		expect(p.active).toBe(true);
		expect(p.steps.map((s) => s.kind)).toEqual(['lut', 'gpu']);
		const g = p.steps[1] as Extract<(typeof p.steps)[number], { kind: 'gpu' }>;
		expect(g.spec.id).toBe(LUMETRI_SPATIAL_EFFECT_ID);
		expect(g.fx.id).toBe('fx1~spatial');
	});

	it('a masked instance is one masked unit (maskJoin on the LUT step)', () => {
		const p = planLayerFx(resolved({ exposure: 1, vignetteAmount: -2 }, [mask]), opts)!;
		const [lut, gpu] = p.steps as { kind: string; masks?: unknown[]; maskJoin?: boolean }[];
		expect(lut!.kind).toBe('lut');
		expect(lut!.maskJoin).toBe(true);
		expect(gpu!.masks?.length).toBe(1);
		expect(gpu!.maskJoin).toBeUndefined();
	});

	it('the before/after toggle bypasses the spatial stage with the grade', () => {
		const p = planLayerFx(resolved({ exposure: 1, vignetteAmount: -2 }), { ...opts, colorBypass: true });
		expect(p === null || p.steps.length === 0 || !p.active).toBe(true);
	});

	it('a pointwise-only grade does not take the fx path', () => {
		expect(planLayerFx(resolved({ exposure: 1, fadedFilm: 30 }), opts)).toBeNull();
	});
});
