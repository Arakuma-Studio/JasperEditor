// Workstream `gaps` UI commands (docs/wp-notes/gaps.md): Edit ▸ Find…, Edit Original, File ▸ Exit, Clip ▸ Rename…,
// Sequence ▸ Add Tracks… / Delete Tracks…, track height presets. Later sections of this module register the other
// gaps dialogs (Project Settings, Sequence Settings, proxies, Project Manager, Export Frame, Audio Channels…).
import { linkedPartners, trackLabel } from '@jasper/project';
import { z } from 'zod';
import { projectItemMenuExtensions } from '../extensions/index.ts';
import {
	AUDIO_CHANNELS_DIALOG,
	type AudioChannelsTarget,
	registerAudioChannelsDialog,
	routingOf,
} from '../gaps/AudioChannelsDialog.tsx';
import { labelDefault } from '../gaps/app-prefs.ts';
import {
	EXPORT_FRAME_DIALOG,
	type FrameSource,
	registerExportFrameDialog,
} from '../gaps/ExportFrameDialog.tsx';
import { FIND_DIALOG, type FindScope, registerFindDialog } from '../gaps/FindDialog.tsx';
import { registerGapsPreferencePages } from '../gaps/PreferencePages.tsx';
import { PROJECT_SETTINGS_DIALOG, registerProjectSettingsDialog } from '../gaps/ProjectSettingsDialog.tsx';
import {
	ATTACH_PROXIES_DIALOG,
	CREATE_PROXIES_DIALOG,
	RECONNECT_FULL_RES_DIALOG,
	registerProxyDialogs,
} from '../gaps/ProxyDialogs.tsx';
import { registerSequenceSettingsDialog, SEQUENCE_SETTINGS_DIALOG } from '../gaps/SequenceSettingsDialog.tsx';
import {
	askExit,
	MANAGE_HEIGHT_PRESETS_DIALOG,
	promptName,
	registerSmallDialogs,
} from '../gaps/SmallDialogs.tsx';
import { ADD_TRACKS_DIALOG, DELETE_TRACKS_DIALOG, registerTrackDialogs } from '../gaps/TrackDialogs.tsx';
import { presetHeights, trackHeightPresets } from '../gaps/track-heights.ts';
import { mediaKeyOf } from '../import/assets.ts';
import { getSourceTransport } from '../panels/program/transport-registry.ts';
import { sourceMonitorState } from '../panels/source/source-state.ts';
import { trackHeight } from '../panels/timeline/model/layout.ts';
import { detectRuntime, getDesktopBridge } from '../runtime/platform.ts';
import { saveNow, setSkipUnloadFlush } from '../runtime/save.ts';
import { runCommand } from './registry.ts';
import { apply, envOf, seekReveal, selectedClips } from './timeline.ts';
import type { CommandCtx, UiCommand } from './types.ts';

registerGapsPreferencePages();

// gaps: Project panel item context menu — New Sequence From Clip and the Proxy submenu (Premiere's).
projectItemMenuExtensions.register({
	id: 'gaps.items',
	order: 6,
	items: ({ items, readOnly, runCommand: run }) => {
		if (!run || !items.length) return [];
		const one = items.length === 1 && items[0]!.kind === 'media';
		const media = items.some((i) => i.kind === 'media' || i.kind === 'subclip');
		return [
			...(one
				? [
						{
							kind: 'item' as const,
							label: 'New Sequence From Clip',
							disabled: readOnly,
							run: () => run('project.newSequenceFromClip', undefined),
						},
					]
				: []),
			...(media
				? [
						{
							kind: 'submenu' as const,
							label: 'Proxy',
							items: [
								{
									kind: 'item' as const,
									label: 'Create Proxies…',
									disabled: readOnly,
									run: () => run('project.createProxies', undefined),
								},
								{
									kind: 'item' as const,
									label: 'Attach Proxies…',
									disabled: readOnly,
									run: () => run('project.attachProxies', undefined),
								},
								{
									kind: 'item' as const,
									label: 'Reconnect Full Resolution Media…',
									disabled: readOnly,
									run: () => run('project.reconnectFullRes', undefined),
								},
								{
									kind: 'item' as const,
									label: 'Detach Proxies',
									disabled: readOnly,
									run: () => run('project.detachProxies', undefined),
								},
							],
						},
						{ kind: 'item' as const, label: 'Edit Original', run: () => run('edit.editOriginal', undefined) },
					]
				: []),
		];
	},
});

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

