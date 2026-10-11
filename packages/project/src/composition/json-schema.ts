// A small JSON Schema validator and the defaultProps inference of S08:MGC-011 (motion-graphics composition
// props). Pure and dependency-free: runs in the browser, the engine and the headless agent path.
//
// Supported keywords (draft 2020-12 / draft-07 as produced by `z.toJSONSchema` and `zod-to-json-schema`):
// type (incl. "integer" and type arrays), enum, const, anyOf, oneOf, allOf, not, $ref (local `#/…` pointers,
// `$defs` and `definitions`), properties, required, additionalProperties, patternProperties,
// propertyNames, minProperties/maxProperties, items (schema or draft-07 tuple array), prefixItems,
// additionalItems, minItems, maxItems, uniqueItems, contains, minLength, maxLength, pattern, format (only
// checked for the colour formats below), minimum, maximum, exclusiveMinimum, exclusiveMaximum (number and
// draft-04 boolean forms), multipleOf. Unknown keywords are ignored (open world, like the spec).

export type JsonSchemaNode = Record<string, unknown>;
export type SchemaIssue = { path: string; message: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The JSON type name of a value (`integer` is reported as `number`; checked separately). */
function typeOf(v: unknown): string {
	if (v === null) return 'null';
	if (Array.isArray(v)) return 'array';
	return typeof v;
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a)) {
		const bb = b as unknown[];
		return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
	}
	const ka = Object.keys(a as object);
	const kb = Object.keys(b as object);
	return (
		ka.length === kb.length &&
		ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
	);
}

/** Resolves a local `$ref` (`#`, `#/$defs/x`, `#/definitions/x`, any `#/a/b` pointer) against the root. */
function resolveSchemaRef(root: JsonSchemaNode, ref: string): JsonSchemaNode | boolean | undefined {
	if (!ref.startsWith('#')) return undefined;
	const parts = ref
		.slice(1)
		.split('/')
		.filter((p) => p !== '')
		.map((p) => decodeURIComponent(p.replace(/~1/g, '/').replace(/~0/g, '~')));
	let cur: unknown = root;
	for (const p of parts) {
		if (!isObj(cur) && !Array.isArray(cur)) return undefined;
		cur = (cur as Record<string, unknown>)[p];
	}
	return isObj(cur) || typeof cur === 'boolean' ? cur : undefined;
}

/** Follows `$ref` chains (at most 32 hops) and returns the target schema. */
export function derefSchema(
	root: JsonSchemaNode,
	s: JsonSchemaNode | boolean | undefined,
): JsonSchemaNode | boolean | undefined {
	let cur = s;
	for (let i = 0; i < 32 && isObj(cur) && typeof cur.$ref === 'string'; i++) {
		const next = resolveSchemaRef(root, cur.$ref);
		if (next === undefined) return cur;
		// Draft 2020-12: sibling keywords apply next to $ref; merge them over the target (object targets only).
		const { $ref: _r, ...rest } = cur;
		cur = isObj(next) && Object.keys(rest).length ? { ...next, ...rest } : next;
	}
	return cur;
}

const pathStr = (path: readonly (string | number)[]) => (path.length ? path.join('.') : '(root)');

/** Validates `value` against `schema`; returns the issues (empty = valid). Stops after 50 issues. */
export function validateJsonSchema(schema: JsonSchemaNode | boolean, value: unknown): SchemaIssue[] {
	const issues: SchemaIssue[] = [];
	const root = isObj(schema) ? schema : {};
	visit(root, schema, value, [], issues, 0);
	return issues.slice(0, 50);
}

