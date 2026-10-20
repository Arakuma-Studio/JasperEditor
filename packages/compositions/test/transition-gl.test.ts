// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRANSITION_FAMILIES, TRANSITION_SPECS } from '@jasper/project';
import { expectFingerprints } from '@jasper/testkit/golden';
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME, openGlPage } from './gl-browser.ts';
import { TEST_TRANSITIONS } from './transition-examples.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** Golden transition fingerprints: `<id>@<p>` → 4×4 mean RGB (FilmCraft's goldens.txt, ±4 levels). */
const TR_FINGERPRINTS = join(here, 'goldens', 'transition-fingerprints.json');
const inFamily = new Set(TRANSITION_FAMILIES.flatMap((f) => f.transitions.map((s) => s.id)));
const transitionGroups = [
	{
		family: undefined,
		ids: [...TRANSITION_SPECS.filter((s) => s.gpu && !inFamily.has(s.id)), ...TEST_TRANSITIONS].map(
			(s) => s.id,
		),
		timeout: 60_000,
	},
	...TRANSITION_FAMILIES.map((f) => ({
		family: f.file,
		ids: f.transitions.filter((s) => s.gpu).map((s) => s.id),
		timeout: 240_000,
	})),
];
// A missing registered transition must not silently remove its committed golden cases.
const pinnedIds = new Set(
	Object.keys(JSON.parse(readFileSync(TR_FINGERPRINTS, 'utf8'))).map((id) =>
		id.replace(/@(0\.25|0\.5|0\.75)$/, ''),
	),
);
const listedIds = new Set(transitionGroups.flatMap((g) => g.ids));
transitionGroups.push({
	family: undefined,
	ids: [...pinnedIds].filter((id) => !listedIds.has(id)),
	timeout: 60_000,
});

type Px = [number, number, number, number];
const near = (a: Px, b: Px, tol = 4) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);
const H_TEST = 36;

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'GPU transitions in WebGL2 (headless Chrome)',
	{ timeout: 60_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const call = <T>(name: string, arg?: { family?: string; id: string }): Promise<T> =>
			page.evaluate(
				([n, a]) =>
					(window as unknown as { __tr: Record<string, (a?: { family?: string; id: string }) => unknown> })
						.__tr[n]!(a),
				[name, arg] as const,
			) as Promise<T>;
		const endsOk = (r: Record<string, { first: Px; last: Px }>) =>
			Object.entries(r)
				.filter(([, v]) => !near(v.first, [255, 0, 0, 255], 6) || !near(v.last, [0, 0, 255, 255], 6))
				.map(([id, v]) => `${id}: ${v.first.join(',')} → ${v.last.join(',')}`);

		beforeAll(async () => {
			({ browser, page } = await openGlPage(join(here, 'transition-gl', 'entry.ts')));
		}, 120_000);

		afterAll(async () => {
			await browser?.close();
		});

		// Keep the shared-host sequence: all catalogue draws, then all endpoints, then all fingerprints in each family.
		for (const { family, ids, timeout } of transitionGroups) {
			for (const id of ids)
				it(`renders ${id} with both, single and reversed sides`, { timeout }, async () => {
					const r = await call<{ errors: string[] }>('catalogue', { family, id });
					expect(r.errors).toEqual([]);
				});
			for (const id of ids)
				it(`shows A at progress 0 and B at 1 for ${id}`, { timeout }, async () => {
					expect(endsOk(await call('ends', { family, id }))).toEqual([]);
				});
			for (const id of ids)
				it(`matches golden pixels at progress 0.25, 0.5 and 0.75 for ${id}`, { timeout }, async () => {
					expectFingerprints(
						TR_FINGERPRINTS,
						await call<Record<string, number[]>>('fingerprints', { family, id }),
						4,
					);
				});
		}

		it('places the side pictures through their matrices and opacity', async () => {
			const r = await call<{ left: Px; right: Px; outside: Px; inside: Px }>('placement');
			expect(near(r.left, [255, 0, 0, 128], 3)).toBe(true); // scaled ×2, half opacity (premultiplied out)
			expect(near(r.right, [0, 0, 255, 128], 3)).toBe(true);
			expect(r.outside[3]).toBe(0); // left of the moved picture: transparent
			expect(near(r.inside, [255, 0, 0, 255])).toBe(true);
		});

		it('binds image params (Gradient Wipe / VR Gradient Wipe Custom Gradient; none or missing → built-in)', async () => {
			const r = await call<Record<string, [Px, Px]>>('gradientImage');
			const RED: Px = [255, 0, 0, 255];
			const BLUE: Px = [0, 0, 255, 255];
			// Left to Right: the left switches first. Custom (white | black): the dark right half first.
			expect(near(r.plain![0], BLUE) && near(r.plain![1], RED)).toBe(true);
			expect(near(r.custom![0], RED) && near(r.custom![1], BLUE)).toBe(true);
			expect(r.missing).toEqual(r.plain);
			expect(near(r.vrCustom![0], RED) && near(r.vrCustom![1], BLUE)).toBe(true);
		});

		it('Push: the border is never visible at progress 0 or 1 (it travels between the clips)', async () => {
			const r = await call<{ first: Px[]; last: Px[]; mid: Px[] }>('pushBorder');
			expect(r.first.every((p) => near(p, [255, 0, 0, 255]))).toBe(true);
			expect(r.last.every((p) => near(p, [0, 0, 255, 255]))).toBe(true);
			// Mid-way the white band sits between B (top) and A (bottom).
			expect(r.mid.some((p) => near(p, [255, 255, 255, 255], 10))).toBe(true);
			expect(near(r.mid[1]!, [0, 0, 255, 255]) && near(r.mid[H_TEST - 2]!, [255, 0, 0, 255])).toBe(true);
		});

		it("S_MochaWhip follows the incoming side's planar track (Track Mode Off: as without a track)", async () => {
			const r = await call<{ diff: number; diffOff: number; endCentre: Px; endCorner: Px }>('mochaTrack');
			expect(r.diff).toBeGreaterThan(20);
			expect(r.diffOff).toBe(0);
			// At progress 1 the cut-out has landed exactly: B everywhere.
			expect(near(r.endCentre, [0, 255, 0, 255])).toBe(true);
			expect(near(r.endCorner, [0, 0, 255, 255])).toBe(true);
		});

		it('Custom Completion replaces the timing; off keeps the linear ramp', async () => {
			const r = await call<{ zero: Px; full: Px; offLeft: Px; offRight: Px }>('completion');
			expect(near(r.zero, [255, 0, 0, 255])).toBe(true);
			expect(near(r.full, [0, 0, 255, 255])).toBe(true);
			// Off (completion ignored): p = 0.5 → B on the left half, A on the right.
			expect(near(r.offLeft, [0, 0, 255, 255]) && near(r.offRight, [255, 0, 0, 255])).toBe(true);
		});

		it('reads both sides in one shader (S_DissolveLuma)', async () => {
			const r = await call<{ white: Px; black: Px }>('luma');
			expect(near(r.white, [0, 255, 0, 255])).toBe(true);
			expect(near(r.black, [0, 0, 0, 255])).toBe(true);
		});
	},
);
