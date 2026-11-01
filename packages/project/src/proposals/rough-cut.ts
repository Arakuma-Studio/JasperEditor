// An agent's own rough cut as a reviewable proposal (spec 18 AF-PROP-001 / AF-PROP-002): the input of MCP
// `propose_edits` (the strategy in 1–8 sentences, items with a Review group, the reason, the beat and quote they are
// about, ordinary edit commands and alternative command sets; limits), the proposal draft it becomes (feature
// `rough-cut`, item ids by index, the strategy as the summary, beat / quote / reason in `meta`) and the lenient reader
// of that meta for the Review panel. Pure; the engine validates the draft like any proposal (every item dry-run) and
// refuses the whole of it when one item fails (`proposalItemFailures`).
import { z } from 'zod';
import { ROUGH_CUT_FEATURE } from './features.ts';
import { PROPOSAL_LIMITS, type ProposalDraft } from './schema.ts';

/** Review groups of a rough cut, in Review order (= the feature's declared groups). */
export const ROUGH_CUT_GROUPS = ['selects', 'removed', 'retakes', 'reorder', 'b-roll', 'other'] as const;
export type RoughCutGroup = (typeof ROUGH_CUT_GROUPS)[number];

export const ROUGH_CUT_LIMITS = {
	maxItems: 200,
	/** Commands of every item and alternative together. */
	maxCommands: 2000,
	maxItemCommands: 100,
	maxAlternatives: PROPOSAL_LIMITS.maxAlternatives,
	maxStrategy: 2000,
	maxStrategySentences: 8,
	maxReason: 280,
	maxBeat: 40,
	maxQuote: 280,
} as const;

/**
 * Sentences in `text`: one per end mark (. ! ? … followed by a space and a capital letter, digit or opening quote, or
 * by the end; 。！？ always), plus a last sentence without one. "e.g. the", "2.5" and "v1.2" end nothing. Never throws.
 */
export function strategySentences(text: string): number {
	const s = typeof text === 'string' ? text.trim() : '';
	if (!s) return 0;
	const ends = s.match(/[.!?…]+(?=\s+["'“‘([]?[\p{Lu}\p{N}]|\s*$)|[。！？]+/gu)?.length ?? 0;
	return ends + (/[.!?…。！？]\s*$/u.test(s) ? 0 : 1);
}

const text = (max: number) => z.string().trim().min(1).max(max);
const Commands = z
	.array(z.record(z.string(), z.unknown()))
	.min(1)
	.max(ROUGH_CUT_LIMITS.maxItemCommands, `at most ${ROUGH_CUT_LIMITS.maxItemCommands} commands per item`);

export const RoughCutAlternativeSchema = z.strictObject({
	label: text(PROPOSAL_LIMITS.maxLabel),
	reason: text(ROUGH_CUT_LIMITS.maxReason).optional(),
	commands: Commands,
});

export const RoughCutItemSchema = z.strictObject({
	group: z.enum(ROUGH_CUT_GROUPS),
	reason: text(ROUGH_CUT_LIMITS.maxReason),
	beat: text(ROUGH_CUT_LIMITS.maxBeat).optional(),
	quote: text(ROUGH_CUT_LIMITS.maxQuote).optional(),
	commands: Commands,
	alternatives: z.array(RoughCutAlternativeSchema).max(ROUGH_CUT_LIMITS.maxAlternatives).optional(),
});
export type RoughCutItem = z.infer<typeof RoughCutItemSchema>;

export const RoughCutStrategySchema = text(ROUGH_CUT_LIMITS.maxStrategy).refine(
	(s) => strategySentences(s) <= ROUGH_CUT_LIMITS.maxStrategySentences,
	`the strategy is the plan in 1–${ROUGH_CUT_LIMITS.maxStrategySentences} sentences`,
);

/** Commands of every item and alternative of a rough cut. */
export function roughCutCommandCount(
	items: readonly Pick<RoughCutItem, 'commands' | 'alternatives'>[],
): number {
	let n = 0;
	for (const it of items) {
		n += it.commands.length;
		for (const a of it.alternatives ?? []) n += a.commands.length;
	}
	return n;
}

export const RoughCutInputSchema = z
	.strictObject({
		sequenceId: z.string().min(1).max(128),
		title: text(PROPOSAL_LIMITS.maxTitle),
		strategy: RoughCutStrategySchema,
		items: z.array(RoughCutItemSchema).min(1).max(ROUGH_CUT_LIMITS.maxItems),
	})
	.superRefine((v, ctx) => {
		const n = roughCutCommandCount(v.items);
		if (n > ROUGH_CUT_LIMITS.maxCommands)
			ctx.addIssue({
				code: 'custom',
				path: ['items'],
				message: `a rough cut holds at most ${ROUGH_CUT_LIMITS.maxCommands} commands in all (alternatives included), got ${n}: propose it in parts`,
			});
	});
export type RoughCutInput = z.infer<typeof RoughCutInputSchema>;

/** The id of the item at `index` ("e0", "e1", …): failures name the same index. */
export const roughCutItemId = (index: number) => `e${index}`;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** The proposal draft of a parsed rough cut (feature `rough-cut`; the strategy is its summary). */
export function roughCutDraft(input: RoughCutInput): ProposalDraft {
	return {
		feature: ROUGH_CUT_FEATURE,
		sequenceId: input.sequenceId,
		title: input.title,
		summary: input.strategy,
		items: input.items.map((it, i) => ({
			id: roughCutItemId(i),
			label: clip(it.beat ? `${it.beat}: ${it.reason}` : it.reason, PROPOSAL_LIMITS.maxLabel),
			group: it.group,
			commands: it.commands,
			meta: {
				group: it.group,
				reason: it.reason,
				...(it.beat ? { beat: it.beat } : {}),
				...(it.quote ? { quote: it.quote } : {}),
			},
			...(it.alternatives?.length
				? {
						alternatives: it.alternatives.map((a) => ({
							label: a.label,
							commands: a.commands,
							...(a.reason ? { meta: { reason: a.reason } } : {}),
						})),
					}
				: {}),
		})),
	};
}

/** What a rough-cut item says about itself (its meta), for the Review rows. */
export type RoughCutMeta = { group?: string; reason: string; beat?: string; quote?: string };

const str = (v: unknown, max: number): string | null =>
	typeof v === 'string' && v.trim() ? clip(v.trim(), max) : null;

/** The rough-cut meta of an item (or of an alternative: its reason), null when it has no reason. Never throws. */
export function roughCutMetaOf(meta: unknown): RoughCutMeta | null {
	if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
	const m = meta as Record<string, unknown>;
	const reason = str(m.reason, ROUGH_CUT_LIMITS.maxReason);
	if (!reason) return null;
	const group = str(m.group, PROPOSAL_LIMITS.maxGroup);
	const beat = str(m.beat, ROUGH_CUT_LIMITS.maxBeat);
	const quote = str(m.quote, ROUGH_CUT_LIMITS.maxQuote);
	return {
		...(group ? { group } : {}),
		reason,
		...(beat ? { beat } : {}),
		...(quote ? { quote } : {}),
	};
}
