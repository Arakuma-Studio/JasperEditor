/**
 * Channel layouts, format conversion (up/downmix), pan laws and the 5.1 surround panner.
 *
 * **Channel order.** 5.1 audio is always in the SMPTE / WAVE order **L, R, C, LFE, Ls, Rs**; stereo is L, R;
 * mono is one channel.
 *
 * **Downmix** follows ITU-R BS.775 (Table 2, "3/2 source" rows), with `k = 1/√2` (−3 dB):
 *
 * | from → to | equations |
 * |---|---|
 * | 5.1 → 2.0 | `Lo = L + k·C + k·Ls`, `Ro = R + k·C + k·Rs` (LFE omitted) |
 * | 5.1 → 1.0 | `M = k·L + k·R + C + ½·Ls + ½·Rs` |
 * | 2.0 → 1.0 | `M = k·L + k·R` |
 *
 * The 5.1 → stereo fold can be changed with the "5.1 Mixdown Type" ({@link Mixdown}): `front` drops the
 * surrounds, the `…Lfe` variants add `k·LFE` to both sides.
 *
 * **Upmix** places the source on the front speakers without inventing content: mono → C (5.1) or both
 * sides at unity (2.0); stereo → L, R.
 *
 * **5.1 panner** ({@link pan51Matrix}): a puck at `(x, y)` in the listening square (x −1 left … +1 right,
 * y −1 rear … +1 front). A point source is split front/rear and left/right with the sine/cosine
 * constant-power law, and the front image is shared between the phantom L/R pair and the centre speaker by
 * **Center %** (`k_c = center · (1 − |x|)` of the front power goes to C). The gains of a point source always
 * have unit power (`Σ g² = 1`). Multichannel sources keep their layout around the puck: each source channel
 * sits at its nominal speaker position moved by the puck's offset from front-centre (so the default puck
 * (0, 1) at 100 % centre maps 5.1 to itself exactly). Stereo sources sit at the puck ± 1 in x. The LFE output
 * is the source LFE (5.1) or the mean of the source channels (mono/stereo) times the LFE gain.
 *
 * Ported from FilmCraft `crates/audio-dsp/src/channels.rs` and `src/effects/channel.rs` (MIT OR Apache-2.0).
 */

/** −3 dB, the BS.775 downmix coefficient. */
export const K = Math.SQRT1_2;

/** 5.1 channel indices (SMPTE / WAVE order). */
export const CH_L = 0;
export const CH_R = 1;
export const CH_C = 2;
export const CH_LFE = 3;
export const CH_LS = 4;
export const CH_RS = 5;

/** A channel layout. */
export type Layout = 'mono' | 'stereo' | '5.1';

/** All layouts. */
export const LAYOUTS: readonly Layout[] = ['mono', 'stereo', '5.1'];

/** Number of channels of a layout. */
export function channelCount(layout: Layout): number {
	switch (layout) {
		case 'mono':
			return 1;
		case 'stereo':
			return 2;
		case '5.1':
			return 6;
	}
}

/** The layout of a plain channel count (1, 2 or 6; anything else is treated as stereo). */
export function layoutFromChannels(n: number): Layout {
	return n === 1 ? 'mono' : n === 6 ? '5.1' : 'stereo';
}

/** Short channel names for display. */
export function channelNames(layout: Layout): readonly string[] {
	switch (layout) {
		case 'mono':
			return ['M'];
		case 'stereo':
			return ['L', 'R'];
		case '5.1':
			return ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'];
	}
}

/** Premiere's "5.1 Mixdown Type": how 5.1 is folded to stereo. `frontRear` is ITU-R BS.775. */
export type Mixdown = 'front' | 'frontRear' | 'frontLfe' | 'frontRearLfe';

/** All mixdown types. */
export const MIXDOWNS: readonly Mixdown[] = ['front', 'frontRear', 'frontLfe', 'frontRearLfe'];

/** Parse a mixdown id case-insensitively; undefined when unknown. */
export function mixdownFromId(s: string): Mixdown | undefined {
	const l = s.toLowerCase();
	return MIXDOWNS.find((m) => m.toLowerCase() === l);
}

