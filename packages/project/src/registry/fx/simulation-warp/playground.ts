// Simulation ▸ Particle Playground (sim-warp workstream; After Effects' Particle Playground): a deterministic 2D
// particle system stepped from clip time 0 at SIM_SPS. Producers: Cannon (a stream from a barrel), Grid (particles
// placed at time 0) and Layer Exploder (this layer or an image broken into particles at time 0). Forces: Gravity,
// Repel, Wall (a mask of the layer the particles bounce off), the Particle Exploder (bursts particles into smaller
// ones) and the Persistent / Ephemeral Property Mappers (an image's red, green, blue drive particle properties at the
// particle's position). Every producer, force and mapper has an Affects group (particles from which producer, a
// selection map, characters, age with feather). Cannon / Grid Text turn particles into characters; Layer Map draws
// particles as copies of a picture. Particles replace the layer's own pixels.
// Ported from EffectCraft crates/effects/src/sim3.rs (Pg, Mapper, Affects, playground_plan; MIT OR Apache-2.0), see
// licenses/ported/sim-warp.md.
import type { EffectParams, EffectSpec, ParamSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { GLSL_DATA } from '../glsl/data.ts';
import { fxParam } from '../params.ts';
import { GLSL_PSDG_FONT } from '../premiere-stylize-distort-generate/video-font.ts';
import type { FxFrameContext, FxLayerMask, FxPixels } from '../shader.ts';
import { n, popup, randomSeedParam, values } from './common.ts';
import {
	bool,
	choice,
	clamp,
	h01,
	num,
	paramsAtStep,
	rgba,
	SIM_SPS,
	SimCache,
	simKey,
	stepsOf,
	vec2,
} from './core.ts';
import { GLSL_SPRITES } from './sprites.ts';

export const MAP_TARGETS = [
	'None',
	'Red',
	'Green',
	'Blue',
	'Kinetic Friction',
	'Static Friction',
	'Angle',
	'Angular Velocity',
	'Torque',
	'Scale',
	'X Scale',
	'Y Scale',
	'X',
	'Y',
	'Gradient Velocity',
	'X Speed',
	'Y Speed',
	'Gradient Force',
	'X Force',
	'Y Force',
	'Opacity',
	'Mass',
	'Lifespan',
	'Character',
	'Font Size',
	'Time Offset',
	'Scale Speed',
] as const;
export const MAP_OPERATORS = ['Set', 'Add', 'Difference', 'Subtract', 'Multiply', 'Min', 'Max'] as const;
export const PARTICLES_FROM = [
	'All',
	'Cannon',
	'Grid',
	'Layer Exploder',
	'Particle Exploder',
	'Grid & Layer Exploder',
	'Cannon & Grid',
	'Cannon & Particle Exploder',
] as const;
const EXPLODE_SOURCES = ['None', 'This Layer', 'Image'] as const;
export const MASK_CHOICES = [
	'None',
	'Mask 1',
	'Mask 2',
	'Mask 3',
	'Mask 4',
	'Mask 5',
	'Mask 6',
	'Mask 7',
	'Mask 8',
] as const;

const SRC = { cannon: 0, grid: 1, layer: 2, particle: 3 } as const;
const MAX = 60000;

// Particle fields.
const F = {
	x: 0,
	y: 1,
	vx: 2,
	vy: 3,
	ox: 4,
	oy: 5,
	r: 6,
	g: 7,
	b: 8,
	a: 9,
	rad: 10,
	mass: 11,
	fric: 12,
	sfric: 13,
	fx: 14,
	fy: 15,
	angle: 16,
	angVel: 17,
	torque: 18,
	sx: 19,
	sy: 20,
	sspeed: 21,
	age: 22,
	life: 23,
	ch: 24,
	toff: 25,
	src: 26,
	id: 27,
} as const;
const S = 28;

type PgState = { d: Float64Array; n: number; carry: number; next: number; init: boolean };

// ---------------------------------------------------------------- params

function affects(group: string, key: string): ParamSpec[] {
	return [
		popup(`${key}ParticlesFrom`, 'Particles From', PARTICLES_FROM, 0, group),
		fxParam.media(`${key}SelectionMap`, 'Selection Map', ['image'], { group }),
		{ name: `${key}Characters`, label: 'Characters', type: 'string', default: '', animatable: false, group },
		n(`${key}OlderYoungerThan`, 'Older/Younger than', 0, -1000, 1000, -10, 10, 0.01, { group, unit: 's' }),
		n(`${key}AgeFeather`, 'Age Feather', 0, 0, 1000, 0, 10, 0.01, { group, unit: 's' }),
	];
}

function mapperParams(group: string, key: string, operators: boolean): ParamSpec[] {
	const out: ParamSpec[] = [fxParam.media(`${key}Map`, 'Use Layer As Map', ['image'], { group })];
	for (const c of ['Red', 'Green', 'Blue']) {
		out.push(popup(`${key}${c}To`, `Map ${c} To`, MAP_TARGETS, 0, group));
		if (operators) out.push(popup(`${key}${c}Operator`, 'Operator', MAP_OPERATORS, 0, group));
		out.push(n(`${key}${c}Min`, 'Min', 0, -10000, 10000, -100, 100, 0.01, { group }));
		out.push(n(`${key}${c}Max`, 'Max', 1, -10000, 10000, -100, 100, 0.01, { group }));
	}
	return [...out, ...affects(group, key)];
}

const AFFECT_KEYS = ['pex', 'layerMap', 'gravity', 'repel', 'wall', 'persistent', 'ephemeral'] as const;

// ---------------------------------------------------------------- maps and affects

/** Straight RGBA 0..1 of a map at layer px (stretched over the layer), bilinear, clamped. */
function mapAt(px: FxPixels, x: number, y: number, lw: number, lh: number): [number, number, number, number] {
	const fx = clamp((x / lw) * px.width - 0.5, 0, px.width - 1);
	const fy = clamp((y / lh) * px.height - 0.5, 0, px.height - 1);
	const x0 = Math.floor(fx);
	const y0 = Math.floor(fy);
	const x1 = Math.min(px.width - 1, x0 + 1);
	const y1 = Math.min(px.height - 1, y0 + 1);
	const tx = fx - x0;
	const ty = fy - y0;
	const out: [number, number, number, number] = [0, 0, 0, 0];
	for (let k = 0; k < 4; k++) {
		const at = (xx: number, yy: number) => px.data[(yy * px.width + xx) * 4 + k]! / 255;
		const a = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * tx;
		const b = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * tx;
		out[k] = a + (b - a) * ty;
	}
	return out;
}

type Affects = { from: number; sel: FxPixels | null; chars: string; age: number; feather: number };
function affectsOf(q: EffectParams, key: string, ctx: FxFrameContext): Affects {
	return {
		from: choice(q[`${key}ParticlesFrom`], values(PARTICLES_FROM)),
		sel: ctx.pixels?.(`${key}SelectionMap`) ?? null,
		chars: typeof q[`${key}Characters`] === 'string' ? (q[`${key}Characters`] as string) : '',
		age: num(q[`${key}OlderYoungerThan`]),
		feather: Math.max(0, num(q[`${key}AgeFeather`])),
	};
}
function weight(a: Affects, d: Float64Array, o: number, lw: number, lh: number): number {
	const src = d[o + F.src]!;
	const ok = [
		true,
		src === SRC.cannon,
		src === SRC.grid,
		src === SRC.layer,
		src === SRC.particle,
		src === SRC.grid || src === SRC.layer,
		src === SRC.cannon || src === SRC.grid,
		src === SRC.cannon || src === SRC.particle,
	][a.from]!;
	if (!ok) return 0;
	if (a.chars) {
		const ch = d[o + F.ch]!;
		if (!ch || !a.chars.includes(String.fromCodePoint(ch))) return 0;
	}
	let w = 1;
	if (a.age !== 0) {
		const age = d[o + F.age]!;
		const dd = a.age > 0 ? age - a.age : -a.age - age;
		w *= a.feather > 0 ? clamp(dd / a.feather + 0.5, 0, 1) : dd >= 0 ? 1 : 0;
	}
	if (a.sel) {
		const c = mapAt(a.sel, d[o + F.x]!, d[o + F.y]!, lw, lh);
		w *= clamp(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2], 0, 1) * c[3];
	}
	return w;
}

