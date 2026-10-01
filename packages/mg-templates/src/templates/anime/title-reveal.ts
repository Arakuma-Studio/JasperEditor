// title-reveal@1 (S11:ATP-003): a char-staggered title and a subtitle with an underline drawn on; the outro plays
// the stagger backwards. Metadata only — implementation: packages/motion/src/templates/title-reveal.tsx.
import { z } from 'zod';
import { CANVASES } from '../../core.ts';
import type { MgAnimeTemplateDefinition } from '../../types.ts';
import { easeParam, rgbaParam } from './common.ts';

export const titleRevealParams = z.strictObject({
	title: z.string().max(120).default('Title Reveal'),
	subtitle: z.string().max(200).default('An animated title'),
	titleColor: rgbaParam([1, 1, 1, 1]),
	subtitleColor: rgbaParam([1, 1, 1, 0.85]),
	accentColor: rgbaParam([0.22, 0.53, 1, 1]),
	/** Title size in design pixels (the subtitle is 40 % of it). */
	titleSize: z.number().min(24).max(240).default(110),
	alignment: z.enum(['left', 'center', 'right']).default('center'),
	/** Vertical position of the title baseline block, 0 (top) … 1 (bottom) of the design canvas. */
	y: z.number().min(0).max(1).default(0.5),
	/** Fraction of the intro spread across the characters (0 = all together). */
	stagger: z.number().min(0).max(1).default(0.55),
	/** Order of the characters: forward, from the centre out, or shuffled by the clip seed. */
	order: z.enum(['forward', 'center', 'random']).default('forward'),
	ease: easeParam('outExpo'),
	underline: z.boolean().default(true),
});
export type TitleRevealParams = z.output<typeof titleRevealParams>;

export const titleReveal: MgAnimeTemplateDefinition<TitleRevealParams> = {
	id: 'title-reveal',
	version: 1,
	name: 'Title Reveal',
	category: 'Titles',
	description: 'Characters rise in one by one, the subtitle follows and an accent underline draws on.',
	renderer: 'anime',
	// 2: drawing clipped to the canvas (preview = hybrid export).
	renderVersion: 2,
	posterAt: 2,
	paramsSchema: titleRevealParams,
	defaults: titleRevealParams.parse({}),
	introFrames: 36,
	outroFrames: 18,
	defaultDurationSeconds: 5,
	canvases: [...CANVASES],
};
