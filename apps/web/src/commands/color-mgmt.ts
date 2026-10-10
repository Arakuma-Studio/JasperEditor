// Colour management UI commands and menu extensions (workstream color-mgmt): Sequence ▸ Sequence Settings… (its Colour
// section), the Colour section of Interpret Footage (color-mgmt/interpret-section.tsx) and Clip Colour Space on
// timeline clips (clip context menu). Every edit is one undoable transaction (dialogs in color-mgmt/dialogs.tsx).
import type { MediaAsset } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { openDialog } from '@jasper/ui';
import {
	INTERPRET_COLOR_DIALOG,
	registerColorMgmtDialogs,
	SEQUENCE_COLOR_DIALOG,
} from '../color-mgmt/dialogs.tsx';
// The Colour section of Interpret Footage (imports' section registry) registers at module load.
import '../color-mgmt/interpret-section.tsx';
import { clipMenuExtensions } from '../extensions/index.ts';
import type { CommandCtx, UiCommand } from './types.ts';

const PICTURES = new Set(['video', 'image', 'animated-image']);

const writable = (ctx: CommandCtx) => !!ctx.session && !ctx.session.getState().readOnly;

/** Selected timeline clips that show a picture from media. */
function selectedMediaClips(session: EditorSession): { sequenceId: string; clipIds: string[] } | null {
	const s = session.getState();
	const seq = s.activeSequenceId ? s.document.sequences[s.activeSequenceId] : undefined;
	if (!seq) return null;
	const ids = s.selection.timeline.clips.filter((id) => {
		const c = seq.clips[id] as { mediaId?: string } | undefined;
		const a = c?.mediaId ? (s.document.media[c.mediaId] as MediaAsset | undefined) : undefined;
		return !!a && PICTURES.has(a.kind);
	});
	return ids.length ? { sequenceId: seq.id, clipIds: ids } : null;
}

clipMenuExtensions.register({
	id: 'color-mgmt.clip',
	items({ session, clip, selection }) {
		const s = session.getState();
		const a = (clip as { mediaId?: string }).mediaId
			? (s.document.media[(clip as { mediaId: string }).mediaId] as MediaAsset | undefined)
			: undefined;
		if (!a || !PICTURES.has(a.kind) || !s.activeSequenceId) return [];
		const ids = selection.includes(clip.id) ? selection : [clip.id];
		return [
			{
				kind: 'item',
				label: 'Clip Colour Space…',
				disabled: s.readOnly,
				run: () => {
					registerColorMgmtDialogs();
					void openDialog(INTERPRET_COLOR_DIALOG, {
						session,
						target: { kind: 'clips', sequenceId: s.activeSequenceId!, clipIds: [...ids] },
					});
				},
			},
		];
	},
});

export const colorMgmtCommands: UiCommand[] = [
	{
		// gaps: Sequence ▸ Sequence Settings… is the whole dialog (gaps/SequenceSettingsDialog.tsx); its Colour section
		// opens this one.
		id: 'sequence.colorSettings',
		label: 'Sequence Colour Settings…',
		description:
			'Colour settings of the active sequence: working colour space (Rec. 709, sRGB, Rec. 2020, P3, Rec. 2100 PQ / HLG, linear variants), Blend Using 1.0 Gamma, Auto Tone Map Media, HDR graphics white and mastering peak (Sequence Settings ▸ Colour).',
		scope: 'global',
		agentExposed: true,
		when: (ctx) => writable(ctx) && !!ctx.session!.getState().activeSequenceId,
		disabledReason: () => 'Open a sequence',
		run(ctx) {
			const session = ctx.session;
			const id = session?.getState().activeSequenceId;
			if (!session || !id) return;
			registerColorMgmtDialogs();
			ctx.ui.openDialog(SEQUENCE_COLOR_DIALOG, { session, sequenceId: id });
		},
	},
	{
		id: 'clip.colorSpace',
		label: 'Clip Colour Space…',
		description:
			'Overrides the colour interpretation of the selected clips (over their media’s Interpret Footage).',
		scope: 'global',
		agentExposed: true,
		when: (ctx) => writable(ctx) && !!selectedMediaClips(ctx.session!),
		disabledReason: () => 'Select clips that show video or stills',
		run(ctx) {
			const session = ctx.session;
			const sel = session ? selectedMediaClips(session) : null;
			if (!session || !sel) return;
			registerColorMgmtDialogs();
			ctx.ui.openDialog(INTERPRET_COLOR_DIALOG, { session, target: { kind: 'clips', ...sel } });
		},
	},
];
