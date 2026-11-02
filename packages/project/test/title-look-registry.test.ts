// Spec 19 §14 "Registry completeness": every layer type, finish and generator meets the extension contract, and has a
// recorded picture, or this fails. Nothing here knows a particular type: a new registration is checked by being there.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	appearanceFromRecipe,
	appearanceProblem,
	defaultEffectRegistry,
	type EffectSpec,
	FORBIDDEN_TITLE_GLSL,
	FX_BUILTIN_UNIFORMS,
	layerParamSpecs,
	layerPropertySpecs,
	planTitleLook,
	resolveAppearance,
	TITLE_FINISHES,
	TITLE_GENERATOR_EFFECTS,
	TITLE_GENERATORS,
	TITLE_LAYER_TYPES,
	TITLE_LOOK_EFFECT,
	TITLE_LOOK_EFFECT_ID,
	titleLayerType,
	validateGpuEffect,
	withDefaults,
} from '../src/index.ts';

const goldens = JSON.parse(
	readFileSync(join(__dirname, '../../compositions/test/goldens/title-look-fingerprints.json'), 'utf8'),
) as Record<string, unknown>;

const NAME = /^[A-Za-z][A-Za-z0-9]*$/;
const glslOf = (s: { glsl: string }) => s.glsl;

describe('the look effect', () => {
	it('is registered, internal, valid, and not offered anywhere', () => {
		const spec = defaultEffectRegistry.get(TITLE_LOOK_EFFECT_ID) as EffectSpec;
		expect(spec).toBe(TITLE_LOOK_EFFECT);
		expect(spec.internal).toBe(true);
		expect(validateGpuEffect(spec)).toEqual([]);
	});
});

