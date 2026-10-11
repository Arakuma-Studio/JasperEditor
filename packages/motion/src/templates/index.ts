// @jasper/motion/templates — React implementations of the anime templates (S11 §5, ARCHITECTURE §20.2), keyed
// `id@version` like the `renderer: 'anime'` entries of @jasper/mg-templates.
// Owner: wp-m2-anime-templates.
import type { ComponentType } from 'react';
import { Callout } from './callout.tsx';
import { Counter } from './counter.tsx';
import { LowerThirdAnim } from './lower-third-anim.tsx';
import { TitleReveal } from './title-reveal.tsx';
import type { AnimeTemplateProps } from './types.ts';

export type { AnimeTemplateProps } from './types.ts';

/** The shipped implementations (S11:ATP-001/003). */
export const ANIME_TEMPLATE_IMPLS: Readonly<Record<string, ComponentType<AnimeTemplateProps>>> =
	Object.freeze({
		'title-reveal@1': TitleReveal,
		'lower-third-anim@1': LowerThirdAnim,
		'callout@1': Callout,
		'counter@1': Counter,
	});
