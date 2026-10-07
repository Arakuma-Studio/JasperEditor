// Effect family "simulation-warp" (sim-warp workstream): After Effects' Simulation category (particles, shatter, cards,
// foam, waves, caustics, weather) and the mesh / brush warps of Distort (Puppet, Liquify, Mesh Warp, Bezier Warp,
// Reshape, Smear, Displacement Map, Optics Compensation, Polar Coordinates), under neutral names. Ids
// `jasper.<kebab>`; Effects-panel folders = categories (Simulation, Distort, Transition). The entries live under
// ./simulation-warp/ (one file per group); this file is the family's single export.
// Design and verified behaviour: docs/wp-notes/sim-warp.md. Authoring guide: docs/wp-notes/fx-shader-framework.md.
import type { EffectSpec } from '../effects.ts';
import { CARD_EFFECTS, CARD_TRANSITION_EFFECTS } from './simulation-warp/cards.ts';
import { SHATTER_EFFECTS } from './simulation-warp/shatter.ts';
import { PARTICLE_EFFECTS } from './simulation-warp/particles.ts';
import { WEATHER_EFFECTS } from './simulation-warp/weather.ts';

export const SIMULATION_WARP_EFFECTS: readonly EffectSpec[] = [
	...PARTICLE_EFFECTS,
	...CARD_EFFECTS,
	...SHATTER_EFFECTS,
	...WEATHER_EFFECTS,
	...CARD_TRANSITION_EFFECTS,
];
