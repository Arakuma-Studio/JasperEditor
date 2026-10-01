// M2 UI commands for text animators (S11:TXA-024): text.applyAnimation (agent-exposed), text.removeAnimation, the
// Graphics ▸ Text Animation menu entries and the clip context submenu. Owner: wp-m2-text-anim (ARCHITECTURE
// §20.6). This module is imported at start-up (commands/index.ts), so it is also where the package registers
// its UI extensions (Properties ▸ Text Animation section, Effect Controls rows, timeline drop target).
// Contracts: empty.
import type { UiCommand } from './types.ts';

export const textAnimationCommands: UiCommand[] = [];