// ---------------------------------------------------------------- File ▸ Project Settings… (PRJ-4)

const projectSettings: UiCommand = {
	id: 'project.settings',
	label: 'Project Settings…',
	description: 'General (renderers, display formats), Scratch Disks and Ingest Settings of the open project.',
	scope: 'global',
	agentExposed: true,
	argsSchema: z.object({ tab: z.enum(['general', 'scratch', 'ingest']).optional() }).optional(),
	when: hasSession,
	disabledReason: () => 'Open a project first',
	run: (ctx, args) => {
		if (!ctx.session) return;
		registerProjectSettingsDialog();
		ctx.ui.openDialog(PROJECT_SETTINGS_DIALOG, {
			session: ctx.session,
			engine: ctx.engine,
			...((args as { tab?: string } | undefined)?.tab ? { initialTab: (args as { tab: string }).tab } : {}),
			openPreferences: (page: string) => void runCommand('app.preferences', ctx, { page }),
		});
	},
};

// ---------------------------------------------------------------- Clip ▸ Proxy (PRJ-8)

/** Media of the selection (Project panel items first, else the selected timeline clips), in order, unique. */
export function selectedMediaIds(ctx: CommandCtx): string[] {
	const session = ctx.session;
	if (!session) return [];
	const doc = session.getCommitted();
	const st = session.getState();
	const out: string[] = [];
	const add = (id: string | undefined) => {
		if (id && doc.media[id] && !out.includes(id)) out.push(id);
	};
	const timelineFirst = ctx.focus.panel === 'timeline' || ctx.focus.panel === 'program';
	const fromProject = () => {
		for (const id of st.selection.project.items) {
			const it = doc.items[id];
			if (it && (it.kind === 'media' || it.kind === 'subclip')) add(it.mediaId);
		}
	};
	const fromTimeline = () => {
		const e = envOf(ctx);
		if (e) for (const c of selectedClips(e)) add((c as { mediaId?: string }).mediaId);
	};
	if (timelineFirst) {
		fromTimeline();
		if (!out.length) fromProject();
	} else {
		fromProject();
		if (!out.length) fromTimeline();
	}
	return out;
}

const videoSelected = (ctx: CommandCtx) =>
	selectedMediaIds(ctx).some((id) => ctx.session?.getCommitted().media[id]?.kind === 'video');

const proxyDialog = (id: string, label: string, kind: string, description: string): UiCommand => ({
	id,
	label,
	description,
	scope: 'global',
	agentExposed: true,
	when: videoSelected,
	disabledReason: () => 'Select video clips or Project panel items',
	run: (ctx) => {
		if (!ctx.session) return;
		registerProxyDialogs();
		ctx.ui.openDialog(kind, {
			session: ctx.session,
			engine: ctx.engine,
			mediaIds: selectedMediaIds(ctx),
			localEngine: ctx.capabilities.has('nativeFfmpeg'),
		});
	},
});

const detachProxies: UiCommand = {
	id: 'project.detachProxies',
	label: 'Detach Proxies',
	scope: 'global',
	agentExposed: true,
	when: (ctx) => selectedMediaIds(ctx).some((id) => !!ctx.session?.getCommitted().media[id]?.proxy),
	disabledReason: () => 'Select clips with attached proxies',
	run: (ctx) => {
		const ids = selectedMediaIds(ctx).filter((id) => !!ctx.session?.getCommitted().media[id]?.proxy);
		if (!ctx.session || !ids.length) return;
		const r = ctx.session.apply({
			label: 'Detach Proxies',
			origin: 'user',
			commands: [{ type: 'media.detachProxy', mediaIds: ids }] as never[],
		});
		if (!r.ok)
			ctx.ui.toast({
				kind: 'warning',
				message: 'Detach Proxies: not possible',
				detail: r.errors[0]?.message,
			});
	},
};

