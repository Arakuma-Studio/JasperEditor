// app UI commands — owned by WP-2A: save, workspaces, panel focus/maximize/close, command palette,
// themes, full screen, modes, Home. Commands drive the shell through the `shell` panel service
// (apps/web/src/shell/context.tsx). Keymap ids from keymap-defaults.ts that differ from the canonical ids
// (app.save, app.commandPalette, panel.open.*, workspace.switch.N…) are registered as hidden aliases.
import { z } from 'zod';
import { PANEL_KINDS, type PanelKind } from '../panels/types.ts';
import { saveNow } from '../runtime/save.ts';
import type { ShellController } from '../shell/context.tsx';
import { DIALOGS } from '../shell/dialogs.tsx';
import { focusStore } from '../shell/focus.ts';
import { prefsStore } from '../shell/prefs.ts';
import type { CommandCtx, UiCommand } from './types.ts';

const hasShell = (ctx: CommandCtx) => !!ctx.services.get('shell');
const NO_SHELL = 'Open a project to use the editor workspace';

/** A shell-driven command: enabled only while the editor shell is mounted. */
function sc(
	id: string,
	label: string,
	run: (shell: ShellController, ctx: CommandCtx, args?: unknown) => void | Promise<void>,
	extra: Partial<UiCommand> = {},
): UiCommand {
	return {
		id,
		label,
		scope: 'global',
		...extra,
		when: (ctx) => hasShell(ctx) && (extra.when ? extra.when(ctx) : true),
		disabledReason: (ctx) => (hasShell(ctx) ? extra.disabledReason?.(ctx) : NO_SHELL),
		run: (ctx, args) => {
			const shell = ctx.services.get('shell');
			if (shell) return run(shell, ctx, args);
		},
	};
}

/** Hidden alias for a keymap id (keeps menus/palette on the canonical id). */
function alias(id: string, target: UiCommand, extra: Partial<UiCommand> = {}): UiCommand {
	return { ...target, ...extra, id, hidden: true };
}

const PANEL_LABELS: Record<PanelKind, string> = {
	project: 'Project',
	source: 'Source Monitor',
	program: 'Program Monitor',
	timeline: 'Timeline',
	tools: 'Tools',
	effectControls: 'Effect Controls',
	effects: 'Effects',
	properties: 'Properties',
	motionTemplates: 'Motion Templates',
	audioMeters: 'Audio Meters',
	history: 'History',
	info: 'Info',
	markers: 'Markers',
	jobs: 'Jobs',
	lumetri: 'Lumetri Color',
	scopes: 'Lumetri Scopes',
	audioTrackMixer: 'Audio Track Mixer',
	audioClipMixer: 'Audio Clip Mixer',
	text: 'Text',
	essentialSound: 'Essential Sound',
};

// ------------------------------------------------------------------ save

const save: UiCommand = {
	id: 'file.save',
	label: 'Save',
	scope: 'global',
	agentExposed: true,
	when: (ctx) => !!ctx.session && !ctx.session.getState().readOnly,
	disabledReason: (ctx) => (!ctx.session ? 'Open a project first' : 'The project is open read-only'),
	run: async (ctx) => {
		if (!ctx.session) return;
		const r = await saveNow(ctx.session);
		switch (r) {
			case 'saved':
				ctx.ui.toast({ kind: 'success', message: 'Project saved' });
				break;
			case 'unchanged':
				ctx.ui.toast({ kind: 'info', message: 'All changes are already saved' });
				break;
			case 'no-store':
				ctx.ui.toast({ kind: 'info', message: 'This project has no store to save to' });
				break;
			case 'read-only':
				ctx.ui.toast({ kind: 'warning', message: 'The project is open read-only' });
				break;
			case 'conflict':
				ctx.ui.toast({
					kind: 'error',
					message: 'Save conflict',
					detail: 'The project changed elsewhere. Reopen it to continue.',
				});
				break;
			default:
				ctx.ui.toast({
					kind: 'error',
					message: 'Save failed',
					detail: 'Check that the engine is running and try again.',
				});
		}
	},
};

// ------------------------------------------------------------------ panels

