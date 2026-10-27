// Unknown-key detection for agent input (docs/wp-notes/mcp-cli.md §1): walks a value against a zod schema
// and reports the keys no fixed-shape object accepts, with the accepted ones and typo suggestions. Shared by
// jasper-mcp (tool arguments) and the agent transaction path (command arguments, nested objects included:
// command schemas strip unknown nested keys, which would otherwise be dropped silently).
import { z } from 'zod';
import { COMMAND_CATALOG, isCommandType } from '../commands/catalog.ts';
import type { Issue } from '../commands/types.ts';

type AnySchema = z.ZodType;
type Def = Record<string, unknown> & { type: string };

const defOf = (s: unknown): Def | null => {
	const d = (s as { _zod?: { def?: Def } } | null)?._zod?.def;
	return d && typeof d.type === 'string' ? d : null;
};

/**
 * Marks an object whose extra keys are validated elsewhere (e.g. apply_commands' commands, checked against
 * each command's own schema), so strictness keeps it open: `z.looseObject({...}).meta(OPEN_OBJECT)`.
 */
export const OPEN_OBJECT = { 'x-jasper-open': true } as const;
export const isOpenObject = (s: AnySchema) => z.globalRegistry.get(s)?.['x-jasper-open'] === true;
/** `looseObject` / `.passthrough()`: a catchall that takes anything. */
export const isAnyCatchall = (c: AnySchema) => {
	const t = defOf(c)?.type;
	return t === 'unknown' || t === 'any';
};

export const SCHEMA_WRAPPERS: ReadonlySet<string> = new Set([
	'optional',
	'nullable',
	'default',
	'prefault',
	'readonly',
	'catch',
	'nonoptional',
]);

export type UnknownKeys = { path: string; keys: string[]; accepted: string[] };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === 'object' && !Array.isArray(v);

export const keyPathText = (p: readonly (string | number)[]) =>
	p.length ? p.map((x, i) => (typeof x === 'number' ? `[${x}]` : i ? `.${x}` : x)).join('') : '';

/** Issues of `schema` on `value` other than unknown keys (to pick the union option meant). */
function otherIssues(schema: AnySchema, value: unknown): number {
	const r = schema.safeParse(value);
	if (r.success) return 0;
	return r.error.issues.filter((i) => i.code !== 'unrecognized_keys').length;
}

/**
 * Walks `value` against `schema` and collects the keys no fixed-shape object accepts. Objects that strip
 * (`z.object`) or pass through (`looseObject`) unknown keys count as closed unless marked OPEN_OBJECT; a
 * typed catchall and records accept any key. In unions the option the caller meant is the one whose only
 * problems are unknown keys.
 */
export function findUnknownKeys(
	schema: AnySchema,
	value: unknown,
	path: (string | number)[] = [],
	out: UnknownKeys[] = [],
	depth = 0,
): UnknownKeys[] {
	const def = defOf(schema);
	if (!def || depth > 64) return out;
	if (SCHEMA_WRAPPERS.has(def.type)) {
		if (value === undefined || value === null) return out;
		return findUnknownKeys(def.innerType as AnySchema, value, path, out, depth + 1);
	}
	switch (def.type) {
		case 'lazy':
			return findUnknownKeys((def.getter as () => AnySchema)(), value, path, out, depth + 1);
		case 'pipe':
			return findUnknownKeys(def.in as AnySchema, value, path, out, depth + 1);
		case 'object': {
			if (!isPlainObject(value)) return out;
			const shape = def.shape as Record<string, AnySchema>;
			const catchall = def.catchall as AnySchema | undefined;
			const open =
				!!catchall && defOf(catchall)?.type !== 'never' && (!isAnyCatchall(catchall) || isOpenObject(schema));
			const extra = Object.keys(value).filter((k) => !(k in shape));
			if (extra.length && !open)
				out.push({ path: keyPathText(path), keys: extra, accepted: Object.keys(shape) });
			for (const [k, v] of Object.entries(value)) {
				if (k in shape) findUnknownKeys(shape[k]!, v, [...path, k], out, depth + 1);
				else if (open && !isAnyCatchall(catchall!))
					findUnknownKeys(catchall!, v, [...path, k], out, depth + 1);
			}
			return out;
		}
		case 'array':
			if (Array.isArray(value))
				for (const [i, v] of value.entries())
					findUnknownKeys(def.element as AnySchema, v, [...path, i], out, depth + 1);
			return out;
		case 'tuple':
			if (Array.isArray(value)) {
				const items = def.items as AnySchema[];
				const rest = def.rest as AnySchema | null | undefined;
				value.forEach((v, i) => {
					const s = items[i] ?? rest;
					if (s) findUnknownKeys(s, v, [...path, i], out, depth + 1);
				});
			}
			return out;
		case 'record':
			if (isPlainObject(value))
				for (const [k, v] of Object.entries(value))
					findUnknownKeys(def.valueType as AnySchema, v, [...path, k], out, depth + 1);
			return out;
		case 'union': {
			let best: { found: UnknownKeys[]; score: number } | null = null;
			for (const s of def.options as AnySchema[]) {
				const issues = otherIssues(s, value);
				const found = findUnknownKeys(s, value, path, [], depth + 1);
				const score = issues * 1000 + found.reduce((n, f) => n + f.keys.length, 0);
				if (!best || score < best.score) best = { found, score };
			}
			if (best && best.score < 1000) out.push(...best.found);
			return out;
		}
		default:
			return out;
	}
}