for (const t of TITLE_LAYER_TYPES)
	describe(`layer type ${t.type}`, () => {
		const params = layerParamSpecs(t);
		const defaults = withDefaults(t, {});

		it('has a label, a description and valid, unique param names that no built-in uniform takes', () => {
			expect(t.label).toBeTruthy();
			expect(t.description).toBeTruthy();
			const names = params.map((p) => p.name);
			expect(new Set(names).size).toBe(names.length);
			for (const n of names) {
				expect(n).toMatch(NAME);
				expect(Object.keys(FX_BUILTIN_UNIFORMS)).not.toContain(`u_${n}`);
			}
		});

		it('its defaults pass INV-APPEARANCE, and it plans', () => {
			let n = 0;
			const id = () => `apl_${String(++n).padStart(16, '0')}`;
			const a = appearanceFromRecipe({ layers: [{ type: t.type }] }, id);
			expect(appearanceProblem(a)).toBeNull();
			const ctx = {
				width: 640,
				height: 360,
				pxScale: 1,
				fps: 30,
				structures: {
					titleLook: { appearance: resolveAppearance(a, 0), source: a, unitPx: 64, contentSeconds: 0 },
				},
			};
			const passes = planTitleLook(ctx);
			expect(passes.length).toBeGreaterThan(2);
			for (const p of passes) expect(p.frag).toMatch(/\bvoid\s+main\s*\(/);
		});

		it('reports a summary line and finite reach', () => {
			const s = t.summary(defaults, {});
			expect(s.text.length).toBeGreaterThan(0);
			if (s.primary !== null) expect(params.map((p) => p.name)).toContain(s.primary);
			const r = t.reach?.(defaults) ?? 0;
			for (const v of typeof r === 'number' ? [r] : Object.values(r)) expect(Number.isFinite(v)).toBe(true);
		});

		it('its shader never uses forbidden constructs (determinism, TL-035)', () => {
			const ctx = {
				look: resolveAppearance(
					appearanceFromRecipe({ layers: [] }, () => ''),
					0,
				),
				pxPerPercent: 1,
				base: 0,
			};
			const src = [glslOf(t.shader(defaults, ctx)), t.blur?.(defaults, ctx)?.mask ?? ''].join('\n');
			for (const [re, why] of FORBIDDEN_TITLE_GLSL) expect(re.test(src), `${t.type}: ${why}`).toBe(false);
			expect(src).toMatch(/\bvec4\s+tl_layer\s*\(\s*TlSurface\s+\w+\s*\)/);
		});

		it('exposes properties for Effect Controls', () => {
			const specs = layerPropertySpecs(
				{ id: 'fx_0000000000000001' },
				{ id: 'apl_0000000000000001', type: t.type, enabled: true, params: {} },
			);
			expect(specs.length).toBeGreaterThan(0);
		});

		it('has recorded fingerprints: a registered type without a picture test fails here', () => {
			expect(Object.keys(goldens)).toEqual(
				expect.arrayContaining([`${t.type}@default`, `${t.type}@perturbed`]),
			);
		});
	});

describe('finishes', () => {
	it('have unique ids, params named after the finish, and shaders of the contract', () => {
		const ids = TITLE_FINISHES.map((f) => f.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toContain('flat');
		const all: string[] = [];
		for (const f of TITLE_FINISHES) {
			expect(f.glsl).toMatch(/\bvec4\s+tl_finish\s*\(\s*vec4\s+\w+\s*,\s*TlSurface\s+\w+\s*\)/);
			for (const [re, why] of FORBIDDEN_TITLE_GLSL) expect(re.test(f.glsl), `${f.id}: ${why}`).toBe(false);
			for (const p of f.params) {
				expect(p.name.startsWith(f.id)).toBe(true);
				all.push(p.name);
			}
		}
		expect(new Set(all).size).toBe(all.length);
	});
});

describe('generators', () => {
	it('each is an effect in Generate and a look layer, from the same GLSL', () => {
		expect(TITLE_GENERATOR_EFFECTS).toHaveLength(TITLE_GENERATORS.length);
		for (const g of TITLE_GENERATORS) {
			const fx = TITLE_GENERATOR_EFFECTS.find((e) => e.id === `jasper.generator.${g.id}`)!;
			expect(fx.category).toBe('Generate');
			expect(validateGpuEffect(fx)).toEqual([]);
			expect(titleLayerType(`generator:${g.id}`)).toBeTruthy();
			expect(g.glsl).toMatch(/\bvec4\s+tl_generate\s*\(\s*TlSurface\s+\w+\s*\)/);
		}
	});

	it('are the sixteen of TL-061', () => {
		expect(TITLE_GENERATORS.map((g) => g.id).sort()).toEqual(
			[
				'backlight',
				'brushSwirl',
				'corona',
				'fire',
				'glints',
				'inkSplatter',
				'lensFlare',
				'lightStreaks',
				'lightning',
				'magicCircle',
				'particles',
				'pattern',
				'shockwave',
				'smoke',
				'speedLines',
				'sunburst',
			].sort(),
		);
	});

	it('have labels the Effects panel can tell from every other effect', () => {
		const labels = [...defaultEffectRegistry.list()].filter((e) => !e.internal).map((e) => e.label);
		for (const g of TITLE_GENERATOR_EFFECTS)
			expect(labels.filter((l) => l === g.label).length, g.label).toBe(1);
	});

	for (const g of TITLE_GENERATORS)
		describe(g.id, () => {
			const specs = g.params;
			const layer = titleLayerType(`generator:${g.id}`)!;
			const fx = TITLE_GENERATOR_EFFECTS.find((e) => e.id === `jasper.generator.${g.id}`)!;

			it('has at least three presets of valid params, in a look and as an effect (TL-063)', () => {
				expect(g.presets?.length ?? 0).toBeGreaterThanOrEqual(3);
				const ids = g.presets!.map((p) => p.id);
				expect(new Set(ids).size).toBe(ids.length);
				for (const preset of g.presets!) {
					expect(preset.label).toBeTruthy();
					for (const name of Object.keys(preset.params))
						expect(
							specs.map((p) => p.name),
							`${preset.id}.${name}`,
						).toContain(name);
					let n = 0;
					const a = appearanceFromRecipe(
						{ layers: [{ type: layer.type, params: preset.params as Record<string, unknown> }] },
						() => `apl_${String(++n).padStart(16, '0')}`,
					);
					expect(appearanceProblem(a), preset.id).toBeNull();
					const passes = fx.gpu!.passes as (p: unknown, c: unknown) => unknown[];
					const defaults = Object.fromEntries(fx.params.map((p) => [p.name, p.default]));
					expect(
						passes({ ...defaults, ...preset.params }, { width: 640, height: 360, pxScale: 1, fps: 30 })
							.length,
					).toBeGreaterThan(0);
				}
			});

			it('never reads time from a frame counter or a seed from ids, in any of its passes', () => {
				const ctx = { width: 640, height: 360, pxScale: 1, fps: 30 };
				const passes = (
					fx.gpu!.passes as (p: unknown, c: unknown) => { frag: string; draw?: { vert: string } }[]
				)(Object.fromEntries(fx.params.map((p) => [p.name, p.default])), ctx);
				for (const pass of passes)
					for (const src of [pass.frag, pass.draw?.vert ?? ''])
						for (const [re, why] of FORBIDDEN_TITLE_GLSL) expect(re.test(src), `${g.id}: ${why}`).toBe(false);
			});

			it('names no param after a built-in uniform', () => {
				for (const p of specs) expect(Object.keys(FX_BUILTIN_UNIFORMS)).not.toContain(`u_${p.name}`);
			});

			it('reaches a finite distance at its presets', () => {
				for (const preset of g.presets ?? []) {
					const values = withDefaults(layer, preset.params as never);
					const r = g.reach?.(values) ?? 0;
					for (const v of typeof r === 'number' ? [r] : Object.values(r))
						expect(Number.isFinite(v)).toBe(true);
				}
			});
		});
});
