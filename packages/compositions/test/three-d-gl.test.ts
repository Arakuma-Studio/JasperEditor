// @vitest-environment node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME, openGlPage } from './gl-browser.ts';

const here = dirname(fileURLToPath(import.meta.url));

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'Classic 3D on the GPU = the CPU reference',
	{ timeout: 180_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const call = <T>(name: string, arg?: unknown): Promise<T> =>
			page.evaluate(
				([n, a]) => (window as unknown as { __3d: Record<string, (a?: unknown) => unknown> }).__3d[n]!(a),
				[name, arg] as const,
			) as Promise<T>;

		beforeAll(async () => {
			({ browser, page } = await openGlPage(join(here, 'three-d-gl', 'entry.ts'), {
				page: { viewport: { width: 64, height: 64 } },
			}));
		}, 120_000);

		afterAll(async () => {
			await browser?.close();
		});

		it.each([
			['flat', 0],
			['intersect', 0.002],
			['orbit', 0.003],
			['ortho', 0.002],
			['lights', 0.003],
			['dissolve', 0],
			['dof', 0.004],
		] as const)('%s', async (name, allowedBad) => {
			const r = await call<{ gl: number[]; cpu: number[]; W: number; H: number }>('render', name);
			let bad = 0;
			let worst = 0;
			let drawn = 0;
			for (let i = 0; i < r.W * r.H; i++) {
				const a = r.cpu[i * 4 + 3]!;
				if (a > 0) drawn++;
				let e = Math.abs(a - r.gl[i * 4 + 3]!);
				// Compared premultiplied (straight bytes of translucent edges amplify the 8-bit storage of the canvas).
				const ga = r.gl[i * 4 + 3]!;
				for (let c = 0; c < 3; c++)
					e = Math.max(e, Math.abs((r.cpu[i * 4 + c]! * a) / 255 - (r.gl[i * 4 + c]! * ga) / 255));
				worst = Math.max(worst, e);
				// Pixels on an edge (a sample exactly on a texel or a plane border) may round to the other side.
				if (e > 3) {
					bad++;
					if (process.env.THREE_D_DEBUG)
						console.log(
							name,
							i % r.W,
							Math.floor(i / r.W),
							r.cpu.slice(i * 4, i * 4 + 4),
							r.gl.slice(i * 4, i * 4 + 4),
						);
				}
			}
			expect(drawn, 'the scene draws something').toBeGreaterThan(100);
			expect(bad / (r.W * r.H), `${name}: worst ${worst}`).toBeLessThanOrEqual(allowedBad);
		});
	},
);
