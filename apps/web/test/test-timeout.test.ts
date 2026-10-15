// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const calibration = vi.hoisted(() => ({ factor: 1, strict: false }));
vi.mock('../../../scripts/perf/budget.ts', () => ({
	loadFactor: () => calibration.factor,
	get PERF_STRICT() {
		return calibration.strict;
	},
}));

async function configuredTimeout(factor: number, strict: boolean) {
	calibration.factor = factor;
	calibration.strict = strict;
	vi.resetModules();
	return (await import('../vitest.config.ts')).default.test?.testTimeout;
}

describe('web timeout configuration (docs/performance.md)', () => {
	it('exports load-scaled timeouts bounded between 15 and 60 seconds', async () => {
		for (const [factor, timeout] of [
			[1, 15_000],
			[1.5, 15_000],
			[2, 20_000],
			[3, 45_000],
			[10, 60_000],
		] as const) {
			expect(await configuredTimeout(factor, false)).toBe(timeout);
		}
	});

	it('exports the strict 5-second timeout when PERF mode is enabled', async () => {
		for (const factor of [1, 8]) {
			expect(await configuredTimeout(factor, true)).toBe(5_000);
		}
	});
});
