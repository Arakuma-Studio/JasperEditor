// @jasper/motion/templates — React implementations of the anime templates (S11 §5, ARCHITECTURE §20.2), keyed
// `id@version` like the `renderer: 'anime'` entries of @jasper/mg-templates.
import type { ComponentType } from 'react';
import { Callout } from './callout.tsx';
import { Counter } from './counter.tsx';
import { LowerThirdAnim } from './lower-third-anim.tsx';
import { TitleReveal } from './title-reveal.tsx';
import type { AnimeTemplateProps } from './types.ts';

export {
	buildCallout,
	buildCalloutLine,
	CALLOUT_LINE_PHASE,
	CALLOUT_PULSE_PHASE,
	Callout,
	calloutGeometry,
} from './callout.tsx';
export { addInOut, phaseTimes, staggerRanks, TEMPLATE_FONT, type TemplateTiming } from './common.tsx';
export {
	buildCounter,
	buildCounterCount,
	Counter,
	counterCountMs,
	counterProgressAt,
	counterValue,
} from './counter.tsx';
export { buildLowerThirdAnim, LowerThirdAnim } from './lower-third-anim.tsx';
export { buildTitleReveal, TitleReveal, titleSegments } from './title-reveal.tsx';
export type { AnimeTemplateProps } from './types.ts';

export const ANIME_TEMPLATE_IMPLS: Readonly<Record<string, ComponentType<AnimeTemplateProps>>> =
	Object.freeze({
		'title-reveal@1': TitleReveal,
		'lower-third-anim@1': LowerThirdAnim,
		'callout@1': Callout,
		'counter@1': Counter,
	});
