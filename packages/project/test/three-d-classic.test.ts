// three-d: the Classic 3D CPU reference renderer (the oracle of the GL renderer) — golden behaviour: default camera
// = the 2D placement, per-pixel depth sort of intersecting planes, stack order of coplanar planes, blend modes in
// depth order, lights (Lambert, spot cone, specular), ray-cast shadows (incl. coloured through Light Transmission),
// Accepts Shadows Only, and the bokeh depth of field (EffectCraft bokeh tests).
import { describe, expect, it } from 'vitest';
import {
	anim,
	blurLevels,
	bokehBlur,
	boostHighlights,
	type CameraState,
	type ClassicSetup,
	defaultCamera,
	type FloatImage,
	type Iris,
	kernelSpans,
	layerWorldMatrix,
	lightStateOf,
	type Mat3,
	materialAt,
	newFloatImage,
	newLayer3D,
	newLightData,
	type PlaneSource,
	prepareClassicPlane,
	progressiveBlur,
	renderClassicCPU,
	type Transform,
	type Vec3,
} from '../src/index.ts';

const W = 64;
const H = 48;
const FPS = { num: 30, den: 1 };

function solid(w: number, h: number, rgba: [number, number, number, number]): FloatImage {
	const img = newFloatImage(w, h);
	for (let i = 0; i < w * h; i++) img.data.set([rgba[0] * rgba[3], rgba[1] * rgba[3], rgba[2] * rgba[3], rgba[3]], i * 4);
	return img;
}
const tr = (o: Partial<Record<keyof Transform, unknown>> = {}): Transform =>
	({
		position: anim([W / 2, H / 2]),
		anchor: anim([16, 12]),
		scale: anim(100),
		scaleWidth: anim(100),
		uniformScale: true,
		rotation: anim(0),
		flipH: false,
		flipV: false,
		...o,
	}) as Transform;
const ID: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function plane(
	key: string,
	order: number,
	o: { transform?: Transform; td?: ReturnType<typeof newLayer3D>; mode?: string; opacity?: number; w?: number; h?: number } = {},
): PlaneSource {
	const td = o.td ?? newLayer3D();
	return {
		key,
		width: o.w ?? 32,
		height: o.h ?? 24,
		layerToPicture: ID,
		world: layerWorldMatrix({ transform: o.transform ?? tr(), threeD: td }, 0),
		material: materialAt(td.material, 0),
		opacity: o.opacity ?? 1,
		mode: o.mode ?? 'normal',
		seed: 1,
		order,
		draw: td.material.castsShadows !== 'only',
	};
}
const setup = (o: Partial<ClassicSetup> = {}): ClassicSetup => ({
	width: W,
	height: H,
	scale: 1,
	frame: { width: W, height: H },
	camera: defaultCamera(W, H),
	lights: [],
	...o,
});
const px = (img: FloatImage, x: number, y: number) => Array.from(img.data.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));

