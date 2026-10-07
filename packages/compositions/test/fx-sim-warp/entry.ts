// Browser entry of fx-sim-warp-gl.test.ts: characteristic pixels, determinism and seed stability of every effect of
// the simulation-warp family through the real GPU host. Each function returns plain data to assert on.
import { FX_FAMILIES } from '@jasper/project';
import { centroid, defaults, maxDiff, mean, picture, premulOk, run, solid, spec, sumDiff } from './harness.ts';

const W = 96;
const H = 64;
const box = { width: W, height: H };

const fx = (id: string, over: Record<string, unknown> = {}, extra: Parameters<typeof run>[4] = {}, paint = picture) => {
	const s = spec(id);
	return run(s, defaults(s, over), box, paint, extra);
};

/** A larger render as a PNG data URL (contact-sheet gallery). */
function png(arg: { id: string; over?: Record<string, unknown>; frame?: number; w?: number; h?: number; bg?: string }) {
	const s = spec(arg.id);
	const r = run(s, defaults(s, arg.over ?? {}), { width: arg.w ?? 480, height: arg.h ?? 270 }, arg.bg ? solid(arg.bg) : picture, {
		frame: arg.frame ?? 30,
	});
	const c = document.createElement('canvas');
	c.width = r.out.width;
	c.height = r.out.height;
	const ctx = c.getContext('2d')!;
	ctx.fillStyle = '#202020';
	ctx.fillRect(0, 0, c.width, c.height);
	ctx.drawImage(r.out, 0, 0);
	return { url: c.toDataURL('image/png'), ms: r.ms };
}

const api = {
	png,
	/** Compiles and runs every effect of the family at default params (several frames), checking alpha sanity. */
	catalogue() {
		const fam = FX_FAMILIES.find((f) => f.file === 'simulation-warp')!;
		const errors: string[] = [];
		for (const s of fam.effects) {
			for (const frame of [0, 17]) {
				try {
					const r = run(s, defaults(s), box, picture, { frame });
					if (!premulOk(r.out)) errors.push(`${s.id}@${frame}: broken premultiplied alpha`);
				} catch (e) {
					errors.push(`${s.id}@${frame}: ${(e as Error).message}`);
				}
			}
		}
		return { count: fam.effects.length, errors };
	},

	/** Same params + frame → same pixels; another seed → other pixels; the next frame moves. */
	determinism(arg: { id: string; over?: Record<string, unknown>; frame?: number }) {
		const f = arg.frame ?? 12;
		const a = fx(arg.id, arg.over, { frame: f });
		const b = fx(arg.id, arg.over, { frame: f });
		const c = fx(arg.id, arg.over, { frame: f, seed: 0.71 });
		const d = fx(arg.id, arg.over, { frame: f + 3 });
		return { same: maxDiff(a.out, b.out), seed: sumDiff(a.out, c.out), moves: sumDiff(a.out, d.out), ms: a.ms };
	},

	weather() {
		const rain = fx('jasper.rainfall', { drops: 400, opacity: 100, appearance: 'softSolid', color: [1, 1, 1, 1] }, { frame: 15 }, solid('#333'));
		const noRain = fx('jasper.rainfall', { drops: 0 }, { frame: 15 }, solid('#333'));
		const rainOnly = fx('jasper.rainfall', { drops: 400, compositeWithOriginal: false }, { frame: 15 }, solid('#333'));
		const snow = fx('jasper.snowfall', { flakes: 300 }, { frame: 30 }, solid('#333'));
		const bubbles = fx('jasper.bubbles', { bubbleAmount: 30, bubbleSize: 3 }, { frame: 9 });
		const noBubbles = fx('jasper.bubbles', { bubbleAmount: 0 }, { frame: 9 });
		const one = (f: number) =>
			centroid(fx('jasper.bubbles', { bubbleAmount: 1, bubbleSize: 4, wobbleAmplitude: 0, bubbleSpeed: 0.2 }, { frame: f }).out);
		const drizzle = fx('jasper.drizzle', {}, { frame: 18 });
		const noDrizzle = fx('jasper.drizzle', { dripRate: 0 }, { frame: 18 });
		const star = fx('jasper.star-burst', { gridSpacing: 4 }, { frame: 15 });
		const star2 = fx('jasper.star-burst', { gridSpacing: 4 }, { frame: 27 });
		const starFull = fx('jasper.star-burst', { blendWithOriginal: 100 }, { frame: 15 });
		return {
			rainVisible: sumDiff(rain.out, rain.input),
			noRain: maxDiff(noRain.out, noRain.input),
			rainOnlyAlpha: mean(rainOnly.out)[3],
			snowVisible: sumDiff(snow.out, snow.input),
			bubblesAlpha: mean(bubbles.out)[3],
			noBubblesAlpha: mean(noBubbles.out)[3],
			bubbleY: [one(0)[1], one(6)[1]],
			drizzle: sumDiff(drizzle.out, drizzle.input),
			noDrizzle: maxDiff(noDrizzle.out, noDrizzle.input),
			starAlpha: mean(star.out)[3],
			starMoves: sumDiff(star.out, star2.out),
			starFull: maxDiff(starFull.out, starFull.input),
		};
	},
};

(window as unknown as { __psdgTest: typeof api }).__psdgTest = api;
