// The web project's happy-dom tests get the browser's Web Storage on every Node the repo supports
// (packages/testkit/src/dom-storage-setup.ts). On Node 25+ without the setup file `localStorage` was Node's `undefined`.
import { describe, expect, it } from 'vitest';

describe('Web Storage under happy-dom', () => {
	it('localStorage and sessionStorage are happy-dom Storage that keeps what is written', () => {
		for (const storage of [globalThis.localStorage, globalThis.sessionStorage]) {
			expect(storage).toBeInstanceOf(Storage);
			storage.setItem('jasper:test', '1');
			expect(storage.getItem('jasper:test')).toBe('1');
			storage.removeItem('jasper:test');
			expect(storage.getItem('jasper:test')).toBeNull();
		}
		expect(window.localStorage).toBe(globalThis.localStorage);
		expect(localStorage).not.toBe(sessionStorage);
	});
});
