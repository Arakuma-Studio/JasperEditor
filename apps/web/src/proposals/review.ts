// The Review panel's and review bar's model (spec 12 §2.7 "Review", P3-R6; WP3.3b). Pure: the rows of the proposal
// under review grouped by role (Hero / Support / Bed / Layers / … / Tracks) in time order, the setup items (a bin, a
// sound's media, a new cue: WP3.2 `meta.setup`) folded under the row that needs them, the counts the bar, the tab
// badge and the Apply button show, the navigation order, the frame range Review zooms to, what an Apply would remove
// from the user's sequence (named in the confirmation) and the proposal card's sentence counts.
import {
	APPROVAL_COMMANDS,
	COMMAND_CATALOG,
	type CueKind,
	createSeededIdSource,
	dependencyClosure,
	type ProjectDocument,
	type Proposal,
	type ProposalContext,
	previewProposalSteps,
	type Sequence,
	selectedCommands,
} from '@jasper/project';
import type { ProposalPreviewState, ReviewItem } from '@jasper/session';
import { t } from '../i18n/runtime.ts';
import { KIND_GLYPH, kindLabel } from '../sound/cues/model.ts';
import { type GhostModel, setupOwners } from './ghosts.ts';

export type ReviewRow = {
	item: ReviewItem;
	/** The sequence frame the item is anchored at (its cue, else where its ghost starts), or null. */
	frame: number | null;
	/** Cue kind (`meta.kind`) when it is one. */
	kind: CueKind | null;
	/** Sound name shown for the chosen command set. */
	sound: string | null;
	role: string | null;
	/** Gain the placement gets (the ghost clip's, else the plan's seeded offset), dB. */
	gainDb: number | null;
	/** The short reason (the cue's reason, else the why-line). */
	reason: string | null;
	/** The setup items folded under this row. */
	setup: ReviewItem[];
};

export type ReviewGroup = { id: string; label: string; rows: ReviewRow[] };

export type ReviewModel = {
	groups: ReviewGroup[];
	/** Setup items nothing in the list needs (shown in their own "Setup" group). */
	orphans: ReviewItem[];
	/** Row ids in list order (as shown). */
	listOrder: string[];
	/** Row ids in time order (the timeline's ◀ ▶). */
	timeOrder: string[];
	byId: Record<string, ReviewRow>;
};

export type ReviewCounts = {
	total: number;
	pending: number;
	accepted: number;
	rejected: number;
	stale: number;
	invalid: number;
	applied: number;
	/** Left to decide here (pending + stale). */
	open: number;
};

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

function metaOf(m: unknown): Record<string, unknown> {
	return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}
