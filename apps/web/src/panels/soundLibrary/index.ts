import { lazyPanel } from '../lazy.ts';
import type { PanelDefinition } from '../types.ts';

// Sound Library (spec 12 §2.7, P1-R7): search, audition and insert licensed sound effects peak-aligned at the playhead.
const soundLibrary: PanelDefinition = {
	kind: 'soundLibrary',
	title: () => 'Sound Library',
	icon: 'panel.soundLibrary',
	instance: 'single',
	minSize: { w: 280, h: 220 },
	keymapScope: 'soundLibrary',
	touch: 'sheet',
	requires: ['engine'],
	dockWith: 'essentialSound',
	agentDescription:
		'Sound Library: search licensed sound effects (starter kit, packs, user folders, Jasper Synth) by text, type chips grouped by family, Refine pills (length, tone, attack, weight, texture) and licence (Commercial-safe by default); Space auditions the selected sound, Enter or double-click inserts it with its peak on the playhead (one undo step, Essential Sound type SFX), drag onto the timeline snaps the peak; collections All, Favourites, Recent, Used in this project, Sources.',
	menu: [
		{ type: 'command', command: 'soundLibrary.installStarterKit', label: 'Install Starter Kit' },
		{ type: 'command', command: 'soundLibrary.rescan', label: 'Rescan Library' },
		{ type: 'separator' },
		{ type: 'command', command: 'soundLibrary.toggleCompact', label: 'Compact Rows' },
		{ type: 'command', command: 'soundLibrary.preferences', label: 'Sound Library Preferences…' },
		{ type: 'command', command: 'file.exportSoundCredits', label: 'Export Sound Credits…' },
	],
	component: lazyPanel(() => import('./SoundLibraryPanel.tsx'), 'SoundLibraryPanel'),
};
export default soundLibrary;
