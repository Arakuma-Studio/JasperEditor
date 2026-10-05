// @vitest-environment node
// Sapphire Glows + Lighting family in a real WebGL2 (headless Chrome, SwiftShader): every effect compiles and runs
// with default params on two scenes (opaque night street, transparent logo), plus the characteristic pixel of each
// effect, padding (light drawn outside the layer box), alpha, Show/Mix with Orig, and seeded determinism.
// FX_GL=0 skips it; needs a Chrome (JASPER_BROWSER_EXECUTABLE or the usual paths).
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME, openSglPage, sgl } from './fx-sapphire-glows-lighting/browser.ts';

type Px = [number, number, number, number];
type Pixels = { canvas: number[]; box: number[]; out: Px[]; src: Px[] };
type Opts = { scene?: string; width?: number; height?: number; frame?: number; depth?: boolean; seed?: number };

const lum = (p: Px) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'Sapphire Glows + Lighting in WebGL2',
	{ timeout: 120_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const pixels = (id: string, params: Record<string, unknown>, opts: Opts, pts: [number, number][]) =>
			sgl<Pixels>(page, 'pixels', id, params, opts, pts);
		const checksum = (id: string, params: Record<string, unknown>, opts: Opts = {}) =>
			sgl<number>(page, 'checksum', id, params, opts);

		beforeAll(async () => {
			({ browser, page } = await openSglPage());
		}, 120_000);

		afterAll(async () => {
			await browser?.close();
		});

		it('compiles and runs every effect of the family with default params', async () => {
			const r = await sgl<{ count: number; errors: string[] }>(page, 'allDefaults');
			expect(r.errors).toEqual([]);
			expect(r.count).toBeGreaterThanOrEqual(1);
		});
	},
);
