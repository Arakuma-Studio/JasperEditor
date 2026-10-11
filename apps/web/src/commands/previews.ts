import type { PreviewRenderMode } from '@jasper/api';
import { EngineError } from '@jasper/engine-client';
import { audioPreviewSegments, previewSegments, sequenceDuration } from '@jasper/project';
import { exportEnvelope } from '../export/settings.ts';
import { PREVIEW_SETTINGS_DIALOG, registerPreviewDialogs } from '../previews/dialog.tsx';
import { previewStatusStore } from '../previews/store.ts';
import { type Env, envOf, selectedClips } from './timeline.ts';
import type { CommandCtx, UiCommand } from './types.ts';

const T = 'editing' as const;

/** In/Out of the sequence, else the whole sequence (Premiere renders the work area / In to Out). */
function inOut(e: Env): { start: number; end: number } {
	const end = sequenceDuration({ clips: e.seq.clips });
	return { start: e.seq.inPoint ?? 0, end: Math.max((e.seq.inPoint ?? 0) + 1, e.seq.outPoint ?? end) };
}

const MODE_LABEL: Record<PreviewRenderMode, string> = {
	effects: 'Render Effects In to Out',
	all: 'Render In to Out',
	selection: 'Render Selection',
	audio: 'Render Audio',
};

async function render(ctx: CommandCtx, mode: PreviewRenderMode): Promise<void> {
	const e = envOf(ctx);
	if (!e) return;
	const label = MODE_LABEL[mode];
	const clipIds = mode === 'selection' ? selectedClips(e).map((c) => c.id) : undefined;
	if (mode === 'selection' && !clipIds?.length) {
		ctx.ui.toast({ kind: 'info', message: `${label}: select clips first` });
		return;
	}
	try {
		const doc = e.session.getCommitted();
		const r = await ctx.engine.renderPreviews({
			envelope: exportEnvelope(doc, e.session.revision),
			sequenceId: e.seq.id,
			mode,
			...(mode === 'selection' ? { clipIds } : { range: inOut(e) }),
		});
		if ('job' in r && r.job === null) {
			ctx.ui.toast({
				kind: 'info',
				message: `${label}: nothing to render`,
				detail:
					r.existing > 0
						? `Previews are up to date (${r.existing} segment${r.existing === 1 ? '' : 's'}).`
						: 'No segment in the range needs rendering.',
			});
			return;
		}
		ctx.ui.toast({
			kind: 'info',
			message: `${label}: ${(r as { title: string }).title}`,
			detail: 'Progress is shown in the Jobs panel.',
		});
	} catch (err) {
		ctx.ui.toast({
			kind: 'error',
			message: `${label} failed`,
			detail: err instanceof EngineError ? `${err.code}: ${err.message}` : String(err),
		});
	}
}

async function deleteFiles(ctx: CommandCtx, inToOut: boolean): Promise<void> {
	const e = envOf(ctx);
	if (!e) return;
	const label = inToOut ? 'Delete Render Files In to Out' : 'Delete Render Files';
	try {
		let req: { all: true } | { hashes: string[] };
		if (inToOut) {
			const doc = e.session.getCommitted();
			const r = inOut(e);
			const inRange = (s: { startFrame: number; frames: number }) =>
				s.startFrame < r.end && s.startFrame + s.frames > r.start;
			req = {
				hashes: [
					...previewSegments(doc, e.seq.id).filter(inRange),
					...audioPreviewSegments(doc, e.seq.id).filter(inRange),
				].map((s) => s.hash),
			};
		} else req = { all: true };
		const res = await ctx.engine.deletePreviews(req);
		previewStatusStore.reset();
		ctx.ui.toast({
			kind: 'success',
			message: `${label}: ${res.deleted} file${res.deleted === 1 ? '' : 's'} deleted`,
			...(res.bytes ? { detail: `${(res.bytes / 1048576).toFixed(1)} MB freed` } : {}),
		});
	} catch (err) {
		ctx.ui.toast({
			kind: 'error',
			message: `${label} failed`,
			detail: err instanceof EngineError ? `${err.code}: ${err.message}` : String(err),
		});
	}
}

const hasSeq = (ctx: CommandCtx) => envOf(ctx) !== null;

export const previewCommands: UiCommand[] = [
	{
		// Keymap presets depend on this stable command id.
		id: 'timeline.renderInToOut',
		label: 'Render Effects In to Out',
		description: 'Render previews of the red and yellow segments between In and Out',
		scope: T,
		capability: 'engine',
		when: hasSeq,
		run: (ctx) => render(ctx, 'effects'),
		agentExposed: true,
	},
	{
		id: 'timeline.renderAllInToOut',
		label: 'Render In to Out',
		description: 'Render previews of every segment between In and Out',
		scope: T,
		capability: 'engine',
		when: hasSeq,
		run: (ctx) => render(ctx, 'all'),
		agentExposed: true,
	},
	{
		id: 'timeline.renderSelection',
		label: 'Render Selection',
		description: 'Render previews of the segments that show the selected clips',
		scope: T,
		capability: 'engine',
		when: (ctx) => {
			const e = envOf(ctx);
			return !!e && selectedClips(e).length > 0;
		},
		disabledReason: (ctx) => {
			const e = envOf(ctx);
			return e && selectedClips(e).length === 0 ? 'Select clips in the Timeline first' : undefined;
		},
		run: (ctx) => render(ctx, 'selection'),
		agentExposed: true,
	},
	{
		id: 'timeline.renderAudio',
		label: 'Render Audio',
		description: 'Render the sequence mix between In and Out to audio previews',
		scope: T,
		capability: 'engine',
		when: hasSeq,
		run: (ctx) => render(ctx, 'audio'),
		agentExposed: true,
	},
	{
		id: 'timeline.deleteRenderFiles',
		label: 'Delete Render Files',
		description: 'Delete every render preview file',
		scope: T,
		capability: 'engine',
		when: hasSeq,
		run: (ctx) => deleteFiles(ctx, false),
		agentExposed: true,
	},
	{
		id: 'timeline.deleteRenderFilesInToOut',
		label: 'Delete Render Files In to Out',
		description: 'Delete the render preview files of the segments between In and Out',
		scope: T,
		capability: 'engine',
		when: hasSeq,
		run: (ctx) => deleteFiles(ctx, true),
		agentExposed: true,
	},
	{
		id: 'sequence.previewSettings',
		label: 'Video Previews…',
		description: 'Preview file format, size and quality of the active sequence',
		scope: T,
		when: hasSeq,
		run: (ctx) => {
			const e = envOf(ctx);
			if (!e) return;
			registerPreviewDialogs();
			ctx.ui.openDialog(PREVIEW_SETTINGS_DIALOG, { session: e.session, sequenceId: e.seq.id });
		},
	},
];
