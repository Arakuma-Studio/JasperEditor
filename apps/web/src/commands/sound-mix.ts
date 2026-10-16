// Sound design mixing commands (spec 12 §2.4 / §2.7, P4-R4 / P4-R5; wp-note "Phase 4 → WP4.2b"):
// Sequence ▸ Sound Design ▸ Rebalance SFX Levels (the engine's masking solver on every sound effect, or on `clipIds`;
// apply mode: one undo step, the user's gains kept unless named), Room Glue… and Delivery Target… (dialogs), and Essential
// Sound's Auto gain toggle (`sound.setAutoGain`). Agents reach every entry through the UI command catalogue; the same
// edits are MCP tools too (`rebalance_sfx`, `set_room_glue`, `apply_delivery`, `apply_commands` with
// `soundDesign.setAutoGain`).
import { type Command, isSfxClip } from '@jasper/project';
import { toasts, toast as uiToast } from '@jasper/ui';
import { z } from 'zod';
import { t } from '../i18n/runtime.ts';
import { sfxOf } from '../sound/design-model.ts';
import { DELIVERY_DIALOG, ROOM_GLUE_DIALOG, registerMixDialogs } from '../sound/MixDialogs.tsx';
import { entryOfRevision, rebalanceSummary, runRebalance, undoIfTop } from '../sound/mix-jobs.ts';
import { sfxLevelView } from '../sound/mix-model.ts';
import { ReportedCommandError } from './registry.ts';
import { type ResolvedSequenceCommandContext, sequenceContext } from './sequence-context.ts';
import type { CommandCtx, CommandScope, UiCommand } from './types.ts';

registerMixDialogs();

const G: CommandScope = 'global';

const ClipIdsArgs = z
	.object({ clipIds: z.array(z.string().min(1).max(128)).min(1).max(2000).optional() })
	.strict()
	.optional();
const AutoGainArgs = z
	.object({ clipIds: z.array(z.string().min(1).max(128)).min(1).max(2000).optional(), auto: z.boolean() })
	.strict();

/** Sound effects of the sequence (`isSfxClip`), or of `ids` when given (unknown / non-effect ids dropped). */
function sfxClipIds(e: ResolvedSequenceCommandContext, ids?: readonly string[]): string[] {
	const pool = ids ? ids.map((id) => e.seq.clips[id]).filter((c) => !!c) : Object.values(e.seq.clips);
	return pool.filter((c) => c.kind === 'audio' && isSfxClip(c)).map((c) => c.id);
}

/** The clips the Auto gain toggle acts on: `clipIds`, else the selected placed sound effects. */
function autoGainTargets(e: ResolvedSequenceCommandContext, ids?: readonly string[]): string[] {
	const pool = ids ?? e.session.getState().selection.timeline.clips;
	return sfxClipIds(e, pool).filter((id) => !!sfxOf(e.seq.clips[id]));
}

const writable = (ctx: CommandCtx) => {
	const e = sequenceContext(ctx);
	return !!e && !e.session.getState().readOnly;
};

