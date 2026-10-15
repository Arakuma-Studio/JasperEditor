// Panel registry (ARCHITECTURE §7.2, S05:PN-001): the Window menu, palette, dock deserializer, touch
// shells and the agent's UI catalog are generated from this list. One import per panel folder.
import audioClipMixer from './audioClipMixer/index.ts';
import audioMeters from './audioMeters/index.ts';
import audioTrackMixer from './audioTrackMixer/index.ts';
import effectControls from './effectControls/index.ts';
import effects from './effects/index.ts';
import essentialGraphics from './essentialGraphics/index.ts';
import essentialSound from './essentialSound/index.ts';
import history from './history/index.ts';
import info from './info/index.ts';
import jobs from './jobs/index.ts';
import lumetri from './lumetri/index.ts';
import markers from './markers/index.ts';
import mediaBrowser from './mediaBrowser/index.ts';
import motionTemplates from './motionTemplates/index.ts';
import program from './program/index.ts';
import project from './project/index.ts';
import properties from './properties/index.ts';
import scopes from './scopes/index.ts';
import soundLibrary from './soundLibrary/index.ts';
import source from './source/index.ts';
import text from './text/index.ts';
import timeline from './timeline/index.ts';
import tools from './tools/index.ts';
import type { PanelDefinition } from './types.ts';

const PANEL_DEFINITIONS: readonly PanelDefinition[] = [
	project,
	source,
	program,
	timeline,
	tools,
	effectControls,
	effects,
	properties,
	motionTemplates,
	audioMeters,
	history,
	info,
	markers,
	jobs,
	lumetri,
	scopes,
	audioTrackMixer,
	audioClipMixer,
	text,
	essentialSound,
	essentialGraphics,
	mediaBrowser,
	soundLibrary,
];

export function listPanels(): readonly PanelDefinition[] {
	return PANEL_DEFINITIONS;
}
