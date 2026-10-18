// Ambience beds and room tone (spec 12 §4 P6-E12; wp-note "Phase 6 → WP-E8"): Sequence ▸ Sound Design ▸ Lay Ambience
// Bed… (the dialog: the bed, where scenes change, the measured scenes) and Fill Room Tone (the holes between dialogue
// clips filled with the room tone closest to the dialogue's noise floor: one undo step, Undo in the toast; or a
// proposal). Agents have the same through MCP `lay_ambience_bed` / `fill_room_tone` and here `sound.fillRoomTone`.
import { dialogueGaps } from '@jasper/project';
import { toasts, toast as uiToast } from '@jasper/ui';
import { z } from 'zod';
import { t } from '../i18n/runtime.ts';
import { openReview } from '../proposals/actions.ts';
import { AMBIENCE_BED_DIALOG, registerAmbienceBedDialog } from '../sound/AmbienceBedDialog.tsx';
import { roomToneSummary, runRoomTone } from '../sound/bed-jobs.ts';
import { entryOfRevision, undoIfTop } from '../sound/mix-jobs.ts';
import { ReportedCommandError, runCommand } from './registry.ts';
import { sequenceContext } from './sequence-context.ts';
import type { CommandCtx, CommandScope, UiCommand } from './types.ts';

registerAmbienceBedDialog();

const G: CommandScope = 'global';
const FillArgs = z
	.object({ mode: z.enum(['apply', 'propose']).optional() })
	.strict()
	.optional();

const writable = (ctx: CommandCtx) => {
	const e = sequenceContext(ctx);
	return !!e && !e.session.getState().readOnly;
};

/** Whether the active sequence has audio to lay a bed under (any clip at all). */
const hasContent = (ctx: CommandCtx) => {
	const e = sequenceContext(ctx);
	return !!e && Object.keys(e.seq.clips).length > 0;
};

async function fillRoomTone(ctx: CommandCtx, mode: 'apply' | 'propose'): Promise<void> {
	const e = sequenceContext(ctx);
	if (!e) return;
	const key = `room-tone:${e.seq.id}`;
	const title = t('Matching room tone to the dialogue…');
	const progress = uiToast({ kind: 'progress', title, progress: { value: null }, dedupeKey: key });
	try {
		const r = await runRoomTone(
			ctx.engine,
			{ projectId: e.session.projectId, sequenceId: e.seq.id, mode },
			{
				onJob: (j) =>
					uiToast({
						kind: 'progress',
						title,
						...(j.stage ? { detail: j.stage } : {}),
						progress: { value: j.progress, jobId: j.id },
						dedupeKey: key,
					}),
			},
		);
		toasts.dismiss(progress);
		const sum = roomToneSummary(r);
		if (r.proposalId) {
			if (await openReview(e.session, r.proposalId)) void runCommand('panel.focus.review', ctx);
			uiToast({ kind: 'success', title: sum.title, detail: sum.detail });
			return;
		}
		const entry = entryOfRevision(e.session, r.revision);
		uiToast({
			kind: r.applied ? 'success' : 'info',
			title: sum.title,
			detail: sum.detail,
			durationMs: 15_000,
			...(r.applied
				? {
						actions: [
							{
								label: t('Undo'),
								run: () => {
									if (!undoIfTop(e.session, entry))
										uiToast({ kind: 'info', title: t('Newer edits came after it; use the History panel') });
								},
							},
						],
					}
				: {}),
		});
	} catch (err) {
		toasts.dismiss(progress);
		ctx.ui.toast({
			kind: 'warning',
			message: t('Could not fill room tone'),
			detail: err instanceof Error ? err.message : String(err),
		});
		throw new ReportedCommandError(err);
	}
}

export const soundBedCommands: UiCommand[] = [
	{
		id: 'sound.layAmbienceBed',
		label: 'Lay Ambience Bed…',
		description:
			'Lay one ambience per scene of the active sequence (scenes change at cuts to other footage, scene markers and measured shot changes): the recording looped at its measured clean window and loop points with crossfades, crossfaded between scenes, at the ambience level, optionally ducked under the dialogue; one undo step, or a proposal for review',
		scope: G,
		capability: 'engine',
		when: (ctx) => writable(ctx) && hasContent(ctx),
		disabledReason: (ctx) => {
			const e = sequenceContext(ctx);
			if (!e) return t('Open a sequence first');
			if (e.session.getState().readOnly) return t('The project is read-only');
			return t('The sequence is empty');
		},
		run: (ctx) => {
			const e = sequenceContext(ctx);
			if (!e) return;
			ctx.ui.openDialog(AMBIENCE_BED_DIALOG, {
				session: e.session,
				engine: ctx.engine,
				sequenceId: e.seq.id,
				toast: ctx.ui.toast,
				onReview: () => void runCommand('panel.focus.review', ctx),
			});
		},
	},
	{
		id: 'sound.fillRoomTone',
		label: 'Fill Room Tone',
		description:
			'Fill the holes between the dialogue clips of the active sequence (under 10 s, inside a dialogue scene) with the room tone closest to the dialogue’s measured noise floor (else its own quietest stretch), looped at the floor’s level: one undo step (mode "propose": a proposal for review)',
		scope: G,
		capability: 'engine',
		agentExposed: true,
		argsSchema: FillArgs,
		when: (ctx) => {
			const e = sequenceContext(ctx);
			return (
				!!e && !e.session.getState().readOnly && dialogueGaps(e.session.getCommitted(), e.seq).length > 0
			);
		},
		disabledReason: (ctx) => {
			const e = sequenceContext(ctx);
			if (!e) return t('Open a sequence first');
			if (e.session.getState().readOnly) return t('The project is read-only');
			return t('No gap between dialogue clips (type the dialogue in Essential Sound)');
		},
		run: async (ctx, args) => {
			const a = FillArgs.parse(args);
			await fillRoomTone(ctx, a?.mode ?? 'apply');
		},
	},
];
