// callout@1 (S11:ATP-003): a target dot pops in, a leader line draws on (anime.js `createDrawable` on an SVG
// leaf) and a label box appears at its end — or, with `motionPath`, travels along the line (`createMotionPath`).
// Metadata only — implementation: packages/motion/src/templates/callout.tsx.
import { z } from 'zod';
import { CANVASES } from '../../core.ts';
import type { MgAnimeTemplateDefinition } from '../../types.ts';
import { easeParam, rgbaParam } from './common.ts';

const unit = (d: number) => z.number().min(0).max(1).default(d);

export const calloutParams = z.strictObject({
	label: z.string().max(80).default('Look here'),
	/** Target point, 0…1 of the design canvas. */
	targetX: unit(0.36),
	targetY: unit(0.62),
	/** Label anchor (the end of the leader line), 0…1 of the design canvas. */
	labelX: unit(0.6),
	labelY: unit(0.32),
	dotColor: rgbaParam([1, 0.78, 0.18, 1]),
	lineColor: rgbaParam([1, 1, 1, 1]),
	boxColor: rgbaParam([0.04, 0.06, 0.12, 0.88]),
	textColor: rgbaParam([1, 1, 1, 1]),
	dotSize: z.number().min(4).max(80).default(18),
	lineWidth: z.number().min(1).max(20).default(4),
	textSize: z.number().min(14).max(120).default(44),
	/** Leader line shape. */
	path: z.enum(['straight', 'curve']).default('curve'),
	/** The label box travels along the leader line during the intro instead of appearing at its end. */
	motionPath: z.boolean().default(false),
	ease: easeParam('inOut'),
});
export type CalloutParams = z.output<typeof calloutParams>;

export const callout: MgAnimeTemplateDefinition<CalloutParams> = {
	id: 'callout',
	version: 1,
	name: 'Callout',
	category: 'Callouts',
	description: 'A target dot, a leader line drawn on and a label box (optionally travelling along the line).',
	renderer: 'anime',
	renderVersion: 1,
	posterAt: 2.5,
	paramsSchema: calloutParams,
	defaults: calloutParams.parse({}),
	introFrames: 42,
	outroFrames: 15,
	defaultDurationSeconds: 5,
	canvases: [...CANVASES],
};
