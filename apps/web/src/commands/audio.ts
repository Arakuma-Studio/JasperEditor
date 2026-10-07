// Audio UI commands (audio-mix): Audio Gain (G), Audio Scrubbing (Shift+S), Auto Duck, Measure Loudness, Loudness
// Normalization of the Mix, Normalize Loudness of a media, Voice-over Record and its settings. This module is
// imported at start-up (commands/index.ts): it also installs the preview mix runtime (AudioWorklet), the dialogs and
// Preferences ▸ Audio.
import type { Sequence } from '@jasper/project';
import { openDialog, toast } from '@jasper/ui';
import { z } from 'zod';
import {
	AUDIO_GAIN_DIALOG,
	AUTO_DUCK_DIALOG,
	LOUDNESS_DIALOG,
	NORMALIZE_MEDIA_DIALOG,
	registerAudioDialogs,
	reportLoudness,
} from '../audio/dialogs.tsx';
import { AudioPreferencesPage } from '../audio/PreferencesPage.tsx';
import { audioPrefs } from '../audio/prefs.ts';
import { installAudioRuntime } from '../audio/runtime.ts';
import { voiceoverFor } from '../audio/voiceover.ts';
import { clipMenuExtensions, projectItemMenuExtensions } from '../extensions/index.ts';
import {
	PREFERENCES_DIALOG,
	registerPreferencesDialog,
	registerPreferencesPage,
} from '../shell/preferences/index.ts';
import type { CommandCtx, UiCommand } from './types.ts';

installAudioRuntime();
registerAudioDialogs();

// Context menus: timeline audio clips (Audio Gain, Auto Duck, Normalize Loudness) and Project media items.
clipMenuExtensions.register({
	id: 'audio-mix',
	order: 40,
	items: ({ session, clip, selection }) => {
		if (!AUDIO_KINDS.has(clip.kind)) return [];
		const readOnly = session.getState().readOnly;
		const seqId = session.getState().activeSequenceId;
		const seq = seqId ? (session.getCommitted().sequences[seqId] as Sequence | undefined) : undefined;
		if (!seq) return [];
		const ids = (selection.includes(clip.id) ? selection : [clip.id]).filter((id) => {
			const c = seq.clips[id];
			return !!c && AUDIO_KINDS.has(c.kind);
		});
		const mediaId = (clip as { mediaId?: string }).mediaId;
		return [
			{
				kind: 'item',
				label: 'Audio Gain…',
				shortcut: 'G',
				disabled: readOnly,
				run: () => void openDialog(AUDIO_GAIN_DIALOG, { session, sequenceId: seq.id, clipIds: ids }),
			},
			{
				kind: 'item',
				label: 'Auto Duck…',
				disabled: readOnly,
				run: () => void openDialog(AUTO_DUCK_DIALOG, { session, sequenceId: seq.id, clipIds: ids }),
			},
			...(clip.kind === 'audio' && mediaId
				? [
						{
							kind: 'item' as const,
							label: 'Normalize Loudness…',
							disabled: readOnly,
							run: () =>
								void openDialog(NORMALIZE_MEDIA_DIALOG, {
									session,
									mediaId,
									clipIds: ids.filter((id) => (seq.clips[id] as { mediaId?: string }).mediaId === mediaId),
								}),
						},
					]
				: []),
		];
	},
});
projectItemMenuExtensions.register({
	id: 'audio-mix',
	order: 60,
	items: ({ session, items, readOnly }) => {
		if (items.length !== 1) return [];
		const it = items[0] as { kind: string; mediaId?: string };
		const kind = it.mediaId ? session.getCommitted().media[it.mediaId]?.kind : undefined;
		if (it.kind !== 'media' || !it.mediaId || (kind !== 'audio' && kind !== 'video')) return [];
		const mediaId = it.mediaId;
		return [
			{
				kind: 'item',
				label: 'Normalize Loudness…',
				disabled: readOnly,
				run: () => void openDialog(NORMALIZE_MEDIA_DIALOG, { session, mediaId, clipIds: [] }),
			},
		];
	},
});
registerPreferencesDialog();
registerPreferencesPage({ id: 'audio', title: 'Audio', order: 30, component: AudioPreferencesPage });

