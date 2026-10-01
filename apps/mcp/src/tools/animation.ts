// M2 MCP tools for text animators (S11:ANA-002, ARCHITECTURE §20.7): list_text_animations, set_text_animation
// (in/out presets, durations, params; null removes) and `add_text` animateIn/animateOut (editing.ts hunk).
// Owner: wp-m2-text-anim. Contracts: no tools yet.
import type { ToolContext } from '../context.ts';

/** Appended to the server instructions (EDITING_GUIDE) when non-empty. */
export const ANIMATION_GUIDE = '';

export function registerAnimationTools(_ctx: ToolContext): void {
	// wp-m2-text-anim registers its tools here.
}
