// Workstream `gaps` UI commands (docs/wp-notes/gaps.md): Edit ▸ Find…, Edit Original, File ▸ Exit, Clip ▸ Rename…,
// Sequence ▸ Add Tracks… / Delete Tracks…, track height presets. Later sections of this module register the other
// gaps dialogs (Project Settings, Sequence Settings, proxies, Project Manager, Export Frame, Audio Channels…).
import { trackLabel } from '@jasper/project';
import { z } from 'zod';
import { FIND_DIALOG, type FindScope, registerFindDialog } from '../gaps/FindDialog.tsx';
import {
	askExit,
	MANAGE_HEIGHT_PRESETS_DIALOG,
	promptName,
	registerSmallDialogs,
} from '../gaps/SmallDialogs.tsx';
import { ADD_TRACKS_DIALOG, DELETE_TRACKS_DIALOG, registerTrackDialogs } from '../gaps/TrackDialogs.tsx';
import { presetHeights, trackHeightPresets } from '../gaps/track-heights.ts';
import { mediaKeyOf } from '../import/assets.ts';
import { trackHeight } from '../panels/timeline/model/layout.ts';
import { detectRuntime, getDesktopBridge } from '../runtime/platform.ts';
import { saveNow, setSkipUnloadFlush } from '../runtime/save.ts';
import { apply, envOf, seekReveal, selectedClips } from './timeline.ts';
import type { CommandCtx, UiCommand } from './types.ts';

const hasSession = (ctx: CommandCtx) => !!ctx.session;
const hasSeq = (ctx: CommandCtx) => envOf(ctx) !== null;
const NO_SEQ = 'Open a sequence first';

// ---------------------------------------------------------------- Edit ▸ Find…

/** Where Find searches: the focused panel decides (Timeline / monitors → the sequence; otherwise the project). */
export function findScopeFor(ctx: CommandCtx): FindScope {
	const p = ctx.focus.panel;
	return p === 'timeline' || p === 'program' ? 'timeline' : 'project';
}

const find: UiCommand = {
	id: 'edit.find',
	label: 'Find…',
	description:
		'Find items in the Project panel, or clips and markers in the sequence when the Timeline has focus.',
	scope: 'global',
	agentExposed: true,
	argsSchema: z.object({ scope: z.enum(['project', 'timeline']).optional() }).optional(),
	when: hasSession,
	disabledReason: () => 'Open a project first',
	run: (ctx, args) => {
		const session = ctx.session;
		if (!session) return;
		registerFindDialog();
		const scope = (args as { scope?: FindScope } | undefined)?.scope ?? findScopeFor(ctx);
		const e = envOf(ctx);
		if (scope === 'timeline' && !e) {
			ctx.ui.toast({ kind: 'info', message: 'Open a sequence to find in it' });
			return;
		}
		ctx.ui.openDialog(FIND_DIALOG, {
			session,
			scope,
			sequenceId: e?.seq.id ?? null,
			seek: (frame: number) => {
				const env = envOf(ctx);
				if (env) seekReveal(env, frame);
			},
		});
	},
};

// ---------------------------------------------------------------- Edit Original

/** The media of the selection: the primary Project panel item, else the first selected timeline clip. */
export function selectedMediaId(ctx: CommandCtx): string | null {
	const session = ctx.session;
	if (!session) return null;
	const doc = session.getCommitted();
	const st = session.getState();
	const fromItem = (id: string | null | undefined) => {
		const it = id ? doc.items[id] : undefined;
		return it && (it.kind === 'media' || it.kind === 'subclip') ? it.mediaId : null;
	};
	const projectFirst = ctx.focus.panel !== 'timeline' && ctx.focus.panel !== 'program';
	const item = fromItem(st.selection.project.primary) ?? fromItem(st.selection.project.items[0]);
	if (projectFirst && item) return item;
	const e = envOf(ctx);
	const clip = e
		? selectedClips(e).find((c) => typeof (c as { mediaId?: unknown }).mediaId === 'string')
		: undefined;
	return (clip as { mediaId?: string } | undefined)?.mediaId ?? item;
}

