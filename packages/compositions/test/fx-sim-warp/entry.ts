// Browser entry of fx-sim-warp-gl.test.ts: characteristic pixels, determinism and seed stability of every effect of
// the simulation-warp family through the real GPU host. Each function returns plain data to assert on.
import { FX_FAMILIES } from '@jasper/project';
import { centroid, centroidLum, defaults, maxDiff, mean, picture, premulOk, px, run, solid, spec, sumDiff } from './harness.ts';

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

	particles() {
		const types = spec('jasper.particle-world').params.find((q) => q.name === 'particleType')!.options!;
		const typeErrors: string[] = [];
		for (const t of types) {
			try {
				const r = fx('jasper.particle-world', { particleType: t, birthRate: 2, birthSize: 0.4, deathSize: 0.4 }, { frame: 20 });
				if (mean(r.out)[3] < 0.05) typeErrors.push(`${t}: nothing drawn`);
			} catch (e) {
				typeErrors.push(`${t}: ${(e as Error).message}`);
			}
		}
		const pw = (over: Record<string, unknown>, frame: number, key = 'k1') =>
			fx('jasper.particle-world', { birthRate: 1, particleType: 'fadedSphere', birthSize: 0.3, deathSize: 0.3, longevity: 3, transferMode: 'blackMatte', ...over }, { frame, instanceKey: key });
		const direct = pw({ seed: 11 }, 60, 'direct');
		pw({ seed: 11 }, 30, 'stepped');
		pw({ seed: 11 }, 45, 'stepped');
		const stepped = pw({ seed: 11 }, 60, 'stepped');
		const start = pw({}, 0, 'zero');
		const up = centroidLum(fx('jasper.particle-world', { birthRate: 2, velocity: 0.2, gravity: 0, particleType: 'fadedSphere', longevity: 3, transferMode: 'blackMatte' }, { frame: 30 }, solid('#000')).out);
		const down = centroidLum(fx('jasper.particle-world', { birthRate: 2, velocity: 0.2, gravity: 2, particleType: 'fadedSphere', longevity: 3, transferMode: 'blackMatte' }, { frame: 30 }, solid('#000')).out);
		const floor = centroidLum(fx('jasper.particle-world', { birthRate: 2, velocity: 0.2, gravity: 4, floorAction: 'glue', floorPosition: 0.1, particleType: 'fadedSphere', longevity: 5 }, { frame: 60 }, solid('#000')).out);
		const grid = fx('jasper.particle-world', { birthRate: 0, showGrid: true, showHorizon: true }, { frame: 0 }, solid('#000'));
		const ps = (dir: number) =>
			centroidLum(fx('jasper.particle-systems', { gravity: 0, animation: 'directionAxis', direction: dir, particleType: 'fadedSphere', transferMode: 'blackMatte' }, { frame: 20 }, solid('#000')).out);
		const mercury = fx('jasper.mercury', { birthRate: 3, radiusX: 10, radiusY: 10 }, { frame: 40 });
		const noMercury = fx('jasper.mercury', { birthRate: 0 }, { frame: 40 });
		return {
			typeErrors,
			seek: maxDiff(direct.out, stepped.out),
			startAlpha: mean(start.out)[0] + mean(start.out)[1] + mean(start.out)[2],
			gravityY: [up[1], down[1]],
			floorY: floor[1],
			gridAlpha: mean(grid.out)[3],
			psUp: ps(0)[1],
			psRight: ps(90)[0],
			mercuryAlpha: mean(mercury.out)[3],
			noMercuryAlpha: mean(noMercury.out)[3],
		};
	},

	cards() {
		const cd = fx('jasper.card-dance', {});
		const cdRot = fx('jasper.card-dance', { yRotationSource: 'intensity1', yRotationMultiplier: 90 });
		const cdZ = fx('jasper.card-dance', { zPositionOffset: -1 });
		const cw0 = fx('jasper.card-wipe', { transitionCompletion: 0 });
		const cw50 = fx('jasper.card-wipe', { transitionCompletion: 50, rows: 1, columns: 8 });
		const cw100 = fx('jasper.card-wipe', { transitionCompletion: 100 });
		const pp0 = fx('jasper.pixel-polly', { startTime: 1 }, { frame: 15 });
		const pp = fx('jasper.pixel-polly', { gridSpacing: 6 }, { frame: 15 });
		const ppTex = fx('jasper.pixel-polly', { gridSpacing: 6, object: 'texturedSquare' }, { frame: 15 });
		const at = (c: HTMLCanvasElement, x: number, y: number) => px(c, x, y);
		return {
			cdRest: maxDiff(cd.out, cd.input),
			cdRot: sumDiff(cdRot.out, cdRot.input),
			cdZ: sumDiff(cdZ.out, cdZ.input),
			cwRest: maxDiff(cw0.out, cw0.input),
			cwLeft: at(cw50.out, 4, 32)[3],
			cwRight: at(cw50.out, 92, 32)[3],
			cwDone: mean(cw100.out)[3],
			ppBefore: maxDiff(pp0.out, pp0.input),
			ppAfter: sumDiff(pp.out, pp.input),
			ppTex: sumDiff(pp.out, ppTex.out),
		};
	},

	shatter() {
		const base = { view: 'rendered' };
		const t0 = fx('jasper.shatter', base, { frame: 0 });
		const t1 = fx('jasper.shatter', base, { frame: 15 });
		const patterns = ['bricks', 'glass', 'hexagons', 'squares', 'triangles'].map((pattern) => {
			const r = fx('jasper.shatter', { ...base, pattern }, { frame: 0 });
			return maxDiff(r.out, r.input);
		});
		const wire = fx('jasper.shatter', { view: 'wireframeFrontView', repetitions: 3 }, { frame: 0 });
		const layerOnly = fx('jasper.shatter', { ...base, render: 'layer' }, { frame: 15 });
		const piecesOnly = fx('jasper.shatter', { ...base, render: 'pieces' }, { frame: 15 });
		const forces = fx('jasper.shatter', { view: 'wireframeFrontViewForces' }, { frame: 0 });
		return {
			rest: maxDiff(t0.out, t0.input),
			moved: sumDiff(t1.out, t1.input),
			patterns,
			wireMax: mean(wire.out)[3],
			wireHasGaps: px(wire.out, 48, 32)[3] < 255 ? 1 : 0,
			layerCentre: px(layerOnly.out, 48, 32)[3],
			layerCorner: px(layerOnly.out, 2, 2)[3],
			piecesCorner: px(piecesOnly.out, 2, 2)[3],
			forcesRed: mean(forces.out)[0] - mean(wire.out)[0],
		};
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
