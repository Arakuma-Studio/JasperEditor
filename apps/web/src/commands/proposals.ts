// Proposal review commands (spec 12 §2.5 / §2.7 "Review", P3-R4 / P3-R6 ghost part): start reviewing a proposal (its
// ghosts appear on the Timeline and "Hear proposal" becomes available), leave the review, and "Hear proposal" (A/B:
// the Program monitor plays the proposal's preview document instead of the sequence). Agents reach them through the
// UI command catalogue; the decisions and Apply are the user's (Apply needs a trusted gesture: the ghost card and,
// with WP3.3b, the review bar). Also registers the Program overlay chip "Hearing proposal".
import { z } from 'zod';
import { t } from '../i18n/runtime.ts';
import { registerProposalUi } from '../proposals/register.tsx';
import { proposalsFor } from '../proposals/state.ts';
import type { CommandCtx, UiCommand } from './types.ts';

registerProposalUi();

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

const hasSession = (ctx: CommandCtx) => !!ctx.session;
const reviewing = (ctx: CommandCtx) =>
	!!ctx.session && proposalsFor(ctx.session).getState().activeId !== null;

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
			const r = await c.setActive(id);
			if (!r.ok) ctx.ui.toast({ kind: 'warning', message: t('Cannot review the proposal: {0}', r.message) });
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
			if (ctx.session) proposalsFor(ctx.session).exit();
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
];
