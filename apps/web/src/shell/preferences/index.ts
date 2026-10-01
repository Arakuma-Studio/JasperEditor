// Preferences dialog shell and page registry (S07:PRU-004, ARCHITECTURE §19.10).
export { PREFERENCES_DIALOG, PreferencesDialog, registerPreferencesDialog } from './PreferencesDialog.tsx';
export {
	type PreferencesPageDef,
	type PreferencesPageProps,
	preferencesPages,
	registerPreferencesPage,
} from './registry.ts';