const eq = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();

function distance(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array<number>(n).fill(0)]);
	for (let j = 1; j <= n; j++) d[0]![j] = j;
	for (let i = 1; i <= m; i++)
		for (let j = 1; j <= n; j++) {
			d[i]![j] = Math.min(
				d[i - 1]![j]! + 1,
				d[i]![j - 1]! + 1,
				d[i - 1]![j - 1]! + (eq(a[i - 1]!, b[j - 1]!) ? 0 : 1),
			);
			// Damerau: an adjacent transposition ("nmae" → "name") is one edit.
			if (i > 1 && j > 1 && eq(a[i - 1]!, b[j - 2]!) && eq(a[i - 2]!, b[j - 1]!))
				d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
		}
	return d[m]![n]!;
}

/** The accepted key closest to `key`, when it is plausibly a typo. */
function suggestKey(key: string, accepted: readonly string[]): string | undefined {
	let best: { k: string; d: number } | undefined;
	for (const k of accepted) {
		const dist = distance(key, k);
		if (!best || dist < best.d) best = { k, d: dist };
	}
	if (!best) return undefined;
	const limit = Math.max(1, Math.floor(Math.max(key.length, best.k.length) / 3));
	if (best.d <= limit) return best.k;
	const lk = key.toLowerCase();
	return accepted.find(
		(a) => a.length >= 3 && lk.length >= 3 && (a.toLowerCase().includes(lk) || lk.includes(a.toLowerCase())),
	);
}

/** "accepts: a, b, c (did you mean "x" → "y"?)" for one UnknownKeys entry. */
export function acceptedKeysText(f: UnknownKeys): string {
	const sugg = f.keys
		.map((k) => [k, suggestKey(k, f.accepted)] as const)
		.filter(([, s]) => s)
		.map(([k, s]) => `"${k}" → "${s}"?`);
	return `${f.accepted.join(', ') || '(nothing)'}${sugg.length ? ` (did you mean ${sugg.join(', ')})` : ''}`;
}

export const TEMP_REF_HINT =
	'An id created earlier in the same transaction is referenced as "$name" after that command declared `ref: "$name"`.';

/**
 * Unknown keys in agent commands, nested objects included (E_SCHEMA issues naming the keys, the accepted
 * ones and a typo suggestion). Command types that are not in the catalogue are left to `applyTransaction`.
 */
export function unknownCommandKeyIssues(commands: readonly unknown[]): Issue[] {
	const issues: Issue[] = [];
	commands.forEach((c, i) => {
		const type = (c as { type?: unknown })?.type;
		if (!isCommandType(type)) return;
		for (const f of findUnknownKeys(COMMAND_CATALOG[type].schema as AnySchema, c)) {
			const where = f.path ? ` in ${f.path}` : '';
			const refs = f.accepted.includes('ref') || f.keys.some((k) => k.startsWith('$'));
			issues.push({
				commandIndex: i,
				code: 'E_SCHEMA',
				message: `${type}: unknown key${f.keys.length > 1 ? 's' : ''} ${f.keys.map((k) => `"${k}"`).join(', ')}${where}; ${f.path || type} accepts: ${acceptedKeysText(f)}.${refs ? ` ${TEMP_REF_HINT}` : ''}`,
				path: f.path ? f.path.split('.') : [],
			});
		}
	});
	return issues;
}