/** Conversion matrix `m[out][in]` from `from` to `to` (5.1 → stereo uses `mixdown`). */
export function conversionMatrix(from: Layout, to: Layout, mixdown: Mixdown = 'frontRear'): number[][] {
	const ni = channelCount(from);
	const no = channelCount(to);
	const m = Array.from({ length: no }, () => new Array<number>(ni).fill(0));
	if (from === to) {
		for (let i = 0; i < no; i++) m[i][i] = 1;
		return m;
	}
	if (from === 'mono' && to === 'stereo') {
		m[0][0] = 1;
		m[1][0] = 1;
	} else if (from === 'mono' && to === '5.1') m[CH_C][0] = 1;
	else if (from === 'stereo' && to === 'mono') m[0] = [K, K];
	else if (from === 'stereo' && to === '5.1') {
		m[CH_L][0] = 1;
		m[CH_R][1] = 1;
	} else if (from === '5.1' && to === 'mono') {
		m[0][CH_L] = K;
		m[0][CH_R] = K;
		m[0][CH_C] = 1;
		m[0][CH_LS] = 0.5;
		m[0][CH_RS] = 0.5;
	} else if (from === '5.1' && to === 'stereo') {
		m[0][CH_L] = 1;
		m[1][CH_R] = 1;
		m[0][CH_C] = K;
		m[1][CH_C] = K;
		if (mixdown === 'frontRear' || mixdown === 'frontRearLfe') {
			m[0][CH_LS] = K;
			m[1][CH_RS] = K;
		}
		if (mixdown === 'frontLfe' || mixdown === 'frontRearLfe') {
			m[0][CH_LFE] = K;
			m[1][CH_LFE] = K;
		}
	}
	return m;
}

let scratch = new Float64Array(16);

/**
 * Apply a matrix `m[out][in]` to planar `input`, writing `output[o][offset … offset + length)` =
 * `gain · Σ_i m[o][i] · input[i][…]` (or adding it to the existing output when `accumulate`). Input and
 * output may be the same arrays (computed per sample frame). Missing input channels count as silence;
 * extra output rows beyond `m` are left alone. Allocation-free after the first call with a given width.
 */
export function applyMatrix(
	m: ReadonlyArray<ArrayLike<number>>,
	input: Float32Array[],
	output: Float32Array[],
	offset = 0,
	length?: number,
	gain = 1,
	accumulate = false,
): void {
	const no = Math.min(m.length, output.length);
	if (no === 0) return;
	let n = length ?? Number.POSITIVE_INFINITY;
	for (const c of input) n = Math.min(n, c.length - offset);
	for (let o = 0; o < no; o++) n = Math.min(n, output[o].length - offset);
	if (!Number.isFinite(n) || n <= 0) return;
	if (scratch.length < no) scratch = new Float64Array(no);
	const tmp = scratch;
	for (let k = offset; k < offset + n; k++) {
		for (let o = 0; o < no; o++) {
			const row = m[o];
			const ni = Math.min(row.length, input.length);
			let s = 0;
			for (let i = 0; i < ni; i++) {
				const g = row[i];
				if (g !== 0) s += g * input[i][k];
			}
			tmp[o] = s * gain;
		}
		for (let o = 0; o < no; o++) {
			if (accumulate) output[o][k] += tmp[o];
			else output[o][k] = tmp[o];
		}
	}
}

/** Convert planar audio between layouts (allocates the output; a copy when `from === to`). */
export function convertLayout(
	input: Float32Array[],
	from: Layout,
	to: Layout,
	mixdown: Mixdown = 'frontRear',
): Float32Array[] {
	const n = input.length ? Math.min(...input.map((c) => c.length)) : 0;
	if (from === to) return input.map((c) => c.slice(0, n));
	const out = Array.from({ length: channelCount(to) }, () => new Float32Array(n));
	applyMatrix(conversionMatrix(from, to, mixdown), input, out);
	return out;
}

/**
 * Convert planar audio whose layout is given by its channel count to `to`. Unusual channel counts take the
 * first channels that fit and pad with silence.
 */
export function convertChannels(
	input: Float32Array[],
	to: Layout,
	mixdown: Mixdown = 'frontRear',
): Float32Array[] {
	const from = layoutFromChannels(input.length);
	const n = input.length ? Math.min(...input.map((c) => c.length)) : 0;
	if (input.length !== channelCount(from)) {
		return Array.from({ length: channelCount(to) }, (_, c) =>
			c < input.length ? input[c].slice(0, n) : new Float32Array(n),
		);
	}
	return convertLayout(input, from, to, mixdown);
}

/** Peak level (linear) per channel. */
export function channelPeaks(input: Float32Array[]): number[] {
	return input.map((c) => {
		let p = 0;
		for (let i = 0; i < c.length; i++) {
			const a = Math.abs(c[i]);
			if (a > p) p = a;
		}
		return p;
	});
}

/**
 * Constant-power (−3 dB) pan of a mono source, `pan` −1 (left) … +1 (right): `[cos θ, sin θ]`,
 * `θ = (pan + 1)·π/4`; the centre is 0.7071 on both sides.
 */
