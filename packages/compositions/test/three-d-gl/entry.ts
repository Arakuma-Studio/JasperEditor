import {
	anim,
	type CameraState,
	type ClassicSetup,
	type CpuPlane,
	compositeClassicCPU,
	defaultCamera,
	dofPicture,
	type FloatImage,
	type LightState,
	layerWorldMatrix,
	lightStateOf,
	lookAtCamera,
	materialAt,
	newFloatImage,
	newLayer3D,
	newLightData,
	type PlaneSource,
	prepareClassicPlane,
	type Transform,
	type Vec3,
} from '@jasper/project';
import { fxHost } from '../../src/fx/host.ts';
import { type GlPlane, renderClassicGL } from '../../src/three-d/gl.ts';

const W = 96;
const H = 64;
const FPS = { num: 30, den: 1 };
const RIG = { start: 0, duration: 10, sourceIn: 0, speed: { rate: 1, reverse: false, maintainPitch: false } };

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s >>> 24;
	};
}
type Pic = { canvas: HTMLCanvasElement; float: FloatImage };
function picture(
	w: number,
	h: number,
	fill: (x: number, y: number) => [number, number, number, number],
): Pic {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	const ctx = c.getContext('2d')!;
	const d = ctx.createImageData(w, h);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.data.set(fill(x, y), (y * w + x) * 4);
	ctx.putImageData(d, 0, 0);
	const back = ctx.getImageData(0, 0, w, h).data;
	const f = newFloatImage(w, h);
	for (let i = 0; i < w * h; i++) {
		const a = back[i * 4 + 3]! / 255;
		f.data.set(
			[(back[i * 4]! / 255) * a, (back[i * 4 + 1]! / 255) * a, (back[i * 4 + 2]! / 255) * a, a],
			i * 4,
		);
	}
	return { canvas: c, float: f };
}
const noise = (seed: number, aMin = 255) => {
	const r = rng(seed);
	return () =>
		[r(), r(), r(), aMin >= 255 ? 255 : aMin + Math.round((r() / 255) * (255 - aMin))] as [
			number,
			number,
			number,
			number,
		];
};
const checker =
	(a: [number, number, number, number], b: [number, number, number, number], k = 4) =>
	(x: number, y: number) =>
		(Math.floor(x / k) + Math.floor(y / k)) & 1 ? a : b;

const tr = (o: Partial<Record<keyof Transform, unknown>> = {}): Transform =>
	({
		position: anim([W / 2, H / 2]),
		anchor: anim([20, 15]),
		scale: anim(100),
		scaleWidth: anim(100),
		uniformScale: true,
		rotation: anim(0),
		flipH: false,
		flipV: false,
		...o,
	}) as Transform;

type Layer = {
	pic: Pic;
	transform?: Transform;
	td?: ReturnType<typeof newLayer3D>;
	mode?: string;
	opacity?: number;
	seed?: number;
};
type Scene = { layers: Layer[]; camera?: CameraState; lights?: LightState[]; backdrop?: Pic };

function light(
	type: 'parallel' | 'spot' | 'point' | 'ambient',
	o: Record<string, unknown> = {},
	pos?: Vec3,
	poi?: Vec3,
) {
	const data = newLightData(type, { width: W, height: H }, o);
	if (pos) data.transform.position = anim(pos);
	if (poi) data.transform.pointOfInterest = anim(poi);
	return lightStateOf(
		{ clipId: `${type}${Math.random()}`, name: type, trackIndex: 0, ...RIG, light: data },
		0,
		FPS,
	);
}

