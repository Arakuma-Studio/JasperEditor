// Browser entry of the Advanced 3D GL test (bundled with esbuild, run in headless Chrome by ../three-d-advanced.test.ts):
// renders scenes with the Advanced 3D renderer and, for unlit scenes, the Classic 3D CPU reference of the same
// pictures; lit scenes report what the test checks (shadow masks with and without the caster's shadows, coverage of
// extruded vs flat text, colours at given pixels).
import '../gl-poison.ts';
import {
	anim,
	type CameraState,
	type ClassicSetup,
	type CpuPlane,
	compositeClassicCPU,
	defaultCamera,
	extrudeShapes,
	type FloatImage,
	type LightState,
	layerWorldMatrix,
	lightStateOf,
	lookAtCamera,
	type Mesh,
	mat4Mul,
	materialAt,
	newFloatImage,
	newLayer3D,
	newLightData,
	type PlaneSource,
	parseModel,
	prepareClassicPlane,
	shapesOfAlpha,
	type Transform,
	type Vec3,
} from '@jasper/project';
import { fxHost } from '../../src/fx/host.ts';
import {
	type AdvancedEnvironment,
	type AdvancedMember,
	renderAdvancedGL,
} from '../../src/three-d/advanced.ts';
import { type LoadedModel, modelToLayer } from '../../src/three-d/model-loader.ts';

const W = 96;
const H = 64;
const FPS = { num: 30, den: 1 };
const RIG = { start: 0, duration: 10, sourceIn: 0, speed: { rate: 1, reverse: false, maintainPitch: false } };

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
function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s >>> 24;
	};
}
/** Smooth noise (2×2 px blocks) so bilinear sampling differences stay small. */
const blocks = (seed: number) => {
	const r = rng(seed);
	const cells = new Map<string, [number, number, number, number]>();
	return (x: number, y: number) => {
		const k = `${x >> 2},${y >> 2}`;
		if (!cells.has(k)) cells.set(k, [r(), r(), r(), 255]);
		return cells.get(k)!;
	};
};
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

type Layer = {
	pic: Pic;
	transform?: Transform;
	td?: ReturnType<typeof newLayer3D>;
	mesh?: Mesh | null;
	opacity?: number;
	model?: LoadedModel;
};
type Scene = {
	layers: Layer[];
	camera?: CameraState;
	lights?: LightState[];
	backdrop?: Pic;
	env?: AdvancedEnvironment;
};

const td = (f: (t: ReturnType<typeof newLayer3D>) => void) => {
	const t = newLayer3D();
	f(t);
	return t;
};

/** A white ring (outline with a hole) on transparency. */
const ring = () =>
	picture(40, 30, (x, y) => {
		const d = Math.hypot(x + 0.5 - 20, y + 0.5 - 15);
		const a = Math.max(0, Math.min(1, 12 - d + 0.5)) * Math.max(0, Math.min(1, d - 6 + 0.5));
		return [240, 240, 240, Math.round(a * 255)];
	});

function extruded(p: Pic, depth: number, bevel: 'none' | 'angular' | 'convex' = 'none'): Mesh {
	const ctx = p.canvas.getContext('2d')!;
	const d = ctx.getImageData(0, 0, p.canvas.width, p.canvas.height).data;
	const shapes = shapesOfAlpha(
		p.canvas.width,
		p.canvas.height,
		(x, y) => d[(y * p.canvas.width + x) * 4 + 3]!,
	);
	return extrudeShapes(shapes, { depth, bevelStyle: bevel, bevelDepth: 2, holeBevel: 100 });
}

