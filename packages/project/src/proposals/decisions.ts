// Review decisions on a proposal (pure state transitions; the engine store persists them). None touches the
// document: rejecting leaves it identical, accepting is recorded after the composed transaction applied.
import { PROPOSAL_LIMITS, type Proposal, type ProposalIssue, type ProposalItem } from './schema.ts';

export type DecisionResult =
	| { ok: true; proposal: Proposal; changed: string[] }
	| { ok: false; errors: ProposalIssue[] };

function withItems(p: Proposal, map: (it: ProposalItem) => ProposalItem, now: string): DecisionResult {
	const changed: string[] = [];
	const items = p.items.map((it) => {
		const next = map(it);
		if (next !== it) changed.push(it.id);
		return next;
	});
	return { ok: true, proposal: changed.length ? { ...p, items, updatedAt: now } : p, changed };
}

function unknownIds(p: Proposal, ids: readonly string[]): ProposalIssue[] {
	const known = new Set(p.items.map((it) => it.id));
	return ids
		.filter((id) => !known.has(id))
		.map((id) => ({ code: 'E_NOT_FOUND', message: `No item ${id} in the proposal`, itemId: id }));
}

function stripReason(it: ProposalItem): Omit<ProposalItem, 'reason'> {
	const { reason: _r, ...rest } = it;
	return rest;
}

/** Marks items accepted after their transaction applied (`applied`: revision, refs, time). */
export function markAccepted(
	p: Proposal,
	itemIds: readonly string[],
	applied: { revision: number; refs: Record<string, string>; at: string },
): Proposal {
	const ids = new Set(itemIds);
	const items = p.items.map(
		(it): ProposalItem => (ids.has(it.id) ? { ...stripReason(it), state: 'accepted', applied } : it),
	);
	return ids.size ? { ...p, items, updatedAt: applied.at } : p;
}

/**
 * Rejects items ('all' = every pending or stale one). An accepted item cannot be rejected (it is in the document:
 * undo it in History, then reopen it). Rejecting changes nothing in the document.
 */
export function rejectItems(p: Proposal, itemIds: readonly string[] | 'all', now: string): DecisionResult {
	if (itemIds !== 'all') {
		const errors = unknownIds(p, itemIds);
		for (const id of itemIds) {
			const it = p.items.find((x) => x.id === id);
			if (it?.state === 'accepted')
				errors.push({
					code: 'E_INVALID_PARAM',
					message: `Item ${id} is already applied: undo it in History (then reopen it) instead`,
					itemId: id,
				});
		}
		if (errors.length) return { ok: false, errors };
	}
	const ids = itemIds === 'all' ? null : new Set(itemIds);
	return withItems(
		p,
		(it) => {
			const hit = ids ? ids.has(it.id) : it.state === 'pending' || it.state === 'stale';
			if (!hit || it.state === 'rejected') return it;
			return { ...stripReason(it), state: 'rejected' };
		},
		now,
	);
}

/**
 * Puts decided items back to review ('all' = every accepted or rejected one): after the accept was undone in
 * History, the proposal reopens with its notes and selected alternatives intact. Invalid items stay invalid.
 */
export function reopenItems(p: Proposal, itemIds: readonly string[] | 'all', now: string): DecisionResult {
	if (itemIds !== 'all') {
		const errors = unknownIds(p, itemIds);
		if (errors.length) return { ok: false, errors };
	}
	const ids = itemIds === 'all' ? null : new Set(itemIds);
	return withItems(
		p,
		(it) => {
			const hit = ids ? ids.has(it.id) : it.state === 'accepted' || it.state === 'rejected';
			if (!hit || (it.state !== 'accepted' && it.state !== 'rejected')) return it;
			const { applied: _a, ...rest } = stripReason(it);
			return { ...rest, state: 'pending' };
		},
		now,
	);
}

/** A setup item (`meta.setup: true`): it exists only as the requirement of other items (a bin, an imported sound, a cue). */
export function isSetupItem(item: { meta?: unknown }): boolean {
	const m = item.meta;
	return !!m && typeof m === 'object' && (m as { setup?: unknown }).setup === true;
}

