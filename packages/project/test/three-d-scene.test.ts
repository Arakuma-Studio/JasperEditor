import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	activeCameraClipAt,
	angleOfViewForZoom,
	anim,
	applyMat3,
	cameraStateOf,
	defaultCamera,
	defaultCameraZoom,
	focalLengthForZoom,
	type Keyframe,
	layerMatrix,
	layerWorldMatrix,
	lightAttenuation,
	lightStateOf,
	mat4Apply,
	mat4Invert,
	mat4Mul,
	mat4Orientation,
	newCameraData,
	newLayer3D,
	newLightData,
	orientationMatrixAt,
	orientationOfMat4,
	planeHomography,
	projectPoint,
	type RenderCameraClip,
	type RenderLightClip,
	runs3d,
	type Transform,
	type Vec3,
	zoomForAngleOfView,
	zoomForFocalLength,
} from '../src/index.ts';

const W = 1920;
const H = 1080;
const FPS = { num: 30, den: 1 };

const transform = (o: Partial<Record<keyof Transform, unknown>> = {}): Transform =>
	({
		position: anim([W / 2, H / 2]),
		anchor: anim([320, 180]),
		scale: anim(100),
		scaleWidth: anim(100),
		uniformScale: true,
		rotation: anim(0),
		flipH: false,
		flipV: false,
		...o,
	}) as Transform;

const rig = {
	start: 0,
	duration: 300,
	sourceIn: 0,
	speed: { rate: 1, reverse: false, maintainPitch: false },
};

describe('default camera', () => {
	it('is the 50 mm preset at −zoom', () => {
		const cam = defaultCamera(W, H);
		expect(cam.zoom).toBeCloseTo(2666.6667, 3);
		expect(cam.eye).toEqual([W / 2, H / 2, -cam.zoom]);
		expect(projectPoint(cam, W, H, [100, 200, 0])).toEqual([expect.closeTo(100, 9), expect.closeTo(200, 9)]);
	});

	it('a 3D layer at its defaults projects exactly like its 2D Motion (property test)', () => {
		fc.assert(
			fc.property(
				fc.double({ min: -500, max: 2500, noNaN: true }),
				fc.double({ min: -500, max: 1500, noNaN: true }),
				fc.double({ min: -400, max: 400, noNaN: true }),
				fc.double({ min: 1, max: 400, noNaN: true }),
				fc.double({ min: -720, max: 720, noNaN: true }),
				fc.boolean(),
				(x, y, ax, s, r, flip) => {
					const tr = transform({
						position: anim([x, y]),
						anchor: anim([ax, -ax / 2]),
						scale: anim(s),
						rotation: anim(r),
						flipH: flip,
					});
					const world = layerWorldMatrix({ transform: tr, threeD: newLayer3D() }, 0);
					const h = planeHomography(defaultCamera(W, H), W, H, world)!;
					const m2 = layerMatrix({
						position: [x, y],
						anchor: [ax, -ax / 2],
						scale: s,
						scaleWidth: 100,
						uniformScale: true,
						rotation: r,
						flipH: flip,
						flipV: false,
					});
					for (const p of [
						[0, 0],
						[640, 0],
						[640, 360],
						[13, 77],
					] as [number, number][]) {
						const a = applyMat3(h, p);
						const b = [m2.a * p[0] + m2.c * p[1] + m2.e, m2.b * p[0] + m2.d * p[1] + m2.f];
						expect(Math.abs(a[0] - b[0]!)).toBeLessThan(1e-6);
						expect(Math.abs(a[1] - b[1]!)).toBeLessThan(1e-6);
					}
				},
			),
			{ numRuns: 200 },
		);
	});

	it('pushing a layer back (+z) makes it smaller; toward the camera bigger', () => {
		const td = newLayer3D();
		td.positionZ = anim(defaultCameraZoom(W)); // twice the distance → half the size
		const world = layerWorldMatrix({ transform: transform(), threeD: td }, 0);
		const h = planeHomography(defaultCamera(W, H), W, H, world)!;
		const a = applyMat3(h, [0, 0]);
		const b = applyMat3(h, [640, 0]);
		expect(b[0] - a[0]).toBeCloseTo(320, 6);
	});
});

