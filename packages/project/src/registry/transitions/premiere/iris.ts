// Premiere ▸ Video Transitions ▸ Iris (part of the premiere-transitions family; Iris Round lives in
// ../premiere-transitions.ts). Each iris grows a shape of the frame's proportions around the Center point, from
// nothing (a margin below zero, so not even an anti-aliased dot shows at p = 0) to a margin past the farthest corner.
import type { TransitionSpec } from '../../../transitions.ts';
import { TRANSITION_BINS } from '../define.ts';
import { defineEdgeWipe } from './common.ts';

const bin = TRANSITION_BINS.iris;

/** Shared preamble: centre px, the farthest extent from it per axis (rx, ry) and the aspect. */
const PRE = /* glsl */ `
  vec2 c = u_center * u_compSize;
  vec2 q = px - c;
  vec2 far = max(c, u_compSize - c);
  float asp = tr_aspect();`;

/** Iris ▸ Iris Box: B appears in a rectangle (the frame's proportions) growing from the centre. */
export const IRIS_BOX = defineEdgeWipe({
	id: 'jasper.iris-box',
	label: 'Iris Box',
	bin,
	description: 'The incoming clip is revealed through a box of the frame’s proportions that opens from the center point.',
	keywords: ['iris', 'box', 'square', 'rectangle', 'reveal'],
	center: true,
	body: `${PRE}
  // Half size (asp·s, s): s in px of half height. Fully open when both half sizes reach the farthest edges.
  float full = max(far.y, far.x / asp);
  float s = pr_grow(p, full, m / min(asp, 1.0));
  d = pr_box(px, c, vec2(asp * s, s));`,
});

/** Iris ▸ Iris Diamond: B appears in a diamond growing from the centre. */
export const IRIS_DIAMOND = defineEdgeWipe({
	id: 'jasper.iris-diamond',
	label: 'Iris Diamond',
	bin,
	description: 'The incoming clip is revealed through a diamond that opens from the center point.',
	keywords: ['iris', 'diamond', 'rhombus', 'reveal'],
	center: true,
	body: `${PRE}
  // |x|/asp + |y| <= s (s in px of half height); distance to the edge lines in px.
  float g = length(vec2(1.0 / asp, 1.0));
  float full = far.x / asp + far.y;
  float s = pr_grow(p, full, m * g);
  d = (s - (abs(q.x) / asp + abs(q.y))) / g;`,
});

/** Iris ▸ Iris Cross: B appears in a plus sign whose arms reach the edges, then widen. */
export const IRIS_CROSS = defineEdgeWipe({
	id: 'jasper.iris-cross',
	label: 'Iris Cross',
	bin,
	description: 'The incoming clip is revealed through a cross that opens from the center point: the arms reach out, then widen.',
	keywords: ['iris', 'cross', 'plus', 'reveal'],
	center: true,
	body: `${PRE}
  // Two bars of thickness 2s: a horizontal one 2·s·asp long each way and a vertical one 2·s. They reach the edges
  // at the same time; the cross is fully open when one bar covers the frame.
  float full = min(max(far.y, far.x / (2.0 * asp)), max(far.x, far.y / 2.0));
  float s = pr_grow(p, full, m);
  float sp = max(s, 0.0);
  float h = tr_boxDist(px, c, vec2(2.0 * asp * sp, sp));
  float v = tr_boxDist(px, c, vec2(sp, 2.0 * sp));
  d = max(h, v) + min(s, 0.0);`,
});

export const PREMIERE_IRISES: readonly TransitionSpec[] = [IRIS_BOX, IRIS_CROSS, IRIS_DIAMOND];
