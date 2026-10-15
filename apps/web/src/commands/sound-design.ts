// Sound design clip and cue commands (spec 12 §2.7, P2-R7, WP2.4b): Swap Sound… (Alt+Shift+S, Replace mode), Next /
// Previous Variation (Ctrl+Alt+. / Ctrl+Alt+,), Align Peak to Playhead (Ctrl+Alt+P), Align Peak to Nearest Cue, Set
// Peak at Playhead, Find Similar Sounds, Reveal in Sound Library, Add to Palette, Role ▸, Show Licence…, Add Layer…,
// Link / Unlink Layers; for project audio Detect Peak and Add to Sound Library…; Sequence ▸ Sound Design ▸ Fill
// Unfilled Cues; the Sound Library's In Context audition (Shift+Space), its toggle and Esc (leave Fill / Replace).
// Every document edit is an ordinary command (`soundDesign.*`, `clip.move`, `clip.link`…) in one undo step; agents
// reach every entry through the UI command catalogue (`clipId` / `cueId` arguments where they need a target).
import { SoundIdSchema } from '@jasper/api';
import {
	type AudioClip,
	type Clip,
	type Command,
	type Rational,
	SFX_ROLES,
	type SfxRole,
} from '@jasper/project';
import { z } from 'zod';
import { t } from '../i18n/runtime.ts';
import {
	ADD_TO_LIBRARY_DIALOG,
	folderOf,
	mediaFilePath,
	registerAddToLibraryDialog,
} from '../sound/AddToLibraryDialog.tsx';
import { auditionPlayer } from '../sound/audition.ts';
import {
	cancelLibraryMode,
	clipSoundTarget,
	cueFillTarget,
	requestClipTarget,
	requestCueFill,
	soundLibraryController,
	withSoundLibrary,
} from '../sound/controller.ts';
import { contentFlicksAt, cuesOf } from '../sound/cues/model.ts';
import {
	alignedFrameOf,
	clipProvenance,
	clipSoundId,
	clipSoundLabel,
	clipSoundTitle,
	cueLabel,
	cueOfClip,
	isLibraryClip,
	paletteOf,
	sfxOf,
} from '../sound/design-model.ts';
import { detectClipPeak } from '../sound/detect-peak.ts';
import { SOUND_LICENSE_DIALOG } from '../sound/dialogs.tsx';
import { cueCandidates, fillCueWithSound, fillUnfilledCues, linkLayersCommands } from '../sound/fill.ts';
import { inContextActive, inContextEndedBy, stopInContext } from '../sound/in-context.ts';
import { soundLibraryPrefs } from '../sound/prefs.ts';
import { registerSoundDesignUi } from '../sound/register.tsx';
import { cycleVariation, swappableClips } from '../sound/swap.ts';
import { ReportedCommandError, runCommand } from './registry.ts';
import {
	applySequenceCommands,
	type ResolvedSequenceCommandContext,
	sequenceContext,
} from './sequence-context.ts';
import type { CommandCtx, CommandScope, UiCommand } from './types.ts';

registerAddToLibraryDialog();
registerSoundDesignUi();

const E: CommandScope = 'editing';
const G: CommandScope = 'global';
const S: CommandScope = 'soundLibrary';

const ClipArgs = z
	.object({ clipId: z.string().min(1).max(128).optional() })
	.strict()
	.optional();
type ClipArgsT = z.infer<typeof ClipArgs>;

/** The clips a command acts on: `clipId`, else the selected clips (audio only). */
function targetClips(e: ResolvedSequenceCommandContext, args: unknown): AudioClip[] {
	const a = args as ClipArgsT;
	const ids = a?.clipId ? [a.clipId] : e.session.getState().selection.timeline.clips;
	return ids.map((id) => e.seq.clips[id]).filter((c): c is AudioClip => !!c && c.kind === 'audio');
}

