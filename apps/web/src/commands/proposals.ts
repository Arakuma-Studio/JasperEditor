// Proposal review commands (spec 12 §2.5 / §2.7 "Review", P3-R4 / P3-R6): start reviewing a proposal (its ghosts
// appear on the Timeline and "Hear proposal" becomes available), leave the review, "Hear proposal" (A/B: the Program
// monitor plays the proposal's preview document instead of the sequence), and the Review keymap scope (WP3.3b):
// Enter accept, Backspace / Delete reject, U clear, A A/B, Space ▶ the item in context, Shift+Space the whole range,
// Ctrl+Enter Apply, Esc exit, Up / Down move between items. Agents reach the review, navigation, decisions and
// playback through the UI command catalogue; Apply and Discard are the user's (Apply needs a trusted key press or click:
// an agent's `ui_key` / `ui_command` is refused). Also registers the Program overlay chip "Hearing proposal".
import { z } from 'zod';
import { trackUserInput, userGestureActive } from '../agent-bridge/agent-input.ts';
import { t } from '../i18n/runtime.ts';
import {
	acceptAll,
	applyReview,
	cycleAlternative,
	decide,
	discardReview,
	exitReview,
	openReview,
	playReviewItem,
	playReviewRange,
	refreshReview,
	rejectAll,
	stepReviewItem,
} from '../proposals/actions.ts';
import { registerProposalUi } from '../proposals/register.tsx';
import { reviewCounts } from '../proposals/review.ts';
import { proposalsFor } from '../proposals/state.ts';
import type { CommandCtx, UiCommand } from './types.ts';

registerProposalUi();
trackUserInput();

const ReviewArgs = z
	.object({
		/** The proposal (`prp_…`); default: the newest one with items left to review. */
		proposalId: z.string().min(1).max(64).optional(),
	})
	.strict()
	.optional();

const HearArgs = z
	.object({
		/** Set it (true: hear the proposal, false: the sequence) instead of toggling. */
		on: z.boolean().optional(),
	})
	.strict()
	.optional();

const ItemArgs = z
	.object({
		/** The item (default: the one the review is on, i.e. the last selected). */
		itemId: z.string().min(1).max(64).optional(),
	})
	.strict()
	.optional();

const StepArgs = z
	.object({
		/** `time` (default): timeline order (◀ ▶); `list`: the Review panel's order (↑ ↓). */
		order: z.enum(['time', 'list']).optional(),
	})
	.strict()
	.optional();

const AltArgs = z
	.object({
		itemId: z.string().min(1).max(64).optional(),
		/** 1 (default): next alternate; -1: previous. */
		dir: z.union([z.literal(1), z.literal(-1)]).optional(),
	})
	.strict()
	.optional();

const hasSession = (ctx: CommandCtx) => !!ctx.session;
const reviewing = (ctx: CommandCtx) =>
	!!ctx.session && proposalsFor(ctx.session).getState().activeId !== null;
const writableReview = (ctx: CommandCtx) => reviewing(ctx) && !ctx.session!.getState().readOnly;
const itemsOf = (ctx: CommandCtx) => (ctx.session ? proposalsFor(ctx.session).getState().items : []);
const onItem = (ctx: CommandCtx) => writableReview(ctx) && itemsOf(ctx).some((it) => !it.setup);
const reveal = (ctx: CommandCtx) => (f: number) => ctx.services.get('timelineViewport')?.scrollToFrame(f);
const notReviewing = () => t('No proposal is under review');

const hasStale = (ctx: CommandCtx) =>
	writableReview(ctx) && itemsOf(ctx).some((it) => !it.setup && it.state === 'stale');

