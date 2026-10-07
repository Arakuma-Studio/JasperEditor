// wp speech UI commands (agent-exposed): Generate Transcript… for the active sequence (Sequence ▸ Captions, Text ▸
// Transcript), for the selected clips' media (Clip menu) or the selected Project media, and Preferences ▸ Transcription.
// Premiere has no default shortcuts for these. Gated by the `transcription` capability (engine speech ready).
import type { Sequence } from '@jasper/project';
import { activeTimeline } from '../panels/timeline/env.tsx';
import { PREFERENCES_DIALOG } from '../shell/preferences/index.ts';
import { clipMedia, hasAudio } from '../speech/model.ts';
import { openGenerateTranscript, registerSpeechUi } from '../speech/register.ts';
import type { CommandCtx, UiCommand } from './types.ts';

registerSpeechUi();

function activeSequence(ctx: CommandCtx): Sequence | null {
	const session = ctx.session;
	if (!session) return null;
	const id = activeTimeline(ctx.services)?.sequenceId() ?? session.getState().activeSequenceId;
	return id ? ((session.getCommitted().sequences[id] as Sequence | undefined) ?? null) : null;
}

function selectedProjectMedia(ctx: CommandCtx): string[] {
	const s = ctx.session?.getState();
	if (!s) return [];
	const doc = s.document;
	return s.selection.project.items
		.map((id) => (doc.items[id] as { mediaId?: string } | undefined)?.mediaId)
		.filter((id): id is string => !!id && hasAudio(doc.media[id] as never));
}

function selectedClipMedia(ctx: CommandCtx): string[] {
	const s = ctx.session?.getState();
	return s ? clipMedia(s.document, s.selection.timeline.clips) : [];
}

const writable = (ctx: CommandCtx) => !!ctx.session && !ctx.session.getState().readOnly;

export const speechCommands: UiCommand[] = [
	{
		id: 'transcript.generate',
		label: 'Generate Transcript…',
		description: 'Transcribe the active sequence (its clip media, or its mix) with Whisper on this computer',
		scope: 'global',
		capability: 'transcription',
		agentExposed: true,
		when: (ctx) => writable(ctx) && !!activeSequence(ctx),
		disabledReason: (ctx) =>
			!ctx.session
				? 'Open a project first'
				: !activeSequence(ctx)
					? 'Open a sequence first'
					: 'The project is read-only',
		run: (ctx) => {
			const seq = activeSequence(ctx);
			if (seq && ctx.session) openGenerateTranscript(ctx.session, { kind: 'sequence', sequenceId: seq.id });
		},
	},
	{
		id: 'transcript.generateForClips',
		label: 'Generate Transcript…',
		description: 'Transcribe the media of the selected clips',
		scope: 'global',
		capability: 'transcription',
		agentExposed: true,
		when: (ctx) => writable(ctx) && selectedClipMedia(ctx).length > 0,
		disabledReason: () => 'Select clips with sound first',
		run: (ctx) => {
			const ids = selectedClipMedia(ctx);
			if (ids.length && ctx.session) openGenerateTranscript(ctx.session, { kind: 'media', mediaIds: ids });
		},
	},
	{
		id: 'transcript.generateForMedia',
		label: 'Generate Transcript…',
		description: 'Transcribe the selected Project panel media',
		scope: 'global',
		capability: 'transcription',
		agentExposed: true,
		when: (ctx) => writable(ctx) && selectedProjectMedia(ctx).length > 0,
		disabledReason: () => 'Select media with sound in the Project panel first',
		run: (ctx) => {
			const ids = selectedProjectMedia(ctx);
			if (ids.length && ctx.session) openGenerateTranscript(ctx.session, { kind: 'media', mediaIds: ids });
		},
	},
	{
		id: 'speech.preferences',
		label: 'Transcription…',
		description: 'Preferences ▸ Transcription: speech-to-text models',
		scope: 'global',
		run: (ctx) => ctx.ui.openDialog(PREFERENCES_DIALOG, { page: 'speech', session: ctx.session ?? null }),
	},
];