/** The one clip a command acts on (the argument, else the primary selected audio clip). */
function targetClip(e: ResolvedSequenceCommandContext, args: unknown): AudioClip | null {
	const a = args as ClipArgsT;
	if (a?.clipId) {
		const c = e.seq.clips[a.clipId];
		return c?.kind === 'audio' ? (c as AudioClip) : null;
	}
	const sel = e.session.getState().selection.timeline;
	const primary = sel.primaryClip ? e.seq.clips[sel.primaryClip] : undefined;
	if (primary?.kind === 'audio') return primary as AudioClip;
	return targetClips(e, args)[0] ?? null;
}

const writable = (ctx: CommandCtx) => {
	const e = sequenceContext(ctx);
	return !!e && !e.session.getState().readOnly;
};
const libraryClip = (e: ResolvedSequenceCommandContext, c: Clip | null) => !!c && isLibraryClip(e.doc, c);
/** Clips with an aligned point (library sounds and clips with a detected / set peak). */
const peakClip = (e: ResolvedSequenceCommandContext, c: Clip | null) =>
	!!c && c.kind === 'audio' && alignedFrameOf(e.doc, e.seq, c) !== null;

const SELECT_SFX = () => t('Select a sound effect clip');

function toastError(ctx: CommandCtx, message: string, e: unknown): void {
	ctx.ui.toast({ kind: 'warning', message, detail: e instanceof Error ? e.message : String(e) });
}

/** Clips that move with `clip` (its group and, with linked selection, its links). */
function movingWith(e: ResolvedSequenceCommandContext, clip: Clip): string[] {
	const ids = new Set<string>([clip.id]);
	if (clip.groupId) for (const m of e.seq.groups?.[clip.groupId]?.members ?? []) ids.add(m);
	if (clip.linkId && e.session.getState().toggles.linkedSelection)
		for (const m of e.seq.links?.[clip.linkId]?.members ?? []) ids.add(m);
	return [...ids].filter((id) => e.seq.clips[id]);
}

/** Moves a clip (and what moves with it) so its aligned point lands on `frame`. */
function alignPeakTo(
	ctx: CommandCtx,
	e: ResolvedSequenceCommandContext,
	clip: Clip,
	frame: number,
	label: string,
) {
	const at = alignedFrameOf(e.doc, e.seq, clip);
	if (at === null) return;
	const ids = movingWith(e, clip);
	let delta = Math.round(frame) - Math.floor(at);
	const minStart = Math.min(...ids.map((id) => e.seq.clips[id]!.start));
	if (minStart + delta < 0) delta = -minStart;
	if (!delta) return;
	applySequenceCommands(ctx, e, label, [
		{ type: 'clip.move', clipIds: ids, deltaFrames: delta, mode: 'overwrite' },
	]);
}

const ROLE_LABELS: Record<SfxRole, string> = { hero: 'Hero', support: 'Support', layer: 'Layer' };

function roleCommand(role: SfxRole): UiCommand {
	return {
		id: `sound.setRole.${role}`,
		label: ROLE_LABELS[role],
		description: `Set the sound-design role of the selected sound effect clips to ${role}`,
		scope: E,
		agentExposed: true,
		argsSchema: ClipArgs,
		when: (ctx) => {
			const e = sequenceContext(ctx);
			return (
				!!e &&
				!e.session.getState().readOnly &&
				targetClips(e, undefined).some((c) => libraryClip(e, c) || !!sfxOf(c))
			);
		},
		disabledReason: SELECT_SFX,
		checked: (ctx) => {
			const e = sequenceContext(ctx);
			const clips = e ? targetClips(e, undefined).filter((c) => !!sfxOf(c)) : [];
			return clips.length > 0 && clips.every((c) => sfxOf(c)?.role === role);
		},
		run: (ctx, args) => {
			const e = sequenceContext(ctx);
			if (!e) return;
			const ids = targetClips(e, args)
				.filter((c) => libraryClip(e, c) || !!sfxOf(c))
				.map((c) => c.id);
			if (!ids.length) return;
			applySequenceCommands(ctx, e, t('Sound Role'), [
				{ type: 'soundDesign.setRole', clipIds: ids, role } as Command,
			]);
		},
	};
}

