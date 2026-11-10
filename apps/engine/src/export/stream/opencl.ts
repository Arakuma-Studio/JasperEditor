// The multi-tap kernel of kernel streams (kernel.ts `drawTaps`) on an OpenCL device, run by the shipped LGPL ffmpeg's
// `program_opencl` filter inside the composite (docs/wp-notes/export-performance.md §10). Node no longer draws the
// pixels: for every frame it writes one raw RGBA frame of `inW × inH` to the stream's pipe — the frame's tap program
// in the first `progRows` rows (one little-endian float32 per pixel) and the member's picture below it (top-left,
// rows of `inW` px) — and the composite runs `hwupload, program_opencl, hwdownload` before its overlay. The OpenCL
// program is `drawTaps` line by line in float32 (the CPU kernel computes in float64 and accumulates in float32);
// derived values (clamped clips, edge gradients, sample bounds) are computed here in float64, as the CPU kernel
// computes them. A stream that does not fit (an image larger than OpenCL guarantees, too many taps or stages) is
// drawn by the CPU kernel and named in `pipeline.kernel.fallbackReasons`.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { endianness, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Ffmpeg } from '../../tools/ffmpeg.ts';
import { filterPath } from '../../tools/filter-text.ts';
import { drawTaps } from './kernel.ts';
import type { TapFrame } from './lowered.ts';
import type { TapStreamPlan } from './tap-plan.ts';

/** Name of the OpenCL device a composite process creates (`-init_hw_device opencl=<name>…`). */
export const OPENCL_DEVICE = 'jcl';
const KERNEL = 'jasper_taps';

/** Header words of a frame program: picture row, taps, opacity / wsum, rect (4), picture size (2), reserved. */
const HDR = 10;
/** Words of a tap: w, map (6), clip (4), gu, gv, lu, hu, lv, hv, stages. */
const TAP = 18;
/** Words of a stage: map (6), rect (4), gu, gv. */
const STG = 12;
/** Taps of one frame the OpenCL program takes (the real project draws up to 40). */
export const OPENCL_MAX_TAPS = 256;
/** Coverage stages of one tap (lowered layers have up to 3: layer box, Transform box, S_Shake canvas). */
export const OPENCL_MAX_STAGES = 8;
/** Largest image side every full-profile OpenCL device supports (CL_DEVICE_IMAGE2D_MAX_WIDTH / HEIGHT ≥ 8192). */
export const OPENCL_MAX_IMAGE = 8192;
/** Narrowest input frame (a small picture still leaves room for a program in few rows). */
const MIN_WIDTH = 64;

