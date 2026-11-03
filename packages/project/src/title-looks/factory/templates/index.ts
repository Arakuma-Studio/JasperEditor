// Spec 19 TL-052: the title templates of the library. Adding one: an entry in a file here. Search: `searchTemplates`.
import type { CostClass } from '../../../three-d/scene-look.ts';
import { SURFACE_PRESETS } from '../../../three-d/surfaces.ts';
import { foldSearchText } from '../search.ts';
import { FULL_SCREEN_TEMPLATES } from './full-screen.ts';
import { LOWER_THIRD_TEMPLATES } from './lower-thirds.ts';
import { SOCIAL_TEMPLATES } from './social.ts';
import { THREE_D_TEMPLATES } from './three-d.ts';
import type { TitleTemplate } from './types.ts';

export * from './types.ts';

export const FACTORY_TEMPLATES: readonly TitleTemplate[] = [
	...LOWER_THIRD_TEMPLATES,
	...FULL_SCREEN_TEMPLATES,
	...SOCIAL_TEMPLATES,
	...THREE_D_TEMPLATES,
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

/**
 * What a template costs to export (TL-078), as `costClassOf` says of the clips it makes: `fast` without a solid; a solid
 * never bakes and renders every frame on the Remotion path, and glints, inflate or a transmissive material make it heavy.
 */
export function templateCostClass(t: TitleTemplate): CostClass {
	const solids = t.clips.flatMap((c) => (c.kind === 'text' && c.solid ? [c.solid] : []));
	if (!solids.length) return 'fast';
	const transmits = (id: string | undefined) => !!id && (SURFACE_PRESETS[id]?.values.transmission ?? 0) > 0;
	const heavy =
		!!t.scene3d?.glint ||
		solids.some(
			(s) =>
				!!s.inflate ||
				[
					s.material,
					...Object.values(s.surfaces ?? {}),
					...(s.bands ?? []).map((b) => b.material),
					...(s.plates ?? []).map((p) => p.material),
				].some(transmits),
		);
	return heavy ? '3d-heavy' : '3d';
}
