// The generators of spec 19 §7. Adding one: a file with `defineGenerator` and one line here. Each entry becomes a
// standalone effect in the `Generate` category and a `generator:<id>` look layer (`registry.ts`), from the same GLSL.
import type { TitleGenerator } from '../contract.ts';
import { GENERATOR_CORONA } from './corona.ts';
import { GENERATOR_FIRE } from './fire.ts';
import { GENERATOR_SMOKE } from './smoke.ts';

export const TITLE_GENERATORS: readonly TitleGenerator[] = [GENERATOR_FIRE, GENERATOR_SMOKE, GENERATOR_CORONA];