/** The OpenCL program (`drawTaps` per output pixel; one work item per pixel of the stream's frame). */
export const TAPS_CL = `// JasperEditor: the multi-tap kernel (apps/engine/src/export/stream/kernel.ts drawTaps) on an OpenCL device.
#define HDR ${HDR}
#define TAP ${TAP}
#define STG ${STG}
__constant sampler_t S = CLK_NORMALIZED_COORDS_FALSE | CLK_ADDRESS_CLAMP_TO_EDGE | CLK_FILTER_NEAREST;

uint4 texel(__read_only image2d_t src, int x, int y) {
	return convert_uint4_sat_rte(read_imagef(src, S, (int2)(x, y)) * 255.0f);
}

float word(__read_only image2d_t src, int w, int i) {
	uint4 b = texel(src, i % w, i / w);
	return as_float(b.x | (b.y << 8) | (b.z << 16) | (b.w << 24));
}

__kernel void ${KERNEL}(__write_only image2d_t dst, unsigned int index, __read_only image2d_t src) {
	const int x = get_global_id(0);
	const int y = get_global_id(1);
	const int iw = get_image_width(src);
	const int n = (int)word(src, iw, 1);
	if (n <= 0 || x < (int)word(src, iw, 3) || y < (int)word(src, iw, 4) || x >= (int)word(src, iw, 5) ||
		y >= (int)word(src, iw, 6)) {
		write_imagef(dst, (int2)(x, y), (float4)(0.0f));
		return;
	}
	const int py = (int)word(src, iw, 0);
	const float op = word(src, iw, 2);
	const int maxU = (int)word(src, iw, 7) - 1;
	const int maxV = (int)word(src, iw, 8) - 1;
	const float X = x + 0.5f;
	const float Y = y + 0.5f;
	float ar = 0.0f, ag = 0.0f, ab = 0.0f, aa = 0.0f;
	int p = HDR;
	for (int t = 0; t < n; t++) {
		const float w = word(src, iw, p);
		const float m0 = word(src, iw, p + 1), m1 = word(src, iw, p + 2), m2 = word(src, iw, p + 3);
		const float m3 = word(src, iw, p + 4), m4 = word(src, iw, p + 5), m5 = word(src, iw, p + 6);
		const float cu0 = word(src, iw, p + 7), cv0 = word(src, iw, p + 8);
		const float cu1 = word(src, iw, p + 9), cv1 = word(src, iw, p + 10);
		const float gu = word(src, iw, p + 11), gv = word(src, iw, p + 12);
		const float lu = word(src, iw, p + 13), hu = word(src, iw, p + 14);
		const float lv = word(src, iw, p + 15), hv = word(src, iw, p + 16);
		const int ns = (int)word(src, iw, p + 17);
		const int q0 = p + TAP;
		p = q0 + ns * STG;
		const float u = m0 * X + m1 * Y + m2;
		const float v = m3 * X + m4 * Y + m5;
		float cu = 0.5f + fmin(u - cu0, cu1 - u) * gu;
		if (cu <= 0.0f) continue;
		float cv = 0.5f + fmin(v - cv0, cv1 - v) * gv;
		if (cv <= 0.0f) continue;
		if (cu > 1.0f) cu = 1.0f;
		if (cv > 1.0f) cv = 1.0f;
		float cover = cu * cv;
		for (int s = 0; s < ns; s++) {
			const int q = q0 + s * STG;
			const float zu = word(src, iw, q) * X + word(src, iw, q + 1) * Y + word(src, iw, q + 2);
			const float zv = word(src, iw, q + 3) * X + word(src, iw, q + 4) * Y + word(src, iw, q + 5);
			float ku = 0.5f + fmin(zu - word(src, iw, q + 6), word(src, iw, q + 8) - zu) * word(src, iw, q + 10);
			float kv = 0.5f + fmin(zv - word(src, iw, q + 7), word(src, iw, q + 9) - zv) * word(src, iw, q + 11);
			if (ku <= 0.0f || kv <= 0.0f) {
				cover = 0.0f;
				break;
			}
			if (ku > 1.0f) ku = 1.0f;
			if (kv > 1.0f) kv = 1.0f;
			cover *= ku * kv;
		}
		if (!(cover > 0.0f)) continue;
		float su = (u < lu ? lu : u > hu ? hu : u) - 0.5f;
		float sv = (v < lv ? lv : v > hv ? hv : v) - 0.5f;
		if (su < 0.0f) su = 0.0f;
		else if (su > maxU) su = maxU;
		if (sv < 0.0f) sv = 0.0f;
		else if (sv > maxV) sv = maxV;
		const int iu = (int)su;
		const int iv = (int)sv;
		const float fx = su - iu;
		const float fy = sv - iv;
		const int iu1 = iu < maxU ? iu + 1 : iu;
		const int iv1 = iv < maxV ? iv + 1 : iv;
		const uint4 t00 = texel(src, iu, py + iv);
		const uint4 t10 = texel(src, iu1, py + iv);
		const uint4 t01 = texel(src, iu, py + iv1);
		const uint4 t11 = texel(src, iu1, py + iv1);
		const float a00 = t00.w * (1.0f - fx) * (1.0f - fy);
		const float a10 = t10.w * fx * (1.0f - fy);
		const float a01 = t01.w * (1.0f - fx) * fy;
		const float a11 = t11.w * fx * fy;
		const float a = a00 + a10 + a01 + a11;
		if (a <= 0.0f) continue;
		const float k = w * cover;
		ar += (k * (t00.x * a00 + t10.x * a10 + t01.x * a01 + t11.x * a11)) / 255.0f;
		ag += (k * (t00.y * a00 + t10.y * a10 + t01.y * a01 + t11.y * a11)) / 255.0f;
		ab += (k * (t00.z * a00 + t10.z * a10 + t01.z * a01 + t11.z * a11)) / 255.0f;
		aa += k * a;
	}
	if (!(aa > 0.0f)) {
		write_imagef(dst, (int2)(x, y), (float4)(0.0f));
		return;
	}
	const float kk = 255.0f / aa;
	const float r = ar * kk;
	const float g = ag * kk;
	const float b = ab * kk;
	const float al = aa * op;
	const float4 px = floor((float4)(r > 255.0f ? 255.0f : r, g > 255.0f ? 255.0f : g, b > 255.0f ? 255.0f : b,
		al > 255.0f ? 255.0f : al) + 0.5f);
	write_imagef(dst, (int2)(x, y), px / 255.0f);
}
`;

