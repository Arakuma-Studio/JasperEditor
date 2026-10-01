// Small helpers shared by handler files.

import type { DDoc, HandlerContext } from '../context.ts';
import type { CommandOf, CommandType } from '../schemas/index.ts';

export type Handler<T extends CommandType> = (doc: DDoc, cmd: CommandOf<T>, h: HandlerContext) => unknown;
export type HandlerMap = { [T in CommandType]?: Handler<T> };

const STUBS = new WeakSet<object>();

/** Handler for a command whose implementation belongs to another work package or milestone. */
export function notImplemented<T extends CommandType>(type: T, owner: string): Handler<T> {
	const stub: Handler<T> = (_doc, _cmd, h) =>
		h.fail('E_NOT_IMPLEMENTED', `${type} is not implemented yet (${owner})`);
	STUBS.add(stub);
	return stub;
}

/**
 * Refuses one field of an otherwise implemented command whose implementation belongs to another work package
 * (M2, ARCHITECTURE §20.1; owners are listed in `COMMAND_FIELD_OWNERS`).
 */
export function patchFieldNotImplemented(
	h: HandlerContext,
	type: CommandType,
	field: string,
	owner: string,
): never {
	return h.fail('E_NOT_IMPLEMENTED', `${type} ${field} is not implemented yet (${owner})`, { path: [field] });
}

/** True when the handler is a `notImplemented()` stub (drives `implemented` in the agent schema). */
export function isNotImplementedHandler(handler: unknown): boolean {
	return typeof handler === 'function' && STUBS.has(handler);
}

/** Resolved id list (after `$selection` substitution the schema's union is always an array). */
export function idList(v: readonly string[] | '$selection' | undefined): string[] {
	if (v === undefined) return [];
	if (v === '$selection') return [];
	return [...new Set(v)];
}
