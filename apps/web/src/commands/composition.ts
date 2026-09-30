// M2 UI commands: Import Remotion Project…, New Composition Clip, Rebuild Bundle. Owner: wp-m2-mg (ARCHITECTURE §19.10).
// This module is imported at start-up (commands/index.ts), so it is also where the package registers its UI
// extensions (extensions/index.ts: effect editors, clip sections, Program overlays, menu entries).
import type { UiCommand } from './types.ts';

export const compositionCommands: UiCommand[] = [];
