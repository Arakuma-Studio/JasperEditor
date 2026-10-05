// applyTransaction: validates, resolves refs, runs handlers atomically with Immer, checks invariants,
// applies the expectedRevision fast-forward rule and reports created/changed/deleted
// (S01:CMD-004…006, AGT-010, AGT-011; ARCHITECTURE §5.3).
import { produce } from 'immer';
import { z } from 'zod';
import { looksLikeId } from '../ids.ts';
import { checkInvariants } from '../invariants.ts';
import type { ProjectDocument } from '../schema/document.ts';
import { COMMAND_CATALOG, isCommandType } from './catalog.ts';
import { HandlerContext, substituteRefs } from './context.ts';
import { diffDocuments } from './diff.ts';
import { collectOrphans } from './handlers/project.ts';
import { compressionWarnings } from './handlers/text-animation.ts';
import type { Command } from './schemas/index.ts';
import {
	type CommandContext,
	CommandError,
	type Issue,
	type Origin,
	type TransactionResult,
	TX_PROTOCOL,
} from './types.ts';

export const DEFAULT_MAX_COMMANDS = 5000;

const OriginSchema = z.union([
	z.literal('user'),
	z.literal('system'),
	z.literal('migration'),
	z.strictObject({ agent: z.string().min(1), runId: z.string().optional() }),
]);

/** Transaction envelope (S01:CMD-005). Commands are validated individually against the catalog. */
export const TransactionSchema = z.strictObject({
	protocol: z.literal(TX_PROTOCOL),
	label: z.string(),
	origin: OriginSchema,
	expectedRevision: z.number().int().min(0).optional(),
	dryRun: z.boolean().optional(),
	sequenceId: z.string().optional(),
	commands: z.array(z.record(z.string(), z.unknown())),
});

export type Transaction = {
	protocol: typeof TX_PROTOCOL;
	label: string;
	origin: Origin;
	expectedRevision?: number;
	dryRun?: boolean;
	sequenceId?: string;
	commands: Command[];
};

/** Transaction without `protocol` (filled in by callers such as EditorSession.apply). */
export type TxInput = Omit<Transaction, 'protocol'> & { protocol?: typeof TX_PROTOCOL };

const zodPath = (p: readonly PropertyKey[]) => p.map((x) => String(x));

function fail(revision: number, errors: Issue[]): { ok: false; revision: number; errors: Issue[] } {
	return { ok: false, revision, errors };
}

/** Parses and validates every command; returns typed commands or the schema issues. */
function validateCommands(raw: readonly unknown[]): { commands: Command[]; errors: Issue[] } {
	const errors: Issue[] = [];
	const commands: Command[] = [];
	raw.forEach((c, i) => {
		const type = (c as { type?: unknown })?.type;
		if (!isCommandType(type)) {
			errors.push({
				commandIndex: i,
				code: 'E_SCHEMA',
				message: `Unknown command type ${JSON.stringify(type)}`,
				path: ['type'],
			});
			return;
		}
		const parsed = COMMAND_CATALOG[type].schema.safeParse(c);
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				errors.push({
					commandIndex: i,
					code: 'E_SCHEMA',
					message: `${type}: ${issue.message}`,
					path: zodPath(issue.path),
				});
			}
			return;
		}
		commands.push(parsed.data as Command);
	});
	return { commands, errors };
}

/** Ids a transaction reads or writes explicitly (for the AGT-010 fast-forward rule). */
function referencedIds(commands: readonly unknown[], extra: readonly string[] = []): Set<string> {
	const out = new Set(extra);
	const walk = (v: unknown) => {
		if (looksLikeId(v)) out.add(v);
		else if (Array.isArray(v)) v.forEach(walk);
		// A clipboard payload's ids belong to the copied content, an effect preset's to the library (S03:FX-030):
		// neither are entities the transaction touches.
		else if (v && typeof v === 'object')
			for (const [k, x] of Object.entries(v)) if (k !== 'payload' && k !== 'preset') walk(x);
	};
	commands.forEach(walk);
	return out;
}

/**
 * Applies a transaction atomically. Returns the input document reference when the transaction fails,
 * is a dry run, or changes nothing.
 */
