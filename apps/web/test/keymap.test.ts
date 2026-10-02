import { describe, expect, it } from 'vitest';
import {
	chordFromEvent,
	DEFAULT_KEYMAP,
	effectiveKey,
	normalizeChord,
	type Platform,
	type Runtime,
	resolveBindings,
	scopeChain,
} from '../src/commands/keymap-defaults.ts';

const TL_903 = [
	'transport.playStop',
	'transport.shuttleReverse',
	'transport.shuttleStop',
	'transport.shuttleForward',
	'transport.shuttleSlowReverse',
	'transport.shuttleSlowForward',
	'transport.stepBack',
	'transport.stepForward',
	'transport.stepBackMany',
	'transport.stepForwardMany',
	'transport.goToStart',
	'transport.goToEnd',
	'transport.prevEdit',
	'transport.nextEdit',
	'transport.prevEditAny',
	'transport.nextEditAny',
	'transport.playInToOut',
	'transport.playAround',
	'transport.toggleAudioScrub',
	'timeline.markIn',
	'timeline.markOut',
	'timeline.markClip',
	'timeline.markSelection',
	'timeline.clearIn',
	'timeline.clearOut',
	'timeline.clearInOut',
	'timeline.goToIn',
	'timeline.goToOut',
	'timeline.lift',
	'timeline.extract',
	'timeline.insertFromSource',
	'timeline.overwriteFromSource',
	'timeline.addMarker',
	'timeline.nextMarker',
	'timeline.prevMarker',
	'timeline.clearMarker',
	'timeline.clearAllMarkers',
	'timeline.addEdit',
	'timeline.addEditAllTracks',
	'timeline.rippleTrimPrevToPlayhead',
	'timeline.rippleTrimNextToPlayhead',
	'timeline.trimPrevToPlayhead',
	'timeline.trimNextToPlayhead',
	'timeline.extendEditToPlayhead',
	'timeline.cycleTrimType',
	'timeline.trimBack',
	'timeline.trimForward',
	'timeline.trimBackMany',
	'timeline.trimForwardMany',
	'timeline.nudgeLeft',
	'timeline.nudgeRight',
	'timeline.nudgeLeftMany',
	'timeline.nudgeRightMany',
	'timeline.nudgeUp',
	'timeline.nudgeDown',
	'timeline.slipLeft',
	'timeline.slipRight',
	'timeline.slideLeft',
	'timeline.slideRight',
	'timeline.clear',
	'timeline.rippleDelete',
	'timeline.selectAll',
	'timeline.deselectAll',
	'timeline.selectClipAtPlayhead',
	'timeline.selectNextClip',
	'timeline.selectPrevClip',
	'timeline.toggleSnap',
	'timeline.linkUnlink',
	'timeline.group',
	'timeline.ungroup',
	'timeline.toggleEnable',
	'timeline.speedDuration',
	'timeline.audioGain',
	'timeline.matchFrame',
	'timeline.reverseMatchFrame',
	'timeline.applyDefaultVideoTransition',
	'timeline.applyDefaultAudioTransition',
	'timeline.duplicate',
	'timeline.copy',
	'timeline.cut',
	'timeline.paste',
	'timeline.pasteInsert',
	'timeline.pasteAttributes',
	'timeline.zoomIn',
	'timeline.zoomOut',
	'timeline.zoomToSequence',
	'timeline.videoTracksTaller',
	'timeline.videoTracksShorter',
	'timeline.audioTracksTaller',
	'timeline.audioTracksShorter',
	'timeline.expandAllTracks',
	'timeline.minimizeAllTracks',
	'timeline.pageLeft',
	'timeline.pageRight',
	'timeline.renderInToOut',
	'timeline.setWorkAreaIn',
	'timeline.setWorkAreaOut',
	'tool.selection',
	'tool.trackSelectForward',
	'tool.trackSelectBackward',
	'tool.ripple',
	'tool.rolling',
	'tool.rateStretch',
	'tool.razor',
	'tool.slip',
	'tool.slide',
	'tool.pen',
	'tool.hand',
	'tool.zoom',
	'tool.type',
	'history.undo',
	'history.redo',
	'gesture.cancel',
];

