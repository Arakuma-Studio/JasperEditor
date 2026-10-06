// Synthetic generators (edit-structure): the pictures and sounds of Bars and Tone and the Universal Counting
// Leader as pure functions of (size, content time). The Player draws these pixels on a canvas; the engine writes the
// same pixels into intermediates for the native export, so preview and export match exactly.
// Bars: SMPTE RP 219-1 / ARIB STD-B28 HD colour bars (Premiere's HD bars "comply with ARIB STD-B28"), in full-range
// sRGB code values. Leader: Premiere's Universal Counting Leader Setup (wipe, background, line, target and numeral
// colours; cue blips). Ported and extended from FilmCraft `crates/media/src/generators.rs` (MIT OR Apache-2.0).
import { type CountingLeaderStyle, LEADER_BLIP_DB, LEADER_BLIP_HZ, type SyntheticSound } from './synthetic.ts';

// ---------------------------------------------------------------- bars

const pct = (p: number) => Math.round((p / 100) * 255);
type RGB = readonly [number, number, number];
const GREY = (p: number): RGB => [pct(p), pct(p), pct(p)];
const B75 = pct(75);
/** 75 % bars, left to right: white, yellow, cyan, green, magenta, red, blue. */
const BARS75: readonly RGB[] = [
	[B75, B75, B75],
	[B75, B75, 0],
	[0, B75, B75],
	[0, B75, 0],
	[B75, 0, B75],
	[B75, 0, 0],
	[0, 0, B75],
];

/**
 * HD colour bars at `w × h` (RGBA, straight alpha, opaque). Layout of SMPTE RP 219 for a 16:9 frame: `d` = w/8 side
 * panels, `c` = 3w/28 bar width; rows 7/12 (40 % grey | seven 75 % bars | 40 % grey), 1/12 (100 % cyan | 100 % white
 * | 75 % white | 100 % blue), 1/12 (100 % yellow | 0–100 % ramp | 100 % red), 3/12 (15 % grey | black | 100 % white |
 * black | PLUGE −2/0/+2/0/+4 % | black | 15 % grey). Sub-black PLUGE (−2 %) is clipped to black in RGB.
 */
export function renderBars(w: number, h: number): Uint8ClampedArray {
	const px = new Uint8ClampedArray(w * h * 4);
	const d = w / 8;
	const c = (w - 2 * d) / 7;
	const r1 = Math.round((h * 7) / 12);
	const r2 = Math.round((h * 8) / 12);
	const r3 = Math.round((h * 9) / 12);
	// Row 4 boundaries (multiples of c after the side panel).
	const row4: { to: number; v: RGB }[] = [];
	{
		let x = d;
		const seg = (len: number, v: RGB) => {
			x += len;
			row4.push({ to: x, v });
		};
		row4.push({ to: d, v: GREY(15) });
		seg(1.5 * c, GREY(0));
		seg(2 * c, GREY(100));
		seg((5 / 6) * c, GREY(0));
		seg(c / 3, GREY(0)); // −2 % (clipped)
		seg(c / 3, GREY(0));
		seg(c / 3, GREY(2));
		seg(c / 3, GREY(0));
		seg(c / 3, GREY(4));
		row4.push({ to: w - d, v: GREY(0) });
		row4.push({ to: w + 1, v: GREY(15) });
	}
	const row = new Uint8ClampedArray(w * 4);
	const fillRow = (y0: number, y1: number, colorAt: (x: number) => RGB) => {
		for (let x = 0; x < w; x++) {
			const v = colorAt(x + 0.5);
			row[x * 4] = v[0];
			row[x * 4 + 1] = v[1];
			row[x * 4 + 2] = v[2];
			row[x * 4 + 3] = 255;
		}
		for (let y = y0; y < y1; y++) px.set(row, y * w * 4);
	};
	fillRow(0, r1, (x) => (x < d || x >= w - d ? GREY(40) : BARS75[Math.min(6, Math.floor((x - d) / c))]!));
	fillRow(r1, r2, (x) =>
		x < d ? [0, 255, 255] : x >= w - d ? [0, 0, 255] : x < d + c ? GREY(100) : GREY(75),
	);
	fillRow(r2, r3, (x) => {
		if (x < d) return [255, 255, 0];
		if (x >= w - d) return [255, 0, 0];
		const v = Math.round(((x - d) / (w - 2 * d)) * 255);
		return [v, v, v];
	});
	fillRow(r3, h, (x) => row4.find((s) => x < s.to)!.v);
	return px;
}