function text(v: unknown, max = 200): string | null {
	return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

/** Group key of a row: its role (sound design) or the item's group. */
function groupKey(item: ReviewItem): string {
	const m = metaOf(item.meta);
	const g = (text(m.role, 64) ?? item.group ?? '').toLowerCase();
	if (g === 'ambient' || g === 'ambience' || g === 'bed') return 'bed';
	if (g === 'track' || g === 'tracks') return 'tracks';
	return g || 'other';
}

const GROUP_ORDER = ['hero', 'support', 'bed', 'layer'];

/** "Hero", "Support", "Bed", "Layers", "Tracks", or the group itself. */
export function groupLabel(key: string): string {
	switch (key) {
		case 'hero':
			return t('Hero');
		case 'support':
			return t('Support');
		case 'bed':
			return t('Bed');
		case 'layer':
			return t('Layers');
		case 'tracks':
			return t('Tracks');
		case 'setup':
			return t('Setup');
		case 'other':
			return t('Other');
		default:
			return key.slice(0, 1).toUpperCase() + key.slice(1);
	}
}

/** The kind's glyph shape and label (null when `meta.kind` is not a cue kind). */
export function kindOf(meta: unknown): CueKind | null {
	const k = metaOf(meta).kind;
	return typeof k === 'string' && k in KIND_GLYPH ? (k as CueKind) : null;
}
export const kindName = (k: CueKind) => kindLabel(k);

/** The sound the item's chosen command set places (alternatives carry their own title / label). */
function soundName(item: ReviewItem): string | null {
	const m = metaOf(item.meta);
	if (item.selectedAlternative > 0) return text(item.alternativeLabels[item.selectedAlternative], 120);
	return text(m.title, 120) ?? null;
}

function rowOf(item: ReviewItem, ghost: GhostModel | null, gainOf: (id: string) => number | null): ReviewRow {
	const m = metaOf(item.meta);
	const g = ghost?.byItem[item.id];
	const frame = finite(m.frame) ? Math.max(0, Math.floor(m.frame)) : g ? g.start : null;
	const gain = gainOf(item.id) ?? (finite(m.gainOffsetDb) ? m.gainOffsetDb : null);
	return {
		item,
		frame,
		kind: kindOf(m),
		sound: soundName(item),
		role: text(m.role, 32),
		gainDb: gain,
		reason:
			text(m.cueReason, 160) ??
			(item.selectedAlternative > 0 ? text(metaOf(item.selectedMeta).why, 160) : null) ??
			text(m.why, 160) ??
			text(m.reason, 160),
		setup: [],
	};
}

/** The rows of the proposal under review. `ghost`: its ghosts in the drawn sequence (frames and gains), if any. */
export function buildReviewModel(items: readonly ReviewItem[], ghost: GhostModel | null): ReviewModel {
	const order = new Map(items.map((it, i) => [it.id, i]));
	// An item's gain is the gain of what its own chosen command set places (the first clip it creates, else the first it
	// changes), never a setup item's ghost folded under it (the delivery preset re-levels the music clips).
	const gains = new Map<string, number>();
	for (const pass of ['created', 'changed'] as const)
		for (const c of ghost?.clips ?? [])
			if (c.change === pass && c.sourceItemId === c.itemId && c.gainDb !== null && !gains.has(c.itemId))
				gains.set(c.itemId, c.gainDb);
	const gainOf = (id: string) => gains.get(id) ?? null;
	const owners = setupOwners(items);
	const byId: Record<string, ReviewRow> = {};
	const groups = new Map<string, ReviewRow[]>();
	for (const it of items) {
		if (it.setup) continue;
		const row = rowOf(it, ghost, gainOf);
		byId[it.id] = row;
		const k = groupKey(it);
		groups.set(k, [...(groups.get(k) ?? []), row]);
	}
	const orphans: ReviewItem[] = [];
	for (const it of items) {
		if (!it.setup) continue;
		const owner = owners.get(it.id);
		const row = owner ? byId[owner] : undefined;
		if (row) row.setup.push(it);
		else orphans.push(it);
	}
	const byTime = (a: ReviewRow, b: ReviewRow) =>
		(a.frame ?? Number.POSITIVE_INFINITY) - (b.frame ?? Number.POSITIVE_INFINITY) ||
		(order.get(a.item.id) ?? 0) - (order.get(b.item.id) ?? 0);
	const keys = [...groups.keys()].sort((a, b) => {
		const rank = (k: string) => {
			const i = GROUP_ORDER.indexOf(k);
			return i >= 0 ? i : k === 'tracks' ? 1000 : k === 'other' ? 999 : 100;
		};
		return rank(a) - rank(b) || a.localeCompare(b);
	});
	const out: ReviewGroup[] = keys.map((k) => ({
		id: k,
		label: groupLabel(k),
		rows: [...(groups.get(k) ?? [])].sort(byTime),
	}));
	const listOrder = out.flatMap((g) => g.rows.map((r) => r.item.id));
	const timeOrder = Object.values(byId)
		.sort(byTime)
		.map((r) => r.item.id);
	return { groups: out, orphans, listOrder, timeOrder, byId };
}

/** Counts of the items the reviewer decides on (setup items come with them and are not counted). */
export function reviewCounts(items: readonly ReviewItem[]): ReviewCounts {
	const c: ReviewCounts = {
		total: 0,
		pending: 0,
		accepted: 0,
		rejected: 0,
		stale: 0,
		invalid: 0,
		applied: 0,
		open: 0,
	};
	for (const it of items) {
		if (it.setup) continue;
		c.total++;
		c[it.state]++;
	}
	c.open = c.pending + c.stale;
	return c;
}

/** The item after / before `from` in `order` (clamped at the ends); the first / last when `from` is not in it. */
export function stepItem(order: readonly string[], from: string | null, dir: 1 | -1): string | null {
	if (!order.length) return null;
	const i = from ? order.indexOf(from) : -1;
	if (i < 0) return dir > 0 ? order[0]! : order[order.length - 1]!;
	return order[Math.min(order.length - 1, Math.max(0, i + dir))]!;
}

/** The frames the proposal's ghosts span in the drawn sequence (what Review zooms to), or null. */
export function proposalRange(ghost: GhostModel | null): { start: number; end: number } | null {
	if (!ghost?.items.length) return null;
	let start = Number.POSITIVE_INFINITY;
	let end = Number.NEGATIVE_INFINITY;
	for (const it of ghost.items) {
		start = Math.min(start, it.start);
		end = Math.max(end, it.end);
	}
	return Number.isFinite(start) && Number.isFinite(end) ? { start, end: Math.max(end, start + 1) } : null;
}

/**
 * What applying `itemIds` (with what they require) would remove from the user's sequence: the clips the preview deletes
 * that exist now. Named in the Apply confirmation ("Also removes 1 of your clips: …"); accepting them IS the approval.
 */
export function removalsOf(
	preview: Pick<ProposalPreviewState, 'result' | 'base'> | null,
	itemIds: readonly string[],
): { clipId: string; name: string; itemId: string }[] {
	if (!preview) return [];
	const out: { clipId: string; name: string; itemId: string }[] = [];
	const seen = new Set<string>();
	for (const itemId of itemIds) {
		const g = preview.result.items[itemId];
		if (!g) continue;
		for (const id of g.deleted) {
			if (seen.has(id)) continue;
			for (const seq of Object.values(preview.base.sequences) as Sequence[]) {
				const c = seq.clips[id];
				if (!c) continue;
				seen.add(id);
				out.push({ clipId: id, name: c.name || id, itemId });
				break;
			}
		}
	}
	return out;
}

/** What applying the items would do that an agent's own transaction needs the user's approval for. */
export type ApprovalNeed =
	| { kind: 'command'; type: string; label: string }
	| { kind: 'force'; type: string; label: string }
	| { kind: 'agentsMayApply' };

function forced(v: unknown, depth = 0): boolean {
	if (depth > 8 || !v || typeof v !== 'object') return false;
	if (Array.isArray(v)) return v.some((x) => forced(x, depth + 1));
	for (const [k, x] of Object.entries(v))
		if ((k === 'force' && x === true) || forced(x, depth + 1)) return true;
	return false;
}

/**
 * The commands among the items an Apply brings (their accept closure, the chosen command sets) that would need the
 * user's approval if an agent ran them (the agent guard's rule, S01:AGT-011): destructive commands, `force`, and an
 * agent's grant of "Allow agents to apply sound proposals". Applying in the editor is the user's own edit, so the
 * Review names them in its confirmation instead of applying them unseen. Never throws.
 */
export function approvalNeeds(proposal: Proposal | null, itemIds: readonly string[]): ApprovalNeed[] {
	if (!proposal) return [];
	try {
		const closure = dependencyClosure(
			proposal,
			itemIds.filter((id) => proposal.items.some((it) => it.id === id)),
			(it) => it.state === 'accepted' || it.state === 'invalid',
		);
		const out: ApprovalNeed[] = [];
		const seen = new Set<string>();
		const add = (key: string, need: ApprovalNeed) => {
			if (seen.has(key)) return;
			seen.add(key);
			out.push(need);
		};
		for (const it of closure)
			for (const c of selectedCommands(it)) {
				const type = (c as { type?: unknown }).type;
				if (typeof type !== 'string') continue;
				const label =
					(COMMAND_CATALOG as Record<string, { label?: string } | undefined>)[type]?.label ?? type;
				if ((APPROVAL_COMMANDS as readonly string[]).includes(type))
					add(`c:${type}`, { kind: 'command', type, label });
				else if (forced(c)) add(`f:${type}`, { kind: 'force', type, label });
				else if (
					type === 'soundDesign.setSettings' &&
					(c as { agentsMayApply?: unknown }).agentsMayApply === true
				)
					add('agentsMayApply', { kind: 'agentsMayApply' });
			}
		return out;
	} catch {
		return [];
	}
}

/** The proposal card's counts: sounds it places, tracks it creates, items to decide on. */
export type CardCounts = { sounds: number; newTracks: number; items: number };

/**
 * Counts for "<agent> proposes <title>: <n> sounds on <k> new tracks", from a preview of every undecided item on the
 * committed document (never committed; ids seeded like the review's preview). Never throws.
 */
export function proposalCardCounts(doc: ProjectDocument, p: Proposal, ctx: ProposalContext): CardCounts {
	const run = proposalCardCountsSteps(doc, p, ctx);
	for (;;) {
		const step = run.next();
		if (step.done) return step.value;
	}
}

/**
 * `proposalCardCounts` one item at a time (the card spreads a large proposal's preview over several frames,
 * `runInSlices`). The items are applied without the invariant check: only the counts are read.
 */
export function* proposalCardCountsSteps(
	doc: ProjectDocument,
	p: Proposal,
	ctx: ProposalContext,
): Generator<unknown, CardCounts, void> {
	const items = p.items.filter((it) => {
		const m = metaOf(it.meta);
		return m.setup !== true && (it.state === 'pending' || it.state === 'stale');
	}).length;
	try {
		const r = yield* previewProposalSteps(
			doc,
			p,
			'undecided',
			{ ...ctx, checkInvariants: false },
			{
				idsFor: (it) => createSeededIdSource(`${p.id}:${it.id}:${it.selectedAlternative ?? 0}`),
				// batches of items stay near one slice of `runInSlices`
				batchMs: 8,
			},
		);
		let sounds = 0;
		let newTracks = 0;
		const created = new Set(r.ghost.created);
		for (const seq of Object.values(r.document.sequences) as Sequence[]) {
			for (const id of created) {
				const c = seq.clips[id];
				if (c && c.kind === 'audio') sounds++;
			}
			for (const tr of [...seq.videoTracks, ...seq.audioTracks]) if (created.has(tr.id)) newTracks++;
		}
		return { sounds, newTracks, items };
	} catch {
		return { sounds: 0, newTracks: 0, items };
	}
}

/** "claude-code proposes Sound design: Main: 12 sounds on 2 new tracks". */
export function cardSentence(
	agent: string,
	title: string,
	feature: string,
	counts: CardCounts | null,
): string {
	if (!counts) return t('{0} proposes {1}', agent, title);
	if (feature === 'sound-design' && counts.sounds > 0) {
		const sounds = counts.sounds === 1 ? t('1 sound') : t('{0} sounds', counts.sounds);
		if (counts.newTracks <= 0) return t('{0} proposes {1}: {2}', agent, title, sounds);
		const tracks = counts.newTracks === 1 ? t('1 new track') : t('{0} new tracks', counts.newTracks);
		return t('{0} proposes {1}: {2} on {3}', agent, title, sounds, tracks);
	}
	return t(
		'{0} proposes {1}: {2}',
		agent,
		title,
		counts.items === 1 ? t('1 item') : t('{0} items', counts.items),
	);
}

/** Who wrote a proposal, for sentences ("you" for the user's own). */
export function authorName(author: Proposal['author'] | undefined): string {
	return author && typeof author === 'object' ? author.agent : t('you');
}
