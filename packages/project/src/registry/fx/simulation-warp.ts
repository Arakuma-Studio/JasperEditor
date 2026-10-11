// Effect family "simulation-warp": After Effects' Simulation category (particles, shatter, cards,
// foam, waves, caustics, weather) and the mesh / brush warps of Distort (Puppet, Liquify, Mesh Warp, Bezier Warp,
// Reshape, Smear, Displacement Map, Optics Compensation, Polar Coordinates), under neutral names. Ids
// `jasper.<kebab>`; Effects-panel folders = categories (Simulation, Distort, Transition). The entries live under
// ./simulation-warp/ (one file per group); this file is the family's single export.
// Design and verified behaviour: docs/wp-notes/sim-warp.md. Authoring guide: docs/wp-notes/fx-shader-framework.md.
import type { EffectSpec } from '../effects.ts';
import { CARD_EFFECTS, CARD_TRANSITION_EFFECTS } from './simulation-warp/cards.ts';
import { CAUSTICS_EFFECTS } from './simulation-warp/caustics.ts';
import { DISTORT_EFFECTS } from './simulation-warp/distort.ts';
import { FOAM_EFFECTS } from './simulation-warp/foam.ts';
import { MESH_WARP_EFFECTS } from './simulation-warp/mesh-warps.ts';
import { PARTICLE_EFFECTS } from './simulation-warp/particles.ts';
import { PIXEL_FX_EFFECTS } from './simulation-warp/pixel-fx.ts';
import { PLAYGROUND_EFFECTS } from './simulation-warp/playground.ts';
import { PUPPET_EFFECTS } from './simulation-warp/puppet.ts';
import { SHATTER_EFFECTS } from './simulation-warp/shatter.ts';
import { WAVE_WORLD_EFFECTS } from './simulation-warp/wave-world.ts';
import { WEATHER_EFFECTS } from './simulation-warp/weather.ts';

export const SIMULATION_WARP_EFFECTS: readonly EffectSpec[] = [
	...PARTICLE_EFFECTS,
	...PLAYGROUND_EFFECTS,
	...CARD_EFFECTS,
	...SHATTER_EFFECTS,
	...PIXEL_FX_EFFECTS,
	...FOAM_EFFECTS,
	...WAVE_WORLD_EFFECTS,
	...CAUSTICS_EFFECTS,
	...WEATHER_EFFECTS,
	...CARD_TRANSITION_EFFECTS,
	...DISTORT_EFFECTS,
	...MESH_WARP_EFFECTS,
	...PUPPET_EFFECTS,
];
