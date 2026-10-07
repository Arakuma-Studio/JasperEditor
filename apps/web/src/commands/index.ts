// UI commands (ARCHITECTURE §7.3): imports every domain module and registers them once.

// Register the Program overlay that attaches the layer-bake runtime.
import '../layer-bake/commands.ts';
// Register the fx framework's on-canvas point handles (wave 1).
import '../fx/register.ts';
// audio-fx: Effect Controls editors of the audio effects (EQ curves, dynamics, meters).
import '../audio-fx/register.ts';
import { audioFxCommands } from '../audio-fx/commands.ts';
import { appCommands } from './app.ts';
import { audioCommands } from './audio.ts';
import { cacheCommands } from './cache.ts';
import { captionCommands } from './captions.ts';
import { clipboardCommands } from './clipboard.ts';
import { colorCommands } from './color.ts';
import { compositionCommands } from './composition.ts';
import { editCommands } from './edit.ts';
import { editUxCommands } from './edit-ux.ts';
import { exportCommands } from './export.ts';
import { helpCommands } from './help.ts';
import { inspectorCommands } from './inspector.ts';
import { integrationCommands } from './integration.ts';
import { interchangeCommands } from './interchange.ts';
import { layerCommands } from './layer.ts';
import { maskCommands } from './masks.ts';
import { mgCommands } from './mg.ts';
import { monitorViewCommands } from './monitor-view.ts';
import { multicamCommands } from './multicam.ts';
import { processCommands } from './process.ts';
import { projectCommands } from './project.ts';
import { projectFileCommands } from './project-files.ts';
import { registerCommands } from './registry.ts';
import { rotoCommands } from './roto.ts';
import { shapeCommands } from './shapes.ts';
import { speechCommands } from './speech.ts';
import { structureCommands } from './structure.ts';
import { textAnimationCommands } from './text-animation.ts';
import { timeCommands } from './time.ts';
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
	audioCommands,
	audioFxCommands,
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
	structureCommands,
	projectFileCommands,
	maskCommands,
	captionCommands,
	speechCommands,
	rotoCommands,
	multicamCommands,
	interchangeCommands,
	timeCommands,
	// edit-ux (registered after timeline/transport: trim mode, match frame, subclips, dialogs)
	editUxCommands,
	monitorViewCommands,
];

let registered = false;
/** Registers every domain module (idempotent). */
export function registerAllCommands(): void {
	if (registered) return;
	registered = true;
	for (const list of COMMAND_MODULES) registerCommands(list);
}
