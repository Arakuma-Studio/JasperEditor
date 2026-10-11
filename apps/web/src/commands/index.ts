import '../layer-bake/commands.ts';
import '../fx/register.ts';
import '../simwarp/register.ts';
import '../audio-fx/register.ts';
import { audioFxCommands } from '../audio-fx/commands.ts';
import { appCommands } from './app.ts';
import { audioCommands } from './audio.ts';
import { cacheCommands } from './cache.ts';
import { captionCommands } from './captions.ts';
import { clipboardCommands } from './clipboard.ts';
import { colorCommands } from './color.ts';
import { colorMgmtCommands } from './color-mgmt.ts';
import { compositionCommands } from './composition.ts';
import { editCommands } from './edit.ts';
import { editUxCommands } from './edit-ux.ts';
import { exportCommands } from './export.ts';
import { gapsCommands } from './gaps.ts';
import { helpCommands } from './help.ts';
import { importsCommands } from './imports.ts';
import { inspectorCommands } from './inspector.ts';
import { integrationCommands } from './integration.ts';
import { interchangeCommands } from './interchange.ts';
import { layerCommands } from './layer.ts';
import { maskCommands } from './masks.ts';
import { mgCommands } from './mg.ts';
import { monitorViewCommands } from './monitor-view.ts';
import { multicamCommands } from './multicam.ts';
import { polishCommands } from './polish.ts';
import { previewCommands } from './previews.ts';
import { processCommands } from './process.ts';
import { projectCommands } from './project.ts';
import { projectFileCommands } from './project-files.ts';
import { registerCommands } from './registry.ts';
import { rotoCommands } from './roto.ts';
import { shapeCommands } from './shapes.ts';
import { speechCommands } from './speech.ts';
import { structureCommands } from './structure.ts';
import { textAnimationCommands } from './text-animation.ts';
import { threeDCommands } from './three-d.ts';
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
	previewCommands,
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
	colorMgmtCommands,
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
	importsCommands,
	monitorViewCommands,
	threeDCommands,
	gapsCommands,
	polishCommands,
];

let registered = false;
/** Registers every domain module (idempotent). */
export function registerAllCommands(): void {
	if (registered) return;
	registered = true;
	for (const list of COMMAND_MODULES) registerCommands(list);
}
