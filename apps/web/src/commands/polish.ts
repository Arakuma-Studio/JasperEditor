import type { Clip } from '@jasper/project';
import { t } from '../i18n/runtime.ts';
import { getCustomBins } from '../panels/effects/presets/custom-bins.ts';
import { getMediaBrowser } from '../panels/mediaBrowser/instances.ts';
import {
	MEDIA_PROPERTIES_DIALOG,
	registerMediaPropertiesDialog,
} from '../panels/project/MediaPropertiesDialog.tsx';
import {
	clearPosterFrames,
	posterHover,
	selectedPosterItems,
	setPosterFromHover,
} from '../panels/project/poster-frame.ts';
import { revealSection } from '../panels/properties/controls/Section.tsx';
import { saveBeforeLeaving } from '../runtime/save.ts';
import { ENGINE_DIALOGS, registerEngineDialogs } from '../shell/engine-dialogs.tsx';
import { selectedMediaIds } from './gaps.ts';
import type { CommandCtx, UiCommand } from './types.ts';

const editable = (ctx: CommandCtx) => !!ctx.session && !ctx.session.getState().readOnly;

/** The section of the Properties panel that holds a motion-graphic clip's template parameters. */
const MG_PARAMETERS_SECTION = 'properties.template';

/** Motion-graphic clips of the timeline selection (the active sequence). */
export function selectedMotionGraphics(ctx: CommandCtx): string[] {
	const state = ctx.session?.store.getState();
	const seq = state?.activeSequenceId ? state.document.sequences[state.activeSequenceId] : undefined;
	if (!state || !seq) return [];
	return state.selection.timeline.clips.filter(
		(id) => (seq.clips[id] as Clip | undefined)?.kind === 'motion-graphic',
	);
}

const withBrowser = (fn: (b: NonNullable<ReturnType<typeof getMediaBrowser>>) => void) => (): void => {
	const b = getMediaBrowser();
	if (b) fn(b);
};

