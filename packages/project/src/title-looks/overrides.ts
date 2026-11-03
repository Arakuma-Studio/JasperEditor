// Spec 19 TL-011 / TL-016 / TL-019: how an appearance relates to its look.
//
// A clip's appearance always holds its effective values, so a missing look only unlinks it (TL-015). `lookOverrides`
// names where it deviates from the linked look, by layer id and param; it is derived data, recomputed at the end of
// every transaction that changes a linked clip (`normalizeLookLinks`), so no command has to maintain it. `look.update`
// takes the deviations from the clip itself against the look as it was, and re-applies them to the new look: each
// override keeps its value, keyframes and expression.
import { evaluate } from '../keyframes.ts';
import type { Animatable, RGBA } from '../schema/common.ts';
import {
	type Appearance,
	type AppearanceLayer,
	type Colorway,
	type LayerParamValue,
	type Paint,
	PaintSchema,
	type Role,
	staticAnim,
	type TitleLook,
} from './model.ts';

/** `lookOverrides`: `<layerId>` → changed params (`$enabled`, `$name`, `$fixedColor` for those fields), and the `$` entries below. */
export type LookOverrides = {
	[layerId: string]: unknown;
	/** Layers the clip added. */
	$added?: string[];
	/** Look layers the clip removed. */
	$removed?: string[];
	/** The clip's order of the shared layers differs from the look's. */
	$order?: true;
	$palette?: string[];
	$light?: string[];
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Whether `a` overrides the look's value `b`: other value, keys or an expression. */
function animDiffers(a: Animatable<unknown> | undefined, b: Animatable<unknown> | undefined): boolean {
	if (!a) return false;
	if (a.keyframes.length > 0 || a.expression) return true;
	return !b || !same(a.value, b.value);
}

/** Where `a` deviates from `base` (TL-011). An empty result means "no overrides". */
export function diffAppearance(base: Appearance, a: Appearance): LookOverrides {
	const out: LookOverrides = {};
	const looks = new Map(base.layers.map((l) => [l.id, l]));
	const mine = new Map(a.layers.map((l) => [l.id, l]));
	for (const l of a.layers) {
		const b = looks.get(l.id);
		if (!b) {
			(out.$added ??= []).push(l.id);
			continue;
		}
		const changed = Object.keys(l.params).filter((k) => animDiffers(l.params[k], b.params[k]));
		if (l.enabled !== b.enabled) changed.push('$enabled');
		if (l.name !== b.name) changed.push('$name');
		if ((l.fixedColor === true) !== (b.fixedColor === true)) changed.push('$fixedColor');
		if (changed.length) out[l.id] = changed;
	}
	for (const b of base.layers) if (!mine.has(b.id)) (out.$removed ??= []).push(b.id);
	const sharedMine = a.layers.filter((l) => looks.has(l.id)).map((l) => l.id);
	const sharedBase = base.layers.filter((l) => mine.has(l.id)).map((l) => l.id);
	if (!same(sharedMine, sharedBase)) out.$order = true;
	const roles = new Set([...Object.keys(a.palette), ...Object.keys(base.palette)]) as Set<Role>;
	for (const r of roles)
		if (animDiffers(a.palette[r] as Animatable<unknown>, base.palette[r] as Animatable<unknown>))
			(out.$palette ??= []).push(r);
	if (a.light.source !== base.light.source) (out.$light ??= []).push('source');
	for (const k of ['angle', 'altitude'] as const)
		if (animDiffers(a.light[k] as Animatable<unknown>, base.light[k] as Animatable<unknown>))
			(out.$light ??= []).push(k);
	return out;
}

/**
 * The appearance of `next` carrying `a`'s deviations from `base` (TL-016): values, keys and expressions of overridden
 * params, the clip's own layers and removals. `diffAppearance` of the result against `next` names the same params.
 */
export function rebaseAppearance(base: Appearance, next: Appearance, a: Appearance): Appearance {
	const d = diffAppearance(base, a);
	const mine = new Map(a.layers.map((l) => [l.id, l]));
	const removed = new Set(d.$removed ?? []);
	const added = new Set(d.$added ?? []);
	const layers: AppearanceLayer[] = [];
	for (const l of next.layers) {
		if (removed.has(l.id)) continue;
		const out = clone(l);
		const own = mine.get(l.id);
		for (const name of (d[l.id] as string[] | undefined) ?? []) {
			if (name === '$enabled' && own) out.enabled = own.enabled;
			else if (name === '$name') {
				if (own?.name !== undefined) out.name = own.name;
				else delete out.name;
			} else if (name === '$fixedColor') {
				if (own?.fixedColor) out.fixedColor = true;
				else delete out.fixedColor;
			} else if (own?.params[name]) out.params[name] = clone(own.params[name]);
		}
		layers.push(out);
	}
	// The clip's own layers stay above the layer they sat above.
	a.layers.forEach((l, i) => {
		if (!added.has(l.id)) return;
		const below = a.layers[i - 1]?.id;
		const at = below === undefined ? -1 : layers.findIndex((x) => x.id === below);
		layers.splice(at + 1, 0, clone(l));
	});
	if (d.$order) {
		const rank = new Map(a.layers.map((l, i) => [l.id, i]));
		const shared = layers.filter((l) => rank.has(l.id)).sort((x, y) => rank.get(x.id)! - rank.get(y.id)!);
		let k = 0;
		for (let i = 0; i < layers.length; i++) if (rank.has(layers[i]!.id)) layers[i] = shared[k++]!;
	}
	const palette = clone(next.palette);
	for (const r of (d.$palette ?? []) as Role[]) {
		const own = a.palette[r];
		if (own) palette[r] = clone(own);
		else delete palette[r];
	}
	const light = clone(next.light);
	for (const k of d.$light ?? []) {
		if (k === 'source') light.source = a.light.source;
		else light[k as 'angle' | 'altitude'] = clone(a.light[k as 'angle' | 'altitude']);
	}
	const { font: _font, lookOverrides: _o, ...rest } = next;
	return {
		...clone(rest),
		seed: a.seed,
		...(a.lookId !== undefined ? { lookId: a.lookId } : {}),
		...(a.colorwayId !== undefined ? { colorwayId: a.colorwayId } : {}),
		palette,
		light,
		layers,
	};
}

/**
 * Keeps layer identity across a redefinition of a look: a layer of `next` takes the id of the look's layer of the same
 * type at the same position among that type, because linked clips' overrides are keyed by layer id (TL-016).
 */
export function adoptLayerIds(old: Appearance, next: Appearance): void {
	const free = new Map<string, string[]>();
	for (const l of old.layers) free.set(l.type, [...(free.get(l.type) ?? []), l.id]);
	for (const l of next.layers) {
		const id = free.get(l.type)?.shift();
		if (id) l.id = id;
	}
}

/** How many keyframes an appearance holds on the params `next` replaces (TL-019). */
export function countKeyframes(a: Appearance): number {
	let n = 0;
	for (const v of Object.values(a.palette)) n += v?.keyframes.length ?? 0;
	n += a.light.angle.keyframes.length + a.light.altitude.keyframes.length;
	for (const l of a.layers) for (const v of Object.values(l.params)) n += v.keyframes.length;
	return n;
}

/** The look's body as an appearance for one clip. */
export function appearanceOfLook(look: TitleLook, seed: number): Appearance {
	const { lookOverrides: _o, ...body } = clone(look.appearance);
	return { ...body, lookId: look.id, seed };
}

/** A clip's appearance as a look's body: values at content time `t`, no keys, no expressions, no link (TL-015). */
export function lookBodyOf(a: Appearance, t: number): Appearance {
	const flat = <T>(anim: Animatable<T>): Animatable<T> => staticAnim(clone(evaluate(anim, t)));
	const palette: Appearance['palette'] = {};
	for (const [r, v] of Object.entries(a.palette)) if (v) palette[r as Role] = flat(v);
	const { lookId: _l, lookOverrides: _o, colorwayId: _c, ...rest } = a;
	return {
		...clone(rest),
		palette,
		light: { ...clone(a.light), angle: flat(a.light.angle), altitude: flat(a.light.altitude) },
		layers: a.layers.map((l) => ({
			...clone(l),
			params: Object.fromEntries(
				Object.entries(l.params).map(([k, v]) => [k, flat(v as Animatable<LayerParamValue>)]),
			),
		})),
	};
}

/** TL-019: a colourway's values on an appearance. Keyed roles keep their keys and report it; structure is untouched. */
export function applyColorway(
	a: Appearance,
	colorway: Pick<Colorway, 'palette'> & { id?: string },
): { keptAnimated: Role[] } {
	const keptAnimated: Role[] = [];
	for (const [role, color] of Object.entries(colorway.palette)) {
		const r = role as Role;
		const cur = a.palette[r];
		if (cur?.keyframes.length) keptAnimated.push(r);
		if (cur) cur.value = clone(color);
		else a.palette[r] = staticAnim(clone(color));
	}
	if (colorway.id !== undefined) a.colorwayId = colorway.id;
	else delete a.colorwayId;
	return { keptAnimated };
}

/** The roles a value reads, when it is a paint (TL-051: a fixed layer reads none). */
export function paintRoles(v: unknown): Role[] {
	const p = PaintSchema.safeParse(v);
	if (!p.success) return [];
	if (p.data.kind === 'role') return [p.data.role];
	if (p.data.kind !== 'gradient') return [];
	return p.data.gradient.stops.flatMap((s) => ('role' in s.paint ? [s.paint.role] : []));
}

/** A paint with its roles replaced by their colours under `palette`: what `fixedColor` stores. */
export function paintWithoutRoles(p: Paint, palette: Record<Role, RGBA>): Paint {
	if (p.kind === 'role') return { kind: 'color', color: [...palette[p.role]] };
	if (p.kind !== 'gradient') return p;
	const stops = p.gradient.stops.map((s) =>
		'role' in s.paint ? { ...s, paint: { color: [...palette[s.paint.role]] as RGBA } } : s,
	);
	return { kind: 'gradient', gradient: { ...p.gradient, stops } };
}
