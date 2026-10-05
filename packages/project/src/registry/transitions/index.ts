// The GPU transition catalogue and framework (wave 2; docs/wp-notes/fx-transition-framework.md). Every family file
// exports one `readonly TransitionSpec[]`; `FX_TRANSITIONS` concatenates them in Effects-panel order and is part of
// `TRANSITION_SPECS` (../../transitions.ts), hence of the Effects panel, the timeline, Effect Controls' Transition
// section, the agent schema export / MCP and the renderers. Adding a transition = adding an entry to its family
// file; nothing else changes.
// Import rule (no cycles): family files import values from `./define.ts`, `./glsl.ts`, `./shader.ts`, `../fx/*` and
// only TYPES from `../../transitions.ts` / `../effects.ts`.
import type { TransitionSpec } from '../../transitions.ts';
import { PREMIERE_TRANSITIONS } from './premiere-transitions.ts';
import { SAPPHIRE_DISSOLVE_TRANSITIONS } from './sapphire-dissolves.ts';
import { SAPPHIRE_WIPES_OTHER_TRANSITIONS } from './sapphire-wipes-other.ts';

export * from './define.ts';
export * from './glsl.ts';
export * from './shader.ts';

/** The families, with the id prefix every entry of a family uses (checked by the catalogue test). */
export const TRANSITION_FAMILIES: readonly {
	file: string;
	idPrefix: string;
	transitions: readonly TransitionSpec[];
}[] = [
	{ file: 'premiere-transitions', idPrefix: 'jasper.', transitions: PREMIERE_TRANSITIONS },
	{ file: 'sapphire-dissolves', idPrefix: 'jasper.s.', transitions: SAPPHIRE_DISSOLVE_TRANSITIONS },
	{ file: 'sapphire-wipes-other', idPrefix: 'jasper.s.', transitions: SAPPHIRE_WIPES_OTHER_TRANSITIONS },
];

/** Every GPU transition of the catalogue (registered by default). */
export const FX_TRANSITIONS: readonly TransitionSpec[] = TRANSITION_FAMILIES.flatMap((f) => f.transitions);
