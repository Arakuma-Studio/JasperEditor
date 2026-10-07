// SVG path data → Bézier paths (wp shapes): every command of SVG 1.1/2 path syntax (M, L, H, V, C, S, Q, T, A, Z, in
// absolute and relative forms, implicit repeats, compact number syntax and arc flags without separators). Quadratics
// are elevated to cubics exactly; elliptical arcs become cubics of ≤ 90° each (endpoint → centre parameterisation
// per SVG 2 Appendix B.2.4, out-of-range radii scaled up). Pure; used by paste, SVG import and the agent tools.
import { type BezPath, type Cubic, lineCubic, type P, type SubPath } from './geom.ts';

const CMD = /[MmLlHhVvCcSsQqTtAaZz]/;

/** Tokenises path data into commands and numbers (flags of arcs are read one character at a time). */
function tokenize(d: string): (string | number)[] {
	const out: (string | number)[] = [];
	let i = 0;
	const s = d;
	let lastCmd = '';
	let argIndex = 0;
	const num = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
	while (i < s.length) {
		const ch = s[i]!;
		if (/[\s,]/.test(ch)) {
			i++;
			continue;
		}
		if (CMD.test(ch)) {
			out.push(ch);
			lastCmd = ch;
			argIndex = 0;
			i++;
			continue;
		}
		// Arc flags (args 3 and 4 of each 7-arg group) are single characters "0" or "1".
		if (
			(lastCmd === 'A' || lastCmd === 'a') &&
			(argIndex % 7 === 3 || argIndex % 7 === 4) &&
			(ch === '0' || ch === '1')
		) {
			out.push(ch === '1' ? 1 : 0);
			argIndex++;
			i++;
			continue;
		}
		const m = num.exec(s.slice(i));
		if (!m) throw new Error(`Invalid path data near "${s.slice(i, i + 12)}"`);
		out.push(Number.parseFloat(m[0]));
		argIndex++;
		i += m[0].length;
	}
	return out;
}

/** Elliptical arc (SVG endpoint parameterisation) as cubics. */
export function arcToCubics(
	p0: P,
	rx0: number,
	ry0: number,
	phiDeg: number,
	largeArc: boolean,
	sweep: boolean,
	p1: P,
): Cubic[] {
	if (p0[0] === p1[0] && p0[1] === p1[1]) return [];
	let rx = Math.abs(rx0);
	let ry = Math.abs(ry0);
	if (rx === 0 || ry === 0) return [lineCubic(p0, p1)];
	const phi = (phiDeg * Math.PI) / 180;
	const cos = Math.cos(phi);
	const sin = Math.sin(phi);
	const dx = (p0[0] - p1[0]) / 2;
	const dy = (p0[1] - p1[1]) / 2;
	const x1 = cos * dx + sin * dy;
	const y1 = -sin * dx + cos * dy;
	const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
	if (lambda > 1) {
		const k = Math.sqrt(lambda);
		rx *= k;
		ry *= k;
	}
	const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
	const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
	let co = den > 0 ? Math.sqrt(Math.max(0, num / den)) : 0;
	if (largeArc === sweep) co = -co;
	const cx1 = (co * rx * y1) / ry;
	const cy1 = (-co * ry * x1) / rx;
	const cx = cos * cx1 - sin * cy1 + (p0[0] + p1[0]) / 2;
	const cy = sin * cx1 + cos * cy1 + (p0[1] + p1[1]) / 2;
	const ang = (ux: number, uy: number, vx: number, vy: number) =>
		Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
	const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
	let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
	if (!sweep && dt > 0) dt -= 2 * Math.PI;
	else if (sweep && dt < 0) dt += 2 * Math.PI;
	const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
	const step = dt / n;
	const k = (4 / 3) * Math.tan(step / 4);
	const pt = (t: number): P => [
		cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin,
		cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos,
	];
	const der = (t: number): P => [
		-rx * Math.sin(t) * cos - ry * Math.cos(t) * sin,
		-rx * Math.sin(t) * sin + ry * Math.cos(t) * cos,
	];
	const out: Cubic[] = [];
	for (let i = 0; i < n; i++) {
		const a = t1 + step * i;
		const b = a + step;
		const pa = i === 0 ? p0 : pt(a);
		const pb = i === n - 1 ? p1 : pt(b);
		const da = der(a);
		const db = der(b);
		out.push([pa, [pa[0] + k * da[0], pa[1] + k * da[1]], [pb[0] - k * db[0], pb[1] - k * db[1]], pb]);
	}
	return out;
}

