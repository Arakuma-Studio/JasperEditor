// UI commands (ARCHITECTURE §7.3): imports every domain module and registers them once.

// Register the Program overlay that attaches the layer-bake runtime.
import '../layer-bake/commands.ts';
import { appCommands } from './app.ts';
import { cacheCommands } from './cache.ts';
import { clipboardCommands } from './clipboard.ts';
import { colorCommands } from './color.ts';
import { compositionCommands } from './composition.ts';
import { editCommands } from './edit.ts';
import { exportCommands } from './export.ts';
import { helpCommands } from './help.ts';
import { inspectorCommands } from './inspector.ts';
import { integrationCommands } from './integration.ts';
import { layerCommands } from './layer.ts';
import { mgCommands } from './mg.ts';
import { processCommands } from './process.ts';
import { projectCommands } from './project.ts';
import { registerCommands } from './registry.ts';
import { shapeCommands } from './shapes.ts';
import { textAnimationCommands } from './text-animation.ts';
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
	colorCommands,
	processCommands,
	compositionCommands,
	trackingCommands,
	transitionCommands,
	textAnimationCommands,
	shapeCommands,
	clipboardCommands,
	layerCommands,
	cacheCommands,
];

let registered = false;
/** Registers every domain module (idempotent). */
export function registerAllCommands(): void {
	if (registered) return;
	registered = true;
	for (const list of COMMAND_MODULES) registerCommands(list);
}