function propGet(d: Float64Array, o: number, t: number): number {
	switch (t) {
		case 1:
			return d[o + F.r]!;
		case 2:
			return d[o + F.g]!;
		case 3:
			return d[o + F.b]!;
		case 4:
			return d[o + F.fric]!;
		case 5:
			return d[o + F.sfric]!;
		case 6:
			return d[o + F.angle]!;
		case 7:
			return d[o + F.angVel]!;
		case 8:
			return d[o + F.torque]!;
		case 9:
			return (d[o + F.sx]! + d[o + F.sy]!) * 0.5;
		case 10:
			return d[o + F.sx]!;
		case 11:
			return d[o + F.sy]!;
		case 12:
			return d[o + F.x]!;
		case 13:
			return d[o + F.y]!;
		case 15:
			return d[o + F.vx]!;
		case 16:
			return d[o + F.vy]!;
		case 18:
			return d[o + F.fx]!;
		case 19:
			return d[o + F.fy]!;
		case 20:
			return d[o + F.a]!;
		case 21:
			return d[o + F.mass]!;
		case 22:
			return d[o + F.life]!;
		case 23:
			return d[o + F.ch]!;
		case 24:
			return d[o + F.rad]!;
		case 25:
			return d[o + F.toff]!;
		case 26:
			return d[o + F.sspeed]!;
		default:
			return 0;
	}
}
function propSet(d: Float64Array, o: number, t: number, v: number): void {
	switch (t) {
		case 1:
			d[o + F.r] = v;
			break;
		case 2:
			d[o + F.g] = v;
			break;
		case 3:
			d[o + F.b] = v;
			break;
		case 4:
			d[o + F.fric] = clamp(v, 0, 10);
			break;
		case 5:
			d[o + F.sfric] = Math.max(0, v);
			break;
		case 6:
			d[o + F.angle] = v;
			break;
		case 7:
			d[o + F.angVel] = v;
			break;
		case 8:
			d[o + F.torque] = v;
			break;
		case 9:
			d[o + F.sx] = d[o + F.sy] = Math.max(0, v);
			break;
		case 10:
			d[o + F.sx] = Math.max(0, v);
			break;
		case 11:
			d[o + F.sy] = Math.max(0, v);
			break;
		case 12:
			d[o + F.x] = v;
			break;
		case 13:
			d[o + F.y] = v;
			break;
		case 15:
			d[o + F.vx] = v;
			break;
		case 16:
			d[o + F.vy] = v;
			break;
		case 18:
			d[o + F.fx] = v;
			break;
		case 19:
			d[o + F.fy] = v;
			break;
		case 20:
			d[o + F.a] = clamp(v, 0, 1);
			break;
		case 21:
			d[o + F.mass] = Math.max(0.01, v);
			break;
		case 22:
			d[o + F.life] = Math.max(0, v);
			break;
		case 23:
			d[o + F.ch] = clamp(Math.round(v), 0, 0x10ffff);
			break;
		case 24:
			d[o + F.rad] = Math.max(0, v);
			break;
		case 25:
			d[o + F.toff] = v;
			break;
		case 26:
			d[o + F.sspeed] = v;
			break;
		default:
			break;
	}
}