function scenes(): Record<string, () => Scene> {
	const pic = (seed: number) => picture(40, 30, blocks(seed));
	const spot = (cast: boolean) =>
		light(
			'spot',
			{ coneAngle: 90, castsShadows: cast, shadowDarkness: 100, shadowDiffusion: 0 },
			[W / 2 - 10, H / 2 - 30, -120],
			[W / 2, H / 2, 0],
		);
	const shadowScene = (cast: boolean): Scene => ({
		layers: [
			{
				pic: picture(40, 30, () => [200, 200, 200, 255]),
				transform: tr({ scale: anim(220) }),
				td: td((t) => {
					t.material.acceptsShadows = 'on';
					t.material.specularIntensity = anim(0);
				}),
			},
			{
				pic: picture(12, 10, () => [255, 60, 0, 255]),
				transform: tr({ anchor: anim([6, 5]) }),
				td: td((t) => {
					t.positionZ = anim(-40);
					t.material.castsShadows = 'on';
					t.material.specularIntensity = anim(0);
				}),
			},
		],
		lights: [spot(cast), light('ambient', { intensity: 20 })],
		backdrop: picture(W, H, () => [0, 0, 0, 255]),
	});
	return {
		flat: () => ({ layers: [{ pic: pic(1) }], backdrop: picture(W, H, blocks(9)) }),
		stack: () => ({
			layers: [
				{ pic: pic(1), td: td((t) => (t.rotationY = anim(35))) },
				{ pic: pic(2), td: td((t) => (t.rotationX = anim(-25))) },
				{ pic: pic(3), td: td((t) => (t.positionZ = anim(30))), opacity: 0.6 },
			],
			backdrop: picture(W, H, blocks(9)),
		}),
		orbit: () => ({
			layers: [
				{ pic: pic(4), td: td((t) => (t.orientation = anim<Vec3>([10, 20, 5]))) },
				{
					pic: pic(5),
					transform: tr({ position: anim([30, 20]) }),
					td: td((t) => (t.positionZ = anim(-20))),
				},
			],
			camera: lookAtCamera([W / 2 + 60, H / 2 - 40, -110], [W / 2, H / 2, 0], 130),
		}),
		ortho: () => ({
			layers: [{ pic: pic(6), td: td((t) => (t.rotationY = anim(40))) }],
			camera: lookAtCamera([W / 2, H / 2, -1000], [W / 2, H / 2, 0], 0.8, true),
		}),
		shadowOn: () => shadowScene(true),
		shadowOff: () => shadowScene(false),
		ringFlat: () => ({
			layers: [{ pic: ring(), td: td((t) => (t.rotationY = anim(50))) }],
			lights: [
				light('parallel', { intensity: 90 }, [W / 2 - 60, H / 2 - 40, -80], [W / 2, H / 2, 0]),
				light('ambient', { intensity: 20 }),
			],
		}),
		ringExtruded: () => {
			const p = ring();
			return {
				layers: [{ pic: p, td: td((t) => (t.rotationY = anim(50))), mesh: extruded(p, 25, 'convex') }],
				lights: [
					light('parallel', { intensity: 90 }, [W / 2 - 60, H / 2 - 40, -80], [W / 2, H / 2, 0]),
					light('ambient', { intensity: 20 }),
				],
			};
		},
		env: () => {
			// Equirect: green at the left / right edges (behind), red in the middle (in front).
			const e = picture(64, 32, (x) => (Math.abs(x + 0.5 - 32) < 16 ? [255, 0, 0, 255] : [0, 255, 0, 255]));
			return {
				layers: [
					{
						pic: picture(40, 30, () => [128, 128, 128, 255]),
						transform: tr({ position: anim([W / 2, H / 2]), anchor: anim([20, 15]), scale: anim(60) }),
						td: td((t) => {
							t.material.reflectionIntensity = anim(100);
							t.material.reflectionSharpness = anim(100);
							t.material.diffuse = anim(0);
							t.material.ambient = anim(0);
							t.material.specularIntensity = anim(0);
							t.material.metal = anim(0);
						}),
					},
				],
				env: { image: e.canvas, rotation: 0, color: [1, 1, 1], background: true },
			};
		},
		dof: () => {
			const cam: CameraState = { ...defaultCamera(W, H) };
			cam.dof = {
				focus: cam.zoom,
				aperture: 14,
				blurLevel: 1,
				iris: { sides: 6, rotation: 0, roundness: 0, aspect: 1, fringe: 0 },
				highlight: { gain: 0, threshold: 1, saturation: 0 },
			};
			const chk = (x: number, y: number) =>
				(((x >> 1) + (y >> 1)) & 1 ? [255, 255, 255, 255] : [0, 0, 0, 255]) as [
					number,
					number,
					number,
					number,
				];
			return {
				layers: [
					{ pic: picture(40, 30, chk), transform: tr({ position: anim([25, 32]) }) },
					{
						pic: picture(40, 30, chk),
						transform: tr({ position: anim([70, 32]), scale: anim(300) }),
						td: td((t) => (t.positionZ = anim(600))),
					},
				],
				camera: cam,
				backdrop: picture(W, H, () => [128, 128, 128, 255]),
			};
		},
		model: () => {
			// A red cube (OBJ), turned so three faces show, lit from the upper left.
			const v = [
				[-1, -1, -1],
				[1, -1, -1],
				[1, 1, -1],
				[-1, 1, -1],
				[-1, -1, 1],
				[1, -1, 1],
				[1, 1, 1],
				[-1, 1, 1],
			];
			const f = [
				[1, 2, 3, 4],
				[5, 8, 7, 6],
				[1, 5, 6, 2],
				[2, 6, 7, 3],
				[3, 7, 8, 4],
				[5, 1, 4, 8],
			];
			const obj = [...v.map((p) => `v ${p.join(' ')}`), ...f.map((q) => `f ${q.join(' ')}`)].join('\n');
			const model = parseModel(new TextEncoder().encode(obj), 'obj');
			model.primitives[0]!.material.baseColor = [0.9, 0.1, 0.1, 1];
			return {
				layers: [
					{
						pic: picture(1, 1, () => [0, 0, 0, 0]),
						transform: tr({ anchor: anim([W / 2, H / 2]) }),
						td: td((t) => {
							t.orientation = anim<Vec3>([30, 40, 0]);
							t.material.specularIntensity = anim(0);
						}),
						model: { model, textures: [null] },
					},
				],
				lights: [
					light('parallel', { intensity: 100 }, [W / 2 - 60, H / 2 - 80, -100], [W / 2, H / 2, 0]),
					light('ambient', { intensity: 20 }),
				],
			};
		},
		highlight: () => ({
			layers: [
				{
					pic: picture(40, 30, () => [60, 60, 200, 255]),
					transform: tr({ scale: anim(200) }),
					td: td((t) => {
						t.material.specularIntensity = anim(100);
						t.material.specularShininess = anim(90);
						t.material.diffuse = anim(20);
					}),
				},
			],
			lights: [light('point', { intensity: 100 }, [W / 2, H / 2, -60])],
		}),
	};
}

