import { describe, expect, it } from 'vitest';
import { webTestTimeoutMs } from '../vitest.config.ts';

describe('web test timeout', () => {
	it('is 15 s on a quiet host, grows with the square of the load factor, and is capped at a minute', () => {
		expect(webTestTimeoutMs(1, false)).toBe(15_000);
		expect(webTestTimeoutMs(1.5, false)).toBe(15_000);
		expect(webTestTimeoutMs(2, false)).toBe(20_000);
		expect(webTestTimeoutMs(3, false)).toBe(45_000);
		expect(webTestTimeoutMs(10, false)).toBe(60_000);
		expect(webTestTimeoutMs(Number.POSITIVE_INFINITY, false)).toBe(60_000);
	});

	it('PERF=1 keeps the strict 5 s whatever the load', () => {
		expect(webTestTimeoutMs(1, true)).toBe(5000);
		expect(webTestTimeoutMs(8, true)).toBe(5000);
	});

	it('this run is configured with it: never unlimited, never above the ceiling', (ctx) => {
		const timeout = ctx.task.timeout;
		expect(timeout).toBeGreaterThanOrEqual(5000);
		expect(timeout).toBeLessThanOrEqual(60_000);
		if (process.env.PERF !== '1') expect(timeout).toBeGreaterThanOrEqual(15_000);
	});
});