function scenes(): Record<string, () => Scene> {
	const td = (f: (t: ReturnType<typeof newLayer3D>) => void) => {
		const t = newLayer3D();
		f(t);
		return t;
	};
	const pic40 = (seed: number, aMin = 255) => picture(40, 30, noise(seed, aMin));
	return {
		flat: () => ({ layers: [{ pic: pic40(1) }], backdrop: picture(W, H, noise(9)) }),
		intersect: () => ({
			layers: [
				{ pic: pic40(1), td: td((t) => (t.rotationY = anim(35))) },
				{ pic: pic40(2, 120), td: td((t) => (t.rotationX = anim(-25))), mode: 'multiply' },
				{ pic: pic40(3), td: td((t) => (t.positionZ = anim(30))), mode: 'screen', opacity: 0.7 },
			],
			backdrop: picture(W, H, noise(9)),
		}),
		orbit: () => ({
			layers: [
				{
					pic: picture(40, 30, checker([255, 0, 0, 255], [0, 0, 255, 255])),
					td: td((t) => (t.orientation = anim<Vec3>([10, 20, 5]))),
				},
				{
					pic: pic40(4),
					transform: tr({ position: anim([30, 20]) }),
					td: td((t) => (t.positionZ = anim(-20))),
				},
			],
			camera: lookAtCamera([W / 2 + 60, H / 2 - 40, -110], [W / 2, H / 2, 0], 130),
		}),
		ortho: () => ({
			layers: [{ pic: pic40(5), td: td((t) => (t.rotationY = anim(40))) }],
			camera: lookAtCamera([W / 2, H / 2, -1000], [W / 2, H / 2, 0], 0.8, true),
		}),
		lights: () => {
			const recv = td((t) => {
				t.material.acceptsShadows = 'on';
				t.material.specularShininess = anim(40);
				t.rotationX = anim(-30);
			});
			const caster = td((t) => {
				t.positionZ = anim(-30);
				t.material.castsShadows = 'on';
				t.material.lightTransmission = anim(60);
			});
			return {
				layers: [
					{ pic: picture(40, 30, () => [200, 200, 200, 255]), transform: tr({ scale: anim(200) }), td: recv },
					{
						pic: picture(12, 10, checker([255, 60, 0, 255], [0, 0, 0, 0], 3)),
						transform: tr({ anchor: anim([6, 5]) }),
						td: caster,
					},
				],
				lights: [
					light(
						'spot',
						{
							coneAngle: 70,
							coneFeather: 40,
							castsShadows: true,
							shadowDiffusion: 3,
							falloff: 'smooth',
							radius: 60,
							falloffDistance: 80,
						},
						[20, 10, -90],
						[W / 2, H / 2, 0],
					),
					light(
						'point',
						{ color: [0.3, 0.6, 1, 1], intensity: 80, falloff: 'inverse-square', radius: 40 },
						[80, 50, -40],
					),
					light(
						'parallel',
						{ intensity: 40, castsShadows: true, shadowDarkness: 60 },
						[W / 2, 0, -80],
						[W / 2, H / 2, 0],
					),
					light('ambient', { intensity: 15 }),
				],
				backdrop: picture(W, H, () => [10, 20, 30, 255]),
			};
		},
		dissolve: () => ({
			layers: [{ pic: pic40(6), mode: 'dissolve', opacity: 0.5, seed: 123456789 }],
			backdrop: picture(W, H, noise(8)),
		}),
		dof: () => {
			const cam: CameraState = { ...defaultCamera(W, H) };
			cam.dof = {
				focus: cam.zoom,
				aperture: 12,
				blurLevel: 1,
				iris: { sides: 6, rotation: 15, roundness: 0.2, aspect: 1.3, fringe: 0.5 },
				highlight: { gain: 0.3, threshold: 0.7, saturation: 0.4 },
			};
			return {
				layers: [
					{
						pic: picture(40, 30, checker([255, 255, 255, 255], [20, 40, 200, 255], 5)),
						td: td((t) => (t.rotationY = anim(50))),
					},
					{
						pic: pic40(7),
						transform: tr({ position: anim([30, 22]) }),
						td: td((t) => (t.positionZ = anim(60))),
					},
				],
				camera: cam,
			};
		},
	};
}

function render(name: string): { gl: number[]; cpu: number[]; W: number; H: number } {
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const s = scenes()[name]!();
	const setup: ClassicSetup = {
		width: W,
		height: H,
		scale: 1,
		frame: { width: W, height: H },
		camera: s.camera ?? defaultCamera(W, H),
		lights: s.lights ?? [],
	};
	const gl: GlPlane[] = [];
	const cpu: CpuPlane[] = [];
	s.layers.forEach((l, i) => {
		const t = l.td ?? newLayer3D();
		const src: PlaneSource = {
			key: `p${i}`,
			width: l.pic.canvas.width,
			height: l.pic.canvas.height,
			layerToPicture: [1, 0, 0, 0, 1, 0, 0, 0, 1],
			world: layerWorldMatrix({ transform: l.transform ?? tr(), threeD: t }, 0),
			material: materialAt(t.material, 0),
			opacity: l.opacity ?? 1,
			mode: l.mode ?? 'normal',
			seed: l.seed ?? 1,
			order: i,
			draw: t.material.castsShadows !== 'only',
		};
		const p = prepareClassicPlane(setup, src);
		if (!p) return;
		gl.push({ ...p, picture: l.pic.canvas, pictureWidth: src.width, pictureHeight: src.height });
		cpu.push({
			...p,
			pixels: p.dof && setup.camera.dof ? dofPicture(p, l.pic.float, setup.camera.dof) : l.pic.float,
		});
	});
	const out = document.createElement('canvas');
	out.width = W;
	out.height = H;
	renderClassicGL(h, { setup, planes: gl, backdrop: s.backdrop?.canvas ?? null }, out.getContext('2d')!);
	const canvas = s.backdrop
		? { ...s.backdrop.float, data: s.backdrop.float.data.slice() }
		: newFloatImage(W, H);
	compositeClassicCPU(canvas, setup, cpu);
	const glPx = Array.from(out.getContext('2d')!.getImageData(0, 0, W, H).data);
	// CPU → straight bytes like getImageData (clamped premultiplied).
	const cpuPx: number[] = [];
	for (let i = 0; i < W * H; i++) {
		const a = Math.min(1, Math.max(0, canvas.data[i * 4 + 3]!));
		for (let c = 0; c < 3; c++) {
			const v = Math.min(a, Math.max(0, canvas.data[i * 4 + c]!));
			cpuPx.push(a > 0 ? Math.round((v / a) * 255) : 0);
		}
		cpuPx.push(Math.round(a * 255));
	}
	return { gl: glPx, cpu: cpuPx, W, H };
}

(window as unknown as { __3d: unknown }).__3d = { render };