type Mapper = { map: FxPixels; chans: [number, number, number, number][]; aff: Affects };
function mapperOf(q: EffectParams, key: string, ctx: FxFrameContext, ops: boolean): Mapper | null {
	const map = ctx.pixels?.(`${key}Map`) ?? null;
	if (!map) return null;
	const chans = (['Red', 'Green', 'Blue'] as const).map(
		(c) =>
			[
				choice(q[`${key}${c}To`], values(MAP_TARGETS)),
				ops ? choice(q[`${key}${c}Operator`], values(MAP_OPERATORS)) : 0,
				num(q[`${key}${c}Min`]),
				num(q[`${key}${c}Max`], 1),
			] as [number, number, number, number],
	);
	if (chans.every((c) => c[0] === 0)) return null;
	return { map, chans, aff: affectsOf(q, key, ctx) };
}
function applyMapper(m: Mapper, d: Float64Array, o: number, lw: number, lh: number): void {
	const w = weight(m.aff, d, o, lw, lh);
	if (w <= 0) return;
	const x = d[o + F.x]!;
	const y = d[o + F.y]!;
	const px = mapAt(m.map, x, y, lw, lh);
	m.chans.forEach(([target, op, lo, hi], ch) => {
		if (target === 0) return;
		const v = lo + (hi - lo) * px[ch]!;
		if (target === 14 || target === 17) {
			const gx = mapAt(m.map, x + 1, y, lw, lh)[ch]! - mapAt(m.map, x - 1, y, lw, lh)[ch]!;
			const gy = mapAt(m.map, x, y + 1, lw, lh)[ch]! - mapAt(m.map, x, y - 1, lw, lh)[ch]!;
			const k = 0.5 * (hi - lo) * w;
			if (target === 14) {
				d[o + F.vx] = d[o + F.vx]! + gx * k;
				d[o + F.vy] = d[o + F.vy]! + gy * k;
			} else {
				d[o + F.fx] = d[o + F.fx]! + gx * k;
				d[o + F.fy] = d[o + F.fy]! + gy * k;
			}
			return;
		}
		const cur = propGet(d, o, target);
		const nv = [v, cur + v, Math.abs(cur - v), cur - v, cur * v, Math.min(cur, v), Math.max(cur, v)][op]!;
		propSet(d, o, target, w >= 1 || !Number.isFinite(cur) ? nv : cur + (nv - cur) * w);
	});
}

function pointInPoly(pts: readonly [number, number][], x: number, y: number): boolean {
	let c = false;
	for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
		const [ax, ay] = pts[i]!;
		const [bx, by] = pts[j]!;
		if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) c = !c;
	}
	return c;
}

/** The mask chosen by a "Mask n" popup (null for None or a missing mask). */
export function maskOf(v: unknown, masks: readonly FxLayerMask[] | undefined): FxLayerMask | null {
	const i = choice(v, values(MASK_CHOICES));
	return i > 0 ? (masks?.[i - 1] ?? null) : null;
}

// ---------------------------------------------------------------- simulation

function grow(st: PgState): void {
	if ((st.n + 1) * S <= st.d.length) return;
	const d = new Float64Array(Math.max(st.d.length * 2, S * 256));
	d.set(st.d);
	st.d = d;
}

function add(
	st: PgState,
	x: number,
	y: number,
	vx: number,
	vy: number,
	c: readonly number[],
	r: number,
	src: number,
): number {
	grow(st);
	const o = st.n * S;
	const d = st.d;
	d.fill(0, o, o + S);
	d[o + F.x] = x;
	d[o + F.y] = y;
	d[o + F.vx] = vx;
	d[o + F.vy] = vy;
	d[o + F.ox] = x;
	d[o + F.oy] = y;
	d[o + F.r] = c[0]!;
	d[o + F.g] = c[1]!;
	d[o + F.b] = c[2]!;
	d[o + F.a] = c[3]!;
	d[o + F.rad] = r;
	d[o + F.mass] = 1;
	d[o + F.sx] = 1;
	d[o + F.sy] = 1;
	d[o + F.life] = Number.POSITIVE_INFINITY;
	d[o + F.src] = src;
	d[o + F.id] = st.next++;
	st.n++;
	return o;
}