const AUDIO_KINDS = new Set(['audio', 'nest-audio', 'synthetic-audio']);

function activeSeq(ctx: CommandCtx): Sequence | null {
	const s = ctx.session?.getState();
	const id = s?.activeSequenceId;
	return id ? ((s!.document.sequences[id] as Sequence | undefined) ?? null) : null;
}

/** Selected audio clips of the active sequence (linked video selects its audio). */
function selectedAudioClips(ctx: CommandCtx): string[] {
	const s = ctx.session?.getState();
	const seq = activeSeq(ctx);
	if (!s || !seq) return [];
	const out = new Set<string>();
	for (const id of s.selection.timeline.clips) {
		const c = seq.clips[id];
		if (!c) continue;
		if (AUDIO_KINDS.has(c.kind)) out.add(id);
		else if (c.linkId) {
			const link = seq.links[c.linkId];
			for (const m of link?.members ?? [])
				if (seq.clips[m] && AUDIO_KINDS.has(seq.clips[m]!.kind)) out.add(m);
		}
	}
	return [...out];
}

/** The media of the selected Project item, else the first selected audio clip's (Normalize Loudness). */
function normalizeTarget(ctx: CommandCtx): { mediaId: string; clipIds: string[] } | null {
	const s = ctx.session?.getState();
	if (!s) return null;
	const doc = s.document;
	const itemId = s.selection.project.primary ?? s.selection.project.items[0];
	const it = itemId ? (doc.items[itemId] as { kind: string; mediaId?: string } | undefined) : undefined;
	const clips = selectedAudioClips(ctx);
	const seq = activeSeq(ctx);
	const clipMedia = clips
		.map((id) => (seq?.clips[id] as { mediaId?: string } | undefined)?.mediaId)
		.find((m) => !!m);
	const mediaId = clipMedia ?? (it?.kind === 'media' ? it.mediaId : undefined);
	if (!mediaId) return null;
	const kind = doc.media[mediaId]?.kind;
	if (kind !== 'audio' && kind !== 'video') return null;
	return {
		mediaId,
		clipIds: clips.filter(
			(id) =>
				(seq?.clips[id] as { kind: string; mediaId?: string } | undefined)?.mediaId === mediaId &&
				seq?.clips[id]?.kind === 'audio',
		),
	};
}

const editable = (ctx: CommandCtx) => !!ctx.session && !ctx.session.getState().readOnly;

