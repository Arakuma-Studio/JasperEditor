// UI commands (ARCHITECTURE §7.3): imports every domain module and registers them once.
import { appCommands } from './app.ts';
import { editCommands } from './edit.ts';
import { exportCommands } from './export.ts';
import { helpCommands } from './help.ts';
import { inspectorCommands } from './inspector.ts';
import { integrationCommands } from './integration.ts';
import { mgCommands } from './mg.ts';
import { projectCommands } from './project.ts';
import { registerCommands } from './registry.ts';
import { timelineCommands } from './timeline.ts';
import { transportCommands } from './transport.ts';
import type { UiCommand } from './types.ts';

export * from './context.ts';
export * from './keymap-defaults.ts';
export * from './registry.ts';
export * from './types.ts';

export const COMMAND_MODULES: Record<string, UiCommand[]> = {
	app: appCommands,
	edit: editCommands,
	timeline: timelineCommands,
	transport: transportCommands,
	inspector: inspectorCommands,
	project: projectCommands,
	export: exportCommands,
	mg: mgCommands,
	integration: integrationCommands,
	help: helpCommands,
};

let registered = false;
/** Registers every domain module (idempotent). */
export function registerAllCommands(): void {
	if (registered) return;
	registered = true;
	for (const list of Object.values(COMMAND_MODULES)) registerCommands(list);
}
