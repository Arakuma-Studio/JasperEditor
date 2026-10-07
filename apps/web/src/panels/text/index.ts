import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

/** wp captions: Premiere's Text panel — Transcript (text-based editing) and Captions tabs. */
const text: PanelDefinition = {
	kind: 'text',
	title: () => 'Text',
	icon: 'panel.text',
	instance: 'single',
	minSize: { w: 260, h: 160 },
	keymapScope: 'text',
	touch: 'sheet',
	agentDescription:
		'Text panel: the sequence transcript (search, select words to mark In/Out, extract, lift, remove fillers and pauses, speakers, create captions) and the caption list of the active caption track (edit text and timecodes, search/replace, style).',
	menu: [
		{ type: 'command', command: 'timeline.addCaptionTrack', label: 'Add New Caption Track…' },
		{ type: 'command', command: 'timeline.addCaptionAtPlayhead', label: 'Add Caption at Playhead' },
		{ type: 'command', command: 'captions.import', label: 'Import Captions…' },
		{ type: 'command', command: 'captions.export', label: 'Export Captions…' },
		{ type: 'separator' },
		{ type: 'command', command: 'transcript.import', label: 'Import Transcript…' },
		{ type: 'command', command: 'transcript.createCaptions', label: 'Create Captions…' },
	],
	component: lazyPanel(() => import('./TextPanel.tsx'), 'TextPanel'),
};
export default text;