export function panMonoGains(pan: number): [number, number] {
	const theta = (Math.min(1, Math.max(-1, pan)) + 1) * 0.25 * Math.PI;
	return [snap(Math.cos(theta)), snap(Math.sin(theta))];
}

/**
 * Stereo balance, `pan` −1 … +1: the side opposite the direction is attenuated with a cosine
 * (constant-power) law, the other side stays at unity; centre = unity on both sides.
 */
export function balanceGains(pan: number): [number, number] {
	const p = Math.min(1, Math.max(-1, pan));
	return [snap(Math.cos(Math.max(0, p) * Math.PI * 0.5)), snap(Math.cos(Math.max(0, -p) * Math.PI * 0.5))];
}

/** Snap values within 1e-12 of 0 or 1 (trigonometric round-off at the quadrant ends). */
function snap(v: number): number {
	if (Math.abs(v) < 1e-12) return 0;
	if (Math.abs(v - 1) < 1e-12) return 1;
	return v;
}

/** The 5.1 panner of a track or send feeding a 5.1 bus. */
export type Pan51 = {
	/** −1 (left) … +1 (right). */
	x: number;
	/** −1 (rear) … +1 (front). */
	y: number;
	/** Center %: 0 … 1, the share of the front image the centre speaker takes at x = 0. */
	center: number;
	/** LFE gain (linear). */
	lfeGain: number;
};

/** Front centre, 100 % centre, LFE at unity. */
export const DEFAULT_PAN51: Readonly<Pan51> = Object.freeze({ x: 0, y: 1, center: 1, lfeGain: 1 });

/** Gains of a point source at `(x, y)` to the six 5.1 outputs (LFE is 0); `Σ g² = 1`. */
export function pointGains51(x: number, y: number, center: number): number[] {
	const cx = Math.min(1, Math.max(-1, x));
	const cy = Math.min(1, Math.max(-1, y));
	const fb = (1 - cy) * 0.5 * (Math.PI / 2);
	const f = Math.cos(fb);
	const b = Math.sin(fb);
	const lr = (cx + 1) * (Math.PI / 4);
	const gl = Math.cos(lr);
	const gr = Math.sin(lr);
	const kc = Math.min(1, Math.max(0, Math.min(1, Math.max(0, center)) * (1 - Math.abs(cx))));
	const ph = Math.sqrt(1 - kc);
	const g = [0, 0, 0, 0, 0, 0];
	g[CH_L] = f * ph * gl;
	g[CH_R] = f * ph * gr;
	g[CH_C] = f * Math.sqrt(kc);
	g[CH_LS] = b * gl;
	g[CH_RS] = b * gr;
	// sin/cos at the quadrant ends are not exactly 0 / 1: snap them so speaker positions route bit-exactly
	// (a 5.1 source through the default panner is the identity)
	for (let i = 0; i < 6; i++) {
		if (Math.abs(g[i]) < 1e-6) g[i] = 0;
		else if (Math.abs(g[i] - 1) < 1e-6) g[i] = 1;
	}
	return g;
}

/** Nominal source-channel positions relative to the puck's offset from front-centre. */
function offsets(from: Layout): ReadonlyArray<readonly [number, number]> {
	switch (from) {
		case 'mono':
			return [[0, 0]];
		case 'stereo':
			return [
				[-1, 0],
				[1, 0],
			];
		case '5.1':
			// L, R, C, LFE (not positioned), Ls, Rs
			return [
				[-1, 0],
				[1, 0],
				[0, 0],
				[0, 0],
				[-1, -2],
				[1, -2],
			];
	}
}

/** Panning matrix `m[out][in]` (6 outputs × source channels) of a `sourceLayout` source through the 5.1 panner. */
export function pan51Matrix(sourceLayout: Layout, p: Pan51 = DEFAULT_PAN51): number[][] {
	const ni = channelCount(sourceLayout);
	const m = Array.from({ length: 6 }, () => new Array<number>(ni).fill(0));
	const offs = offsets(sourceLayout);
	for (let i = 0; i < offs.length; i++) {
		if (sourceLayout === '5.1' && i === CH_LFE) {
			m[CH_LFE][i] = p.lfeGain;
			continue;
		}
		const g = pointGains51(p.x + offs[i][0], p.y + offs[i][1], p.center);
		for (let o = 0; o < 6; o++) m[o][i] = g[o];
		if (sourceLayout !== '5.1') m[CH_LFE][i] = p.lfeGain / ni;
	}
	return m;
}
