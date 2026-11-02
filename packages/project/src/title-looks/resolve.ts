// Spec 19 TL-014 / TL-030: an appearance evaluated at a content time, what the pass planner reads. Every number and
// palette colour is an `Animatable` (keys in the clip's content time, expressions bound like any other property), and
// structure is hold-only. Pure and cheap: called per visible frame for every clip with a look.
import { evaluate, isAnimated } from '../keyframes.ts';
import type { Animatable, RGBA } from '../schema/common.ts';
import {
	type Appearance,
	COLOR_ROLES,
	DEFAULT_LIGHT_ALTITUDE,
	DEFAULT_LIGHT_ANGLE,
	DEFAULT_PALETTE,
	type GlobalLight,
	type LayerParamValue,
	type Role,
} from './model.ts';

/** One layer at a frame: every stored param evaluated. Params it does not store take the layer type's defaults. */
export type ResolvedTitleLayer = {
	id: string;
	type: string;
	params: Record<string, LayerParamValue>;
};

export type ResolvedAppearance = {
	seed: number;
	/** Every role, filled from `DEFAULT_PALETTE` where the appearance has none. */
	palette: Record<Role, RGBA>;
	light: { angle: number; altitude: number };
	/** Enabled layers, bottom-first. */
	layers: ResolvedTitleLayer[];
};

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** An appearance at content time `t` (flicks). `global`: the sequence's light at that moment (TL-017). */
export function resolveAppearance(
	a: Appearance,
	t: number,
	global?: { angle: number; altitude: number } | null,
): ResolvedAppearance {
	const palette = {} as Record<Role, RGBA>;
	for (const role of COLOR_ROLES) {
		const anim = a.palette?.[role] as Animatable<RGBA> | undefined;
		palette[role] = anim ? evaluate(anim, t) : DEFAULT_PALETTE[role];
	}
	const layers: ResolvedTitleLayer[] = [];
	for (const l of a.layers ?? []) {
		if (!l.enabled) continue;
		const params: Record<string, LayerParamValue> = {};
		for (const k of Object.keys(l.params)) params[k] = evaluate(l.params[k]!, t);
		layers.push({ id: l.id, type: l.type, params });
	}
	const light =
		a.light?.source === 'sequence' && global
			? global
			: {
					angle: num(a.light ? evaluate(a.light.angle, t) : undefined, DEFAULT_LIGHT_ANGLE),
					altitude: num(a.light ? evaluate(a.light.altitude, t) : undefined, DEFAULT_LIGHT_ALTITUDE),
				};
	return { seed: num(a.seed, 0), palette, light, layers };
}

/** Every animatable of an appearance, palette and light included. */
export function* appearanceAnimatables(a: Appearance): Generator<Animatable<unknown>> {
	for (const anim of Object.values(a.palette ?? {})) if (anim) yield anim as Animatable<unknown>;
	if (a.light) {
		yield a.light.angle as Animatable<unknown>;
		yield a.light.altitude as Animatable<unknown>;
	}
	for (const l of a.layers ?? []) for (const anim of Object.values(l.params)) yield anim as Animatable<unknown>;
}

/** The appearance changes with time on its own (keys or expressions; the sequence's light is the caller's check). */
export function appearanceAnimated(a: Appearance): boolean {
	for (const anim of appearanceAnimatables(a)) if (isAnimated(anim)) return true;
	return false;
}

/** The global light at sequence time `t`. */
export function resolveGlobalLight(g: GlobalLight, t: number): { angle: number; altitude: number } {
	return {
		angle: num(evaluate(g.angle, t), DEFAULT_LIGHT_ANGLE),
		altitude: num(evaluate(g.altitude, t), DEFAULT_LIGHT_ALTITUDE),
	};
}
