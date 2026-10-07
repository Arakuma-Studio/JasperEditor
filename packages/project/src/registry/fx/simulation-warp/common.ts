// Shared params and passes of the simulation-warp family (sim-warp workstream).
import type { ParamSpec } from '../../effects.ts';
import { fxParam } from '../params.ts';
import type { ShaderPass } from '../shader.ts';
import { GLSL_SPRITES } from './sprites.ts';

/** The Random Seed of a simulation (named `seed`: the framework mixes it into `u_seed` / `ctx.seed`). */
export function randomSeedParam(def = 0): ParamSpec {
	return {
		name: 'seed',
		label: 'Random Seed',
		type: 'number',
		default: def,
		range: { min: 0, max: 10000, softMax: 1000, step: 1 },
		animatable: false,
	};
}

/** A plain number param (animatable). */
export const n = (
	name: string,
	label: string,
	def: number,
	min: number,
	max: number,
	softMin = min,
	softMax = max,
	step = 0.01,
	extra: { unit?: ParamSpec['unit']; group?: string; animatable?: boolean } = {},
): ParamSpec =>
	fxParam.number(
		name,
		label,
		def,
		{ min, max, softMin, softMax, step },
		{
			...(extra.unit ? { unit: extra.unit } : {}),
			...(extra.group ? { group: extra.group } : {}),
			...(extra.animatable !== undefined ? { animatable: extra.animatable } : {}),
		},
	);

/** A popup with labels = values' display names. */
export const pick = (
	name: string,
	label: string,
	options: readonly string[],
	labels: readonly string[],
	def: string,
	group?: string,
): ParamSpec => fxParam.choice(name, label, options, labels, def, group ? { group } : undefined);

/** Option values from labels ("Shaded Sphere" → "shadedSphere"). */
export const values = (labels: readonly string[]) =>
	labels.map((l) =>
		l
			.replace(/[^A-Za-z0-9 ]+/g, ' ')
			.trim()
			.split(/\s+/)
			.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1)))
			.join(''),
	);

/** A popup built from labels only. */
export const popup = (name: string, label: string, labels: readonly string[], defIndex = 0, group?: string) => {
	const opts = values(labels);
	return pick(name, label, opts, labels, opts[defIndex]!, group);
};

/**
 * The final pass of a sprite/piece effect: the drawn layer (`u_<input>`) combined with the original by
 * `sp_combine(u_post, …)` (`u_post` from the effect's uniforms: 0 Composite … 5 the effect only).
 */
export function combinePass(input = 'sprites'): ShaderPass {
	return {
		include: [GLSL_SPRITES],
		frag: /* glsl */ `
void main() {
  fragColor = sp_combine(u_post, texture(u_source, v_uv), texture(u_${input}, v_uv));
}`,
	};
}