/** Initial particles: Grid and Layer Exploder (at time 0). */
function initPg(p: EffectParams, ctx: FxFrameContext, seed: number): PgState {
	const st: PgState = { d: new Float64Array(S * 256), n: 0, carry: 0, next: 0, init: true };
	const lw = ctx.width;
	const lh = ctx.height;
	const across = Math.max(0, Math.round(num(p.gridParticlesAcross)));
	const down = Math.max(0, Math.round(num(p.gridParticlesDown)));
	const gpos = vec2(p.gridPosition, [0.5, 0.5]);
	const gw = num(p.gridWidth, 100);
	const gh = num(p.gridHeight, 100);
	const gcol = rgba(p.gridColor, [1, 1, 1, 1]);
	const grad = Math.max(0, num(p.gridParticleRadius, 2));
	const text = [...(typeof p.gridText === 'string' ? p.gridText : '')];
	let k = 0;
	for (let j = 0; j < down; j++)
		for (let i = 0; i < across; i++) {
			let ch = 0;
			if (text.length) {
				const c = text[k % text.length]!;
				k++;
				if (c === ' ') continue;
				ch = c.codePointAt(0)!;
			}
			if (st.n >= MAX) break;
			const fx = across > 1 ? i / (across - 1) - 0.5 : 0;
			const fy = down > 1 ? j / (down - 1) - 0.5 : 0;
			const o = add(st, gpos[0] * lw + fx * gw, gpos[1] * lh + fy * gh, 0, 0, gcol, grad, SRC.grid);
			st.d[o + F.ch] = ch;
		}
	const ex = choice(p.explodeSource, values(EXPLODE_SOURCES));
	if (ex > 0) {
		const img = ex === 2 ? (ctx.pixels?.('explodeImage') ?? null) : null;
		const r = Math.max(0.5, num(p.explodeRadius, 2));
		const disp = num(p.explodeDispersion, 20);
		const step = Math.max(1, r * 2);
		for (let y = step / 2; y < lh && st.n < MAX; y += step)
			for (let x = step / 2; x < lw && st.n < MAX; x += step) {
				// This Layer: every grid point (colour and visibility read from the layer when drawn); an image: its
				// opaque points with their colours.
				const c = img ? mapAt(img, x, y, lw, lh) : [1, 1, 1, 1];
				if (img && c[3]! <= 0.05) continue;
				const id = st.next;
				const dx = x - lw / 2;
				const dy = y - lh / 2;
				const l = Math.max(1, Math.hypot(dx, dy));
				add(
					st,
					x,
					y,
					(dx / l) * disp + (h01(id, 1, seed) * 2 - 1) * disp,
					(dy / l) * disp + (h01(id, 2, seed) * 2 - 1) * disp,
					c,
					r,
					SRC.layer,
				);
			}
	}
	return st;
}

