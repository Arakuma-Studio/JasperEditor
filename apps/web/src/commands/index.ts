import '../layer-bake/commands.ts';
import '../fx/register.ts';
import '../simwarp/register.ts';
import '../audio-fx/register.ts';
import '../template-edit/register.ts';
import '../remote-assets/register.ts';
import { audioFxCommands } from '../audio-fx/commands.ts';
import { strokeAnimationCommands } from '../stroke-animation/commands.ts';
import { appCommands } from './app.ts';
import { audioCommands } from './audio.ts';
import { automationCommands } from './automation.ts';
import { briefCommands } from './brief.ts';
import { cacheCommands } from './cache.ts';
import { captionCommands } from './captions.ts';
import { cleanupCommands } from './cleanup.ts';
import { clipboardCommands } from './clipboard.ts';
import { colorCommands } from './color.ts';
import { colorMgmtCommands } from './color-mgmt.ts';
import { compositionCommands } from './composition.ts';
import { easingCommands } from './easing.ts';
import { editCommands } from './edit.ts';
import { editUxCommands } from './edit-ux.ts';
import { exportCommands } from './export.ts';
import { fontCommands } from './fonts.ts';
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
import { proposalCommands } from './proposals.ts';
import { registerCommands } from './registry.ts';
import { rotoCommands } from './roto.ts';
import { scriptFixCommands } from './script-fix.ts';
import { shapeCommands } from './shapes.ts';
import { soundCommands } from './sound.ts';
import { soundBedCommands } from './sound-beds.ts';
import { soundCheckCommands } from './sound-check.ts';
import { soundCueCommands } from './sound-cues.ts';
import { soundDesignCommands } from './sound-design.ts';
import { soundMixCommands } from './sound-mix.ts';
import { speechCommands } from './speech.ts';
import { structureCommands } from './structure.ts';
import { subtitleCommands } from './subtitles.ts';
import { textAnimationCommands } from './text-animation.ts';
import { textStyleCommands } from './text-styles.ts';
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
	strokeAnimationCommands,
	clipboardCommands,
	layerCommands,
	cacheCommands,
	structureCommands,
	projectFileCommands,
	maskCommands,
	captionCommands,
	speechCommands,
	// spec 14: Clean Up Voice (Text panel ▸ Transcript ▸ Clean Up)
	cleanupCommands,
	// spec 17: Fix Transcript, Script…
	scriptFixCommands,
	// spec 18 AF-BRF-006: Sequence ▸ Brief…
	briefCommands,
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
	easingCommands,
	// sound-design (spec 12): Sound Library, Cue Seam
	soundCommands,
	soundCueCommands,
	soundDesignCommands,
	automationCommands,
	soundMixCommands,
	soundBedCommands,
	soundCheckCommands,
	// proposals (spec 12 §2.5): review in the Timeline, Hear proposal
	proposalCommands,
	// wp fonts: the user font library (Preferences ▸ Fonts, Resolve Fonts)
	fontCommands,
	// spec 13 AS-032: Select ▸ Same Style, linked text styles
	textStyleCommands,
	// spec 13 AS-040: Create Subtitles, Align Subtitles to Cuts, Select ▸ Subtitle Group / Same Template
	subtitleCommands,
];

let registered = false;
/** Registers every domain module (idempotent). */
export function registerAllCommands(): void {
	if (registered) return;
	registered = true;
	for (const list of COMMAND_MODULES) registerCommands(list);
}