function visit(
	root: JsonSchemaNode,
	schema0: JsonSchemaNode | boolean | undefined,
	v: unknown,
	path: (string | number)[],
	out: SchemaIssue[],
	depth: number,
): void {
	if (out.length >= 50 || depth > 64) return;
	const schema = derefSchema(root, schema0);
	if (schema === undefined || schema === true) return;
	if (schema === false) {
		out.push({ path: pathStr(path), message: 'no value is allowed here' });
		return;
	}
	const s = schema;
	const push = (message: string) => out.push({ path: pathStr(path), message });
	const t = typeOf(v);

	if (s.type !== undefined) {
		const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
		const ok = types.some((ty) => (ty === 'integer' ? t === 'number' && Number.isInteger(v) : ty === t));
		if (!ok) {
			push(`expected ${types.join(' or ')}, got ${t}`);
			return;
		}
	}
	if (Array.isArray(s.enum) && !s.enum.some((e) => deepEqual(e, v)))
		push(`must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`);
	if ('const' in s && !deepEqual(s.const, v)) push(`must be ${JSON.stringify(s.const)}`);

	if (Array.isArray(s.allOf))
		for (const sub of s.allOf) visit(root, sub as JsonSchemaNode, v, path, out, depth + 1);
	if (Array.isArray(s.anyOf)) {
		const ok = s.anyOf.some((sub) => {
			const tmp: SchemaIssue[] = [];
			visit(root, sub as JsonSchemaNode, v, path, tmp, depth + 1);
			return tmp.length === 0;
		});
		if (!ok) push('does not match any allowed shape');
	}
	if (Array.isArray(s.oneOf)) {
		const n = s.oneOf.filter((sub) => {
			const tmp: SchemaIssue[] = [];
			visit(root, sub as JsonSchemaNode, v, path, tmp, depth + 1);
			return tmp.length === 0;
		}).length;
		if (n !== 1) push(n === 0 ? 'does not match any allowed shape' : 'matches more than one shape');
	}
	if (s.not !== undefined) {
		const tmp: SchemaIssue[] = [];
		visit(root, s.not as JsonSchemaNode, v, path, tmp, depth + 1);
		if (tmp.length === 0) push('matches a forbidden shape');
	}

	if (t === 'number') {
		const n = v as number;
		const num = (k: string) => (typeof s[k] === 'number' ? (s[k] as number) : undefined);
		const min = num('minimum');
		const max = num('maximum');
		if (min !== undefined && (s.exclusiveMinimum === true ? n <= min : n < min))
			push(`must be ${s.exclusiveMinimum === true ? '>' : '>='} ${min}`);
		if (max !== undefined && (s.exclusiveMaximum === true ? n >= max : n > max))
			push(`must be ${s.exclusiveMaximum === true ? '<' : '<='} ${max}`);
		const xmin = num('exclusiveMinimum');
		const xmax = num('exclusiveMaximum');
		if (xmin !== undefined && n <= xmin) push(`must be > ${xmin}`);
		if (xmax !== undefined && n >= xmax) push(`must be < ${xmax}`);
		const mul = num('multipleOf');
		if (mul !== undefined && mul > 0 && Math.abs(n / mul - Math.round(n / mul)) > 1e-9)
			push(`must be a multiple of ${mul}`);
		if (!Number.isFinite(n)) push('must be a finite number');
	}
	if (t === 'string') {
		const str = v as string;
		const len = [...str].length;
		if (typeof s.minLength === 'number' && len < s.minLength)
			push(`must have at least ${s.minLength} characters`);
		if (typeof s.maxLength === 'number' && len > s.maxLength)
			push(`must have at most ${s.maxLength} characters`);
		if (typeof s.pattern === 'string') {
			let re: RegExp | null = null;
			try {
				re = new RegExp(s.pattern, 'u');
			} catch {
				re = null;
			}
			if (re && !re.test(str)) push(`must match ${s.pattern}`);
		}
		if (s.format === 'color' && !isCssColor(str)) push('must be a CSS colour');
	}
	if (t === 'array') {
		const arr = v as unknown[];
		if (typeof s.minItems === 'number' && arr.length < s.minItems)
			push(`must have at least ${s.minItems} items`);
		if (typeof s.maxItems === 'number' && arr.length > s.maxItems)
			push(`must have at most ${s.maxItems} items`);
		if (s.uniqueItems === true) {
			for (let i = 0; i < arr.length; i++)
				for (let j = i + 1; j < arr.length; j++)
					if (deepEqual(arr[i], arr[j])) {
						push('items must be unique');
						i = arr.length;
						break;
					}
		}
		let tuple = 0;
		if (Array.isArray(s.prefixItems)) {
			tuple = s.prefixItems.length;
			s.prefixItems.forEach((sub, i) => {
				if (i < arr.length) visit(root, sub as JsonSchemaNode, arr[i], [...path, i], out, depth + 1);
			});
		}
		if (Array.isArray(s.items)) {
			// draft-07 tuple form
			tuple = s.items.length;
			s.items.forEach((sub, i) => {
				if (i < arr.length) visit(root, sub as JsonSchemaNode, arr[i], [...path, i], out, depth + 1);
			});
			if (s.additionalItems !== undefined)
				for (let i = tuple; i < arr.length; i++)
					visit(root, s.additionalItems as JsonSchemaNode, arr[i], [...path, i], out, depth + 1);
		} else if (s.items !== undefined) {
			for (let i = tuple; i < arr.length; i++)
				visit(root, s.items as JsonSchemaNode, arr[i], [...path, i], out, depth + 1);
		}
		if (s.contains !== undefined) {
			const ok = arr.some((x, i) => {
				const tmp: SchemaIssue[] = [];
				visit(root, s.contains as JsonSchemaNode, x, [...path, i], tmp, depth + 1);
				return tmp.length === 0;
			});
			if (!ok) push('must contain a matching item');
		}
	}
	if (t === 'object') {
		const o = v as Record<string, unknown>;
		const keys = Object.keys(o);
		if (typeof s.minProperties === 'number' && keys.length < s.minProperties)
			push(`must have at least ${s.minProperties} properties`);
		if (typeof s.maxProperties === 'number' && keys.length > s.maxProperties)
			push(`must have at most ${s.maxProperties} properties`);
		if (Array.isArray(s.required))
			for (const k of s.required as string[])
				if (!(k in o) || o[k] === undefined)
					out.push({ path: pathStr([...path, k]), message: 'is required' });
		const props = isObj(s.properties) ? s.properties : {};
		const patterns: [RegExp, unknown][] = [];
		if (isObj(s.patternProperties)) {
			for (const [p, sub] of Object.entries(s.patternProperties)) {
				try {
					patterns.push([new RegExp(p, 'u'), sub]);
				} catch {
					// invalid pattern: ignored
				}
			}
		}
		for (const k of keys) {
			if (o[k] === undefined) continue;
			let matched = false;
			if (k in props) {
				matched = true;
				visit(root, props[k] as JsonSchemaNode, o[k], [...path, k], out, depth + 1);
			}
			for (const [re, sub] of patterns) {
				if (re.test(k)) {
					matched = true;
					visit(root, sub as JsonSchemaNode, o[k], [...path, k], out, depth + 1);
				}
			}
			if (!matched && s.additionalProperties !== undefined) {
				if (s.additionalProperties === false)
					out.push({ path: pathStr([...path, k]), message: 'is not an allowed property' });
				else visit(root, s.additionalProperties as JsonSchemaNode, o[k], [...path, k], out, depth + 1);
			}
			if (s.propertyNames !== undefined) {
				const tmp: SchemaIssue[] = [];
				visit(root, s.propertyNames as JsonSchemaNode, k, [...path, k], tmp, depth + 1);
				if (tmp.length) out.push({ path: pathStr([...path, k]), message: 'has an invalid name' });
			}
		}
	}
}

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FN_COLOR = /^(?:rgba?|hsla?)\(\s*[-\d.%\s,/]+\)$/i;

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()/rgba()/hsl()/hsla()` strings. */
export function isCssColor(s: string): boolean {
	const v = s.trim();
	return HEX_COLOR.test(v) || FN_COLOR.test(v);
}

const ASSET_EXT =
	/\.(?:png|jpe?g|gif|webp|avif|svg|bmp|tiff?|mp4|mov|m4v|webm|mkv|avi|mp3|wav|aac|m4a|ogg|flac|opus|json|lottie)$/i;

/** UI control hints of a composition's props (manifest `ui`, or inferred). Keys are dotted prop paths. */
export type PropsUiHint = {
	control?: 'color' | 'text' | 'textarea' | 'slider' | 'asset' | 'number' | 'toggle' | 'select' | 'json';
	label?: string;
	min?: number;
	max?: number;
	step?: number;
	[k: string]: unknown;
};
export type PropsUiHints = Record<string, PropsUiHint>;

function inferValue(v: unknown, path: string, ui: PropsUiHints, depth: number): JsonSchemaNode {
	if (v === null || v === undefined || depth > 16) return {};
	switch (typeof v) {
		case 'string': {
			if (isCssColor(v)) ui[path] = { control: 'color' };
			else if (ASSET_EXT.test(v.trim()) && !/\s/.test(v.trim())) ui[path] = { control: 'asset' };
			else if (v.length > 80 || v.includes('\n')) ui[path] = { control: 'textarea' };
			return { type: 'string' };
		}
		case 'number':
			return { type: Number.isInteger(v) ? 'integer' : 'number' };
		case 'boolean':
			return { type: 'boolean' };
		case 'object': {
			if (Array.isArray(v)) {
				const kinds = new Set(v.map((x) => typeOf(x)));
				if (v.length > 0 && kinds.size === 1 && !kinds.has('object') && !kinds.has('array')) {
					const k = [...kinds][0]!;
					const allInt = k === 'number' && v.every((x) => Number.isInteger(x));
					return { type: 'array', items: { type: allInt ? 'integer' : k } };
				}
				return { type: 'array' };
			}
			const properties: Record<string, JsonSchemaNode> = {};
			for (const [k, x] of Object.entries(v as Record<string, unknown>))
				properties[k] = inferValue(x, path ? `${path}.${k}` : k, ui, depth + 1);
			return { type: 'object', properties };
		}
		default:
			return {};
	}
}

/**
 * JSON Schema inferred from a composition's `defaultProps` (S08:MGC-011 §3): strings → text (textarea when
 * long or multiline, colour for CSS colours, asset for media paths), numbers → number/integer, booleans,
 * arrays of one primitive type → list, objects → nested groups. Unknown shapes stay editable as JSON.
 * The schema is permissive (no `required`, extra properties allowed) — it drives the form, not strict checks.
 */
export function inferPropsSchema(defaultProps: Record<string, unknown>): {
	schema: JsonSchemaNode;
	ui: PropsUiHints;
} {
	const ui: PropsUiHints = {};
	const schema = inferValue(defaultProps ?? {}, '', ui, 0);
	return { schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', ...schema }, ui };
}

/** UI hints derivable from an explicit schema (colour formats/patterns, long strings). */
export function schemaUiHints(schema: JsonSchemaNode, defaults: Record<string, unknown> = {}): PropsUiHints {
	const ui: PropsUiHints = {};
	const walk = (s0: JsonSchemaNode | boolean | undefined, path: string, dflt: unknown, depth: number) => {
		const s = derefSchema(schema, s0);
		if (!isObj(s) || depth > 16) return;
		const props = isObj(s.properties) ? s.properties : null;
		if (props) {
			for (const [k, sub] of Object.entries(props))
				walk(sub as JsonSchemaNode, path ? `${path}.${k}` : k, isObj(dflt) ? dflt[k] : undefined, depth + 1);
			return;
		}
		if (!path) return;
		const hex = typeof s.pattern === 'string' && /^\^?#/.test(s.pattern);
		if (s.format === 'color' || hex || (typeof dflt === 'string' && isCssColor(dflt) && s.type === 'string'))
			ui[path] = { control: 'color' };
		else if (s.type === 'string' && typeof s.maxLength === 'number' && s.maxLength > 120)
			ui[path] = { control: 'textarea' };
	};
	walk(schema, '', defaults, 0);
	return ui;
}
