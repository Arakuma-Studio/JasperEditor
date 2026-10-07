// Strict tool arguments (docs/wp-notes/mcp-cli.md §1): every tool rejects unknown argument keys, at the top
// level and inside nested objects, with an error that names them and lists the accepted ones. Applies to
// every tool registered on the server, whoever registers it:
//   - `strictInputSchema` turns a tool's input shape into a deep-strict zod object, so `tools/list`
//     advertises `additionalProperties: false` on every fixed-shape object;
//   - `installStrictValidation` replaces the SDK's argument validation for the whole server: unknown keys
//     are found first (with "did you mean" suggestions), then the schema is checked; both failures come
//     back as `isError` results with the same `{error: {code, message, hint, details}}` body as every
//     other tool error (the SDK turns any thrown error during `tools/call` into such a result).
import {
	acceptedKeysText,
	findUnknownKeys,
	isAnyCatchall,
	isOpenObject,
	keyPathText,
	SCHEMA_WRAPPERS,
	TEMP_REF_HINT,
	type UnknownKeys,
} from '@jasper/project';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export { OPEN_OBJECT, suggestKey } from '@jasper/project';

type AnySchema = z.ZodType;
type Def = Record<string, unknown> & { type: string };

const defOf = (s: unknown): Def | null => {
	const d = (s as { _zod?: { def?: Def } } | null)?._zod?.def;
	return d && typeof d.type === 'string' ? d : null;
};

/** Copies registry metadata (description, title, examples) from `from` to its rebuilt copy. */
function withMeta<T extends AnySchema>(to: T, from: AnySchema): T {
	const meta = z.globalRegistry.get(from);
	if (meta && !z.globalRegistry.has(to)) z.globalRegistry.add(to, meta);
	return to;
}

const WRAPPERS = SCHEMA_WRAPPERS;
const isOpen = isOpenObject;

/**
 * A copy of `schema` in which every object that would silently strip or pass through unknown keys rejects
 * them instead (`looseObject` too, unless marked OPEN_OBJECT). Objects with a typed catchall
 * (`.catchall(x)`), records, intersections, pipes (transforms) and lazy schemas keep their behaviour; their
 * fixed-shape descendants are still made strict where they can be rebuilt safely.
 */
export function deepStrict<T extends AnySchema>(schema: T, seen = new Map<AnySchema, AnySchema>()): T {
	const done = seen.get(schema);
	if (done) return done as T;
	const def = defOf(schema);
	if (!def) return schema;
	let out: AnySchema = schema;
	if (def.type === 'object') {
		const shape = def.shape as Record<string, AnySchema>;
		const next: Record<string, AnySchema> = {};
		let changed = false;
		for (const [k, v] of Object.entries(shape)) {
			next[k] = deepStrict(v, seen);
			if (next[k] !== v) changed = true;
		}
		const catchall = def.catchall as AnySchema | undefined;
		// clone keeps the object's own checks (refinements) and options; only shape / catchall change.
		const clone = (d: Def) => (schema as unknown as { clone(d: Def): AnySchema }).clone(d);
		if (!catchall || (isAnyCatchall(catchall) && !isOpen(schema)))
			out = clone({ ...def, shape: next, catchall: z.never() });
		else if (changed) out = clone({ ...def, shape: next });
	} else if (WRAPPERS.has(def.type)) {
		const inner = def.innerType as AnySchema;
		const s = deepStrict(inner, seen);
		if (s !== inner)
			out = (schema as unknown as { clone(d: Def): AnySchema }).clone({ ...def, innerType: s });
	} else if (def.type === 'array') {
		const el = def.element as AnySchema;
		const s = deepStrict(el, seen);
		if (s !== el) out = (schema as unknown as { clone(d: Def): AnySchema }).clone({ ...def, element: s });
	} else if (def.type === 'union') {
		const options = def.options as AnySchema[];
		const next = options.map((o) => deepStrict(o, seen));
		if (next.some((o, i) => o !== options[i]))
			out = (schema as unknown as { clone(d: Def): AnySchema }).clone({ ...def, options: next });
	} else if (def.type === 'record') {
		const v = def.valueType as AnySchema;
		const s = deepStrict(v, seen);
		if (s !== v) out = (schema as unknown as { clone(d: Def): AnySchema }).clone({ ...def, valueType: s });
	} else if (def.type === 'tuple') {
		const items = def.items as AnySchema[];
		const next = items.map((o) => deepStrict(o, seen));
		const rest = def.rest as AnySchema | null | undefined;
		const r = rest ? deepStrict(rest, seen) : rest;
		if (next.some((o, i) => o !== items[i]) || r !== rest)
			out = (schema as unknown as { clone(d: Def): AnySchema }).clone({ ...def, items: next, rest: r });
	}
	if (out !== schema) withMeta(out, schema);
	seen.set(schema, out);
	return out as T;
}