describe('Classic 3D (CPU reference)', () => {
	it('a plane at its defaults is drawn exactly where its 2D Motion puts it', () => {
		const canvas = newFloatImage(W, H);
		renderClassicCPU(canvas, setup(), [{ src: plane('a', 0), pixels: solid(32, 24, [1, 0, 0, 1]) }]);
		// Anchor (16,12) at (32,24) → covers x 16…48, y 12…36.
		expect(px(canvas, 16, 12)).toEqual([1, 0, 0, 1]);
		expect(px(canvas, 47, 35)).toEqual([1, 0, 0, 1]);
		expect(px(canvas, 15, 12)[3]).toBe(0);
		expect(px(canvas, 48, 35)[3]).toBe(0);
	});

	it('the nearer plane wins whatever the stack order; intersecting planes split along their intersection', () => {
		const near = newLayer3D();
		near.positionZ = anim(-20); // the camera is at z = −88.9 (64 px wide frame)
		const canvas = newFloatImage(W, H);
		renderClassicCPU(canvas, setup(), [
			{ src: plane('near', 0, { td: near }), pixels: solid(32, 24, [0, 1, 0, 1]) },
			{ src: plane('far', 1), pixels: solid(32, 24, [1, 0, 0, 1]) },
		]);
		expect(px(canvas, 32, 24)).toEqual([0, 1, 0, 1]);
		// Two planes crossing through x = 32: one tilted about Y, the other flat. Left of the crossing the tilted plane
		// is in front (rotation Y +30° brings its left edge toward the camera), right of it behind.
		const tilt = newLayer3D();
		tilt.rotationY = anim(30);
		const c2 = newFloatImage(W, H);
		renderClassicCPU(c2, setup(), [
			{ src: plane('tilt', 1, { td: tilt }), pixels: solid(32, 24, [0, 0, 1, 1]) },
			{ src: plane('flat', 0), pixels: solid(32, 24, [1, 0, 0, 1]) },
		]);
		const left = px(c2, 24, 24);
		const right = px(c2, 40, 24);
		expect(left[2]! > 0.99 || right[2]! > 0.99).toBe(true);
		expect(left[2]! > 0.99 && right[2]! > 0.99).toBe(false);
		expect(left[0]! + right[0]!).toBeGreaterThan(0.99);
	});

	it('coplanar planes keep stack order; blend modes apply in depth order', () => {
		const canvas = solid(W, H, [0.5, 0.5, 0.5, 1]);
		renderClassicCPU(canvas, setup(), [
			{ src: plane('a', 0), pixels: solid(32, 24, [1, 0, 0, 1]) },
			{ src: plane('b', 1, { mode: 'multiply' }), pixels: solid(32, 24, [0.5, 1, 1, 1]) },
		]);
		expect(px(canvas, 32, 24)).toEqual([0.5, 0, 0, 1]);
		expect(px(canvas, 2, 2)).toEqual([0.5, 0.5, 0.5, 1]);
	});

	it('lights: no lights = unlit; a parallel light facing the plane lights it by diffuse·N·L + ambient', () => {
		const rig = { start: 0, duration: 10, sourceIn: 0, speed: { rate: 1, reverse: false, maintainPitch: false } };
		const light = (type: 'parallel' | 'ambient', o = {}) =>
			lightStateOf({ clipId: type, name: type, trackIndex: 0, ...rig, light: newLightData(type, { width: W, height: H }, o) }, 0, FPS);
		const par = light('parallel');
		// Aim straight at the plane (from the camera side).
		par.dir = [0, 0, 1];
		const canvas = newFloatImage(W, H);
		renderClassicCPU(canvas, setup({ lights: [par, light('ambient', { intensity: 20 })] }), [
			{ src: plane('a', 0), pixels: solid(32, 24, [1, 1, 1, 1]) },
		]);
		// diffuse 50 % · 1 + ambient 100 % · 0.2 + specular 50 % · (N·H)^1.32 · metal → white: 0.5 + 0.2 + 0.5 = 1.2
		const v = px(canvas, 32, 24);
		expect(v[0]).toBeCloseTo(1.2, 4);
	});

	it('ray-cast shadows: a caster between a light and a receiver darkens it; Light Transmission tints it', () => {
		const rig = { start: 0, duration: 10, sourceIn: 0, speed: { rate: 1, reverse: false, maintainPitch: false } };
		const l = lightStateOf(
			{ clipId: 'l', name: 'l', trackIndex: 0, ...rig, light: newLightData('parallel', { width: W, height: H }, { castsShadows: true }) },
			0,
			FPS,
		);
		l.dir = [0, 0, 1];
		const recv = newLayer3D();
		recv.material.specularIntensity = anim(0);
		recv.material.ambient = anim(0);
		const caster = newLayer3D();
		caster.positionZ = anim(-30);
		caster.material.castsShadows = 'only';
		// Small caster (8×8) in the middle, receiver 32×24.
		const big = renderShadow(caster, recv, l, [1, 1, 1, 1]);
		expect(big.centre).toBeLessThan(0.01);
		expect(big.edge).toBeCloseTo(0.5, 5);
		// 100 % transmission through a red caster: red light passes, green/blue blocked.
		caster.material.lightTransmission = anim(100);
		const tinted = renderShadow(caster, recv, l, [1, 0, 0, 1]);
		expect(tinted.rgb[0]).toBeCloseTo(0.5, 5);
		expect(tinted.rgb[1]).toBeLessThan(0.01);
	});

	it('Accepts Shadows: Only draws just the shadow', () => {
		const rig = { start: 0, duration: 10, sourceIn: 0, speed: { rate: 1, reverse: false, maintainPitch: false } };
		const l = lightStateOf(
			{ clipId: 'l', name: 'l', trackIndex: 0, ...rig, light: newLightData('parallel', { width: W, height: H }, { castsShadows: true }) },
			0,
			FPS,
		);
		l.dir = [0, 0, 1];
		const recv = newLayer3D();
		recv.material.acceptsShadows = 'only';
		const caster = newLayer3D();
		caster.positionZ = anim(-30);
		caster.material.castsShadows = 'only';
		const r = renderShadow(caster, recv, l, [1, 1, 1, 1]);
		expect(r.alphaCentre).toBeCloseTo(1, 5);
		expect(r.alphaEdge).toBe(0);
	});

	it('depth of field: a plane at the focus distance stays sharp, a farther one is blurred', () => {
		const cam: CameraState = { ...defaultCamera(W, H) };
		cam.dof = {
			focus: cam.zoom,
			aperture: 20,
			blurLevel: 1,
			iris: { sides: 6, rotation: 0, roundness: 1, aspect: 1, fringe: 0 },
			highlight: { gain: 0, threshold: 1, saturation: 0 },
		};
		const sharp = prepareClassicPlane(setup({ camera: cam }), plane('a', 0));
		expect(sharp?.dof).toBeNull();
		const far = newLayer3D();
		far.positionZ = anim(cam.zoom);
		const p = prepareClassicPlane(setup({ camera: cam }), plane('b', 0, { td: far }))!;
		expect(p.dof).not.toBeNull();
		// coc = 20 · |2z − z| / 2z = 10 px on screen; layer at half size → radius 10 layer px.
		expect(p.dof!.radius(p.width / 2, p.height / 2)).toBeCloseTo(10, 6);
	});
});

