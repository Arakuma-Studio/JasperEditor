// mcp-cli live-UI automation (agent-bridge/ui-input.ts, ui-elements.ts): chord parsing, key codes and roles.
import { describe, expect, it } from 'vitest';
import { accessibleName, implicitRole, isInteractive } from '../src/agent-bridge/ui-elements.ts';
import { keyOf, parseChord } from '../src/agent-bridge/ui-input.ts';

describe('ui_key chords', () => {
	it('parses modifiers and keys like the keymap (KeyboardEvent.code)', () => {
		expect(parseChord('Cmd+Shift+Z')).toEqual({ mods: { command: true, shift: true }, key: 'Z' });
		expect(parseChord('Alt++')).toEqual({ mods: { alt: true }, key: '+' });
		expect(parseChord('Space')).toEqual({ mods: {}, key: 'Space' });
		expect(() => parseChord('Hyper+K')).toThrow(/Unknown modifier/);
		expect(keyOf('Space')).toEqual({ key: ' ', code: 'Space', shift: false });
		expect(keyOf('k')).toEqual({ key: 'k', code: 'KeyK', shift: false });
		expect(keyOf('K')).toEqual({ key: 'K', code: 'KeyK', shift: true });
		expect(keyOf('7')).toMatchObject({ code: 'Digit7' });
		expect(keyOf('?')).toEqual({ key: '?', code: 'Slash', shift: true });
		expect(keyOf('F9')).toMatchObject({ key: 'F9', code: 'F9' });
		expect(keyOf('PageDown')).toMatchObject({ code: 'PageDown' });
		expect(() => keyOf('Banana')).toThrow(/Unknown key/);
	});
});

describe('element roles and names', () => {
	it('treats native controls, interactive roles and focusable elements as interactive', () => {
		const html = (s: string) => {
			const d = document.createElement('div');
			d.innerHTML = s;
			return d.firstElementChild!;
		};
		expect(isInteractive(html('<button>Go</button>'))).toBe(true);
		expect(isInteractive(html('<input type="hidden">'))).toBe(false);
		expect(isInteractive(html('<div role="slider"></div>'))).toBe(true);
		expect(isInteractive(html('<div tabindex="0"></div>'))).toBe(true);
		expect(isInteractive(html('<div tabindex="-1"></div>'))).toBe(false);
		expect(isInteractive(html('<div>text</div>'))).toBe(false);
		expect(implicitRole(html('<input type="checkbox">'))).toBe('checkbox');
		expect(implicitRole(html('<input type="range">'))).toBe('slider');
		expect(implicitRole(html('<select><option>a</option></select>'))).toBe('combobox');
		expect(accessibleName(html('<button aria-label="Play">▶</button>'))).toBe('Play');
		expect(accessibleName(html('<button title="Snap">S</button>'))).toBe('Snap');
		expect(accessibleName(html('<input placeholder="Search">'))).toBe('Search');
	});
});
