// audio-fx UI commands: Window ▸ Essential Sound, Clip ▸ Audio Options ▸ Remix… / Revert Remix / Auto-Match
// Loudness / Clear Audio Type. Remix… opens Essential Sound ▸
// Duration (Premiere's flow); agents pass {targetSeconds} to remix directly. Remixed clips get Revert Remix in their
// context menu.
import {
	AUDIO_TYPE_LABELS,
	AUDIO_TYPES,
	type AudioClip,
	type AudioType,
	formatTimecode,
	readEssentialSound,
	type Sequence,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { z } from 'zod';
import type { CommandCtx, UiCommand } from '../commands/types.ts';
import { clipMenuExtensions } from '../extensions/index.ts';
import { t } from '../i18n/runtime.ts';
import {
	autoMatchLoudness,
	autoMatchMessage,
	autoTagClips,
	autoTagMessage,
	endOnBar,
	heroCueUnder,
	landDrop,
	remixClip,
	selectAudioType,
	selectedAudioClips,
	singleMusicClip,
} from './ops.ts';

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

const AutoTagArgs = z
	.strictObject({
		/** Clips to tag (default: the selected audio clips). */
		clipIds: z.array(z.string().min(1)).min(1).max(500).optional(),
		/** Also replace audio types you set (default false). */
		force: z.boolean().optional(),
	})
	.optional();

/** The audio clips Auto Tag works on: `clipIds` (audio clips of the active sequence) or the selection. */
function autoTagTargets(ctx: CommandCtx, raw: unknown): { seq: Sequence | null; ids: string[] } {
	const args = AutoTagArgs.safeParse(raw);
	const { seq, clips } = selection(ctx);
	if (args.success && args.data?.clipIds && ctx.session) {
		const s = ctx.session.getState();
		const active = s.activeSequenceId
			? (s.document.sequences[s.activeSequenceId] as Sequence | undefined)
			: undefined;
		return {
			seq: active ?? null,
			ids: args.data.clipIds.filter((id) => active?.clips[id]?.kind === 'audio'),
		};
	}
	return { seq, ids: clips.map((c) => c.id) };
}

const SelectTypeArgs = z
	.strictObject({
		/** The audio type (default: the type of the selected clips, when they share one). */
		type: z.enum(AUDIO_TYPES).optional(),
	})
	.optional();

/** The type Select All Clips of Audio Type selects: the argument, else the one type of the selected clips. */
function selectTypeTarget(ctx: CommandCtx, raw: unknown): AudioType | null {
	const args = SelectTypeArgs.safeParse(raw);
	if (args.success && args.data?.type) return args.data.type;
	const types = new Set(selection(ctx).clips.map((c) => readEssentialSound(c.essential)?.type ?? null));
	const [only] = types;
	return types.size === 1 && only ? only : null;
}

const RemixArgs = z
	.strictObject({
		targetSeconds: z.number().positive(),
		segments: z.number().min(0).max(100).optional(),
		variations: z.number().min(0).max(100).optional(),
	})
	.optional();

const LandDropArgs = z
	.strictObject({
		/** Sequence frame to land the drop on (default: the playhead, or the hero cue for Land Drop on Hero Cue). */
		frame: z.number().int().min(0).optional(),
		/** The moment to land (media seconds; default the top drop candidate). */
		dropSec: z.number().min(0).max(864_000).optional(),
	})
	.optional();

const EndOnBarArgs = z
	.strictObject({
		direction: z.enum(['earlier', 'nearest']).optional(),
		fadeSeconds: z.number().positive().max(10).optional(),
	})
	.optional();

/** The one music clip selected (a clip, or the pieces of one remix). */
const theMusicClip = (ctx: CommandCtx) => singleMusicClip(selection(ctx).clips);
const oneMusicClip = (ctx: CommandCtx) => editable(ctx) && !!theMusicClip(ctx);

async function runLandDrop(ctx: CommandCtx, raw: unknown, on: 'playhead' | 'hero'): Promise<void> {
	const args = LandDropArgs.parse(raw);
	const { seq } = selection(ctx);
	const clip = theMusicClip(ctx);
	if (!ctx.session || !seq || !clip) return;
	let frame = args?.frame;
	if (frame === undefined && on === 'hero') {
		const hero = heroCueUnder(seq, clip);
		if (!hero) {
			ctx.ui.toast({
				kind: 'error',
				message: t('No hero cue under the music'),
				detail: t('Add a hero cue, or land the drop on the playhead.'),
			});
			return;
		}
		frame = hero.frame;
	}
	frame ??= ctx.transport.getState().frame;
	try {
		const r = await landDrop(ctx.session, ctx.engine, seq.id, clip.id, frame, {
			...(args?.dropSec !== undefined ? { dropSec: args.dropSec } : {}),
		});
		ctx.ui.toast({
			kind: 'success',
			message: t(
				'The drop lands at {0} ({1} segments, {2} s)',
				formatTimecode(frame, seq.settings.frameRate, { dropFrame: seq.settings.dropFrame }),
				r.pieces,
				r.lengthSeconds.toFixed(2),
			),
		});
	} catch (e) {
		ctx.ui.toast({ kind: 'error', message: t('Land the Drop failed'), detail: (e as Error).message });
	}
}

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
		when: oneMusicClip,
		disabledReason: (ctx) => (theMusicClip(ctx) ? undefined : 'Select one music clip'),
		run: async (ctx, raw) => {
			const args = RemixArgs.parse(raw);
			const { seq } = selection(ctx);
			const clip = theMusicClip(ctx);
			if (!ctx.session || !seq || !clip) return;
			if (!args) return openPanel(ctx);
			try {
				const r = await remixClip(ctx.session, ctx.engine, seq.id, clip.id, args.targetSeconds, args);
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
		id: 'audio.landDropOnPlayhead',
		label: 'Land Drop on Playhead',
		description:
			'Re-cut the selected music clip at bar lines so its drop plays exactly at the playhead (or `frame`; `dropSec` picks the moment in media seconds)',
		scope: 'global',
		agentExposed: true,
		capability: 'engine',
		argsSchema: LandDropArgs,
		when: oneMusicClip,
		disabledReason: (ctx) => (theMusicClip(ctx) ? undefined : 'Select one music clip'),
		run: (ctx, raw) => runLandDrop(ctx, raw, 'playhead'),
	},
	{
		id: 'audio.landDropOnHero',
		label: 'Land Drop on Hero Cue',
		description:
			'Re-cut the selected music clip at bar lines so its drop plays exactly on the first hero cue under it',
		scope: 'global',
		agentExposed: true,
		capability: 'engine',
		argsSchema: LandDropArgs,
		when: (ctx) => oneMusicClip(ctx) && !!heroCueUnder(selection(ctx).seq!, theMusicClip(ctx)!),
		disabledReason: (ctx) =>
			!theMusicClip(ctx)
				? 'Select one music clip'
				: heroCueUnder(selection(ctx).seq!, theMusicClip(ctx)!)
					? undefined
					: 'No hero cue under the music',
		run: (ctx, raw) => runLandDrop(ctx, raw, 'hero'),
	},
	{
		id: 'audio.endOnBar',
		label: 'End on Bar',
		description:
			'End the selected music clip on a bar line: just before a downbeat, with a one-beat fade-out (`direction` nearest also looks up to half a bar later)',
		scope: 'global',
		agentExposed: true,
		capability: 'engine',
		argsSchema: EndOnBarArgs,
		when: oneMusicClip,
		disabledReason: (ctx) => (theMusicClip(ctx) ? undefined : 'Select one music clip'),
		run: async (ctx, raw) => {
			const args = EndOnBarArgs.parse(raw);
			const { seq } = selection(ctx);
			const clip = theMusicClip(ctx);
			if (!ctx.session || !seq || !clip) return;
			try {
				const r = await endOnBar(ctx.session, ctx.engine, seq.id, clip.id, args ?? {});
				ctx.ui.toast({
					kind: 'success',
					message: t(
						'The music ends on the bar line at {0}',
						formatTimecode(r.endFrame, seq.settings.frameRate, { dropFrame: seq.settings.dropFrame }),
					),
				});
			} catch (e) {
				ctx.ui.toast({ kind: 'error', message: t('End on Bar failed'), detail: (e as Error).message });
			}
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
		id: 'audio.autoTag',
		label: 'Auto Tag Audio Types',
		description:
			'Listen to the selected audio clips and give each an audio type (Dialogue, Music, SFX or Ambience), marked auto until you confirm it in Essential Sound; types you set are kept',
		scope: 'global',
		agentExposed: true,
		capability: 'engine',
		argsSchema: AutoTagArgs,
		when: (ctx) => editable(ctx) && selection(ctx).clips.length > 0,
		disabledReason: (ctx) => (selection(ctx).clips.length > 0 ? undefined : 'Select audio clips'),
		run: async (ctx, raw) => {
			const { seq, ids } = autoTagTargets(ctx, raw);
			if (!ctx.session || !seq || !ids.length) return;
			const force = AutoTagArgs.safeParse(raw).data?.force === true;
			try {
				const out = await autoTagClips(ctx.session, ctx.engine, seq.id, ids, { force });
				const message = autoTagMessage(out);
				ctx.ui.toast(
					out.tagged.length
						? { kind: out.low.length ? 'info' : 'success', message }
						: { kind: 'error', message: 'Auto Tag', detail: message },
				);
			} catch (e) {
				ctx.ui.toast({ kind: 'error', message: 'Auto Tag failed', detail: (e as Error).message });
			}
		},
	},
	{
		id: 'audio.selectAudioType',
		label: 'Select All Clips of Audio Type',
		labelFor: (ctx) => {
			const type = selectTypeTarget(ctx, undefined);
			return type
				? t('Select All {0} Clips', t(AUDIO_TYPE_LABELS[type]))
				: t('Select All Clips of Audio Type');
		},
		description:
			'Select every audio clip of an Essential Sound type (Dialogue, Music, SFX or Ambience) in the active sequence; without a type, the type of the selected clips',
		scope: 'global',
		agentExposed: true,
		argsSchema: SelectTypeArgs,
		when: (ctx) => !!ctx.session?.getState().activeSequenceId,
		disabledReason: () => 'Open a sequence',
		run: (ctx, raw) => {
			const type = selectTypeTarget(ctx, raw);
			if (!ctx.session) return;
			if (!type) {
				ctx.ui.toast({
					kind: 'info',
					message: t('Select clips of one audio type, or pick a type in Essential Sound'),
				});
				return;
			}
			const n = selectAudioType(ctx.session, type);
			if (!n)
				ctx.ui.toast({
					kind: 'info',
					message: t('No {0} clips in this sequence', t(AUDIO_TYPE_LABELS[type])),
				});
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

// Timeline clip context menu (audio clips): Auto Tag Audio Types (the selection, with this clip), Select All <Type> Clips
// for a clip with a type; remixed audio clips get Revert Remix.
clipMenuExtensions.register({
	id: 'audio-fx',
	order: 41,
	items: ({ session, clip, runCommand: run }) => {
		if (clip.kind !== 'audio') return [];
		const s = session.getState();
		const seq = s.activeSequenceId
			? (s.document.sequences[s.activeSequenceId] as Sequence | undefined)
			: undefined;
		const picked = s.selection.timeline.clips.filter((id) => seq?.clips[id]?.kind === 'audio');
		const clipIds = picked.includes(clip.id) ? picked : [clip.id];
		const clipType = readEssentialSound((clip as AudioClip).essential)?.type ?? null;
		return [
			...(run
				? [
						{
							kind: 'item' as const,
							label: 'Auto Tag Audio Types',
							disabled: s.readOnly,
							run: () => run('audio.autoTag', { clipIds }),
						},
					]
				: []),
			...(run && clipType
				? [
						{
							kind: 'item' as const,
							label: t('Select All {0} Clips', t(AUDIO_TYPE_LABELS[clipType])),
							run: () => run('audio.selectAudioType', { type: clipType }),
						},
					]
				: []),
			...((clip as AudioClip).remix
				? [
						{
							kind: 'item' as const,
							label: 'Revert Remix',
							disabled: s.readOnly,
							run: () => void revertRemix(session, clip.id),
						},
					]
				: []),
			// P6-E11: music to picture on a music clip (the selection is this clip alone)
			...(run && clipType === 'music' && clipIds.length === 1
				? [
						{
							kind: 'item' as const,
							label: 'Land Drop on Playhead',
							disabled: s.readOnly,
							run: () => run('audio.landDropOnPlayhead'),
						},
						{
							kind: 'item' as const,
							label: 'End on Bar',
							disabled: s.readOnly,
							run: () => run('audio.endOnBar'),
						},
					]
				: []),
		];
	},
});