function renderShadow(caster: ReturnType<typeof newLayer3D>, recv: ReturnType<typeof newLayer3D>, l: ReturnType<typeof lightStateOf>, color: [number, number, number, number]) {
	const canvas = newFloatImage(W, H);
	renderClassicCPU(canvas, setup({ lights: [l] }), [
		{ src: plane('recv', 0, { td: recv }), pixels: solid(32, 24, [1, 1, 1, 1]) },
		{
			src: plane('caster', 1, { td: caster, transform: tr({ anchor: anim([4, 4]) }), w: 8, h: 8 }),
			pixels: solid(8, 8, color),
		},
	]);
	const c = px(canvas, 32, 24);
	const e = px(canvas, 18, 14);
	return { centre: c[0]!, edge: e[0]!, rgb: c, alphaCentre: c[3]!, alphaEdge: e[3]! };
}

describe('bokeh (EffectCraft bokeh tests, ported)', () => {
	const dot = (size: number) => {
		const img = newFloatImage(size, size);
		const c = size >> 1;
		img.data.set([1, 1, 1, 1], (c * size + c) * 4);
		return img;
	};
	const lit = (img: FloatImage, x: number, y: number) => {
		const c = img.width >> 1;
		return img.data[((c + y) * img.width + c + x) * 4 + 3]! > 1e-4;
	};
	const iris = (o: Partial<Iris>): Iris => ({ sides: 0, rotation: 0, roundness: 0, aspect: 1, fringe: 0, ...o });

	it('kernel shapes', () => {
		const hex = iris({ sides: 6 });
		let b = bokehBlur(dot(81), hex, 20);
		expect(lit(b, 19, 0)).toBe(true);
		const x = Math.round(19.4 * Math.cos(Math.PI / 6));
		const y = Math.round(19.4 * Math.sin(Math.PI / 6));
		expect(lit(b, x, y)).toBe(false);
		b = bokehBlur(dot(81), { ...hex, rotation: 30 }, 20);
		expect(!lit(b, 19, 0) && lit(b, x, y)).toBe(true);
		b = bokehBlur(dot(81), { ...hex, roundness: 1 }, 20);
		expect(lit(b, 19, 0) && lit(b, x, y)).toBe(true);
		const area = (sides: number) => {
			const o = bokehBlur(dot(81), iris({ sides }), 20);
			let n = 0;
			for (let i = 3; i < o.data.length; i += 4) if (o.data[i]! > 1e-4) n++;
			return n;
		};
		expect(area(3) * 2).toBeLessThan(area(10));
		const wide = bokehBlur(dot(121), iris({ sides: 8, aspect: 4 }), 15);
		expect(lit(wide, 28, 0) && !lit(wide, 0, 10)).toBe(true);
		let sum = 0;
		for (let i = 3; i < wide.data.length; i += 4) sum += wide.data[i]!;
		expect(Math.abs(sum - 1)).toBeLessThan(1e-3);
	});

	it('diffraction fringe brightens the rim', () => {
		const plain = bokehBlur(dot(81), iris({ sides: 8 }), 20);
		const fringe = bokehBlur(dot(81), iris({ sides: 8, fringe: 2 }), 20);
		const at = (img: FloatImage, x: number) => img.data[(40 * 81 + 40 + x) * 4 + 3]!;
		expect(Math.abs(at(plain, 0) - at(plain, 17))).toBeLessThan(1e-6);
		expect(at(fringe, 18)).toBeGreaterThan(at(fringe, 0) * 1.5);
	});

	it('highlights boost only above threshold', () => {
		const img = newFloatImage(2, 1);
		img.data.set([0.9, 0.9, 0.9, 1, 0.3, 0.3, 0.3, 1]);
		boostHighlights(img, { gain: 0.5, threshold: 0.8, saturation: 0 });
		expect(img.data[0]!).toBeGreaterThan(1.2);
		expect(img.data[4]!).toBeCloseTo(0.3, 6);
	});

	it('progressive blur follows the radius map', () => {
		const w = 41;
		const h = 41;
		const img = newFloatImage(w, h);
		for (let y = 0; y < h; y++) img.data.set([1, 1, 1, 1], (y * w + 20) * 4);
		const radius = Float32Array.from({ length: w * h }, (_, i) => (Math.floor(i / w) / 40) * 8);
		const out = progressiveBlur(img, iris({ sides: 6, roundness: 1 }), radius);
		const spread = (y: number) => {
			let n = 0;
			for (let x = 0; x < w; x++) if (out.data[(y * w + x) * 4 + 3]! > 0.03) n++;
			return n;
		};
		expect(spread(1)).toBeLessThanOrEqual(3);
		expect(spread(39)).toBeGreaterThanOrEqual(13);
		expect(spread(20) > spread(1) && spread(20) < spread(39)).toBe(true);
		expect(blurLevels([0, 0.1])).toBeNull();
		expect(kernelSpans(iris({}), 0.2)).toBeNull();
	});
});

export type _V = Vec3;
