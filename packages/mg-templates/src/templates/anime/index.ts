// Anime templates (S11 §5): metadata of the `renderer: 'anime'` catalogue entries. Implementations live in
// `@jasper/motion/templates` (`ANIME_TEMPLATE_IMPLS`, keyed `id@version`).
import type { AnyAnimeMgTemplate } from '../../types.ts';
import { callout } from './callout.ts';
import { counter } from './counter.ts';
import { lowerThirdAnim } from './lower-third-anim.ts';
import { socialComment } from './social-comment.ts';
import { titleReveal } from './title-reveal.ts';

export * from './callout.ts';
export * from './common.ts';
export * from './counter.ts';
export * from './eases.ts';
export * from './lower-third-anim.ts';
export * from './motion.ts';
export * from './social-comment.ts';
export * from './timing.ts';
export * from './title-reveal.ts';

/** The shipped anime templates, in gallery order. */
export const ANIME_CATALOG: readonly AnyAnimeMgTemplate[] = [
	titleReveal,
	lowerThirdAnim,
	callout,
	counter,
	socialComment,
];
