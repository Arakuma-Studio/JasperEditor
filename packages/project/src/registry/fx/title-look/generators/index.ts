// The generators of spec 19 §7. Adding one: a file with `defineGenerator` and one line here. Each entry becomes a
// standalone effect in the `Generate` category and a `generator:<id>` look layer (`registry.ts`), from the same GLSL.
import type { TitleGenerator } from '../contract.ts';
import { GENERATOR_BACKLIGHT } from './backlight.ts';
import { GENERATOR_BRUSH_SWIRL } from './brush-swirl.ts';
import { GENERATOR_CORONA } from './corona.ts';
import { GENERATOR_FIRE } from './fire.ts';
import { GENERATOR_GLINTS } from './glints.ts';
import { GENERATOR_INK_SPLATTER } from './ink-splatter.ts';
import { GENERATOR_LENS_FLARE } from './lens-flare.ts';
import { GENERATOR_LIGHT_STREAKS } from './light-streaks.ts';
import { GENERATOR_LIGHTNING } from './lightning.ts';
import { GENERATOR_MAGIC_CIRCLE } from './magic-circle.ts';
import { GENERATOR_PARTICLES } from './particles.ts';
import { GENERATOR_PATTERN } from './pattern.ts';
import { GENERATOR_SHOCKWAVE } from './shockwave.ts';
import { GENERATOR_SMOKE } from './smoke.ts';
import { GENERATOR_SPEED_LINES } from './speed-lines.ts';
import { GENERATOR_SUNBURST } from './sunburst.ts';

export const TITLE_GENERATORS: readonly TitleGenerator[] = [
	GENERATOR_FIRE,
	GENERATOR_SMOKE,
	GENERATOR_CORONA,
	GENERATOR_SUNBURST,
	GENERATOR_MAGIC_CIRCLE,
	GENERATOR_LENS_FLARE,
	GENERATOR_BACKLIGHT,
	GENERATOR_LIGHT_STREAKS,
	GENERATOR_SHOCKWAVE,
	GENERATOR_PARTICLES,
	GENERATOR_GLINTS,
	GENERATOR_INK_SPLATTER,
	GENERATOR_BRUSH_SWIRL,
	GENERATOR_SPEED_LINES,
	GENERATOR_LIGHTNING,
	GENERATOR_PATTERN,
];