const toggleProxies: UiCommand = {
	id: 'media.toggleProxies',
	label: 'Toggle Proxies',
	description: 'Play attached proxies in the monitors (exports always use the full-resolution media).',
	scope: 'global',
	agentExposed: true,
	when: hasSession,
	checked: (ctx) => !!ctx.session?.getState().toggles.attachedProxies,
	run: (ctx) => {
		const s = ctx.session;
		if (!s) return;
		const on = !s.getState().toggles.attachedProxies;
		s.setToggles({ attachedProxies: on });
		const attached = Object.values(s.getCommitted().media).filter((m) => !!m.proxy).length;
		ctx.ui.toast({
			kind: 'info',
			message: on ? 'Proxies on' : 'Proxies off',
			detail: on
				? `${attached} clip${attached === 1 ? '' : 's'} with attached proxies`
				: 'Full-resolution media',
			durationMs: 2000,
		});
	},
};

// ---------------------------------------------------------------- File ▸ Export ▸ Frame (EX-3)

/** The frame the focused monitor shows: the Source monitor's source, else the active sequence at the playhead. */
export function frameSourceFor(ctx: CommandCtx): { source: FrameSource; baseName: string } | null {
	const session = ctx.session;
	if (!session) return null;
	const doc = session.getCommitted();
	if (ctx.focus.panel === 'source') {
		const src = sourceMonitorState.getState();
		const it = src.itemId ? doc.items[src.itemId] : undefined;
		if (it)
			return {
				source: { kind: 'source', itemId: it.id, frame: getSourceTransport()?.getState().frame ?? 0 },
				baseName: it.name,
			};
	}
	const e = envOf(ctx);
	if (!e) return null;
	const item = Object.values(doc.items).find((i) => i.kind === 'sequence' && i.sequenceId === e.seq.id);
	return {
		source: { kind: 'sequence', sequenceId: e.seq.id, frame: e.playhead },
		baseName: item?.name ?? 'Sequence',
	};
}

const exportFrame: UiCommand = {
	id: 'export.frame',
	label: 'Export Frame…',
	description:
		'Export the frame the Program (or focused Source) monitor shows as PNG, JPEG, TIFF, DPX or OpenEXR.',
	icon: 'app.export',
	scope: 'global',
	agentExposed: true,
	capability: 'engine',
	when: (ctx) => !!frameSourceFor(ctx),
	disabledReason: () => 'Open a sequence or a source first',
	run: (ctx) => {
		const f = frameSourceFor(ctx);
		if (!f || !ctx.session) return;
		registerExportFrameDialog();
		ctx.ui.openDialog(EXPORT_FRAME_DIALOG, { session: ctx.session, engine: ctx.engine, ...f });
	},
};

// ---------------------------------------------------------------- Sequence ▸ Sequence Settings… (TL-11)

const sequenceSettings: UiCommand = {
	id: 'sequence.settings',
	label: 'Sequence Settings…',
	description:
		'Timebase, frame size, pixel aspect ratio, fields, audio sample rate and channels of the active sequence, with its Video Previews and working colour space.',
	scope: 'global',
	agentExposed: true,
	when: (ctx) => hasSeq(ctx) && !ctx.session?.getState().readOnly,
	disabledReason: () => 'Open a sequence',
	run: (ctx) => {
		const e = envOf(ctx);
		if (!e) return;
		registerSequenceSettingsDialog();
		ctx.ui.openDialog(SEQUENCE_SETTINGS_DIALOG, {
			session: e.session,
			sequenceId: e.seq.id,
			runCommand: (id: string) => void runCommand(id, ctx),
		});
	},
};

/** The media item of the selection for New Sequence From Clip (a picture or sound with a duration). */
function fromClipMedia(ctx: CommandCtx): { mediaId: string; name: string; binId: string | null } | null {
	const s = ctx.session;
	if (!s) return null;
	const st = s.getState();
	const doc = s.getCommitted();
	const id = st.selection.project.primary ?? st.selection.project.items[0];
	const it = id ? doc.items[id] : undefined;
	if (!it || it.kind !== 'media') return null;
	const a = doc.media[it.mediaId];
	if (!a || (a.kind !== 'video' && a.kind !== 'audio' && a.kind !== 'image' && a.kind !== 'animated-image'))
		return null;
	const bin = Object.values(doc.items).find((b) => b.kind === 'bin' && b.children.includes(it.id));
	return { mediaId: a.id, name: it.name, binId: bin?.id ?? null };
}

