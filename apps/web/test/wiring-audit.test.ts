// Wiring audit (WP-3I, ARCHITECTURE §7.2/§7.3): every command id referenced by the default keymap or a menu is
// either registered or listed here as intentionally absent in M1 (reason per group). A newly unregistered id
// (typo, dropped registration) fails this test; registering one of the listed ids needs no change here.
import { describe, expect, it } from 'vitest';
import { DEFAULT_KEYMAP, getCommand, registerAllCommands } from '../src/commands/index.ts';
import { PANEL_DEFINITIONS } from '../src/panels/registry.ts';
import { PANEL_KINDS } from '../src/panels/types.ts';
import { MENUBAR } from '../src/shell/menus/model.ts';

/** Not in M1 (ARCHITECTURE §17 / spec priority P1–P2); menus show them disabled with a reason (SH-031). */
const INTENTIONALLY_ABSENT: Record<string, readonly string[]> = {
	'clipboard (S01 §20, M2)': [
		'edit.cut',
		'edit.copy',
		'edit.paste',
		'edit.pasteInsert',
		'edit.pasteAttributes',
		'timeline.copy',
		'timeline.cut',
		'timeline.paste',
		'timeline.pasteInsert',
		'timeline.pasteAttributes',
	],
	'transitions (M2)': [
		'timeline.applyDefaultVideoTransition',
		'timeline.applyDefaultAudioTransition',
		'timeline.applyDefaultTransitionsToSelection',
	],
	'captions (M2)': [
		'timeline.addCaptionTrack',
		'timeline.addCaptionAtPlayhead',
		'timeline.nextCaptionSegment',
		'timeline.prevCaptionSegment',
	],
	'source monitor / three-point editing extras (M2)': [
		'timeline.matchFrame',
		'timeline.reverseMatchFrame',
		'project.setPosterFrame',
		'project.clearPosterFrame',
		'project.makeSubclip',
		'monitor.fullScreenVideo',
		'transport.toggleAudioScrub',
	],
	'clip dialogs not in the M1 subset': [
		'timeline.group',
		'timeline.ungroup',
		'timeline.speedDuration',
		'timeline.audioGain',
		'timeline.audioChannels',
		'timeline.rename',
		'timeline.toggleLinkedSelection',
		'timeline.addTracks',
		'timeline.deleteTracks',
		'clip.nest',
		'mg.editParameters',
	],
	'shapes and monitor guides (M2)': [
		'graphics.newRectangle',
		'graphics.newEllipse',
		'program.showRulers',
		'program.showGuides',
		'program.lockGuides',
	],
	'panels that do not exist in M1': [
		'panel.open.audioTrackMixer',
		'panel.open.mediaBrowser',
		'panel.open.audioClipMixer',
		'project.importFromMediaBrowser',
		'effects.newCustomBin',
		'effects.deleteCustomItem',
	],
	'agent chat (Stage 2 / M2)': ['agent.stop', 'agent.newConversation', 'agent.askSelection'],
	'app / project management beyond M1': [
		'app.saveAs',
		'app.saveCopy',
		'file.revert',
		'app.quit',
		'app.keyboardShortcuts',
		'app.preferences',
		'app.notices',
		'project.settings',
		'project.mediaProperties',
		'project.newColorMatte',
		'project.createProxies',
		'sequence.settings',
		'edit.find',
		'edit.editOriginal',
		'engine.connect',
		'engine.status',
		'export.frame',
	],
};

const ABSENT = new Set(Object.values(INTENTIONALLY_ABSENT).flat());

function menuCommandIds(): string[] {
	const ids: string[] = [];
	const walk = (x: unknown): void => {
		if (Array.isArray(x)) {
			for (const v of x) walk(v);
			return;
		}
		if (!x || typeof x !== 'object') return;
		const o = x as Record<string, unknown>;
		if (o.type === 'command' && typeof o.command === 'string') ids.push(o.command);
		for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
	};
	walk(MENUBAR);
	for (const d of PANEL_DEFINITIONS) walk(d.menu ?? []);
	return [...new Set(ids)];
}

describe('wiring audit (WP-3I)', () => {
	registerAllCommands();

	it('every keymap command id is registered or intentionally absent', () => {
		const missing = [...new Set(DEFAULT_KEYMAP.map((b) => b.command))].filter((id) => !getCommand(id));
		expect(missing.filter((id) => !ABSENT.has(id))).toEqual([]);
	});

	it('every menu command id is registered or intentionally absent', () => {
		const missing = menuCommandIds().filter((id) => !getCommand(id));
		expect(missing.filter((id) => !ABSENT.has(id))).toEqual([]);
	});

	it('M1 golden-path commands are registered', () => {
		for (const id of [
			'project.import',
			'export.media',
			'graphics.newTextLayer',
			'mg.insertTemplate',
			'history.undo',
			'history.redo',
			'timeline.addEdit',
			'tool.razor',
			'transport.playStop',
			'app.newProject',
			'app.openProject',
			'app.newSequence',
			...PANEL_KINDS.map((k) => `panel.open.${k}`),
		]) {
			expect(getCommand(id), id).toBeTruthy();
		}
	});

	it('every panel kind has exactly one definition with a component', () => {
		for (const kind of PANEL_KINDS) {
			const defs = PANEL_DEFINITIONS.filter((d) => d.kind === kind);
			expect(defs.length, kind).toBe(1);
			expect(defs[0]!.component, kind).toBeTruthy();
		}
	});
});
