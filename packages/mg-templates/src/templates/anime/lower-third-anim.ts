// lower-third-anim@1 (S11:ATP-003): an accent bar and a panel wipe in, name and role words stagger in, and the
// outro plays the intro in reverse. Metadata only — implementation: packages/motion/src/templates/lower-third-anim.tsx.
import { z } from 'zod';
import { CANVASES } from '../../core.ts';
import type { MgAnimeTemplateDefinition } from '../../types.ts';
import { easeParam, rgbaParam } from './common.ts';

export const lowerThirdAnimParams = z.strictObject({
	name: z.string().max(80).default('Jordan Avery'),
	role: z.string().max(120).default('Director of Photography'),
	nameColor: rgbaParam([1, 1, 1, 1]),
	roleColor: rgbaParam([0.82, 0.86, 0.95, 1]),
	barColor: rgbaParam([0.22, 0.53, 1, 1]),
	panelColor: rgbaParam([0.04, 0.06, 0.12, 0.82]),
	/** Name size in design pixels (the role is 55 % of it). */
	nameSize: z.number().min(20).max(140).default(58),
	/** Margin from the left (side `left`) or right (side `right`) edge of the canvas, 0…1 of the design width. */
	x: z.number().min(0).max(1).default(0.0625),
	/** Top of the panel, 0…1 of the design height. */
	y: z.number().min(0).max(1).default(0.74),
	side: z.enum(['left', 'right']).default('left'),
	ease: easeParam('outExpo'),
});
export type LowerThirdAnimParams = z.output<typeof lowerThirdAnimParams>;

export const lowerThirdAnim: MgAnimeTemplateDefinition<LowerThirdAnimParams> = {
	id: 'lower-third-anim',
	version: 1,
	name: 'Lower Third (Animated)',
	category: 'Lower Thirds',
	description: 'Bar and panel wipe in, name and role words stagger in; the outro reverses the intro.',
	renderer: 'anime',
	renderVersion: 1,
	posterAt: 2.5,
	paramsSchema: lowerThirdAnimParams,
	defaults: lowerThirdAnimParams.parse({}),
	introFrames: 30,
	outroFrames: 21,
	defaultDurationSeconds: 5,
	canvases: [...CANVASES],
};
