import {
	FX_FAMILIES,
	liquifyApplyStroke,
	liquifyEmpty,
	meshWarpRest,
	meshWarpSetVertex,
	resolvePuppet,
} from '@jasper/project';
import {
	canvas,
	centroid,
	centroidLum,
	defaults,
	maxDiff,
	mean,
	picture,
	pixelsOf,
	premulOk,
	px,
	run,
	solid,
	spec,
	sumDiff,
} from './harness.ts';

const W = 96;
const H = 64;
const box = { width: W, height: H };

const fx = (
	id: string,
	over: Record<string, unknown> = {},
	extra: Parameters<typeof run>[4] = {},
	paint = picture,
) => {
	const s = spec(id);
	return run(s, defaults(s, over), box, paint, extra);
};

function canvasRegion(c: HTMLCanvasElement, x: number, y: number, w: number, h: number): HTMLCanvasElement {
	return canvas(w, h, (ctx) => ctx.drawImage(c, x, y, w, h, 0, 0, w, h));
}

function png(arg: {
	id: string;
	over?: Record<string, unknown>;
	frame?: number;
	w?: number;
	h?: number;
	bg?: string;
}) {
	const s = spec(arg.id);
	const r = run(
		s,
		defaults(s, arg.over ?? {}),
		{ width: arg.w ?? 480, height: arg.h ?? 270 },
		arg.bg ? solid(arg.bg) : picture,
		{
			frame: arg.frame ?? 30,
		},
	);
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

	determinism(arg: { id: string; over?: Record<string, unknown>; frame?: number }) {
		const f = arg.frame ?? 12;
		const a = fx(arg.id, arg.over, { frame: f });
		const b = fx(arg.id, arg.over, { frame: f });
		const c = fx(arg.id, arg.over, { frame: f, seed: 0.71 });
		const d = fx(arg.id, arg.over, { frame: f + 3 });
		return {
			same: maxDiff(a.out, b.out),
			seed: sumDiff(a.out, c.out),
			moves: sumDiff(a.out, d.out),
			ms: a.ms,
		};
	},

	particles() {
		const types = spec('jasper.particle-world').params.find((q) => q.name === 'particleType')!.options!;
		const typeErrors: string[] = [];
		for (const t of types) {
			try {
				const r = fx(
					'jasper.particle-world',
					{ particleType: t, birthRate: 2, birthSize: 0.4, deathSize: 0.4 },
					{ frame: 20 },
				);
				if (mean(r.out)[3] < 0.05) typeErrors.push(`${t}: nothing drawn`);
			} catch (e) {
				typeErrors.push(`${t}: ${(e as Error).message}`);
			}
		}
		const pw = (over: Record<string, unknown>, frame: number, key = 'k1') =>
			fx(
				'jasper.particle-world',
				{
					birthRate: 1,
					particleType: 'fadedSphere',
					birthSize: 0.3,
					deathSize: 0.3,
					longevity: 3,
					transferMode: 'blackMatte',
					...over,
				},
				{ frame, instanceKey: key },
			);
		const direct = pw({ seed: 11 }, 60, 'direct');
		pw({ seed: 11 }, 30, 'stepped');
		pw({ seed: 11 }, 45, 'stepped');
		const stepped = pw({ seed: 11 }, 60, 'stepped');
		const start = pw({}, 0, 'zero');
		const up = centroidLum(
			fx(
				'jasper.particle-world',
				{
					birthRate: 2,
					velocity: 0.2,
					gravity: 0,
					particleType: 'fadedSphere',
					longevity: 3,
					transferMode: 'blackMatte',
				},
				{ frame: 30 },
				solid('#000'),
			).out,
		);
		const down = centroidLum(
			fx(
				'jasper.particle-world',
				{
					birthRate: 2,
					velocity: 0.2,
					gravity: 2,
					particleType: 'fadedSphere',
					longevity: 3,
					transferMode: 'blackMatte',
				},
				{ frame: 30 },
				solid('#000'),
			).out,
		);
		const floor = centroidLum(
			fx(
				'jasper.particle-world',
				{
					birthRate: 2,
					velocity: 0.2,
					gravity: 4,
					floorAction: 'glue',
					floorPosition: 0.1,
					particleType: 'fadedSphere',
					longevity: 5,
				},
				{ frame: 60 },
				solid('#000'),
			).out,
		);
		const grid = fx(
			'jasper.particle-world',
			{ birthRate: 0, showGrid: true, showHorizon: true },
			{ frame: 0 },
			solid('#000'),
		);
		const ps = (dir: number) =>
			centroidLum(
				fx(
					'jasper.particle-systems',
					{
						gravity: 0,
						animation: 'directionAxis',
						direction: dir,
						particleType: 'fadedSphere',
						transferMode: 'blackMatte',
					},
					{ frame: 20 },
					solid('#000'),
				).out,
			);
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

	pixelFx() {
		const balls = fx('jasper.ball-action', { ballSize: 80 });
		const noBalls = fx('jasper.ball-action', { ballSize: 0 });
		const scattered = fx('jasper.ball-action', { ballSize: 80, scatter: 20 });
		const sz0 = fx('jasper.scatterize', {});
		const sz = fx('jasper.scatterize', { scatter: 5 });
		const tw = fx('jasper.scatterize', { leftTwist: 80, rightTwist: 80 });
		const hair = fx('jasper.hair', { length: 12 });
		const noHair = fx('jasper.hair', { density: 0 });
		const heavy = fx('jasper.hair', { length: 12, weight: 2 });
		return {
			ballsAlpha: mean(balls.out)[3],
			ballGap: px(balls.out, 0, 0)[3],
			noBalls: mean(noBalls.out)[3],
			scatter: sumDiff(balls.out, scattered.out),
			szIdentity: maxDiff(sz0.out, sz0.input),
			sz: sumDiff(sz.out, sz.input),
			tw: sumDiff(tw.out, tw.input),
			hair: sumDiff(hair.out, hair.input),
			noHair: maxDiff(noHair.out, noHair.input),
			weight: sumDiff(hair.out, heavy.out),
		};
	},

	surfaces() {
		const foam = (frame: number, key: string, over: Record<string, unknown> = {}) =>
			fx('jasper.foam', { productionRate: 3, ...over }, { frame, instanceKey: key });
		const f1 = foam(40, 'a');
		foam(20, 'b');
		const f2 = foam(40, 'b');
		const rendered = foam(40, 'c', { view: 'rendered' });
		const f0 = foam(0, 'd');
		// Wave World: flat without amplitude, waves with it; ground with a dry (bright) right half.
		const ww = (over: Record<string, unknown>, frame: number, extra = {}) =>
			fx('jasper.wave-world', { view: 'heightMap', gridResolution: 24, ...over }, { frame, ...extra });
		const flat = ww({ producer1Amplitude: 0 }, 30);
		const waves = ww({}, 30);
		const wire = fx('jasper.wave-world', { gridResolution: 10 }, { frame: 10 });
		const ground = canvas(32, 32, (ctx) => {
			ctx.fillStyle = '#000';
			ctx.fillRect(0, 0, 16, 32);
			ctx.fillStyle = '#fff';
			ctx.fillRect(16, 0, 16, 32);
		});
		const dry = ww(
			{
				ground: { mediaId: 'g' },
				steepness: 0.5,
				groundHeight: 0.25,
				renderDryAreasAs: 'transparent',
				producer1Position: [0.25, 0.5],
			},
			30,
			{
				pixels: { ground: pixelsOf(ground, 'g1') },
			},
		);
		const wwSeek1 = ww({}, 45, { instanceKey: 'w1' });
		ww({}, 15, { instanceKey: 'w2' });
		const wwSeek2 = ww({}, 45, { instanceKey: 'w2' });
		// Caustics: flat water + light overhead + no surface = the bottom; a surface map refracts.
		const ident = fx('jasper.caustics', {
			surfaceOpacity: 0,
			ambientLight: 0,
			diffuseReflection: 1,
			lightHeight: 10,
			specularReflection: 0,
			smoothing: 0,
		});
		const surface = canvas(64, 64, (ctx) => {
			const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
			g.addColorStop(0, '#fff');
			g.addColorStop(1, '#000');
			ctx.fillStyle = g;
			ctx.fillRect(0, 0, 64, 64);
		});
		const wavy = fx(
			'jasper.caustics',
			{ waterSurface: { mediaId: 'w' }, waveHeight: 1, waterDepth: 1, causticsStrength: 1 },
			{
				textures: { u_waterSurface: { source: surface, width: 64, height: 64, version: '1' } },
			},
		);
		return {
			foamAlpha: mean(f1.out)[3],
			foamSeek: maxDiff(f1.out, f2.out),
			foamRendered: sumDiff(f1.out, rendered.out),
			foam0: mean(f0.out)[3],
			flatSpread: Math.abs(mean(flat.out)[0] - 127.5),
			wavesVary: sumDiff(waves.out, flat.out),
			wireGreen: mean(wire.out)[1] - mean(wire.out)[0],
			dryRight: px(dry.out, 88, 32)[3],
			wetLeft: px(dry.out, 8, 32)[3],
			wwSeek: maxDiff(wwSeek1.out, wwSeek2.out),
			causticsIdentity: maxDiff(ident.out, ident.input),
			causticsWavy: sumDiff(wavy.out, wavy.input),
		};
	},

	playground() {
		const pg = (over: Record<string, unknown>, frame: number, extra: Parameters<typeof run>[4] = {}) =>
			fx('jasper.particle-playground', over, { frame, ...extra }, solid('rgba(0,0,0,0)'));
		const cannon = (f: number, key: string) =>
			pg({ cannonPosition: [0.5, 0.8], cannonVelocity: 60, gravityForce: 30 }, f, { instanceKey: key });
		const a = cannon(30, 'c1');
		cannon(60, 'c2');
		cannon(10, 'c2');
		const b = cannon(30, 'c2');
		const z = cannon(0, 'c3');
		const grid = (f: number, extra: Parameters<typeof run>[4] = {}) =>
			pg(
				{
					cannonParticlesPerSecond: 0,
					gridPosition: [0.5, 10 / 64],
					gridWidth: 40,
					gridHeight: 0,
					gridParticlesAcross: 5,
					gridParticlesDown: 1,
					gravityForce: 100,
					wallBoundary: 'mask1',
				},
				f,
				extra,
			);
		const masks = [
			{
				id: 'm',
				closed: true,
				inverted: false,
				points: [
					[0, 0],
					[96, 0],
					[96, 15],
					[0, 15],
				] as [number, number][],
			},
		];
		const spread = (force: number) => {
			const r = pg(
				{
					cannonParticlesPerSecond: 0,
					gridWidth: 6,
					gridHeight: 6,
					gridParticlesAcross: 3,
					gridParticlesDown: 3,
					gravityForce: 0,
					repelForce: force,
					repelForceRadius: 20,
				},
				15,
			);
			let x0 = 999;
			let x1 = -1;
			const d = r.out.getContext('2d')!.getImageData(0, 0, r.out.width, r.out.height).data;
			for (let y = 0; y < r.out.height; y++)
				for (let x = 0; x < r.out.width; x++)
					if (d[(y * r.out.width + x) * 4 + 3]! > 80) {
						x0 = Math.min(x0, x);
						x1 = Math.max(x1, x);
					}
			return x1 - x0;
		};
		const text = pg(
			{
				cannonParticlesPerSecond: 0,
				gridParticlesAcross: 3,
				gridParticlesDown: 1,
				gridWidth: 50,
				gravityForce: 0,
				gridText: 'ABC',
				gridParticleRadius: 14,
			},
			1,
		);
		const explode = fx(
			'jasper.particle-playground',
			{
				cannonParticlesPerSecond: 0,
				explodeSource: 'thisLayer',
				explodeRadius: 2,
				explodeDispersion: 0,
				gravityForce: 0,
			},
			{ frame: 1 },
		);
		return {
			cannonAlpha: mean(a.out)[3],
			cannonSeek: maxDiff(a.out, b.out),
			cannonZero: mean(z.out)[3],
			gridY0: centroid(grid(0).out)[1],
			gridY1: centroid(grid(15).out)[1],
			wallY: centroid(grid(45, { structures: { masks } }).out)[1],
			spread: [spread(0), spread(0.2)],
			textAlpha: mean(text.out)[3],
			explodeColour: mean(explode.out),
			sourceColour: mean(explode.input),
		};
	},

	distort() {
		const id = (fxId: string, over: Record<string, unknown> = {}) => {
			const r = fx(fxId, over);
			return maxDiff(r.out, r.input);
		};
		const sq = (x0: number, y0: number, x1: number, y1: number) => ({
			id: `${x0}`,
			closed: true,
			inverted: false,
			points: [
				[x0, y0],
				[x1, y0],
				[x1, y1],
				[x0, y1],
			] as [number, number][],
		});
		const masks = [sq(30, 20, 50, 40), sq(20, 10, 70, 50), sq(5, 2, 90, 60)];
		const ctxMasks = { structures: { masks } };
		const rs = fx(
			'jasper.reshape',
			{ sourceMask: 'mask1', destinationMask: 'mask2', boundaryMask: 'mask3' },
			ctxMasks,
		);
		const sm = fx(
			'jasper.smear',
			{ sourceMask: 'mask1', boundaryMask: 'mask3', maskOffset: [10, 5] },
			ctxMasks,
		);
		const dmMap = canvas(96, 64, (ctx) => {
			ctx.fillStyle = 'rgb(255,128,0)';
			ctx.fillRect(0, 0, 96, 64);
		});
		const dm = fx(
			'jasper.displacement-map',
			{
				displacementMapLayer: { mediaId: 'm' },
				displacementMapBehavior: 'stretchMapToFit',
				maxHorizontal: 10,
				maxVertical: 0,
				expandOutput: false,
			},
			{
				textures: { u_displacementMapLayer: { source: dmMap, width: 96, height: 64, version: '1' } },
			},
		);
		const bw = fx('jasper.bezier-warp', { topLeftVertex: [0.2, 0.1] });
		return {
			identities: {
				dmOff: id('jasper.displacement-map', {
					useForHorizontal: 'off',
					useForVertical: 'off',
					expandOutput: false,
				}),
				dmHalf: id('jasper.displacement-map', {
					useForHorizontal: 'half',
					useForVertical: 'half',
					expandOutput: false,
				}),
				optics: id('jasper.optics-compensation'),
				polar: id('jasper.polar-coordinates'),
				bezier: id('jasper.bezier-warp'),
				reshapeNoMasks: id('jasper.reshape', { sourceMask: 'mask1', destinationMask: 'mask2' }),
				smearNoMasks: id('jasper.smear'),
			},
			optics: sumDiff(
				fx('jasper.optics-compensation', { fieldOfView: 90 }).out,
				fx('jasper.optics-compensation').out,
			),
			polar: sumDiff(
				fx('jasper.polar-coordinates', { interpolation: 100 }).out,
				fx('jasper.polar-coordinates').input,
			),
			dmShift: [px(dm.out, 20, 30), px(dm.input, 30, 30)],
			reshape: sumDiff(rs.out, rs.input),
			reshapeOutside: maxDiff(canvasRegion(rs.out, 0, 0, 4, 64), canvasRegion(rs.input, 0, 0, 4, 64)),
			smear: sumDiff(sm.out, sm.input),
			bezier: sumDiff(bw.out, bw.input),
			bezierCorner: px(bw.out, 1, 1)[3],
		};
	},

	warps() {
		const mwRest = fx('jasper.mesh-warp', { distortionMesh: meshWarpRest(7, 7) });
		const mwEmpty = fx('jasper.mesh-warp', {});
		const moved = meshWarpSetVertex(meshWarpRest(4, 4), 2, 2, [0.7, 0.5]);
		const mw = fx('jasper.mesh-warp', { rows: 4, columns: 4, distortionMesh: moved });
		const lq0 = fx('jasper.liquify', {});
		const mesh = liquifyApplyStroke(liquifyEmpty(W, H), W, H, {
			tool: 'warp',
			points: [
				[30, 32],
				[60, 32],
			],
			size: 40,
			pressure: 100,
		});
		const lq = fx('jasper.liquify', { distortionMesh: mesh });
		const lqHalf = fx('jasper.liquify', { distortionMesh: mesh, distortionPercentage: 50 });
		const lqView = fx('jasper.liquify', { distortionMesh: mesh, viewMesh: true });
		const pupDoc = {
			meshes: [{ id: 'm', name: 'M', seed: [0.5, 0.5], density: 50, expansion: 0, triangles: 200 }],
			pins: [
				{
					id: 'a',
					name: 'a',
					kind: 'position',
					meshId: 'm',
					rest: [0.1, 0.5],
					position: { value: [0.1, 0.5], keyframes: [] },
					scale: { value: 100, keyframes: [] },
					rotation: { value: 0, keyframes: [] },
					amount: { value: 50, keyframes: [] },
					extent: { value: 15, keyframes: [] },
					inFront: { value: 50, keyframes: [] },
				},
				{
					id: 'b',
					name: 'b',
					kind: 'position',
					meshId: 'm',
					rest: [0.9, 0.5],
					position: { value: [0.9, 0.1], keyframes: [] },
					scale: { value: 100, keyframes: [] },
					rotation: { value: 0, keyframes: [] },
					amount: { value: 50, keyframes: [] },
					extent: { value: 15, keyframes: [] },
					inFront: { value: 50, keyframes: [] },
				},
			],
		};
		const rest = JSON.parse(JSON.stringify(pupDoc));
		rest.pins[1].position.value = [0.9, 0.5];
		const pp0 = fx('jasper.puppet', {}, { structures: { puppet: resolvePuppet(rest as never, 0) } });
		const pp = fx('jasper.puppet', {}, { structures: { puppet: resolvePuppet(pupDoc as never, 0) } });
		const ppNone = fx('jasper.puppet', {});
		return {
			mwRest: maxDiff(mwRest.out, mwRest.input),
			mwEmpty: maxDiff(mwEmpty.out, mwEmpty.input),
			mw: sumDiff(mw.out, mw.input),
			lq0: maxDiff(lq0.out, lq0.input),
			lq: sumDiff(lq.out, lq.input),
			lqHalf: sumDiff(lqHalf.out, lqHalf.input),
			lqView: sumDiff(lqView.out, lq.out),
			pp0: maxDiff(
				canvasRegion(pp0.out, pp0.layout.box.x, pp0.layout.box.y, W, H),
				canvasRegion(pp0.input, pp0.layout.box.x, pp0.layout.box.y, W, H),
			),
			pp: sumDiff(
				canvasRegion(pp.out, pp.layout.box.x, pp.layout.box.y, W, H),
				canvasRegion(pp.input, pp.layout.box.x, pp.layout.box.y, W, H),
			),
			ppCanvas: [pp.out.width, pp.out.height],
			ppNone: maxDiff(ppNone.out, ppNone.input),
		};
	},

	weather() {
		const rain = fx(
			'jasper.rainfall',
			{ drops: 400, opacity: 100, appearance: 'softSolid', color: [1, 1, 1, 1] },
			{ frame: 15 },
			solid('#333'),
		);
		const noRain = fx('jasper.rainfall', { drops: 0 }, { frame: 15 }, solid('#333'));
		const rainOnly = fx(
			'jasper.rainfall',
			{ drops: 400, compositeWithOriginal: false },
			{ frame: 15 },
			solid('#333'),
		);
		const snow = fx('jasper.snowfall', { flakes: 300 }, { frame: 30 }, solid('#333'));
		const bubbles = fx('jasper.bubbles', { bubbleAmount: 30, bubbleSize: 3 }, { frame: 9 });
		const noBubbles = fx('jasper.bubbles', { bubbleAmount: 0 }, { frame: 9 });
		const one = (f: number) =>
			centroid(
				fx(
					'jasper.bubbles',
					{ bubbleAmount: 1, bubbleSize: 4, wobbleAmplitude: 0, bubbleSpeed: 0.2 },
					{ frame: f },
				).out,
			);
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

export type SimulationApi = typeof api;

(window as unknown as { __psdgTest: SimulationApi }).__psdgTest = api;
