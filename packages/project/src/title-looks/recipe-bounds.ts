// Spec 19 TL-106: what an agent's `recipe` may be before anything reads it. Recipes arrive as untrusted JSON, so the walk
// is iterative (depth cannot overflow the stack), stops at the first problem, and runs before `JSON.stringify` or a
// schema touches the value. `look.apply` still applies TL-013's limits to what it stores.
import { GENERATOR_LAYER_PREFIX } from '../registry/fx/title-look/registry.ts';
import { appearanceBytes, MAX_APPEARANCE_BYTES, MAX_APPEARANCE_LAYERS } from './model.ts';

export const RECIPE_BOUNDS = {
	/** UTF-8 bytes of the JSON: a recipe is smaller than the appearance it becomes. */
	maxBytes: MAX_APPEARANCE_BYTES,
	layers: MAX_APPEARANCE_LAYERS,
	/** Nesting of objects and arrays. The deepest legitimate path: layers[i].params.paint.gradient.stops[j].paint.color. */
	maxDepth: 12,
	/** Values in the whole recipe. */
	maxNodes: 20_000,
	/** Layers of one type: each repeats its passes, and a look needs a few of any type. */
	maxTypeInstances: 8,
	/** `generator:*` layers: each draws a procedural picture every frame. */
	maxGeneratorInstances: 4,
} as const;

export type RecipeBoundsProblem = {
	cap: 'bytes' | 'layers' | 'depth' | 'instances' | 'nodes' | 'shape';
	message: string;
};

/** The first bound `raw` breaks, or null. Never throws, whatever `raw` is (cycles included). */
export function recipeBoundsProblem(raw: unknown): RecipeBoundsProblem | null {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
		return { cap: 'shape', message: 'a recipe is an object {layers, palette?, light?, font?}' };
	const stack: { value: object; depth: number }[] = [{ value: raw, depth: 1 }];
	let nodes = 0;
	while (stack.length) {
		const { value, depth } = stack.pop()!;
		if (depth > RECIPE_BOUNDS.maxDepth)
			return { cap: 'depth', message: `a recipe nests at most ${RECIPE_BOUNDS.maxDepth} levels` };
		for (const v of Object.values(value)) {
			if (++nodes > RECIPE_BOUNDS.maxNodes)
				return { cap: 'nodes', message: `a recipe holds at most ${RECIPE_BOUNDS.maxNodes} values` };
			if (typeof v === 'object' && v !== null) stack.push({ value: v, depth: depth + 1 });
		}
	}
	const layers = (raw as { layers?: unknown }).layers;
	if (Array.isArray(layers)) {
		if (layers.length > RECIPE_BOUNDS.layers)
			return {
				cap: 'layers',
				message: `a recipe holds at most ${RECIPE_BOUNDS.layers} layers (${layers.length} given)`,
			};
		const perType = new Map<string, number>();
		let generators = 0;
		for (const l of layers) {
			const type = (l as { type?: unknown } | null)?.type;
			if (typeof type !== 'string') continue;
			const n = (perType.get(type) ?? 0) + 1;
			perType.set(type, n);
			if (n > RECIPE_BOUNDS.maxTypeInstances)
				return {
					cap: 'instances',
					message: `a recipe holds at most ${RECIPE_BOUNDS.maxTypeInstances} layers of one type (${type})`,
				};
			if (type.startsWith(GENERATOR_LAYER_PREFIX) && ++generators > RECIPE_BOUNDS.maxGeneratorInstances)
				return {
					cap: 'instances',
					message: `a recipe holds at most ${RECIPE_BOUNDS.maxGeneratorInstances} generator layers`,
				};
		}
	}
	// The walk bounded the shape and a cycle fails it on depth, so stringifying is safe here.
	let bytes: number;
	try {
		bytes = appearanceBytes(raw);
	} catch {
		return { cap: 'shape', message: 'a recipe is plain JSON' };
	}
	if (bytes > RECIPE_BOUNDS.maxBytes)
		return { cap: 'bytes', message: `a recipe is at most ${RECIPE_BOUNDS.maxBytes} bytes (${bytes} given)` };
	return null;
}
