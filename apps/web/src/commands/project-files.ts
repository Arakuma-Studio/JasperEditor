import { confirmDialog, openDialog } from '@jasper/ui';
import { z } from 'zod';
import { PROJECT_FILE_DIALOGS, projectFileActions, supportsVersions } from '../home/project-files.tsx';
import type { CommandCtx, UiCommand } from './types.ts';

const NO_PROJECT = 'Open a project first';
const NOT_STORED = 'This project is not stored by the engine (demo project)';

const actionsFor = (ctx: CommandCtx) => projectFileActions(ctx.session);
const failed = (ctx: CommandCtx, message: string, e: unknown) =>
	ctx.ui.toast({ kind: 'error', message, detail: e instanceof Error ? e.message : String(e) });

function saveAsCommand(id: string, label: string, open: boolean): UiCommand {
	return {
		id,
		label,
		description: open
			? 'Save the project under a new name and continue editing the new project; the original keeps its last saved state.'
			: 'Save a copy of the project under a new name and keep editing this one.',
		scope: 'global',
		agentExposed: true,
		argsSchema: z.object({ name: z.string().min(1).max(200).optional() }).optional(),
		when: (ctx) => !!actionsFor(ctx),
		disabledReason: (ctx) => (!ctx.session ? NO_PROJECT : 'The project has no store'),
		run: async (ctx, args) => {
			const actions = actionsFor(ctx);
			if (!actions) return;
			const doc = actions.session.getCommitted();
			let name = (args as { name?: string } | undefined)?.name;
			name ??= await openDialog<string>(PROJECT_FILE_DIALOGS.saveAs, {
				title: open ? 'Save Project As' : 'Save a Copy',
				initial: open ? doc.name : `${doc.name} copy`,
				primary: 'Save',
			});
			if (!name) return;
			try {
				await actions.saveAs(name, { open });
				ctx.ui.toast({ kind: 'success', message: open ? `Saved as “${name}”` : `Saved a copy as “${name}”` });
			} catch (e) {
				failed(ctx, open ? 'Save As failed' : 'Save a Copy failed', e);
			}
		},
	};
}

const revert: UiCommand = {
	id: 'file.revert',
	label: 'Revert',
	description:
		'Discard the changes autosave has not written yet and reload the last saved state. For older states use File ▸ Project Versions….',
	scope: 'global',
	when: (ctx) => {
		const s = ctx.session?.getState();
		return !!actionsFor(ctx) && !!s && !s.readOnly && s.dirty;
	},
	disabledReason: (ctx) => {
		const s = ctx.session?.getState();
		if (!s) return NO_PROJECT;
		if (!actionsFor(ctx)) return NOT_STORED;
		if (s.readOnly) return 'The project is open read-only';
		return 'No unsaved changes: autosave has saved everything (use File ▸ Project Versions… to go back further)';
	},
	run: async (ctx) => {
		const actions = actionsFor(ctx);
		if (!actions) return;
		const ok = await confirmDialog({
			title: 'Revert to the last saved state?',
			body: 'Changes that have not been saved yet are discarded. This cannot be undone.',
			confirmLabel: 'Revert',
			danger: true,
		});
		if (!ok) return;
		try {
			await actions.revert();
			ctx.ui.toast({ kind: 'success', message: 'Reverted to the last saved state' });
		} catch (e) {
			failed(ctx, 'Revert failed', e);
		}
	},
};

const versions: UiCommand = {
	id: 'file.projectVersions',
	label: 'Project Versions…',
	description: 'Saved versions of this project: restore one or open it as a new project.',
	scope: 'global',
	when: (ctx) => !!actionsFor(ctx) && supportsVersions(ctx.session),
	disabledReason: (ctx) => (!ctx.session ? NO_PROJECT : NOT_STORED),
	run: (ctx) => {
		const actions = actionsFor(ctx);
		if (actions) void openDialog(PROJECT_FILE_DIALOGS.versions, { actions });
	},
};

const recover: UiCommand = {
	id: 'file.recoverUnsaved',
	label: 'Recover Unsaved Changes…',
	description:
		'Unsaved changes of editing sessions that ended before they were saved (a crash, a closed tab).',
	scope: 'global',
	when: (ctx) => !!actionsFor(ctx) && supportsVersions(ctx.session) && !ctx.session?.getState().readOnly,
	disabledReason: (ctx) =>
		!ctx.session
			? NO_PROJECT
			: ctx.session.getState().readOnly
				? 'The project is open read-only'
				: NOT_STORED,
	run: async (ctx) => {
		const actions = actionsFor(ctx);
		if (!actions) return;
		try {
			const candidates = await actions.listRecovery();
			if (candidates.length === 0) {
				ctx.ui.toast({ kind: 'info', message: 'There are no unsaved changes to recover' });
				return;
			}
			await openDialog(PROJECT_FILE_DIALOGS.recovery, { actions, candidates, atOpen: false });
		} catch (e) {
			failed(ctx, 'Could not look for unsaved changes', e);
		}
	},
};

export const projectFileCommands: UiCommand[] = [
	saveAsCommand('app.saveAs', 'Save As…', true),
	saveAsCommand('app.saveCopy', 'Save a Copy…', false),
	revert,
	versions,
	recover,
];
