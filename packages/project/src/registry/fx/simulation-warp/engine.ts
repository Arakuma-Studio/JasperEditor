// The stepped particle engine of Particle World, Particle Systems II and Mercury. Particles are
// born from a producer ellipsoid at Birth Rate, move under the Animation's force field, gravity, resistance and the
// floor, and die at their (randomised) Longevity. The engine steps at SIM_SPS from clip time 0 with the params AT
// EACH STEP (keyframed birth rates, moving producers — whose motion the particles inherit by Inherit Velocity %), so
// it is a pure function of the document and the frame (`SimCache` checkpoints: seeking equals playing).
// Ported from EffectCraft crates/effects/src/sim.rs (Phys::spawn/step, MIT OR Apache-2.0) and extended (per-step
// params, inherit velocity, floor actions, Twirl, cone spread, origin colours); see licenses/ported/sim-warp.md.
import { clamp, h01, hs, SIM_SPS, valueNoise3 } from './core.ts';

/** Animation types of Particle World (also Particle Systems II and Mercury). */
export const PW_ANIMATIONS = [
	'Explosive',
	'Direction Axis',
	'Cone Axis',
	'Viscouse',
	'Twirl',
	'Twirly',
	'Vortex',
	'Fire',
	'Jet Sideways',
	'Fractal Omni',
	'Fractal Uni',
] as const;
export const ANIM = {
	explosive: 0,
	directionAxis: 1,
	coneAxis: 2,
	viscouse: 3,
	twirl: 4,
	twirly: 5,
	vortex: 6,
	fire: 7,
	jetSideways: 8,
	fractalOmni: 9,
	fractalUni: 10,
} as const;

/** Floor actions (Particle World ▸ Physics ▸ Floor). */
export const FLOOR_ACTIONS = ['None', 'Bounce', 'Ice', 'Glue'] as const;

/** Physics at one step (world units: Particle World = layer widths, 2D systems = layer heights; y down). */
export type Phys = {
	/** Particles per second. */
	rate: number;
	life: number;
	producer: [number, number, number];
	radius: [number, number, number];
	/** Producer velocity (world units / s) × Inherit Velocity. */
	inherit: [number, number, number];
	anim: number;
	speed: number;
	gravity: [number, number, number];
	resistance: number;
	axis: [number, number, number];
	extra: number;
	/** Cone Axis half-angle spread factor |tan(Extra Angle / 2)| (≤ 20). */
	cone: number;
	/** 0 none, 1 bounce, 2 ice, 3 glue; floor plane y (world units). */
	floor: number;
	floorY: number;
	seed: number;
	max: number;
	/** 2D systems keep z = 0. */
	flat: boolean;
};

/** Fields per particle in `PState.d`. */
export const P_STRIDE = 14;
/** Field offsets. */
export const PF = {
	x: 0,
	y: 1,
	z: 2,
	vx: 3,
	vy: 4,
	vz: 5,
	age: 6,
	life: 7,
	rnd: 8,
	id: 9,
	ox: 10,
	oy: 11,
	oz: 12,
	stuck: 13,
} as const;

export type PState = { d: Float64Array; n: number; carry: number; nextId: number };

export const newPState = (): PState => ({ d: new Float64Array(P_STRIDE * 256), n: 0, carry: 0, nextId: 0 });
export const clonePState = (s: PState): PState => ({
	d: s.d.slice(0, Math.max(s.n, 1) * P_STRIDE),
	n: s.n,
	carry: s.carry,
	nextId: s.nextId,
});

function norm3(v: [number, number, number]): [number, number, number] {
	const l = Math.hypot(v[0], v[1], v[2]);
	return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : [0, -1, 0];
}

function randDir(i: number, k: number, seed: number, flat: boolean): [number, number, number] {
	if (flat) {
		const a = h01(i, k, seed) * Math.PI * 2;
		return [Math.cos(a), Math.sin(a), 0];
	}
	const z = hs(i, k, seed);
	const a = h01(i, k + 1, seed) * Math.PI * 2;
	const r = Math.sqrt(Math.max(0, 1 - z * z));
	return [r * Math.cos(a), r * Math.sin(a), z];
}

