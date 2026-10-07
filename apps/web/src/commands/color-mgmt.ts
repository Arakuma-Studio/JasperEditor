// Colour management UI commands and menu extensions (workstream color-mgmt): Sequence ▸ Sequence Settings… (its Colour
// section), Interpret Footage ▸ Colour on Project items (also in the Project panel's item menu) and Clip Colour Space on
// timeline clips (clip context menu). Every edit is one undoable transaction (dialogs in color-mgmt/dialogs.tsx).
import type { MediaAsset } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { openDialog } from '@jasper/ui';
import {
	INTERPRET_COLOR_DIALOG,
	registerColorMgmtDialogs,
	SEQUENCE_COLOR_DIALOG,
} from '../color-mgmt/dialogs.tsx';
import { clipMenuExtensions, projectItemMenuExtensions } from '../extensions/index.ts';
import type { CommandCtx, UiCommand } from './types.ts';

const PICTURES = new Set(['video', 'image', 'animated-image']);

const writable = (ctx: CommandCtx) => !!ctx.session && !ctx.session.getState().readOnly;

/** Picture media of the selected Project items. */
function selectedPictureMedia(session: EditorSession): string[] {
	const s = session.getState();
	const out: string[] = [];
	for (const id of s.selection.project.items) {
		const it = s.document.items[id];
		if (it?.kind !== 'media') continue;
		const a = s.document.media[it.mediaId] as MediaAsset | undefined;
		if (a && PICTURES.has(a.kind)) out.push(a.id);
	}
	return [...new Set(out)];
}

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

projectItemMenuExtensions.register({
	id: 'color-mgmt.interpret',
	items({ session, items, readOnly }) {
		const doc = session.getCommitted();
		const media = items
			.filter((i) => i.kind === 'media')
			.map((i) => (i.kind === 'media' ? doc.media[i.mediaId] : undefined))
			.filter((a): a is NonNullable<typeof a> => !!a && PICTURES.has(a.kind))
			.map((a) => a.id);
		if (media.length === 0) return [];
		return [
			{
				kind: 'item',
				label: 'Interpret Footage ▸ Colour…',
				disabled: readOnly,
				run: () => {
					registerColorMgmtDialogs();
					void openDialog(INTERPRET_COLOR_DIALOG, { session, target: { kind: 'media', mediaIds: media } });
				},
			},
		];
	},
});

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
		id: 'sequence.settings',
		label: 'Sequence Settings…',
		description:
			'Colour settings of the active sequence: working colour space (Rec. 709, sRGB, Rec. 2020, P3, Rec. 2100 PQ / HLG, linear variants), Blend Using 1.0 Gamma, Auto Tone Map Media, HDR graphics white and mastering peak. Frame size, rate and audio are in the Properties panel.',
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
		id: 'media.interpretColor',
		label: 'Interpret Footage ▸ Colour…',
		description:
			'How the selected Project items’ colours are read: automatic from the file tags or a colour space override (camera log, HDR, ACES, an OCIO config space), range, tone mapping, PQ peak and input LUT.',
		scope: 'global',
		agentExposed: true,
		when: (ctx) => writable(ctx) && selectedPictureMedia(ctx.session!).length > 0,
		disabledReason: () => 'Select video or still items in the Project panel',
		run(ctx) {
			const session = ctx.session;
			if (!session) return;
			const mediaIds = selectedPictureMedia(session);
			if (mediaIds.length === 0) return;
			registerColorMgmtDialogs();
			ctx.ui.openDialog(INTERPRET_COLOR_DIALOG, { session, target: { kind: 'media', mediaIds } });
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
