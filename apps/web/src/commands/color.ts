// M2 UI commands: Lumetri panel/Color workspace commands, effect editors (registerEffectEditor), scopes. Owner: wp-m2-color (ARCHITECTURE §19.10).
// This module is imported at start-up (commands/index.ts), so it is also where the package registers its UI
// extensions (extensions/index.ts: effect editors, clip sections, Program overlays, menu entries).
import type { UiCommand } from './types.ts';

export const colorCommands: UiCommand[] = [];