const focusPanels: UiCommand[] = PANEL_KINDS.map((kind) =>
	sc(`panel.focus.${kind}`, `Open ${PANEL_LABELS[kind]} Panel`, (shell) => shell.focusPanel(kind), {
		checked: (ctx) => !!ctx.services.get('shell')?.isPanelOpen(kind),
		agentExposed: true,
	}),
);
const byId = new Map(focusPanels.map((c) => [c.id, c]));
// `panel.open.<kind>` for every kind: the keymap binds some, and other packages call e.g. `panel.open.jobs`
// (Export mode) and `panel.open.motionTemplates` (Project panel ▸ New Item ▸ Motion Graphic).
const openAliases: UiCommand[] = PANEL_KINDS.map((kind) =>
	alias(`panel.open.${kind}`, byId.get(`panel.focus.${kind}`)!),
);

const maximizeFocused = sc(
	'panel.maximize',
	'Maximize Panel Group',
	(shell) => void shell.toggleMaximize('focused'),
	{
		checked: (ctx) => !!ctx.services.get('shell')?.isMaximized(),
	},
);
const maximizePointer = sc(
	'workspace.maximizeUnderCursor',
	'Maximize Panel Group Under Pointer',
	(shell) => void shell.toggleMaximize('pointer'),
	{
		checked: (ctx) => !!ctx.services.get('shell')?.isMaximized(),
	},
);
const closePanel = sc('panel.close', 'Close Panel', (shell) => shell.closePanel(), {
	when: (ctx) => hasShell(ctx) && !!focusStore.getState().instanceId,
	disabledReason: (ctx) => (hasShell(ctx) ? 'No panel has focus' : NO_SHELL),
});
const floatPanel = sc('panel.float', 'Undock Panel', (shell) => shell.floatPanel(), {
	when: (ctx) => hasShell(ctx) && !!focusStore.getState().instanceId,
	disabledReason: (ctx) => (hasShell(ctx) ? 'No panel has focus' : NO_SHELL),
});

// ------------------------------------------------------------------ workspaces

const switchWorkspace = sc(
	'workspace.switch',
	'Switch Workspace',
	(shell, _ctx, args) => {
		const id = (args as { id?: string } | undefined)?.id;
		if (id) shell.switchWorkspace(id);
	},
	{ argsSchema: z.object({ id: z.string() }), agentExposed: true, hidden: true },
);
const switchByNumber: UiCommand[] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) =>
	sc(
		`workspace.switch.${n}`,
		`Workspace ${n}`,
		(shell) => {
			const id = shell.workspaces.byNumber(n);
			if (id) shell.switchWorkspace(id);
		},
		{ hidden: true },
	),
);
const resetWorkspace = sc('workspace.reset', 'Reset to Saved Layout', (shell) => shell.resetWorkspace());

// ------------------------------------------------------------------ view

const THEMES = ['darkest', 'dark'] as const;
const theme: UiCommand = {
	id: 'view.theme',
	label: 'Switch Theme',
	description: 'Darkest / Dark; pass {theme} to choose one (S05:DT-003)',
	scope: 'global',
	agentExposed: true,
	argsSchema: z.object({ theme: z.enum(THEMES).optional() }).optional(),
	run: (_ctx, args) => {
		const t = (args as { theme?: (typeof THEMES)[number] } | undefined)?.theme;
		prefsStore.set({ theme: t ?? (prefsStore.get().theme === 'darkest' ? 'dark' : 'darkest') });
	},
};
const themeCmd = (t: (typeof THEMES)[number], label: string): UiCommand => ({
	id: `view.theme.${t}`,
	label,
	scope: 'global',
	checked: () => prefsStore.get().theme === t,
	run: () => prefsStore.set({ theme: t }),
});
const prefToggle = (
	id: string,
	label: string,
	get: () => boolean,
	set: (on: boolean) => void,
): UiCommand => ({
	id,
	label,
	scope: 'global',
	checked: () => get(),
	run: () => set(!get()),
});

const layoutCmd = (id: string, label: string, mode: 'desktop' | 'compact' | null): UiCommand => ({
	id,
	label,
	scope: 'global',
	checked: () => prefsStore.get().layoutMode === mode,
	run: () => prefsStore.set({ layoutMode: mode }),
});

const modeCmd = (mode: 'import' | 'edit' | 'export', label: string) =>
	sc(`mode.${mode}`, label, (shell) => shell.setMode(mode), {
		checked: (ctx) => ctx.services.get('shell')?.getMode() === mode,
	});

// ------------------------------------------------------------------ the list

const paletteOpen = sc('palette.open', 'Command Palette', (shell) => shell.openPalette(), {
	icon: 'app.search',
});

