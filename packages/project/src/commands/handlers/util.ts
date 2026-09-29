// Small helpers shared by handler files.
import type { CommandOf, CommandType } from '../schemas/index.ts';
import type { DDoc, HandlerContext } from '../context.ts';

export type Handler<T extends CommandType> = (doc: DDoc, cmd: CommandOf<T>, h: HandlerContext) => unknown;
export type HandlerMap = { [T in CommandType]?: Handler<T> };

/** Handler for a command whose implementation belongs to another work package or milestone. */
export function notImplemented<T extends CommandType>(type: T, owner: string): Handler<T> {
	return (_doc, _cmd, h) => h.fail('E_NOT_IMPLEMENTED', `${type} is not implemented yet (${owner})`);
}

/** Resolved id list (after `$selection` substitution the schema's union is always an array). */
export function idList(v: readonly string[] | '$selection' | undefined): string[] {
	if (v === undefined) return [];
	if (v === '$selection') return [];
	return [...new Set(v)];
}
