// Colour-run fusion (M2, ARCHITECTURE §19.2): consecutive enabled colour effects of a layer (EffectSpec.color)
// form a run that is baked into ONE 3D LUT. The preview (WebGL) and the native export (lut3d) both consume the
// baked LUT, so they agree to the LUT's precision. Pure and shared by @jasper/compositions and the engine.
import { canonicalJson } from '../canonical-json.ts';
import type { ColorFn, ColorOpContext, EffectLike, EffectRegistry } from '../registry/effects.ts';
import { effectiveParams } from '../registry/effects.ts';
import { bakeLut, type Lut } from './lut.ts';

export { canonicalJson };

/** Minimal effect shape (evaluated params): `ResolvedEffect` and the engine's evaluated instances fit. */
export type ColorRunEffect = EffectLike;

type EffectRunSource = Pick<EffectLike, 'id' | 'effectId' | 'effectVersion' | 'enabled'>;

export type EffectRun<E extends EffectRunSource = ColorRunEffect> =
	| { kind: 'color'; effects: E[] }
	| { kind: 'other'; effect: E };

/** Default lattice sizes (S06:CG-012): preview 33, export 65 would be ~275k evaluations; 33 is the default for both. */
export const PREVIEW_LUT_SIZE = 33;
export const EXPORT_LUT_SIZE = 33;

/**
 * Splits a layer's effect stack (stack order) into colour runs and other effects. Disabled effects are dropped;
 * unknown ids and audio effects are dropped (they are bypassed by every renderer, S01:FX-022).
 */
export function effectRuns<E extends EffectRunSource>(
	effects: readonly E[],
	registry: EffectRegistry,
): EffectRun<E>[] {
	const out: EffectRun<E>[] = [];
	for (const fx of effects) {
		if (!fx.enabled) continue;
		const spec = registry.get(fx.effectId, fx.effectVersion);
		if (spec?.appliesTo !== 'video') continue;
		if (spec.color) {
			const last = out[out.length - 1];
			if (last?.kind === 'color') last.effects.push(fx);
			else out.push({ kind: 'color', effects: [fx] });
		} else out.push({ kind: 'other', effect: fx });
	}
	return out;
}

/** The composed pixel function of a colour run, or null when every effect is the identity. */
function colorRunFn(
	effects: readonly ColorRunEffect[],
	registry: EffectRegistry,
	ctx: ColorOpContext,
): ColorFn | null {
	const fns: ColorFn[] = [];
	for (const fx of effects) {
		const spec = registry.get(fx.effectId, fx.effectVersion);
		if (!spec?.color) continue;
		const fn = spec.color.build(effectiveParams(spec, fx.params), ctx);
		if (fn) fns.push(fn);
	}
	if (fns.length === 0) return null;
	if (fns.length === 1) return fns[0]!;
	return (c) => {
		for (const f of fns) f(c);
	};
}

/** Bakes a colour run into a 3D LUT, or returns null for an identity run. */
export function bakeColorRun(
	effects: readonly ColorRunEffect[],
	registry: EffectRegistry,
	ctx: ColorOpContext,
	size = EXPORT_LUT_SIZE,
): Lut | null {
	const fn = colorRunFn(effects, registry, ctx);
	if (!fn) return null;
	return bakeLut(size, (c) => {
		fn(c);
		// Keep the table inside the displayable range: both renderers clamp at output anyway.
		for (let k = 0; k < 3; k++) c[k] = c[k]! < 0 ? 0 : c[k]! > 1 ? 1 : c[k]!;
	});
}

/**
 * Stable identity of a colour run for LUT caches: effect ids, versions and evaluated params, plus the content
 * identity of every referenced LUT asset (`lutKey(mediaId)`, e.g. its fingerprint) and the lattice size.
 */
export function colorRunKey(
	effects: readonly ColorRunEffect[],
	lutKey: (mediaId: string) => string,
	size = EXPORT_LUT_SIZE,
	/** color-mgmt: identity of the context the ops read (`workingKey` of the working space); '' = none. */
	extra = '',
): string {
	const luts: string[] = [];
	const walk = (v: unknown) => {
		if (v && typeof v === 'object') {
			const m = (v as { mediaId?: unknown }).mediaId;
			if (typeof m === 'string') luts.push(lutKey(m));
			for (const x of Object.values(v as Record<string, unknown>)) walk(x);
		}
	};
	for (const fx of effects) walk(fx.params);
	return canonicalJson({
		size,
		effects: effects.map((fx) => [fx.effectId, fx.effectVersion, fx.params]),
		luts,
		...(extra ? { ctx: extra } : {}),
	});
}
