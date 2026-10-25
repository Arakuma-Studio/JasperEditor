// Test-only anime template for the template-assets render test (social-comment §7.8): it declares a font and the
// emoji of its text, like the social-comment template does. Never part of the shipped catalogue: the test bundle
// aliases `@jasper/mg-templates` / `@jasper/motion/templates` to modules that add it. It borrows Title Reveal's params
// (`title` is its text).

import { emojiGraphemes } from '../../../mg-templates/src/emoji.ts';
import { ANIME_CATALOG } from '../../../mg-templates/src/templates/anime/index.ts';
import type { AnyMgTemplate } from '../../../mg-templates/src/types.ts';

export const PROBE_FAMILY = 'Probe Sans';

const titleReveal = ANIME_CATALOG.find((d) => d.id === 'title-reveal')!;

export const PROBE_DEF: AnyMgTemplate = {
	...titleReveal,
	id: 'asset-probe',
	version: 1,
	name: 'Asset probe',
	category: 'Test',
	upgrades: [],
	requiredAssets: (p: Record<string, unknown>) => ({
		fonts: [{ family: PROBE_FAMILY, weight: 700, style: 'normal' as const }],
		emoji: { pack: 'apple' as const, graphemes: emojiGraphemes(String(p.title ?? '')) },
	}),
} as AnyMgTemplate;
