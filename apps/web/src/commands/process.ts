import { type MediaAsset, originalMediaId } from '@jasper/project';
import { z } from 'zod';
import {
	openProcessForClips,
	openProcessForMedia,
	openReplaceFootage,
	replaceFootageBlocker,
	switchMediaVersionInteractive,
	targetsForClips,
} from '../processing/actions.ts';
import { registerProcessingUi } from '../processing/register.ts';
import { PREFERENCES_DIALOG, registerPreferencesDialog } from '../shell/preferences/index.ts';
import type { CommandCtx, UiCommand } from './types.ts';

registerProcessingUi();

function selectedVideoMedia(ctx: CommandCtx): string | null {
	const s = ctx.session?.getState();
	if (!s) return null;
	const doc = s.document;
	const ids = s.selection.project.items;
	const itemId = s.selection.project.primary ?? ids[0];
	const it = itemId ? (doc.items[itemId] as { kind: string; mediaId?: string } | undefined) : undefined;
	if (it?.kind !== 'media' || !it.mediaId) return null;
	return (doc.media[it.mediaId] as MediaAsset | undefined)?.kind === 'video' ? it.mediaId : null;
}

function clipTargets(ctx: CommandCtx) {
	const s = ctx.session?.getState();
	return s ? targetsForClips(s.document, s.selection.timeline.clips) : null;
}

/** Selected video clips that use a processed (derived) version. */
function processedSelection(ctx: CommandCtx): { clipIds: string[]; original: string } | null {
	const t = clipTargets(ctx);
	const s = ctx.session?.getState();
	if (!t || !s) return null;
	const original = originalMediaId(s.document, t.mediaId);
	if (!original || original === t.mediaId) return null;
	return { clipIds: t.clipIds, original };
}

/** Media of Replace Footage…: the selected Project media item, else the first selected timeline clip's. */
function replaceTarget(ctx: CommandCtx): string | null {
	const s = ctx.session?.getState();
	if (!s) return null;
	const doc = s.document;
	const itemId = s.selection.project.primary ?? s.selection.project.items[0];
	const it = itemId ? (doc.items[itemId] as { kind: string; mediaId?: string } | undefined) : undefined;
	if (it?.kind === 'media' && it.mediaId) return it.mediaId;
	for (const id of s.selection.timeline.clips)
		for (const seq of Object.values(doc.sequences)) {
			const c = seq.clips[id] as { mediaId?: string } | undefined;
			if (c?.mediaId) return c.mediaId;
		}
	return null;
}

const PrefsArgs = z.object({ page: z.string().optional() }).optional();

export const processCommands: UiCommand[] = [
	{
		id: 'process.processClip',
		label: 'Process Clip…',
		description:
			'Creates a processed version (deblock, denoise, stabilize, de-judder, upscale) of the selected clip’s media as an engine job.',
		scope: 'editing',
		capability: 'engine',
		when: (ctx) =>
			!!ctx.session && !ctx.session.getState().readOnly && (!!clipTargets(ctx) || !!selectedVideoMedia(ctx)),
		disabledReason: (ctx) =>
			!ctx.session
				? 'Open a project first'
				: 'Select a video clip in the timeline or a video in the Project panel',
		run: (ctx) => {
			const session = ctx.session;
			if (!session) return;
			const t = clipTargets(ctx);
			if (t) openProcessForClips(session, t.clipIds);
			else {
				const m = selectedVideoMedia(ctx);
				if (m) openProcessForMedia(session, m);
			}
		},
	},
	{
		id: 'process.useOriginal',
		label: 'Use Original Version',
		description:
			'Switches the selected clips from a processed version back to the original media (Motion compensated).',
		scope: 'editing',
		when: (ctx) => !!processedSelection(ctx),
		run: (ctx) => {
			const sel = processedSelection(ctx);
			if (!sel || !ctx.session) return;
			void switchMediaVersionInteractive(ctx.session, sel.clipIds, sel.original).then((r) => {
				if (r && !r.ok)
					ctx.ui.toast({ kind: 'warning', message: 'Could not switch the version', detail: r.message });
			});
		},
	},
	{
		id: 'media.replaceFootage',
		label: 'Replace Footage…',
		description:
			'Replaces the file of the selected media for every clip that uses it, keeping the clips on the same source frames when the files carry a source-range sidecar or timecode.',
		scope: 'editing',
		capability: 'engine',
		when: (ctx) => {
			const m = replaceTarget(ctx);
			return (
				!!ctx.session &&
				!ctx.session.getState().readOnly &&
				!!m &&
				!replaceFootageBlocker(ctx.session.getState().document, m)
			);
		},
		disabledReason: (ctx) => {
			if (!ctx.session) return 'Open a project first';
			const m = replaceTarget(ctx);
			return m
				? (replaceFootageBlocker(ctx.session.getState().document, m) ?? 'Read-only project')
				: 'Select a media item or clip';
		},
		run: (ctx) => {
			const m = replaceTarget(ctx);
			if (m && ctx.session) openReplaceFootage(ctx.session, m);
		},
	},
	{
		id: 'app.preferences',
		label: 'Preferences…',
		description: 'Opens Edit ▸ Preferences (General, Processing, …).',
		scope: 'global',
		argsSchema: PrefsArgs,
		run: (ctx, args) => {
			registerPreferencesDialog();
			const page = (args as z.infer<typeof PrefsArgs>)?.page;
			// M3 (wp-m3-transdefaults): pages with project-scoped settings read the open session.
			ctx.ui.openDialog(PREFERENCES_DIALOG, { ...(page ? { page } : {}), session: ctx.session ?? null });
		},
	},
	{
		id: 'process.preferences',
		label: 'Processing Preferences…',
		description: 'Remote executor (SSH), local CPU slots and super-resolution models.',
		scope: 'global',
		run: (ctx) => {
			registerPreferencesDialog();
			ctx.ui.openDialog(PREFERENCES_DIALOG, { page: 'processing', session: ctx.session ?? null });
		},
	},
];
