// M2 UI commands for shapes (S11:SHP-006): graphics.newRectangle / graphics.newEllipse (Graphics ▸ New Layer,
// currently unregistered: the menu entries stay disabled) and the Program monitor Rectangle / Ellipse tools.
// Owner: wp-m2-shapes (ARCHITECTURE §20.6). This module is imported at start-up (commands/index.ts), so it is also
// where the package registers its UI extensions (Properties ▸ Shape section, Effect Controls rows).
// Contracts: empty.
import type { UiCommand } from './types.ts';

export const shapeCommands: UiCommand[] = [];
