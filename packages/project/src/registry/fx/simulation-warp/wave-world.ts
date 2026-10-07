// Simulation ▸ Wave World (sim-warp workstream; After Effects' Wave World): a stepped 2D wave equation on a grid,
// driven by two producers (rings or lines oscillating at Amplitude / Frequency / Phase), damped, reflected or absorbed
// at the edges, shaped by an optional Ground image (its luminance is an elevation: dry land is a wall, shallow water
// slows the waves by Wave Strength). Views: Height Map (a grey displacement map for Caustics / Displacement Map) and
// Wireframe Preview (the grid in perspective). Stepped from clip time 0 (+ Pre-roll) at SIM_SPS with the params of
// each step; checkpointed so seeking equals playing.
// Ported from EffectCraft crates/effects/src/sim2.rs (wave_world_impl, Producer; MIT OR Apache-2.0), see
// licenses/ported/sim-warp.md.
import type { EffectParams, EffectSpec, ParamSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { GLSL_DATA } from '../glsl/data.ts';
import { fxParam } from '../params.ts';
import type { FxFrameContext, FxPixels } from '../shader.ts';
import { n, popup, values } from './common.ts';
import { bool, choice, clamp, num, SIM_SPS, SimCache, simKey, stepsAt, vec2 } from './core.ts';
import { GLSL_SPRITES, SPRITE_FRAG_MAIN, SPRITE_VERT_DECLS } from './sprites.ts';

const VIEWS = ['Wireframe Preview', 'Height Map'] as const;
const REFLECT = ['None', 'Left', 'Top', 'Right', 'Bottom', 'All'] as const;

type Waves = { nx: number; ny: number; u: Float64Array; v: Float64Array };

function producerParams(k: 1 | 2, amp: number, pos: [number, number]): ParamSpec[] {
	const g = `Producer ${k}`;
	const id = (s: string) => `producer${k}${s}`;
	return [
		popup(id('Type'), 'Type', ['Ring', 'Line'], 0, g),
		fxParam.point(id('Position'), 'Position', pos, { group: g }),
		n(id('Length'), 'Height/Length', 0.1, 0, 2, 0, 1, 0.001, { group: g }),
		n(id('Width'), 'Width', 0.1, 0, 2, 0, 1, 0.001, { group: g }),
		fxParam.angle(id('Angle'), 'Angle', 0, { group: g }),
		n(id('Amplitude'), 'Amplitude', amp, -5, 5, -1, 1, 0.001, { group: g }),
		n(id('Frequency'), 'Frequency', 1, 0, 30, 0, 5, 0.001, { group: g }),
		fxParam.angle(id('Phase'), 'Phase', 0, { group: g }),
	];
}

/** Grid size of the simulation (nx × ny points). */
export function waveGrid(p: EffectParams, lw: number, lh: number, pxScale: number) {
	let res = clamp(Math.round(num(p.gridResolution, 60)), 1, 400);
	if (bool(p.gridResDownsamples)) res = Math.max(1, Math.round(res * pxScale));
	const nx = Math.max(2, res) + 1;
	const ny = Math.max(2, Math.round((res * lh) / Math.max(1, lw))) + 1;
	return { nx, ny };
}

/** Water depth per grid point from the Ground image (null without one: deep everywhere). */
function groundDepth(p: EffectParams, px: FxPixels | null, nx: number, ny: number): Float64Array | null {
	if (!px) return null;
	const steep = num(p.steepness, 0.25);
	const level = num(p.groundHeight, 0.25);
	const out = new Float64Array(nx * ny);
	for (let i = 0; i < nx * ny; i++) {
		const fx = (i % nx) / (nx - 1);
		const fy = Math.floor(i / nx) / (ny - 1);
		const x = clamp(Math.floor(fx * px.width), 0, px.width - 1);
		const y = clamp(Math.floor(fy * px.height), 0, px.height - 1);
		const o = (y * px.width + x) * 4;
		const l = ((0.2126 * px.data[o]! + 0.7152 * px.data[o + 1]! + 0.0722 * px.data[o + 2]!) / 255) * (px.data[o + 3]! / 255);
		out[i] = level - steep * l;
	}
	return out;
}

const CACHE = new SimCache<Waves>(4);

function simulateWaves(p: EffectParams, ctx: FxFrameContext): { st: Waves; depth: Float64Array | null } {
	const lw = Math.max(1, ctx.width);
	const lh = Math.max(1, ctx.height);
	const { nx, ny } = waveGrid(p, lw, lh, ctx.pxScale);
	const ground = ctx.pixels?.('ground') ?? null;
	const depth = groundDepth(p, ground, nx, ny);
	const preroll = Math.max(0, num(p.preRoll));
	const t = ctx.frame / (ctx.fps > 0 ? ctx.fps : 30);
	const cell = 1 / (nx - 1);
	const strength = clamp(num(p.waveStrength), 0, 1);
	const level = Math.max(1e-3, num(p.groundHeight, 0.25));
	const speedK = new Float64Array(nx * ny).fill(1);
	if (depth)
		for (let i = 0; i < nx * ny; i++)
			speedK[i] = depth[i]! <= 0 ? 0 : 1 - strength * (1 - Math.sqrt(clamp(depth[i]! / level, 0, 1)));
	const key = simKey(p, ctx, 'waves', `${nx}x${ny}|${ground?.key ?? ''}`);
	const st = CACHE.run(
		key,
		stepsAt(t + preroll),
		() => ({ nx, ny, u: new Float64Array(nx * ny), v: new Float64Array(nx * ny) }),
		(w, step) => {
			const q = ctx.paramsAt?.(((step / SIM_SPS - preroll) * ctx.fps)) ?? p;
			const speed = Math.max(0, num(q.waveSpeed, 0.2));
			const damping = Math.max(0, num(q.damping, 0.05));
			const reflect = choice(q.reflectEdges, values(REFLECT));
			const cps = speed * (nx - 1);
			const sub = clamp(Math.ceil((cps * 2) / SIM_SPS), 1, 64);
			const dt = 1 / (SIM_SPS * sub);
			const prods = ([1, 2] as const).map((k) => {
				const pos = vec2(q[`producer${k}Position`], k === 1 ? [0.5, 0.5] : [0.25, 0.25]);
				const angle = (num(q[`producer${k}Angle`]) * Math.PI) / 180;
				return {
					ring: choice(q[`producer${k}Type`], ['ring', 'line']) === 0,
					pos: [pos[0], (pos[1] * lh) / lw],
					len: num(q[`producer${k}Length`], 0.1),
					width: num(q[`producer${k}Width`], 0.1),
					sa: Math.sin(angle),
					ca: Math.cos(angle),
					amp: num(q[`producer${k}Amplitude`], k === 1 ? 0.5 : 0),
					freq: num(q[`producer${k}Frequency`], 1),
					phase: (num(q[`producer${k}Phase`]) * Math.PI) / 180,
				};
			});
			const weight = (pr: (typeof prods)[number], x: number, y: number) => {
				const dx = x - pr.pos[0]!;
				const dy = y - pr.pos[1]!;
				const u = dx * pr.ca + dy * pr.sa;
				const v = -dx * pr.sa + dy * pr.ca;
				const a = Math.max(pr.len * 0.5, 1e-3);
				const b = Math.max(pr.width * 0.5, 1e-3);
				const d = pr.ring ? Math.hypot(u / a, v / b) : Math.max(Math.abs(u) / a, Math.abs(v) / b);
				return clamp(1 - d, 0, 1);
			};
			const c2 = cps * cps;
			const acc = new Float64Array(nx * ny);
			const sponge = Math.max(1, Math.min(4, Math.floor(nx / 4)));
			const refl = (side: number) => reflect === 5 || reflect === side;
			for (let k = 0; k < sub; k++) {
				const tt = (step + k / sub) / SIM_SPS - preroll;
				for (let y = 0; y < ny; y++)
					for (let x = 0; x < nx; x++) {
						const i = y * nx + x;
						const g = (xx: number, yy: number) => w.u[yy * nx + xx]!;
						const l =
							g(Math.max(0, x - 1), y) + g(Math.min(nx - 1, x + 1), y) + g(x, Math.max(0, y - 1)) + g(x, Math.min(ny - 1, y + 1)) - 4 * w.u[i]!;
						acc[i] = c2 * speedK[i]! * speedK[i]! * l - damping * 4 * w.v[i]!;
					}
				for (let i = 0; i < nx * ny; i++) {
					w.v[i] = w.v[i]! + acc[i]! * dt;
					w.u[i] = w.u[i]! + w.v[i]! * dt;
				}
				for (const pr of prods) {
					if (pr.amp === 0) continue;
					const target = pr.amp * Math.sin(2 * Math.PI * pr.freq * tt + pr.phase);
					for (let i = 0; i < nx * ny; i++) {
						const wt = weight(pr, (i % nx) * cell, Math.floor(i / nx) * cell);
						if (wt > 0) {
							w.u[i] = w.u[i]! + (target - w.u[i]!) * wt;
							w.v[i] = w.v[i]! * (1 - wt);
						}
					}
				}
				for (let i = 0; i < nx * ny; i++)
					if (speedK[i]! <= 0) {
						w.u[i] = 0;
						w.v[i] = 0;
					}
				for (let y = 0; y < ny; y++)
					for (let x = 0; x < nx; x++) {
						let f = 1;
						if (!refl(1) && x < sponge) f = Math.min(f, x / sponge);
						if (!refl(3) && nx - 1 - x < sponge) f = Math.min(f, (nx - 1 - x) / sponge);
						if (!refl(2) && y < sponge) f = Math.min(f, y / sponge);
						if (!refl(4) && ny - 1 - y < sponge) f = Math.min(f, (ny - 1 - y) / sponge);
						if (f < 1) {
							const i = y * nx + x;
							const kk = 0.85 + 0.15 * f;
							w.u[i] = w.u[i]! * kk;
							w.v[i] = w.v[i]! * kk;
						}
					}
			}
		},
		(w) => ({ nx: w.nx, ny: w.ny, u: w.u.slice(), v: w.v.slice() }),
	);
	return { st, depth };
}

export const WAVE_WORLD = defineShaderEffect({
	id: 'jasper.wave-world',
	label: 'Wave World',
	category: 'Simulation',
	description:
		'Simulates waves on a water surface from two producers, with damping, reflecting edges and a ground; renders a height map or a wireframe preview.',
	keywords: ['waves', 'water', 'ripples', 'height map', 'simulation', 'ocean'],
	params: [
		popup('view', 'View', VIEWS, 0),
		fxParam.angle('horizontalRotation', 'Horizontal Rotation', 0, { group: 'Wireframe Controls' }),
		n('verticalRotation', 'Vertical Rotation', 53, 0, 90, 0, 90, 0.1, { group: 'Wireframe Controls', unit: 'deg' }),
		n('verticalScale', 'Vertical Scale', 0.5, 0, 10, 0, 2, 0.001, { group: 'Wireframe Controls' }),
		n('brightness', 'Brightness', 0.5, -1, 2, 0, 1, 0.001, { group: 'Height Map Controls' }),
		n('contrast', 'Contrast', 0.75, 0, 4, 0, 2, 0.001, { group: 'Height Map Controls' }),
		n('gammaAdjustment', 'Gamma Adjustment', 1, 0.01, 10, 0.2, 5, 0.001, { group: 'Height Map Controls' }),
		popup('renderDryAreasAs', 'Render Dry Areas As', ['Solid', 'Transparent'], 0, 'Height Map Controls'),
		n('transparency', 'Transparency', 0, 0, 1, 0, 1, 0.001, { group: 'Height Map Controls' }),
		n('gridResolution', 'Grid Resolution', 60, 1, 400, 1, 200, 1, { group: 'Simulation' }),
		fxParam.toggle('gridResDownsamples', 'Grid Res Downsamples', false, { group: 'Simulation' }),
		n('waveSpeed', 'Wave Speed', 0.2, 0, 5, 0, 1, 0.001, { group: 'Simulation' }),
		n('damping', 'Damping', 0.05, 0, 5, 0, 1, 0.001, { group: 'Simulation' }),
		popup('reflectEdges', 'Reflect Edges', REFLECT, 0, 'Simulation'),
		n('preRoll', 'Pre-roll (seconds)', 0, 0, 30, 0, 10, 0.01, { group: 'Simulation', unit: 's' }),
		fxParam.media('ground', 'Ground', ['image'], { group: 'Ground' }),
		n('steepness', 'Steepness', 0.25, 0, 2, 0, 1, 0.001, { group: 'Ground' }),
		n('groundHeight', 'Height', 0.25, 0, 2, 0, 1, 0.001, { group: 'Ground' }),
		n('waveStrength', 'Wave Strength', 0, 0, 1, 0, 1, 0.001, { group: 'Ground' }),
		...producerParams(1, 0.5, [0.5, 0.5]),
		...producerParams(2, 0, [0.25, 0.25]),
	],
	expensive: true,
	gpu: {
		kind: 'generator',
		cpuPixels: ['ground'],
		uniforms: (p, ctx) => {
			const { st, depth } = simulateWaves(p, ctx);
			const grid = new Float32Array(st.nx * st.ny * 4);
			for (let i = 0; i < st.nx * st.ny; i++) {
				grid[i * 4] = st.u[i]!;
				grid[i * 4 + 1] = depth && depth[i]! <= 0 ? 1 : 0;
			}
			const hr = (num(p.horizontalRotation) * Math.PI) / 180;
			const vr = (num(p.verticalRotation, 53) * Math.PI) / 180;
			return {
				u_grid: { texels: grid },
				u_gn: { ivec2: [st.nx, st.ny] },
				u_edges: { int: (st.nx - 1) * st.ny + st.nx * (st.ny - 1) },
				u_rotH: [Math.sin(hr), Math.cos(hr)],
				u_rotV: [Math.sin(vr), Math.cos(vr)],
			};
		},
		passes: (p) =>
			choice(p.view, values(VIEWS)) === 1
				? [
						{
							include: [GLSL_DATA],
							frag: /* glsl */ `
void main() {
  vec2 L = u_box.zw / u_pxScale;
  vec2 lp = fx_layerPx();
  vec2 g = lp / max(L.x, 1.0) * float(u_gn.x - 1);
  float h = fx_texelGrid(u_grid, u_gn.x, u_gn.y, g - 0.0).x;
  float v = pow(clamp(u_brightness + u_contrast * h, 0.0, 1.0), 1.0 / max(u_gammaAdjustment, 0.01));
  float a = 1.0 - u_transparency;
  if (u_renderDryAreasAs == 1) {
    ivec2 gi = ivec2(clamp(floor(g + 0.5), vec2(0.0), vec2(u_gn - 1)));
    if (fx_texel(u_grid, gi.y * u_gn.x + gi.x).y > 0.5) a = 0.0;
  }
  fragColor = vec4(vec3(v) * a, a);
}`,
						},
					]
				: [
						{
							output: 'wire',
							include: [GLSL_SPRITES, GLSL_DATA],
							draw: {
								vertices: 6,
								instances: { uniform: 'u_edges' },
								vert: /* glsl */ `${SPRITE_VERT_DECLS}
vec2 ww_project(int x, int y) {
  vec2 L = u_box.zw / u_pxScale;
  float gx = float(x) / float(u_gn.x - 1) * L.x - L.x * 0.5;
  float gy = float(y) / float(u_gn.x - 1) * L.x - float(u_gn.y - 1) / float(u_gn.x - 1) * L.x * 0.5;
  float hgt = fx_texel(u_grid, y * u_gn.x + x).x * u_verticalScale * L.y * 0.5;
  float rx = gx * u_rotH.y - gy * u_rotH.x;
  float ry = gx * u_rotH.x + gy * u_rotH.y;
  return u_box.xy + vec2(L.x * 0.5 + rx, L.y * 0.5 + ry * u_rotV.y - hgt * u_rotV.x) * u_pxScale;
}
void main() {
  int e = gl_InstanceID;
  int nh = (u_gn.x - 1) * u_gn.y;
  int x0, y0, x1, y1;
  if (e < nh) { y0 = e / (u_gn.x - 1); x0 = e % (u_gn.x - 1); x1 = x0 + 1; y1 = y0; }
  else { int k = e - nh; y0 = k / u_gn.x; x0 = k % u_gn.x; x1 = x0; y1 = y0 + 1; }
  vec2 a = ww_project(x0, y0);
  vec2 b = ww_project(x1, y1);
  sp_emitSprite(gl_VertexID, a, 8, 0.4 * u_pxScale, 0.0, b - a, vec4(0.4, 0.9, 0.4, 1.0));
}`,
							},
							frag: SPRITE_FRAG_MAIN,
						},
						{
							frag: /* glsl */ `
void main() { vec4 w = texture(u_wire, v_uv); fragColor = w + vec4(0.0, 0.0, 0.0, 1.0) * (1.0 - w.a); }`,
						},
					],
	},
});

export const WAVE_WORLD_EFFECTS: readonly EffectSpec[] = [WAVE_WORLD];
