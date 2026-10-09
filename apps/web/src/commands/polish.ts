// Workstream polish: the menu entries that were still unregistered (docs/wp-notes/polish.md).
//   project.importFromMediaBrowser  File ▸ Import from Media Browser (Ctrl+Alt+I): imports the files selected in
//                                   the Media Browser panel; with nothing selected it opens the panel
//   mediaBrowser.up / .refresh / .toggleAllFiles   the Media Browser panel menu
//   engine.connect / engine.status  File ▸ Engine ▸ Connect… / Engine Status
//   mg.editParameters               Clip ▸ Motion Graphic ▸ Edit Parameters…: Properties ▸ Parameters of the selected
//                                   motion-graphic clips (Premiere edits a template's parameters in Essential
//                                   Graphics ▸ Edit / the Properties panel, not in a dialog)
//   app.notices                     Help ▸ Third-Party Notices
import type { Clip } from '@jasper/project';
import { persistenceFor } from '@jasper/session';
import { getMediaBrowser } from '../panels/mediaBrowser/instances.ts';
import { revealSection } from '../panels/properties/controls/Section.tsx';
import { ENGINE_DIALOGS, registerEngineDialogs } from '../shell/engine-dialogs.tsx';
import type { CommandCtx, UiCommand } from './types.ts';

const editable = (ctx: CommandCtx) => !!ctx.session && !ctx.session.getState().readOnly;

/** The section of the Properties panel that holds a motion-graphic clip's template parameters. */
export const MG_PARAMETERS_SECTION = 'properties.template';

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
					if (session) await persistenceFor(session)?.flush();
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
