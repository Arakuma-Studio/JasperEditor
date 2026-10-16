// What the review UI does (spec 12 §2.7 "Review", P3-R6; WP3.3b), shared by the Review panel, the review bar on the
// Timeline, the ghost card, the proposal card and the `proposals.*` UI commands (the Review keymap scope):
// entering review (its sequence opens, the Timeline zooms to it), moving between items (the ghost is selected and the
// playhead goes to the item's anchor), decisions, Accept all / Reject all, ▶ in context and the range, Apply (a trusted
// user gesture only; destructive items are named in a confirmation, which IS the approval) with its toast "Applied n of
// m sounds from <author>" offering Undo and Reopen review, and Discard (the proposal is deleted, after a confirmation).
// Every outcome is announced (aria-live) through `reviewAnnouncer`.
import type { Sequence } from '@jasper/project';
import type { EditorSession, ProposalsController, ReviewItem } from '@jasper/session';
import { confirmDialog, toast } from '@jasper/ui';
import { createStore } from 'zustand/vanilla';
import { t } from '../i18n/runtime.ts';
import { inContextStore, playTimelineWindow } from '../sound/in-context.ts';
import { soundLibraryPrefs } from '../sound/prefs.ts';
import { buildGhostModel, type GhostItem, type GhostModel } from './ghosts.ts';
import {
	authorName,
	buildReviewModel,
	type ReviewModel,
	removalsOf,
	reviewCounts,
	stepItem,
} from './review.ts';
import { proposalsFor } from './state.ts';

/** The last thing the review did, for screen readers (the panel and the bar render it in an aria-live region). */
export const reviewAnnouncer = createStore<{ message: string; n: number }>(() => ({ message: '', n: 0 }));
export function announce(message: string): void {
	reviewAnnouncer.setState((s) => ({ message, n: s.n + 1 }));
}

/** Pre-roll before the range "Play range" plays (spec: 2 s before the first item). */
export const RANGE_PREROLL_SEC = 2;

export type RevealFn = (frame: number) => void;

/** The sequence the proposal under review draws in: its own, else the active one. */
export function reviewSequenceId(session: EditorSession): string | null {
	const p = proposalsFor(session).getState().proposal;
	const doc = session.getCommitted();
	if (p?.sequenceId && doc.sequences[p.sequenceId]) return p.sequenceId;
	return session.getState().activeSequenceId;
}

/** The ghosts of the proposal under review in its sequence (null when nothing shows). */
export function currentGhostModel(session: EditorSession): GhostModel | null {
	const st = proposalsFor(session).getState();
	const seqId = reviewSequenceId(session);
	if (!seqId || !st.activeId || !st.preview || !st.proposal || st.preview.proposalId !== st.activeId)
		return null;
	try {
		const m = buildGhostModel({
			preview: st.preview,
			committed: st.preview.base,
			sequenceId: seqId,
			items: st.items,
			agent: typeof st.proposal.author === 'object',
		});
		return m.items.length ? m : null;
	} catch {
		return null;
	}
}

export function currentReviewModel(session: EditorSession): ReviewModel {
	return buildReviewModel(proposalsFor(session).getState().items, currentGhostModel(session));
}

/** The item the review is on: the last selected one. */
export function currentItemId(session: EditorSession): string | null {
	const st = proposalsFor(session).getState();
	const id = st.selection.at(-1) ?? null;
	return id && st.items.some((it) => it.id === id && !it.setup) ? id : null;
}

/** Selects an item (its ghost), moves the playhead to its anchor and scrolls the Timeline there. */
export function focusItem(session: EditorSession, itemId: string, reveal?: RevealFn): void {
	const c = proposalsFor(session);
	c.select([itemId]);
	const row = currentReviewModel(session).byId[itemId];
	if (row?.frame !== null && row?.frame !== undefined && !session.transport.getState().playing) {
		session.transport.seek(row.frame);
		reveal?.(row.frame);
	}
	const it = c.getState().items.find((x) => x.id === itemId);
	if (it) announce(itemAnnouncement(it, row?.frame ?? null, session));
}