/** How a kernel stream's frames go to the OpenCL program (set on `TapStreamPlan.gpu` when the stream uses it). */
export type GpuTapLayout = {
	/** Input frame size (program rows + picture rows). */
	inW: number;
	inH: number;
	/** Rows of the program; the picture starts at this row. */
	progRows: number;
	/** Rows of the picture canvas (the largest picture of the stream). */
	picH: number;
	/** The OpenCL program file `program_opencl` loads. */
	source: string;
};

/** Words of a frame's OpenCL program (upper bound: every tap counted). */
function programWords(prog: ArrayLike<number>): { words: number; taps: number; stages: number } {
	const n = prog[0]! | 0;
	let p = 2;
	let words = HDR;
	let stages = 0;
	for (let t = 0; t < n; t++) {
		const ns = prog[p + 11]! | 0;
		stages = Math.max(stages, ns);
		words += TAP + ns * STG;
		p += 12 + ns * 10;
	}
	return { words, taps: n, stages };
}

/**
 * The input layout of a stream drawn by the OpenCL program, or why it stays on the CPU kernel. Every frame's
 * program fits in `progRows` rows and every member's picture (each mip level) in the canvas.
 */
export function gpuTapLayout(
	plan: TapStreamPlan,
	source: string,
): { layout: GpuTapLayout } | { reason: string } {
	let picW = 1;
	let picH = 1;
	let words = HDR;
	for (const m of plan.members) {
		for (const p of m.pictures) {
			picW = Math.max(picW, p.w);
			picH = Math.max(picH, p.h);
		}
		for (const f of m.frames) {
			if (!f.rect) continue;
			const pw = programWords(f.prog);
			if (pw.taps > OPENCL_MAX_TAPS)
				return { reason: `a frame draws ${pw.taps} taps (the OpenCL kernel takes ${OPENCL_MAX_TAPS})` };
			if (pw.stages > OPENCL_MAX_STAGES)
				return {
					reason: `a tap has ${pw.stages} coverage stages (the OpenCL kernel takes ${OPENCL_MAX_STAGES})`,
				};
			words = Math.max(words, pw.words);
		}
	}
	const inW = Math.max(MIN_WIDTH, picW);
	const progRows = Math.ceil(words / inW);
	const inH = progRows + picH;
	if (inW > OPENCL_MAX_IMAGE || inH > OPENCL_MAX_IMAGE)
		return { reason: `a ${picW}×${picH} px picture is larger than an OpenCL image (${OPENCL_MAX_IMAGE} px)` };
	if (plan.outW > OPENCL_MAX_IMAGE || plan.outH > OPENCL_MAX_IMAGE)
		return { reason: `a ${plan.outW}×${plan.outH} px stream is larger than an OpenCL image` };
	return { layout: { inW, inH, progRows, picH, source } };
}

/** Whether `frame`'s program and `pic` still fit `layout` (a pipelined still re-planned its member). */
export function fitsLayout(
	layout: GpuTapLayout,
	pics: readonly { w: number; h: number }[],
	frames: readonly TapFrame[],
): boolean {
	if (pics.some((p) => p.w > layout.inW || p.h > layout.picH)) return false;
	const cap = layout.progRows * layout.inW;
	return frames.every((f) => {
		if (!f.rect) return true;
		const pw = programWords(f.prog);
		return pw.words <= cap && pw.taps <= OPENCL_MAX_TAPS && pw.stages <= OPENCL_MAX_STAGES;
	});
}

