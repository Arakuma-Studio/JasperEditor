// Sound Library commands (spec 12 §2.7, P1-R7/R8): the panel's keymap scope `soundLibrary` (Space audition, Enter
// insert, F favourite, L loop, Ctrl/Cmd+F search), its panel menu, File ▸ Export ▸ Sound Credits…, and the commands
// agents drive through the UI command catalogue (search, insert a sound by id at the playhead). Also registers
// Preferences ▸ Sound Library and the Sound Library dialogs.
import { SoundIdSchema } from '@jasper/api';
import { z } from 'zod';
import { activeTimeline } from '../panels/timeline/env.tsx';
import {
	PREFERENCES_DIALOG,
	registerPreferencesDialog,
	registerPreferencesPage,
} from '../shell/preferences/index.ts';
import { auditionPlayer } from '../sound/audition.ts';
import { insertSoundWithFeedback, requestSoundSearch, soundLibraryController } from '../sound/controller.ts';
import { registerSoundDialogs, SOUND_CREDITS_DIALOG } from '../sound/dialogs.tsx';
import { SoundLibraryPreferencesPage } from '../sound/PreferencesPage.tsx';
import { soundLibraryPrefs } from '../sound/prefs.ts';
import { runCommand } from './registry.ts';
import type { CommandCtx, UiCommand } from './types.ts';

registerSoundDialogs();
registerPreferencesDialog();
registerPreferencesPage({
	id: 'sound-library',
	title: 'Sound Library',
	order: 31,
	component: SoundLibraryPreferencesPage,
});

const S = 'soundLibrary' as const;
const panelSelected = () => soundLibraryController()?.selected() ?? null;
const writableSequence = (ctx: CommandCtx) => {
	const s = ctx.session?.getState();
	return !!s && !s.readOnly && !!(activeTimeline(ctx.services)?.sequenceId() ?? s.activeSequenceId);
};

const InsertArgs = z
	.object({
		soundId: SoundIdSchema,
		/** Sequence frame the aligned point lands on (default: the playhead). */
		at: z.number().int().min(0).optional(),
		/** Which point lands there: auto (default, by the sound's type: peak, end for risers, start for UI), peak, start, end. */
		align: z.enum(['auto', 'peak', 'start', 'end']).optional(),
	})
	.strict();

