// Simulation ▸ Particle World, Particle Systems II, Mercury (sim-warp workstream; After Effects' CC Particle World,
// CC Particle Systems II and CC Mr. Mercury under neutral names). Stepped simulations (engine.ts) rendered by one
// instanced draw pass (particle-render.ts). Particle World is 3D seen through its own Effect Camera (distance,
// rotation, field of view) with depth cues, a floor and guides; Particle Systems II is the 2D system; Mercury turns
// its particles into shaded liquid-metal metaballs.
// Ported from EffectCraft crates/effects/src/sim.rs (pw_phys, particle_world_plan, ps2_phys, mercury_blobs,
// mr_mercury; MIT OR Apache-2.0) and extended; see licenses/ported/sim-warp.md.
import type { EffectParams, EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { GLSL_DATA } from '../glsl/data.ts';
import { fxParam } from '../params.ts';
import type { FxFrameContext } from '../shader.ts';
import { combinePass, n, popup, randomSeedParam, values } from './common.ts';
import {
	bool,
	choice,
	clamp,
	num,
	paramsAtStep,
	rgba,
	SIM_SPS,
	SimCache,
	simKey,
	stepsOf,
	vec2,
} from './core.ts';
import {
	clonePState,
	FLOOR_ACTIONS,
	lifeOf,
	newPState,
	P_STRIDE,
	type PState,
	PF,
	type Phys,
	PW_ANIMATIONS,
	stepParticles,
} from './engine.ts';
import {
	GLSL_PARTICLES,
	PARTICLE_FRAG,
	PARTICLE_TYPES,
	PARTICLE_VERT,
	REC,
	TYPE_KIND,
	TYPE_SHAPE,
	typeVertices,
	writeRecord,
} from './particle-render.ts';

const SIM = 'Simulation';
const ANIM_VALUES = values(PW_ANIMATIONS);
const TYPE_VALUES = values(PARTICLE_TYPES);
const TRANSFER = ['Composite', 'Screen', 'Add', 'Black Matte'] as const;
const OPACITY_MAPS = ['Fade In and Out', 'Constant', 'Fade In', 'Fade Out', 'Fade Out Fast'] as const;
const COLOR_MAPS = ['Birth to Death', 'Origin to Death', 'Custom'] as const;
const DEPTH_CUES = ['None', 'Fade', 'Fog'] as const;
const MAX_PARTICLES = 40000;
const rad = (d: number) => (d * Math.PI) / 180;

/** sp_combine mode of a Transfer Mode (Black Matte = the particles over black). */
const transferPost = (v: unknown) => [0, 1, 2, 6][choice(v, values(TRANSFER))]!;

/** Opacity 0..1 at life fraction u. */
export function opacityAt(map: number, u: number): number {
	switch (map) {
		case 1:
			return 1;
		case 2:
			return Math.min(u * 5, 1);
		case 3:
			return 1 - u;
		case 4:
			return Math.min(1, (1 - u) * 3) * Math.min(u * 20, 1);
		default:
			return Math.min(u * 20, 1) * Math.min((1 - u) * 5, 1);
	}
}

const lerp3 = (a: readonly number[], b: readonly number[], t: number) => [
	a[0]! + (b[0]! - a[0]!) * t,
	a[1]! + (b[1]! - a[1]!) * t,
	a[2]! + (b[2]! - a[2]!) * t,
];

/** Straight colour of a particle at life u (Color Map). */
function colorAt(p: EffectParams, map: number, u: number, originT: number): number[] {
	const birth = rgba(p.birthColor, [1, 1, 0, 1]);
	const death = rgba(p.deathColor, [0.6, 0, 0, 1]);
	if (map === 2) {
		const stops = [1, 2, 3, 4, 5].map((k) => rgba(p[`customColor${k}`], [1, 1, 1, 1]));
		const x = clamp(u, 0, 1) * 4;
		const i = Math.min(3, Math.floor(x));
		return lerp3(stops[i]!, stops[i + 1]!, x - i);
	}
	if (map === 1) {
		// Origin to Death: the birth colour shifts toward the death colour with the distance from the producer centre.
		const b = lerp3(birth, death, clamp(originT, 0, 1) * 0.5);
		return lerp3(b, death, u);
	}
	return lerp3(birth, death, u);
}

// ---------------------------------------------------------------- shared particle params

function particleParams(d: { birthSize: number; deathSize: number; sizeMax: number }) {
	const g = 'Particle';
	return [
		popup('particleType', 'Particle Type', PARTICLE_TYPES, 0, g),
		fxParam.media('texture', 'Texture Layer', ['image', 'video'], { group: g }),
		fxParam.percent('textureScatter', 'Texture Scatter', 0, { group: g }),
		n('rotationSpeed', 'Rotation Speed', 120, -3600, 3600, -720, 720, 0.1, { group: g, unit: 'deg' }),
		fxParam.angle('initialRotation', 'Initial Rotation', 0, { group: g }),
		n('birthSize', 'Birth Size', d.birthSize, 0, d.sizeMax, 0, d.sizeMax / 10, 0.001, { group: g }),
		n('deathSize', 'Death Size', d.deathSize, 0, d.sizeMax, 0, d.sizeMax / 10, 0.001, { group: g }),
		fxParam.percent('sizeVariation', 'Size Variation', 0, { group: g }),
		fxParam.percent('maxOpacity', 'Max Opacity', 75, { group: g }),
		popup('opacityMap', 'Opacity Map', OPACITY_MAPS, 0, g),
		popup('colorMap', 'Color Map', COLOR_MAPS, 0, g),
		fxParam.color('birthColor', 'Birth Color', [1, 1, 0, 1], { group: g }),
		fxParam.color('deathColor', 'Death Color', [0.6, 0, 0, 1], { group: g }),
		fxParam.color('customColor1', 'Custom Color 1', [1, 1, 1, 1], { group: g }),
		fxParam.color('customColor2', 'Custom Color 2', [1, 1, 0, 1], { group: g }),
		fxParam.color('customColor3', 'Custom Color 3', [1, 0.5, 0, 1], { group: g }),
		fxParam.color('customColor4', 'Custom Color 4', [0.8, 0, 0, 1], { group: g }),
		fxParam.color('customColor5', 'Custom Color 5', [0.2, 0, 0, 1], { group: g }),
		fxParam.percent('volumeShade', 'Volume Shade', 0, { group: g }),
		popup('transferMode', 'Transfer Mode', TRANSFER, 0, g),
	];
}

/** The draw pass + transfer composite of a particle effect (instances = `u_count`, vertices = `u_verts`). */
const particlePasses = [
	{
		output: 'sprites',
		include: [GLSL_PARTICLES],
		draw: {
			vertices: { uniform: 'u_verts' },
			instances: { uniform: 'u_count' },
			vert: PARTICLE_VERT,
		},
		frag: PARTICLE_FRAG,
	},
	combinePass(),
];

/** Record data of particles + guides (sorted far to near by `depth`, descending). */
type Item = { depth: number; write: (out: Float32Array, i: number) => void };

function pack(items: Item[]): { texels: Float32Array; count: number } {
	items.sort((a, b) => b.depth - a.depth);
	const texels = new Float32Array(Math.max(1, items.length) * REC * 4);
	items.forEach((it, i) => {
		it.write(texels, i);
	});
	return { texels, count: items.length };
}

// ---------------------------------------------------------------- Particle World

/** Particle World's physics at a step (params `q` of that step, `prev` of the step before: producer motion). */
function pwPhys(q: EffectParams, prev: EffectParams, seed: number): Phys {
	const prod = (r: EffectParams): [number, number, number] => [num(r.producerX), num(r.producerY), num(r.producerZ)];
	const p0 = prod(prev);
	const p1 = prod(q);
	const inh = num(q.inheritVelocity) / 100;
	const g = num(q.gravity, 0.5);
	return {
		rate: Math.max(0, num(q.birthRate, 0.5)) * 120,
		life: Math.max(0, num(q.longevity, 1)),
		producer: p1,
		radius: [Math.max(0, num(q.radiusX, 0.025)), Math.max(0, num(q.radiusY, 0.025)), Math.max(0, num(q.radiusZ, 0.025))],
		inherit: [(p1[0] - p0[0]) * SIM_SPS * inh, (p1[1] - p0[1]) * SIM_SPS * inh, (p1[2] - p0[2]) * SIM_SPS * inh],
		anim: choice(q.animation, ANIM_VALUES),
		speed: num(q.velocity, 1) * 0.5,
		gravity: [num(q.gravityX) * g, num(q.gravityY, 1) * g, num(q.gravityZ) * g],
		resistance: Math.max(0, num(q.resistance)),
		axis: [num(q.axisX), num(q.axisY, -1), num(q.axisZ)],
		extra: num(q.extra, 1),
		cone: Math.min(20, Math.abs(Math.tan(rad(num(q.extraAngle, 360)) * 0.5))),
		floor: choice(q.floorAction, values(FLOOR_ACTIONS)),
		floorY: num(q.floorPosition, 0.5),
		seed,
		max: MAX_PARTICLES,
		flat: false,
	};
}

const PW_CACHE = new SimCache<PState>(6);
const PS_CACHE = new SimCache<PState>(6);
const MERCURY_CACHE = new SimCache<PState>(6);

/** Runs a stepped particle system to the context's frame. */
function simulate(
	cache: SimCache<PState>,
	salt: string,
	p: EffectParams,
	ctx: FxFrameContext,
	phys: (q: EffectParams, prev: EffectParams) => Phys,
): PState {
	return cache.run(
		simKey(p, ctx, salt),
		stepsOf(ctx),
		newPState,
		(st, i) => stepParticles(st, phys(paramsAtStep(p, ctx, i), paramsAtStep(p, ctx, Math.max(0, i - 1))), i),
		clonePState,
	);
}

/** The Effect Camera: world (layer widths, origin at the layer centre, y down, z away) → layer px + depth. */
export function pwCamera(p: EffectParams, lw: number, lh: number) {
	const dist = Math.max(0.05, num(p.cameraDistance, 2));
	const fov = clamp(num(p.cameraFov, 50), 1, 170);
	const f = (dist * Math.tan(rad(25))) / Math.tan(rad(fov) / 2);
	const [ax, ay, az] = [rad(num(p.cameraRotationX)), rad(num(p.cameraRotationY)), rad(num(p.cameraRotationZ))];
	const [sx, cx, sy, cy, sz, cz] = [Math.sin(ax), Math.cos(ax), Math.sin(ay), Math.cos(ay), Math.sin(az), Math.cos(az)];
	return {
		dist,
		/** [x, y (layer px), zc (depth from the camera), k (scale)] or null behind the camera. */
		project(x: number, y: number, z: number): [number, number, number, number] | null {
			// X then Y then Z rotation of the world about its origin.
			let y1 = y * cx - z * sx;
			let z1 = y * sx + z * cx;
			const x2 = x * cy + z1 * sy;
			z1 = -x * sy + z1 * cy;
			const x3 = x2 * cz - y1 * sz;
			y1 = x2 * sz + y1 * cz;
			const zc = z1 + dist;
			if (zc <= 0.05) return null;
			const k = f / zc;
			return [lw * 0.5 + x3 * lw * k, lh * 0.5 + y1 * lw * k, zc, k];
		},
	};
}

/** Guide lines (Grid & Guides) as line records. */
function guideItems(p: EffectParams, cam: ReturnType<typeof pwCamera>, toCanvas: (x: number, y: number) => [number, number], s: number): Item[] {
	const out: Item[] = [];
	const line = (a: [number, number, number], b: [number, number, number], c: number[], steps = 1) => {
		for (let k = 0; k < steps; k++) {
			const t0 = k / steps;
			const t1 = (k + 1) / steps;
			const pa = cam.project(a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0, a[2] + (b[2] - a[2]) * t0);
			const pb = cam.project(a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1, a[2] + (b[2] - a[2]) * t1);
			if (!pa || !pb) continue;
			const [x0, y0] = toCanvas(pa[0], pa[1]);
			const [x1, y1] = toCanvas(pb[0], pb[1]);
			out.push({
				depth: 1e9, // guides first (behind the particles)
				write: (o, i) => writeRecord(o, i, x0, y0, 0.5 * s, 0, c, 8, [x1 - x0, y1 - y0], 0, 0, 0, [0, 0]),
			});
		}
	};
	if (bool(p.showGrid)) {
		const subdiv = Math.max(1, Math.min(100, Math.round(num(p.gridSubdivisions, 10))));
		const size = Math.max(0.001, num(p.gridSize, 0.5));
		const half = (subdiv * size) / 2;
		const c0 = choice(p.gridPosition, ['floor', 'worldCenter']) === 0 ? num(p.floorPosition, 0.5) : 0;
		const axis = choice(p.gridAxis, ['xzAxis', 'xyAxis', 'yzAxis']);
		const pt = (u: number, w: number): [number, number, number] =>
			axis === 0 ? [u, c0, w] : axis === 1 ? [u, w, c0] : [c0, u, w];
		const grey = [0.55, 0.55, 0.55, 0.8];
		for (let k = 0; k <= subdiv; k++) {
			const u = -half + k * size;
			line(pt(u, -half), pt(u, half), grey, 8);
			line(pt(-half, u), pt(half, u), grey, 8);
		}
	}
	if (bool(p.showHorizon)) {
		const fy = num(p.floorPosition, 0.5);
		line([-400, fy, 200], [400, fy, 200], [0.5, 0.8, 1, 1], 16);
	}
	if (bool(p.showAxisBox)) {
		line([0, 0, 0], [0.25, 0, 0], [1, 0.2, 0.2, 1], 4);
		line([0, 0, 0], [0, -0.25, 0], [0.2, 1, 0.2, 1], 4);
		line([0, 0, 0], [0, 0, 0.25], [0.3, 0.5, 1, 1], 4);
	}
	const px = num(p.producerX);
	const py = num(p.producerY);
	const pz = num(p.producerZ);
	if (bool(p.showPosition)) {
		const e = 0.03;
		line([px - e, py, pz], [px + e, py, pz], [1, 1, 1, 1]);
		line([px, py - e, pz], [px, py + e, pz], [1, 1, 1, 1]);
	}
	if (bool(p.showRadius)) {
		const rx = num(p.radiusX, 0.025);
		const ry = num(p.radiusY, 0.025);
		for (let k = 0; k < 32; k++) {
			const a0 = (k / 32) * Math.PI * 2;
			const a1 = ((k + 1) / 32) * Math.PI * 2;
			line([px + Math.cos(a0) * rx, py + Math.sin(a0) * ry, pz], [px + Math.cos(a1) * rx, py + Math.sin(a1) * ry, pz], [1, 1, 0.4, 1]);
		}
	}
	return out;
}

/** Records of the live particles of a state (shared by Particle World and Particle Systems II). */
function particleItems(
	st: PState,
	p: EffectParams,
	place: (x: number, y: number, z: number) => { x: number; y: number; depth: number; k: number } | null,
	velScale: number,
	sizeUnit: number,
	cue: (depth: number, c: number[]) => number[],
): Item[] {
	const type = choice(p.particleType, TYPE_VALUES);
	const kind = TYPE_KIND[type]!;
	const shape = TYPE_SHAPE[type]!;
	const bs = num(p.birthSize, 0.2);
	const ds = num(p.deathSize, 0.2);
	const svar = num(p.sizeVariation) / 100;
	const maxOp = num(p.maxOpacity, 75) / 100;
	const opMap = choice(p.opacityMap, values(OPACITY_MAPS));
	const colMap = choice(p.colorMap, values(COLOR_MAPS));
	const scatter = num(p.textureScatter) / 100;
	const rot0 = rad(num(p.initialRotation));
	const rotSpeed = rad(num(p.rotationSpeed, 120));
	const rmax = Math.max(1e-6, Math.hypot(num(p.radiusX, 0.025), num(p.radiusY, 0.025), num(p.radiusZ, 0.025)));
	const out: Item[] = [];
	const d = st.d;
	for (let r = 0; r < st.n; r++) {
		const o = r * P_STRIDE;
		const at = place(d[o + PF.x]!, d[o + PF.y]!, d[o + PF.z]!);
		if (!at) continue;
		const u = lifeOf(st, r);
		const rnd = d[o + PF.rnd]!;
		const size = Math.max(0, (bs + (ds - bs) * u) * (1 + svar * (rnd * 2 - 1)));
		const rr = size * sizeUnit * at.k;
		const originT = Math.hypot(d[o + PF.ox]!, d[o + PF.oy]!, d[o + PF.oz]!) / rmax;
		const rgb = colorAt(p, colMap, u, originT);
		const c = cue(at.depth, [rgb[0]!, rgb[1]!, rgb[2]!, maxOp * opacityAt(opMap, u)]);
		const ang = rot0 + rnd * Math.PI * 2 + rotSpeed * d[o + PF.age]!;
		// Screen velocity (canvas px / s) for Line and Motion Polygon.
		const nx = place(d[o + PF.x]! + d[o + PF.vx]! * 0.01, d[o + PF.y]! + d[o + PF.vy]! * 0.01, d[o + PF.z]! + d[o + PF.vz]! * 0.01);
		const svx = nx ? (nx.x - at.x) * 100 * velScale : 0;
		const svy = nx ? (nx.y - at.y) * 100 * velScale : 0;
		const vl = Math.max(1e-6, Math.hypot(svx, svy));
		let seg: [number, number] = [0, 0];
		let radius = rr;
		if (type === 0) {
			seg = [(-svx / vl) * rr * 2, (-svy / vl) * rr * 2];
			radius = Math.max(rr * 0.08, 0.5);
		} else if (type === 8) {
			seg = [-svx * 0.05, -svy * 0.05];
			radius = rr * 0.5;
		}
		const sc: [number, number] = [(rnd * 7.31) % 1 * scatter, ((rnd * 13.7) % 1) * scatter];
		out.push({
			depth: at.depth,
			write: (t, i) => writeRecord(t, i, at.x, at.y, radius, ang, c, shape, seg, rnd, kind, type, sc),
		});
	}
	return out;
}

export const PARTICLE_WORLD = defineShaderEffect({
	id: 'jasper.particle-world',
	label: 'Particle World',
	category: SIM,
	description:
		'A 3D particle system: a producer emits particles that explode, swirl, burn or flow under gravity and a floor, seen through its own camera.',
	keywords: ['particles', 'emitter', 'sparks', 'fireworks', 'fire', 'cc particle world', '3d'],
	params: [
		fxParam.toggle('showGrid', 'Grid', false, { group: 'Grid & Guides' }),
		popup('gridPosition', 'Grid Position', ['Floor', 'World Center'], 0, 'Grid & Guides'),
		popup('gridAxis', 'Grid Axis', ['XZ Axis', 'XY Axis', 'YZ Axis'], 0, 'Grid & Guides'),
		n('gridSubdivisions', 'Grid Subdivisions', 10, 1, 100, 1, 50, 1, { group: 'Grid & Guides' }),
		n('gridSize', 'Grid Size', 0.5, 0.001, 10, 0.01, 2, 0.001, { group: 'Grid & Guides' }),
		fxParam.toggle('showHorizon', 'Horizon', false, { group: 'Grid & Guides' }),
		fxParam.toggle('showAxisBox', 'Axis Box', false, { group: 'Grid & Guides' }),
		fxParam.toggle('showPosition', 'Position', false, { group: 'Grid & Guides' }),
		fxParam.toggle('showRadius', 'Radius', false, { group: 'Grid & Guides' }),
		n('birthRate', 'Birth Rate', 0.5, 0, 100, 0, 10),
		n('longevity', 'Longevity (sec)', 1, 0, 100, 0, 10, 0.01, { unit: 's' }),
		n('producerX', 'Position X', 0, -10, 10, -1, 1, 0.001, { group: 'Producer' }),
		n('producerY', 'Position Y', 0, -10, 10, -1, 1, 0.001, { group: 'Producer' }),
		n('producerZ', 'Position Z', 0, -10, 10, -1, 1, 0.001, { group: 'Producer' }),
		n('radiusX', 'Radius X', 0.025, 0, 10, 0, 1, 0.001, { group: 'Producer' }),
		n('radiusY', 'Radius Y', 0.025, 0, 10, 0, 1, 0.001, { group: 'Producer' }),
		n('radiusZ', 'Radius Z', 0.025, 0, 10, 0, 1, 0.001, { group: 'Producer' }),
		popup('animation', 'Animation', PW_ANIMATIONS, 0, 'Physics'),
		n('velocity', 'Velocity', 1, -10, 10, 0, 5, 0.01, { group: 'Physics' }),
		n('inheritVelocity', 'Inherit Velocity %', 0, -100, 100, -100, 100, 0.1, { group: 'Physics' }),
		n('gravity', 'Gravity', 0.5, -10, 10, -2, 2, 0.001, { group: 'Physics' }),
		n('resistance', 'Resistance', 0, 0, 20, 0, 5, 0.01, { group: 'Physics' }),
		n('extra', 'Extra', 1, 0, 10, 0, 2, 0.01, { group: 'Physics' }),
		fxParam.angle('extraAngle', 'Extra Angle', 360, { group: 'Physics' }),
		popup('floorAction', 'Floor Action', FLOOR_ACTIONS, 0, 'Physics'),
		n('floorPosition', 'Floor Position', 0.5, -10, 10, -1, 1, 0.001, { group: 'Physics' }),
		n('axisX', 'Direction Axis X', 0, -1, 1, -1, 1, 0.01, { group: 'Physics' }),
		n('axisY', 'Direction Axis Y', -1, -1, 1, -1, 1, 0.01, { group: 'Physics' }),
		n('axisZ', 'Direction Axis Z', 0, -1, 1, -1, 1, 0.01, { group: 'Physics' }),
		n('gravityX', 'Gravity Vector X', 0, -1, 1, -1, 1, 0.01, { group: 'Physics' }),
		n('gravityY', 'Gravity Vector Y', 1, -1, 1, -1, 1, 0.01, { group: 'Physics' }),
		n('gravityZ', 'Gravity Vector Z', 0, -1, 1, -1, 1, 0.01, { group: 'Physics' }),
		...particleParams({ birthSize: 0.2, deathSize: 0.2, sizeMax: 10 }),
		n('cameraDistance', 'Distance', 2, 0.1, 20, 0.5, 6, 0.01, { group: 'Effect Camera' }),
		fxParam.angle('cameraRotationX', 'Rotation X', 0, { group: 'Effect Camera' }),
		fxParam.angle('cameraRotationY', 'Rotation Y', 0, { group: 'Effect Camera' }),
		fxParam.angle('cameraRotationZ', 'Rotation Z', 0, { group: 'Effect Camera' }),
		n('cameraFov', 'FOV', 50, 1, 170, 10, 120, 0.1, { group: 'Effect Camera', unit: 'deg' }),
		popup('depthCue', 'Depth Cue', DEPTH_CUES, 0, 'Extras'),
		n('depthCueDistance', 'Depth Cue Distance', 2, 0.01, 50, 0.1, 10, 0.01, { group: 'Extras' }),
		fxParam.color('fogColor', 'Fog Color', [0, 0, 0, 1], { group: 'Extras' }),
		randomSeedParam(),
	],
	expensive: true,
	gpu: {
		kind: 'generator',
		uniforms: (p, ctx) => {
			const seed = Math.floor(ctx.seed * 4294967296) ^ 0x2545;
			const st = simulate(PW_CACHE, 'pw', p, ctx, (q, prev) => pwPhys(q, prev, seed));
			const lw = ctx.width;
			const lh = ctx.height;
			const s = ctx.pxScale;
			const cam = pwCamera(p, lw, lh);
			// Canvas px of a layer point: the box sits at the padding offset (none: 0) — the host passes u_box; the
			// layer box starts at the canvas origin for this unpadded effect.
			const toCanvas = (x: number, y: number): [number, number] => [x * s, y * s];
			const cueType = choice(p.depthCue, values(DEPTH_CUES));
			const cueDist = Math.max(0.01, num(p.depthCueDistance, 2));
			const fog = rgba(p.fogColor, [0, 0, 0, 1]);
			const vshade = num(p.volumeShade) / 100;
			const cue = (depth: number, c: number[]) => {
				const dq = clamp((depth - cam.dist) / cueDist, 0, 1);
				let [r, g, b, a] = c as [number, number, number, number];
				if (vshade > 0) {
					const k = 1 - vshade * clamp((depth - cam.dist + 1) / 2, 0, 1);
					r *= k;
					g *= k;
					b *= k;
				}
				if (cueType === 1) a *= 1 - dq;
				else if (cueType === 2) [r, g, b] = [r + (fog[0] - r) * dq, g + (fog[1] - g) * dq, b + (fog[2] - b) * dq];
				return [r, g, b, a];
			};
			const items = [
				...guideItems(p, cam, toCanvas, s),
				...particleItems(
					st,
					p,
					(x, y, z) => {
						const q = cam.project(x, y, z);
						if (!q) return null;
						const [cx, cy] = toCanvas(q[0], q[1]);
						return { x: cx, y: cy, depth: q[2], k: q[3] };
					},
					1,
					0.5 * lw * s * 0.25,
					cue,
				),
			];
			const packed = pack(items);
			return {
				u_parts: { texels: packed.texels },
				u_count: { int: packed.count },
				u_verts: { int: typeVertices(choice(p.particleType, TYPE_VALUES)) },
				u_post: { int: transferPost(p.transferMode) },
			};
		},
		passes: particlePasses,
	},
});

// ---------------------------------------------------------------- Particle Systems II

function psPhys(q: EffectParams, prev: EffectParams, seed: number, lw: number, lh: number): Phys {
	const unit = Math.max(1, lh);
	const pos = (r: EffectParams): [number, number, number] => {
		const v = vec2(r.position, [0.5, 0.5]);
		return [(v[0] * lw) / unit, (v[1] * lh) / unit, 0];
	};
	const p0 = pos(prev);
	const p1 = pos(q);
	const inh = num(q.inheritVelocity) / 100;
	const dir = rad(num(q.direction));
	return {
		rate: Math.max(0, num(q.birthRate, 2)) * 60,
		life: Math.max(0, num(q.longevity, 1)),
		producer: p1,
		radius: [Math.max(0, num(q.radiusX)) / unit, Math.max(0, num(q.radiusY)) / unit, 0],
		inherit: [(p1[0] - p0[0]) * SIM_SPS * inh, (p1[1] - p0[1]) * SIM_SPS * inh, 0],
		anim: choice(q.animation, ANIM_VALUES),
		speed: num(q.velocity, 2) * 0.25,
		gravity: [0, num(q.gravity, 1) * 0.5, 0],
		resistance: Math.max(0, num(q.resistance)),
		// After Effects angles: 0° = up, clockwise.
		axis: [Math.sin(dir), -Math.cos(dir), 0],
		extra: num(q.extra, 1),
		cone: Math.min(20, Math.abs(Math.tan(rad(45 * num(q.extra, 1)) * 0.5))),
		floor: 0,
		floorY: 0,
		seed,
		max: MAX_PARTICLES,
		flat: true,
	};
}

export const PARTICLE_SYSTEMS = defineShaderEffect({
	id: 'jasper.particle-systems',
	label: 'Particle Systems II',
	category: SIM,
	description: 'A 2D particle system: sparks, fountains and bursts from a producer point with gravity and resistance.',
	keywords: ['particles', 'emitter', 'sparks', 'fountain', 'cc particle systems'],
	params: [
		n('birthRate', 'Birth Rate', 2, 0, 100, 0, 20),
		n('longevity', 'Longevity (sec)', 1, 0, 100, 0, 10, 0.01, { unit: 's' }),
		fxParam.point('position', 'Position', [0.5, 0.5], { group: 'Producer' }),
		n('radiusX', 'Radius X', 0, 0, 2000, 0, 200, 0.1, { group: 'Producer', unit: 'px' }),
		n('radiusY', 'Radius Y', 0, 0, 2000, 0, 200, 0.1, { group: 'Producer', unit: 'px' }),
		popup('animation', 'Animation', PW_ANIMATIONS, 0, 'Physics'),
		n('velocity', 'Velocity', 2, -20, 20, 0, 10, 0.01, { group: 'Physics' }),
		n('inheritVelocity', 'Inherit Velocity %', 0, -100, 100, -100, 100, 0.1, { group: 'Physics' }),
		n('gravity', 'Gravity', 1, -20, 20, -5, 5, 0.01, { group: 'Physics' }),
		n('resistance', 'Resistance', 0, 0, 20, 0, 5, 0.01, { group: 'Physics' }),
		fxParam.angle('direction', 'Direction', 0, { group: 'Physics' }),
		n('extra', 'Extra', 1, 0, 10, 0, 2, 0.01, { group: 'Physics' }),
		...particleParams({ birthSize: 0.5, deathSize: 1.5, sizeMax: 20 }),
		randomSeedParam(),
	],
	expensive: true,
	gpu: {
		kind: 'generator',
		uniforms: (p, ctx) => {
			const seed = Math.floor(ctx.seed * 4294967296) ^ 0x85eb;
			const lw = ctx.width;
			const lh = ctx.height;
			const unit = Math.max(1, lh);
			const s = ctx.pxScale;
			const st = simulate(PS_CACHE, 'ps2', p, ctx, (q, prev) => psPhys(q, prev, seed, lw, lh));
			const items = particleItems(
				st,
				p,
				(x, y) => ({ x: x * unit * s, y: y * unit * s, depth: 0, k: 1 }),
				1,
				unit * 0.02 * s,
				(_d, c) => c,
			);
			// 2D: draw in birth order (no depth); `pack` sorts by depth, all equal → stable.
			const packed = pack(items);
			return {
				u_parts: { texels: packed.texels },
				u_count: { int: packed.count },
				u_verts: { int: typeVertices(choice(p.particleType, TYPE_VALUES)) },
				u_post: { int: transferPost(p.transferMode) },
			};
		},
		passes: particlePasses,
	},
});

// ---------------------------------------------------------------- Mercury

const INFLUENCE_MAPS = ['Constant Blobs', 'Blob In', 'Blob Out', 'Blob In & Out'] as const;

export const MERCURY = defineShaderEffect({
	id: 'jasper.mercury',
	label: 'Mercury',
	category: SIM,
	description: 'Liquid-metal blobs: a particle system rendered as merging, shaded metaballs that refract the layer.',
	keywords: ['metaballs', 'liquid', 'metal', 'blobs', 'mr mercury', 'cc mr mercury'],
	params: [
		n('radiusX', 'Radius X', 50, 0, 2000, 0, 300, 0.1, { unit: 'px' }),
		n('radiusY', 'Radius Y', 50, 0, 2000, 0, 300, 0.1, { unit: 'px' }),
		fxParam.point('producer', 'Producer', [0.5, 0.5]),
		fxParam.angle('direction', 'Direction', 0),
		n('velocity', 'Velocity', 1, -20, 20, 0, 5),
		n('birthRate', 'Birth Rate', 1, 0, 20, 0, 5),
		n('longevity', 'Longevity (sec)', 2, 0, 100, 0, 10, 0.01, { unit: 's' }),
		n('gravity', 'Gravity', 0.5, -20, 20, -5, 5),
		n('resistance', 'Resistance', 0, 0, 20, 0, 5),
		n('extra', 'Extra', 1, 0, 10, 0, 2),
		popup('animation', 'Animation', PW_ANIMATIONS, 0),
		n('blobInfluence', 'Blob Influence', 100, 0, 400, 0, 200, 0.1),
		popup('influenceMap', 'Influence Map', INFLUENCE_MAPS, 0),
		n('blobBirthSize', 'Blob Birth Size', 0.5, 0, 10, 0, 2),
		n('blobDeathSize', 'Blob Death Size', 0.25, 0, 10, 0, 2),
		n('lightIntensity', 'Light Intensity', 100, 0, 400, 0, 200, 0.1, { group: 'Light' }),
		fxParam.color('lightColor', 'Light Color', [1, 1, 1, 1], { group: 'Light' }),
		n('lightHeight', 'Light Height', 50, -100, 100, -100, 100, 0.1, { group: 'Light' }),
		fxParam.angle('lightDirection', 'Light Direction', -45, { group: 'Light' }),
		n('ambient', 'Ambient', 0, -200, 200, -100, 100, 0.1, { group: 'Shading' }),
		n('diffuse', 'Diffuse', 75, 0, 200, 0, 100, 0.1, { group: 'Shading' }),
		n('specular', 'Specular', 50, 0, 200, 0, 100, 0.1, { group: 'Shading' }),
		n('roughness', 'Roughness', 0.05, 0.001, 1, 0.001, 0.5, 0.001, { group: 'Shading' }),
		fxParam.percent('metal', 'Metal', 100, { group: 'Shading' }),
		randomSeedParam(),
	],
	expensive: true,
	gpu: {
		uniforms: (p, ctx) => {
			const seed = Math.floor(ctx.seed * 4294967296) ^ 0xc2b2;
			const lw = ctx.width;
			const lh = ctx.height;
			const unit = Math.max(1, lh);
			const s = ctx.pxScale;
			const st = simulate(MERCURY_CACHE, 'mercury', p, ctx, (q, prev) => {
				const ph = psPhys(
					{ ...q, position: q.producer, radiusX: q.radiusX, radiusY: q.radiusY },
					{ ...prev, position: prev.producer },
					seed,
					lw,
					lh,
				);
				return {
					...ph,
					rate: Math.max(0, num(q.birthRate, 1)) * 10,
					speed: num(q.velocity, 1) * 0.3,
					inherit: [0, 0, 0],
					max: 4000,
				};
			});
			const bs = num(p.blobBirthSize, 0.5);
			const ds = num(p.blobDeathSize, 0.25);
			const map = choice(p.influenceMap, values(INFLUENCE_MAPS));
			const blobs: number[] = [];
			for (let r = 0; r < st.n; r++) {
				const o = r * P_STRIDE;
				const u = lifeOf(st, r);
				let size = bs + (ds - bs) * u;
				if (map === 1) size *= Math.min(1, u * 4);
				else if (map === 2) size *= Math.min(1, (1 - u) * 4);
				else if (map === 3) size *= Math.min(1, u * 4, (1 - u) * 4);
				const rr = Math.max(0, size * unit * 0.08 * s);
				if (rr <= 0.1) continue;
				blobs.push(st.d[o + PF.x]! * unit * s, st.d[o + PF.y]! * unit * s, rr, 0);
			}
			return {
				u_blobs: { texels: blobs.length ? blobs : [0, 0, 0, 0] },
				u_count: { int: blobs.length / 4 },
			};
		},
		passes: [
			{
				// The metaball field and its gradient (additive, rgba16f): f = Σ (1 − d²/R²)³ inside R = 2r(1 + influence).
				output: 'field',
				format: 'rgba16f',
				include: [GLSL_DATA],
				draw: {
					vertices: 6,
					instances: { uniform: 'u_count' },
					blend: 'add',
					vert: /* glsl */ `
out vec2 v_q;
flat out vec3 v_b;
vec2 mc_corner(int v) {
  int c = v == 3 ? 2 : v == 4 ? 1 : v == 5 ? 3 : v;
  return vec2(c == 1 || c == 3 ? 1.0 : -1.0, c >= 2 ? 1.0 : -1.0);
}
void main() {
  vec4 b = fx_texel(u_blobs, gl_InstanceID);
  float rr = b.z * 2.0 * (1.0 + u_blobInfluence / 100.0);
  vec2 c = u_box.xy + b.xy;
  vec2 q = c + mc_corner(gl_VertexID) * (rr + 1.0);
  v_q = q;
  v_b = vec3(c, rr);
  fx_emit(q);
}`,
				},
				frag: /* glsl */ `
in vec2 v_q;
flat in vec3 v_b;
void main() {
  vec2 d = v_q - v_b.xy;
  float d2 = dot(d, d) / (v_b.z * v_b.z);
  if (d2 >= 1.0) { fragColor = vec4(0.0); return; }
  float k = 1.0 - d2;
  float g = -6.0 * k * k / (v_b.z * v_b.z);
  fragColor = vec4(k * k * k, g * d.x, g * d.y, 0.0);
}`,
			},
			{
				frag: /* glsl */ `
void main() {
  vec4 fv = texture(u_field, v_uv);
  float thr = 0.35;
  if (u_count == 0 || fv.x <= thr * 0.8) { fragColor = vec4(0.0); return; }
  float cov = clamp((fv.x - thr * 0.8) / (thr * 0.4), 0.0, 1.0);
  vec3 n = normalize(vec3(fv.y * 3.0, fv.z * 3.0, 1.0 / (1.0 + fv.x)));
  vec4 sp = texture(u_source, clamp(v_uv - n.xy * 12.0 * u_pxScale / u_canvasSize, vec2(0.0), vec2(1.0)));
  vec3 base = sp.a > 0.0 ? sp.rgb / sp.a : vec3(0.7, 0.7, 0.75);
  float ld = radians(u_lightDirection);
  vec3 l = normalize(vec3(sin(ld), -cos(ld), max(u_lightHeight / 100.0, 0.05)));
  float li = u_lightIntensity / 100.0;
  float nl = max(dot(n, l), 0.0);
  vec3 hv = normalize(vec3(l.xy, l.z + 1.0));
  float spec = pow(max(dot(n, hv), 0.0), 1.0 / max(u_roughness, 0.001)) * u_specular / 100.0 * li;
  float shade = u_ambient / 100.0 + u_diffuse / 100.0 * nl * li;
  float metal = u_metal / 100.0;
  vec3 c = base * shade + spec * (u_lightColor.rgb * (1.0 - metal) + base * metal);
  fragColor = vec4(c * cov, cov);
}`,
			},
		],
	},
});

export const PARTICLE_EFFECTS: readonly EffectSpec[] = [PARTICLE_WORLD, PARTICLE_SYSTEMS, MERCURY];