/** The deep-strict input schema of a tool from its zod raw shape. */
export function strictInputSchema(shape: Record<string, AnySchema>): z.ZodObject {
	return deepStrict(z.object(shape)) as unknown as z.ZodObject;
}

export type ArgumentError = { code: string; message: string; hint: string; details: unknown };

/** The error for unknown argument keys of a tool. */
export function unknownArgumentsError(tool: string, found: UnknownKeys[]): ArgumentError {
	const parts = found.map((f) => {
		const where = f.path ? ` in ${f.path}` : '';
		const keys = f.keys.map((k) => `"${k}"`).join(', ');
		return `unknown argument${f.keys.length > 1 ? 's' : ''} ${keys}${where}`;
	});
	const hints = found.map((f) => `${f.path ? f.path : tool} accepts: ${acceptedKeysText(f)}.`);
	const refs = found.some((f) => f.keys.some((k) => k.startsWith('$')) || f.accepted.includes('ref'));
	return {
		code: 'E_UNKNOWN_ARGUMENT',
		message: `${tool}: ${parts.join('; ')}`,
		hint: `${hints.join(' ')}${refs ? ` ${TEMP_REF_HINT}` : ''} Unknown keys are rejected, never ignored.`,
		details: { unknown: found },
	};
}

/** The error for arguments that do not match a tool's schema. */
export function invalidArgumentsError(tool: string, schema: AnySchema, error: z.ZodError): ArgumentError {
	const issues = error.issues.slice(0, 8).map((i) => ({
		path: keyPathText(i.path as (string | number)[]),
		message: i.message,
	}));
	const shape = defOf(schema)?.type === 'object' ? Object.keys(defOf(schema)!.shape as object) : [];
	const required = shape.filter((k) => {
		const s = (defOf(schema)!.shape as Record<string, AnySchema>)[k]!;
		return !s.safeParse(undefined).success;
	});
	return {
		code: 'E_INVALID_ARGUMENT',
		message: `${tool}: ${issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ')}`,
		hint: `Check the tool's input schema (tools/list). ${tool} accepts: ${shape.join(', ') || '(no arguments)'}${
			required.length ? `; required: ${required.join(', ')}` : ''
		}. Times accept frames, {"seconds": x} or "HH:MM:SS:FF".`,
		details: { issues },
	};
}

/** Validates tool arguments: unknown keys first, then the schema. Throws the JSON error body. */
export async function validateArguments(tool: string, schema: AnySchema, args: unknown): Promise<unknown> {
	const value = args ?? {};
	const unknown = findUnknownKeys(schema, value);
	if (unknown.length) throw new ArgumentValidationError(unknownArgumentsError(tool, unknown));
	const r = await schema.safeParseAsync(value);
	if (!r.success) throw new ArgumentValidationError(invalidArgumentsError(tool, schema, r.error));
	return r.data;
}

/** Thrown during `tools/call`; its message is the JSON error body the client receives (`isError`). */
export class ArgumentValidationError extends Error {
	constructor(readonly body: ArgumentError) {
		super(JSON.stringify({ error: body }));
		this.name = 'ArgumentValidationError';
	}
}

type ValidatingServer = {
	validateToolInput?: (tool: { inputSchema?: AnySchema }, args: unknown, name: string) => Promise<unknown>;
};

/**
 * Replaces the SDK's argument validation for every tool of `server` (also tools registered without
 * `defineTool`). Throws at start-up if the SDK no longer has the hook, so a dependency update cannot
 * silently drop strictness (a unit test covers it too).
 */
export function installStrictValidation(server: McpServer): void {
	const s = server as unknown as ValidatingServer;
	if (typeof s.validateToolInput !== 'function')
		throw new Error('The MCP SDK no longer exposes validateToolInput: update apps/mcp/src/strict.ts');
	s.validateToolInput = async (tool, args, name) => {
		if (!tool.inputSchema) return undefined;
		return validateArguments(name, tool.inputSchema, args);
	};
}