// ---------------------------------------------------------------- counting leader

/** Leader timeline (content seconds): lead-in, the countdown 8 → 2 (one second each), then black to the end. */
export const LEADER_LEAD_IN = 2;
export const LEADER_FIRST_NUMERAL = 8;
export const LEADER_LAST_NUMERAL = 2;
export const LEADER_COUNT_END = LEADER_LEAD_IN + (LEADER_FIRST_NUMERAL - LEADER_LAST_NUMERAL + 1); // 9 s
export const LEADER_DURATION = 11;

/** What the leader shows at content time `t` (seconds). */
export function leaderPhaseAt(t: number):
	| { phase: 'lead-in' }
	| { phase: 'count'; numeral: number; sweep: number }
	| { phase: 'black' } {
	if (t < LEADER_LEAD_IN) return { phase: 'lead-in' };
	if (t < LEADER_COUNT_END) {
		const k = Math.floor(t - LEADER_LEAD_IN);
		return { phase: 'count', numeral: LEADER_FIRST_NUMERAL - k, sweep: t - LEADER_LEAD_IN - k };
	}
	return { phase: 'black' };
}

/** Times (seconds) at which a blip starts, for the style's cue options. */
export function leaderBlipTimes(style: Pick<CountingLeaderStyle, 'cueBlipOnTwo' | 'cueBlipAllSeconds'>): number[] {
	const out: number[] = [];
	if (style.cueBlipAllSeconds)
		for (let n = LEADER_FIRST_NUMERAL; n >= LEADER_LAST_NUMERAL; n--)
			out.push(LEADER_LEAD_IN + (LEADER_FIRST_NUMERAL - n));
	else if (style.cueBlipOnTwo) out.push(LEADER_LEAD_IN + (LEADER_FIRST_NUMERAL - LEADER_LAST_NUMERAL));
	return out;
}

type Pt = readonly [number, number];
/** Points of an elliptic arc; angles in degrees, 0 = right, clockwise (y down). */
function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): Pt[] {
	const n = Math.max(6, Math.ceil(Math.abs(a1 - a0) / 10));
	const out: Pt[] = [];
	for (let i = 0; i <= n; i++) {
		const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
		out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
	}
	return out;
}

/** Stroke font for the numerals (polylines in a unit box, y down; drawn with round caps). */
const DIGITS: Readonly<Record<string, readonly Pt[][]>> = {
	'0': [arc(0.5, 0.5, 0.42, 0.5, 0, 360)],
	'1': [
		[
			[0.28, 0.16],
			[0.55, 0],
			[0.55, 1],
		],
	],
	'2': [
		[
			...arc(0.5, 0.27, 0.4, 0.27, 190, 380),
			[0.06, 1],
			[0.94, 1],
		],
	],
	'3': [arc(0.5, 0.26, 0.38, 0.26, 200, 450), arc(0.5, 0.74, 0.42, 0.26, 270, 520)],
	'4': [
		[
			[0.72, 1],
			[0.72, 0],
			[0.04, 0.7],
			[0.96, 0.7],
		],
	],
	'5': [
		[
			[0.88, 0],
			[0.2, 0],
			[0.14, 0.46],
			...arc(0.5, 0.68, 0.4, 0.32, 215, 500),
		],
	],
	'6': [
		arc(0.5, 0.68, 0.42, 0.32, 0, 360),
		[
			[0.82, 0.05],
			[0.58, 0],
			[0.34, 0.07],
			[0.16, 0.27],
			[0.08, 0.55],
			[0.09, 0.7],
		],
	],
	'7': [
		[
			[0.04, 0],
			[0.96, 0],
			[0.36, 1],
		],
	],
	'8': [arc(0.5, 0.25, 0.34, 0.25, 0, 360), arc(0.5, 0.73, 0.42, 0.27, 0, 360)],
	'9': [
		arc(0.5, 0.32, 0.42, 0.32, 0, 360),
		[
			[0.92, 0.32],
			[0.91, 0.52],
			[0.82, 0.76],
			[0.62, 0.95],
			[0.4, 1],
			[0.18, 0.94],
		],
	],
};