/**
 * Writes the OpenCL program of one frame (`drawTaps` arguments: `prog`, `opacity`, `rect` in the stream's frame of
 * `dw × dh`, a picture of `cw × ch`) into `out` (`progRows × inW` words, the rest zeroed). Null frame = transparent.
 */
export function encodeGpuFrame(
	layout: GpuTapLayout,
	frame: { prog: ArrayLike<number>; opacity: number; rect: ArrayLike<number> | null } | null,
	cw: number,
	ch: number,
	dw: number,
	dh: number,
	out: Float32Array,
): void {
	out.fill(0);
	out[0] = layout.progRows;
	if (!frame?.rect) return;
	const prog = frame.prog;
	const nTaps = prog[0]! | 0;
	const wsum = prog[1]!;
	const rect = frame.rect;
	if (!(frame.opacity > 0) || nTaps < 1 || !(wsum > 0) || cw < 1 || ch < 1) return;
	const x0 = Math.max(0, Math.floor(rect[0]!));
	const y0 = Math.max(0, Math.floor(rect[1]!));
	const x1 = Math.min(dw, Math.ceil(rect[2]!));
	const y1 = Math.min(dh, Math.ceil(rect[3]!));
	if (x1 <= x0 || y1 <= y0) return;
	out[2] = Math.min(1, frame.opacity) / wsum;
	out[3] = x0;
	out[4] = y0;
	out[5] = x1;
	out[6] = y1;
	out[7] = cw;
	out[8] = ch;
	let n = 0;
	let o = HDR;
	let p = 2;
	for (let t = 0; t < nTaps; t++) {
		const w = prog[p]!;
		const m = [prog[p + 1]!, prog[p + 2]!, prog[p + 3]!, prog[p + 4]!, prog[p + 5]!, prog[p + 6]!];
		const cu0 = Math.max(0, prog[p + 7]!);
		const cv0 = Math.max(0, prog[p + 8]!);
		const cu1 = Math.min(cw, prog[p + 9]!);
		const cv1 = Math.min(ch, prog[p + 10]!);
		const ns = prog[p + 11]! | 0;
		const sp = p + 12;
		p = sp + ns * 10;
		// (skipped by the CPU kernel too)
		if (!(w > 0) || cu1 <= cu0 || cv1 <= cv0) continue;
		n++;
		out[o] = w;
		for (let k = 0; k < 6; k++) out[o + 1 + k] = m[k]!;
		out[o + 7] = cu0;
		out[o + 8] = cv0;
		out[o + 9] = cu1;
		out[o + 10] = cv1;
		out[o + 11] = 1 / Math.hypot(m[0]!, m[1]!);
		out[o + 12] = 1 / Math.hypot(m[3]!, m[4]!);
		out[o + 13] = Math.min(cu0 + 0.5, (cu0 + cu1) / 2);
		out[o + 14] = Math.max(cu1 - 0.5, (cu0 + cu1) / 2);
		out[o + 15] = Math.min(cv0 + 0.5, (cv0 + cv1) / 2);
		out[o + 16] = Math.max(cv1 - 0.5, (cv0 + cv1) / 2);
		out[o + 17] = ns;
		o += TAP;
		for (let s = 0; s < ns; s++, o += STG) {
			const q = sp + s * 10;
			for (let k = 0; k < 10; k++) out[o + k] = prog[q + k]!;
			out[o + 10] = 1 / Math.hypot(prog[q]!, prog[q + 1]!);
			out[o + 11] = 1 / Math.hypot(prog[q + 3]!, prog[q + 4]!);
		}
	}
	out[1] = n;
}

