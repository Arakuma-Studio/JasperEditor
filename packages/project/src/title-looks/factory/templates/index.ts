// Spec 19 TL-052: the title templates of the library. Adding one: an entry in a file here. Search: `searchTemplates`.
import { foldSearchText } from '../search.ts';
import { FULL_SCREEN_TEMPLATES } from './full-screen.ts';
import { LOWER_THIRD_TEMPLATES } from './lower-thirds.ts';
import { SOCIAL_TEMPLATES } from './social.ts';
import type { TitleTemplate } from './types.ts';

export * from './types.ts';

export const FACTORY_TEMPLATES: readonly TitleTemplate[] = [
	...LOWER_THIRD_TEMPLATES,
	...FULL_SCREEN_TEMPLATES,
	...SOCIAL_TEMPLATES,
];

export const factoryTemplate = (id: string): TitleTemplate | undefined =>
	FACTORY_TEMPLATES.find((t) => t.id === id);

/** Templates whose text holds every word of `query`, folded like the look search; library order. */
export function searchTemplates(query: string): TitleTemplate[] {
	const words = foldSearchText(query).split(/\s+/).filter(Boolean);
	return FACTORY_TEMPLATES.filter((t) => {
		const text = foldSearchText([t.name, t.nameEs, t.category, t.kind, t.description, ...t.tags].join(' '));
		return words.every((w) => text.includes(w));
	});
}
