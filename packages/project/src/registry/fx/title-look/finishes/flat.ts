// `flat`: the paint as it is. Every other finish (§5.1) has this shape: GLSL `tl_finish`, params named after the finish.
import { defineFinish } from '../contract.ts';

export const FINISH_FLAT = defineFinish({
	id: 'flat',
	label: 'Flat',
	description: 'The paint as it is.',
	params: [],
	glsl: /* glsl */ `vec4 tl_finish(vec4 paint, TlSurface s) { return paint; }`,
});