/** The filters that turn a stream's input frames into its drawn `outW × outH` RGBA frames on the OpenCL device. */
export function gpuTapFilters(layout: GpuTapLayout, outW: number, outH: number): string[] {
	return [
		'hwupload',
		`program_opencl=source=${filterPath(layout.source)}:kernel=${KERNEL}:size=${outW}x${outH}`,
		'hwdownload',
		'format=rgba',
	];
}

/** Global arguments of a process whose streams use the OpenCL program (before its inputs). */
export function openClDeviceArgs(init: string): string[] {
	return ['-init_hw_device', init, '-filter_hw_device', OPENCL_DEVICE];
}

export type OpenClPolicy = {
	/** `auto` (default): the OpenCL kernel when a device passes the probe; `off`: the CPU kernel (`JASPER_EXPORT_OPENCL=0`). */
	mode: 'auto' | 'off';
	/**
	 * `-init_hw_device` value: a GPU device by default (`JASPER_EXPORT_OPENCL_DEVICE` unset or `gpu`) — an OpenCL
	 * runtime on the CPU would take the cores the kernel is moved off —; `any` = the first device; else ffmpeg's
	 * `<platform>.<device>` index.
	 */
	init: string;
};

export function openClPolicyFromEnv(env: Record<string, string | undefined> = process.env): OpenClPolicy {
	const v = env.JASPER_EXPORT_OPENCL;
	const d = env.JASPER_EXPORT_OPENCL_DEVICE?.trim();
	const init =
		!d || d === 'gpu'
			? `opencl=${OPENCL_DEVICE}:,device_type=gpu`
			: d === 'any'
				? `opencl=${OPENCL_DEVICE}`
				: /^\d+\.\d+$/.test(d)
					? `opencl=${OPENCL_DEVICE}:${d}`
					: `opencl=${OPENCL_DEVICE}:,device_type=gpu`;
	return { mode: v === '0' || v === 'off' ? 'off' : 'auto', init };
}

/** What the composite needs to draw kernel streams on the OpenCL device. */
export type OpenClTaps = { init: string; source: string };

const SOURCE_HASH = createHash('sha256').update(TAPS_CL).digest('hex').slice(0, 16);