function stepPg(st: PgState, q: EffectParams, ctx: FxFrameContext, seed: number): void {
	const dt = 1 / SIM_SPS;
	const lw = ctx.width;
	const lh = ctx.height;
	const d = st.d;
	const persistent = mapperOf(q, 'persistent', ctx, false);
	const ephemeral = mapperOf(q, 'ephemeral', ctx, true);
	if (persistent) for (let i = 0; i < st.n; i++) applyMapper(persistent, d, i * S, lw, lh);
	// The ephemeral mapper's values hold for this step only.
	const eph = st.d.slice(0, st.n * S);
	if (ephemeral) for (let i = 0; i < st.n; i++) applyMapper(ephemeral, eph, i * S, lw, lh);
	const gravDir = (num(q.gravityDirection, 180) * Math.PI) / 180;
	const gf = num(q.gravityForce, 108);
	const gravity = [Math.sin(gravDir) * gf, -Math.cos(gravDir) * gf];
	const gspread = Math.max(0, num(q.gravityForceRandomSpread) / 100);
	const gravAff = affectsOf(q, 'gravity', ctx);
	const repel = num(q.repelForce) * 100;
	const repelR = Math.max(0, num(q.repelForceRadius));
	const repelAff = affectsOf(q, 'repel', ctx);
	const wall = maskOf(q.wallBoundary, ctx.structures?.masks);
	const wallAff = affectsOf(q, 'wall', ctx);
	const push = new Float64Array(st.n * 2);
	if (repel !== 0 && repelR > 0 && st.n > 1) {
		const grid = new Map<string, number[]>();
		for (let i = 0; i < st.n; i++) {
			const key = `${Math.floor(eph[i * S + F.x]! / repelR)},${Math.floor(eph[i * S + F.y]! / repelR)}`;
			const l = grid.get(key);
			if (l) l.push(i);
			else grid.set(key, [i]);
		}
		for (let i = 0; i < st.n; i++) {
			const o = i * S;
			const w = weight(repelAff, eph, o, lw, lh);
			if (w <= 0) continue;
			const cx = Math.floor(eph[o + F.x]! / repelR);
			const cy = Math.floor(eph[o + F.y]! / repelR);
			for (let gy = cy - 1; gy <= cy + 1; gy++)
				for (let gx = cx - 1; gx <= cx + 1; gx++)
					for (const j of grid.get(`${gx},${gy}`) ?? []) {
						if (j === i) continue;
						const dx = eph[o + F.x]! - eph[j * S + F.x]!;
						const dy = eph[o + F.y]! - eph[j * S + F.y]!;
						const dist = Math.hypot(dx, dy);
						if (dist < repelR && dist > 1e-4) {
							const k = (w * repel * (1 - dist / repelR)) / dist;
							push[i * 2] = push[i * 2]! + dx * k;
							push[i * 2 + 1] = push[i * 2 + 1]! + dy * k;
						}
					}
		}
	}
	for (let i = 0; i < st.n; i++) {
		const o = i * S;
		const gw = weight(gravAff, eph, o, lw, lh);
		const g = gspread > 0 ? 1 + (h01(d[o + F.id]!, 7, seed) * 2 - 1) * gspread : 1;
		const mass = eph[o + F.mass]!;
		let ax = gravity[0]! * g * gw + (eph[o + F.fx]! + push[i * 2]!) / mass;
		let ay = gravity[1]! * g * gw + (eph[o + F.fy]! + push[i * 2 + 1]!) / mass;
		const resting = Math.abs(eph[o + F.vx]!) < 1e-3 && Math.abs(eph[o + F.vy]!) < 1e-3;
		if (resting && Math.hypot(ax, ay) <= eph[o + F.sfric]!) {
			ax = 0;
			ay = 0;
		}
		const damp = Math.max(0, 1 - eph[o + F.fric]! * 0.1);
		const nvx = (eph[o + F.vx]! + ax * dt) * damp;
		const nvy = (eph[o + F.vy]! + ay * dt) * damp;
		d[o + F.vx] = nvx - (eph[o + F.vx]! - d[o + F.vx]!);
		d[o + F.vy] = nvy - (eph[o + F.vy]! - d[o + F.vy]!);
		d[o + F.angVel] = d[o + F.angVel]! + eph[o + F.torque]! * dt;
		d[o + F.angle] = d[o + F.angle]! + eph[o + F.angVel]! * dt;
		d[o + F.sx] = Math.max(0, d[o + F.sx]! + eph[o + F.sspeed]! * dt);
		d[o + F.sy] = Math.max(0, d[o + F.sy]! + eph[o + F.sspeed]! * dt);
		d[o + F.age] = d[o + F.age]! + dt;
		const nx = d[o + F.x]! + nvx * dt;
		const ny = d[o + F.y]! + nvy * dt;
		if (wall && weight(wallAff, eph, o, lw, lh) > 0.5) {
			const was = pointInPoly(wall.points, d[o + F.x]!, d[o + F.y]!);
			const now = pointInPoly(wall.points, nx, ny);
			if (was !== now) {
				// Bounce: reverse the velocity and stay on the same side.
				d[o + F.vx] = -d[o + F.vx]! * 0.9;
				d[o + F.vy] = -d[o + F.vy]! * 0.9;
				continue;
			}
		}
		d[o + F.x] = nx;
		d[o + F.y] = ny;
	}
	// Leave the universe (3 × the layer) or die at the lifespan (ephemeral lifespans count).
	let w = 0;
	for (let i = 0; i < st.n; i++) {
		const o = i * S;
		const x = d[o + F.x]!;
		const y = d[o + F.y]!;
		const alive = x > -lw * 2 && x < lw * 3 && y > -lh * 2 && y < lh * 3 && d[o + F.age]! <= eph[o + F.life]!;
		if (!alive) continue;
		if (w !== i) d.copyWithin(w * S, o, o + S);
		w++;
	}
	st.n = w;
	// Particle Exploder.
	const pexR = Math.max(0, num(q.pexRadius));
	if (pexR > 0) {
		const pexDisp = num(q.pexDispersion, 20);
		const pexAff = affectsOf(q, 'pex', ctx);
		const old = st.d.slice(0, st.n * S);
		const count = st.n;
		st.n = 0;
		for (let i = 0; i < count; i++) {
			const o = i * S;
			const r = old[o + F.rad]!;
			if (
				old[o + F.src] === SRC.particle ||
				old[o + F.ch]! !== 0 ||
				r <= pexR * 1.01 ||
				weight(pexAff, old, o, lw, lh) <= 0.5 ||
				st.n > MAX
			) {
				grow(st);
				st.d.set(old.subarray(o, o + S), st.n * S);
				st.n++;
				continue;
			}
			const pieces = clamp(Math.round((r / pexR) ** 2), 2, 16);
			for (let k = 0; k < pieces; k++) {
				const id = st.next++;
				const a = ((k + h01(id, 31, seed)) / pieces) * Math.PI * 2;
				const sp = pexDisp * (0.5 + h01(id, 32, seed));
				grow(st);
				const q2 = st.n * S;
				st.d.set(old.subarray(o, o + S), q2);
				st.d[q2 + F.x] = old[o + F.x]! + Math.cos(a) * (r - pexR);
				st.d[q2 + F.y] = old[o + F.y]! + Math.sin(a) * (r - pexR);
				st.d[q2 + F.vx] = old[o + F.vx]! + Math.cos(a) * sp;
				st.d[q2 + F.vy] = old[o + F.vy]! + Math.sin(a) * sp;
				st.d[q2 + F.rad] = pexR;
				st.d[q2 + F.src] = SRC.particle;
				st.d[q2 + F.id] = id;
				st.n++;
			}
		}
	}
	// Cannon.
	const rate = Math.max(0, num(q.cannonParticlesPerSecond, 60));
	if (rate > 0) {
		st.carry += rate / SIM_SPS;
		const born = Math.floor(st.carry);
		st.carry -= born;
		const pos = vec2(q.cannonPosition, [0.5, 0.9]);
		const barrel = num(q.cannonBarrelRadius);
		const dir = num(q.cannonDirection);
		const dspread = num(q.cannonDirectionRandomSpread, 20);
		const vel = num(q.cannonVelocity, 130);
		const vspread = num(q.cannonVelocityRandomSpread, 20);
		const col = rgba(q.cannonColor, [1, 0, 0, 1]);
		const rad = Math.max(0, num(q.cannonParticleRadius, 2));
		const text = [...(typeof q.cannonText === 'string' ? q.cannonText : '')];
		for (let k = 0; k < born && st.n < MAX; k++) {
			const id = st.next;
			const hh = (j: number) => h01(id, j, seed) * 2 - 1;
			// After Effects angles: 0° = up, clockwise.
			const a = ((dir + hh(1) * dspread * 0.5) * Math.PI) / 180;
			const speed = Math.max(0, vel + hh(3) * vspread);
			const off =
				barrel >= 0
					? [hh(2) * barrel, hh(4) * barrel]
					: (() => {
							const aa = h01(id, 5, seed) * Math.PI * 2;
							const rr = Math.sqrt(h01(id, 6, seed)) * -barrel;
							return [Math.cos(aa) * rr, Math.sin(aa) * rr];
						})();
			const vx = Math.sin(a) * speed;
			const vy = -Math.cos(a) * speed;
			const frac = h01(id, 9, seed) * dt;
			const o = add(
				st,
				pos[0] * lw + off[0]! + vx * frac,
				pos[1] * lh + off[1]! + vy * frac,
				vx,
				vy,
				col,
				rad,
				SRC.cannon,
			);
			if (text.length) st.d[o + F.ch] = text[id % text.length]!.codePointAt(0)!;
		}
	}
}

