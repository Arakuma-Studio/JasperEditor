// M2 UI commands: Apply Default Transitions (Ctrl+D, Ctrl+Shift+D, Shift+D), transition editing. Owner: wp-m2-transitions (ARCHITECTURE §19.10).
// This module is imported at start-up (commands/index.ts), so it is also where the package registers its UI
// extensions (extensions/index.ts: effect editors, clip sections, Program overlays, menu entries).
import type { UiCommand } from './types.ts';

export const transitionCommands: UiCommand[] = [];
