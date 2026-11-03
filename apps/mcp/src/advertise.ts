// The smallest correct shape of a tool's input for `tools/list`. Agents read this on every load, and in big unions it
// was almost all of the payload, so what a call does not need to get right drops out here. Validation is untouched
// (strict.ts works on the zod schema), and `describe_tool` still returns the full schema for the rare deep shape.
type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Keywords that say nothing a call needs: bounds of ids and text, and strictness the server enforces anyway. */
const DROPPED = new Set([
	'$schema',
	'additionalItems',
	'additionalProperties',
	'maxLength',
	'minLength',
	'pattern',
	'propertyNames',
]);

/** An enum this long is a catalogue, not a choice: it names its source instead. */
const MAX_ENUM = 40;

const safeInteger = (v: unknown): boolean => v === Number.MAX_SAFE_INTEGER || v === Number.MIN_SAFE_INTEGER;

/** A bound the JSON Schema of an unbounded integer carries. */
function isNoiseBound(key: string, value: unknown): boolean {
	return (key === 'minimum' || key === 'maximum') && safeInteger(value);
}

const TIME_TYPE = ['integer', 'string'];

/** A `{frames: n}` branch: the mark of a time argument. */
const isFramesBranch = (s: Json): boolean =>
	isObject(s.properties) && Object.keys(s.properties).join() === 'frames';

/** A keyframed value (`{value, keyframes…}`), the alternative of an animatable number or vector. */
const isAnimatedBranch = (s: Json): boolean =>
	isObject(s.properties) && 'keyframes' in s.properties && 'value' in s.properties;

function flattenAnyOf(branches: unknown[]): Json[] {
	return branches.flatMap((b) => {
		if (!isObject(b)) return [];
		return Array.isArray(b.anyOf) && Object.keys(b).length === 1 ? flattenAnyOf(b.anyOf) : [b];
	});
}

/** The tag of a discriminated union: a property every branch fixes to its own constant. */
function unionTag(branches: readonly Json[]): string | null {
	if (branches.length < 2 || !branches.every((b) => isObject(b.properties))) return null;
	const first = branches[0]!.properties as Json;
	return (
		Object.keys(first).find((key) =>
			branches.every((b) => {
				const p = (b.properties as Json)[key];
				return isObject(p) && (p.const !== undefined || (Array.isArray(p.enum) && p.enum.length === 1));
			}),
		) ?? null
	);
}

const tagValue = (p: Json): unknown => p.const ?? (p.enum as unknown[])[0];

function compactUnion(node: Json): Json {
	let branches = flattenAnyOf(node.anyOf as unknown[]).filter((b) => b.type !== 'null');
	const { anyOf: _anyOf, ...rest } = node;
	// Children compact first, so an outer union sees an inner time union as its finished form.
	if (branches.some((b) => isFramesBranch(b) || Array.isArray(b.type))) return { ...rest, type: TIME_TYPE };
	const animated = branches.filter(isAnimatedBranch);
	if (animated.length && animated.length < branches.length)
		branches = branches.filter((b) => !isAnimatedBranch(b));
	const tag = unionTag(branches);
	if (tag) {
		const values = branches.map((b) => tagValue((b.properties as Json)[tag] as Json));
		return {
			...rest,
			type: 'object',
			properties: { [tag]: { enum: values } },
			required: [tag],
		};
	}
	if (branches.every((b) => b.const !== undefined)) return { ...rest, enum: branches.map((b) => b.const) };
	const seen = new Set<string>();
	const unique = branches.filter((b) => {
		const key = JSON.stringify(b);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	if (unique.length === 1) return { ...rest, ...unique[0] };
	return { ...rest, anyOf: unique };
}

/** One schema node, children first. */
export function compactNode(input: unknown): unknown {
	if (Array.isArray(input)) return input.map(compactNode);
	if (!isObject(input)) return input;
	const out: Json = {};
	for (const [key, value] of Object.entries(input)) {
		if (DROPPED.has(key) || isNoiseBound(key, value)) continue;
		if (key === 'properties' && isObject(value)) {
			out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, compactNode(v)]));
			continue;
		}
		// A tuple of one type reads as an array of it.
		if (key === 'items' && Array.isArray(value)) {
			const items = value.map(compactNode);
			out.items = items.every((i) => JSON.stringify(i) === JSON.stringify(items[0])) ? items[0] : items;
			continue;
		}
		out[key] = compactNode(value);
	}
	if (Array.isArray(out.enum) && out.enum.length > MAX_ENUM) delete out.enum;
	return Array.isArray(out.anyOf) ? compactUnion(out) : out;
}

/** A schema over this many characters advertises its nested fields by name and type only. */
const MAX_SCHEMA_CHARS = 6000;

/** Drops what nested fields say about themselves; top-level parameters keep their descriptions. */
function withoutNestedDescriptions(node: unknown, depth: number): unknown {
	if (Array.isArray(node)) return node.map((n) => withoutNestedDescriptions(n, depth));
	if (!isObject(node)) return node;
	const out: Json = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === 'description' && depth > 1) continue;
		if (key === 'properties' && isObject(value))
			out.properties = Object.fromEntries(
				Object.entries(value).map(([k, v]) => [k, withoutNestedDescriptions(v, depth + 1)]),
			);
		else out[key] = withoutNestedDescriptions(value, depth);
	}
	return out;
}

/** Objects this deep read as plain objects: a wrong key still gets a refusal that lists the accepted ones. */
function withoutDeepObjects(node: unknown, depth: number): unknown {
	if (Array.isArray(node)) return node.map((n) => withoutDeepObjects(n, depth));
	if (!isObject(node)) return node;
	if (depth > 2 && isObject(node.properties)) {
		const { properties: _properties, required: _required, ...rest } = node;
		return rest;
	}
	const out: Json = {};
	for (const [key, value] of Object.entries(node))
		out[key] =
			key === 'properties' && isObject(value)
				? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutDeepObjects(v, depth + 1)]))
				: withoutDeepObjects(value, depth);
	return out;
}

/** The advertised form of a tool's input schema. */
export function compactInputSchema<T>(schema: T): T {
	const compact = compactNode(schema);
	if (JSON.stringify(compact).length <= MAX_SCHEMA_CHARS) return compact as T;
	const shallow = withoutNestedDescriptions(compact, 0);
	if (JSON.stringify(shallow).length <= MAX_SCHEMA_CHARS) return shallow as T;
	return withoutDeepObjects(shallow, 0) as T;
}