describe('3D layer transform', () => {
	it('Y rotation of 90° shows the layer edge-on (no homography)', () => {
		const td = newLayer3D();
		td.rotationY = anim(90);
		const world = layerWorldMatrix({ transform: transform(), threeD: td }, 0);
		expect(planeHomography(defaultCamera(W, H), W, H, world)).toBeNull();
	});

	it('X rotation tilts the top edge away (narrower) under perspective', () => {
		const td = newLayer3D();
		td.rotationX = anim(-45);
		const tr = transform({ anchor: anim([320, 180]) });
		const world = layerWorldMatrix({ transform: tr, threeD: td }, 0);
		const h = planeHomography(defaultCamera(W, H), W, H, world)!;
		const top = applyMat3(h, [640, 0])[0] - applyMat3(h, [0, 0])[0];
		const bottom = applyMat3(h, [640, 360])[0] - applyMat3(h, [0, 360])[0];
		// rotationX −45°: the top goes toward +z (away), the bottom toward the camera.
		expect(top).toBeLessThan(bottom);
	});

	it('Z position / scale / anchor Z compose as T·O·Rz·Ry·Rx·S·T(−A)', () => {
		const td = newLayer3D();
		td.anchorZ = anim(50);
		td.scaleZ = anim(200);
		td.positionZ = anim(10);
		const world = layerWorldMatrix({ transform: transform(), threeD: td }, 0);
		const p = mat4Apply(world, [320, 180, 50]);
		expect(p[0]).toBeCloseTo(W / 2, 9);
		expect(p[1]).toBeCloseTo(H / 2, 9);
		expect(p[2]).toBeCloseTo(10, 9);
		// One layer pixel in z is two world pixels.
		expect(mat4Apply(world, [320, 180, 51])[2]).toBeCloseTo(12, 9);
	});

	it('Orientation interpolates along the shortest rotation', () => {
		const k = (id: string, time: number, value: Vec3): Keyframe<Vec3> => ({
			id,
			time,
			value,
			interpolation: 'linear',
			easeIn: { influence: 1 / 3, slope: 1 },
			easeOut: { influence: 1 / 3, slope: 1 },
		});
		// 350° → 10° about Y: the short way goes through 0°, not 180°.
		const o = { value: [0, 350, 0] as Vec3, keyframes: [k('a', 0, [0, 350, 0]), k('b', 100, [0, 10, 0])] };
		const mid = orientationOfMat4(orientationMatrixAt(o, 50));
		expect(Math.min(mid[1], 360 - mid[1])).toBeLessThan(1e-6);
		const end = orientationMatrixAt(o, 100);
		const want = mat4Orientation([0, 10, 0]);
		for (let i = 0; i < 16; i++) expect(end[i]!).toBeCloseTo(want[i]!, 9);
	});

	it('orientationOfMat4 inverts mat4Orientation (property test)', () => {
		fc.assert(
			fc.property(
				fc.double({ min: 0, max: 359, noNaN: true }),
				fc.double({ min: -85, max: 85, noNaN: true }),
				fc.double({ min: 0, max: 359, noNaN: true }),
				(x, y, z) => {
					const m = mat4Orientation([x, y, z]);
					const back = mat4Orientation(orientationOfMat4(m));
					for (let i = 0; i < 16; i++) expect(Math.abs(back[i]! - m[i]!)).toBeLessThan(1e-9);
				},
			),
		);
	});

	it('mat4Invert inverts world matrices', () => {
		const td = newLayer3D();
		td.rotationX = anim(30);
		td.orientation = anim<Vec3>([10, 20, 30]);
		const world = layerWorldMatrix({ transform: transform({ rotation: anim(17) }), threeD: td }, 0);
		const id = mat4Mul(world, mat4Invert(world)!);
		for (let i = 0; i < 16; i++) expect(id[i]!).toBeCloseTo(i % 5 === 0 ? 1 : 0, 9);
	});
});