describe('default keymap (S02:TL-903, R-PUI §16, S05:KB-010/011/013)', () => {
	it('contains every TL-903 command id', () => {
		const ids = new Set(DEFAULT_KEYMAP.map((b) => b.command));
		for (const id of TL_903) expect(ids, id).toContain(id);
	});
	it('contains the S05:KB-010 shell bindings', () => {
		const find = (command: string) => DEFAULT_KEYMAP.find((b) => b.command === command)?.key;
		expect(find('app.commandPalette')).toBe('Ctrl+Shift+KeyP');
		expect(find('monitor.fit')).toBe('Ctrl+Digit0');
		expect(find('workspace.maximizeUnderCursor')).toBe('Backquote');
		expect(find('workspace.nextPanel')).toBe('Ctrl+Shift+Period');
		expect(find('workspace.switch.1')).toBe('Alt+Shift+Digit1');
		expect(find('app.cycleRegions')).toBe('F6');
	});
	it('has no Agent panel bindings: agents connect over MCP (wp-mcp)', () => {
		expect(DEFAULT_KEYMAP.filter((b) => /(^|\.)agent(\.|$)/.test(b.command))).toEqual([]);
	});
	it('binds physical KeyboardEvent.code values only', () => {
		const code =
			/^(Key[A-Z]|Digit\d|Numpad\w+|Arrow(Left|Right|Up|Down)|F\d{1,2}|Space|Enter|Escape|Backspace|Delete|Home|End|PageUp|PageDown|Tab|Comma|Period|Slash|Backslash|Semicolon|Quote|Backquote|Equal|Minus|BracketLeft|BracketRight)$/;
		for (const b of DEFAULT_KEYMAP) {
			for (const k of [b.key, b.mac, b.web].filter(Boolean) as string[])
				expect(k.split('+').pop(), `${b.command}: ${k}`).toMatch(code);
		}
	});
	const combos: [Platform, Runtime][] = [
		['win', 'desktop'],
		['linux', 'web'],
		['mac', 'desktop'],
		['mac', 'web'],
	];
	for (const [platform, runtime] of combos) {
		it(`has no duplicate bindings within a scope (${platform}/${runtime}, KB-011)`, () => {
			const seen = new Map<string, string>();
			const dups: string[] = [];
			for (const b of DEFAULT_KEYMAP) {
				const key = effectiveKey(b, platform, runtime);
				if (!key) continue;
				const k = `${b.scope}|${normalizeChord(key)}`;
				const prev = seen.get(k);
				if (prev && prev !== b.command) dups.push(`${k}: ${prev} vs ${b.command}`);
				seen.set(k, b.command);
			}
			expect(dups).toEqual([]);
		});
	}
	it('uses web fallbacks for browser-reserved chords (KB-013)', () => {
		const newSeq = DEFAULT_KEYMAP.find((b) => b.command === 'app.newSequence')!;
		expect(effectiveKey(newSeq, 'linux', 'web')).toBe('Alt+KeyN');
		expect(effectiveKey(newSeq, 'linux', 'desktop')).toBe('Ctrl+KeyN');
		expect(
			effectiveKey(DEFAULT_KEYMAP.find((b) => b.command === 'graphics.newTextLayer')!, 'win', 'pwa'),
		).toBe('Alt+KeyT');
	});
	it('resolves focused panel → editing → global', () => {
		expect(scopeChain('timeline')).toEqual(['timeline', 'editing', 'global']);
		expect(scopeChain('project')).toEqual(['project', 'global']);
		expect(scopeChain(null)).toEqual(['global']);
		const chord = chordFromEvent(
			{ code: 'KeyC', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false },
			'linux',
		);
		expect(
			resolveBindings(chord, scopeChain('timeline'), { platform: 'linux', runtime: 'web' }).map(
				(b) => b.command,
			),
		).toEqual(['timeline.copy', 'edit.copy']);
		const redo = chordFromEvent(
			{ code: 'KeyZ', ctrlKey: false, altKey: false, shiftKey: true, metaKey: true },
			'mac',
		);
		expect(
			resolveBindings(redo, scopeChain('program'), { platform: 'mac', runtime: 'desktop' }).map(
				(b) => b.command,
			),
		).toEqual(['history.redo']);
		expect(
			resolveBindings('KeyC', scopeChain('timeline'), { platform: 'linux', runtime: 'web' })[0]!.command,
		).toBe('tool.razor');
		expect(
			resolveBindings('Equal', scopeChain('project'), { platform: 'linux', runtime: 'web' })[0]!.command,
		).toBe('project.zoomIn');
	});
});