/** Parses SVG path data into a compound Bézier path. Throws on malformed data. */
export function parseSvgPath(d: string): BezPath {
	const tk = tokenize(d);
	const out: BezPath = [];
	let cur: SubPath | null = null;
	let pos: P = [0, 0];
	let start: P = [0, 0];
	let lastCtrl: P | null = null;
	let lastQuad: P | null = null;
	let i = 0;
	let cmd = '';
	const nextNum = (): number => {
		const v = tk[i];
		if (typeof v !== 'number') throw new Error(`Path data: expected a number after "${cmd}"`);
		i++;
		return v;
	};
	const ensure = () => {
		if (!cur) {
			cur = { segs: [], closed: false };
			out.push(cur);
			start = pos;
		}
		return cur;
	};
	const push = (c: Cubic) => {
		ensure().segs.push(c);
		pos = c[3];
	};
	while (i < tk.length) {
		const t = tk[i];
		if (typeof t === 'string') {
			cmd = t;
			i++;
		} else if (!cmd) throw new Error('Path data must start with a command');
		else if (cmd === 'M') cmd = 'L';
		else if (cmd === 'm') cmd = 'l';
		const rel = cmd === cmd.toLowerCase();
		const R = (x: number, y: number): P => (rel ? [pos[0] + x, pos[1] + y] : [x, y]);
		let ctrl: P | null = null;
		let quad: P | null = null;
		switch (cmd.toUpperCase()) {
			case 'M': {
				const p = R(nextNum(), nextNum());
				cur = { segs: [], closed: false };
				out.push(cur);
				pos = p;
				start = p;
				break;
			}
			case 'L':
				push(lineCubic(pos, R(nextNum(), nextNum())));
				break;
			case 'H': {
				const x = nextNum();
				push(lineCubic(pos, [rel ? pos[0] + x : x, pos[1]]));
				break;
			}
			case 'V': {
				const y = nextNum();
				push(lineCubic(pos, [pos[0], rel ? pos[1] + y : y]));
				break;
			}
			case 'C': {
				const c1 = R(nextNum(), nextNum());
				const c2 = R(nextNum(), nextNum());
				const p = R(nextNum(), nextNum());
				push([pos, c1, c2, p]);
				ctrl = c2;
				break;
			}
			case 'S': {
				const c1: P = lastCtrl ? [2 * pos[0] - lastCtrl[0], 2 * pos[1] - lastCtrl[1]] : pos;
				const c2 = R(nextNum(), nextNum());
				const p = R(nextNum(), nextNum());
				push([pos, c1, c2, p]);
				ctrl = c2;
				break;
			}
			case 'Q': {
				const q = R(nextNum(), nextNum());
				const p = R(nextNum(), nextNum());
				push(quadToCubic(pos, q, p));
				quad = q;
				break;
			}
			case 'T': {
				const q: P = lastQuad ? [2 * pos[0] - lastQuad[0], 2 * pos[1] - lastQuad[1]] : pos;
				const p = R(nextNum(), nextNum());
				push(quadToCubic(pos, q, p));
				quad = q;
				break;
			}
			case 'A': {
				const rx = nextNum();
				const ry = nextNum();
				const rot = nextNum();
				const large = nextNum() !== 0;
				const sw = nextNum() !== 0;
				const p = R(nextNum(), nextNum());
				const arcs = arcToCubics(pos, rx, ry, rot, large, sw, p);
				ensure();
				for (const c of arcs) push(c);
				pos = p;
				break;
			}
			case 'Z': {
				if (cur) {
					(cur as SubPath).closed = true;
					cur = null;
				}
				pos = start;
				break;
			}
			default:
				throw new Error(`Unknown path command "${cmd}"`);
		}
		lastCtrl = ctrl;
		lastQuad = quad;
		if (cmd === 'Z' || cmd === 'z') {
			// After Z a following coordinate pair starts a new subpath at the current point (implicit M is not
			// allowed by the grammar, so only a command can follow).
			cmd = '';
		}
	}
	return out.filter((sp) => sp.segs.length > 0);
}

function quadToCubic(p0: P, q: P, p1: P): Cubic {
	return [
		p0,
		[p0[0] + ((q[0] - p0[0]) * 2) / 3, p0[1] + ((q[1] - p0[1]) * 2) / 3],
		[p1[0] + ((q[0] - p1[0]) * 2) / 3, p1[1] + ((q[1] - p1[1]) * 2) / 3],
		p1,
	];
}
