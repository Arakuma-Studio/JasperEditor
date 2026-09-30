// project UI commands — owned by WP-2E (S05:PRJ-002/003, KB-010; S01 §5). Ids match keymap-defaults.ts.
// Panel-view commands act on the focused Project panel instance (else the most recently used one).
import type { EditorSession } from '@jasper/session';
import { pickFilesInBrowser } from '../import/desktop.ts';
import { EngineImportService } from '../import/service.ts';
import { createBin, deleteItems } from '../panels/project/actions.ts';
import { projectDialogs } from '../panels/project/dialogs.tsx';
import { activeProjectBin, getProjectPanel, type ProjectPanelHandle } from '../panels/project/instances.ts';
import { getImportService } from '../state/services.ts';
import type { CommandCtx, UiCommand } from './types.ts';

const editable = (ctx: CommandCtx) => !!ctx.session && !ctx.session.getState().readOnly;
const panel = (ctx: CommandCtx): ProjectPanelHandle | null =>
	getProjectPanel(ctx.focus.panel === 'project' ? ctx.focus.instanceId : null);
const withPanel = (fn: (p: ProjectPanelHandle) => void) => (ctx: CommandCtx) => {
	const p = panel(ctx);
	if (p) fn(p);
};
const hasPanel = (ctx: CommandCtx) => !!panel(ctx);

/** File ▸ Import (Ctrl+I): native dialog on desktop (paths), browser file picker on web (uploads). */
export async function runImport(ctx: CommandCtx, session: EditorSession): Promise<void> {
	const service =
		(getImportService() as EngineImportService | null) ??
		new EngineImportService({ engine: ctx.engine, session });
	const binId = panel(ctx)?.getBinId() ?? activeProjectBin();
	const paths = service.isDesktop ? await service.pickDesktopPaths() : null;
	let result: Awaited<ReturnType<EngineImportService['importFiles']>> | null = null;
	if (paths) {
		if (paths.length) result = await service.importFiles({ paths }, { kind: 'bin', binId });
	} else {
		const files = await pickFilesInBrowser();
		if (files.length) result = await service.importFiles({ files }, { kind: 'bin', binId });
	}
	if (result?.mediaIds.length)
		ctx.ui.toast({ kind: 'success', message: service.describe(result, { kind: 'bin', binId }) });
}

const importCommand = (id: string): UiCommand => ({
	id,
	label: 'Import…',
	description: 'Import media files into the current bin',
	icon: 'app.import',
	scope: 'global',
	when: editable,
	run: (ctx) => (ctx.session ? runImport(ctx, ctx.session) : undefined),
	agentExposed: true,
});

export const projectCommands: UiCommand[] = [
	importCommand('project.import'),
	// Alias used by menus/briefs ("file.import"); the keymap binds project.import.
	importCommand('file.import'),
	{
		id: 'project.newBin',
		label: 'New Bin',
		icon: 'panel.project',
		scope: 'project',
		when: editable,
		run: (ctx) => {
			const p = panel(ctx);
			if (p) p.newBin();
			else if (ctx.session) createBin(ctx.session, null);
		},
		agentExposed: true,
	},
	{
		id: 'project.newSequence',
		label: 'New Sequence…',
		icon: 'panel.timeline',
		scope: 'global',
		when: editable,
		run: (ctx) => {
			const p = panel(ctx);
			if (p) p.newSequence();
			else projectDialogs.open({ kind: 'newSequence', binId: null });
		},
		agentExposed: true,
	},
	{
		id: 'project.listView',
		label: 'List View',
		scope: 'project',
		when: hasPanel,
		run: withPanel((p) => p.setView('list')),
	},
	{
		id: 'project.iconView',
		label: 'Icon View',
		scope: 'project',
		when: hasPanel,
		run: withPanel((p) => p.setView('icon')),
	},
	{
		id: 'project.toggleView',
		label: 'Toggle List/Icon View',
		scope: 'project',
		when: hasPanel,
		run: withPanel((p) => p.toggleView()),
	},
	{
		id: 'project.hoverScrub',
		label: 'Hover Scrub',
		scope: 'project',
		when: hasPanel,
		run: withPanel((p) => p.toggleHoverScrub()),
	},
	...(['project.thumbnailLarger', 'project.zoomIn'] as const).map(
		(id): UiCommand => ({
			id,
			label: 'Larger Thumbnails',
			scope: 'project',
			when: hasPanel,
			repeat: true,
			run: withPanel((p) => p.zoom(16)),
		}),
	),
	...(['project.thumbnailSmaller', 'project.zoomOut'] as const).map(
		(id): UiCommand => ({
			id,
			label: 'Smaller Thumbnails',
			scope: 'project',
			when: hasPanel,
			repeat: true,
			run: withPanel((p) => p.zoom(-16)),
		}),
	),
	{
		id: 'project.openInSource',
		label: 'Open in Source Monitor',
		scope: 'project',
		when: (ctx) => hasPanel(ctx) && !!ctx.session?.getState().selection.project.primary,
		run: withPanel((p) => p.openSelection()),
	},
	{
		id: 'project.renameItem',
		label: 'Rename',
		scope: 'project',
		when: (ctx) => editable(ctx) && !!ctx.session?.getState().selection.project.primary,
		run: withPanel((p) => p.renameSelection()),
		agentExposed: true,
	},
	...(['project.deleteWithOptions', 'project.deleteItems'] as const).map(
		(id): UiCommand => ({
			id,
			label: 'Clear',
			description: 'Delete the selected project items (asks when media is in use)',
			scope: 'project',
			when: (ctx) => editable(ctx) && (ctx.session?.getState().selection.project.items.length ?? 0) > 0,
			run: (ctx) => {
				const p = panel(ctx);
				if (p) p.deleteSelection();
				else if (ctx.session) deleteItems(ctx.session, ctx.session.getState().selection.project.items);
			},
			agentExposed: true,
		}),
	),
];