const editOriginal: UiCommand = {
	id: 'edit.editOriginal',
	label: 'Edit Original',
	description:
		'Open the selected media in its default application (desktop app), or show it in the file browser (web, local engine).',
	scope: 'global',
	agentExposed: true,
	when: (ctx) => !!selectedMediaId(ctx),
	disabledReason: () => 'Select a media clip or Project panel item',
	run: async (ctx) => {
		const mediaId = selectedMediaId(ctx);
		const asset = mediaId ? ctx.session?.getCommitted().media[mediaId] : undefined;
		const key = mediaKeyOf(asset);
		if (!asset || !key) {
			ctx.ui.toast({ kind: 'warning', message: 'Edit Original: the media has no file on the engine' });
			return;
		}
		try {
			const loc = await ctx.engine.call('mediaLocation', { params: { mediaKey: key } });
			if (!loc.exists || !loc.path) {
				ctx.ui.toast({
					kind: 'warning',
					message: 'Edit Original: the media is offline',
					detail: asset.originalName,
				});
				return;
			}
			const desktop = getDesktopBridge();
			if (desktop?.openPath) {
				const err = await desktop.openPath(loc.path);
				if (err) ctx.ui.toast({ kind: 'warning', message: 'Edit Original failed', detail: err });
				return;
			}
			if (!loc.canOpen) {
				ctx.ui.toast({ kind: 'info', message: 'The media file is on the engine host', detail: loc.path });
				return;
			}
			const r = await ctx.engine.call('mediaOpen', { params: { mediaKey: key }, body: { action: 'reveal' } });
			ctx.ui.toast({ kind: 'info', message: 'Shown in the file browser', detail: r.path });
		} catch (err) {
			ctx.ui.toast({
				kind: 'warning',
				message: 'Edit Original failed',
				detail: err instanceof Error ? err.message : String(err),
			});
		}
	},
};

// ---------------------------------------------------------------- File ▸ Exit

const quit: UiCommand = {
	id: 'app.quit',
	label: 'Exit',
	description: 'Quit the desktop app (asks to save unsaved changes first).',
	scope: 'global',
	when: () => detectRuntime() === 'desktop' && !!getDesktopBridge()?.quit,
	disabledReason: () => 'Available in the desktop app only (close the browser tab on the web)',
	run: async (ctx) => {
		const desktop = getDesktopBridge();
		if (!desktop?.quit) return;
		const session = ctx.session;
		if (session?.getState().dirty && !session.getState().readOnly) {
			const choice = await askExit(session.getState().document.name);
			if (choice === 'cancel') return;
			if (choice === 'save') {
				const r = await saveNow(session);
				if (r === 'error' || r === 'conflict') {
					ctx.ui.toast({
						kind: 'error',
						message: 'Not quitting: the project could not be saved',
						detail: 'Fix the problem (or choose Don’t Save) and try again.',
					});
					return;
				}
			} else setSkipUnloadFlush(true);
		}
		desktop.quit();
	},
};

// ---------------------------------------------------------------- Clip ▸ Rename…

const renameClip: UiCommand = {
	id: 'timeline.rename',
	label: 'Rename…',
	description: 'Rename the selected timeline clip (Premiere Clip ▸ Rename…).',
	scope: 'editing',
	agentExposed: true,
	argsSchema: z.object({ name: z.string().min(1).max(200) }).optional(),
	when: (ctx) => {
		const e = envOf(ctx);
		return !!e && selectedClips(e).length > 0;
	},
	disabledReason: () => 'Select a clip in the Timeline',
	run: async (ctx, args) => {
		const e = envOf(ctx);
		if (!e) return;
		const clips = selectedClips(e);
		if (!clips.length) return;
		const given = (args as { name?: string } | undefined)?.name;
		const name =
			given ??
			(await promptName({
				title: clips.length > 1 ? `Rename ${clips.length} Clips` : 'Rename Clip',
				label: 'Clip Name',
				initial: clips[0]!.name,
				maxLength: 200,
			}));
		if (!name) return;
		apply(ctx, e, 'Rename Clip', [{ type: 'clip.update', clipIds: clips.map((c) => c.id), patch: { name } }]);
	},
};

// ---------------------------------------------------------------- Sequence ▸ Add Tracks… / Delete Tracks…

const trackDialog = (id: string, label: string, kind: string): UiCommand => ({
	id,
	label,
	scope: 'global',
	agentExposed: true,
	when: hasSeq,
	disabledReason: () => NO_SEQ,
	run: (ctx) => {
		const e = envOf(ctx);
		if (!e) return;
		registerTrackDialogs();
		ctx.ui.openDialog(kind, { session: e.session, sequenceId: e.seq.id });
	},
});

// ---------------------------------------------------------------- track heights

function currentHeights(ctx: CommandCtx) {
	const e = envOf(ctx);
	if (!e) return null;
	return {
		e,
		video: e.seq.videoTracks.map((t) => trackHeight(e.view.trackHeights, t.id, 'video')),
		audio: e.seq.audioTracks.map((t) => trackHeight(e.view.trackHeights, t.id, 'audio')),
	};
}

