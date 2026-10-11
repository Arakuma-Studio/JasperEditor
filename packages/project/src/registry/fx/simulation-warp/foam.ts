// Simulation ▸ Foam (After Effects' Foam): bubbles born in a producer rectangle grow to their
// size, drift with the wind, turbulence and a Flow Map (they run downhill on its luminance), repel and stick to each
// other, wobble and pop at the end of their Strength-shortened lifespan, pushing their neighbours away at Pop
// Velocity. Draft views show bubble outlines (and the flow map); Rendered draws a built-in bubble texture or the
// Bubble Texture Layer, oriented by Bubble Orientation, reflecting the Environment Map. Stepped once per 1/30 s from
// clip time 0 with the params of each step (checkpointed: seeking equals playing).
// Ported from EffectCraft crates/effects/src/sim2.rs (foam_full_plan; MIT OR Apache-2.0), see
// licenses/ported/sim-warp.md.
import type { EffectParams, EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { GLSL_DATA } from '../glsl/data.ts';
import { fxParam } from '../params.ts';
import type { FxFrameContext, FxPixels } from '../shader.ts';
import { n, popup, randomSeedParam, values } from './common.ts';
import { bool, choice, clamp, hs, num, SimCache, simKey, valueNoise3, vec2 } from './core.ts';
import { GLSL_SPRITES } from './sprites.ts';

const FOAM_FPS = 30;
const FOAM_MAX = 3000;
const VIEWS = ['Draft', 'Draft + Flow Map', 'Rendered'] as const;
const TEXTURES = ['Default Bubble', 'Spit', 'Bubblegum', 'Dishwater', 'Milky', 'User Defined'] as const;
const BLENDS = ['Transparent', 'Solid Old on Top', 'Solid New on Top'] as const;
const ORIENT = ['Fixed', 'Physical Orientation', 'Bubble Velocity'] as const;
const STRIDE = 8; // x, y, vx, vy, age, size, spin, id

type FoamState = { d: Float64Array; n: number; carry: number; next: number };
const newState = (): FoamState => ({ d: new Float64Array(STRIDE * 64), n: 0, carry: 0, next: 0 });
const cloneState = (s: FoamState): FoamState => ({
	d: s.d.slice(0, Math.max(1, s.n) * STRIDE),
	n: s.n,
	carry: s.carry,
	next: s.next,
});

/** Age (steps) at which bubble `id` pops: its lifespan, shortened at random for frail bubbles. */
const popAge = (id: number, lifespan: number, frailty: number, seed: number) =>
	lifespan * (1 - frailty * (hs(id, 11, seed) * 0.5 + 0.5));

/** Luminance × alpha of a map at u, v (0..1), bilinear. */
function lum(px: FxPixels, u: number, v: number): number {
	const fx = clamp(u * px.width - 0.5, 0, px.width - 1);
	const fy = clamp(v * px.height - 0.5, 0, px.height - 1);
	const x0 = Math.floor(fx);
	const y0 = Math.floor(fy);
	const x1 = Math.min(px.width - 1, x0 + 1);
	const y1 = Math.min(px.height - 1, y0 + 1);
	const at = (x: number, y: number) => {
		const i = (y * px.width + x) * 4;
		return (
			((0.2126 * px.data[i]! + 0.7152 * px.data[i + 1]! + 0.0722 * px.data[i + 2]!) / 255) *
			(px.data[i + 3]! / 255)
		);
	};
	const tx = fx - x0;
	const ty = fy - y0;
	const a = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * tx;
	const b = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * tx;
	return a + (b - a) * ty;
}

const CACHE = new SimCache<FoamState>(4);

function foamStep(
	st: FoamState,
	q: EffectParams,
	step: number,
	lw: number,
	lh: number,
	seed: number,
	flow: FxPixels | null,
): void {
	const unit = lw * 0.01;
	const prod = vec2(q.producerPoint, [0.5, 0.5]);
	const pxp = prod[0] * lw;
	const pyp = prod[1] * lh;
	const psx = num(q.producerXSize, 0.05) * lw;
	const psy = num(q.producerYSize, 0.05) * lh;
	const porient = (num(q.producerOrientation) * Math.PI) / 180;
	const rate = Math.max(0, num(q.productionRate, 1));
	const size = Math.max(0, num(q.size, 0.5));
	const sizeVar = num(q.sizeVariance, 0.5);
	const lifespan = Math.max(1, num(q.lifespan, 300));
	const growth = Math.max(0.0001, num(q.bubbleGrowthSpeed, 0.1));
	const frailty = 1 - clamp(num(q.strength, 10) / 20, 0, 1);
	const initSpeed = num(q.initialSpeed);
	const initDir = (num(q.initialDirection) * Math.PI) / 180;
	const wind = num(q.windSpeed, 0.5);
	const windDir = (num(q.windDirection, 90) * Math.PI) / 180;
	const turb = num(q.turbulence, 0.5);
	const repulsion = num(q.repulsion, 1);
	const popVelocity = num(q.popVelocity, 1);
	const viscosity = clamp(num(q.viscosity, 0.1), 0, 1);
	const sticky = clamp(num(q.stickiness, 0.75), 0, 1);
	const universe = Math.max(0.01, num(q.universeSize, 1));
	const steep = num(q.flowMapSteepness, 0.05);
	const fitsUniverse = choice(q.flowMapFits, values(['Background', 'Universe'])) === 1;
	const substeps = [1, 2, 4][choice(q.simulationQuality, values(['Normal', 'High', 'Intense']))]!;
	const wvec = [Math.sin(windDir) * wind * unit, -Math.cos(windDir) * wind * unit];
	const ux0 = -(universe - 1) * 0.5 * lw;
	const uy0 = -(universe - 1) * 0.5 * lh;
	const ux1 = lw - ux0;
	const uy1 = lh - uy0;
	const hAt = (x: number, y: number) =>
		flow
			? lum(
					flow,
					fitsUniverse ? (x - ux0) / (ux1 - ux0) : x / lw,
					fitsUniverse ? (y - uy0) / (uy1 - uy0) : y / lh,
				)
			: 0;
	const t = step / FOAM_FPS;
	const rad = (o: number) => st.d[o + 5]! * unit * 3 * Math.min(1, st.d[o + 4]! * growth);
	// Births.
	st.carry += rate;
	const born = Math.floor(st.carry);
	st.carry -= born;
	for (let k = 0; k < born && st.n < FOAM_MAX; k++) {
		const id = st.next++;
		if ((st.n + 1) * STRIDE > st.d.length) {
			const d = new Float64Array(st.d.length * 2);
			d.set(st.d);
			st.d = d;
		}
		const u = hs(id, 1, seed) * 0.5 * psx;
		const w = hs(id, 2, seed) * 0.5 * psy;
		const o = st.n * STRIDE;
		st.d[o] = pxp + u * Math.cos(porient) - w * Math.sin(porient);
		st.d[o + 1] = pyp + u * Math.sin(porient) + w * Math.cos(porient);
		st.d[o + 2] = Math.sin(initDir) * initSpeed * unit;
		st.d[o + 3] = -Math.cos(initDir) * initSpeed * unit;
		st.d[o + 4] = 0;
		st.d[o + 5] = Math.max(0.01, size * (1 + sizeVar * hs(id, 3, seed)));
		st.d[o + 6] = hs(id, 12, seed) * Math.PI;
		st.d[o + 7] = id;
		st.n++;
	}
	const d = st.d;
	for (let sub = 0; sub < substeps; sub++) {
		const k = 1 / substeps;
		for (let i = 0; i < st.n; i++) {
			const o = i * STRIDE;
			const n1 = valueNoise3(d[o]! / (lw * 0.15), d[o + 1]! / (lw * 0.15), t * 0.5, seed) - 0.5;
			const n2 = valueNoise3(d[o]! / (lw * 0.15) + 19, d[o + 1]! / (lw * 0.15), t * 0.5, seed) - 0.5;
			for (let c = 0; c < 2; c++) {
				d[o + 2 + c] = d[o + 2 + c]! + (wvec[c]! - d[o + 2 + c]!) * 0.1 * k;
				d[o + 2 + c] = d[o + 2 + c]! * (1 - viscosity * 0.5 * k);
			}
			d[o + 2] = d[o + 2]! + n1 * turb * unit * k;
			d[o + 3] = d[o + 3]! + n2 * turb * unit * k;
			if (flow && steep !== 0) {
				const e = Math.max(unit, 1);
				const gx = (hAt(d[o]! + e, d[o + 1]!) - hAt(d[o]! - e, d[o + 1]!)) / (2 * e);
				const gy = (hAt(d[o]!, d[o + 1]! + e) - hAt(d[o]!, d[o + 1]! - e)) / (2 * e);
				d[o + 2] = d[o + 2]! - gx * steep * lw * 0.5 * k;
				d[o + 3] = d[o + 3]! - gy * steep * lw * 0.5 * k;
			}
			d[o + 6] = d[o + 6]! + (d[o + 2]! / Math.max(rad(o), 0.5)) * k;
		}
		if (repulsion > 0 && st.n > 1) {
			let maxr = 1;
			for (let i = 0; i < st.n; i++) maxr = Math.max(maxr, rad(i * STRIDE));
			const cs = maxr * 2;
			const grid = new Map<string, number[]>();
			for (let i = 0; i < st.n; i++) {
				const key = `${Math.floor(d[i * STRIDE]! / cs)},${Math.floor(d[i * STRIDE + 1]! / cs)}`;
				const l = grid.get(key);
				if (l) l.push(i);
				else grid.set(key, [i]);
			}
			const push = new Float64Array(st.n * 2);
			for (let i = 0; i < st.n; i++) {
				const o = i * STRIDE;
				const gx = Math.floor(d[o]! / cs);
				const gy = Math.floor(d[o + 1]! / cs);
				for (let dy = -1; dy <= 1; dy++)
					for (let dx = -1; dx <= 1; dx++) {
						const list = grid.get(`${gx + dx},${gy + dy}`);
						if (!list) continue;
						for (const j of list) {
							if (j <= i) continue;
							const q2 = j * STRIDE;
							const ddx = d[q2]! - d[o]!;
							const ddy = d[q2 + 1]! - d[o + 1]!;
							const dist = Math.max(Math.hypot(ddx, ddy), 1e-4);
							const overlap = rad(o) + rad(q2) - dist;
							if (overlap > 0) {
								const f = ((overlap * 0.5 * Math.min(repulsion, 4) * (1 - sticky * 0.5)) / dist) * k;
								push[i * 2] = push[i * 2]! - ddx * f;
								push[i * 2 + 1] = push[i * 2 + 1]! - ddy * f;
								push[j * 2] = push[j * 2]! + ddx * f;
								push[j * 2 + 1] = push[j * 2 + 1]! + ddy * f;
							}
						}
					}
			}
			for (let i = 0; i < st.n; i++) {
				d[i * STRIDE] = d[i * STRIDE]! + clamp(push[i * 2]!, -maxr, maxr);
				d[i * STRIDE + 1] = d[i * STRIDE + 1]! + clamp(push[i * 2 + 1]!, -maxr, maxr);
			}
		}
		for (let i = 0; i < st.n; i++) {
			const o = i * STRIDE;
			d[o] = d[o]! + d[o + 2]! * k;
			d[o + 1] = d[o + 1]! + d[o + 3]! * k;
		}
	}
	for (let i = 0; i < st.n; i++) d[i * STRIDE + 4] = d[i * STRIDE + 4]! + 1;
	// Pops push the neighbours away.
	const popped: [number, number, number][] = [];
	for (let i = 0; i < st.n; i++) {
		const o = i * STRIDE;
		if (d[o + 4]! >= popAge(d[o + 7]!, lifespan, frailty, seed)) popped.push([d[o]!, d[o + 1]!, rad(o)]);
	}
	if (popVelocity !== 0)
		for (const [px, py, pr] of popped) {
			const reach = Math.max(pr * 3, unit);
			for (let i = 0; i < st.n; i++) {
				const o = i * STRIDE;
				const dx = d[o]! - px;
				const dy = d[o + 1]! - py;
				const dist = Math.hypot(dx, dy);
				if (dist > 1e-4 && dist < reach) {
					const f = (popVelocity * unit * (1 - dist / reach)) / dist;
					d[o + 2] = d[o + 2]! + dx * f;
					d[o + 3] = d[o + 3]! + dy * f;
				}
			}
		}
	let w = 0;
	for (let i = 0; i < st.n; i++) {
		const o = i * STRIDE;
		const alive =
			d[o + 4]! < popAge(d[o + 7]!, lifespan, frailty, seed) &&
			d[o]! > ux0 &&
			d[o]! < ux1 &&
			d[o + 1]! > uy0 &&
			d[o + 1]! < uy1;
		if (!alive) continue;
		if (w !== i) d.copyWithin(w * STRIDE, o, o + STRIDE);
		w++;
	}
	st.n = w;
}

function simulateFoam(p: EffectParams, ctx: FxFrameContext): FoamState {
	const flow = ctx.pixels?.('flowMap') ?? null;
	const seed = Math.floor(ctx.seed * 4294967296) ^ 0x68e3;
	const t = ctx.frame / (ctx.fps > 0 ? ctx.fps : 30);
	const steps = t > 0 ? Math.min(FOAM_FPS * 600, Math.floor(t * FOAM_FPS + 1e-6)) : 0;
	return CACHE.run(
		simKey(p, ctx, 'foam', flow?.key ?? ''),
		steps,
		newState,
		(st, i) =>
			foamStep(st, ctx.paramsAt?.((i / FOAM_FPS) * ctx.fps) ?? p, i, ctx.width, ctx.height, seed, flow),
		cloneState,
	);
}

export const FOAM = defineShaderEffect({
	id: 'jasper.foam',
	label: 'Foam',
	category: 'Simulation',
	description:
		'Generates bubbles that grow, drift with wind, turbulence and a flow map, stick, repel and pop, drawn as outlines or textured, reflective bubbles.',
	keywords: ['bubbles', 'foam', 'soap', 'fizz', 'liquid'],
	params: [
		popup('view', 'View', VIEWS, 0),
		fxParam.point('producerPoint', 'Producer Point', [0.5, 0.5], { group: 'Producer' }),
		n('producerXSize', 'Producer X Size', 0.05, 0, 2, 0, 1, 0.001, { group: 'Producer' }),
		n('producerYSize', 'Producer Y Size', 0.05, 0, 2, 0, 1, 0.001, { group: 'Producer' }),
		fxParam.angle('producerOrientation', 'Producer Orientation', 0, { group: 'Producer' }),
		fxParam.toggle('zoomProducerPoint', 'Zoom Producer Point', false, { group: 'Producer' }),
		n('productionRate', 'Production Rate', 1, 0, 50, 0, 10, 0.001, { group: 'Producer' }),
		n('size', 'Size', 0.5, 0, 10, 0, 2, 0.001, { group: 'Bubbles' }),
		n('sizeVariance', 'Size Variance', 0.5, 0, 1, 0, 1, 0.001, { group: 'Bubbles' }),
		n('lifespan', 'Lifespan', 300, 1, 30000, 1, 1000, 0.1, { group: 'Bubbles' }),
		n('bubbleGrowthSpeed', 'Bubble Growth Speed', 0.1, 0.0001, 10, 0.0001, 1, 0.0001, { group: 'Bubbles' }),
		n('strength', 'Strength', 10, 0, 100, 0, 20, 0.01, { group: 'Bubbles' }),
		n('initialSpeed', 'Initial Speed', 0, -100, 100, -10, 10, 0.001, { group: 'Physics' }),
		fxParam.angle('initialDirection', 'Initial Direction', 0, { group: 'Physics' }),
		n('windSpeed', 'Wind Speed', 0.5, -100, 100, -10, 10, 0.001, { group: 'Physics' }),
		fxParam.angle('windDirection', 'Wind Direction', 90, { group: 'Physics' }),
		n('turbulence', 'Turbulence', 0.5, 0, 10, 0, 2, 0.001, { group: 'Physics' }),
		n('wobbleAmount', 'Wobble Amount', 0.05, 0, 10, 0, 2, 0.001, { group: 'Physics' }),
		n('repulsion', 'Repulsion', 1, 0, 10, 0, 2, 0.001, { group: 'Physics' }),
		n('popVelocity', 'Pop Velocity', 1, -100, 100, -10, 10, 0.001, { group: 'Physics' }),
		n('viscosity', 'Viscosity', 0.1, 0, 1, 0, 1, 0.001, { group: 'Physics' }),
		n('stickiness', 'Stickiness', 0.75, 0, 1, 0, 1, 0.001, { group: 'Physics' }),
		n('zoom', 'Zoom', 1, 0.01, 50, 0.1, 5, 0.001),
		n('universeSize', 'Universe Size', 1, 0.01, 10, 0.5, 3, 0.001),
		popup('blendMode', 'Blend Mode', BLENDS, 0, 'Rendering'),
		popup('bubbleTexture', 'Bubble Texture', TEXTURES, 0, 'Rendering'),
		fxParam.media('bubbleTextureLayer', 'Bubble Texture Layer', ['image', 'video'], { group: 'Rendering' }),
		popup('bubbleOrientation', 'Bubble Orientation', ORIENT, 0, 'Rendering'),
		fxParam.media('environmentMap', 'Environment Map', ['image', 'video'], { group: 'Rendering' }),
		n('reflectionStrength', 'Reflection Strength', 0, 0, 1, 0, 1, 0.001, { group: 'Rendering' }),
		n('reflectionConvergence', 'Reflection Convergence', 0, 0, 1, 0, 1, 0.001, { group: 'Rendering' }),
		fxParam.media('flowMap', 'Flow Map', ['image'], { group: 'Flow Map' }),
		n('flowMapSteepness', 'Flow Map Steepness', 0.05, -100, 100, -1, 1, 0.001, { group: 'Flow Map' }),
		popup('flowMapFits', 'Flow Map Fits', ['Background', 'Universe'], 0, 'Flow Map'),
		popup('simulationQuality', 'Simulation Quality', ['Normal', 'High', 'Intense'], 0, 'Flow Map'),
		randomSeedParam(1),
	],
	expensive: true,
	gpu: {
		kind: 'generator',
		cpuPixels: ['flowMap'],
		uniforms: (p, ctx) => {
			const st = simulateFoam(p, ctx);
			const lw = ctx.width;
			const lh = ctx.height;
			const s = ctx.pxScale;
			const unit = lw * 0.01;
			const seed = Math.floor(ctx.seed * 4294967296) ^ 0x68e3;
			const lifespan = Math.max(1, num(p.lifespan, 300));
			const frailty = 1 - clamp(num(p.strength, 10) / 20, 0, 1);
			const growth = Math.max(0.0001, num(p.bubbleGrowthSpeed, 0.1));
			const wobble = Math.max(0, num(p.wobbleAmount, 0.05));
			const zoom = Math.max(0.01, num(p.zoom, 1));
			const prod = vec2(p.producerPoint, [0.5, 0.5]);
			const [cx, cy] = bool(p.zoomProducerPoint) ? [prod[0] * lw, prod[1] * lh] : [lw / 2, lh / 2];
			const orient = choice(p.bubbleOrientation, values(ORIENT));
			const blend = choice(p.blendMode, values(BLENDS));
			const order = Array.from({ length: st.n }, (_, i) => i);
			const age = (i: number) => st.d[i * STRIDE + 4]!;
			const idOf = (i: number) => st.d[i * STRIDE + 7]!;
			if (blend === 2) order.sort((a, b) => age(b) - age(a) || idOf(a) - idOf(b));
			else if (blend === 1) order.sort((a, b) => age(a) - age(b) || idOf(a) - idOf(b));
			const out = new Float32Array(Math.max(1, st.n) * 4);
			order.forEach((i, j) => {
				const o = i * STRIDE;
				const a = st.d[o + 4]!;
				const wob = wobble > 0 ? 1 + wobble * 0.15 * Math.sin(a * 0.35 + hs(idOf(i), 13, seed) * 6) : 1;
				const r = st.d[o + 5]! * unit * 3 * Math.min(1, a * growth) * wob * zoom * s;
				const rot = orient === 1 ? st.d[o + 6]! : orient === 2 ? Math.atan2(st.d[o + 3]!, st.d[o + 2]!) : 0;
				const fade = clamp((popAge(idOf(i), lifespan, frailty, seed) - a) / 5, 0, 1);
				out[j * 4] = (cx + (st.d[o]! - cx) * zoom) * s;
				out[j * 4 + 1] = (cy + (st.d[o + 1]! - cy) * zoom) * s;
				out[j * 4 + 2] = r;
				// Rotation and fade packed: fade in the integer part ×1000? Keep them apart: rot (rad) + fade in w.
				out[j * 4 + 3] =
					Math.floor(fade * 1000) + (((rot % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2);
			});
			return { u_bubbles: { texels: out }, u_count: { int: st.n } };
		},
		passes: (p) => [
			{
				output: 'foam',
				include: [GLSL_SPRITES, GLSL_DATA],
				draw: {
					vertices: 6,
					instances: { uniform: 'u_count' },
					// Transparent (Rendered): bubbles add up like light; otherwise solid, in age order.
					blend:
						choice(p.blendMode, values(BLENDS)) === 0 && choice(p.view, values(VIEWS)) === 2 ? 'add' : 'over',
					vert: /* glsl */ `
out vec2 v_q;
flat out vec4 v_b; // centre, radius, rotation
flat out float v_fade;
void main() {
  vec4 b = fx_texel(u_bubbles, gl_InstanceID);
  float fade = floor(b.w) / 1000.0;
  float rot = fract(b.w) * 6.2831853;
  if (b.z <= 0.05 || fade <= 0.0) { fx_cull(); v_q = vec2(0.0); v_b = vec4(0.0); v_fade = 0.0; return; }
  vec2 c = u_box.xy + b.xy;
  vec2 q = c + sp_corner(gl_VertexID) * (b.z + 1.5);
  v_q = q; v_b = vec4(c, b.z, rot); v_fade = fade;
  fx_emit(q);
}`,
				},
				frag: /* glsl */ `
in vec2 v_q;
flat in vec4 v_b;
flat in float v_fade;
void main() {
  vec2 d = v_q - v_b.xy;
  float r = max(v_b.z, 0.5);
  if (u_view != 2) { fragColor = sp_shade(4, d, r, 0.0, vec2(0.0), vec4(0.55, 0.75, 1.0, v_fade)); return; }
  vec2 uv = d / r;
  float dd = length(uv);
  float cov = clamp((1.0 - dd) * r + 0.5, 0.0, 1.0);
  vec4 c;
  if (u_bubbleTexture == 5) {
    if (cov <= 0.0) { fragColor = vec4(0.0); return; }
    float sr = sin(v_b.w), cr = cos(v_b.w);
    vec2 tu = vec2(uv.x * cr + uv.y * sr, -uv.x * sr + uv.y * cr);
    vec4 tx = u_bubbleTextureLayer_size.x > 0.0 ? texture(u_bubbleTextureLayer, tu * 0.5 + 0.5) : vec4(0.0);
    c = tx * v_fade * cov;
  } else {
    int shape = u_bubbleTexture == 1 ? 3 : (u_bubbleTexture == 4 ? 2 : 4);
    vec3 col = u_bubbleTexture == 2 ? vec3(1.0, 0.6, 0.8) : (u_bubbleTexture == 3 ? vec3(0.8, 0.85, 0.75) : (u_bubbleTexture == 4 ? vec3(0.97, 0.97, 0.95) : (u_bubbleTexture == 1 ? vec3(0.95, 0.95, 0.92) : vec3(1.0))));
    c = sp_shade(shape, d, r, v_b.w, vec2(0.0), vec4(col, v_fade));
  }
  if (u_environmentMap_size.x > 0.0 && u_reflectionStrength > 0.0 && cov > 0.0) {
    vec2 bc = v_b.xy / u_canvasSize;
    vec2 e = u_reflectionConvergence >= 1.0 ? bc : bc * u_reflectionConvergence + (clamp(uv, -1.0, 1.0) * 0.5 + 0.5) * (1.0 - u_reflectionConvergence);
    vec4 env = texture(u_environmentMap, e);
    float rim = min(dot(uv, uv), 1.0);
    c.rgb += env.rgb * u_reflectionStrength * (0.3 + 0.7 * rim) * cov;
  }
  fragColor = c;
}`,
			},
			{
				frag: /* glsl */ `
void main() {
  vec4 o = texture(u_foam, v_uv);
  if (u_view == 1 && u_flowMap_size.x > 0.0) o += texture(u_flowMap, fx_layerNorm()) * 0.5 * (1.0 - o.a);
  fragColor = vec4(min(o.rgb, vec3(o.a)), o.a);
}`,
			},
		],
	},
});

export const FOAM_EFFECTS: readonly EffectSpec[] = [FOAM];