export const polishCommands: UiCommand[] = [
	{
		id: 'project.importFromMediaBrowser',
		label: 'Import from Media Browser',
		description:
			'Imports the files selected in the Media Browser into the current bin; opens the Media Browser when nothing is selected.',
		icon: 'panel.mediaBrowser',
		scope: 'global',
		capability: 'engine',
		when: editable,
		disabledReason: (ctx) => (ctx.session ? 'The project is open read-only' : 'Open a project first'),
		agentExposed: true,
		run: async (ctx) => {
			const browser = getMediaBrowser();
			if (browser?.selectedFiles().length) {
				await browser.importSelected();
				return;
			}
			ctx.services.get('shell')?.focusPanel('mediaBrowser');
			ctx.ui.toast({
				kind: 'info',
				message: 'Select files in the Media Browser, then import them',
				detail: 'Double-click a file, press Enter, or drag it onto the Project panel or the Timeline.',
			});
		},
	},
	{
		id: 'mediaBrowser.up',
		label: 'Go Up',
		scope: 'mediaBrowser',
		when: () => !!getMediaBrowser(),
		run: withBrowser((b) => b.goUp()),
	},
	{
		id: 'mediaBrowser.refresh',
		label: 'Refresh',
		scope: 'mediaBrowser',
		when: () => !!getMediaBrowser(),
		run: withBrowser((b) => b.refresh()),
	},
	{
		id: 'mediaBrowser.toggleAllFiles',
		label: 'Show All Files',
		description: 'Also lists hidden files and files JasperEditor cannot import.',
		scope: 'mediaBrowser',
		when: () => !!getMediaBrowser(),
		checked: () => !!getMediaBrowser()?.showsAllFiles(),
		run: withBrowser((b) => b.toggleAllFiles()),
	},
	{
		id: 'engine.status',
		label: 'Engine Status',
		description:
			'Shows the engine this window uses: version, FFmpeg build, encoders, render paths and features.',
		icon: 'app.engine',
		scope: 'global',
		agentExposed: true,
		run: (ctx) => {
			registerEngineDialogs();
			ctx.ui.openDialog(ENGINE_DIALOGS.status, { engine: ctx.engine });
		},
	},
	{
		id: 'engine.connect',
		label: 'Connect to Engine…',
		description: 'Reconnects to the engine, or opens the editor of another engine by its address.',
		icon: 'app.engine',
		scope: 'global',
		run: (ctx) => {
			registerEngineDialogs();
			const session = ctx.session;
			ctx.ui.openDialog(ENGINE_DIALOGS.connect, {
				engine: ctx.engine,
				beforeLeave: async () => {
					if (session) await saveBeforeLeaving(session);
				},
			});
		},
	},
	{
		id: 'mg.editParameters',
		label: 'Edit Parameters…',
		description:
			'Shows the template parameters of the selected motion-graphic clips in the Properties panel.',
		icon: 'panel.properties',
		scope: 'editing',
		agentExposed: true,
		when: (ctx) => selectedMotionGraphics(ctx).length > 0,
		disabledReason: () => 'Select a motion-graphic clip in the Timeline',
		run: (ctx) => {
			if (!selectedMotionGraphics(ctx).length) return;
			ctx.services.get('shell')?.focusPanel('properties');
			revealSection(MG_PARAMETERS_SECTION);
			// Put the caret in the first parameter once the section is on screen.
			if (typeof document === 'undefined') return;
			const focusFirst = (tries: number) => {
				// The retries outlive the command: the page (or a test environment) may be gone by then.
				if (typeof document === 'undefined') return;
				const field = document.querySelector<HTMLElement>(
					`[data-section="${MG_PARAMETERS_SECTION}"] input, [data-section="${MG_PARAMETERS_SECTION}"] [role="spinbutton"], [data-section="${MG_PARAMETERS_SECTION}"] button[role="combobox"]`,
				);
				if (field) field.focus({ preventScroll: false });
				else if (tries > 0) setTimeout(() => focusFirst(tries - 1), 50);
			};
			setTimeout(() => focusFirst(10), 0);
		},
	},
	{
		id: 'project.mediaProperties',
		label: 'Get Properties for Selection…',
		description:
			'Shows the file path, type, size, picture and sound format and duration of the selected media (Project panel items or timeline clips).',
		icon: 'panel.info',
		scope: 'global',
		agentExposed: true,
		when: (ctx) => selectedMediaIds(ctx).length > 0,
		disabledReason: () => 'Select media in the Project panel or a clip in the Timeline',
		run: (ctx) => {
			if (!ctx.session) return;
			const mediaIds = selectedMediaIds(ctx).slice(0, 20);
			if (!mediaIds.length) return;
			registerMediaPropertiesDialog();
			ctx.ui.openDialog(MEDIA_PROPERTIES_DIALOG, { session: ctx.session, engine: ctx.engine, mediaIds });
		},
	},
	{
		id: 'project.setPosterFrame',
		label: 'Set Poster Frame',
		description:
			'Makes the frame shown while hover-scrubbing a thumbnail in the Project panel (Icon View) the poster frame of that item.',
		icon: 'project.posterFrame',
		scope: 'project',
		when: editable,
		run: (ctx) => {
			if (!ctx.session) return;
			if (!setPosterFromHover(ctx.session))
				ctx.ui.toast({
					kind: 'info',
					message: 'Hover over a clip thumbnail to choose its poster frame',
					detail:
						'In the Project panel’s Icon View, move the pointer across a thumbnail to the frame you want.',
				});
		},
	},
	{
		id: 'project.clearPosterFrame',
		label: 'Clear Poster Frame',
		description: 'Shows the default thumbnail again for the hovered or selected items.',
		icon: 'project.posterFrame',
		scope: 'project',
		when: (ctx) => {
			if (!editable(ctx) || !ctx.session) return false;
			const hover = posterHover();
			const item = hover ? ctx.session.getCommitted().items[hover.itemId] : undefined;
			return selectedPosterItems(ctx.session).length > 0 || !!(item && 'poster' in item && item.poster);
		},
		disabledReason: () => 'Select an item that has a poster frame',
		run: (ctx) => {
			if (ctx.session) clearPosterFrames(ctx.session);
		},
	},
	{
		id: 'effects.newCustomBin',
		label: 'New Custom Bin',
		description: 'Creates a bin for your effect presets (inside the picked bin, else under Presets).',
		icon: 'project.newBin',
		scope: 'effects',
		when: () => !!getCustomBins(),
		run: (ctx) => {
			if (getCustomBins()?.newBin() === false)
				ctx.ui.toast({ kind: 'warning', message: 'Your presets need the engine' });
		},
	},
	{
		id: 'effects.deleteCustomItem',
		label: 'Delete Custom Item',
		description: 'Deletes the picked preset or preset bin of yours (built-in ones cannot be deleted).',
		scope: 'effects',
		when: () => !!getCustomBins()?.focusedCustomItem(),
		labelFor: () => {
			const item = getCustomBins()?.focusedCustomItem();
			if (!item) return t('Delete Custom Item');
			return item.kind === 'bin' ? t('Delete Custom Bin') : t('Delete Custom Preset');
		},
		disabledReason: () => 'Pick one of your presets or preset bins in the Effects panel',
		run: () => {
			getCustomBins()?.deleteFocused();
		},
	},
	{
		id: 'app.notices',
		label: 'Third-Party Notices',
		description:
			'Licences of FFmpeg, the packages in this build and the source code ported from other projects.',
		scope: 'global',
		run: (ctx) => {
			registerEngineDialogs();
			ctx.ui.openDialog(ENGINE_DIALOGS.notices, {});
		},
	},
];