export const proposalCommands: UiCommand[] = [
	{
		id: 'proposals.review',
		label: 'Review Proposal',
		description:
			'Review a proposal in the Timeline: its items are drawn as ghosts (accept / reject them on their cards) and "Hear proposal" plays it in the Program monitor. Default: the newest proposal with items left to review.',
		scope: 'global',
		agentExposed: true,
		argsSchema: ReviewArgs,
		when: hasSession,
		disabledReason: () => t('Open a project first'),
		run: async (ctx, args) => {
			const session = ctx.session;
			if (!session) return;
			const c = proposalsFor(session);
			let id = (args as z.infer<typeof ReviewArgs>)?.proposalId ?? null;
			if (!id) {
				await c.load();
				const seqId = session.getState().activeSequenceId;
				const open = c
					.getState()
					.list.filter((p) => !p.decided)
					.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
				id = (open.find((p) => p.sequenceId === seqId) ?? open[0])?.id ?? null;
			}
			if (!id) {
				ctx.ui.toast({ kind: 'info', message: t('No proposal to review') });
				return;
			}
			await openReview(session, id);
		},
	},
	{
		id: 'proposals.refresh',
		label: 'Refresh Proposal',
		description:
			'Ask the proposal’s producer to re-plan its stale items on the current edit ("Refresh proposal"): they come back pending for review; nothing is applied. Disabled when no item is stale; refused when the producer cannot re-plan.',
		scope: 'global',
		agentExposed: true,
		when: hasStale,
		disabledReason: (ctx) =>
			!reviewing(ctx)
				? notReviewing()
				: ctx.session?.getState().readOnly
					? t('The project is read-only')
					: t('No item changed since it was proposed'),
		run: async (ctx) => {
			if (ctx.session) await refreshReview(ctx.session);
		},
	},
	{
		id: 'proposals.exitReview',
		label: 'Exit Proposal Review',
		description:
			'Stop reviewing the proposal: its ghosts go and the Program monitor plays the sequence again',
		scope: 'global',
		agentExposed: true,
		when: reviewing,
		disabledReason: () => t('No proposal is under review'),
		run: (ctx) => {
			if (ctx.session) exitReview(ctx.session);
		},
	},
	{
		id: 'proposals.toggleHear',
		label: 'Hear Proposal',
		description:
			'A/B: the Program monitor plays the proposal under review (picture and sound of its preview document) or the sequence as it is; switches while playing. `on` sets it instead of toggling.',
		scope: 'global',
		agentExposed: true,
		when: reviewing,
		argsSchema: HearArgs,
		checked: (ctx) => !!ctx.session && proposalsFor(ctx.session).getState().hear,
		disabledReason: () => t('No proposal is under review'),
		run: (ctx, args) => {
			if (!ctx.session) return;
			const on = (args as z.infer<typeof HearArgs>)?.on;
			const c = proposalsFor(ctx.session);
			if (on === undefined) c.toggleHear();
			else c.setHear(on);
		},
	},
	{
		id: 'proposals.acceptItem',
		label: 'Accept Proposal Item',
		description:
			'Accept an item of the proposal under review (default: the current one) and what it requires; it is applied with the others by Apply',
		scope: 'review',
		agentExposed: true,
		argsSchema: ItemArgs,
		when: onItem,
		disabledReason: notReviewing,
		run: async (ctx, args) => {
			const id = (args as z.infer<typeof ItemArgs>)?.itemId;
			if (ctx.session) await decide(ctx.session, 'accept', id ? [id] : undefined);
		},
	},
	{
		id: 'proposals.rejectItem',
		label: 'Reject Proposal Item',
		description: 'Reject an item of the proposal under review (default: the current one); the agent reads it',
		scope: 'review',
		agentExposed: true,
		argsSchema: ItemArgs,
		when: onItem,
		disabledReason: notReviewing,
		run: async (ctx, args) => {
			const id = (args as z.infer<typeof ItemArgs>)?.itemId;
			if (ctx.session) await decide(ctx.session, 'reject', id ? [id] : undefined);
		},
	},
	{
		id: 'proposals.clearItem',
		label: 'Clear Proposal Item Decision',
		description: 'Put an item of the proposal under review back to pending (default: the current one)',
		scope: 'review',
		agentExposed: true,
		argsSchema: ItemArgs,
		when: onItem,
		disabledReason: notReviewing,
		run: async (ctx, args) => {
			const id = (args as z.infer<typeof ItemArgs>)?.itemId;
			if (ctx.session) await decide(ctx.session, 'clear', id ? [id] : undefined);
		},
	},
	{
		id: 'proposals.acceptAll',
		label: 'Accept All Proposal Items',
		description:
			'Accept every pending or stale item of the proposal under review (rejected items stay rejected)',
		scope: 'global',
		agentExposed: true,
		when: (ctx) =>
			writableReview(ctx) &&
			itemsOf(ctx).some((it) => !it.setup && (it.state === 'pending' || it.state === 'stale')),
		disabledReason: () => t('Nothing left to accept'),
		run: async (ctx) => {
			if (ctx.session) await acceptAll(ctx.session);
		},
	},
	{
		id: 'proposals.rejectAll',
		label: 'Reject All Proposal Items',
		description: 'Reject every item of the proposal under review that is not applied yet',
		scope: 'global',
		agentExposed: true,
		when: (ctx) =>
			writableReview(ctx) && reviewCounts(itemsOf(ctx)).open + reviewCounts(itemsOf(ctx)).accepted > 0,
		disabledReason: () => t('Nothing left to reject'),
		run: async (ctx) => {
			if (ctx.session) await rejectAll(ctx.session);
		},
	},
	...([1, -1] as const).map(
		(dir): UiCommand => ({
			id: dir > 0 ? 'proposals.nextItem' : 'proposals.prevItem',
			label: dir > 0 ? 'Next Proposal Item' : 'Previous Proposal Item',
			description:
				'Go to the next / previous item of the proposal under review: its ghost is selected and the playhead moves to its anchor',
			scope: 'review',
			agentExposed: true,
			repeat: true,
			argsSchema: StepArgs,
			when: (ctx) => reviewing(ctx) && itemsOf(ctx).some((it) => !it.setup),
			disabledReason: notReviewing,
			run: (ctx, args) => {
				if (ctx.session)
					stepReviewItem(ctx.session, dir, (args as z.infer<typeof StepArgs>)?.order ?? 'time', reveal(ctx));
			},
		}),
	),
	{
		id: 'proposals.cycleAlternative',
		label: 'Next Proposal Alternate',
		description:
			'Swap an item of the proposal under review to its next (dir 1) or previous (dir -1) alternate (default: the current item); the choice is stored for the agent',
		scope: 'review',
		agentExposed: true,
		argsSchema: AltArgs,
		when: onItem,
		disabledReason: notReviewing,
		run: async (ctx, args) => {
			const a = args as z.infer<typeof AltArgs>;
			if (ctx.session) await cycleAlternative(ctx.session, a?.dir ?? 1, a?.itemId);
		},
	},
	{
		id: 'proposals.playItem',
		label: 'Play Proposal Item in Context',
		description:
			'Play the current item of the proposal under review in context: pre-roll, the item and 1 s after, with "Hear proposal" on',
		scope: 'review',
		agentExposed: true,
		argsSchema: ItemArgs,
		when: (ctx) => reviewing(ctx) && itemsOf(ctx).some((it) => !it.setup),
		disabledReason: notReviewing,
		run: (ctx, args) => {
			if (ctx.session) playReviewItem(ctx.session, (args as z.infer<typeof ItemArgs>)?.itemId);
		},
	},
	{
		id: 'proposals.playRange',
		label: 'Play Proposal Range',
		description:
			'Play the whole proposal under review with "Hear proposal" on: from 2 s before its first item to the end of its last',
		scope: 'review',
		agentExposed: true,
		when: reviewing,
		disabledReason: notReviewing,
		run: (ctx) => {
			if (ctx.session) playReviewRange(ctx.session);
		},
	},
	{
		id: 'proposals.apply',
		label: 'Apply Accepted Proposal Items',
		description:
			'Apply the accepted items of the proposal under review as ONE undoable step. Only your own key press or click applies: agents cannot run it',
		scope: 'review',
		when: (ctx) => writableReview(ctx) && itemsOf(ctx).some((it) => it.state === 'accepted'),
		disabledReason: () => t('Accept items first'),
		run: async (ctx) => {
			if (ctx.session) await applyReview(ctx.session, { trusted: userGestureActive() });
		},
	},
	{
		id: 'proposals.discard',
		label: 'Discard Proposal',
		description: 'Delete the proposal under review (after a confirmation); nothing in the sequence changes',
		scope: 'global',
		when: writableReview,
		disabledReason: notReviewing,
		run: async (ctx) => {
			if (ctx.session) await discardReview(ctx.session);
		},
	},
];