export const audioCommands: UiCommand[] = [
	{
		id: 'timeline.audioGain',
		label: 'Audio Gain…',
		scope: 'timeline',
		agentExposed: true,
		when: (ctx) => editable(ctx) && selectedAudioClips(ctx).length > 0,
		disabledReason: (ctx) => (selectedAudioClips(ctx).length ? undefined : 'Select audio clips'),
		run: (ctx) => {
			const seq = activeSeq(ctx);
			const clipIds = selectedAudioClips(ctx);
			if (!seq || !ctx.session || clipIds.length === 0) return;
			ctx.ui.openDialog(AUDIO_GAIN_DIALOG, {
				session: ctx.session,
				engine: ctx.engine,
				sequenceId: seq.id,
				clipIds,
			});
		},
	},
	{
		id: 'transport.toggleAudioScrub',
		label: 'Audio Scrubbing',
		description: 'Play audio while scrubbing the playhead',
		scope: 'editing',
		agentExposed: true,
		checked: () => audioPrefs.get().scrub,
		run: (ctx) => {
			const on = !audioPrefs.get().scrub;
			audioPrefs.set({ scrub: on });
			ctx.ui.toast({ kind: 'info', message: on ? 'Audio scrubbing on' : 'Audio scrubbing off' });
		},
	},
	{
		id: 'audio.autoDuck',
		label: 'Auto Duck…',
		description: 'Duck the selected clips (music) under dialogue or other tracks',
		scope: 'global',
		agentExposed: true,
		when: (ctx) => editable(ctx) && selectedAudioClips(ctx).length > 0,
		disabledReason: (ctx) =>
			selectedAudioClips(ctx).length ? undefined : 'Select the clips to duck (music)',
		capability: 'engine',
		run: (ctx) => {
			const seq = activeSeq(ctx);
			if (!seq || !ctx.session) return;
			ctx.ui.openDialog(AUTO_DUCK_DIALOG, {
				session: ctx.session,
				engine: ctx.engine,
				sequenceId: seq.id,
				clipIds: selectedAudioClips(ctx),
			});
		},
	},
	{
		id: 'audio.measureLoudness',
		label: 'Measure Loudness',
		description: 'BS.1770 loudness and true peak of the selected audio clips, else of the whole mix',
		scope: 'global',
		agentExposed: true,
		capability: 'engine',
		when: (ctx) => !!activeSeq(ctx),
		run: async (ctx) => {
			const seq = activeSeq(ctx);
			if (!seq || !ctx.session) return;
			try {
				await reportLoudness(ctx.session, ctx.engine, seq.id, selectedAudioClips(ctx));
			} catch (e) {
				toast({ kind: 'error', title: 'Loudness measurement failed', detail: (e as Error).message });
			}
		},
	},
	{
		id: 'sequence.loudness',
		label: 'Loudness Normalization…',
		description: 'Normalize the Mix to a loudness target with a true-peak limit (preview and export)',
		scope: 'global',
		agentExposed: true,
		capability: 'engine',
		when: (ctx) => editable(ctx) && !!activeSeq(ctx),
		run: (ctx) => {
			const seq = activeSeq(ctx);
			if (!seq || !ctx.session) return;
			ctx.ui.openDialog(LOUDNESS_DIALOG, { session: ctx.session, engine: ctx.engine, sequenceId: seq.id });
		},
	},
	{
		id: 'audio.normalizeMedia',
		label: 'Normalize Loudness…',
		description: 'Make a loudness-normalized version of the media (true-peak limited)',
		scope: 'global',
		agentExposed: true,
		capability: 'engine',
		when: (ctx) => editable(ctx) && !!normalizeTarget(ctx),
		disabledReason: (ctx) =>
			normalizeTarget(ctx) ? undefined : 'Select an audio clip or an audio/video Project item',
		run: (ctx) => {
			const t = normalizeTarget(ctx);
			if (!t || !ctx.session) return;
			ctx.ui.openDialog(NORMALIZE_MEDIA_DIALOG, { session: ctx.session, engine: ctx.engine, ...t });
		},
	},
	{
		id: 'audio.voiceoverRecord',
		label: 'Record Voice-over',
		description:
			'Record the microphone into the record-armed (or given) audio track at the playhead; again to stop',
		scope: 'global',
		agentExposed: true,
		capability: 'engine',
		argsSchema: z.object({ trackId: z.string().optional() }).optional(),
		checked: (ctx) => (ctx.session ? voiceoverFor(ctx.session, ctx.engine).busy : false),
		when: (ctx) => editable(ctx) && !!activeSeq(ctx),
		run: async (ctx, args) => {
			if (!ctx.session) return;
			const rec = voiceoverFor(ctx.session, ctx.engine);
			if (rec.busy) {
				rec.stop();
				return;
			}
			try {
				await rec.start({ trackId: (args as { trackId?: string } | undefined)?.trackId ?? null });
			} catch (e) {
				toast({ kind: 'error', title: 'Voice-over recording', detail: (e as Error).message });
			}
		},
	},
	{
		id: 'audio.voiceoverSettings',
		label: 'Voice-Over Record Settings…',
		scope: 'global',
		run: (ctx) => ctx.ui.openDialog(PREFERENCES_DIALOG, { page: 'audio' }),
	},
	{
		id: 'audio.preferences',
		label: 'Audio Preferences…',
		scope: 'global',
		hidden: true,
		run: (ctx) => ctx.ui.openDialog(PREFERENCES_DIALOG, { page: 'audio' }),
	},
];
