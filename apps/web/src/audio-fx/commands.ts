// audio-fx UI commands: Window ▸ Essential Sound, Clip ▸ Audio Options ▸ Remix… / Revert Remix / Auto-Match
// Loudness / Clear Audio Type. Remix… opens Essential Sound ▸
// Duration (Premiere's flow); agents pass {targetSeconds} to remix directly. Remixed clips get Revert Remix in their
// context menu.
import { type AudioClip, readEssentialSound, type Sequence } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { z } from 'zod';
import type { CommandCtx, UiCommand } from '../commands/types.ts';
import { clipMenuExtensions } from '../extensions/index.ts';
import { autoMatchLoudness, autoMatchMessage, remixClip, selectedAudioClips } from './ops.ts';

const editable = (ctx: CommandCtx) => !!ctx.session && !ctx.session.getState().readOnly;

function selection(ctx: CommandCtx): { seq: Sequence | null; clips: AudioClip[] } {
	return ctx.session ? selectedAudioClips(ctx.session) : { seq: null, clips: [] };
}

function openPanel(ctx: CommandCtx): void {
	ctx.services.get('shell')?.focusPanel('essentialSound');
}

function revertRemix(session: EditorSession, clipId: string): string | null {
	const r = session.apply({
		label: 'Revert Remix',
		origin: 'user',
		commands: [{ type: 'clip.remixRevert', clipId }] as never,
	});
	return r.ok ? null : (r.errors?.[0]?.message ?? 'Revert Remix failed');
}

const RemixArgs = z
	.strictObject({
		targetSeconds: z.number().positive(),
		segments: z.number().min(0).max(100).optional(),
		variations: z.number().min(0).max(100).optional(),
	})
	.optional();

export const audioFxCommands: UiCommand[] = [
	{
		id: 'audio.essentialSound',
		label: 'Essential Sound',
		description: 'Open the Essential Sound panel (audio types, repair, clarity, loudness, ducking, remix)',
		scope: 'global',
		agentExposed: true,
		run: openPanel,
	},
	{
		id: 'audio.remix',
		label: 'Remix…',
		description: 'Remix the selected music clip to a duration on its beats (Essential Sound ▸ Duration)',
		scope: 'global',
		agentExposed: true,
		capability: 'engine',
		argsSchema: RemixArgs,
		when: (ctx) => editable(ctx) && selection(ctx).clips.length === 1,
		disabledReason: (ctx) => (selection(ctx).clips.length === 1 ? undefined : 'Select one music clip'),
		run: async (ctx, raw) => {
			const args = RemixArgs.parse(raw);
			const { seq, clips } = selection(ctx);
			if (!ctx.session || !seq || clips.length !== 1) return;
			if (!args) return openPanel(ctx);
			try {
				const r = await remixClip(ctx.session, ctx.engine, seq.id, clips[0]!.id, args.targetSeconds, args);
				ctx.ui.toast({
					kind: 'success',
					message: `Remixed to ${r.lengthSeconds.toFixed(2)} s (${r.pieces} segments, ${Math.round(r.bpm)} BPM)`,
				});
			} catch (e) {
				ctx.ui.toast({ kind: 'error', message: 'Remix failed', detail: (e as Error).message });
			}
		},
	},
	{
		id: 'audio.revertRemix',
		label: 'Revert Remix',
		description: 'Restore the original clip of a remix',
		scope: 'global',
		agentExposed: true,
		when: (ctx) => editable(ctx) && selection(ctx).clips.some((c) => c.remix),
		disabledReason: (ctx) =>
			selection(ctx).clips.some((c) => c.remix) ? undefined : 'Select a remixed clip',
		run: (ctx) => {
			const c = selection(ctx).clips.find((x) => x.remix);
			if (!ctx.session || !c) return;
			const err = revertRemix(ctx.session, c.id);
			if (err) ctx.ui.toast({ kind: 'error', message: err });
		},
	},
	{
		id: 'audio.autoMatchLoudness',
		label: 'Auto-Match Loudness',
		description: 'Match the loudness of the selected typed clips to −23 LUFS (Essential Sound ▸ Loudness)',
		scope: 'global',
		agentExposed: true,
		capability: 'engine',
		when: (ctx) => editable(ctx) && selection(ctx).clips.some((c) => readEssentialSound(c.essential)),
		disabledReason: (ctx) =>
			selection(ctx).clips.some((c) => readEssentialSound(c.essential))
				? undefined
				: 'Give the clips an audio type in Essential Sound',
		run: async (ctx) => {
			const { seq, clips } = selection(ctx);
			if (!ctx.session || !seq) return;
			const ids = clips.filter((c) => readEssentialSound(c.essential)).map((c) => c.id);
			try {
				const out = await autoMatchLoudness(ctx.session, ctx.engine, seq.id, ids);
				const message = autoMatchMessage(out, undefined);
				ctx.ui.toast(
					Object.values(out).some((r) => 'gainDb' in r)
						? { kind: 'success', message }
						: { kind: 'error', message: 'Auto-Match', detail: message },
				);
			} catch (e) {
				ctx.ui.toast({ kind: 'error', message: 'Auto-Match failed', detail: (e as Error).message });
			}
		},
	},
	{
		id: 'audio.clearAudioType',
		label: 'Clear Audio Type',
		description: 'Remove the Essential Sound type and every change it made',
		scope: 'global',
		agentExposed: true,
		when: (ctx) => editable(ctx) && selection(ctx).clips.some((c) => readEssentialSound(c.essential)),
		run: (ctx) => {
			const ids = selection(ctx)
				.clips.filter((c) => readEssentialSound(c.essential))
				.map((c) => c.id);
			if (!ctx.session || !ids.length) return;
			const r = ctx.session.apply({
				label: 'Clear Audio Type',
				origin: 'user',
				commands: [{ type: 'essentialSound.clearType', clipIds: ids }] as never,
			});
			if (!r.ok)
				ctx.ui.toast({ kind: 'error', message: r.errors?.[0]?.message ?? 'Clear Audio Type failed' });
		},
	},
];

// Timeline clip context menu (remixed audio clips): Revert Remix.
clipMenuExtensions.register({
	id: 'audio-fx',
	order: 41,
	items: ({ session, clip }) =>
		clip.kind === 'audio' && (clip as AudioClip).remix
			? [
					{
						kind: 'item',
						label: 'Revert Remix',
						disabled: session.getState().readOnly,
						run: () => void revertRemix(session, clip.id),
					},
				]
			: [],
});
