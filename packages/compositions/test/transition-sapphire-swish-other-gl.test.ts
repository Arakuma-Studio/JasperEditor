// @vitest-environment node
// Start = End pins progress and eliminates per-frame movement, disabling shutter blur in geometry checks.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME, openGlPage } from './gl-browser.ts';
import type { RunOpts } from './transition-sapphire-swish-other-gl/entry.ts';

const here = dirname(fileURLToPath(import.meta.url));

type Px = [number, number, number, number];
const near = (a: Px, b: number[], tol = 6) => b.every((v, i) => Math.abs(v - a[i]!) <= tol);
const at = (p: number, extra: Record<string, unknown> = {}) => ({
	startPercent: p * 100,
	endPercent: p * 100,
	...extra,
});
const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];

describe.runIf(!!CHROME && process.env.FX_GL !== '0')(
	'Sapphire swish/other transitions in WebGL2 (headless Chrome)',
	{ timeout: 120_000 },
	() => {
		let browser: Browser;
		let page: Page;
		const run = (o: RunOpts) =>
			page.evaluate((x) => (window as unknown as { __sso: { run(o: RunOpts): Px[] } }).__sso.run(x), o);
		const frame = (o: Omit<RunOpts, 'points'>) =>
			page.evaluate(
				(x) =>
					(window as unknown as { __sso: { frame(o: Omit<RunOpts, 'points'>): number[] } }).__sso.frame(x),
				o,
			);
		const diff = (a: number[], b: number[]) => a.reduce((s, v, i) => s + Math.abs(v - b[i]!), 0);

		beforeAll(async () => {
			({ browser, page } = await openGlPage(join(here, 'transition-sapphire-swish-other-gl', 'entry.ts')));
			expect(
				await page.evaluate(() => (window as unknown as { __sso: { webgl2(): boolean } }).__sso.webgl2()),
			).toBe(true);
		}, 120_000);

		afterAll(async () => {
			await browser?.close();
		});

		it('S_SwishPan: half-way the outgoing clip fills the left half, the incoming one the right (Left)', async () => {
			const [l, r] = await run({
				id: 'jasper.s.swish-pan',
				params: at(0.5),
				frame: 0,
				duration: 19,
				points: [
					[8, 18],
					[56, 18],
				],
			});
			expect(near(l!, RED)).toBe(true);
			expect(near(r!, BLUE)).toBe(true);
			// Direction Right mirrors it; Reverse plays B → A backwards (B on the left at 0.5).
			const [l2, r2] = await run({
				id: 'jasper.s.swish-pan',
				params: at(0.5, { direction: 'right' }),
				frame: 0,
				duration: 19,
				points: [
					[8, 18],
					[56, 18],
				],
			});
			expect(near(l2!, BLUE)).toBe(true);
			expect(near(r2!, RED)).toBe(true);
			const [l3] = await run({
				id: 'jasper.s.swish-pan',
				params: at(0.5, { reverse: true }),
				frame: 0,
				duration: 19,
				points: [[8, 18]],
			});
			expect(near(l3!, BLUE)).toBe(true);
		});

		it('S_SwishPan: the motion blur smears the seam over many pixels in the middle of a span', async () => {
			// Frame 9 of 19 (progress 0.5) with Blur Amount 2: the seam column is a mix of both clips.
			const [seam, l] = await run({
				id: 'jasper.s.swish-pan',
				frame: 9,
				duration: 19,
				points: [
					[32, 18],
					[2, 18],
				],
			});
			expect(seam![0]).toBeGreaterThan(40);
			expect(seam![2]).toBeGreaterThan(40);
			expect(l![0]).toBeGreaterThan(l![2]!);
			const [sharp] = await run({
				id: 'jasper.s.swish-pan',
				params: { blurAmount: 0 },
				frame: 9,
				duration: 19,
				points: [[28, 18]],
			});
			expect(near(sharp!, RED)).toBe(true);
		});

		it('S_Swish3D: zooms the outgoing clip (Z Dist 0.5) and dissolves around Fade Mid Time', async () => {
			// Halves picture: zoomed ×2 around the centre at the end of From's move, the left quarter shows red.
			const [a] = await run({
				id: 'jasper.s.swish-3d',
				params: at(0.3),
				frame: 0,
				duration: 19,
				from: 'halves',
				points: [[20, 18]],
			});
			expect(near(a!, RED, 10)).toBe(true);
			const [mid] = await run({
				id: 'jasper.s.swish-3d',
				params: at(0.5, { relAmpFrom: 0, relAmpTo: 0 }),
				frame: 0,
				duration: 19,
				points: [[32, 18]],
			});
			expect(mid![0]).toBeGreaterThan(90);
			expect(mid![2]).toBeGreaterThan(90);
			const [late] = await run({
				id: 'jasper.s.swish-3d',
				params: at(0.85),
				frame: 0,
				duration: 19,
				points: [[32, 18]],
			});
			expect(near(late!, BLUE, 10)).toBe(true);
		});

		it('S_CardFlip: the outgoing card turns away, the incoming one turns in (edge-on in the middle)', async () => {
			const [a] = await run({
				id: 'jasper.s.card-flip',
				params: at(0.2),
				frame: 0,
				duration: 19,
				points: [[32, 18]],
			});
			expect(a![0]).toBeGreaterThan(150);
			expect(a![2]).toBeLessThan(20);
			const [b] = await run({
				id: 'jasper.s.card-flip',
				params: at(0.8),
				frame: 0,
				duration: 19,
				points: [[32, 18]],
			});
			expect(b![2]).toBeGreaterThan(150);
			const [edge] = await run({
				id: 'jasper.s.card-flip',
				params: at(0.5),
				frame: 0,
				duration: 19,
				points: [[4, 18]],
			});
			expect(edge![3]).toBe(0); // edge-on: transparent beside the card
			// Revolutions 0 + Shift: a shuffle — at the middle the cards are apart, A on the left (Shift Direction Left).
			const [sl, sr] = await run({
				id: 'jasper.s.card-flip',
				params: at(0.5, { revolutions: 0, shift: 1.2, shadowOpacity: 0 }),
				frame: 0,
				duration: 19,
				points: [
					[6, 18],
					[58, 18],
				],
			});
			expect(sl![0]).toBeGreaterThan(150);
			expect(sr![2]).toBeGreaterThan(150);
		});

		it('S_StripSlideTransition: Top Down slides the top strips off first', async () => {
			const [top, bottom] = await run({
				id: 'jasper.s.strip-slide-transition',
				params: at(0.5),
				frame: 0,
				duration: 19,
				points: [
					[32, 1],
					[32, 34],
				],
			});
			expect(near(top!, BLUE)).toBe(true);
			expect(near(bottom!, RED)).toBe(true);
			const [top2, bottom2] = await run({
				id: 'jasper.s.strip-slide-transition',
				params: at(0.5, { order: 'bottomUp' }),
				frame: 0,
				duration: 19,
				points: [
					[32, 1],
					[32, 34],
				],
			});
			expect(near(top2!, RED)).toBe(true);
			expect(near(bottom2!, BLUE)).toBe(true);
		});

		it('S_FilmRoll: half-way the frame line crosses the middle, A above and B below', async () => {
			const p = at(0.5, { damageAmount: 0, glowBrightness: 0 });
			const [top, line, bottom] = await run({
				id: 'jasper.s.film-roll',
				params: p,
				frame: 0,
				duration: 19,
				points: [
					[32, 4],
					[32, 18],
					[32, 32],
				],
			});
			expect(near(top!, RED)).toBe(true);
			expect(near(line!, [0, 0, 0, 255])).toBe(true);
			expect(near(bottom!, BLUE)).toBe(true);
			// Roll Speed −1 rolls downwards: B above, A below.
			const [top2, bottom2] = await run({
				id: 'jasper.s.film-roll',
				params: { ...p, rollSpeed: -1 },
				frame: 0,
				duration: 19,
				points: [
					[32, 4],
					[32, 32],
				],
			});
			expect(near(top2!, BLUE)).toBe(true);
			expect(near(bottom2!, RED)).toBe(true);
		});

		it('S_FlutterCut: each frame shows the clip of the TS pattern (with colour frames)', async () => {
			const params = { color1Frames: 1, color1Position: 'afterFrom', fromStartFrames: 3, toEndFrames: 3 };
			// = flutterPattern(params, 12) (unit-tested in packages/project/test/transition-sapphire-swish-other.test.ts)
			const pattern = 'FFFCTTFFCTTT';
			for (let i = 0; i < 12; i++) {
				const [c] = await run({
					id: 'jasper.s.flutter-cut',
					params,
					frame: i,
					duration: 12,
					points: [[32, 18]],
				});
				const want = { F: RED, T: BLUE, C: [0, 0, 0, 255] }[pattern[i] as 'F' | 'T' | 'C'];
				expect(near(c!, want), `frame ${i}: ${pattern[i]} got ${c}`).toBe(true);
			}
			// Invert From Clip: inverted frames of A are cyan.
			const inv = { invert: 'from', normalBefore: 0, invertLength: 1 };
			const [c0] = await run({
				id: 'jasper.s.flutter-cut',
				params: inv,
				frame: 0,
				duration: 12,
				points: [[32, 18]],
			});
			expect(near(c0!, [0, 255, 255, 255])).toBe(true);
		});

		it('S_TVChannelChange: black / static in the dead time, clean pictures at the ends', async () => {
			const [black] = await run({
				id: 'jasper.s.tv-channel-change',
				params: at(0.5, { deadTimeStyle: 'black' }),
				frame: 0,
				duration: 19,
				points: [[32, 18]],
			});
			expect(near(black!, [0, 0, 0, 255])).toBe(true);
			const f = await frame({ id: 'jasper.s.tv-channel-change', params: at(0.5), frame: 9, duration: 19 });
			const lum = f.filter((_, i) => i % 4 === 0);
			expect(Math.max(...lum)).toBeGreaterThan(100);
			expect(
				diff(f, await frame({ id: 'jasper.s.tv-channel-change', params: at(0.5), frame: 9, duration: 19 })),
			).toBe(0);
			expect(
				diff(
					f,
					await frame({
						id: 'jasper.s.tv-channel-change',
						params: at(0.5, { seed: 7 }),
						frame: 9,
						duration: 19,
					}),
				),
			).toBeGreaterThan(0);
			const [early] = await run({
				id: 'jasper.s.tv-channel-change',
				params: at(0.02),
				frame: 0,
				duration: 19,
				points: [[32, 18]],
			});
			expect(early![0]).toBeGreaterThan(150);
		});

		it('S_HyperPull / S_HyperPush: the outgoing clip before the dissolve, the incoming one after', async () => {
			for (const id of ['jasper.s.hyper-pull', 'jasper.s.hyper-push']) {
				const [a] = await run({ id, params: at(0.3), frame: 0, duration: 19, points: [[32, 18]] });
				expect(a![0], id).toBeGreaterThan(a![2]! + 100);
				const [b] = await run({ id, params: at(0.7), frame: 0, duration: 19, points: [[32, 18]] });
				expect(b![2], id).toBeGreaterThan(b![0]! + 100);
			}
			// Hyper Pull: Z Dist From 5 shrinks the outgoing checker (reflected around it) before the dissolve.
			const a = await frame({
				id: 'jasper.s.hyper-pull',
				params: at(0.4, { glowBrights: false }),
				frame: 0,
				duration: 19,
				from: 'checker',
			});
			const b = await frame({
				id: 'jasper.s.hyper-pull',
				params: at(0.05, { glowBrights: false }),
				frame: 0,
				duration: 19,
				from: 'checker',
			});
			expect(diff(a, b)).toBeGreaterThan(1000);
		});

		it('S_WhipLash: cuts in the middle; the Whip Out styles land differently', async () => {
			const [a] = await run({
				id: 'jasper.s.whip-lash',
				params: at(0.4),
				frame: 0,
				duration: 19,
				points: [[32, 18]],
			});
			expect(near(a!, RED)).toBe(true);
			const [b] = await run({
				id: 'jasper.s.whip-lash',
				params: at(0.6),
				frame: 0,
				duration: 19,
				points: [[32, 18]],
			});
			expect(near(b!, BLUE)).toBe(true);
			const o = { frame: 0, duration: 19, from: 'checker', to: 'stripes' };
			const smooth = await frame({ id: 'jasper.s.whip-lash', params: at(0.8, { shift: [-0.3, 0] }), ...o });
			const bounce = await frame({
				id: 'jasper.s.whip-lash',
				params: at(0.8, { shift: [-0.3, 0], whipOut: 'bounce' }),
				...o,
			});
			expect(diff(smooth, bounce)).toBeGreaterThan(1000);
		});

		it('S_MochaWhip: without a mask it is a plain whip; a mask whips a cut-out of B in front', async () => {
			const o = { frame: 0, duration: 19, from: 'checker', to: 'stripes' };
			const plain = await frame({ id: 'jasper.s.mocha-whip', params: at(0.6), ...o });
			const cut = await frame({
				id: 'jasper.s.mocha-whip',
				params: at(0.6, { cutoutMask: 'ellipse' }),
				...o,
			});
			expect(diff(plain, cut)).toBeGreaterThan(1000);
			const end = await frame({
				id: 'jasper.s.mocha-whip',
				params: at(1, { cutoutMask: 'rectangle' }),
				...o,
			});
			const b = await frame({ id: 'jasper.s.mocha-whip', params: at(1), ...o });
			expect(diff(end, b)).toBeLessThan(end.length);
		});

		it('S_ParallaxStripsTransition and S_FilmBurnTransition are deterministic per seed', async () => {
			for (const id of ['jasper.s.parallax-strips-transition', 'jasper.s.film-burn-transition']) {
				const o = { id, frame: 9, duration: 19, from: 'checker', to: 'stripes' };
				const a = await frame({ ...o, params: { seed: 1 } });
				expect(diff(a, await frame({ ...o, params: { seed: 1 } })), id).toBe(0);
				expect(diff(a, await frame({ ...o, params: { seed: 2 } })), id).toBeGreaterThan(0);
			}
			// Parallax strips shift the picture inside them: the middle frame differs from the plain dissolve.
			const o = {
				id: 'jasper.s.parallax-strips-transition',
				frame: 0,
				duration: 19,
				from: 'checker',
				to: 'checker',
			};
			expect(
				diff(
					await frame({ ...o, params: at(0.5) }),
					await frame({ ...o, params: at(0.5, { shiftAmount: 0 }) }),
				),
			).toBeGreaterThan(1000);
			// Film burn: the light leaks brighten the middle of the transition.
			const lum = (f: number[]) => f.reduce((s, v, i) => (i % 4 === 3 ? s : s + v), 0);
			const fb = { id: 'jasper.s.film-burn-transition', frame: 0, duration: 19, from: 'gray', to: 'gray' };
			expect(lum(await frame({ ...fb, params: at(0.5) }))).toBeGreaterThan(
				lum(await frame({ ...fb, params: at(0) })) * 1.1,
			);
		});

		it('works at single clip edges (from / to transparency) without NaNs', async () => {
			const ids = [
				'jasper.s.swish-pan',
				'jasper.s.swish-3d',
				'jasper.s.card-flip',
				'jasper.s.film-burn-transition',
				'jasper.s.film-roll',
				'jasper.s.flutter-cut',
				'jasper.s.hyper-pull',
				'jasper.s.hyper-push',
				'jasper.s.mocha-whip',
				'jasper.s.parallax-strips-transition',
				'jasper.s.strip-slide-transition',
				'jasper.s.tv-channel-change',
				'jasper.s.whip-lash',
			];
			for (const id of ids) {
				const [first] = await run({ id, frame: 0, duration: 10, sides: 'in', points: [[32, 18]] });
				expect(first![3], `${id} head`).toBe(0); // a fade at B's head starts transparent
				const [last] = await run({ id, frame: 9, duration: 10, sides: 'out', points: [[32, 18]] });
				expect(last![3], `${id} tail`).toBe(0); // and one at A's tail ends transparent
				// Last frame of a head fade (progress 0.9): mostly the incoming clip, finite colours.
				const [head] = await run({ id, frame: 9, duration: 10, sides: 'in', points: [[32, 18]] });
				expect(head![2]! - head![0]!, `${id} head end ${head}`).toBeGreaterThan(100);
			}
		});
	},
);