function grow(s: PState): void {
	if ((s.n + 1) * P_STRIDE <= s.d.length) return;
	const d = new Float64Array(Math.max(s.d.length * 2, P_STRIDE * 256));
	d.set(s.d);
	s.d = d;
}

/** A new particle `id` (written at slot s.n). */
function spawn(s: PState, ph: Phys, id: number, frac: number): void {
	grow(s);
	const seed = ph.seed;
	const u = randDir(id, 1, seed, ph.flat);
	const rr = h01(id, 3, seed) ** (ph.flat ? 0.5 : 1 / 3);
	const p: [number, number, number] = [0, 0, 0];
	for (let k = 0; k < 3; k++) p[k] = ph.producer[k]! + u[k]! * ph.radius[k]! * rr;
	if (ph.flat) p[2] = 0;
	const ax = norm3(ph.axis);
	const j = randDir(id, 5, seed, ph.flat);
	let dir: [number, number, number];
	switch (ph.anim) {
		case ANIM.directionAxis:
		case ANIM.fractalUni:
			dir = norm3([ax[0] + j[0] * 0.08, ax[1] + j[1] * 0.08, ax[2] + j[2] * 0.08]);
			break;
		case ANIM.coneAxis: {
			const k = ph.cone * h01(id, 8, seed);
			dir = norm3([ax[0] + j[0] * k, ax[1] + j[1] * k, ax[2] + j[2] * k]);
			break;
		}
		case ANIM.twirl: {
			// Outward from the producer with a tangential swirl about the vertical axis (2D: about the view axis).
			const off = [u[0], u[1], u[2]];
			const t = ph.flat ? [-off[1]!, off[0]!, 0] : [-off[2]!, 0, off[0]!];
			dir = norm3([
				off[0]! * 0.5 + t[0]! * ph.extra,
				off[1]! * 0.5 + t[1]!,
				off[2]! * 0.5 + t[2]! * ph.extra,
			]);
			break;
		}
		case ANIM.vortex:
			dir = [j[0], 0, ph.flat ? 0 : j[2]];
			break;
		case ANIM.fire:
			dir = norm3([j[0] * 0.25, -1, j[2] * 0.25]);
			break;
		case ANIM.jetSideways:
			dir = norm3([1, j[1] * 0.05, j[2] * 0.05]);
			break;
		default:
			dir = j;
	}
	const sp = ph.speed * (0.5 + 0.5 * h01(id, 9, seed));
	const v: [number, number, number] = [
		dir[0] * sp + ph.inherit[0],
		dir[1] * sp + ph.inherit[1],
		dir[2] * sp + ph.inherit[2],
	];
	if (ph.flat) v[2] = 0;
	const o = s.n * P_STRIDE;
	const d = s.d;
	// Sub-step birth offset keeps continuous streams smooth.
	d[o + PF.x] = p[0] + v[0] * frac;
	d[o + PF.y] = p[1] + v[1] * frac;
	d[o + PF.z] = p[2] + v[2] * frac;
	d[o + PF.vx] = v[0];
	d[o + PF.vy] = v[1];
	d[o + PF.vz] = v[2];
	d[o + PF.age] = frac;
	d[o + PF.life] = ph.life * (0.8 + 0.4 * h01(id, 10, seed));
	d[o + PF.rnd] = h01(id, 11, seed);
	d[o + PF.id] = id;
	d[o + PF.ox] = p[0] - ph.producer[0];
	d[o + PF.oy] = p[1] - ph.producer[1];
	d[o + PF.oz] = p[2] - ph.producer[2];
	d[o + PF.stuck] = 0;
	s.n++;
}

