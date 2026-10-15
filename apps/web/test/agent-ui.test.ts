import { describe, expect, it, vi } from 'vitest';
import { runUiAction } from '../src/agent-bridge/ui-automation.ts';

describe('ui_key DOM protocol', () => {
	it('dispatches printable chord keys and rejects unknown keys or modifiers', async () => {
		const observed: KeyboardEvent[] = [];
		const listen = (event: KeyboardEvent) => {
			observed.push(event);
			event.preventDefault();
		};
		window.addEventListener('keydown', listen);
		try {
			for (const [chord, key, code, shiftKey, altKey] of [
				['Space', ' ', 'Space', false, false],
				['?', '?', 'Slash', true, false],
				['Alt++', '+', 'Equal', true, true],
			] as const) {
				await expect(runUiAction('key', { key: chord })).resolves.toMatchObject({ handled: true });
				expect(observed.at(-1)).toMatchObject({ key, code, shiftKey, altKey });
			}
			for (const key of ['Hyper+K', 'Banana'])
				await expect(runUiAction('key', { key })).rejects.toMatchObject({ code: 'E_INVALID_PARAM' });
		} finally {
			window.removeEventListener('keydown', listen);
		}
	});
});

describe('desktop screenshots', () => {
	it('reports a refused native capture as unavailable', async () => {
		const previous = Object.getOwnPropertyDescriptor(window, 'jasperDesktop');
		const capturePage = vi.fn().mockResolvedValue(null);
		Object.defineProperty(window, 'jasperDesktop', { configurable: true, value: { capturePage } });
		try {
			await expect(runUiAction('screenshot', {})).rejects.toMatchObject({ code: 'E_NOT_AVAILABLE' });
			expect(capturePage).toHaveBeenCalledOnce();
		} finally {
			if (previous) Object.defineProperty(window, 'jasperDesktop', previous);
			else delete window.jasperDesktop;
		}
	});
});