const newSequenceFromClip: UiCommand = {
	id: 'project.newSequenceFromClip',
	label: 'New Sequence From Clip',
	description:
		"A sequence matching the selected clip's frame size, rate, pixel aspect and fields, with the clip in it.",
	scope: 'global',
	agentExposed: true,
	when: (ctx) => !!fromClipMedia(ctx) && !ctx.session?.getState().readOnly,
	disabledReason: () => 'Select a media item in the Project panel',
	run: (ctx) => {
		const m = fromClipMedia(ctx);
		const s = ctx.session;
		if (!m || !s) return;
		const r = s.apply({
			label: 'New Sequence From Clip',
			origin: 'user',
			commands: [
				{ type: 'sequence.create', name: m.name, fromMediaId: m.mediaId, binId: m.binId },
			] as never[],
		});
		if (!r.ok) {
			ctx.ui.toast({
				kind: 'warning',
				message: 'New Sequence From Clip: not possible',
				detail: r.errors[0]?.message,
			});
			return;
		}
		const out = r.results[0] as { sequenceId?: string; itemId?: string } | undefined;
		if (out?.sequenceId) s.openSequence(out.sequenceId);
	},
};

// ---------------------------------------------------------------- Clip ▸ Modify ▸ Audio Channels… (AU-7)

/** What Audio Channels edits: the selected Project media items, else the selected timeline audio clips (+ linked). */
export function audioChannelsTarget(ctx: CommandCtx): AudioChannelsTarget | null {
	const s = ctx.session;
	if (!s) return null;
	const st = s.getState();
	const doc = s.getCommitted();
	const projectFirst = ctx.focus.panel === 'project';
	const items = st.selection.project.items.filter((id) => doc.items[id]?.kind === 'media');
	const fromItems = (): AudioChannelsTarget | null => {
		if (!items.length) return null;
		const t: AudioChannelsTarget = { kind: 'items', itemIds: items };
		return routingOf(s, t) ? t : null;
	};
	const fromClips = (): AudioChannelsTarget | null => {
		const e = envOf(ctx);
		if (!e) return null;
		const ids = new Set<string>();
		for (const c of selectedClips(e)) {
			if (c.kind === 'audio') ids.add(c.id);
			for (const p of linkedPartners(e.seq, c.id)) if (p.kind === 'audio') ids.add(p.id);
		}
		if (!ids.size) return null;
		const clipIds = [...ids].sort((a, b) => {
			const ta = e.seq.audioTracks.findIndex((t) => t.id === e.seq.clips[a]!.trackId);
			const tb = e.seq.audioTracks.findIndex((t) => t.id === e.seq.clips[b]!.trackId);
			return ta - tb;
		});
		const t: AudioChannelsTarget = { kind: 'clips', sequenceId: e.seq.id, clipIds };
		return routingOf(s, t) ? t : null;
	};
	return projectFirst ? (fromItems() ?? fromClips()) : (fromClips() ?? fromItems());
}

const audioChannels: UiCommand = {
	id: 'timeline.audioChannels',
	label: 'Audio Channels…',
	description:
		'Clip channel format, number of audio clips and the source channel matrix of the selected clips or items.',
	scope: 'global',
	agentExposed: true,
	when: (ctx) => !!audioChannelsTarget(ctx) && !ctx.session?.getState().readOnly,
	disabledReason: () => 'Select audio clips of one media (or a media item in the Project panel)',
	run: (ctx) => {
		const target = audioChannelsTarget(ctx);
		if (!ctx.session || !target) return;
		registerAudioChannelsDialog();
		ctx.ui.openDialog(AUDIO_CHANNELS_DIALOG, { session: ctx.session, target });
	},
};

gapsCommands.push(
	audioChannels,
	sequenceSettings,
	newSequenceFromClip,
	projectSettings,
	proxyDialog(
		'project.createProxies',
		'Create Proxies…',
		CREATE_PROXIES_DIALOG,
		'Transcode the selected video clips to smaller proxies in the background and attach them.',
	),
	proxyDialog(
		'project.attachProxies',
		'Attach Proxies…',
		ATTACH_PROXIES_DIALOG,
		'Attach existing files as the proxies of the selected video clips.',
	),
	proxyDialog(
		'project.reconnectFullRes',
		'Reconnect Full Resolution Media…',
		RECONNECT_FULL_RES_DIALOG,
		'Link the selected clips to their full-resolution files (the files they used become their proxies).',
	),
	detachProxies,
	toggleProxies,
	exportFrame,
);