function tcOf(session: EditorSession, frame: number | null): string {
	if (frame === null) return '';
	const seqId = reviewSequenceId(session);
	const seq = seqId ? (session.getCommitted().sequences[seqId] as Sequence | undefined) : undefined;
	if (!seq) return String(frame);
	const fps = seq.settings.frameRate.num / seq.settings.frameRate.den;
	const s = fps > 0 ? frame / fps : 0;
	return `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
}

/** Item states in words (state is never told by colour alone). */
export const REVIEW_STATE_LABELS: Record<ReviewItem['state'], string> = {
	pending: 'Pending',
	accepted: 'Accepted',
	rejected: 'Rejected',
	stale: 'Stale',
	invalid: 'Invalid',
	applied: 'Applied',
};

function itemAnnouncement(it: ReviewItem, frame: number | null, session: EditorSession): string {
	const at = frame !== null ? ` ${t('at {0}', tcOf(session, frame))}` : '';
	return `${it.label}, ${REVIEW_STATE_LABELS[it.state]}${at}${it.reason ? `. ${it.reason}` : ''}`;
}

/** ◀ ▶ (time order, the timeline's) or ↑ ↓ (list order, the panel's). */
export function stepReviewItem(
	session: EditorSession,
	dir: 1 | -1,
	order: 'time' | 'list' = 'time',
	reveal?: RevealFn,
): string | null {
	const m = currentReviewModel(session);
	const id = stepItem(order === 'list' ? m.listOrder : m.timeOrder, currentItemId(session), dir);
	if (id) focusItem(session, id, reveal);
	return id;
}

/** Accept / reject / clear items (default: the current one); announces the result. */
export async function decide(
	session: EditorSession,
	d: 'accept' | 'reject' | 'clear',
	itemIds?: readonly string[],
): Promise<boolean> {
	const c = proposalsFor(session);
	const ids = itemIds ?? (currentItemId(session) ? [currentItemId(session)!] : []);
	if (!ids.length) {
		announce(t('Select an item first'));
		return false;
	}
	const r = await c.setItemDecision(ids, d);
	if (!r.ok) {
		toast({
			kind: 'warning',
			title: t('Review: not possible'),
			detail: r.message,
			dedupeKey: 'review-decide',
		});
		announce(r.message);
		return false;
	}
	const one = ids.length === 1 ? c.getState().items.find((x) => x.id === ids[0]) : undefined;
	announce(
		one
			? `${one.label}: ${REVIEW_STATE_LABELS[one.state]}`
			: d === 'accept'
				? t('{0} items accepted', ids.length)
				: d === 'reject'
					? t('{0} items rejected', ids.length)
					: t('{0} items back to pending', ids.length),
	);
	return true;
}

/** Accept all: every pending or stale item (rejected ones stay rejected; setup items come with them). */
export function acceptAll(session: EditorSession): Promise<boolean> {
	const ids = proposalsFor(session)
		.getState()
		.items.filter((it) => !it.setup && (it.state === 'pending' || it.state === 'stale'))
		.map((it) => it.id);
	return ids.length ? decide(session, 'accept', ids) : Promise.resolve(false);
}

/** Reject all: every item not applied, rejected or invalid (setup items nothing needs are settled by the engine). */
export function rejectAll(session: EditorSession): Promise<boolean> {
	const ids = proposalsFor(session)
		.getState()
		.items.filter(
			(it) => !it.setup && (it.state === 'pending' || it.state === 'stale' || it.state === 'accepted'),
		)
		.map((it) => it.id);
	return ids.length ? decide(session, 'reject', ids) : Promise.resolve(false);
}

/** Next / previous alternative of an item (default the current one). */
export async function cycleAlternative(
	session: EditorSession,
	dir: 1 | -1,
	itemId?: string,
): Promise<boolean> {
	const id = itemId ?? currentItemId(session);
	if (!id) return false;
	const c = proposalsFor(session);
	const r = await c.cycleAlternative(id, dir);
	if (!r.ok) {
		toast({ kind: 'warning', title: t('Review: not possible'), detail: r.message, dedupeKey: 'review-alt' });
		return false;
	}
	const it = c.getState().items.find((x) => x.id === id);
	if (it)
		announce(
			t(
				'{0}: alternate {1} of {2}, {3}',
				it.label,
				it.selectedAlternative + 1,
				it.alternatives,
				it.alternativeLabels[it.selectedAlternative] ?? '',
			),
		);
	return true;
}

/**
 * Plays a window with "Hear proposal" on (pre-roll from the Sound Library preference unless given, then as it was):
 * the Program monitor plays the proposal's preview document, so the item sounds in context.
 */
export function playWithHear(
	session: EditorSession,
	controller: ProposalsController,
	seq: Sequence,
	win: { start: number; end: number; label: string; before?: number },
): void {
	const was = controller.getState().hear;
	controller.setHear(true);
	const fps = seq.settings.frameRate.num / seq.settings.frameRate.den;
	const span = fps > 0 ? Math.max(0, (win.end - win.start) / fps) : 0;
	playTimelineWindow(session, seq, {
		center: win.start,
		returnTo: Math.round(session.transport.getState().frame),
		title: win.label,
		before: win.before ?? soundLibraryPrefs.get().preRollSec,
		after: span + 1,
	});
	if (was) return;
	let started = inContextStore.getState().active;
	const off = inContextStore.subscribe((s) => {
		if (s.active) started = true;
		if (started && !s.active && !s.loading) {
			off();
			controller.setHear(false);
		}
	});
}

/** ▶ an item in context (default the current one): pre-roll → its tail, with the proposal heard. */
export function playReviewItem(session: EditorSession, itemId?: string): boolean {
	const id = itemId ?? currentItemId(session);
	const model = currentGhostModel(session);
	const seqId = reviewSequenceId(session);
	const seq = seqId ? (session.getCommitted().sequences[seqId] as Sequence | undefined) : undefined;
	const g: GhostItem | undefined = id ? model?.byItem[id] : undefined;
	if (!g || !seq) return false;
	playWithHear(session, proposalsFor(session), seq, g);
	announce(t('Playing {0} in context', g.label));
	return true;
}

/** Shift+Space: the whole proposal, from 2 s before its first item to the end of its last, heard. */
export function playReviewRange(session: EditorSession): boolean {
	const model = currentGhostModel(session);
	const seqId = reviewSequenceId(session);
	const seq = seqId ? (session.getCommitted().sequences[seqId] as Sequence | undefined) : undefined;
	if (!model?.items.length || !seq) return false;
	const start = Math.min(...model.items.map((x) => x.start));
	const end = Math.max(...model.items.map((x) => x.end));
	const title = proposalsFor(session).getState().proposal?.title ?? t('Proposal');
	playWithHear(session, proposalsFor(session), seq, { start, end, label: title, before: RANGE_PREROLL_SEC });
	announce(t('Playing the proposal'));
	return true;
}

/** Starts reviewing a proposal: its sequence opens, its ghosts appear (the Timeline zooms to them). */
export async function openReview(session: EditorSession, proposalId: string): Promise<boolean> {
	const c = proposalsFor(session);
	const r = await c.setActive(proposalId);
	if (!r.ok) {
		toast({ kind: 'warning', title: t('Cannot review the proposal'), detail: r.message });
		return false;
	}
	const p = c.getState().proposal;
	if (p?.sequenceId && session.getCommitted().sequences[p.sequenceId]) session.openSequence(p.sequenceId);
	if (p) announce(t('Reviewing {0}: {1} items', p.title, reviewCounts(c.getState().items).total));
	return true;
}

/** Leaves review (the proposal stays, with its decisions). */
export function exitReview(session: EditorSession): void {
	proposalsFor(session).exit();
	announce(t('Review closed'));
}

function topEntry(session: EditorSession) {
	const h = session.getState().history;
	return h.index > 0 ? h.entries[h.index - 1] : undefined;
}

export type ApplyOutcome =
	| { ok: true; applied: number; total: number; stale: number; entryId: number | null }
	| { ok: false; code: string; message: string };

/**
 * Apply n of m: the locally accepted items as ONE undoable transaction through the engine's accept route (WP3.3a).
 * Only for a trusted user gesture (`trusted`: the click's / key press's `isTrusted`, or `userGestureActive()` for a
 * shortcut). Items that remove the user's clips are named in a confirmation first; confirming is the approval. The
 * toast offers Undo and Reopen review (Reopen undoes it if it is still applied, then reviews the reopened proposal).
 */
export async function applyReview(
	session: EditorSession,
	opts: { trusted: boolean; confirm?: typeof confirmDialog },
): Promise<ApplyOutcome> {
	const c = proposalsFor(session);
	if (!opts.trusted) {
		const message = t('Only you can apply a proposal: click Apply or press Ctrl+Enter in the Review panel');
		toast({ kind: 'error', title: t('Apply refused'), detail: message, dedupeKey: 'review-apply-untrusted' });
		announce(message);
		return { ok: false, code: 'E_UNTRUSTED', message };
	}
	const st = c.getState();
	const p = st.proposal;
	if (!p || !st.activeId)
		return { ok: false, code: 'E_NOT_FOUND', message: t('No proposal is under review') };
	const counts = reviewCounts(st.items);
	const accepted = c.acceptedIds();
	if (!accepted.length) {
		const message = t('Accept items first (Enter, or ✓ on a row)');
		toast({ kind: 'info', title: t('Nothing to apply'), detail: message, dedupeKey: 'review-apply-nothing' });
		return { ok: false, code: 'E_NOTHING', message };
	}
	const n = st.items.filter((it) => !it.setup && it.state === 'accepted').length;
	const removals = removalsOf(st.preview, accepted);
	if (removals.length) {
		const names = removals
			.slice(0, 5)
			.map((r) => `“${r.name}”`)
			.join(', ');
		const more = removals.length > 5 ? ` ${t('and {0} more', removals.length - 5)}` : '';
		const ok = await (opts.confirm ?? confirmDialog)({
			title: t('Apply {0} of {1}?', n, counts.total),
			body:
				removals.length === 1
					? t('Also removes 1 of your clips: {0}', `${names}${more}`)
					: t('Also removes {0} of your clips: {1}', removals.length, `${names}${more}`),
			confirmLabel: t('Apply'),
		});
		if (!ok) return { ok: false, code: 'E_CANCELLED', message: t('Apply cancelled') };
	}
	const author = authorName(p.author);
	const total = counts.total;
	const proposalId = p.id;
	const r = await c.apply({ trusted: true });
	if (!r.ok) {
		const detail = r.stale?.length
			? t('{0} items changed since they were proposed: {1}', r.stale.length, r.stale[0]!.reason)
			: r.message;
		toast({ kind: 'warning', title: t('The proposal could not be applied'), detail });
		announce(detail);
		return { ok: false, code: r.code, message: r.message };
	}
	const after = c.getState();
	const appliedNow = r.applied.filter((id) => !after.items.find((x) => x.id === id)?.setup).length;
	const entry =
		r.revision !== null
			? session.getState().history.entries.find((e) => e.revisionAfter === r.revision && e.origin === 'user')
			: undefined;
	const entryId = entry?.id ?? null;
	const sounds = p.feature === 'sound-design';
	const title = sounds
		? t('Applied {0} of {1} sounds from {2}', appliedNow, total, author)
		: t('Applied {0} of {1} items from {2}', appliedNow, total, author);
	const stillApplied = () => entryId !== null && topEntry(session)?.id === entryId;
	toast({
		kind: 'success',
		title,
		...(r.stale.length
			? {
					detail: t(
						'{0} stale items left in review: {1}',
						r.stale.length,
						r.stale.map((s) => s.reason).join('; '),
					),
				}
			: {}),
		durationMs: 10_000,
		actions: [
			{
				label: t('Undo'),
				run: () => {
					if (stillApplied()) session.undo();
					else toast({ kind: 'info', title: t('Newer edits came after it; use the History panel') });
				},
			},
			{
				label: t('Reopen review'),
				run: () => {
					if (stillApplied()) session.undo();
					else if (entryId !== null && session.getState().history.entries.some((e) => e.id === entryId)) {
						const h = session.getState().history;
						const pos = h.entries.findIndex((e) => e.id === entryId);
						if (pos < h.index) {
							toast({ kind: 'info', title: t('Newer edits came after it; use the History panel') });
							return;
						}
					}
					void openReview(session, proposalId);
				},
			},
		],
	});
	announce(title);
	// nothing left to decide: the review ends (the toast can bring it back)
	if (reviewCounts(after.items).open === 0 && c.acceptedIds().length === 0) c.exit();
	return { ok: true, applied: appliedNow, total, stale: r.stale.length, entryId };
}

/** Discard: the proposal is deleted (after a confirmation); nothing in the sequence changes. */
export async function discardReview(
	session: EditorSession,
	opts: { confirm?: typeof confirmDialog } = {},
): Promise<boolean> {
	const c = proposalsFor(session);
	const p = c.getState().proposal;
	if (!p) return false;
	const ok = await (opts.confirm ?? confirmDialog)({
		title: t('Discard “{0}”?', p.title),
		body:
			typeof p.author === 'object'
				? t(
						'The proposal is deleted; {0} is told it was discarded. Nothing in your sequence changes.',
						p.author.agent,
					)
				: t('The proposal is deleted. Nothing in your sequence changes.'),
		confirmLabel: t('Discard'),
	});
	if (!ok) return false;
	const r = await c.remove(p.id);
	if (!r.ok) {
		toast({ kind: 'warning', title: t('The proposal could not be discarded'), detail: r.message });
		return false;
	}
	announce(t('Discarded {0}', p.title));
	return true;
}