export const soundCommands: UiCommand[] = [
	{
		id: 'soundLibrary.audition',
		label: 'Audition Sound',
		description: 'Play or stop the selected sound of the Sound Library (alone, never changes the project)',
		scope: S,
		when: () => !!panelSelected(),
		disabledReason: () => 'Select a sound in the Sound Library',
		run: () => soundLibraryController()?.toggleAudition(),
	},
	{
		id: 'soundLibrary.stopAudition',
		label: 'Stop Audition',
		scope: 'global',
		hidden: true,
		when: () => auditionPlayer().state.phase !== 'idle',
		run: () => auditionPlayer().stop(),
	},
	{
		id: 'soundLibrary.insert',
		label: 'Insert Sound at Playhead',
		description: 'Insert the selected sound with its peak on the playhead (one undo step)',
		scope: S,
		when: (ctx) => !!panelSelected() && writableSequence(ctx),
		disabledReason: (ctx) =>
			!panelSelected()
				? 'Select a sound in the Sound Library'
				: !ctx.session
					? 'Open a project first'
					: 'Open a sequence first',
		run: () => soundLibraryController()?.insertSelected(),
	},
	{
		id: 'soundLibrary.toggleFavourite',
		label: 'Favourite Sound',
		scope: S,
		when: () => !!panelSelected(),
		checked: () => {
			const e = panelSelected();
			return !!e && soundLibraryPrefs.isFavourite(e.id);
		},
		run: () => soundLibraryController()?.toggleFavourite(),
	},
	{
		id: 'soundLibrary.toggleLoop',
		label: 'Loop Audition',
		scope: S,
		checked: () => soundLibraryPrefs.get().loop,
		run: () => {
			const loop = !soundLibraryPrefs.get().loop;
			soundLibraryPrefs.set({ loop });
			auditionPlayer().setLoop(loop);
		},
	},
	{
		id: 'soundLibrary.toggleAutoPlay',
		label: 'Auto-play Selected Sound',
		scope: S,
		checked: () => soundLibraryPrefs.get().autoPlay,
		run: () => soundLibraryPrefs.set({ autoPlay: !soundLibraryPrefs.get().autoPlay }),
	},
	{
		id: 'soundLibrary.toggleCompact',
		label: 'Compact Rows',
		scope: 'global',
		checked: () => soundLibraryPrefs.get().density === 'compact',
		run: () =>
			soundLibraryPrefs.set({
				density: soundLibraryPrefs.get().density === 'compact' ? 'normal' : 'compact',
			}),
	},
	{
		id: 'soundLibrary.focusSearch',
		label: 'Search Sounds',
		scope: S,
		run: () => soundLibraryController()?.focusSearch(),
	},
	{
		id: 'soundLibrary.findSimilar',
		label: 'Find Similar Sounds',
		scope: S,
		when: () => !!panelSelected(),
		run: () => soundLibraryController()?.findSimilar(),
	},
	{
		id: 'soundLibrary.showLicense',
		label: 'Show Sound Licence…',
		scope: S,
		when: () => !!panelSelected(),
		run: () => soundLibraryController()?.showLicense(),
	},
	{
		id: 'soundLibrary.search',
		label: 'Search the Sound Library',
		description: 'Open the Sound Library and search it (text, type words such as "whoosh", synonyms)',
		scope: 'global',
		capability: 'engine',
		agentExposed: true,
		argsSchema: z.object({ query: z.string().max(500) }).strict(),
		run: async (ctx, args) => {
			const { query } = args as { query: string };
			requestSoundSearch(query);
			await runCommand('panel.focus.soundLibrary', ctx);
		},
	},
	{
		id: 'sound.insertAtPlayhead',
		label: 'Insert Library Sound at Playhead',
		description:
			'Insert a library sound (its id, snd_…) into the active sequence with its peak on the playhead (or on `at`); registers it into the "Sound Effects" bin, picks a free audio track or adds "SFX n", tags it SFX — one undo step',
		scope: 'global',
		capability: 'engine',
		agentExposed: true,
		argsSchema: InsertArgs,
		when: writableSequence,
		disabledReason: (ctx) =>
			!ctx.session
				? 'Open a project first'
				: ctx.session.getState().readOnly
					? 'The project is read-only'
					: 'Open a sequence first',
		run: async (ctx, args) => {
			const a = args as z.infer<typeof InsertArgs>;
			const session = ctx.session;
			if (!session) return;
			const entry = await ctx.engine.getSound(a.soundId);
			const id = await insertSoundWithFeedback(session, ctx.engine, entry, (r) => ctx.ui.toast(r), {
				...(a.at !== undefined ? { at: a.at } : {}),
				...(a.align ? { align: a.align } : {}),
			});
			if (!id) throw new Error(`Could not insert ${a.soundId}`);
		},
	},
	{
		id: 'soundLibrary.installStarterKit',
		label: 'Install Starter Kit',
		description: 'Index the bundled starter kit of sound effects',
		scope: 'global',
		capability: 'engine',
		run: async (ctx) => {
			const st = await ctx.engine.soundLibraryStatus();
			if (st.starter.status !== 'ok' || st.starter.sounds === 0) {
				ctx.ui.toast({ kind: 'warning', message: 'This build has no starter kit' });
				return;
			}
			await ctx.engine.indexSounds({});
			ctx.ui.toast({
				kind: 'info',
				message: 'Indexing the starter kit',
				detail: 'Its sounds appear when the job ends.',
			});
		},
	},
	{
		id: 'soundLibrary.rescan',
		label: 'Rescan Sound Library',
		scope: 'global',
		capability: 'engine',
		run: async (ctx) => {
			await ctx.engine.indexSounds({});
			ctx.ui.toast({ kind: 'info', message: 'Rescanning the sound library' });
		},
	},
	{
		id: 'soundLibrary.preferences',
		label: 'Sound Library Preferences…',
		scope: 'global',
		run: (ctx) => ctx.ui.openDialog(PREFERENCES_DIALOG, { page: 'sound-library', session: ctx.session }),
	},
	{
		id: 'file.exportSoundCredits',
		label: 'Sound Credits…',
		description:
			'Export the credits of the library sounds the sequence or project uses (Markdown, text or CSV)',
		scope: 'global',
		agentExposed: true,
		when: (ctx) => !!ctx.session,
		disabledReason: () => 'Open a project first',
		run: (ctx) => {
			const s = ctx.session;
			if (!s) return;
			ctx.ui.openDialog(SOUND_CREDITS_DIALOG, {
				session: s,
				sequenceId: activeTimeline(ctx.services)?.sequenceId() ?? s.getState().activeSequenceId,
			});
		},
	},
];
