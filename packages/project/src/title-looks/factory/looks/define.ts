// A factory look from its authored parts: the palette is its colourway's, by id, so a look cannot drift from the set.
import type { LookFont } from '../../model.ts';
import type { RecipeLayer } from '../../recipe.ts';
import type { FactoryLook } from '../build.ts';
import { FACTORY_COLORWAYS } from '../colorways.ts';

export type LookInit = {
	slug: string;
	name: string;
	nameEs: string;
	tags: string[];
	description: string;
	sampleText: string;
	/** Colourway slugs: the first is the look's own palette, all are shown on its card. */
	colorways: readonly [string, ...string[]];
	font: LookFont;
	/** Bottom-first. */
	layers: RecipeLayer[];
};

export function defineLook(category: string, l: LookInit): FactoryLook {
	const ids = l.colorways.map((s) => `colorway.${s}`);
	const own = FACTORY_COLORWAYS.find((c) => c.id === ids[0]);
	if (!own) throw new Error(`${l.slug}: unknown colourway ${ids[0]}`);
	return {
		libraryId: `look.${l.slug}`,
		name: l.name,
		nameEs: l.nameEs,
		category,
		tags: l.tags,
		description: l.description,
		sampleText: l.sampleText,
		colorwayId: own.id,
		suggestedColorways: ids,
		recipe: { palette: own.palette, font: l.font, layers: l.layers },
	};
}
