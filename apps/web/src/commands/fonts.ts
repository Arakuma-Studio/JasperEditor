// wp fonts: the user font library in the editor — Edit ▸ Preferences ▸ Fonts (the font manager), Graphics ▸
// Resolve Fonts… and Graphics ▸ Add Fonts…; also the commands agents can drive through the UI command catalogue.
import { registerDialog } from '@jasper/ui';
import {
	addFontsWithFeedback,
	FONTS_PREFERENCES_PAGE,
	openFontPreferences,
	RESOLVE_FONTS_DIALOG,
} from '../fonts/actions.ts';
import { FontsPreferencesPage } from '../fonts/FontsPage.tsx';
import { ResolveFontsDialog } from '../fonts/ResolveFontsDialog.tsx';
import { registerPreferencesDialog, registerPreferencesPage } from '../shell/preferences/index.ts';
import type { UiCommand } from './types.ts';

registerDialog(RESOLVE_FONTS_DIALOG, ResolveFontsDialog);
registerPreferencesDialog();
registerPreferencesPage({
	id: FONTS_PREFERENCES_PAGE,
	title: 'Fonts',
	order: 33,
	component: FontsPreferencesPage,
});

export const fontCommands: UiCommand[] = [
	{
		id: 'fonts.resolve',
		label: 'Resolve Fonts…',
		description:
			"Lists the fonts this project's text and captions use that are not installed, and installs font files for them (the project then renders with them, in the editor and in exports).",
		scope: 'editing',
		when: (ctx) => !!ctx.session,
		disabledReason: () => 'Open a project',
		run: (ctx) => {
			if (ctx.session) ctx.ui.openDialog(RESOLVE_FONTS_DIALOG, { session: ctx.session });
		},
	},
	{
		id: 'fonts.add',
		label: 'Add Fonts…',
		description:
			'Installs font files (TTF, OTF, TTC, WOFF, WOFF2) into your font library: available in every project, like fonts installed on the computer.',
		scope: 'global',
		capability: 'engine',
		run: () => {
			void addFontsWithFeedback();
		},
	},
	{
		id: 'fonts.preferences',
		label: 'Fonts…',
		description:
			'Edit ▸ Preferences ▸ Fonts: the fonts you installed (details, samples, remove) and the bundled families.',
		scope: 'global',
		run: (ctx) => openFontPreferences(ctx.session),
	},
];
