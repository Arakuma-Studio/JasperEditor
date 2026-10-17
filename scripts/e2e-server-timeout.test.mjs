import { describe, expect, it } from 'vitest';
import {
	E2E_SERVER_TIMEOUT_DEFAULT_MS,
	E2E_SERVER_TIMEOUT_MAX_MS,
	E2E_SERVER_TIMEOUT_MIN_MS,
	e2eServerTimeoutMs,
} from '../e2e/server-timeout.ts';

describe('E2E web server start-up timeout', () => {
	it('defaults to 180 s when unset or empty', () => {
		expect(E2E_SERVER_TIMEOUT_DEFAULT_MS).toBe(180_000);
		expect(e2eServerTimeoutMs({})).toBe(180_000);
		expect(e2eServerTimeoutMs({ E2E_SERVER_TIMEOUT_MS: '' })).toBe(180_000);
		expect(e2eServerTimeoutMs({ E2E_SERVER_TIMEOUT_MS: '  ' })).toBe(180_000);
	});

	it('takes a whole number of milliseconds inside 1 s … 1 h', () => {
		expect(e2eServerTimeoutMs({ E2E_SERVER_TIMEOUT_MS: '600000' })).toBe(600_000);
		expect(e2eServerTimeoutMs({ E2E_SERVER_TIMEOUT_MS: ' 90000 ' })).toBe(90_000);
		expect(e2eServerTimeoutMs({ E2E_SERVER_TIMEOUT_MS: String(E2E_SERVER_TIMEOUT_MIN_MS) })).toBe(1_000);
		expect(e2eServerTimeoutMs({ E2E_SERVER_TIMEOUT_MS: String(E2E_SERVER_TIMEOUT_MAX_MS) })).toBe(3_600_000);
	});

	it('refuses values that are not whole milliseconds or out of range, naming the variable', () => {
		for (const bad of ['10m', '1e6', '-5', '60000.5', 'NaN', 'Infinity', '0x100', '999', '3600001']) {
			expect(() => e2eServerTimeoutMs({ E2E_SERVER_TIMEOUT_MS: bad })).toThrow(/E2E_SERVER_TIMEOUT_MS/);
		}
	});

	it('is what playwright.config.ts uses for its webServer', async () => {
		const { readFile } = await import('node:fs/promises');
		const config = await readFile(new URL('../playwright.config.ts', import.meta.url), 'utf8');
		expect(config).toMatch(/timeout:\s*e2eServerTimeoutMs\(\)/);
		expect(config).not.toMatch(/webServer:[\s\S]*timeout:\s*60_000/);
	});
});