/** Advances the state by one step (step index `i`, physics `ph` of that step). */
export function stepParticles(s: PState, ph: Phys, i: number): void {
	const dt = 1 / SIM_SPS;
	const t = i * dt;
	let drag = Math.max(0, ph.resistance);
	if (ph.anim === ANIM.viscouse) drag += 3 * Math.max(0.1, ph.extra);
	const damp = Math.exp(-drag * dt);
	const seed = ph.seed;
	const d = s.d;
	let w = 0;
	for (let r = 0; r < s.n; r++) {
		const o = r * P_STRIDE;
		const age = d[o + PF.age]! + dt;
		if (age >= d[o + PF.life]!) continue; // dies
		if (w !== r) d.copyWithin(w * P_STRIDE, o, o + P_STRIDE);
		const q = w * P_STRIDE;
		w++;
		d[q + PF.age] = age;
		if (d[q + PF.stuck]! > 0) continue; // glued to the floor
		const x = d[q + PF.x]!;
		const y = d[q + PF.y]!;
		const z = d[q + PF.z]!;
		let ax = ph.gravity[0];
		let ay = ph.gravity[1];
		let az = ph.gravity[2];
		switch (ph.anim) {
			case ANIM.twirly: {
				const dx = x - ph.producer[0];
				const dz = z - ph.producer[2];
				const k = 4 * ph.extra;
				ax += -dz * k;
				az += dx * k;
				if (ph.flat) {
					const dy = y - ph.producer[1];
					ax += -dy * k;
					ay += dx * k;
				}
				break;
			}
			case ANIM.vortex: {
				const dx = x - ph.producer[0];
				const dy = y - ph.producer[1];
				const k = 6 * ph.extra;
				ax += -dy * k - dx * 2;
				ay += dx * k - dy * 2;
				break;
			}
			case ANIM.fire: {
				const nn = valueNoise3(x * 8, y * 8, t * 3, seed) - 0.5;
				ax += nn * 4 * ph.extra;
				ay -= ph.gravity[1] * 1.5 + 0.3 * ph.extra;
				break;
			}
			case ANIM.fractalOmni:
			case ANIM.fractalUni: {
				const f = 6 * ph.extra;
				ax += (valueNoise3(x * 5, y * 5, z * 5 + t, seed) - 0.5) * f;
				ay += (valueNoise3(x * 5 + 17, y * 5, z * 5 + t, seed) - 0.5) * f;
				if (!ph.flat) az += (valueNoise3(x * 5, y * 5 + 31, z * 5 + t, seed) - 0.5) * f;
				break;
			}
			default:
				break;
		}
		let vx = (d[q + PF.vx]! + ax * dt) * damp;
		let vy = (d[q + PF.vy]! + ay * dt) * damp;
		let vz = ph.flat ? 0 : (d[q + PF.vz]! + az * dt) * damp;
		let nx = x + vx * dt;
		let ny = y + vy * dt;
		const nz = ph.flat ? 0 : z + vz * dt;
		// Floor (y down: the floor is below when y grows past it).
		if (ph.floor > 0 && ny > ph.floorY && y <= ph.floorY + 1e-9) {
			if (ph.floor === 1) {
				ny = ph.floorY - (ny - ph.floorY) * 0.6;
				vy = -vy * 0.6;
				vx *= 0.9;
				vz *= 0.9;
			} else if (ph.floor === 2) {
				ny = ph.floorY;
				vy = 0;
			} else {
				const k = (ph.floorY - y) / Math.max(ny - y, 1e-12);
				nx = x + (nx - x) * k;
				ny = ph.floorY;
				vx = 0;
				vy = 0;
				vz = 0;
				d[q + PF.stuck] = 1;
			}
		} else if (ph.floor === 2 && Math.abs(y - ph.floorY) < 1e-9 && ny > ph.floorY) {
			ny = ph.floorY; // ice: slide along the floor
			vy = 0;
		}
		d[q + PF.vx] = vx;
		d[q + PF.vy] = vy;
		d[q + PF.vz] = vz;
		d[q + PF.x] = nx;
		d[q + PF.y] = ny;
		d[q + PF.z] = nz;
	}
	s.n = w;
	s.carry += Math.max(0, ph.rate) / SIM_SPS;
	const born = Math.floor(s.carry);
	s.carry -= born;
	for (let k = 0; k < born; k++) {
		if (s.n >= ph.max) break;
		const id = s.nextId++;
		spawn(s, ph, id, h01(id, 12, ph.seed) * dt);
	}
}

/** Life fraction 0..1 of particle slot r. */
export const lifeOf = (s: PState, r: number) =>
	clamp(s.d[r * P_STRIDE + PF.age]! / Math.max(1e-4, s.d[r * P_STRIDE + PF.life]!), 0, 1);
