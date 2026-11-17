import { INTERCHANGE_FORMATS, type InterchangeFormat } from '@jasper/api';
import { z } from 'zod';
import {
	INTERCHANGE_EXPORT_DIALOG,
	LINK_MEDIA_DIALOG,
	offlineMedia,
	registerInterchangeDialogs,
} from '../interchange/dialogs.tsx';
import { formatEntry } from '../interchange/formats.ts';
import type { CommandCtx, UiCommand } from './types.ts';

registerInterchangeDialogs();

const writable = (ctx: CommandCtx) => !!ctx.session && !ctx.session.getState().readOnly;

/** Export source: a selected sequence in the focused Project panel, else the active sequence. */
function sourceSequence(ctx: CommandCtx): string | null {
	const s = ctx.session;
	if (!s) return null;
	if (ctx.focus.panel === 'project') {
		const st = s.getState();
		const item = st.selection.project.primary ? st.document.items[st.selection.project.primary] : undefined;
		if (item?.kind === 'sequence') return item.sequenceId;
	}
	return s.getState().activeSequenceId ?? Object.keys(s.getCommitted().sequences)[0] ?? null;
}

const FormatArgs = z.object({ format: z.enum(INTERCHANGE_FORMATS) });

export const interchangeCommands: UiCommand[] = [
	{
		id: 'file.exportTimeline',
		label: 'Export Timeline…',
		description:
			'Export the sequence as Final Cut Pro XML, FCPXML, OpenTimelineIO, EDL, AAF, OMF or Avid ALE',
		scope: 'global',
		argsSchema: FormatArgs,
		when: (ctx) => !!sourceSequence(ctx),
		disabledReason: () => 'Open or select a sequence to export',
		run: (ctx, args) => {
			const format = ((args as { format?: InterchangeFormat } | undefined)?.format ??
				'fcp7') as InterchangeFormat;
			const sequenceId = sourceSequence(ctx);
			if (!ctx.session || !sequenceId) return;
			ctx.ui.openDialog(INTERCHANGE_EXPORT_DIALOG, {
				session: ctx.session,
				engine: ctx.engine,
				sequenceId,
				format: formatEntry(format).id,
			});
		},
		agentExposed: true,
	},
	{
		id: 'project.linkMedia',
		label: 'Link Media…',
		description: 'Relink offline media: locate files or search a folder by name, size and duration',
		scope: 'global',
		when: (ctx) => writable(ctx) && offlineMedia(ctx.session!).length > 0,
		disabledReason: () => 'No media is offline',
		run: (ctx, args) => {
			const s = ctx.session;
			if (!s) return;
			const st = s.getState();
			// `{all: true}` (the Project panel's offline badge): every offline medium, whatever is selected.
			const all = (args as { all?: unknown } | undefined)?.all === true;
			const selected = (all ? [] : st.selection.project.items)
				.map((id) => st.document.items[id])
				.flatMap((i) => (i?.kind === 'media' ? [i.mediaId] : []));
			const offline = new Set(offlineMedia(s).map((m) => m.id));
			const mediaIds = selected.filter((id) => offline.has(id));
			ctx.ui.openDialog(LINK_MEDIA_DIALOG, {
				session: s,
				engine: ctx.engine,
				...(mediaIds.length ? { mediaIds } : {}),
			});
		},
		agentExposed: true,
	},
];
