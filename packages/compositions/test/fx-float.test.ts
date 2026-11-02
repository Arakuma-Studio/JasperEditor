// Spec 19 TL-123: an effect that declares `gpu.requiresFloat` is bypassed (reason `needs-float`, a visible chip in the
// preview) when the browser has no float render targets, instead of running on the silent 8-bit fallback of the host's
// `target()`. Effects that do not declare it keep today's behaviour.
import { createEffectRegistry, defaultEffectRegistry, type ResolvedEffect } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { planLayerFx } from '../src/fx/plan.ts';

const GLOW = 'jasper.s.glow';
const glow = defaultEffectRegistry.get(GLOW)!;
const registry = (requiresFloat?: boolean | string) =>
	createEffectRegistry([
		...defaultEffectRegistry.list().filter((s) => s.id !== GLOW),
		requiresFloat === undefined ? glow : { ...glow, gpu: { ...glow.gpu!, requiresFloat } },
	]);
const effect = (): ResolvedEffect => ({
	id: 'fx_1',
	effectId: GLOW,
	effectVersion: glow.version,
	enabled: true,
	params: Object.fromEntries(glow.params.map((p) => [p.name, p.default])) as ResolvedEffect['params'],
});
const ctx = { width: 640, height: 360, pxScale: 1, fps: 30, frame: 0 };
const plan = (reg: ReturnType<typeof registry>, floatTargets?: boolean) =>
	planLayerFx([effect()], {
		registry: reg,
		gpu: 'ok',
		ctx,
		...(floatTargets === undefined ? {} : { floatTargets }),
	})!;

describe('planLayerFx and float render targets', () => {
	it('bypasses an effect that requires float without float targets, naming it', () => {
		const p = plan(registry(true), false);
		expect(p.active).toBe(false);
		expect(p.steps).toEqual([]);
		expect(p.bypassed).toEqual([{ fxId: 'fx_1', effectId: GLOW, reason: 'needs-float' }]);
	});

	it('draws it when float targets exist or when the capability is not stated', () => {
		for (const f of [true, undefined]) {
			const p = plan(registry('TITLE_LOOK_NEEDS_FLOAT'), f);
			expect(p.active).toBe(true);
			expect(p.bypassed).toEqual([]);
			expect(p.steps.map((s) => s.kind)).toEqual(['gpu']);
		}
	});

	it('an effect that does not declare it is drawn without float targets, as before', () => {
		const p = plan(registry(), false);
		expect(p.active).toBe(true);
		expect(p.bypassed).toEqual([]);
	});
});
