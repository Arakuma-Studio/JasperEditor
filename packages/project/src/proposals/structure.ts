// Structure of a proposal: item lookup, the dependency closure and the checks that need no document (unique ids,
// requires pointing at earlier items, unique temp refs, alternatives that declare the same refs, limits).
import { isTempRef } from '../commands/context.ts';
import {
	PROPOSAL_LIMITS,
	type Proposal,
	type ProposalIssue,
	type ProposalItem,
	type ProposalItemInput,
} from './schema.ts';

type ItemLike = Pick<ProposalItemInput, 'id' | 'requires' | 'commands' | 'alternatives' | 'selectedAlternative'>;

/** Temp refs a command set declares (`ref`, `itemRef`, `cameraRef`, … at any depth), in order, with repeats. */
export function declaredRefs(commands: readonly unknown[]): string[] {
	const out: string[] = [];
	const walk = (v: unknown, depth: number) => {
		if (depth > 32 || !v || typeof v !== 'object') return;
		if (Array.isArray(v)) {
			for (const x of v) walk(x, depth + 1);
			return;
		}
		for (const [k, x] of Object.entries(v)) {
			if ((k === 'ref' || /Ref$/.test(k)) && isTempRef(x)) out.push(x);
			else if (k !== 'payload' && k !== 'preset') walk(x, depth + 1);
		}
	};
	for (const c of commands) walk(c, 0);
	return out;
}

/**
 * Checks that need no document. Returns every issue (empty = sound). Never throws.
 */
export function proposalStructureIssues(items: readonly ItemLike[]): ProposalIssue[] {
	const issues: ProposalIssue[] = [];
	if (items.length > PROPOSAL_LIMITS.maxItems)
		issues.push({ code: 'E_LIMIT', message: `A proposal holds at most ${PROPOSAL_LIMITS.maxItems} items` });
	let commands = 0;
	let altCommands = 0;
	const index = new Map<string, number>();
	const refOwner = new Map<string, string>();
	items.forEach((it, i) => {
		if (index.has(it.id)) {
			issues.push({ code: 'E_INVALID_PARAM', message: `Item id ${it.id} is used twice`, itemId: it.id });
			return;
		}
		index.set(it.id, i);
		commands += it.commands.length;
		for (const r of it.requires ?? []) {
			const j = index.get(r);
			if (r === it.id)
				issues.push({ code: 'E_INVALID_PARAM', message: `Item ${it.id} requires itself`, itemId: it.id });
			else if (j === undefined)
				issues.push({
					code: items.some((x) => x.id === r) ? 'E_INVALID_PARAM' : 'E_NOT_FOUND',
					message: items.some((x) => x.id === r)
						? `Item ${it.id} requires ${r}, which comes after it: an item may require only earlier items`
						: `Item ${it.id} requires ${r}, which is not an item of the proposal`,
					itemId: it.id,
				});
		}
		const own = declaredRefs(it.commands);
		const ownSet = new Set(own);
		if (ownSet.size !== own.length)
			issues.push({
				code: 'E_INVALID_PARAM',
				message: `Item ${it.id} declares a temp ref twice (${own.find((r, k) => own.indexOf(r) !== k)})`,
				itemId: it.id,
			});
		for (const r of ownSet) {
			const prev = refOwner.get(r);
			if (prev !== undefined)
				issues.push({
					code: 'E_INVALID_PARAM',
					message: `Temp ref ${r} is declared by items ${prev} and ${it.id}: refs must be unique in a proposal (they share one transaction)`,
					itemId: it.id,
				});
			else refOwner.set(r, it.id);
		}
		const alts = it.alternatives ?? [];
		if (it.selectedAlternative !== undefined && it.selectedAlternative > alts.length)
			issues.push({
				code: 'E_INVALID_PARAM',
				message: `Item ${it.id} selects alternative ${it.selectedAlternative} of ${alts.length}`,
				itemId: it.id,
			});
		alts.forEach((a, k) => {
			altCommands += a.commands.length;
			const set = new Set(declaredRefs(a.commands));
			const same = set.size === ownSet.size && [...set].every((r) => ownSet.has(r));
			if (!same)
				issues.push({
					code: 'E_INVALID_PARAM',
					message: `Alternative ${k + 1} of item ${it.id} must declare the same temp refs as the item (${[...ownSet].join(', ') || 'none'}); it declares ${[...set].join(', ') || 'none'}`,
					itemId: it.id,
					path: ['alternatives', k],
				});
		});
	});
	if (commands > PROPOSAL_LIMITS.maxCommands)
		issues.push({
			code: 'E_LIMIT',
			message: `A proposal holds at most ${PROPOSAL_LIMITS.maxCommands} commands in its items (got ${commands})`,
		});
	if (altCommands > PROPOSAL_LIMITS.maxAlternativeCommands)
		issues.push({
			code: 'E_LIMIT',
			message: `A proposal holds at most ${PROPOSAL_LIMITS.maxAlternativeCommands} commands in alternatives (got ${altCommands})`,
		});
	return issues;
}

/** id → item. */
export function itemMap(p: Pick<Proposal, 'items'>): Map<string, ProposalItem> {
	return new Map(p.items.map((it) => [it.id, it]));
}

/**
 * The dependency closure of `ids`: the items and everything they require, transitively, in proposal order.
 * `stopAt` items (e.g. already accepted ones) are neither included nor followed. Unknown ids are ignored.
 */
export function dependencyClosure(
	p: Pick<Proposal, 'items'>,
	ids: Iterable<string>,
	stopAt: (item: ProposalItem) => boolean = () => false,
): ProposalItem[] {
	const byId = itemMap(p);
	const seen = new Set<string>();
	const stack = [...ids];
	while (stack.length) {
		const id = stack.pop()!;
		if (seen.has(id)) continue;
		const it = byId.get(id);
		if (!it || stopAt(it)) continue;
		seen.add(id);
		for (const r of it.requires) if (!seen.has(r)) stack.push(r);
	}
	return p.items.filter((it) => seen.has(it.id));
}

/** Items that require `id`, transitively (not including it), in proposal order. */
export function dependents(p: Pick<Proposal, 'items'>, id: string): ProposalItem[] {
	const hit = new Set([id]);
	const out: ProposalItem[] = [];
	for (const it of p.items) {
		if (it.requires.some((r) => hit.has(r))) {
			hit.add(it.id);
			out.push(it);
		}
	}
	return out;
}

/** Refs defined by accepted items (`applied.refs`): later items' commands use them as ids. */
export function appliedRefs(p: Pick<Proposal, 'items'>): Map<string, string> {
	const out = new Map<string, string>();
	for (const it of p.items)
		if (it.state === 'accepted' && it.applied) for (const [k, v] of Object.entries(it.applied.refs)) out.set(k, v);
	return out;
}