export const appCommands: UiCommand[] = [
	save,
	alias('app.save', save),
	sc('app.goHome', 'Go to Home', (shell) => shell.goHome(), { icon: 'app.home' }),
	paletteOpen,
	alias('app.commandPalette', paletteOpen),
	sc('palette.findPanel', 'Find Panel…', (shell) => shell.openPalette('Open ')),
	...focusPanels,
	...openAliases,
	maximizeFocused,
	alias('workspace.maximizeActive', maximizeFocused),
	maximizePointer,
	closePanel,
	alias('app.closePanel', closePanel),
	floatPanel,
	sc('workspace.nextPanel', 'Focus Next Panel', (shell) => shell.cycleFocus(1)),
	sc('workspace.prevPanel', 'Focus Previous Panel', (shell) => shell.cycleFocus(-1)),
	switchWorkspace,
	...switchByNumber,
	resetWorkspace,
	alias('workspace.resetToSaved', resetWorkspace),
	sc('workspace.save', 'Save Changes to This Workspace', (shell) => shell.saveWorkspace()),
	sc('workspace.saveAs', 'Save as New Workspace…', (shell) => shell.saveWorkspaceAs()),
	sc('workspace.edit', 'Edit Workspaces…', (shell) => shell.editWorkspaces()),
	sc('workspace.import', 'Import Workspace…', (shell) => shell.importWorkspace()),
	sc('workspace.export', 'Export Workspace…', (shell) => shell.exportWorkspace()),
	sc('window.resetAllPanels', 'Reset All Panels', (shell) => {
		shell.workspaces.restoreFactory(shell.workspaces.getState().activeId);
		shell.resetWorkspace();
	}),
	theme,
	themeCmd('darkest', 'Darkest Theme'),
	themeCmd('dark', 'Dark Theme'),
	prefToggle(
		'view.contrast.high',
		'High Contrast',
		() => prefsStore.get().contrast === 'high',
		(on) => prefsStore.set({ contrast: on ? 'high' : 'normal' }),
	),
	prefToggle(
		'view.density.touch',
		'Touch Density',
		() => prefsStore.get().density === 'touch',
		(on) => prefsStore.set({ density: on ? 'touch' : 'normal' }),
	),
	prefToggle(
		'view.tooltips',
		'Show Tooltips',
		() => prefsStore.get().tooltips,
		(on) => prefsStore.set({ tooltips: on }),
	),
	layoutCmd('view.layout.auto', 'Automatic Layout', null),
	layoutCmd('view.layout.desktop', 'Desktop Layout', 'desktop'),
	layoutCmd('view.layout.compact', 'Compact Layout', 'compact'),
	sc('view.fullscreen', 'Full Screen', (shell) => shell.toggleFullscreen(), {
		checked: (ctx) => !!ctx.services.get('shell')?.isFullscreen(),
		icon: 'app.fullscreen',
	}),
	modeCmd('import', 'Import Mode'),
	modeCmd('edit', 'Edit Mode'),
	modeCmd('export', 'Export Mode'),
	sc(
		'app.shortcutReference',
		'Keyboard Shortcut Reference',
		(shell, ctx) =>
			void ctx.ui.openDialog(DIALOGS.shortcutReference, {
				scope: ctx.focus.panel,
				platform: shell.platform,
				runtime: shell.runtime,
			}),
	),
	{
		id: 'app.about',
		label: 'About JasperEditor',
		scope: 'global',
		run: (ctx) => ctx.ui.openDialog(DIALOGS.about, {}),
	},
	{
		id: 'app.cycleRegions',
		label: 'Cycle Window Regions',
		scope: 'global',
		hidden: true,
		run: () => {
			// F6: menubar/header → focused panel → toasts (S05:KB-010, A11Y-002).
			const regions = [
				document.querySelector<HTMLElement>('[data-menu-id]') ??
					document.querySelector<HTMLElement>('[data-testid="home-button"]'),
				document.querySelector<HTMLElement>(
					`[data-panel-body][data-panel-instance="${focusStore.getState().instanceId ?? ''}"]`,
				) ?? document.querySelector<HTMLElement>('[data-panel-body]'),
				document.querySelector<HTMLElement>('[data-testid="toast"]'),
			].filter((x): x is HTMLElement => !!x);
			if (!regions.length) return;
			const i = regions.findIndex((r) => r.contains(document.activeElement));
			regions[(i + 1) % regions.length]?.focus();
		},
	},
];
