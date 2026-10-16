// composeAcceptTx (spec 12 §2.5): the items to accept, their dependency closure, in proposal order, with the selected
// alternatives, as ONE transaction ("Accept <title> (n of m)"), so applying is one undo step.
import { DEFAULT_MAX_COMMANDS } from '../commands/apply.ts';
import { substituteKnownRefs } from '../commands/context.ts';
import { type Origin, TX_PROTOCOL } from '../commands/types.ts';
import { type Proposal, type ProposalIssue, type ProposalItem, selectedCommands } from './schema.ts';
import { appliedRefs, dependencyClosure, itemMap } from './structure.ts';

export type ComposedAccept = {
	ok: true;
	/** Ready for `applyTransaction` / the agent service (commands still to be validated there). */
	tx: {
		protocol: typeof TX_PROTOCOL;
		label: string;
		origin: Origin;
		sequenceId?: string;
		expectedRevision?: number;
		commands: Record<string, unknown>[];
	};
	/** Every item the transaction applies (the requested ones and what they require), in proposal order. */
	itemIds: string[];
	/** Items added by the closure (not requested). */
	added: string[];
	/** Requested items already accepted (nothing to apply for them). */
	skipped: string[];
	/** Per applied item, the half-open range of its commands in `tx.commands`. */
	ranges: { itemId: string; start: number; end: number }[];
};

export type ComposeOptions = {
	expectedRevision?: number;
	/** Treat these items as not applicable (stale ones in a partial accept): composing them fails. */
	exclude?: ReadonlySet<string>;
	/** Most commands of the transaction (default the agent limit, 5000). */
	maxCommands?: number;
};

const LABEL_TITLE_MAX = 80;

/** The History label of an accept: "Accept <title> (n of m)". */
export function acceptLabel(p: Pick<Proposal, 'title' | 'items'>, n: number): string {
	const t = p.title.length > LABEL_TITLE_MAX ? `${p.title.slice(0, LABEL_TITLE_MAX - 1)}…` : p.title;
	return `Accept ${t} (${n} of ${p.items.length})`;
}

/**
 * Composes the transaction that accepts `itemIds` ('all' = every pending or stale item). Already accepted items are
 * skipped (their refs are substituted with what they created). Refused, never thrown: unknown items, invalid items or
 * items that require one, excluded items, more commands than one transaction may hold.
 */
export function composeAcceptTx(
	p: Proposal,
	itemIds: readonly string[] | 'all',
	origin: Origin,
	opts: ComposeOptions = {},
): ComposedAccept | { ok: false; errors: ProposalIssue[] } {
	const byId = itemMap(p);
	const requested =
		itemIds === 'all'
			? p.items.filter((it) => it.state === 'pending' || it.state === 'stale').map((it) => it.id)
			: [...new Set(itemIds)];
	const errors: ProposalIssue[] = [];
	for (const id of requested)
		if (!byId.has(id))
			errors.push({ code: 'E_NOT_FOUND', message: `No item ${id} in the proposal`, itemId: id });
	if (errors.length) return { ok: false, errors };
	const skipped = requested.filter((id) => byId.get(id)!.state === 'accepted');
	const closure = dependencyClosure(
		p,
		requested.filter((id) => !skipped.includes(id)),
		(it) => it.state === 'accepted',
	);
	const requestedSet = new Set(requested);
	for (const it of closure) {
		const via = requestedSet.has(it.id) ? '' : ` (required by ${requiredBy(p, it.id, requestedSet)})`;
		if (it.state === 'invalid')
			errors.push({
				code: 'E_INVALID_PARAM',
				message: `Item ${it.id}${via} is invalid: ${it.reason ?? 'its commands fail'}`,
				itemId: it.id,
			});
		else if (opts.exclude?.has(it.id))
			errors.push({
				code: 'E_STALE',
				message: `Item ${it.id}${via} is stale: ${it.reason ?? 'the document changed'}`,
				itemId: it.id,
			});
	}
	if (errors.length) return { ok: false, errors };

	const refs = appliedRefs(p);
	const commands: Record<string, unknown>[] = [];
	const ranges: ComposedAccept['ranges'] = [];
	for (const it of closure) {
		const start = commands.length;
		for (const c of selectedCommands(it)) commands.push(substituteKnownRefs(c, refs));
		ranges.push({ itemId: it.id, start, end: commands.length });
	}
	const max = opts.maxCommands ?? DEFAULT_MAX_COMMANDS;
	if (commands.length > max)
		return {
			ok: false,
			errors: [
				{
					code: 'E_LIMIT',
					message: `Accepting these items needs ${commands.length} commands; one transaction holds at most ${max}: accept fewer items at a time`,
				},
			],
		};
	return {
		ok: true,
		tx: {
			protocol: TX_PROTOCOL,
			label: acceptLabel(p, closure.length),
			origin,
			...(p.sequenceId ? { sequenceId: p.sequenceId } : {}),
			...(opts.expectedRevision !== undefined ? { expectedRevision: opts.expectedRevision } : {}),
			commands,
		},
		itemIds: closure.map((it) => it.id),
		added: closure.filter((it) => !requestedSet.has(it.id)).map((it) => it.id),
		skipped,
		ranges,
	};
}

function requiredBy(p: Proposal, id: string, requested: ReadonlySet<string>): string {
	for (const it of p.items) if (requested.has(it.id) && dependsOn(p, it, id)) return it.id;
	return 'another item';
}

function dependsOn(p: Proposal, item: ProposalItem, id: string): boolean {
	return dependencyClosure(p, [item.id]).some((x) => x.id === id);
}

/** The item a command index of a composed transaction belongs to. */
export function itemOfCommand(ranges: ComposedAccept['ranges'], commandIndex: number): string | null {
	for (const r of ranges) if (commandIndex >= r.start && commandIndex < r.end) return r.itemId;
	return null;
}