describe('cameras', () => {
	it('a new two-node camera frames the sequence like the default camera', () => {
		const c: RenderCameraClip = {
			clipId: 'c',
			name: 'Camera 1',
			trackIndex: 1,
			...rig,
			camera: newCameraData({ width: W, height: H }),
		};
		const s = cameraStateOf(c, 0, FPS, W);
		const d = defaultCamera(W, H);
		for (let i = 0; i < 16; i++) expect(s.view[i]!).toBeCloseTo(d.view[i]!, 9);
		expect(s.zoom).toBeCloseTo(d.zoom, 9);
	});

	it('the topmost camera that is on is active', () => {
		const cam = newCameraData({ width: W, height: H });
		const a: RenderCameraClip = { clipId: 'a', name: 'a', trackIndex: 1, ...rig, camera: cam };
		const b: RenderCameraClip = {
			clipId: 'b',
			name: 'b',
			trackIndex: 3,
			...rig,
			start: 100,
			duration: 50,
			camera: cam,
		};
		const scene = { renderer: 'classic' as const, cameras: [a, b], lights: [] };
		expect(activeCameraClipAt(scene, 50)?.clipId).toBe('a');
		expect(activeCameraClipAt(scene, 120)?.clipId).toBe('b');
		expect(activeCameraClipAt(scene, 150)?.clipId).toBe('a');
		expect(activeCameraClipAt(scene, 300)).toBeNull();
	});

	it('a one-node camera looks along its own +z (orientation turns it)', () => {
		const data = newCameraData({ width: W, height: H }, { type: 'one-node' });
		data.transform.orientation = anim<Vec3>([0, 90, 0]);
		const s = cameraStateOf({ clipId: 'c', name: 'c', trackIndex: 0, ...rig, camera: data }, 0, FPS, W);
		// Forward (third row of the view) = +x after a 90° Y turn.
		expect(s.view[8]!).toBeCloseTo(1, 9);
		expect(s.view[10]!).toBeCloseTo(0, 9);
	});

	it('lens relations: 50 mm = 2666.67 px at 1920; angle of view round trip', () => {
		const frame = { width: W, height: H };
		expect(zoomForFocalLength(50, frame)).toBeCloseTo(2666.6667, 3);
		expect(focalLengthForZoom(2666.6667, frame)).toBeCloseTo(50, 3);
		const aov = angleOfViewForZoom(2666.6667, frame);
		expect(aov).toBeCloseTo(39.5978, 3);
		expect(zoomForAngleOfView(aov, frame)).toBeCloseTo(2666.6667, 3);
		expect(zoomForFocalLength(50, frame, 24, 'vertical')).toBeCloseTo((H * 50) / 24, 6);
	});
});

describe('lights and materials', () => {
	const light = (type: 'spot' | 'point' | 'parallel', o = {}): RenderLightClip => ({
		clipId: 'l',
		name: 'l',
		trackIndex: 0,
		...rig,
		light: newLightData(type, { width: W, height: H }, o),
	});

	it('a spot light is full inside the inner cone, off outside the outer cone', () => {
		const l = lightStateOf(light('spot', { coneAngle: 90, coneFeather: 50 }), 0, FPS);
		expect(lightAttenuation(l, [W / 2, H / 2, 0])).toBeCloseTo(1, 9);
		// Far off-axis (behind the light's direction) = 0.
		const back: Vec3 = [l.pos[0] - l.dir[0] * 100, l.pos[1] - l.dir[1] * 100, l.pos[2] - l.dir[2] * 100];
		expect(lightAttenuation(l, back)).toBe(0);
	});

	it('inverse-square falloff is clamped inside Radius and falls as (r/d)²', () => {
		const l = lightStateOf(light('point', { falloff: 'inverse-square', radius: 100 }), 0, FPS);
		const at = (d: number): Vec3 => [l.pos[0] + d, l.pos[1], l.pos[2]];
		expect(lightAttenuation(l, at(50))).toBe(1);
		expect(lightAttenuation(l, at(200))).toBeCloseTo(0.25, 9);
	});

	it('smooth falloff: 1 inside Radius, smoothstep to 0 over Falloff Distance', () => {
		const l = lightStateOf(light('point', { falloff: 'smooth', radius: 100, falloffDistance: 100 }), 0, FPS);
		const at = (d: number): Vec3 => [l.pos[0] + d, l.pos[1], l.pos[2]];
		expect(lightAttenuation(l, at(100))).toBe(1);
		expect(lightAttenuation(l, at(150))).toBeCloseTo(0.5, 9);
		expect(lightAttenuation(l, at(250))).toBe(0);
	});
});

describe('3D runs', () => {
	it('consecutive 3D layers form a run; a 2D layer breaks it', () => {
		const runs = runs3d([
			{ key: 'a', trackIndex: 0, is3d: false },
			{ key: 'b', trackIndex: 1, is3d: true },
			{ key: 'c', trackIndex: 3, is3d: true },
			{ key: 'd', trackIndex: 4, is3d: false },
			{ key: 'e', trackIndex: 5, is3d: true },
		]);
		expect(runs).toEqual([
			{ members: ['b', 'c'], topTrack: 3, bottomTrack: 1 },
			{ members: ['e'], topTrack: 5, bottomTrack: 5 },
		]);
	});
});