/** Distance from p to segment ab. */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax;
	const dy = by - ay;
	const l2 = dx * dx + dy * dy;
	let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
	t = t < 0 ? 0 : t > 1 ? 1 : t;
	const ex = px - (ax + t * dx);
	const ey = py - (ay + t * dy);
	return Math.sqrt(ex * ex + ey * ey);
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Composites colour `c` (0..1 RGBA) with coverage `k` over pixel `i` of an opaque canvas. */
function over(px: Float32Array, i: number, c: readonly number[], k: number): void {
	const a = k * (c[3] ?? 1);
	if (a <= 0) return;
	px[i] = px[i]! + (c[0]! - px[i]!) * a;
	px[i + 1] = px[i + 1]! + (c[1]! - px[i + 1]!) * a;
	px[i + 2] = px[i + 2]! + (c[2]! - px[i + 2]!) * a;
}

/**
 * The Universal Counting Leader at content time `t` seconds, `w × h` RGBA (opaque). `frameSeconds` = the length of
 * one frame (the cue circle "on out" is drawn on the leader's last frame).
 */
export function renderCountingLeader(
	w: number,
	h: number,
	t: number,
	style: CountingLeaderStyle,
	frameSeconds: number,
): Uint8ClampedArray {
	const out = new Uint8ClampedArray(w * h * 4);
	const phase = leaderPhaseAt(t);
	const lastFrame = style.cueBlipOnOut && t >= LEADER_DURATION - frameSeconds && t < LEADER_DURATION;
	if (phase.phase === 'black') {
		for (let i = 0; i < out.length; i += 4) out[i + 3] = 255;
		if (lastFrame) drawCueCircle(out, w, h);
		return out;
	}
	const f = new Float32Array(w * h * 4);
	const bg = style.backgroundColor;
	for (let i = 0; i < f.length; i += 4) {
		f[i] = bg[0];
		f[i + 1] = bg[1];
		f[i + 2] = bg[2];
		f[i + 3] = 1;
	}
	const cx = w / 2;
	const cy = h / 2;
	const unit = h / 1080;
	const lineHalf = Math.max(0.75, 2 * unit);
	const ringHalf = Math.max(0.75, 3 * unit);
	const rings = [0.38 * h, 0.32 * h];
	const sweep = phase.phase === 'count' ? phase.sweep * 2 * Math.PI : 0;
	for (let y = 0; y < h; y++) {
		const dy = y + 0.5 - cy;
		for (let x = 0; x < w; x++) {
			const dx = x + 0.5 - cx;
			const i = (y * w + x) * 4;
			const d = Math.sqrt(dx * dx + dy * dy);
			if (sweep > 0) {
				// Clockwise angle from 12 o'clock; the swept sector shows the wipe colour (edge anti-aliased in px).
				let a = Math.atan2(dx, -dy);
				if (a < 0) a += 2 * Math.PI;
				const edge = Math.min(sweep - a, a) * Math.max(d, 1);
				const k = a <= sweep ? clamp01(edge + 0.5) : 0;
				if (k > 0) over(f, i, style.wipeColor, k);
			}
			for (const r of rings) {
				const k = clamp01(ringHalf - Math.abs(d - r) + 0.5);
				if (k > 0) over(f, i, style.targetColor, k);
			}
			const kl = Math.max(clamp01(lineHalf - Math.abs(dx) + 0.5), clamp01(lineHalf - Math.abs(dy) + 0.5));
			if (kl > 0) over(f, i, style.lineColor, kl);
		}
	}
	if (phase.phase === 'count') drawNumeral(f, w, h, String(phase.numeral), style.numeralColor);
	for (let i = 0; i < f.length; i++) out[i] = Math.round(f[i]! * 255);
	if (lastFrame) drawCueCircle(out, w, h);
	return out;
}

