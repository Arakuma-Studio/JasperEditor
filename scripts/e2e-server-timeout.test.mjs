import { describe, expect, it, vi } from 'vitest';
import { e2eServerTimeoutMs } from '../e2e/server-timeout.ts';

describe('E2E web server start-up timeout', () => {
	it('defaults to 180 s when unset or empty', () => {
		expect(e2eServerTimeoutMs({})).toBe(180_000);
		expect(e2eServerTimeoutMs({ E2E_SERVER_TIMEOUT_MS: '' })).toBe(180_000);
		expect(e2eServerTimeoutMs({ E2E_SERVER_TIMEOUT_MS: '  ' })).toBe(180_000);
	});

	it('takes a whole number of milliseconds inside 1 s … 1 h', () => {
		expect(e2eServerTimeoutMs({ E2E_SERVER_TIMEOUT_MS: '600000' })).toBe(600_000);
		expect(e2eServerTimeoutMs({ E2E_SERVER_TIMEOUT_MS: ' 90000 ' })).toBe(90_000);
		expect(e2eServerTimeoutMs({ E2E_SERVER_TIMEOUT_MS: '1000' })).toBe(1_000);
		expect(e2eServerTimeoutMs({ E2E_SERVER_TIMEOUT_MS: '3600000' })).toBe(3_600_000);
	});

	it('refuses values that are not whole milliseconds or out of range, naming the variable', () => {
		for (const bad of ['10m', '1e6', '-5', '60000.5', 'NaN', 'Infinity', '0x100', '999', '3600001']) {
			expect(() => e2eServerTimeoutMs({ E2E_SERVER_TIMEOUT_MS: bad })).toThrow(/E2E_SERVER_TIMEOUT_MS/);
		}
	});

	it('applies the environment override to Playwright web-server startup', async () => {
		vi.stubEnv('E2E_SERVER_TIMEOUT_MS', '600000');
		vi.stubEnv('E2E_TOKEN', process.env.E2E_TOKEN);
		vi.stubEnv('E2E_EDITOR_KEY', process.env.E2E_EDITOR_KEY);
		try {
			const { default: config } = await import('../playwright.config.ts');
			expect(config.webServer.timeout).toBe(600_000);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
