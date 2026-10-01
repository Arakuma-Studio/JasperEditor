// UI commands (ARCHITECTURE §7.3): imports every domain module and registers them once.
import { appCommands } from './app.ts';
import { colorCommands } from './color.ts';
import { compositionCommands } from './composition.ts';
import { editCommands } from './edit.ts';
import { exportCommands } from './export.ts';
import { helpCommands } from './help.ts';
import { inspectorCommands } from './inspector.ts';
import { integrationCommands } from './integration.ts';
import { mgCommands } from './mg.ts';
import { processCommands } from './process.ts';
import { projectCommands } from './project.ts';
import { registerCommands } from './registry.ts';
import { timelineCommands } from './timeline.ts';
import { trackingCommands } from './tracking.ts';
import { transitionCommands } from './transitions.ts';
import { transportCommands } from './transport.ts';
import type { UiCommand } from './types.ts';

export * from './context.ts';
export * from './keymap-defaults.ts';
export * from './registry.ts';
export * from './types.ts';

const COMMAND_MODULES: UiCommand[][] = [
	appCommands,
	editCommands,
	timelineCommands,
	transportCommands,
	inspectorCommands,
	projectCommands,
	exportCommands,
	mgCommands,
	integrationCommands,
	helpCommands,
	// M2 (one module per work package, ARCHITECTURE §19.10)
	colorCommands,
	processCommands,
	compositionCommands,
	trackingCommands,
	transitionCommands,
];

let registered = false;
/** Registers every domain module (idempotent). */
export function registerAllCommands(): void {
	if (registered) return;
	registered = true;
	for (const list of COMMAND_MODULES) registerCommands(list);
}