const CACHE = new SimCache<PgState>(6);
const PIXEL_PARAMS = [
	'explodeImage',
	'persistentMap',
	'ephemeralMap',
	...AFFECT_KEYS.map((k) => `${k}SelectionMap`),
];

function simulatePg(p: EffectParams, ctx: FxFrameContext): { st: PgState; eph: Float64Array } {
	const seed = Math.floor(ctx.seed * 4294967296) ^ 0x7067;
	const extra = [
		...PIXEL_PARAMS.map((k) => ctx.pixels?.(k)?.key ?? ''),
		JSON.stringify(ctx.structures?.masks ?? null),
	].join('|');
	const st = CACHE.run(
		simKey(p, ctx, 'pg', extra),
		stepsOf(ctx),
		() => initPg(p, ctx, seed),
		(s, i) => stepPg(s, paramsAtStep(p, ctx, i), ctx, seed),
		(s) => ({ d: s.d.slice(0, Math.max(1, s.n) * S), n: s.n, carry: s.carry, next: s.next, init: s.init }),
	);
	// What the ephemeral mapper changes shows for this frame only.
	const eph = st.d.slice(0, st.n * S);
	const m = mapperOf(p, 'ephemeral', ctx, true);
	if (m) for (let i = 0; i < st.n; i++) applyMapper(m, eph, i * S, ctx.width, ctx.height);
	return { st, eph };
}

