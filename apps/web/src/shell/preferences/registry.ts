// Preferences page registry (S07:PRU-004, ARCHITECTURE §19.10): the Preferences dialog shell lists the
// registered pages on the left (sorted by `order`) and renders the selected one on the right. Packages
// register their pages at module load of their command module (`commands/<area>.ts`), like the other M2
// extension points, so no shared list has to be edited. A sub-page (`parent`) is listed indented under its parent
// and titled "Parent ▸ Page" (Transcription ▸ Glossary).
import type { ComponentType } from 'react';
import { createRegistry } from '../../extensions/registry.ts';

type PreferencesPageDef = {
	id: string;
	title: string;
	order?: number;
	/** A sub-page: listed indented under the page with this id (give it an `order` right after the parent's). */
	parent?: string;
	component: ComponentType;
};

export const preferencesPages = createRegistry<PreferencesPageDef>();

/** Adds a page to Edit ▸ Preferences; returns the unregister function. */
export function registerPreferencesPage(page: PreferencesPageDef): () => void {
	return preferencesPages.register(page);
}
