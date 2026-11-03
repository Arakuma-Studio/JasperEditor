// Spec 19 TL-050 / TL-051 / TL-052: the factory library, as data. Adding a look: an entry in its category's file under
// `looks/`, a colourway: an entry in `colorways.ts`, a template: an entry under `templates/`. `look.apply` copies a factory
// look into the project on first use (TL-015), so a project never depends on this list. The UI and the agents read
// `FACTORY_LOOKS`, `FACTORY_COLORWAYS`, `LOOK_CATEGORIES`, `FACTORY_TEMPLATES` and `searchLooks`.
import type { FactoryLook } from './build.ts';
import { LOOK_CATEGORIES } from './categories.ts';
import { FACTORY_COLORWAYS } from './colorways.ts';
import { BRUSH_LOOKS } from './looks/brush.ts';
import { CINEMATIC_LOOKS } from './looks/cinematic.ts';
import { CLEAN_LOOKS } from './looks/clean.ts';
import { COMIC_LOOKS } from './looks/comic.ts';
import { CORPORATE_LOOKS } from './looks/corporate.ts';
import { DRAWN_DEPTH_LOOKS } from './looks/drawn-depth.ts';
import { GAMING_LOOKS } from './looks/gaming.ts';
import { HORROR_LOOKS } from './looks/horror.ts';
import { JAPANESE_VARIETY_LOOKS } from './looks/japanese-variety.ts';
import { LUXURY_LOOKS } from './looks/luxury.ts';
import { NEON_RETRO_LOOKS } from './looks/neon-retro.ts';
import { PACHINKO_ARCADE_LOOKS } from './looks/pachinko-arcade.ts';
import { PLAYFUL_LOOKS } from './looks/playful.ts';
import { SOCIAL_LOOKS } from './looks/social.ts';
import { SPORTS_LOOKS } from './looks/sports.ts';

export type { FactoryColorway, FactoryLook } from './build.ts';
export { LOOK_CATEGORIES, type LookCategory, lookCategory } from './categories.ts';
export { FACTORY_COLORWAYS } from './colorways.ts';
export { foldSearchText, type LookQuery, lookSearchEntry, searchLooks } from './search.ts';

/** Library order: the order of `LOOK_CATEGORIES`, general styles first. */
export const FACTORY_LOOKS: readonly FactoryLook[] = [
	...CLEAN_LOOKS,
	...CORPORATE_LOOKS,
	...CINEMATIC_LOOKS,
	...SPORTS_LOOKS,
	...GAMING_LOOKS,
	...NEON_RETRO_LOOKS,
	...COMIC_LOOKS,
	...LUXURY_LOOKS,
	...HORROR_LOOKS,
	...PLAYFUL_LOOKS,
	...SOCIAL_LOOKS,
	...JAPANESE_VARIETY_LOOKS,
	...PACHINKO_ARCADE_LOOKS,
	...BRUSH_LOOKS,
	...DRAWN_DEPTH_LOOKS,
];

export const factoryLook = (id: string): FactoryLook | undefined =>
	FACTORY_LOOKS.find((l) => l.libraryId === id);
export const factoryColorway = (id: string) => FACTORY_COLORWAYS.find((c) => c.id === id);

/** How many looks each category holds, in category order (every category is listed). */
export function lookCategoryCounts(): { id: string; count: number }[] {
	return LOOK_CATEGORIES.map((c) => ({
		id: c.id,
		count: FACTORY_LOOKS.filter((l) => l.category === c.id).length,
	}));
}
