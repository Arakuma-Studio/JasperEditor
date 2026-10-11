import { addTextAt } from '../panels/program/edits.ts';
import { getCommand, runCommand } from './registry.ts';
import type { CommandCtx, UiCommand } from './types.ts';

/** sessionStorage flag read by Home: open the New Project dialog once (File ▸ New ▸ Project…). */
export const HOME_NEW_PROJECT_FLAG = 'jasper:home-new-project';

/** A command that runs another registered command (menus/keymap use canonical ids of other packages). */
function delegate(id: string, label: string, target: string): UiCommand {
	return {
		id,
		label,
		scope: 'global',
		when: (ctx) => {
			const cmd = getCommand(target);
			return !!cmd && (cmd.when ? cmd.when(ctx) : true);
		},
		disabledReason: (ctx) => getCommand(target)?.disabledReason?.(ctx),
		run: async (ctx, args) => {
			await runCommand(target, ctx, args);
		},
	};
}

function goHome(ctx: CommandCtx, openNewProject: boolean): void {
	const shell = ctx.services.get('shell');
	if (!shell) return;
	if (openNewProject) {
		try {
			window.sessionStorage.setItem(HOME_NEW_PROJECT_FLAG, '1');
		} catch {
			// storage unavailable: Home simply opens without the dialog
		}
	}
	shell.goHome();
}

const hasShell = (ctx: CommandCtx) => !!ctx.services.get('shell');

export const integrationCommands: UiCommand[] = [
	{
		id: 'graphics.newTextLayer',
		label: 'Text',
		description: 'Add a 5 s text clip at the playhead, centered in the frame, on a free video track.',
		icon: 'tool.type',
		scope: 'global',
		agentExposed: true,
		when: (ctx) => !!ctx.session?.getState().activeSequenceId,
		disabledReason: (ctx) => (ctx.session?.getState().activeSequenceId ? undefined : 'Open a sequence first'),
		run: (ctx) => {
			const session = ctx.session;
			const seqId = session?.getState().activeSequenceId;
			const seq = seqId ? session?.getCommitted().sequences[seqId] : undefined;
			if (!session || !seq) return;
			const id = addTextAt(
				session,
				[seq.settings.width / 2, seq.settings.height / 2],
				session.transport.getState().frame,
			);
			if (!id) ctx.ui.toast({ kind: 'error', message: 'Could not add the text clip' });
		},
	},
	delegate('mg.insertTemplate', 'Motion Graphic Template…', 'panel.focus.motionTemplates'),
	delegate('app.newSequence', 'New Sequence…', 'project.newSequence'),
	{
		id: 'app.newProject',
		label: 'New Project…',
		scope: 'global',
		when: hasShell,
		run: (ctx) => goHome(ctx, true),
	},
	{
		id: 'app.openProject',
		label: 'Open Project…',
		description: 'Go to Home to open a recent project or a .jasper file.',
		scope: 'global',
		when: hasShell,
		run: (ctx) => goHome(ctx, false),
	},
	{
		id: 'app.closeProject',
		label: 'Close Project',
		scope: 'global',
		when: hasShell,
		run: (ctx) => goHome(ctx, false),
	},
	delegate('edit.selectAll', 'Select All', 'timeline.selectAll'),
	delegate('edit.deselectAll', 'Deselect All', 'timeline.deselectAll'),
	delegate('edit.rippleDelete', 'Ripple Delete', 'timeline.rippleDelete'),
	delegate('edit.duplicate', 'Duplicate', 'timeline.duplicate'),
];
