// Proposal budgets (spec 15 EA-004): a pass whose proposal would not fit one accept transaction (the agent limits,
// S01:AGT-011: 5 000 commands and 20 MB per transaction; 2 000 items per proposal) refuses with E_TOO_LARGE and names
// a range of the sequence that fits, instead of storing a proposal that could never be accepted whole. Producers call
// `proposalBudget` on their items before creating the proposal; `createProposal` refuses an over-cap draft the same way.
// Batch commands (`clip.addAdjustmentBatch`, `keyframe.addBatch`, EA-031) keep a whole-video pass far below the caps.
import { utf8Length } from '../clipboard/payload.ts';
import { PROPOSAL_LIMITS, type ProposalIssue } from './schema.ts';

type BudgetItem = {
	commands?: unknown;
	alternatives?: unknown;
	meta?: unknown;
	[k: string]: unknown;
};

export type ProposalBudget =
	| { fits: true; items: number; commands: number; alternativeCommands: number; bytes: number }
	| {
			fits: false;
			code: 'E_TOO_LARGE';
			message: string;
			items: number;
			commands: number;
			alternativeCommands: number;
			bytes: number;
			/** How many items fit (taken in time order). */
			fit: number;
			/**
			 * Sequence frames [start, end) the items that fit cover (end = where the first one that does not fit starts):
			 * run the pass on this range, then on the rest. null when the items carry no frames.
			 */
			suggestedRange: { start: number; end: number } | null;
			limits: { maxItems: number; maxCommands: number; maxAlternativeCommands: number; maxBytes: number };
	  };

const LIMITS = {
	maxItems: PROPOSAL_LIMITS.maxItems,
	maxCommands: PROPOSAL_LIMITS.maxCommands,
	maxAlternativeCommands: PROPOSAL_LIMITS.maxAlternativeCommands,
	maxBytes: PROPOSAL_LIMITS.maxBytes,
} as const;

/** Room kept for the proposal's own fields (title, summary, report, states, anchors) next to its items. */
const ENVELOPE_BYTES = PROPOSAL_LIMITS.maxReportBytes + 256 * 1024;

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** The sequence frame an item is about: `meta.frame`, else `meta.range.start` / `meta.start`, else null. */
export function itemFrame(item: BudgetItem): number | null {
	const m = item.meta && typeof item.meta === 'object' ? (item.meta as Record<string, unknown>) : {};
	if (finite(m.frame)) return m.frame;
	const r = m.range && typeof m.range === 'object' ? (m.range as Record<string, unknown>) : {};
	if (finite(r.start)) return r.start;
	if (finite(m.start)) return m.start;
	return null;
}

function bytesOf(v: unknown): number {
	try {
		return utf8Length(JSON.stringify(v) ?? '') + 1;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

const countOf = (v: unknown) => (Array.isArray(v) ? v.length : 0);
function altCommands(v: unknown): number {
	if (!Array.isArray(v)) return 0;
	let n = 0;
	for (const a of v) n += countOf((a as { commands?: unknown } | null)?.commands);
	return n;
}

/**
 * Whether items fit one proposal and one accept transaction. Over the caps: E_TOO_LARGE with how many items fit in
 * time order (`frameOf`, default `itemFrame`) and the range they cover. Never throws.
 */
export function proposalBudget(
	items: readonly BudgetItem[],
	opts: { frameOf?: (item: BudgetItem) => number | null } = {},
): ProposalBudget {
	const frameOf = opts.frameOf ?? itemFrame;
	const rows = items.map((it, i) => {
		let frame: number | null = null;
		try {
			frame = frameOf(it);
		} catch {
			frame = null;
		}
		return {
			i,
			frame: finite(frame) ? frame : null,
			commands: countOf(it?.commands),
			alt: altCommands(it?.alternatives),
			bytes: bytesOf(it),
		};
	});
	const totals = rows.reduce(
		(t, r) => ({ commands: t.commands + r.commands, alt: t.alt + r.alt, bytes: t.bytes + r.bytes }),
		{ commands: 0, alt: 0, bytes: 0 },
	);
	const byteCap = LIMITS.maxBytes - ENVELOPE_BYTES;
	const over =
		rows.length > LIMITS.maxItems ||
		totals.commands > LIMITS.maxCommands ||
		totals.alt > LIMITS.maxAlternativeCommands ||
		totals.bytes > byteCap;
	if (!over)
		return {
			fits: true,
			items: rows.length,
			commands: totals.commands,
			alternativeCommands: totals.alt,
			bytes: totals.bytes,
		};
	// time order (items without a frame keep their place after the timed ones)
	const ordered = [...rows].sort(
		(a, b) => (a.frame ?? Number.POSITIVE_INFINITY) - (b.frame ?? Number.POSITIVE_INFINITY) || a.i - b.i,
	);
	let fit = 0;
	let c = 0;
	let alt = 0;
	let bytes = 0;
	for (const r of ordered) {
		if (
			fit + 1 > LIMITS.maxItems ||
			c + r.commands > LIMITS.maxCommands ||
			alt + r.alt > LIMITS.maxAlternativeCommands ||
			bytes + r.bytes > byteCap
		)
			break;
		fit++;
		c += r.commands;
		alt += r.alt;
		bytes += r.bytes;
	}
	const first = ordered[0]?.frame ?? null;
	const next = ordered[fit]?.frame ?? null;
	const suggestedRange = first !== null && next !== null && next > first ? { start: first, end: next } : null;
	const what = [
		rows.length > LIMITS.maxItems ? `${rows.length} items (at most ${LIMITS.maxItems})` : null,
		totals.commands > LIMITS.maxCommands
			? `${totals.commands} commands (one accept transaction holds at most ${LIMITS.maxCommands})`
			: null,
		totals.alt > LIMITS.maxAlternativeCommands
			? `${totals.alt} alternative commands (at most ${LIMITS.maxAlternativeCommands})`
			: null,
		totals.bytes > byteCap ? `${totals.bytes} bytes (at most ${byteCap})` : null,
	].filter(Boolean);
	const range = suggestedRange
		? `; run it on frames ${suggestedRange.start}–${suggestedRange.end} first (${fit} items fit), then on the rest`
		: `; ${fit} of ${rows.length} items fit: run it on a shorter range`;
	return {
		fits: false,
		code: 'E_TOO_LARGE',
		message: `The proposal is too large to accept in one step: ${what.join(', ')}${range}`,
		items: rows.length,
		commands: totals.commands,
		alternativeCommands: totals.alt,
		bytes: totals.bytes,
		fit,
		suggestedRange,
		limits: { ...LIMITS },
	};
}

/** The refusal of an over-cap budget as a proposal issue (with the budget as `detail`), or null when it fits. */
export function tooLargeIssue(budget: ProposalBudget): ProposalIssue | null {
	if (budget.fits) return null;
	const { fits: _f, code, message, ...detail } = budget;
	return { code, message, detail };
}
