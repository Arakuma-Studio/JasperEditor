// Cue Seam commands (spec 12 §2.7; P2-R7 timeline parts): Markers ▸ Add Sound Cue (Alt+Shift+C), Next / Previous Cue,
// Convert Markers to Cues, Convert Cue to Marker; Sequence ▸ Sound Design ▸ Suggest Cues…, Show Cue Seam, Clear
// Unfilled Cues; `soundLibrary.fillCue` (double-click / Enter on a cue: the Sound Library in Fill mode). Document edits
// are `soundCue.*` / `marker.*` commands (one undo step each); agents reach the UI ones through the command catalogue.
import { formatTimecode, type Rational } from '@jasper/project';
import { z } from 'zod';
import { t } from '../i18n/runtime.ts';
import { requestCueFill } from '../sound/controller.ts';
import { CUE_WEIGHT_LABELS, cueAfter, cuesOf, kindLabel } from '../sound/cues/model.ts';
import {
	addCueCommand,
	cueSeamShownFor,
	cuesToMarkersCommands,
	markersToCuesCommands,
	removeCueCommands,
	selectedCues,
	unfilledCueIds,
} from '../sound/cues/seam.ts';
import { registerSuggestCuesDialog, SUGGEST_CUES_DIALOG } from '../sound/cues/SuggestCuesDialog.tsx';
import { runCommand } from './registry.ts';
import { applySequenceCommands, sequenceContext } from './sequence-context.ts';
import type { CommandCtx, CommandScope, UiCommand } from './types.ts';

registerSuggestCuesDialog();

const E: CommandScope = 'editing';
const G: CommandScope = 'global';

const hasSeq = (ctx: CommandCtx) => sequenceContext(ctx) !== null;
const writable = (ctx: CommandCtx) => hasSeq(ctx) && !ctx.session?.getState().readOnly;
const noSeqReason = (ctx: CommandCtx) =>
	!ctx.session
		? t('Open a project first')
		: ctx.session.getState().readOnly
			? t('The project is read-only')
			: t('Open a sequence first');

/** Seeks to a cue and selects it (Next / Previous Cue). */
function goToCue(ctx: CommandCtx, dir: 1 | -1): void {
	const e = sequenceContext(ctx);
	if (!e) return;
	const c = cueAfter(cuesOf(e.seq), e.playhead, dir);
	if (!c) return;
	e.session.transport.seek(c.frame);
	e.handle?.controller.reveal(c.frame);
	e.session.select('cues', [c.id], 'replace');
}

const AddCueArgs = z
	.object({
		/** Sequence frame of the cue (default: the playhead). */
		frame: z.number().int().min(0).optional(),
	})
	.strict();

const FillArgs = z.object({ cueId: z.string().min(1).max(128) }).strict();

