// Fix Transcript commands (spec 17 SC-080; docs/wp-notes/script-correction.md "Editor UI"): "Fix Transcript…" opens
// the Fix dialog for the active sequence (Text panel ▸ Transcript toolbar, Text ▸ Fix Transcript…, Sequence ▸ Fix
// Transcript from Script…), "Script…" opens the Transcript tab's Script drawer (attach, replace or detach the video
// script the fixes and Clean Up read). Neither has a default shortcut (assignable in Keyboard Shortcuts).
import { t } from '../i18n/runtime.ts';
import { textPanelRequests } from '../panels/text/state.ts';
import { canFix } from '../script-fix/engine.ts';
import {
	FIX_TRANSCRIPT_DIALOG,
	type FixDialogEngine,
	registerFixTranscriptDialog,
} from '../script-fix/FixTranscriptDialog.tsx';
import { runCommand } from './registry.ts';
import { sequenceContext } from './sequence-context.ts';
import type { CommandCtx, UiCommand } from './types.ts';

registerFixTranscriptDialog();

const writable = (ctx: CommandCtx) => !!sequenceContext(ctx) && !ctx.session!.getState().readOnly;
const reason = (ctx: CommandCtx) =>
	!ctx.session
		? t('Open a project first')
		: !sequenceContext(ctx)
			? t('Open a sequence first')
			: t('The project is read-only');

export const scriptFixCommands: UiCommand[] = [
	{
		id: 'transcript.fix',
		label: 'Fix Transcript…',
		description:
			'Fix recognition errors in the transcript and its subtitles from the attached script and the personal speech glossary: the audio decides each fix; the fixes open in Review (one undo step when applied)',
		scope: 'global',
		agentExposed: true,
		when: writable,
		disabledReason: reason,
		run: (ctx) => {
			const e = sequenceContext(ctx);
			if (!e) return;
			ctx.ui.openDialog(FIX_TRANSCRIPT_DIALOG, {
				session: e.session,
				engine: canFix(ctx.engine) ? (ctx.engine as unknown as FixDialogEngine) : null,
				sequenceId: e.seq.id,
				onReview: () => void runCommand('panel.focus.review', ctx),
			});
		},
	},
	{
		id: 'transcript.script',
		label: 'Script…',
		description:
			'Open the Script drawer of Text ▸ Transcript: paste or load the video script (plain text or Markdown), replace or detach it; Fix Transcript and Clean Up read it',
		scope: 'global',
		agentExposed: true,
		when: (ctx) => !!sequenceContext(ctx),
		disabledReason: (ctx) => (!ctx.session ? t('Open a project first') : t('Open a sequence first')),
		run: (ctx) => {
			textPanelRequests.open('transcript', undefined, 'script');
			ctx.services.get('shell')?.focusPanel('text');
		},
	},
];