/** Reason recorded on a setup item nothing needs any more. */
export const SETUP_NOT_NEEDED = 'Not needed: every item that requires it was rejected or does not apply';

/**
 * Setup items nothing left needs: a pending or stale setup item whose dependents are all rejected or invalid becomes
 * rejected (transitively), so a reviewed proposal is decided and "all" never applies a requirement alone (a sound
 * imported, a cue added for a placement the user turned down). Accepting such a dependent later still accepts its
 * rejected requirements with it (`planAccept`). Pure; the document is not touched.
 */
export function settleSetupItems(p: Proposal, now: string): Extract<DecisionResult, { ok: true }> {
	let items = p.items;
	const changed: string[] = [];
	for (let pass = 0; pass < 64; pass++) {
		const dependents = new Map<string, ProposalItem[]>();
		for (const it of items)
			for (const r of it.requires) {
				const list = dependents.get(r);
				if (list) list.push(it);
				else dependents.set(r, [it]);
			}
		const settle = new Set<string>();
		for (const it of items) {
			if (!isSetupItem(it) || (it.state !== 'pending' && it.state !== 'stale')) continue;
			const deps = dependents.get(it.id) ?? [];
			if (deps.length && deps.every((d) => d.state === 'rejected' || d.state === 'invalid'))
				settle.add(it.id);
		}
		if (settle.size === 0) break;
		items = items.map((it) => {
			if (!settle.has(it.id)) return it;
			changed.push(it.id);
			return { ...stripReason(it), state: 'rejected' as const, reason: SETUP_NOT_NEEDED };
		});
	}
	return { ok: true, proposal: changed.length ? { ...p, items, updatedAt: now } : p, changed };
}

/** Sets (or with null / "" clears) the reviewer's note of an item. */
export function setItemNote(p: Proposal, itemId: string, note: string | null, now: string): DecisionResult {
	const errors = unknownIds(p, [itemId]);
	if (errors.length) return { ok: false, errors };
	if (note !== null && note.length > PROPOSAL_LIMITS.maxNote)
		return {
			ok: false,
			errors: [
				{
					code: 'E_INVALID_PARAM',
					message: `A note holds at most ${PROPOSAL_LIMITS.maxNote} characters`,
					itemId,
				},
			],
		};
	return withItems(
		p,
		(it) => {
			if (it.id !== itemId) return it;
			if (!note) {
				if (it.note === undefined) return it;
				const { note: _n, ...rest } = it;
				return rest;
			}
			return it.note === note ? it : { ...it, note };
		},
		now,
	);
}

/**
 * Selects the command set an undecided item applies: 0 = its own, k ≥ 1 = `alternatives[k − 1]`. The caller
 * validates the new set against the document (`dryRunCommands`) before storing it.
 */
export function selectAlternative(
	p: Proposal,
	itemId: string,
	alternative: number,
	now: string,
): DecisionResult {
	const errors = unknownIds(p, [itemId]);
	if (errors.length) return { ok: false, errors };
	const it = p.items.find((x) => x.id === itemId)!;
	const n = it.alternatives?.length ?? 0;
	if (!Number.isInteger(alternative) || alternative < 0 || alternative > n)
		return {
			ok: false,
			errors: [
				{
					code: 'E_INVALID_PARAM',
					message: `Item ${itemId} has ${n} alternative${n === 1 ? '' : 's'}: choose 0 (its own) to ${n}`,
					itemId,
				},
			],
		};
	if (it.state === 'accepted')
		return {
			ok: false,
			errors: [
				{
					code: 'E_INVALID_PARAM',
					message: `Item ${itemId} is already applied: undo it in History (then reopen it) to choose another alternative`,
					itemId,
				},
			],
		};
	return withItems(
		p,
		(x) => {
			if (x.id !== itemId || (x.selectedAlternative ?? 0) === alternative) return x;
			const { selectedAlternative: _s, ...rest } = x;
			return alternative === 0 ? rest : { ...rest, selectedAlternative: alternative };
		},
		now,
	);
}