function drawNumeral(f: Float32Array, w: number, h: number, text: string, color: readonly number[]): void {
	const nh = 0.42 * h;
	const nw = 0.6 * nh;
	const half = 0.055 * nh;
	const x0 = w / 2 - nw / 2;
	const y0 = h / 2 - nh / 2;
	const strokes = (DIGITS[text] ?? []).map((pts) => pts.map(([x, y]) => [x0 + x * nw, y0 + y * nh] as const));
	const bx0 = Math.max(0, Math.floor(x0 - half - 1));
	const bx1 = Math.min(w, Math.ceil(x0 + nw + half + 1));
	const by0 = Math.max(0, Math.floor(y0 - half - 1));
	const by1 = Math.min(h, Math.ceil(y0 + nh + half + 1));
	for (let y = by0; y < by1; y++) {
		for (let x = bx0; x < bx1; x++) {
			const px = x + 0.5;
			const py = y + 0.5;
			let d = Number.POSITIVE_INFINITY;
			for (const s of strokes)
				for (let k = 1; k < s.length; k++) {
					const a = s[k - 1]!;
					const b = s[k]!;
					d = Math.min(d, segDist(px, py, a[0], a[1], b[0], b[1]));
				}
			const k = clamp01(half - d + 0.5);
			if (k > 0) over(f, (y * w + x) * 4, color, k);
		}
	}
}

/** The cue circle on the leader's last frame (top right, white). */
function drawCueCircle(px: Uint8ClampedArray, w: number, h: number): void {
	const cx = 0.9 * w;
	const cy = 0.12 * h;
	const r = 0.04 * h;
	for (let y = Math.max(0, Math.floor(cy - r - 1)); y < Math.min(h, Math.ceil(cy + r + 1)); y++)
		for (let x = Math.max(0, Math.floor(cx - r - 1)); x < Math.min(w, Math.ceil(cx + r + 1)); x++) {
			const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
			const k = clamp01(r - d + 0.5);
			if (k <= 0) continue;
			const i = (y * w + x) * 4;
			for (let c = 0; c < 3; c++) px[i + c] = Math.round(px[i + c]! + (255 - px[i + c]!) * k);
		}
}

// ---------------------------------------------------------------- sound

const dbToAmp = (db: number) => 10 ** (db / 20);

/**
 * `n` mono samples of a synthetic sound starting at content time `t0` seconds (`sampleRate` Hz). The leader's blips
 * last one frame (`frameSeconds`). Pure: sample k depends only on its own time.
 */
export function syntheticSamples(
	sound: SyntheticSound,
	t0: number,
	n: number,
	sampleRate: number,
	frameSeconds: number,
): Float32Array {
	const out = new Float32Array(n);
	if (sound.kind === 'tone') {
		const amp = dbToAmp(sound.db);
		const w = 2 * Math.PI * sound.hz;
		for (let k = 0; k < n; k++) out[k] = amp * Math.sin(w * (t0 + k / sampleRate));
		return out;
	}
	const amp = dbToAmp(LEADER_BLIP_DB);
	const w = 2 * Math.PI * LEADER_BLIP_HZ;
	for (const s of leaderBlipTimes(sound.style)) {
		const k0 = Math.max(0, Math.ceil((s - t0) * sampleRate - 1e-9));
		const k1 = Math.min(n, Math.ceil((s + frameSeconds - t0) * sampleRate - 1e-9));
		for (let k = k0; k < k1; k++) out[k] = amp * Math.sin(w * (t0 + k / sampleRate - s));
	}
	return out;
}

/** A 16-bit PCM stereo WAV (both channels equal) of mono float samples. */
export function encodeWavStereo16(samples: Float32Array, sampleRate: number): Uint8Array {
	const n = samples.length;
	const data = n * 4;
	const buf = new ArrayBuffer(44 + data);
	const v = new DataView(buf);
	const str = (o: number, s: string) => {
		for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
	};
	str(0, 'RIFF');
	v.setUint32(4, 36 + data, true);
	str(8, 'WAVE');
	str(12, 'fmt ');
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true);
	v.setUint16(22, 2, true);
	v.setUint32(24, sampleRate, true);
	v.setUint32(28, sampleRate * 4, true);
	v.setUint16(32, 4, true);
	v.setUint16(34, 16, true);
	str(36, 'data');
	v.setUint32(40, data, true);
	for (let i = 0; i < n; i++) {
		const s = Math.max(-1, Math.min(1, samples[i]!));
		const q = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
		v.setInt16(44 + i * 4, q, true);
		v.setInt16(46 + i * 4, q, true);
	}
	return new Uint8Array(buf);
}
