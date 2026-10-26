import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

/** Premiere's Text panel — Transcript (text-based editing), Captions and Subtitles tabs. */
const text: PanelDefinition = {
	kind: 'text',
	title: () => 'Text',
	icon: 'panel.text',
	instance: 'single',
	minSize: { w: 260, h: 160 },
	keymapScope: 'text',
	touch: 'sheet',
	agentDescription:
		'Text panel: the sequence transcript (search, select words to mark In/Out, extract, lift, remove fillers and pauses, speakers, create captions), its Clean Up mode (Sequence ▸ Clean Up Voice…: analyze the speech, review retakes / fillers / pauses with the cleanup.* commands, play the result, apply in one undo step), the caption list of the active caption track (edit text and timecodes, search/replace, style) and the subtitle groups of text clips (Create Subtitles, align to cuts, regenerate, templates, export).',
	menu: [
		{ type: 'command', command: 'timeline.addCaptionTrack', label: 'Add New Caption Track…' },
		{ type: 'command', command: 'timeline.addCaptionAtPlayhead', label: 'Add Caption at Playhead' },
		{ type: 'command', command: 'captions.import', label: 'Import Captions…' },
		{ type: 'command', command: 'captions.export', label: 'Export Captions…' },
		{ type: 'separator' },
		{ type: 'command', command: 'transcript.import', label: 'Import Transcript…' },
		{ type: 'command', command: 'transcript.createCaptions', label: 'Create Captions…' },
		{ type: 'command', command: 'subtitles.create', label: 'Create Subtitles…' },
		{ type: 'command', command: 'subtitles.alignToCuts', label: 'Align Subtitles to Cuts' },
		{ type: 'command', command: 'transcript.cleanUpVoice', label: 'Clean Up Voice…' },
	],
	component: lazyPanel(() => import('./TextPanel.tsx'), 'TextPanel'),
};
export default text;