export const PARTICLE_PLAYGROUND = defineShaderEffect({
	id: 'jasper.particle-playground',
	label: 'Particle Playground',
	category: 'Simulation',
	description:
		'A 2D particle system: a cannon, a grid or an exploded layer make particles (dots, characters or copies of a picture) moved by gravity, repel, walls and property maps.',
	keywords: ['particles', 'cannon', 'explode', 'text particles', 'physics'],
	params: [
		fxParam.point('cannonPosition', 'Position', [0.5, 0.9], { group: 'Cannon' }),
		n('cannonBarrelRadius', 'Barrel Radius', 0, -1000, 1000, -100, 100, 0.1, { group: 'Cannon', unit: 'px' }),
		n('cannonParticlesPerSecond', 'Particles Per Second', 60, 0, 5000, 0, 500, 0.1, { group: 'Cannon' }),
		fxParam.angle('cannonDirection', 'Direction', 0, { group: 'Cannon' }),
		n('cannonDirectionRandomSpread', 'Direction Random Spread', 20, 0, 3600, 0, 360, 0.1, {
			group: 'Cannon',
			unit: 'deg',
		}),
		n('cannonVelocity', 'Velocity', 130, -10000, 10000, 0, 1000, 0.1, { group: 'Cannon' }),
		n('cannonVelocityRandomSpread', 'Velocity Random Spread', 20, 0, 5000, 0, 500, 0.1, { group: 'Cannon' }),
		fxParam.color('cannonColor', 'Color', [1, 0, 0, 1], { group: 'Cannon' }),
		n('cannonParticleRadius', 'Particle Radius', 2, 0, 500, 0, 50, 0.1, { group: 'Cannon', unit: 'px' }),
		fxParam.point('gridPosition', 'Position', [0.5, 0.5], { group: 'Grid' }),
		n('gridWidth', 'Width', 100, 0, 20000, 0, 2000, 0.1, { group: 'Grid', unit: 'px' }),
		n('gridHeight', 'Height', 100, 0, 20000, 0, 2000, 0.1, { group: 'Grid', unit: 'px' }),
		n('gridParticlesAcross', 'Particles Across', 0, 0, 1000, 0, 100, 1, { group: 'Grid' }),
		n('gridParticlesDown', 'Particles Down', 0, 0, 1000, 0, 100, 1, { group: 'Grid' }),
		fxParam.color('gridColor', 'Color', [1, 1, 1, 1], { group: 'Grid' }),
		n('gridParticleRadius', 'Particle Radius', 2, 0, 500, 0, 50, 0.1, { group: 'Grid', unit: 'px' }),
		popup('explodeSource', 'Explode Layer', EXPLODE_SOURCES, 0, 'Layer Exploder'),
		fxParam.media('explodeImage', 'Explode Image', ['image'], { group: 'Layer Exploder' }),
		n('explodeRadius', 'Radius of New Particles', 2, 0.5, 500, 0.5, 50, 0.1, {
			group: 'Layer Exploder',
			unit: 'px',
		}),
		n('explodeDispersion', 'Velocity Dispersion', 20, 0, 5000, 0, 500, 0.1, { group: 'Layer Exploder' }),
		n('pexRadius', 'Radius of New Particles', 0, 0, 500, 0, 50, 0.1, {
			group: 'Particle Exploder',
			unit: 'px',
		}),
		n('pexDispersion', 'Velocity Dispersion', 20, 0, 5000, 0, 500, 0.1, { group: 'Particle Exploder' }),
		...affects('Particle Exploder', 'pex'),
		fxParam.media('layerMapLayer', 'Use Layer', ['image', 'video'], { group: 'Layer Map' }),
		...affects('Layer Map', 'layerMap'),
		n('gravityForce', 'Force', 108, -10000, 10000, 0, 1000, 0.1, { group: 'Gravity' }),
		n('gravityForceRandomSpread', 'Force Random Spread', 0, 0, 1000, 0, 100, 0.1, { group: 'Gravity' }),
		fxParam.angle('gravityDirection', 'Direction', 180, { group: 'Gravity' }),
		...affects('Gravity', 'gravity'),
		n('repelForce', 'Force', 0, -100, 100, -10, 10, 0.01, { group: 'Repel' }),
		n('repelForceRadius', 'Force Radius', 0, 0, 1000, 0, 100, 0.1, { group: 'Repel', unit: 'px' }),
		...affects('Repel', 'repel'),
		popup('wallBoundary', 'Boundary', MASK_CHOICES, 0, 'Wall'),
		...affects('Wall', 'wall'),
		...mapperParams('Persistent Property Mapper', 'persistent', false),
		...mapperParams('Ephemeral Property Mapper', 'ephemeral', true),
		{
			name: 'cannonText',
			label: 'Cannon Text',
			type: 'string',
			default: '',
			animatable: false,
			group: 'Options',
		},
		{
			name: 'gridText',
			label: 'Grid Text',
			type: 'string',
			default: '',
			animatable: false,
			group: 'Options',
		},
		fxParam.toggle('autoOrientRotation', 'Auto-Orient Rotation', false, { group: 'Options' }),
		randomSeedParam(),
	],
	expensive: true,
	gpu: {
		kind: 'generator',
		cpuPixels: PIXEL_PARAMS,
		uniforms: (p, ctx) => {
			const { st, eph } = simulatePg(p, ctx);
			const lw = ctx.width;
			const lh = ctx.height;
			const s = ctx.pxScale;
			const auto = bool(p.autoOrientRotation);
			const mapAff = affectsOf(p, 'layerMap', ctx);
			const hasMap = !!(p.layerMapLayer as { mediaId?: string } | undefined)?.mediaId;
			const thisLayer = choice(p.explodeSource, values(EXPLODE_SOURCES)) === 1;
			const out = new Float32Array(Math.max(1, st.n) * 16);
			for (let i = 0; i < st.n; i++) {
				const o = i * S;
				const vx = eph[o + F.vx]!;
				const vy = eph[o + F.vy]!;
				const angle =
					auto && (vx !== 0 || vy !== 0)
						? Math.atan2(vy, vx) + Math.PI / 2
						: (eph[o + F.angle]! * Math.PI) / 180;
				const sxy = [eph[o + F.sx]!, eph[o + F.sy]!];
				const kind = hasMap && weight(mapAff, eph, o, lw, lh) > 0.5 ? 2 : eph[o + F.ch]! > 0 ? 1 : 0;
				const r = i * 16;
				out[r] = eph[o + F.x]! * s;
				out[r + 1] = eph[o + F.y]! * s;
				out[r + 2] = eph[o + F.rad]! * s;
				out[r + 3] = angle;
				out[r + 4] = eph[o + F.r]!;
				out[r + 5] = eph[o + F.g]!;
				out[r + 6] = eph[o + F.b]!;
				out[r + 7] = eph[o + F.a]!;
				out[r + 8] = kind;
				out[r + 9] = eph[o + F.ch]!;
				out[r + 10] = sxy[0]!;
				out[r + 11] = sxy[1]!;
				// This Layer exploder: colour from the layer at the particle's origin (canvas px), when drawn.
				out[r + 12] = thisLayer && eph[o + F.src] === SRC.layer ? eph[o + F.ox]! * s : -1;
				out[r + 13] = eph[o + F.oy]! * s;
			}
			return { u_pg: { texels: out }, u_count: { int: st.n } };
		},
		passes: [
			{
				output: 'parts',
				include: [GLSL_SPRITES, GLSL_DATA, GLSL_PSDG_FONT],
				draw: {
					vertices: 6,
					instances: { uniform: 'u_count' },
					vert: /* glsl */ `
out vec2 v_q;
flat out vec4 v_p;    // centre, radius (font size), angle
flat out vec4 v_col;
flat out vec4 v_k;    // kind, char, scale x, scale y
void main() {
  int i = gl_InstanceID;
  vec4 t0 = fx_texel(u_pg, i * 4);
  vec4 c = fx_texel(u_pg, i * 4 + 1);
  vec4 t2 = fx_texel(u_pg, i * 4 + 2);
  vec4 t3 = fx_texel(u_pg, i * 4 + 3);
  if (t3.x >= 0.0) {
    vec4 s = textureLod(u_source, (u_box.xy + t3.xy) / u_canvasSize, 0.0);
    c = s.a > 0.0 ? vec4(s.rgb / s.a, s.a * c.a) : vec4(0.0);
  }
  vec2 p = u_box.xy + t0.xy;
  int kind = int(t2.x + 0.5);
  vec2 sc = t2.zw;
  float ext;
  if (kind == 2) ext = length(u_layerMapLayer_size * sc) * 0.5 * u_pxScale + 1.5;
  else if (kind == 1) ext = t0.z * max(sc.x, sc.y) * 0.8 + 1.5;
  else ext = t0.z * (sc.x + sc.y) * 0.5 + 1.5;
  if (c.a <= 1e-5 || ext <= 1.5) { fx_cull(); v_q = vec2(0.0); v_p = vec4(0.0); v_col = vec4(0.0); v_k = vec4(0.0); return; }
  vec2 q = p + sp_corner(gl_VertexID) * ext;
  v_q = q; v_p = vec4(p, t0.z, t0.w); v_col = c; v_k = t2;
  fx_emit(q);
}`,
				},
				frag: /* glsl */ `
in vec2 v_q;
flat in vec4 v_p;
flat in vec4 v_col;
flat in vec4 v_k;
void main() {
  vec2 d = v_q - v_p.xy;
  int kind = int(v_k.x + 0.5);
  float sa = sin(v_p.w), ca = cos(v_p.w);
  vec2 u = vec2(d.x * ca + d.y * sa, -d.x * sa + d.y * ca);
  if (kind == 0) {
    float r = v_p.z * (v_k.z + v_k.w) * 0.5;
    fragColor = sp_shade(1, d, r, 0.0, vec2(0.0), v_col);
    return;
  }
  if (kind == 2) {
    // A copy of the Layer Map picture, rotated and scaled.
    vec2 size = u_layerMapLayer_size * v_k.zw * u_pxScale;
    vec2 uv = u / max(size, vec2(1e-3)) + 0.5;
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) { fragColor = vec4(0.0); return; }
    fragColor = texture(u_layerMapLayer, uv) * v_col.a;
    return;
  }
  // A character of Font Size (radius) height: 4× supersampled bitmap glyph.
  float h = max(v_p.z, 1.0);
  vec2 cell = vec2(12.0, 20.0);
  int code = int(v_k.y + 0.5);
  if (code < 32 || code > 126) code = 63;
  float cov = 0.0;
  for (int k = 0; k < 4; k++) {
    vec2 o = vec2(float(k & 1), float(k >> 1)) * 0.5 - 0.25;
    vec2 g = ((u + o) / vec2(v_k.z, v_k.w)) / h * cell.y + cell * 0.5;
    if (g.x >= 0.0 && g.y >= 0.0 && g.x < cell.x && g.y < cell.y) cov += float(psdg_glyphBit(code, int(g.x), int(g.y)));
  }
  float a = cov * 0.25 * v_col.a;
  fragColor = vec4(v_col.rgb * a, a);
}`,
			},
			{
				frag: /* glsl */ `
void main() { fragColor = texture(u_parts, v_uv); }`,
			},
		],
	},
});

export const PLAYGROUND_EFFECTS: readonly EffectSpec[] = [PARTICLE_PLAYGROUND];
