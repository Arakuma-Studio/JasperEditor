// Spec 19 TL-050 / TL-051: the factory library, as data. Adding a look: an entry in `FACTORY_LOOKS`, a colourway: an
// entry in `FACTORY_COLORWAYS` (their own files per category). `look.apply` copies a factory look into the project on
// first use (TL-015), so a project never depends on this list.
import type { Colorway, TitleLook } from '../model.ts';
import type { LookRecipe } from '../recipe.ts';

/** A factory look: metadata and a recipe, under a library id (`look.<slug>`), not a project id. */
export type FactoryLook = Omit<TitleLook, 'id' | 'appearance' | 'sourceId'> & {
	libraryId: string;
	recipe: LookRecipe;
};

export const FACTORY_LOOKS: readonly FactoryLook[] = [];
export const FACTORY_COLORWAYS: readonly Colorway[] = [];

export const factoryLook = (id: string): FactoryLook | undefined =>
	FACTORY_LOOKS.find((l) => l.libraryId === id);
export const factoryColorway = (id: string): Colorway | undefined =>
	FACTORY_COLORWAYS.find((c) => c.id === id);
