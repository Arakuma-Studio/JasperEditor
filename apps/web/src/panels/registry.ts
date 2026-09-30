// Panel registry (ARCHITECTURE §7.2, S05:PN-001): the Window menu, palette, dock deserializer, touch
// shells and the agent's UI catalog are generated from this list. One import per panel folder.
import agent from './agent/index.ts';
import audioMeters from './audioMeters/index.ts';
import effectControls from './effectControls/index.ts';
import effects from './effects/index.ts';
import history from './history/index.ts';
import info from './info/index.ts';
import jobs from './jobs/index.ts';
import markers from './markers/index.ts';
import motionTemplates from './motionTemplates/index.ts';
import program from './program/index.ts';
import project from './project/index.ts';
import properties from './properties/index.ts';
import source from './source/index.ts';
import timeline from './timeline/index.ts';
import tools from './tools/index.ts';
import type { PanelDefinition, PanelKind } from './types.ts';

export const PANEL_DEFINITIONS: readonly PanelDefinition[] = [
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
	agent,
	jobs,
];

const BY_KIND = new Map(PANEL_DEFINITIONS.map((d) => [d.kind, d]));

export function getPanelDefinition(kind: PanelKind): PanelDefinition {
	const d = BY_KIND.get(kind);
	if (!d) throw new Error(`Unknown panel kind ${kind}`);
	return d;
}

export function listPanels(): readonly PanelDefinition[] {
	return PANEL_DEFINITIONS;
}