export function applyHeightPreset(ctx: CommandCtx, index: number): boolean {
	const e = envOf(ctx);
	const p = trackHeightPresets.list()[index];
	if (!e || !p) return false;
	e.session.setView(e.seq.id, { trackHeights: presetHeights(p, e.seq, e.view.trackHeights) });
	return true;
}

const savePreset: UiCommand = {
	id: 'timeline.saveTrackHeightPreset',
	label: 'Save Track Height Preset…',
	scope: 'global',
	when: hasSeq,
	disabledReason: () => NO_SEQ,
	run: async (ctx) => {
		const h = currentHeights(ctx);
		if (!h) return;
		const name = await promptName({
			title: 'Save Track Height Preset',
			label: 'Preset Name',
			initial: `Preset ${trackHeightPresets.list().length + 1}`,
			maxLength: 60,
		});
		if (!name) return;
		trackHeightPresets.save(name, h.video, h.audio);
		ctx.ui.toast({ kind: 'success', message: `Track heights saved as “${name}”` });
	},
};

const managePresets: UiCommand = {
	id: 'timeline.manageTrackHeightPresets',
	label: 'Manage Track Height Presets…',
	scope: 'global',
	run: (ctx) => {
		registerSmallDialogs();
		ctx.ui.openDialog(MANAGE_HEIGHT_PRESETS_DIALOG, {
			onApply: (id: string) => {
				const i = trackHeightPresets.list().findIndex((p) => p.id === id);
				if (i >= 0) applyHeightPreset(ctx, i);
			},
		});
	},
};

/** Track Height Preset 1…5 (unbound by default; assignable in Keyboard Shortcuts, as Premiere's presets). */
const presetSlots: UiCommand[] = [1, 2, 3, 4, 5].map((n) => ({
	id: `timeline.trackHeightPreset.${n}`,
	label: `Track Height Preset ${n}`,
	scope: 'global' as const,
	labelFor: () => {
		const p = trackHeightPresets.list()[n - 1];
		return p ? `Track Height Preset ${n}: ${p.name}` : `Track Height Preset ${n}`;
	},
	when: (ctx: CommandCtx) => hasSeq(ctx) && !!trackHeightPresets.list()[n - 1],
	disabledReason: () => `Save at least ${n} track height preset${n === 1 ? '' : 's'} first`,
	run: (ctx: CommandCtx) => void applyHeightPreset(ctx, n - 1),
}));

const applyPresetByArgs: UiCommand = {
	id: 'timeline.applyTrackHeightPreset',
	label: 'Apply Track Height Preset',
	scope: 'global',
	hidden: true,
	agentExposed: true,
	argsSchema: z.object({ index: z.number().int().min(0).max(19) }),
	when: hasSeq,
	run: (ctx, args) => {
		const i = (args as { index?: number } | undefined)?.index ?? 0;
		if (!applyHeightPreset(ctx, i)) ctx.ui.toast({ kind: 'info', message: 'No such track height preset' });
	},
};

/** Track header ▸ Track Height ▸ size (one track) — `args.trackId`, `args.px`. */
const setTrackHeight: UiCommand = {
	id: 'timeline.setTrackHeight',
	label: 'Set Track Height',
	scope: 'global',
	hidden: true,
	agentExposed: true,
	argsSchema: z.object({ trackId: z.string(), px: z.number().min(20).max(240) }),
	when: hasSeq,
	run: (ctx, args) => {
		const e = envOf(ctx);
		const a = args as { trackId?: string; px?: number } | undefined;
		if (!e || !a?.trackId || typeof a.px !== 'number') return;
		const t = [...e.seq.videoTracks, ...e.seq.audioTracks].find(
			(x) => x.id === a.trackId || trackLabel(e.seq, x.id) === a.trackId,
		);
		if (!t) return;
		e.session.setView(e.seq.id, { trackHeights: { ...e.view.trackHeights, [t.id]: Math.round(a.px) } });
	},
};

export const gapsCommands: UiCommand[] = [
	find,
	editOriginal,
	quit,
	renameClip,
	trackDialog('timeline.addTracks', 'Add Tracks…', ADD_TRACKS_DIALOG),
	trackDialog('timeline.deleteTracks', 'Delete Tracks…', DELETE_TRACKS_DIALOG),
	savePreset,
	managePresets,
	...presetSlots,
	applyPresetByArgs,
	setTrackHeight,
];