const FillCueArgs = z
	.object({
		cueId: z.string().min(1).max(128).optional(),
		soundId: SoundIdSchema,
		/** Add the sound as one more layer of a filled cue (linked to the others). */
		layer: z.boolean().optional(),
	})
	.strict();

const AuditionArgs = z.object({ soundId: SoundIdSchema.optional() }).strict().optional();

export const soundDesignCommands: UiCommand[] = [
	// ---------------------------------------------------------------- Sound Library
	{
		id: 'soundLibrary.auditionInContext',
		label: 'Audition in Context',
		description:
			'Play the timeline with the selected library sound mixed in, its peak on the selected cue (else the clip being replaced, else the playhead); 2 s pre-roll to 1 s after; never changes the project',
		scope: S,
		agentExposed: true,
		argsSchema: AuditionArgs,
		when: (ctx) => !!ctx.session?.getState().activeSequenceId,
		disabledReason: () => t('Open a sequence first'),
		run: async (ctx, args) => {
			const a = args as z.infer<typeof AuditionArgs>;
			// a toggle: the press that stops it (in the Library's list the audition's own key listener has already
			// stopped it when this runs) does not start it again
			if (inContextActive() || inContextEndedBy(['Space'])) {
				stopInContext();
				return;
			}
			if (a?.soundId) {
				const session = ctx.session;
				if (!session) return;
				const entry = await ctx.engine.getSound(a.soundId);
				const { auditionInContext } = await import('../sound/in-context.ts');
				const r = await auditionInContext(session, ctx.engine, entry);
				// superseded by another audition or stopped while it registered: not a failure
				if (!r.ok && !r.cancelled) throw new Error(r.message);
				return;
			}
			soundLibraryController()?.auditionInContext?.();
		},
	},
	{
		id: 'soundLibrary.toggleInContext',
		label: 'Audition in Context by Default',
		description:
			'Space, Auto-play and hover audition play the sound in the timeline (In Context) instead of alone',
		scope: S,
		checked: () => soundLibraryPrefs.get().inContext,
		run: () => soundLibraryPrefs.set({ inContext: !soundLibraryPrefs.get().inContext }),
	},
	{
		id: 'soundLibrary.toggleAuditionOnSwap',
		label: 'Audition on Swap',
		description: 'After a swap or a variation step, play the 2 s around the sound in the timeline',
		scope: G,
		checked: () => soundLibraryPrefs.get().auditionOnSwap,
		run: () => soundLibraryPrefs.set({ auditionOnSwap: !soundLibraryPrefs.get().auditionOnSwap }),
	},
	{
		id: 'soundLibrary.cancelMode',
		label: 'Leave Fill / Replace Mode',
		scope: S,
		when: () => !!cueFillTarget() || !!clipSoundTarget() || inContextActive(),
		run: () => {
			// Esc stops what plays first (the plain audition, the In Context one), then leaves the mode
			if (auditionPlayer().state.phase !== 'idle') auditionPlayer().stop();
			else if (inContextActive()) stopInContext();
			// this Esc has already stopped the In Context audition (its key listener runs first): the mode stays
			else if (!inContextEndedBy(['Escape'])) cancelLibraryMode();
		},
	},
	// ---------------------------------------------------------------- cues
	{
		id: 'sound.fillCue',
		label: 'Fill Sound Cue',
		description:
			'Fill a sound cue (`cueId`, default the selected cue) with a library sound (`soundId`): placed peak-aligned per the cue (role, align, pan), with the next ranked sounds stored as alternatives; `layer: true` adds it as one more layer, linked. One undo step',
		scope: G,
		capability: 'engine',
		agentExposed: true,
		argsSchema: FillCueArgs,
		when: writable,
		run: async (ctx, args) => {
			const a = args as z.infer<typeof FillCueArgs>;
			const e = sequenceContext(ctx);
			if (!e) return;
			const cueId = a.cueId ?? e.session.getState().selection.cues?.at(-1);
			const cue = cueId ? cuesOf(e.seq).find((c) => c.id === cueId) : undefined;
			if (!cue) throw new Error(t('No sound cue {0} in this sequence', cueId ?? ''));
			const entry = await ctx.engine.getSound(a.soundId);
			const ranked = a.layer ? [] : await cueCandidates(ctx.engine, e.session, e.seq, cue, 4).catch(() => []);
			try {
				const r = await fillCueWithSound(e.session, ctx.engine, entry, {
					sequenceId: e.seq.id,
					cueId: cue.id,
					layer: !!a.layer,
					alternatives: ranked.map((x) => x.id),
				});
				ctx.ui.toast({
					kind: 'success',
					message: r.message,
					action: { label: t('Undo'), command: 'history.undo' },
				});
			} catch (err) {
				toastError(ctx, t('Could not fill the cue'), err);
				throw new ReportedCommandError(err);
			}
		},
	},
	{
		id: 'sound.addCueLayer',
		label: 'Add Layer…',
		description: 'Open the Sound Library to add one more layer to the selected cue (or `cueId`)',
		scope: G,
		argsSchema: z
			.object({ cueId: z.string().min(1).max(128).optional() })
			.strict()
			.optional(),
		when: (ctx) => {
			const e = sequenceContext(ctx);
			return !!e && !e.session.getState().readOnly && !!e.session.getState().selection.cues?.length;
		},
		run: async (ctx, args) => {
			const e = sequenceContext(ctx);
			const id =
				(args as { cueId?: string } | undefined)?.cueId ?? e?.session.getState().selection.cues?.at(-1);
			const cue = e && id ? cuesOf(e.seq).find((c) => c.id === id) : undefined;
			if (!e || !cue) return;
			requestCueFill({
				sequenceId: e.seq.id,
				cueId: cue.id,
				types: cue.types ?? [],
				label: cueLabel(e.seq, cue),
				layer: true,
			});
			await runCommand('panel.focus.soundLibrary', ctx);
		},
	},
	{
		id: 'sound.fillUnfilledCues',
		label: 'Fill Unfilled Cues',
		description:
			'Fill every unfilled, unmuted sound cue of the active sequence with a ranked library sound (round-robin over the best 4, seeded variation): one undo step',
		scope: G,
		capability: 'engine',
		agentExposed: true,
		when: (ctx) => {
			const e = sequenceContext(ctx);
			return (
				!!e &&
				!e.session.getState().readOnly &&
				cuesOf(e.seq).some((c) => !c.muted && !(c.placedClipIds ?? []).some((id) => e.seq.clips[id]))
			);
		},
		disabledReason: () => t('Every cue is filled (or there are none)'),
		run: async (ctx) => {
			const e = sequenceContext(ctx);
			if (!e) return;
			try {
				const r = await fillUnfilledCues(e.session, ctx.engine, e.seq.id);
				ctx.ui.toast({
					kind: r.filled.length ? 'success' : 'warning',
					message: r.filled.length ? t('Filled {0} cues', r.filled.length) : t('No cue could be filled'),
					...(r.skipped.length
						? { detail: t('{0} skipped: {1}', r.skipped.length, r.skipped[0]!.reason) }
						: {}),
					...(r.filled.length ? { action: { label: t('Undo'), command: 'history.undo' } } : {}),
				});
			} catch (err) {
				toastError(ctx, t('Could not fill the cues'), err);
				throw new ReportedCommandError(err);
			}
		},
	},
	// ---------------------------------------------------------------- clips
	{
		id: 'sound.swap',
		label: 'Swap Sound…',
		description:
			'Choose another library sound for the selected sound effect clip in the Sound Library (Replace mode): Enter swaps it, keeping its peak frame, role, pan, gain, group and cue',
		scope: E,
		agentExposed: true,
		argsSchema: ClipArgs,
		when: (ctx) => {
			const e = sequenceContext(ctx);
			return !!e && !e.session.getState().readOnly && peakClip(e, targetClip(e, undefined));
		},
		disabledReason: SELECT_SFX,
		run: async (ctx, args) => {
			const e = sequenceContext(ctx);
			const clip = e ? targetClip(e, args) : null;
			if (!e || !clip || !peakClip(e, clip)) return;
			requestClipTarget({
				kind: 'replace',
				sequenceId: e.seq.id,
				clipId: clip.id,
				soundId: clipSoundId(e.doc, clip),
				title: clipSoundTitle(e.doc, clip),
				label: clipSoundLabel(e.doc, e.seq, clip),
			});
			await runCommand('panel.focus.soundLibrary', ctx);
		},
	},
	...([1, -1] as const).map(
		(dir): UiCommand => ({
			id: dir > 0 ? 'sound.nextVariation' : 'sound.prevVariation',
			label: dir > 0 ? 'Next Variation' : 'Previous Variation',
			description:
				'Swap the selected sound effect clips to their next / previous variation (alternatives, then the same family, then the nearest sounds); repeated presses make one undo step',
			scope: E,
			capability: 'engine',
			agentExposed: true,
			repeat: true,
			when: (ctx) => {
				const e = sequenceContext(ctx);
				return (
					!!e &&
					!e.session.getState().readOnly &&
					swappableClips(e.session, e.seq, e.session.getState().selection.timeline.clips).length > 0
				);
			},
			disabledReason: SELECT_SFX,
			run: async (ctx) => {
				const session = ctx.session;
				if (!session) return;
				let failure: string | null = null;
				await cycleVariation(session, ctx.engine, dir, (r) => {
					if (r.ok) ctx.ui.toast({ kind: 'info', message: r.message, durationMs: 1500 });
					else {
						failure = r.message;
						ctx.ui.toast({ kind: 'warning', message: t('No variation'), detail: r.message });
					}
				});
				// reported above (one toast per failed step); agents still get the failure
				if (failure) throw new ReportedCommandError(failure);
			},
		}),
	),
	{
		id: 'sound.alignPeakToPlayhead',
		label: 'Align Peak to Playhead',
		description:
			'Move the selected sound effect clip (and the clips grouped or linked with it) so its peak is on the playhead',
		scope: E,
		agentExposed: true,
		argsSchema: ClipArgs,
		when: (ctx) => {
			const e = sequenceContext(ctx);
			return !!e && !e.session.getState().readOnly && peakClip(e, targetClip(e, undefined));
		},
		disabledReason: SELECT_SFX,
		run: (ctx, args) => {
			const e = sequenceContext(ctx);
			const clip = e ? targetClip(e, args) : null;
			if (e && clip) alignPeakTo(ctx, e, clip, e.playhead, t('Align Peak to Playhead'));
		},
	},
	{
		id: 'sound.alignPeakToNearestCue',
		label: 'Align Peak to Nearest Cue',
		description: 'Move the selected sound effect clip so its peak is on the nearest sound cue',
		scope: E,
		agentExposed: true,
		argsSchema: ClipArgs,
		when: (ctx) => {
			const e = sequenceContext(ctx);
			return (
				!!e &&
				!e.session.getState().readOnly &&
				cuesOf(e.seq).length > 0 &&
				peakClip(e, targetClip(e, undefined))
			);
		},
		disabledReason: () => t('Select a sound effect clip in a sequence with sound cues'),
		run: (ctx, args) => {
			const e = sequenceContext(ctx);
			const clip = e ? targetClip(e, args) : null;
			if (!e || !clip) return;
			const at = alignedFrameOf(e.doc, e.seq, clip);
			if (at === null) return;
			const own = cueOfClip(e.seq, clip);
			const cues = cuesOf(e.seq);
			const nearest =
				own ?? cues.reduce((b, c) => (Math.abs(c.frame - at) < Math.abs(b.frame - at) ? c : b), cues[0]!);
			alignPeakTo(ctx, e, clip, nearest.frame, t('Align Peak to Nearest Cue'));
		},
	},
	{
		id: 'sound.setPeakAtPlayhead',
		label: 'Set Peak at Playhead',
		description: 'Make the sound at the playhead the peak of the selected clip (the clip does not move)',
		scope: E,
		agentExposed: true,
		argsSchema: ClipArgs,
		when: (ctx) => {
			const e = sequenceContext(ctx);
			const c = e ? targetClip(e, undefined) : null;
			return (
				!!e &&
				!!c &&
				!e.session.getState().readOnly &&
				e.playhead >= c.start &&
				e.playhead < c.start + c.duration
			);
		},
		disabledReason: () => t('Put the playhead over the selected audio clip'),
		run: (ctx, args) => {
			const e = sequenceContext(ctx);
			const clip = e ? targetClip(e, args) : null;
			if (!e || !clip) return;
			const flicks = contentFlicksAt(clip as never, e.playhead, e.seq.settings.frameRate as Rational);
			applySequenceCommands(ctx, e, t('Set Peak'), [
				{ type: 'soundDesign.setPeak', clipId: clip.id, peakFlicks: flicks } as Command,
			]);
		},
	},
	{
		id: 'sound.findSimilar',
		label: 'Find Similar Sounds',
		description: 'Open the Sound Library ranked by similarity to the selected clip’s sound',
		scope: E,
		agentExposed: true,
		argsSchema: ClipArgs,
		when: (ctx) => {
			const e = sequenceContext(ctx);
			return !!e && libraryClip(e, targetClip(e, undefined));
		},
		disabledReason: SELECT_SFX,
		run: async (ctx, args) => {
			const e = sequenceContext(ctx);
			const clip = e ? targetClip(e, args) : null;
			const id = e && clip ? clipSoundId(e.doc, clip) : null;
			if (!e || !clip || !id) return;
			const sound = { id, title: clipSoundTitle(e.doc, clip) };
			withSoundLibrary((c) => c.setSimilar?.(sound));
			await runCommand('panel.focus.soundLibrary', ctx);
		},
	},
	{
		id: 'sound.revealInLibrary',
		label: 'Reveal in Sound Library',
		description: 'Show the selected clip’s sound in the Sound Library',
		scope: E,
		agentExposed: true,
		argsSchema: ClipArgs,
		when: (ctx) => {
			const e = sequenceContext(ctx);
			return !!e && libraryClip(e, targetClip(e, undefined));
		},
		disabledReason: SELECT_SFX,
		run: async (ctx, args) => {
			const e = sequenceContext(ctx);
			const clip = e ? targetClip(e, args) : null;
			const id = e && clip ? clipSoundId(e.doc, clip) : null;
			if (!e || !clip || !id) return;
			const sound = { id, title: clipSoundTitle(e.doc, clip) };
			withSoundLibrary((c) => c.reveal?.(sound));
			await runCommand('panel.focus.soundLibrary', ctx);
		},
	},
	{
		id: 'sound.addToPalette',
		label: 'Add to Palette',
		description: 'Add the selected clips’ library sounds to the sequence’s sound palette (preferred sounds)',
		scope: E,
		agentExposed: true,
		argsSchema: ClipArgs,
		when: (ctx) => {
			const e = sequenceContext(ctx);
			return (
				!!e && !e.session.getState().readOnly && targetClips(e, undefined).some((c) => libraryClip(e, c))
			);
		},
		disabledReason: SELECT_SFX,
		checked: (ctx) => {
			const e = sequenceContext(ctx);
			if (!e) return false;
			const ids = targetClips(e, undefined)
				.map((c) => clipSoundId(e.doc, c))
				.filter((x): x is string => !!x);
			const pal = paletteOf(e.seq);
			return ids.length > 0 && ids.every((id) => pal.includes(id));
		},
		run: (ctx, args) => {
			const e = sequenceContext(ctx);
			if (!e) return;
			const ids = [
				...new Set(
					targetClips(e, args)
						.map((c) => clipSoundId(e.doc, c))
						.filter((x): x is string => !!x),
				),
			];
			if (!ids.length) return;
			const pal = paletteOf(e.seq);
			const remove = ids.every((id) => pal.includes(id));
			applySequenceCommands(ctx, e, remove ? t('Remove from Palette') : t('Add to Palette'), [
				{
					type: 'soundDesign.setPalette',
					sequenceId: e.seq.id,
					soundIds: ids,
					mode: remove ? 'remove' : 'add',
				} as Command,
			]);
		},
	},
	...SFX_ROLES.map(roleCommand),
	{
		id: 'sound.showLicense',
		label: 'Show Licence…',
		description: 'Show the licence, author, source and credit line of the selected clip’s library sound',
		scope: E,
		argsSchema: ClipArgs,
		when: (ctx) => {
			const e = sequenceContext(ctx);
			return !!e && libraryClip(e, targetClip(e, undefined));
		},
		disabledReason: SELECT_SFX,
		run: async (ctx, args) => {
			const e = sequenceContext(ctx);
			const clip = e ? targetClip(e, args) : null;
			const prov = e && clip ? clipProvenance(e.doc, clip) : null;
			if (!prov) return;
			// The library's entry when the engine still has it; else the provenance stored in the project.
			const entry = await ctx.engine.getSound(prov.soundId).catch(() => ({
				id: prov.soundId,
				title: prov.title,
				license: prov.license,
				licenseUrl: prov.licenseUrl,
				author: prov.author,
				sourceUrl: prov.sourceUrl,
				attribution: prov.attribution,
				source: prov.source,
			}));
			ctx.ui.openDialog(SOUND_LICENSE_DIALOG, { entry, rootLabel: null });
		},
	},
	{
		id: 'sound.addLayer',
		label: 'Add Layer…',
		description:
			'Open the Sound Library to add a layer to the selected sound effect clip: aligned to the same peak on the next free SFX track, linked',
		scope: E,
		argsSchema: ClipArgs,
		when: (ctx) => {
			const e = sequenceContext(ctx);
			return !!e && !e.session.getState().readOnly && peakClip(e, targetClip(e, undefined));
		},
		disabledReason: SELECT_SFX,
		run: async (ctx, args) => {
			const e = sequenceContext(ctx);
			const clip = e ? targetClip(e, args) : null;
			if (!e || !clip) return;
			const cue = cueOfClip(e.seq, clip);
			if (cue)
				requestCueFill({
					sequenceId: e.seq.id,
					cueId: cue.id,
					types: cue.types ?? [],
					label: cueLabel(e.seq, cue),
					layer: true,
				});
			else
				requestClipTarget({
					kind: 'layer',
					sequenceId: e.seq.id,
					clipId: clip.id,
					soundId: clipSoundId(e.doc, clip),
					title: clipSoundTitle(e.doc, clip),
					label: clipSoundLabel(e.doc, e.seq, clip),
				});
			await runCommand('panel.focus.soundLibrary', ctx);
		},
	},
	{
		id: 'sound.toggleLinkLayers',
		label: 'Link Layers',
		labelFor: (ctx) => {
			const e = sequenceContext(ctx);
			const clip = e ? targetClip(e, undefined) : null;
			const p = e && clip ? linkLayersCommands(e.seq, clip) : null;
			return p && !p.link ? t('Unlink Layers') : t('Link Layers');
		},
		description: 'Link the layers of the selected sound (they move together) or unlink them',
		scope: E,
		agentExposed: true,
		argsSchema: ClipArgs,
		when: (ctx) => {
			const e = sequenceContext(ctx);
			const clip = e ? targetClip(e, undefined) : null;
			return !!e && !!clip && !e.session.getState().readOnly && !!linkLayersCommands(e.seq, clip);
		},
		disabledReason: () => t('Select a sound with several layers'),
		run: (ctx, args) => {
			const e = sequenceContext(ctx);
			const clip = e ? targetClip(e, args) : null;
			const p = e && clip ? linkLayersCommands(e.seq, clip) : null;
			if (!e || !p) return;
			applySequenceCommands(ctx, e, p.link ? t('Link Layers') : t('Unlink Layers'), p.commands);
		},
	},
	{
		id: 'sound.detectPeak',
		label: 'Detect Peak',
		description:
			'Measure the peak of the selected audio clip (project audio, not a library sound) in the browser and set it: the clip gets a peak handle and peak snapping',
		scope: E,
		agentExposed: true,
		argsSchema: ClipArgs,
		when: (ctx) => {
			const e = sequenceContext(ctx);
			const c = e ? targetClip(e, undefined) : null;
			return !!e && !!c && !e.session.getState().readOnly && !isLibraryClip(e.doc, c);
		},
		disabledReason: () => t('Select an audio clip that is not a library sound'),
		run: async (ctx, args) => {
			const e = sequenceContext(ctx);
			const clip = e ? targetClip(e, args) : null;
			if (!e || !clip) return;
			try {
				const r = await detectClipPeak(e.session, clip, e.seq.settings.frameRate as Rational);
				const res = applySequenceCommands(ctx, e, t('Detect Peak'), [
					{ type: 'soundDesign.setPeak', clipId: clip.id, peakFlicks: r.peakFlicks } as Command,
				]);
				if (res.ok) {
					const doc = e.session.getCommitted();
					const after = doc.sequences[e.seq.id]?.clips[clip.id];
					const at = after ? alignedFrameOf(doc, e.seq, after) : null;
					ctx.ui.toast({
						kind: 'success',
						message: at !== null ? t('Peak found at frame {0}', Math.floor(at)) : t('Peak set'),
						...(r.truncated ? { detail: t('Only the first 2 minutes of the clip were analysed') } : {}),
						action: { label: t('Undo'), command: 'history.undo' },
					});
				}
			} catch (err) {
				toastError(ctx, t('Could not detect the peak'), err);
				throw new ReportedCommandError(err);
			}
		},
	},
	{
		id: 'sound.addToLibrary',
		label: 'Add to Sound Library…',
		description:
			'Add the folder of the selected audio clip’s file to the Sound Library (with a licence declaration)',
		scope: E,
		capability: 'engine',
		argsSchema: ClipArgs,
		when: (ctx) => {
			const e = sequenceContext(ctx);
			const c = e ? targetClip(e, undefined) : null;
			return !!e && !!c && !isLibraryClip(e.doc, c) && !!mediaFilePath(e.doc.media[c.mediaId]);
		},
		disabledReason: () => t('Select an audio clip imported from a file on this computer'),
		run: (ctx, args) => {
			const e = sequenceContext(ctx);
			const clip = e ? targetClip(e, args) : null;
			const path = e && clip ? mediaFilePath(e.doc.media[clip.mediaId]) : null;
			const folder = path ? folderOf(path) : null;
			if (!folder) return;
			ctx.ui.openDialog(ADD_TO_LIBRARY_DIALOG, { engine: ctx.engine, folder, toast: ctx.ui.toast });
		},
	},
	{
		id: 'sound.browse',
		label: 'Browse Sounds…',
		description: 'Open the Sound Library with the sounds suggested for the selected clip’s type',
		scope: G,
		run: async (ctx) => {
			auditionPlayer().stop();
			await runCommand('panel.focus.soundLibrary', ctx);
		},
	},
];
