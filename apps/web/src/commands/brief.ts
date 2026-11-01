// Spec 18 AF-BRF-006: Sequence ▸ Brief… opens the brief of the active sequence with the project's agent notes
// (brief/BriefDialog.tsx). No default shortcut (assignable in Keyboard Shortcuts).
import { BRIEF_DIALOG, registerBriefDialog } from '../brief/BriefDialog.tsx';
import { t } from '../i18n/runtime.ts';
import { sequenceContext } from './sequence-context.ts';
import type { UiCommand } from './types.ts';

registerBriefDialog();

export const briefCommands: UiCommand[] = [
	{
		id: 'sequence.brief',
		label: 'Brief…',
		description:
			'Edit what the active sequence should be (description, platform, frame, target length) for AI agents to read, and see or remove the notes agents kept about the project',
		scope: 'global',
		agentExposed: true,
		when: (ctx) => !!sequenceContext(ctx),
		disabledReason: (ctx) => (!ctx.session ? t('Open a project first') : t('Open a sequence first')),
		run: (ctx) => {
			const e = sequenceContext(ctx);
			if (!e) return;
			ctx.ui.openDialog(BRIEF_DIALOG, { session: e.session, sequenceId: e.seq.id });
		},
	},
];