export const soundCueCommands: UiCommand[] = [
	{
		id: 'sound.addCue',
		label: 'Add Sound Cue',
		description:
			'Add a manual sound cue (support weight) to the active sequence at the playhead or `frame`; it shows on the Cue Seam',
		scope: E,
		agentExposed: true,
		argsSchema: AddCueArgs,
		when: writable,
		disabledReason: noSeqReason,
		run: (ctx, args) => {
			const e = sequenceContext(ctx);
			if (!e) return;
			const frame = (args as z.infer<typeof AddCueArgs> | undefined)?.frame ?? e.playhead;
			const r = applySequenceCommands(ctx, e, t('Add Sound Cue'), [addCueCommand(e.seq.id, frame)]);
			if (!r.ok) return;
			const ids = (r.results[0] as { cueIds?: string[] } | undefined)?.cueIds ?? [];
			if (ids.length) e.session.select('cues', ids, 'replace');
			if (!cueSeamShownFor(e.session, e.seq.id))
				ctx.ui.toast({
					kind: 'info',
					message: t('Sound cue added'),
					detail: t('The Cue Seam is hidden: Sequence ▸ Sound Design ▸ Show Cue Seam'),
				});
		},
	},
	{
		id: 'sound.nextCue',
		label: 'Go to Next Sound Cue',
		scope: E,
		agentExposed: true,
		when: (ctx) => {
			const e = sequenceContext(ctx);
			return !!e && cueAfter(cuesOf(e.seq), e.playhead, 1) !== null;
		},
		run: (ctx) => goToCue(ctx, 1),
	},
	{
		id: 'sound.prevCue',
		label: 'Go to Previous Sound Cue',
		scope: E,
		agentExposed: true,
		when: (ctx) => {
			const e = sequenceContext(ctx);
			return !!e && cueAfter(cuesOf(e.seq), e.playhead, -1) !== null;
		},
		run: (ctx) => goToCue(ctx, -1),
	},
	{
		id: 'sound.convertMarkersToCues',
		label: 'Convert Markers to Sound Cues',
		description:
			'Turn the markers named "sfx: <type>[+<type>]" and the selected markers of the active sequence into sound cues (the markers are removed)',
		scope: E,
		agentExposed: true,
		when: (ctx) => {
			const e = sequenceContext(ctx);
			if (!e || e.session.getState().readOnly) return false;
			return markersToCuesCommands(e.seq, e.session.getState().selection.markers).length > 0;
		},
		disabledReason: () => t('No marker named “sfx: …” and no marker selected'),
		run: (ctx) => {
			const e = sequenceContext(ctx);
			if (!e) return;
			const commands = markersToCuesCommands(e.seq, e.session.getState().selection.markers);
			if (!commands.length) return;
			const n = (commands[0] as { cues: unknown[] }).cues.length;
			const r = applySequenceCommands(ctx, e, t('Convert Markers to Cues ({0})', n), commands);
			if (!r.ok) return;
			const ids = (r.results[0] as { cueIds?: string[] } | undefined)?.cueIds ?? [];
			e.session.select('markers', [], 'replace');
			if (ids.length) e.session.select('cues', ids, 'replace');
		},
	},
	{
		id: 'sound.convertCueToMarker',
		label: 'Convert Sound Cue to Marker',
		description: 'Turn the selected sound cues into markers named "sfx: <types>" (the cues are removed)',
		scope: E,
		agentExposed: true,
		when: (ctx) => {
			const e = sequenceContext(ctx);
			return !!e && !e.session.getState().readOnly && selectedCues(e.session, e.seq).length > 0;
		},
		disabledReason: () => t('Select sound cues on the Cue Seam'),
		run: (ctx) => {
			const e = sequenceContext(ctx);
			if (!e) return;
			const cues = selectedCues(e.session, e.seq);
			const r = applySequenceCommands(
				ctx,
				e,
				cues.length > 1 ? t('Convert Cues to Markers ({0})', cues.length) : t('Convert Cue to Marker'),
				cuesToMarkersCommands(cues),
			);
			if (r.ok) e.session.select('cues', [], 'replace');
		},
	},
	{
		id: 'sound.deleteSelectedCues',
		label: 'Delete Selected Sound Cues',
		description: 'Remove the selected sound cues (the clips filling them stay and forget the cue)',
		scope: E,
		when: (ctx) => {
			const e = sequenceContext(ctx);
			return !!e && !e.session.getState().readOnly && selectedCues(e.session, e.seq).length > 0;
		},
		disabledReason: () => t('Select sound cues on the Cue Seam'),
		run: (ctx) => {
			const e = sequenceContext(ctx);
			if (!e) return;
			const ids = selectedCues(e.session, e.seq).map((c) => c.id);
			const r = applySequenceCommands(
				ctx,
				e,
				ids.length > 1 ? t('Delete Cues ({0})', ids.length) : t('Delete Cue'),
				removeCueCommands(ids),
			);
			if (r.ok) e.session.select('cues', [], 'replace');
		},
	},
	{
		id: 'sound.suggestCues',
		label: 'Suggest Cues…',
		description: 'Find sound cues in the edit (cuts, transitions, motion, text, motion graphics, sfx markers)',
		scope: G,
		when: writable,
		disabledReason: noSeqReason,
		run: (ctx) => {
			const e = sequenceContext(ctx);
			if (!e) return;
			ctx.ui.openDialog(SUGGEST_CUES_DIALOG, {
				session: e.session,
				sequenceId: e.seq.id,
				toast: ctx.ui.toast,
			});
		},
	},
	{
		id: 'sound.toggleCueSeam',
		label: 'Show Cue Seam',
		description: 'Show or hide the Cue Seam (the lane of sound cues between the video and audio tracks)',
		scope: G,
		agentExposed: true,
		when: hasSeq,
		checked: (ctx) => {
			const e = sequenceContext(ctx);
			return !!e && cueSeamShownFor(e.session, e.seq.id);
		},
		run: (ctx) => {
			const e = sequenceContext(ctx);
			if (!e) return;
			const shown = cueSeamShownFor(e.session, e.seq.id);
			e.session.setView(e.seq.id, { cueSeam: shown ? 'off' : 'on' });
		},
	},
	{
		id: 'sound.clearUnfilledCues',
		label: 'Clear Unfilled Cues',
		description: 'Remove every sound cue of the active sequence that no clip fills yet (one undo step)',
		scope: E,
		agentExposed: true,
		when: (ctx) => {
			const e = sequenceContext(ctx);
			return !!e && !e.session.getState().readOnly && unfilledCueIds(e.seq).length > 0;
		},
		disabledReason: () => t('Every cue is filled (or there are none)'),
		run: (ctx) => {
			const e = sequenceContext(ctx);
			if (!e) return;
			const ids = unfilledCueIds(e.seq);
			applySequenceCommands(ctx, e, t('Clear Unfilled Cues ({0})', ids.length), removeCueCommands(ids));
		},
	},
	{
		id: 'soundLibrary.fillCue',
		label: 'Fill Cue from Sound Library…',
		description:
			'Open the Sound Library in Fill mode for a cue: its type filter is set to the sounds the cue suggests (choose one and insert it to fill the cue)',
		scope: G,
		agentExposed: true,
		argsSchema: FillArgs,
		when: hasSeq,
		run: async (ctx, args) => {
			const e = sequenceContext(ctx);
			const a = args as z.infer<typeof FillArgs> | undefined;
			const cueId = a?.cueId ?? e?.session.getState().selection.cues?.at(-1);
			if (!e || !cueId) return;
			const cue = cuesOf(e.seq).find((c) => c.id === cueId);
			if (!cue) throw new Error(t('No sound cue {0} in this sequence', cueId));
			e.session.select('cues', [cue.id], 'replace');
			const tc = formatTimecode(cue.frame, e.seq.settings.frameRate as Rational, {
				dropFrame: e.seq.settings.dropFrame,
				startFrames: e.seq.settings.startTimecodeFrames,
			});
			requestCueFill({
				sequenceId: e.seq.id,
				cueId: cue.id,
				types: cue.types ?? [],
				label: t('{0} {1} cue at {2}', CUE_WEIGHT_LABELS[cue.weight], kindLabel(cue.kind), tc),
			});
			await runCommand('panel.focus.soundLibrary', ctx);
		},
	},
];