/** Runs the rebalance job for the user with a progress toast; the result toast offers Undo. */
async function rebalance(
	ctx: CommandCtx,
	e: ResolvedSequenceCommandContext,
	clipIds: string[] | undefined,
): Promise<{ applied: boolean; changed: string[] }> {
	const key = `rebalance:${e.seq.id}`;
	const title = clipIds
		? t('Rebalancing {0} sound effects…', clipIds.length)
		: t('Rebalancing the sound effects…');
	const progress = uiToast({ kind: 'progress', title, progress: { value: null }, dedupeKey: key });
	try {
		const r = await runRebalance(
			ctx.engine,
			{ projectId: e.session.projectId, sequenceId: e.seq.id, ...(clipIds ? { clipIds } : {}) },
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
		const sum = rebalanceSummary(r);
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
		return {
			applied: r.applied,
			changed: r.report.events.filter((ev) => Math.abs(ev.changeDb) >= 0.01).map((ev) => ev.clipId),
		};
	} catch (err) {
		toasts.dismiss(progress);
		ctx.ui.toast({
			kind: 'warning',
			message: t('Could not rebalance the sound effects'),
			detail: err instanceof Error ? err.message : String(err),
		});
		throw new ReportedCommandError(err);
	}
}

export const soundMixCommands: UiCommand[] = [
	{
		id: 'sound.rebalanceSfx',
		label: 'Rebalance SFX Levels',
		description:
			'Solve the gains of the active sequence’s sound effects (or of clipIds) against the bed with the masking solver — every sound reaches its target lift or says what limited it (dialogue, the bed level, headroom…) — and apply them as one undoable edit; gains you set by hand are kept unless named',
		scope: G,
		capability: 'engine',
		agentExposed: true,
		argsSchema: ClipIdsArgs,
		when: (ctx) => {
			const e = sequenceContext(ctx);
			return !!e && !e.session.getState().readOnly && sfxClipIds(e).length > 0;
		},
		disabledReason: (ctx) => {
			const e = sequenceContext(ctx);
			if (!e) return t('Open a sequence first');
			if (e.session.getState().readOnly) return t('The project is read-only');
			return t('The sequence has no sound effects');
		},
		run: async (ctx, args) => {
			const e = sequenceContext(ctx);
			if (!e) return;
			const a = ClipIdsArgs.parse(args);
			const ids = a?.clipIds ? sfxClipIds(e, a.clipIds) : undefined;
			if (ids && ids.length === 0) {
				ctx.ui.toast({ kind: 'warning', message: t('Select sound effect clips') });
				return;
			}
			await rebalance(ctx, e, ids);
		},
	},
	{
		id: 'sound.setAutoGain',
		label: 'Auto Gain',
		description:
			'Essential Sound ▸ Auto gain for the selected placed sounds (or clipIds): auto false keeps each current gain as your own (rebalancing and delivery presets leave it alone); auto true solves them against the bed again (engine)',
		scope: G,
		agentExposed: true,
		argsSchema: AutoGainArgs,
		// the targets come from the arguments or the selection: checked when it runs
		when: writable,
		disabledReason: () => t('Open a sequence first'),
		run: async (ctx, args) => {
			const e = sequenceContext(ctx);
			if (!e) return;
			const a = AutoGainArgs.parse(args);
			const ids = autoGainTargets(e, a.clipIds);
			if (!ids.length) {
				ctx.ui.toast({ kind: 'warning', message: t('Select placed sound effects') });
				return;
			}
			const flag = (auto: boolean, which: string[]) => {
				if (!which.length) return true;
				const r = e.session.apply({
					label: auto ? t('Auto Gain On') : t('Auto Gain Off'),
					origin: 'user',
					sequenceId: e.seq.id,
					commands: [{ type: 'soundDesign.setAutoGain', clipIds: which, auto } as Command],
				});
				if (!r.ok) ctx.ui.toast({ kind: 'warning', message: r.errors[0]?.message ?? t('Edit failed') });
				return r.ok;
			};
			if (!a.auto) {
				flag(
					false,
					ids.filter((id) => sfxLevelView(e.seq.clips[id]!)?.auto),
				);
				return;
			}
			const manual = ids.filter((id) => !sfxLevelView(e.seq.clips[id]!)?.auto);
			if (!manual.length) return;
			if (!ctx.capabilities.has('engine')) {
				// no engine: hand the recorded level back without a new solve
				flag(true, manual);
				return;
			}
			const r = await rebalance(ctx, e, manual);
			// a clip the solve did not change (same gain) or skipped keeps its manual mark: clear it
			const now = sequenceContext(ctx);
			if (!now) return;
			const left = manual.filter((id) => {
				const c = now.seq.clips[id];
				return !!c && !sfxLevelView(c)?.auto && !r.changed.includes(id);
			});
			flag(true, left);
		},
	},
	{
		id: 'sound.roomGlue',
		label: 'Room Glue…',
		description:
			'Glue the sound effects of the active sequence with a shared short room (an "SFX Room" submix with a Studio Reverb and post-fader sends from the sound-effect tracks): on / off, send level, decay, mix, pre-delay; one undo step',
		scope: G,
		when: writable,
		disabledReason: () => t('Open a sequence first'),
		run: (ctx) => {
			const e = sequenceContext(ctx);
			if (!e) return;
			ctx.ui.openDialog(ROOM_GLUE_DIALOG, { session: e.session, sequenceId: e.seq.id, toast: ctx.ui.toast });
		},
	},
	{
		id: 'sound.deliveryTarget',
		label: 'Delivery Target…',
		description:
			'Mix the active sequence to a delivery preset (web −14 LUFS / −1 dBTP, podcast −16, broadcast EBU R 128 −23, ATSC A/85 −24): loudness normalisation, Auto-Match by type, ducking under the voice and the sound effects solved again, as one undoable edit; shows what it measured',
		scope: G,
		capability: 'engine',
		when: writable,
		disabledReason: () => t('Open a sequence first'),
		run: (ctx) => {
			const e = sequenceContext(ctx);
			if (!e) return;
			ctx.ui.openDialog(DELIVERY_DIALOG, {
				session: e.session,
				engine: ctx.engine,
				sequenceId: e.seq.id,
				toast: ctx.ui.toast,
			});
		},
	},
];