function members(s: Scene): AdvancedMember[] {
	return s.layers.map((l, i) => {
		const t = l.td ?? newLayer3D();
		const world = layerWorldMatrix({ transform: l.transform ?? tr(), threeD: t }, 0);
		if (l.model)
			return {
				key: `p${i}`,
				picture: l.pic.canvas,
				pictureWidth: 1,
				pictureHeight: 1,
				layerToPicture: [1, 0, 0, 0, 1, 0, 0, 0, 1],
				world: mat4Mul(world, modelToLayer(l.model.model.bounds, { width: W, height: H })),
				mesh: null,
				model: l.model,
				material: materialAt(t.material, 0),
				opacity: 1,
				draw: true,
			};
		return {
			key: `p${i}`,
			picture: l.pic.canvas,
			pictureWidth: l.pic.canvas.width,
			pictureHeight: l.pic.canvas.height,
			layerToPicture: [1, 0, 0, 0, 1, 0, 0, 0, 1],
			world: layerWorldMatrix({ transform: l.transform ?? tr(), threeD: t }, 0),
			mesh: l.mesh ?? null,
			material: materialAt(t.material, 0),
			opacity: l.opacity ?? 1,
			draw: t.material.castsShadows !== 'only',
		};
	});
}

function setupOf(s: Scene): ClassicSetup {
	return {
		width: W,
		height: H,
		scale: 1,
		frame: { width: W, height: H },
		camera: s.camera ?? defaultCamera(W, H),
		lights: s.lights ?? [],
	};
}

function advanced(name: string): number[] {
	const h = fxHost();
	if (!h) throw new Error('no WebGL2');
	const s = scenes()[name]!();
	const out = document.createElement('canvas');
	out.width = W;
	out.height = H;
	renderAdvancedGL(
		h,
		{
			setup: setupOf(s),
			members: members(s),
			backdrop: s.backdrop?.canvas ?? null,
			environment: s.env ?? null,
			shadowMapSize: 512,
		},
		out.getContext('2d')!,
	);
	return Array.from(out.getContext('2d')!.getImageData(0, 0, W, H).data);
}

/** Classic 3D CPU reference (unlit scenes: the same projection and sampling). */
function classic(name: string): number[] {
	const s = scenes()[name]!();
	const setup = setupOf(s);
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
			mode: 'normal',
			seed: 1,
			order: i,
			draw: t.material.castsShadows !== 'only',
		};
		const p = prepareClassicPlane(setup, src);
		if (p) cpu.push({ ...p, pixels: l.pic.float });
	});
	const canvas = s.backdrop
		? { ...s.backdrop.float, data: s.backdrop.float.data.slice() }
		: newFloatImage(W, H);
	compositeClassicCPU(canvas, setup, cpu);
	const px: number[] = [];
	for (let i = 0; i < W * H; i++) {
		const a = Math.min(1, Math.max(0, canvas.data[i * 4 + 3]!));
		for (let c = 0; c < 3; c++) {
			const v = Math.min(a, Math.max(0, canvas.data[i * 4 + c]!));
			px.push(a > 0 ? Math.round((v / a) * 255) : 0);
		}
		px.push(Math.round(a * 255));
	}
	return px;
}

/** PNG data URL of an image (×4, debugging). */
function png(img: number[]): string {
	const c = document.createElement('canvas');
	c.width = W;
	c.height = H;
	const ctx = c.getContext('2d')!;
	const d = ctx.createImageData(W, H);
	d.data.set(img);
	ctx.putImageData(d, 0, 0);
	const big = document.createElement('canvas');
	big.width = W * 4;
	big.height = H * 4;
	const b = big.getContext('2d')!;
	b.imageSmoothingEnabled = false;
	b.fillStyle = '#808080';
	b.fillRect(0, 0, W * 4, H * 4);
	b.drawImage(c, 0, 0, W * 4, H * 4);
	return big.toDataURL('image/png');
}

(window as unknown as { __adv: unknown }).__adv = {
	png: (name: string) => png(advanced(name)),
	advanced,
	classic,
	size: () => ({ W, H }),
	info: () => ({ webgl2: !!document.createElement('canvas').getContext('webgl2') }),
};
