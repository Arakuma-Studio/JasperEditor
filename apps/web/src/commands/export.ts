// export UI commands — owned by WP-2E (S05:EX-001, EX-050; S04 §10.1). Ids match keymap-defaults.ts.
import { EngineError } from '@jasper/engine-client';
import { exportMode } from '../export/mode.ts';
import { QuickExportError, startQuickExport } from '../export/quick.ts';
import type { CommandCtx, UiCommand } from './types.ts';

const hasSequence = (ctx: CommandCtx) =>
	!!ctx.session && Object.keys(ctx.session.getCommitted().sequences).length > 0;

/**
 * Export source (S05:EX-001): a selected sequence item when the Project panel is focused, else the
 * active sequence (Timeline / Program).
 */
export function exportSourceSequence(ctx: CommandCtx): string | null {
	const s = ctx.session;
	if (!s) return null;
	if (ctx.focus.panel === 'project') {
		const st = s.getState();
		const item = st.selection.project.primary ? st.document.items[st.selection.project.primary] : undefined;
		if (item?.kind === 'sequence') return item.sequenceId;
	}
	return s.getState().activeSequenceId ?? Object.keys(s.getCommitted().sequences)[0] ?? null;
}

async function quick(ctx: CommandCtx, label: string) {
	if (!ctx.session) return;
	try {
		const job = await startQuickExport(ctx.session, ctx.engine, exportSourceSequence(ctx));
		ctx.ui.toast({
			kind: 'info',
			message: `${label}: ${job.title}`,
			detail: 'Progress is shown in the Jobs panel.',
		});
	} catch (e) {
		ctx.ui.toast({
			kind: 'error',
			message: `${label} failed`,
			detail:
				e instanceof QuickExportError
					? [e.message, ...e.reasons].join(' — ')
					: e instanceof EngineError
						? `${e.code}: ${e.message}`
						: String(e),
		});
	}
}

export const exportCommands: UiCommand[] = [
	{
		id: 'export.media',
		label: 'Export Media…',
		description: 'Open Export mode for the active sequence',
		icon: 'app.export',
		scope: 'global',
		when: hasSequence,
		run: (ctx) => exportMode.open(exportSourceSequence(ctx)),
		agentExposed: true,
	},
	{
		id: 'export.close',
		label: 'Close Export Mode',
		scope: 'global',
		when: () => exportMode.get().open,
		run: () => exportMode.close(),
	},
	{
		id: 'export.quick',
		label: 'Quick Export',
		description: 'Export the active sequence with the last used settings',
		icon: 'app.export',
		scope: 'global',
		capability: 'engine',
		when: hasSequence,
		run: (ctx) => quick(ctx, 'Quick Export'),
		agentExposed: true,
	},
	{
		id: 'export.queue',
		label: 'Add Export to Queue',
		scope: 'global',
		capability: 'engine',
		when: hasSequence,
		run: (ctx) => quick(ctx, 'Queued export'),
	},
];
