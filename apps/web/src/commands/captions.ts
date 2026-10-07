// wp captions UI commands: Sequence ▸ Captions (Add New Caption Track, Add Caption at Playhead, Go to Next / Previous
// Caption Segment, Split / Merge, Show / Hide All Caption Tracks), File ▸ Import Captions… / Export ▸ Captions, the
// Text panel (Captions / Transcript). Premiere defaults: Ctrl+Alt+A / Opt+Cmd+A, Ctrl+Alt+C / Opt+Cmd+C,
// Ctrl+Alt+Down / Up (keymap-defaults.ts). Each edit is one document transaction.
import {
	activeCaptionTrack,
	CAPTION_FILE_FORMATS,
	CAPTION_FORMAT_INFO,
	type CaptionFileFormat,
	captionClipsOf,
	captionCuesForTrack,
	type ProjectDocument,
	type Sequence,
	supportsDropFrame,
	type TransactionResult,
	writeCaptionFileBytes,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { importCaptionFiles } from '../import/captions.ts';
// Registers the Properties ▸ Caption section.
import '../panels/text/CaptionSection.tsx';
import { downloadBytes, type TranscriptTool, textPanelRequests } from '../panels/text/state.ts';
import { activeTimeline } from '../panels/timeline/env.tsx';
import type { CommandCtx, CommandScope, UiCommand } from './types.ts';

type Env = { session: EditorSession; seq: Sequence; playhead: number; doc: ProjectDocument };

function envOf(ctx: CommandCtx): Env | null {
	const session = ctx.session;
	if (!session) return null;
	const s = session.getState();
	const seqId = activeTimeline(ctx.services)?.sequenceId() ?? s.activeSequenceId;
	const doc = session.getCommitted();
	const seq = seqId ? (doc.sequences[seqId] as Sequence | undefined) : undefined;
	if (!seq) return null;
	return { session, seq, doc, playhead: session.transport.getState().frame };
}

const editable = (ctx: CommandCtx) => !!envOf(ctx) && !ctx.session!.getState().readOnly;

function apply(ctx: CommandCtx, e: Env, label: string, commands: unknown[]): TransactionResult {
	const r = e.session.apply({ label, origin: 'user', sequenceId: e.seq.id, commands: commands as never[] });
	if (!r.ok)
		ctx.ui.toast({ kind: 'warning', message: `${label}: not possible`, detail: r.errors[0]?.message });
	return r;
}

function openText(ctx: CommandCtx, tab: 'transcript' | 'captions', clipId?: string, tool?: TranscriptTool) {
	textPanelRequests.open(tab, clipId, tool);
	ctx.services.get('shell')?.focusPanel('text');
}

/** Caption starts on the active caption track (all caption tracks when it has none). */
function captionStarts(e: Env): number[] {
	const active = activeCaptionTrack(e.seq);
	const tracks = active ? [active] : e.seq.captionTracks;
	return [...new Set(tracks.flatMap((t) => captionClipsOf(e.seq, t.id).map((c) => c.start)))].sort(
		(a, b) => a - b,
	);
}

function cmd(
	id: string,
	label: string,
	scope: CommandScope,
	run: (ctx: CommandCtx, e: Env, args?: unknown) => void | Promise<void>,
	extra: Partial<UiCommand> = {},
): UiCommand {
	return {
		id,
		label,
		scope,
		when: editable,
		disabledReason: (ctx) =>
			!ctx.session
				? 'Open a project first'
				: !envOf(ctx)
					? 'Open a sequence first'
					: 'The project is read-only',
		run: async (ctx, args) => {
			const e = envOf(ctx);
			if (e) await run(ctx, e, args);
		},
		agentExposed: true,
		...extra,
	};
}

function pickCaptionFiles(): Promise<File[]> {
	return new Promise((resolve) => {
		const input = document.createElement('input');
		input.type = 'file';
		input.multiple = true;
		input.accept = `${CAPTION_FILE_FORMATS.map((f) => `.${CAPTION_FORMAT_INFO[f].extension}`).join(',')},.xml`;
		input.onchange = () => resolve([...(input.files ?? [])]);
		input.oncancel = () => resolve([]);
		input.click();
	});
}

export const captionCommands: UiCommand[] = [
	cmd('timeline.addCaptionTrack', 'Add New Caption Track', 'timeline', (ctx, e) => {
		const r = apply(ctx, e, 'Add Caption Track', [{ type: 'caption.addTrack' }]);
		if (r.ok) openText(ctx, 'captions');
	}),
	cmd('timeline.addCaptionAtPlayhead', 'Add Caption at Playhead', 'timeline', (ctx, e) => {
		const r = apply(ctx, e, 'Add Caption', [{ type: 'caption.add', at: e.playhead, text: '' }]);
		if (r.ok) {
			const clipId = (r.results[0] as { clipId: string }).clipId;
			e.session.select('timeline', [clipId], 'replace', { primary: clipId });
			openText(ctx, 'captions', clipId);
		}
	}),
	cmd(
		'timeline.nextCaptionSegment',
		'Go to Next Caption Segment',
		'timeline',
		(ctx, e) => {
			const f = captionStarts(e).find((s) => s > e.playhead);
			if (f === undefined) ctx.ui.toast({ kind: 'info', message: 'No later caption' });
			else e.session.transport.seek(f);
		},
		{ when: (ctx) => !!envOf(ctx) },
	),
	cmd(
		'timeline.prevCaptionSegment',
		'Go to Previous Caption Segment',
		'timeline',
		(ctx, e) => {
			const f = [...captionStarts(e)].reverse().find((s) => s < e.playhead);
			if (f === undefined) ctx.ui.toast({ kind: 'info', message: 'No earlier caption' });
			else e.session.transport.seek(f);
		},
		{ when: (ctx) => !!envOf(ctx) },
	),
	cmd('captions.split', 'Split Caption', 'editing', (ctx, e) => {
		apply(ctx, e, 'Split Caption', [{ type: 'caption.split', at: e.playhead }]);
	}),
	cmd('captions.merge', 'Merge Captions', 'editing', (ctx, e) => {
		const ids = e.session
			.getState()
			.selection.timeline.clips.filter((id) => e.seq.clips[id]?.kind === 'captions');
		if (ids.length < 2) ctx.ui.toast({ kind: 'info', message: 'Select two or more consecutive captions' });
		else apply(ctx, e, 'Merge Captions', [{ type: 'caption.merge', clipIds: ids }]);
	}),
	cmd('captions.showAll', 'Show All Caption Tracks', 'global', (ctx, e) => {
		apply(
			ctx,
			e,
			'Show Captions',
			e.seq.captionTracks.map((t) => ({ type: 'track.update', trackId: t.id, patch: { visible: true } })),
		);
	}),
	cmd('captions.hideAll', 'Hide All Caption Tracks', 'global', (ctx, e) => {
		apply(
			ctx,
			e,
			'Hide Captions',
			e.seq.captionTracks.map((t) => ({ type: 'track.update', trackId: t.id, patch: { visible: false } })),
		);
	}),
	cmd('captions.import', 'Import Captions…', 'global', async (ctx, e) => {
		const files = await pickCaptionFiles();
		if (!files.length) return;
		const r = await importCaptionFiles(e.session, ctx.engine, { files, paths: [] });
		for (const f of r.failed)
			ctx.ui.toast({ kind: 'warning', message: `${f.name}: not imported`, detail: f.message });
		if (r.trackIds.length) openText(ctx, 'captions');
	}),
	cmd('captions.export', 'Export Captions', 'global', (ctx, e, args) => {
		const format = ((args as { format?: CaptionFileFormat } | undefined)?.format ??
			'srt') as CaptionFileFormat;
		const track = activeCaptionTrack(e.seq);
		if (!track) {
			ctx.ui.toast({ kind: 'info', message: 'The sequence has no caption track' });
			return;
		}
		const cues = captionCuesForTrack(e.doc, e.seq, track.id);
		const bytes = writeCaptionFileBytes(
			{ cues, blocks: [...(track.vttBlocks ?? [])], warnings: [] },
			format,
			{
				rate: e.seq.settings.frameRate,
				dropFrame: supportsDropFrame(e.seq.settings.frameRate) ? e.seq.settings.dropFrame : true,
				language: track.language ?? 'en',
			},
		);
		const info = CAPTION_FORMAT_INFO[format];
		downloadBytes(
			bytes,
			`${(track.name ?? 'captions').replace(/[^\w.-]+/g, '_')}.${info.extension}`,
			info.mime,
		);
	}),
	cmd(
		'captions.openPanel',
		'Captions',
		'global',
		(ctx, e) => {
			const sel = e.session
				.getState()
				.selection.timeline.clips.find((id) => e.seq.clips[id]?.kind === 'captions');
			openText(ctx, 'captions', sel);
		},
		{ when: (ctx) => !!envOf(ctx) },
	),
	cmd('transcript.openPanel', 'Transcript', 'global', (ctx) => openText(ctx, 'transcript'), {
		when: (ctx) => !!envOf(ctx),
	}),
	cmd('transcript.import', 'Import Transcript…', 'global', (ctx) =>
		openText(ctx, 'transcript', undefined, 'import'),
	),
	cmd('transcript.createCaptions', 'Create Captions…', 'global', (ctx) =>
		openText(ctx, 'transcript', undefined, 'captions'),
	),
	cmd('transcript.removeFillers', 'Remove Filler Words…', 'global', (ctx) =>
		openText(ctx, 'transcript', undefined, 'fillers'),
	),
	cmd('transcript.removePauses', 'Remove Pauses…', 'global', (ctx) =>
		openText(ctx, 'transcript', undefined, 'pauses'),
	),
];