export function applyTransaction(
	doc: ProjectDocument,
	txIn: unknown,
	ctx: CommandContext,
): { document: ProjectDocument; result: TransactionResult } {
	const envelope = TransactionSchema.safeParse({ protocol: TX_PROTOCOL, ...(txIn as object) });
	if (!envelope.success) {
		return {
			document: doc,
			result: fail(
				ctx.revision,
				envelope.error.issues.map((i) => ({
					commandIndex: -1,
					code: 'E_SCHEMA',
					message: i.message,
					path: zodPath(i.path),
				})),
			),
		};
	}
	const tx = envelope.data;
	const max = ctx.maxCommands ?? DEFAULT_MAX_COMMANDS;
	if (tx.commands.length > max) {
		return {
			document: doc,
			result: fail(ctx.revision, [
				{ commandIndex: -1, code: 'E_LIMIT', message: `A transaction may hold at most ${max} commands` },
			]),
		};
	}
	if (tx.expectedRevision !== undefined && tx.expectedRevision > ctx.revision) {
		return {
			document: doc,
			result: fail(ctx.revision, [
				{
					commandIndex: -1,
					code: 'E_REVISION_MISMATCH',
					message: `Revision ${tx.expectedRevision} is ahead of ${ctx.revision}`,
				},
			]),
		};
	}
	const { commands, errors } = validateCommands(tx.commands);
	if (errors.length > 0) return { document: doc, result: fail(ctx.revision, errors) };

	const refs = new Map<string, string>();
	const h = new HandlerContext(ctx, { origin: tx.origin, sequenceId: tx.sequenceId }, refs);
	const results: unknown[] = [];
	let next: ProjectDocument;
	try {
		next = produce(doc, (draft) => {
			commands.forEach((raw, i) => {
				h.commandIndex = i;
				const cmd = substituteRefs(raw, refs, ctx.selection);
				const entry = COMMAND_CATALOG[cmd.type];
				results.push(entry.handler(draft, cmd as never, h) ?? null);
			});
			// Sources whose last reference disappeared (e.g. a solid's color matte) are collected (INV-014).
			collectOrphans(draft);
		});
	} catch (e) {
		if (e instanceof CommandError) {
			return {
				document: doc,
				result: fail(ctx.revision, [
					{
						commandIndex: h.commandIndex,
						code: e.code,
						message: e.message,
						...(e.path ? { path: e.path } : {}),
						...(e.blocking ? { blocking: e.blocking } : {}),
					},
				]),
			};
		}
		const message = e instanceof Error ? e.message : String(e);
		return {
			document: doc,
			result: fail(ctx.revision, [{ commandIndex: h.commandIndex, code: 'E_INTERNAL', message }]),
		};
	}

	if (next !== doc && ctx.checkInvariants !== false) {
		const issues = checkInvariants(next, { effects: ctx.registries.effects });
		if (issues.length > 0) return { document: doc, result: fail(ctx.revision, issues) };
	}
	const diff = diffDocuments(doc, next);

	// Optimistic concurrency with the fast-forward rule (S01:AGT-010).
	if (tx.expectedRevision !== undefined && tx.expectedRevision < ctx.revision) {
		const changedSince: string[] = [];
		if (ctx.entityRevisions) {
			for (const [id, rev] of ctx.entityRevisions) if (rev > tx.expectedRevision) changedSince.push(id);
		}
		const touched = referencedIds(tx.commands, [
			...diff.created,
			...diff.changed,
			...diff.deleted,
			...(tx.sequenceId ? [tx.sequenceId] : []),
		]);
		const conflicts = ctx.entityRevisions
			? changedSince.filter((id) => touched.has(id))
			: ['(unknown: no revision map)'];
		if (conflicts.length > 0) {
			return {
				document: doc,
				result: fail(ctx.revision, [
					{
						commandIndex: -1,
						code: 'E_REVISION_MISMATCH',
						message: `Document changed since revision ${tx.expectedRevision}: ${conflicts.join(', ')}`,
						blocking: conflicts,
					},
				]),
			};
		}
	}

	// M2 (wp-m2-text-anim, S11:TXA-004): text animators compressed by trims, razor, speed or rate changes.
	for (const w of compressionWarnings(doc, next, h.warnings)) h.warnings.push({ commandIndex: -1, ...w });

	const unchanged = next === doc;
	const committed = !tx.dryRun && !unchanged;
	return {
		document: committed ? next : doc,
		result: {
			ok: true,
			revision: committed ? ctx.revision + 1 : ctx.revision,
			refs: Object.fromEntries(refs),
			created: diff.created,
			changed: diff.changed,
			deleted: diff.deleted,
			warnings: h.warnings,
			results,
		},
	};
}