/** Writes the OpenCL program file (content-addressed, atomically) and returns its path. */
async function writeSource(): Promise<string> {
	const dir = join(tmpdir(), 'jasper-opencl');
	const file = join(dir, `taps-${SOURCE_HASH}.cl`);
	try {
		if ((await stat(file)).isFile() && (await readFile(file, 'utf8')) === TAPS_CL) return file;
	} catch {
		// written below
	}
	await mkdir(dir, { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, TAPS_CL);
	await rename(tmp, file);
	return file;
}

/** A small program with rotated, scaled, partly transparent taps and stages: the probe's self-test. */
function selfTestCase() {
	const cw = 23;
	const ch = 17;
	const pic = new Uint8Array(cw * ch * 4);
	for (let y = 0; y < ch; y++)
		for (let x = 0; x < cw; x++) {
			const o = (y * cw + x) * 4;
			pic[o] = (x * 37 + y * 11) & 255;
			pic[o + 1] = (x * 5 + y * 23 + 40) & 255;
			pic[o + 2] = (255 - x * 9) & 255;
			pic[o + 3] = x < 2 || y > 14 ? 0 : (60 + x * 13 + y * 7) & 255 || 255;
		}
	const dw = 37;
	const dh = 29;
	const prog: number[] = [3, 0];
	for (const [w, a, k, dx, dy] of [
		[0.5, 0.2, 0.8, -3.2, -2.1],
		[1, -0.15, 0.7, -4.6, -1.3],
		[0.75, 0.05, 0.9, -2.4, -3.7],
	] as const) {
		prog[1] += w;
		const c = Math.cos(a) * k;
		const s = Math.sin(a) * k;
		prog.push(w, c, s, dx, -s, c, dy, 0.4, 0, cw - 0.3, ch, 2);
		prog.push(1, 0, -2.5, 0, 1, -1.5, 0, 0, 30.5, 22.25);
		prog.push(c, -s, 1.5, s, c, 0.5, 1, 2, 24, 18);
	}
	return { cw, ch, pic, dw, dh, prog, opacity: 0.85, rect: [1, 2, dw - 1, dh - 1] };
}

const probes = new Map<string, Promise<{ ok: true; taps: OpenClTaps } | { ok: false; reason: string }>>();

/**
 * Whether this ffmpeg draws kernel streams on an OpenCL device: the device opens, `program_opencl` builds the
 * program, and a self-test frame drawn by it matches the CPU kernel within 2 levels per channel (one run, remembered
 * per ffmpeg binary and device for the engine's lifetime; the program file is written again when it is missing).
 */
export function probeOpenClTaps(
	ff: Ffmpeg,
	policy: OpenClPolicy = openClPolicyFromEnv(),
): Promise<{ ok: true; taps: OpenClTaps } | { ok: false; reason: string }> {
	if (policy.mode === 'off')
		return Promise.resolve({ ok: false, reason: 'the OpenCL kernel is off (JASPER_EXPORT_OPENCL=0)' });
	if (endianness() !== 'LE')
		return Promise.resolve({ ok: false, reason: 'frame programs are written little-endian' });
	const key = `${ff.bins.ffmpeg ?? ''}|${policy.init}`;
	let p = probes.get(key);
	if (!p) {
		p = runProbe(ff, policy.init);
		probes.set(key, p);
	}
	return p.then(async (r) => (r.ok ? { ok: true, taps: { ...r.taps, source: await writeSource() } } : r));
}

async function runProbe(
	ff: Ffmpeg,
	init: string,
): Promise<{ ok: true; taps: OpenClTaps } | { ok: false; reason: string }> {
	let dir: string | null = null;
	try {
		const source = await writeSource();
		dir = join(tmpdir(), 'jasper-opencl', `probe-${process.pid}-${Date.now()}`);
		await mkdir(dir, { recursive: true });
		const c = selfTestCase();
		const plan = {
			members: [{ pictures: [{ w: c.cw, h: c.ch }], frames: [{ rect: c.rect, prog: c.prog }] }],
			outW: c.dw,
			outH: c.dh,
		} as unknown as TapStreamPlan;
		const r = gpuTapLayout(plan, source);
		if (!('layout' in r)) return { ok: false, reason: r.reason };
		const { layout } = r;
		const frame = Buffer.alloc(layout.inW * layout.inH * 4);
		const words = new Float32Array(frame.buffer, frame.byteOffset, layout.progRows * layout.inW);
		encodeGpuFrame(layout, c, c.cw, c.ch, c.dw, c.dh, words);
		for (let y = 0; y < c.ch; y++)
			frame.set(c.pic.subarray(y * c.cw * 4, (y + 1) * c.cw * 4), (layout.progRows + y) * layout.inW * 4);
		const input = join(dir, 'in.rgba');
		const output = join(dir, 'out.rgba');
		await writeFile(input, frame);
		await ff.run(
			[
				...openClDeviceArgs(init),
				...['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${layout.inW}x${layout.inH}`, '-framerate', '1'],
				...['-i', input, '-vf', gpuTapFilters(layout, c.dw, c.dh).join(',')],
				...['-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', output],
			],
			{ signal: AbortSignal.timeout(60_000) },
		);
		const got = new Uint8Array(await readFile(output));
		const want = new Uint8Array(c.dw * c.dh * 4);
		drawTaps(
			c.pic,
			c.cw,
			c.cw,
			c.ch,
			want,
			c.dw,
			c.dh,
			c.prog,
			c.opacity,
			c.rect,
			new Float32Array(want.length),
		);
		if (got.length !== want.length)
			return { ok: false, reason: `the OpenCL kernel wrote ${got.length} of ${want.length} bytes` };
		let worst = 0;
		for (let i = 0; i < want.length; i++) worst = Math.max(worst, Math.abs(got[i]! - want[i]!));
		if (worst > 2)
			return { ok: false, reason: `the OpenCL kernel differs from the CPU kernel by ${worst} levels` };
		return { ok: true, taps: { init, source } };
	} catch (e) {
		return { ok: false, reason: `no OpenCL device: ${(e as Error).message.split('\n')[0]!.slice(0, 200)}` };
	} finally {
		if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}
