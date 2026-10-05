// Keyframed Motion, Opacity, crop edges and audio levels on the native path (S03:ENG-032, S04:RN-020, wave1
// native-animated-export): the piecewise fit, the planner (these clips plan `native` and the warp stage leaves them
// to the builder), exported frames against the evaluated geometry (every keyframe kind: linear, eased, hold) and
// keyframed volume against the per-frame gain. Real ffmpeg (the engine's build). With REMOTION_E2E=1 the same
// fixture is also rendered by Remotion and compared frame by frame (S03:FX-040 / ENG-033: SSIM ≥ 0.98); with
// NATIVE_ANIM_BENCH=1 a 10 s 1080p fixture is timed on the native and the Remotion path.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMat3, invertMat3, layerMapOf, type Mat3, resolveSceneAt, type Vec2 } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fitPieces, pieceValue, piecewiseExpr } from '../src/export/keyframed.ts';
import { buildNativeGraph } from '../src/export/native.ts';
import { nativeBlockers } from '../src/export/planner.ts';
import { drawLayer } from '../src/export/stream/kernel.ts';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	JSON_H,
	makeApp,
	register,
	type TestApp,
	tempAppdir,
	until,
} from './helpers.ts';

const FWD_ENV: Record<string, string> = {};
for (const k of ['JASPER_FFMPEG', 'JASPER_FFPROBE']) if (process.env[k]) FWD_ENV[k] = process.env[k]!;
const REMOTION = process.env.REMOTION_E2E === '1';
const BENCH = process.env.NATIVE_ANIM_BENCH === '1';
const PORT = Number(process.env.JASPER_E2E_PORT ?? 0);
const W = 1920;
const H = 1080;

/** Measurements: console and `<tmp>/native-animated.txt` (Vitest hides the console of passing tests). */
function report(line: string): void {
	console.info(line);
	appendFileSync(join(tmpdir(), 'native-animated.txt'), `${new Date().toISOString()} ${line}\n`);
}

// ---- fixture: a 640×360 card (white 40 px frame around a 7×4 grid of saturated cells) on a dark plate

const CELL_COLORS: [number, number, number][] = [
	[230, 30, 30],
	[30, 200, 40],
	[40, 60, 220],
	[240, 220, 20],
	[20, 210, 220],
	[210, 40, 200],
	[250, 140, 20],
];
const CARD = { w: 640, h: 360, border: 40, cols: 7, rows: 4 };
const PLATE: [number, number, number] = [20, 20, 20];

/**
 * Card colour at a card point, or null within `EDGE` card px of a boundary (edge-excluded: bilinear fringe plus the
 * ProRes 4444 export's DCT ringing next to saturated edges) or outside.
 */
const EDGE = 7;
function cardColorAt(u: number, v: number): [number, number, number] | null {
	const { w, h, border, cols, rows } = CARD;
	if (u < EDGE || v < EDGE || u > w - EDGE || v > h - EDGE) return null;
	const near = (x: number, lines: number[]) => lines.some((l) => Math.abs(x - l) < EDGE);
	if (near(u, [border, w - border]) || near(v, [border, h - border])) return null;
	if (u < border || v < border || u > w - border || v > h - border) return [255, 255, 255];
	const cw = (w - 2 * border) / cols;
	const ch = (h - 2 * border) / rows;
	const cu = (u - border) / cw;
	const cv = (v - border) / ch;
	if (Math.abs(cu - Math.round(cu)) * cw < EDGE || Math.abs(cv - Math.round(cv)) * ch < EDGE) return null;
	return CELL_COLORS[(Math.floor(cu) + 3 * Math.floor(cv)) % CELL_COLORS.length]!;
}

function makeCard(): string {
	const { w, h, border, cols, rows } = CARD;
	const raw = Buffer.alloc(w * h * 3);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			let c: [number, number, number] = [255, 255, 255];
			const u = x + 0.5;
			const v = y + 0.5;
			if (u > border && v > border && u < w - border && v < h - border) {
				const cu = Math.floor((u - border) / ((w - 2 * border) / cols));
				const cv = Math.floor((v - border) / ((h - 2 * border) / rows));
				c = CELL_COLORS[(cu + 3 * cv) % CELL_COLORS.length]!;
			}
			raw.set(c, (y * w + x) * 3);
		}
	const dir = mkdtempSync(join(tmpdir(), 'jasper-anim-card-'));
	writeFileSync(join(dir, 'card.rgb'), raw);
	const out = join(dir, 'card.png');
	const r = spawnSync('ffmpeg', [
		...['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`],
		...['-i', join(dir, 'card.rgb'), '-frames:v', '1', out],
	]);
	if (r.status !== 0) throw new Error(r.stderr.toString());
	return out;
}

/** The keyframes of the fixture (sequence frames): linear, eased (Bezier), hold, non-uniform scale. */
function animateCard(d: DocBuilder, clip: string): void {
	const at = (f: number) => ({ sequenceFrame: f });
	const t = (p: string) => ['clip', clip, 'transform', p];
	const ease = { influence: 0.6, slope: 0 };
	d.tx([
		{ type: 'keyframe.add', target: t('position'), at: at(0), value: [520, 380] },
		{
			type: 'keyframe.add',
			target: t('position'),
			at: at(18),
			value: [1300, 620],
			interpolation: 'bezier',
			easeIn: ease,
			easeOut: ease,
		},
		{ type: 'keyframe.add', target: t('position'), at: at(34), value: [880, 330], interpolation: 'hold' },
		{ type: 'keyframe.add', target: t('position'), at: at(44), value: [1350, 760] },
		{ type: 'keyframe.add', target: t('anchor'), at: at(0), value: [320, 180] },
		{ type: 'keyframe.add', target: t('anchor'), at: at(47), value: [250, 140] },
		{ type: 'keyframe.add', target: t('rotation'), at: at(0), value: -24 },
		{
			type: 'keyframe.add',
			target: t('rotation'),
			at: at(40),
			value: 33,
			interpolation: 'bezier',
			easeIn: ease,
			easeOut: ease,
		},
		{ type: 'keyframe.add', target: t('scale'), at: at(0), value: 70 },
		{ type: 'keyframe.add', target: t('scale'), at: at(30), value: 145 },
		{ type: 'keyframe.add', target: ['clip', clip, 'opacity'], at: at(0), value: 100 },
		{ type: 'keyframe.add', target: ['clip', clip, 'opacity'], at: at(24), value: 45 },
		{ type: 'keyframe.add', target: ['clip', clip, 'opacity'], at: at(47), value: 85 },
	]);
}

/** Plate: a dark solid (V1) and the animated card (V2), 48 frames of a 1080p30 sequence. */
async function cardDoc(
	app: TestApp | RunningEngine['app'],
	hostH: Record<string, string> = {},
	animate = true,
) {
	const card = await register(app, makeCard(), hostH);
	const d = new DocBuilder();
	const cardId = d.addMedia(card);
	d.tx([
		{ type: 'clip.addSolid', at: 0, duration: 48, track: 'V1', color: [20 / 255, 20 / 255, 20 / 255, 1] },
	]);
	const r = d.tx([
		{ type: 'clip.place', source: { mediaId: cardId }, at: 0, tracks: { video: 'V2' }, ref: '$c' },
	]);
	const clip = r.refs.$c!;
	if (animate) animateCard(d, clip);
	return { d, clip };
}

const proresSettings = (seqId: string, engine: 'auto' | 'native' | 'remotion' = 'auto') => ({
	sequenceId: seqId,
	range: { type: 'custom', startFrame: 0, endFrame: 48 },
	container: 'mov',
	engine,
	video: {
		codec: 'prores',
		proresProfile: '4444',
		width: W,
		height: H,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 10 },
		encoderSpeed: 'fast',
		colorTags: 'rec709',
	},
});

const h264Settings = (seqId: string, engine: 'auto' | 'native' | 'remotion' = 'auto') => ({
	sequenceId: seqId,
	range: { type: 'custom', startFrame: 0, endFrame: 48 },
	container: 'mp4',
	engine,
	video: {
		codec: 'h264',
		width: W,
		height: H,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 18 },
		encoderSpeed: 'fast',
		colorTags: 'rec709',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
});

type Img = { rgb: Buffer; w: number; h: number };

/** Every frame of a file as RGB. */
function decodeAll(file: string): Img[] {
	const r = spawnSync(
		'ffmpeg',
		['-v', 'error', '-i', file, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
		{
			maxBuffer: 1 << 30,
		},
	);
	if (r.status !== 0) throw new Error(`decode failed: ${r.stderr}`);
	const size = W * H * 3;
	return Array.from({ length: r.stdout.length / size }, (_, i) => ({
		rgb: r.stdout.subarray(i * size, (i + 1) * size),
		w: W,
		h: H,
	}));
}

const lum = (img: Img, x: number, y: number) => {
	const o = (y * img.w + x) * 3;
	return (img.rgb[o]! + img.rgb[o + 1]! + img.rgb[o + 2]!) / 3;
};

/**
 * Sub-pixel edge crossings of the (white-framed) card against the dark plate along scanlines, one straight edge
 * of the resolved quad at a time; lines fitted through them intersect in the measured corners.
 */
function measureCorners(img: Img, quad: readonly Vec2[], plate: number): Vec2[] {
	type Line = { p: Vec2; d: Vec2 };
	const lines: Line[] = [];
	const cx = quad.reduce((s, q) => s + q[0], 0) / 4;
	const cy = quad.reduce((s, q) => s + q[1], 0) / 4;
	for (let e = 0; e < 4; e++) {
		const a = quad[e]!;
		const b = quad[(e + 1) % 4]!;
		const horizontalScan = Math.abs(b[1] - a[1]) > Math.abs(b[0] - a[0]);
		const pts: Vec2[] = [];
		for (let t = 0.2; t <= 0.8; t += 0.02) {
			const px = a[0] + (b[0] - a[0]) * t;
			const py = a[1] + (b[1] - a[1]) * t;
			if (px < 8 || py < 8 || px > img.w - 8 || py > img.h - 8) continue;
			if (horizontalScan) {
				const y = Math.floor(py);
				const dir = cx > px ? 1 : -1;
				const x0 = Math.round(px) - 6 * dir;
				const white = lum(img, Math.round(px) + 6 * dir, y);
				const mid = (plate + white) / 2;
				for (let k = 0; k < 12; k++) {
					const xa = x0 + k * dir;
					const va = lum(img, xa, y);
					const vb = lum(img, xa + dir, y);
					if (va < mid && vb >= mid) {
						const s = (mid - va) / (vb - va);
						pts.push([xa + 0.5 + s * dir, y + 0.5]);
						break;
					}
				}
			} else {
				const x = Math.floor(px);
				const dir = cy > py ? 1 : -1;
				const y0 = Math.round(py) - 6 * dir;
				const white = lum(img, x, Math.round(py) + 6 * dir);
				const mid = (plate + white) / 2;
				for (let k = 0; k < 12; k++) {
					const ya = y0 + k * dir;
					const va = lum(img, x, ya);
					const vb = lum(img, x, ya + dir);
					if (va < mid && vb >= mid) {
						const s = (mid - va) / (vb - va);
						pts.push([x + 0.5, ya + 0.5 + s * dir]);
						break;
					}
				}
			}
		}
		expect(pts.length).toBeGreaterThan(8);
		const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
		const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
		let sxx = 0;
		let sxy = 0;
		let syy = 0;
		for (const [x, y] of pts) {
			sxx += (x - mx) ** 2;
			sxy += (x - mx) * (y - my);
			syy += (y - my) ** 2;
		}
		const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
		lines.push({ p: [mx, my], d: [Math.cos(ang), Math.sin(ang)] });
	}
	const corners: Vec2[] = [];
	for (let i = 0; i < 4; i++) {
		const l1 = lines[(i + 3) % 4]!;
		const l2 = lines[i]!;
		const den = l1.d[0] * l2.d[1] - l1.d[1] * l2.d[0];
		const t = ((l2.p[0] - l1.p[0]) * l2.d[1] - (l2.p[1] - l1.p[1]) * l2.d[0]) / den;
		corners.push([l1.p[0] + t * l1.d[0], l1.p[1] + t * l1.d[1]]);
	}
	return corners;
}

/** Max colour error over pixels whose card point is ≥ 3 px away from every card boundary. */
function colourError(img: Img, map: Mat3, opacity: number) {
	const inv = invertMat3(map)!;
	let max = 0;
	let count = 0;
	let sum = 0;
	let where = '';
	for (let y = 0; y < img.h; y += 3)
		for (let x = 0; x < img.w; x += 3) {
			const [u, v] = applyMat3(inv, [x + 0.5, y + 0.5]);
			const c = cardColorAt(u, v);
			if (!c) continue;
			const o = (y * img.w + x) * 3;
			for (let k = 0; k < 3; k++) {
				const want = c[k]! * opacity + PLATE[k]! * (1 - opacity);
				const e = Math.abs(img.rgb[o + k]! - want);
				if (e > max)
					where = `(${x},${y}) u ${u.toFixed(1)} v ${v.toFixed(1)} ch ${k} got ${img.rgb[o + k]} want ${want}`;
				max = Math.max(max, e);
				sum += e;
			}
			count++;
		}
	return { max, count, where, mean: sum / Math.max(1, 3 * count) };
}

/** Mean SSIM (all planes, ffmpeg `ssim`) of frame `frame` of two files. */
function ssim(a: string, b: string, frame: number): number {
	const sel = `select=eq(n\\,${frame}),setpts=PTS-STARTPTS,format=yuv444p`;
	const r = spawnSync('ffmpeg', [
		...['-v', 'info', '-i', a, '-i', b],
		...['-filter_complex', `[0:v]${sel}[a];[1:v]${sel}[b];[a][b]ssim`, '-frames:v', '1', '-f', 'null', '-'],
	]);
	const m = /SSIM .*All:([0-9.]+)/.exec(r.stderr.toString());
	if (!m) throw new Error(`ssim failed: ${r.stderr.toString().slice(-2000)}`);
	return Number(m[1]);
}

/** Share of RGB samples within `tol` code values. */
function within(a: Img, b: Img, tol: number): number {
	let n = 0;
	for (let i = 0; i < a.rgb.length; i++) if (Math.abs(a.rgb[i]! - b.rgb[i]!) <= tol) n++;
	return n / a.rgb.length;
}

const GPL_FILTERS = [
	'eq',
	'perspective',
	'boxblur',
	'hqdn3d',
	'smartblur',
	'delogo',
	'frei0r',
	'spp',
	'pp7',
	'uspp',
	'fspp',
	'mpdecimate',
	'pullup',
];

// ---- the piecewise fit (no ffmpeg)

describe('per-frame samples → piecewise-linear expressions (S03:ENG-032)', () => {
	it('stays within tolerance, keeps holds exact and grows with the curve, not the clip length', () => {
		const n = 3000;
		const eased = Float64Array.from({ length: n }, (_, k) => {
			const x = (k % 300) / 300;
			return 1000 * (x * x * (3 - 2 * x)) + (k >= 1500 ? 400 : 0); // eased ramps + a step at 1500
		});
		const pieces = fitPieces(eased, 0.1);
		for (let k = 0; k < n; k++) expect(Math.abs(pieceValue(pieces, k) - eased[k]!)).toBeLessThanOrEqual(0.1);
		// The step is exact on both sides of the jump.
		expect(pieceValue(pieces, 1499)).toBeCloseTo(eased[1499]!, 9);
		expect(pieceValue(pieces, 1500)).toBeCloseTo(eased[1500]!, 9);
		// A 1000 px ease over 10 s (curvature ≤ 0.067 px/frame²) needs pieces of ~3 frames at 0.1 px.
		expect(pieces.length).toBeLessThan(n / 2.5);
		const linear = Float64Array.from({ length: 100_000 }, (_, k) => 3 + k * 0.25);
		expect(fitPieces(linear, 0.02).length).toBeLessThanOrEqual(Math.ceil(100_000 / 1024) + 1);
		expect(piecewiseExpr(fitPieces(new Float64Array(500).fill(7), 0.02), 't*30/1')).toBe('7');
		const expr = piecewiseExpr(pieces, 't*30/1');
		expect(expr.startsWith('st(0,t*30/1);')).toBe(true);
		// Balanced tree: nesting depth ~ log2(pieces).
		let depth = 0;
		let maxDepth = 0;
		for (const ch of expr) {
			if (ch === '(') maxDepth = Math.max(maxDepth, ++depth);
			if (ch === ')') depth--;
		}
		expect(maxDepth).toBeLessThan(4 * Math.ceil(Math.log2(pieces.length + 1)) + 6);
	});
});

// ---- engine (real ffmpeg)

let app: TestApp;
beforeAll(async () => {
	ensureFixtures();
	app = await makeApp({ env: FWD_ENV });
}, 180_000);
afterAll(closeApps);

async function plan(d: DocBuilder, settings: Record<string, unknown>) {
	const r = await app.inject({
		method: 'POST',
		url: '/api/exports/plan',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings },
	});
	expect(r.statusCode, r.body).toBe(200);
	return r.json() as { path: string; blockers: { itemId?: string; reason: string }[] };
}

async function runExport(d: DocBuilder, settings: Record<string, unknown>) {
	const start = await app.inject({
		method: 'POST',
		url: '/api/exports',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings },
	});
	expect(start.statusCode, start.body).toBe(202);
	const done = await coreServices(app).queue.wait(start.json().id);
	expect(done.error, JSON.stringify(done.error)).toBeUndefined();
	return { done, out: (await coreServices(app).exports.outputFile(done.id))! };
}

describe('planner: keyframed layers and levels are native', () => {
	it('keyframed Motion, Opacity and crop edges plan native without the warp stage; blur, pan stay blocked', async () => {
		const { d, clip } = await cardDoc(app);
		const fx = d.tx([
			{
				type: 'effect.add',
				target: { clipId: clip },
				effectId: 'jasper.crop',
				params: { left: 5 },
				ref: '$fx',
			},
		]);
		d.tx([
			{ type: 'keyframe.add', target: ['effect', fx.refs.$fx, 'top'], at: { sequenceFrame: 0 }, value: 0 },
			{ type: 'keyframe.add', target: ['effect', fx.refs.$fx, 'top'], at: { sequenceFrame: 30 }, value: 40 },
		]);
		const p = await plan(d, h264Settings(d.seqId));
		expect(p).toMatchObject({ path: 'native', blockers: [] });

		// The generic checks alone (no extension) accept the layer; the warp stage does not claim it.
		const planned = await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: h264Settings(d.seqId) as never,
		});
		const c = planned.snapshot.videoTracks.flatMap((t) => t.clips).find((x) => x.clipId === clip)!;
		const caps = { native: true, remotionLocal: 'ready', fframes: 'ready', mgMasters: true } as const;
		expect(nativeBlockers(c, caps, [])).toEqual([]);
		// The same keyframes on an fframes motion graphic (never claimed by the warp stage): native too.
		const mg = {
			...c,
			kind: 'motion-graphic',
			source: { mg: { renderer: 'fframes' } },
		} as unknown as typeof c;
		expect(nativeBlockers(mg, caps, [])).toEqual([]);
		const warp = coreServices(app)
			.exports.nativeExtensions.all()
			.find((e) => e.id === 'warp')!;
		expect(warp.claimsLayer!(c)).toBe(false);

		// Still blocked: a keyframed effect without a native realization, and audio pan.
		const b = await cardDoc(app);
		const blur = b.d.tx([
			{
				type: 'effect.add',
				target: { clipId: b.clip },
				effectId: 'jasper.gaussian-blur',
				params: { radius: 4 },
				ref: '$b',
			},
		]);
		b.d.tx([
			{
				type: 'keyframe.add',
				target: ['effect', blur.refs.$b, 'radius'],
				at: { sequenceFrame: 0 },
				value: 0,
			},
			{
				type: 'keyframe.add',
				target: ['effect', blur.refs.$b, 'radius'],
				at: { sequenceFrame: 9 },
				value: 9,
			},
		]);
		const pb = await plan(b.d, h264Settings(b.d.seqId));
		expect(pb.path).toBe('remotion');
		expect(pb.blockers.map((x) => x.reason).join('\n')).toMatch(/jasper\.gaussian-blur/);

		const a = new DocBuilder();
		const tone = a.addMedia(await register(app, fixture('tone.wav')));
		const ar = a.tx([{ type: 'clip.place', source: { mediaId: tone }, at: 0, ref: '$a' }]);
		const audioClip = Object.keys(ar.refs).length ? ar.refs.$a! : a.clipIds()[0]!;
		a.tx([
			{ type: 'keyframe.add', target: ['clip', audioClip, 'volumeDb'], at: { sequenceFrame: 0 }, value: 0 },
			{
				type: 'keyframe.add',
				target: ['clip', audioClip, 'volumeDb'],
				at: { sequenceFrame: 30 },
				value: -20,
			},
			{ type: 'keyframe.add', target: ['track', 'A1', 'volumeDb'], at: { sequenceFrame: 10 }, value: -3 },
			{ type: 'keyframe.add', target: ['track', 'A1', 'volumeDb'], at: { sequenceFrame: 40 }, value: 0 },
			{ type: 'keyframe.add', target: ['master', 'volumeDb'], at: { sequenceFrame: 0 }, value: -1 },
			{ type: 'keyframe.add', target: ['master', 'volumeDb'], at: { sequenceFrame: 60 }, value: 2 },
		]);
		expect(await plan(a, h264Settings(a.seqId))).toMatchObject({ path: 'native', blockers: [] });
		a.tx([
			{ type: 'keyframe.add', target: ['clip', audioClip, 'pan'], at: { sequenceFrame: 0 }, value: -50 },
			{ type: 'keyframe.add', target: ['clip', audioClip, 'pan'], at: { sequenceFrame: 30 }, value: 50 },
		]);
		const pa = await plan(a, h264Settings(a.seqId));
		expect(pa.path).toBe('remotion');
		expect(pa.blockers.map((x) => x.reason)).toContain(
			'animated audio pan is not supported by the native path',
		);
	}, 120_000);
});

describe('native export of keyframed Motion and Opacity (S03:ENG-030/032)', () => {
	it('every sampled frame matches the evaluated layer: corners ≤ 1 px, colour ≤ 4/255; LGPL filters only', async () => {
		const { d, clip } = await cardDoc(app);
		const settings = proresSettings(d.seqId);
		const planned = await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings as never,
		});
		expect(planned.plan.path).toBe('native');
		const g = buildNativeGraph({
			snapshot: planned.snapshot,
			output: planned.output,
			outputFile: '/tmp/x.mov',
			sources: { media: (id) => planned.media[id] ?? null, mgMaster: () => null },
			threads: 2,
		});
		for (const name of GPL_FILTERS)
			expect(g.filter, name).not.toMatch(new RegExp(`(^|[\\[\\],;\\s])${name}(=|[,;\\[\\s]|$)`, 'm'));
		// Keyframed Motion: the layer is drawn sub-pixel and streamed on a pipe (stream/plan.ts).
		expect(g.streams).toHaveLength(1);
		expect(g.args.join(' ')).toContain('pipe:3');
		for (const name of GPL_FILTERS)
			expect(g.streams[0]!.plan.filter, name).not.toMatch(
				new RegExp(`(^|[\\[\\],;\\s])${name}(=|[,;\\[\\s]|$)`, 'm'),
			);

		const started = Date.now();
		const { done, out } = await runExport(d, settings);
		expect(done.result).toMatchObject({ renderPath: 'native', frames: 48 });
		report(`[anim] 48-frame card export (native, ProRes 4444): ${Date.now() - started} ms`);
		// Every frame: the linear start, the eased segment (18 → 34), the hold (34 → 44) and the jump after it.
		const frames = decodeAll(out);
		expect(frames).toHaveLength(48);
		let worst = 0;
		let worstColour = 0;
		for (const [f, img] of frames.entries()) {
			const layer = resolveSceneAt(planned.snapshot, f).find((l) => l.clip.clipId === clip)!;
			const quad = layer.props.quad;
			const corners = measureCorners(img, quad, PLATE[0]);
			const err = Math.max(...corners.map((c, i) => Math.hypot(c[0] - quad[i]![0], c[1] - quad[i]![1])));
			const col = colourError(img, layerMapOf(layer.props), layer.props.opacity / 100);
			worst = Math.max(worst, err);
			worstColour = Math.max(worstColour, col.max);
			expect(col.count).toBeGreaterThan(1000);
			expect(err, `frame ${f} corners`).toBeLessThanOrEqual(1);
			// ProRes 4444 is lossy: DCT ringing next to saturated edges reaches a few code values.
			expect(col.max, `frame ${f} colour ${col.where}`).toBeLessThanOrEqual(8);
			expect(col.mean, `frame ${f} mean colour error`).toBeLessThan(1);
		}
		report(
			`[anim] geometry: worst corner error ${worst.toFixed(3)} px, worst colour error ${worstColour}/255`,
		);
	}, 300_000);

	it('keyframed crop edges with keyframed non-uniform scale: the visible rect follows the evaluated quad', async () => {
		const d = new DocBuilder();
		d.tx([
			{ type: 'clip.addSolid', at: 0, duration: 48, track: 'V1', color: [20 / 255, 20 / 255, 20 / 255, 1] },
		]);
		const s = d.tx([
			{ type: 'clip.addSolid', at: 0, duration: 48, track: 'V2', color: [1, 1, 1, 1], ref: '$s' },
		]).refs.$s!;
		const at = (f: number) => ({ sequenceFrame: f });
		const t = (p: string) => ['clip', s, 'transform', p];
		const fx = d.tx([
			{ type: 'param.set', target: t('uniformScale'), value: false },
			{ type: 'param.set', target: t('rotation'), value: 12 },
			{ type: 'effect.add', target: { clipId: s }, effectId: 'jasper.crop', params: { top: 10 }, ref: '$fx' },
		]).refs.$fx!;
		d.tx([
			{ type: 'keyframe.add', target: t('scaleWidth'), at: at(0), value: 30 },
			{ type: 'keyframe.add', target: t('scaleWidth'), at: at(40), value: 47 },
			{ type: 'keyframe.add', target: t('scale'), at: at(5), value: 25 },
			{ type: 'keyframe.add', target: t('scale'), at: at(45), value: 36 },
			{ type: 'keyframe.add', target: ['effect', fx, 'left'], at: at(0), value: 0 },
			{ type: 'keyframe.add', target: ['effect', fx, 'left'], at: at(30), value: 25 },
			{ type: 'keyframe.add', target: ['effect', fx, 'right'], at: at(10), value: 0, interpolation: 'hold' },
			{ type: 'keyframe.add', target: ['effect', fx, 'right'], at: at(20), value: 15 },
		]);
		const settings = proresSettings(d.seqId);
		const planned = await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings as never,
		});
		expect(planned.plan).toMatchObject({ path: 'native', blockers: [] });
		const { out } = await runExport(d, settings);
		let worst = 0;
		for (const [f, img] of decodeAll(out).entries()) {
			const layer = resolveSceneAt(planned.snapshot, f).find((l) => l.clip.clipId === s)!;
			const quad = layer.props.quad;
			const corners = measureCorners(img, quad, PLATE[0]);
			const err = Math.max(...corners.map((c, i) => Math.hypot(c[0] - quad[i]![0], c[1] - quad[i]![1])));
			worst = Math.max(worst, err);
			expect(err, `frame ${f} corners`).toBeLessThanOrEqual(1);
		}
		report(`[anim] crop + non-uniform scale: worst corner error ${worst.toFixed(3)} px`);
	}, 300_000);
});

/** Frames of a region of a file as RGB (`w×h` each). */
function decodeRegion(file: string, x: number, y: number, w: number, h: number): Img[] {
	const r = spawnSync(
		'ffmpeg',
		[
			'-v',
			'error',
			'-i',
			file,
			'-vf',
			`crop=${w}:${h}:${x}:${y}`,
			'-pix_fmt',
			'rgb24',
			'-f',
			'rawvideo',
			'pipe:1',
		],
		{ maxBuffer: 1 << 30 },
	);
	if (r.status !== 0) throw new Error(`decode failed: ${r.stderr}`);
	const size = w * h * 3;
	return Array.from({ length: r.stdout.length / size }, (_, i) => ({
		rgb: r.stdout.subarray(i * size, (i + 1) * size),
		w,
		h,
	}));
}

/** Intensity-weighted centroid (pixel centres) of what is brighter than the plate. */
function centroid(img: Img, plate: number): [number, number] {
	let s = 0;
	let sx = 0;
	let sy = 0;
	for (let y = 0; y < img.h; y++)
		for (let x = 0; x < img.w; x++) {
			const v = Math.max(0, lum(img, x, y) - plate);
			s += v;
			sx += v * (x + 0.5);
			sy += v * (y + 0.5);
		}
	return [sx / s, sy / s];
}

describe('sub-pixel motion (no whole-pixel stepping)', () => {
	it('the layer kernel moves edges continuously at any scale (drawn frames, no ffmpeg): ≤ 0.01 px RMS', async () => {
		for (const scale of [20, 37, 50, 63, 80, 95, 100, 130]) {
			const d = new DocBuilder();
			d.tx([{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [0.08, 0.08, 0.08, 1] }]);
			const s = d.tx([
				{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V2', color: [1, 1, 1, 1], ref: '$s' },
			]).refs.$s!;
			const t = (p: string) => ['clip', s, 'transform', p];
			// The left edge sits 100.3 px from the frame's edge and moves 2.95 px in 60 frames.
			d.tx([
				{ type: 'param.set', target: t('scale'), value: scale },
				{
					type: 'keyframe.add',
					target: t('position'),
					at: { sequenceFrame: 0 },
					value: [9.6 * scale + 100.3, 500.6],
				},
				{
					type: 'keyframe.add',
					target: t('position'),
					at: { sequenceFrame: 59 },
					value: [9.6 * scale + 103.25, 500.6],
				},
			]);
			const planned = await coreServices(app).exports.plan({
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: {
					...h264Settings(d.seqId),
					range: { type: 'custom', startFrame: 0, endFrame: 60 },
				} as never,
			});
			const g = buildNativeGraph({
				snapshot: planned.snapshot,
				output: planned.output,
				outputFile: '/tmp/x.mp4',
				sources: { media: () => null, mgMaster: () => null },
				threads: 2,
			});
			expect(g.streams).toHaveLength(1);
			const p = g.streams[0]!.plan;
			const src = new Uint8Array(p.srcW * p.srcH * 4).fill(255);
			const dst = new Uint8Array(p.outW * p.outH * 4);
			let sq = 0;
			for (let k = 0; k < 60; k++) {
				const f = p.frames[k]!;
				drawLayer(src, p.srcW, f.cw, f.ch, dst, p.outW, p.outH, f.inv, f.opacity, f.rect);
				// Left edge on the frame's row 500: c − Σ coverage left of c (c well inside the layer).
				const row = 500 - p.offsets.y[k]!;
				const c = 160 - p.offsets.x[k]!;
				let cov = 0;
				for (let x = 0; x < c; x++) cov += dst[(row * p.outW + x) * 4 + 3]! / 255;
				sq += (c - cov + p.offsets.x[k]! - (100.3 + (k * 2.95) / 59)) ** 2;
			}
			const rms = Math.sqrt(sq / 60);
			expect(rms, `scale ${scale} %`).toBeLessThanOrEqual(0.01);
		}
	}, 600_000);

	it('a 0.05 px/frame pan over 300 frames moves smoothly: per-frame centroid ≤ 0.05 px RMS from the evaluated motion, monotonic, no jumps', async () => {
		const d = new DocBuilder();
		d.tx([
			{ type: 'clip.addSolid', at: 0, duration: 300, track: 'V1', color: [20 / 255, 20 / 255, 20 / 255, 1] },
		]);
		const s = d.tx([
			{ type: 'clip.addSolid', at: 0, duration: 300, track: 'V2', color: [1, 1, 1, 1], ref: '$s' },
		]).refs.$s!;
		const at = (f: number) => ({ sequenceFrame: f });
		const t = (p: string) => ['clip', s, 'transform', p];
		// A 384×216 white card (20 % of the 1080p solid), panned 15 px right over 300 frames, on a fractional y.
		d.tx([
			{ type: 'param.set', target: t('scale'), value: 20 },
			{ type: 'keyframe.add', target: t('position'), at: at(0), value: [800.3, 500.6] },
			{ type: 'keyframe.add', target: t('position'), at: at(299), value: [815.25, 500.6] },
		]);
		const settings = { ...proresSettings(d.seqId), range: { type: 'custom', startFrame: 0, endFrame: 300 } };
		const planned = await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings as never,
		});
		expect(planned.plan.path).toBe('native');
		const { out } = await runExport(d, settings);
		const R = { x: 560, y: 360, w: 520, h: 280 };
		const frames = decodeRegion(out, R.x, R.y, R.w, R.h);
		expect(frames).toHaveLength(300);
		const got = frames.map((img) => centroid(img, PLATE[0]).map((v, i) => v + (i ? R.y : R.x)));
		const want = Array.from({ length: 300 }, (_, f) => {
			const q = resolveSceneAt(planned.snapshot, f).find((l) => l.clip.clipId === s)!.props.quad;
			return [(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2];
		});
		let sq = 0;
		let worstStep = 0;
		let minStep = Number.POSITIVE_INFINITY;
		let worstY = 0;
		for (let f = 0; f < 300; f++) {
			sq += (got[f]![0]! - want[f]![0]!) ** 2;
			worstY = Math.max(worstY, Math.abs(got[f]![1]! - want[f]![1]!));
			if (f > 0) {
				const step = got[f]![0]! - got[f - 1]![0]!;
				const wantStep = want[f]![0]! - want[f - 1]![0]!;
				worstStep = Math.max(worstStep, Math.abs(step - wantStep));
				minStep = Math.min(minStep, step);
			}
		}
		const rms = Math.sqrt(sq / 300);
		report(
			`[subpixel] 0.05 px/frame pan, 300 frames: x RMS ${rms.toFixed(4)} px, worst step error ${worstStep.toFixed(4)} px, smallest step ${minStep.toFixed(4)} px, worst y error ${worstY.toFixed(4)} px`,
		);
		expect(rms).toBeLessThanOrEqual(0.05);
		expect(minStep).toBeGreaterThan(0); // monotonic
		expect(worstStep).toBeLessThan(0.05); // no whole-pixel (or half-pixel) jumps
		expect(worstY).toBeLessThanOrEqual(0.05);
	}, 600_000);
});

describe('native export of keyframed audio levels (S01:FX-010)', () => {
	it('clip, track and master volume keyframes give the per-frame gain of the composition (≤ 0.2 dB)', async () => {
		const d = new DocBuilder();
		const tone = d.addMedia(await register(app, fixture('tone.wav')));
		d.tx([{ type: 'clip.place', source: { mediaId: tone }, at: 0 }]);
		const clip = d.clipIds()[0]!;
		const settings = h264Settings(d.seqId);
		const reference = await runExport(d, settings);
		const at = (f: number) => ({ sequenceFrame: f });
		d.tx([
			{ type: 'keyframe.add', target: ['clip', clip, 'volumeDb'], at: at(0), value: 0 },
			{
				type: 'keyframe.add',
				target: ['clip', clip, 'volumeDb'],
				at: at(30),
				value: -18,
				interpolation: 'hold',
			},
			{ type: 'keyframe.add', target: ['clip', clip, 'volumeDb'], at: at(36), value: -6 },
			{
				type: 'keyframe.add',
				target: ['track', 'A1', 'volumeDb'],
				at: at(8),
				value: -4,
				interpolation: 'bezier',
				easeOut: { influence: 0.5, slope: 0 },
			},
			{ type: 'keyframe.add', target: ['track', 'A1', 'volumeDb'], at: at(40), value: 1 },
			{ type: 'keyframe.add', target: ['master', 'volumeDb'], at: at(0), value: 0 },
			{ type: 'keyframe.add', target: ['master', 'volumeDb'], at: at(47), value: -3 },
		]);
		const planned = await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings as never,
		});
		expect(planned.plan).toMatchObject({ path: 'native', blockers: [] });
		const keyed = await runExport(d, settings);

		// Expected per-frame gain, like the composition's `audioGainAt` (clip volume at the clip frame's content
		// time, track and master volume at its sequence time).
		const a = planned.snapshot.audioClips[0]!;
		const F = 705_600_000 / 30;
		const { evaluate } = await import('@jasper/project');
		const expectDb = (f: number) =>
			evaluate(a.volumeDb, a.sourceIn + f * F) +
			evaluate(a.track.volumeDb, f * F) +
			evaluate(planned.snapshot.master.volumeDb, f * F);
		const pcm = (file: string) => {
			const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-f', 'f32le', 'pipe:1'], {
				maxBuffer: 1 << 28,
			});
			if (r.status !== 0) throw new Error(r.stderr.toString());
			return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length / 4);
		};
		const ref = pcm(reference.out);
		const got = pcm(keyed.out);
		const rms = (x: Float32Array, a0: number, a1: number) => {
			let s = 0;
			for (let i = a0; i < a1; i++) s += x[i]! * x[i]!;
			return Math.sqrt(s / (a1 - a0));
		};
		let worst = 0;
		for (let f = 1; f < 47; f++) {
			// The middle of the frame (gain steps at frame boundaries, evaluated every 128 samples).
			const a0 = f * 1600 + 200;
			const a1 = (f + 1) * 1600 - 200;
			const db = 20 * Math.log10(rms(got, a0, a1) / rms(ref, a0, a1));
			worst = Math.max(worst, Math.abs(db - expectDb(f)));
			expect(
				Math.abs(db - expectDb(f)),
				`frame ${f}: ${db.toFixed(2)} dB vs ${expectDb(f).toFixed(2)}`,
			).toBeLessThan(0.2);
		}
		report(`[anim] keyframed volume: worst per-frame gain error ${worst.toFixed(3)} dB`);
	}, 300_000);
});

// ---- parity with the Remotion render (S03:FX-040 AC-FX-1, ENG-033)

describe.runIf(REMOTION)('native vs Remotion render of the keyframed fixture (REMOTION_E2E=1)', () => {
	let engine: RunningEngine;
	const hostH = () => ({ host: `127.0.0.1:${engine.port}` });

	beforeAll(async () => {
		engine = await startEngine({
			appdir: tempAppdir('jasper-anim-e2e-'),
			port: PORT,
			dev: true,
			env: {
				PATH: process.env.PATH,
				...FWD_ENV,
				...(process.env.JASPER_BROWSER_EXECUTABLE
					? { JASPER_BROWSER_EXECUTABLE: process.env.JASPER_BROWSER_EXECUTABLE }
					: {}),
			},
		});
	}, 600_000);
	afterAll(async () => {
		await engine?.stop();
	});

	async function exportWith(d: DocBuilder, engineName: 'native' | 'remotion') {
		const settings = proresSettings(d.seqId, engineName);
		const r = await engine.app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: { ...JSON_H, ...hostH() },
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings },
		});
		expect(r.statusCode, r.body).toBe(202);
		const queue = coreServices(engine.app).queue;
		await until(
			() => ['succeeded', 'failed', 'cancelled'].includes(queue.get(r.json().id)?.state ?? ''),
			1_200_000,
			250,
		);
		const done = queue.get(r.json().id)!;
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		return (await coreServices(engine.app).exports.outputFile(done.id))!;
	}

	/** Per-frame SSIM, share within 8/255 and the corner errors of both renders against the evaluated quad. */
	async function compare(d: DocBuilder, clip: string, frames: number) {
		const planned = await coreServices(engine.app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: proresSettings(d.seqId) as never,
		});
		const native = await exportWith(d, 'native');
		const remotion = await exportWith(d, 'remotion');
		const a = decodeAll(native);
		const b = decodeAll(remotion);
		expect(a).toHaveLength(frames);
		expect(b).toHaveLength(frames);
		const out = {
			ssim: [] as number[],
			share: [] as number[],
			native: [] as number[],
			remotion: [] as number[],
		};
		for (let f = 0; f < frames; f++) {
			out.ssim.push(ssim(native, remotion, f));
			out.share.push(within(a[f]!, b[f]!, 8));
			const quad = resolveSceneAt(planned.snapshot, f).find((l) => l.clip.clipId === clip)!.props.quad;
			const err = (img: Img) =>
				Math.max(
					...measureCorners(img, quad, PLATE[0]).map((c, i) =>
						Math.hypot(c[0] - quad[i]![0], c[1] - quad[i]![1]),
					),
				);
			out.native.push(err(a[f]!));
			out.remotion.push(err(b[f]!));
		}
		const min = (x: number[]) => Math.min(...x).toFixed(4);
		const max = (x: number[]) => Math.max(...x).toFixed(3);
		const mean = (x: number[]) => (x.reduce((s, v) => s + v, 0) / x.length).toFixed(4);
		return {
			...out,
			line: `SSIM min ${min(out.ssim)} mean ${mean(out.ssim)}; share within 8/255 min ${min(out.share)} mean ${mean(out.share)}; corner error vs evaluated quad: native max ${max(out.native)} px, Remotion max ${max(out.remotion)} px`,
		};
	}

	it('every frame of the keyframed card: SSIM ≥ 0.98 (FX-040), like a static layer of the M1 native path', async () => {
		const { d, clip } = await cardDoc(engine.app, hostH());
		const animated = await compare(d, clip, 48);
		report(`[anim parity] keyframed card, 48 frames: ${animated.line}`);
		for (const [f, v] of animated.ssim.entries()) expect(v, `frame ${f}`).toBeGreaterThanOrEqual(0.98);

		// Reference: the same layer without keyframes (the values of frame 26) through the M1 static native path.
		const props = resolveSceneAt(
			(
				await coreServices(engine.app).exports.plan({
					envelope: d.envelope(),
					sequenceId: d.seqId,
					settings: proresSettings(d.seqId) as never,
				})
			).snapshot,
			26,
		).find((l) => l.clip.clipId === clip)!.props;
		const st = await cardDoc(engine.app, hostH(), false);
		const tv = props.transform!;
		const t = (p: string) => ['clip', st.clip, 'transform', p];
		st.d.tx([
			{ type: 'param.set', target: t('position'), value: tv.position },
			{ type: 'param.set', target: t('anchor'), value: tv.anchor },
			{ type: 'param.set', target: t('scale'), value: tv.scale },
			{ type: 'param.set', target: t('rotation'), value: tv.rotation },
			{ type: 'param.set', target: ['clip', st.clip, 'opacity'], value: props.opacity },
		]);
		const fixed = await compare(st.d, st.clip, 48);
		report(`[anim parity] same layer without keyframes (static): ${fixed.line}`);
		expect(Math.min(...animated.ssim)).toBeGreaterThanOrEqual(Math.min(...fixed.ssim) - 0.005);
	}, 1_800_000);
});

// ---- speed (NATIVE_ANIM_BENCH=1): 10 s 1080p plate + keyframed picture-in-picture

describe.runIf(BENCH)('export speed of keyframed Motion (NATIVE_ANIM_BENCH=1)', () => {
	let engine: RunningEngine;
	const hostH = () => ({ host: `127.0.0.1:${engine.port}` });
	beforeAll(async () => {
		engine = await startEngine({
			appdir: tempAppdir('jasper-anim-bench-'),
			port: PORT,
			dev: true,
			env: {
				PATH: process.env.PATH,
				...FWD_ENV,
				...(process.env.JASPER_BROWSER_EXECUTABLE
					? { JASPER_BROWSER_EXECUTABLE: process.env.JASPER_BROWSER_EXECUTABLE }
					: {}),
			},
		});
	}, 600_000);
	afterAll(async () => {
		await engine?.stop();
	});

	async function timed(d: DocBuilder, settings: Record<string, unknown>) {
		const plan = (
			await engine.app.inject({
				method: 'POST',
				url: '/api/exports/plan',
				headers: { ...JSON_H, ...hostH() },
				payload: { envelope: d.envelope(), sequenceId: d.seqId, settings },
			})
		).json() as { path: string };
		const started = Date.now();
		const r = await engine.app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: { ...JSON_H, ...hostH() },
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings },
		});
		expect(r.statusCode, r.body).toBe(202);
		const queue = coreServices(engine.app).queue;
		await until(
			() => ['succeeded', 'failed', 'cancelled'].includes(queue.get(r.json().id)?.state ?? ''),
			3_600_000,
			250,
		);
		const done = queue.get(r.json().id)!;
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		return { path: plan.path, ms: Date.now() - started, result: done.result };
	}

	/** Fixture A: a 1080p plate and a keyframed 1080p picture-in-picture (eased position, scale, rotation, fade in). */
	async function pipDoc() {
		const d = new DocBuilder();
		const plate = d.addMedia(await register(engine.app, fixture('clip-a.mp4'), hostH()));
		const pip = d.addMedia(await register(engine.app, fixture('clip-a.mp4'), hostH()));
		d.tx([{ type: 'clip.place', source: { mediaId: plate }, at: 0 }]);
		const clip = d.tx([
			{
				type: 'clip.place',
				source: { mediaId: pip },
				at: 0,
				tracks: { video: 'V2', audio: 'A2' },
				ref: '$p',
			},
		]).refs.$p!;
		const at = (f: number) => ({ sequenceFrame: f });
		const t = (p: string) => ['clip', clip, 'transform', p];
		const ease = { influence: 0.5, slope: 0 };
		d.tx([
			{ type: 'keyframe.add', target: t('position'), at: at(0), value: [500, 300] },
			{
				type: 'keyframe.add',
				target: t('position'),
				at: at(150),
				value: [1400, 700],
				interpolation: 'bezier',
				easeIn: ease,
				easeOut: ease,
			},
			{ type: 'keyframe.add', target: t('position'), at: at(299), value: [700, 600] },
			{ type: 'keyframe.add', target: t('scale'), at: at(0), value: 30 },
			{ type: 'keyframe.add', target: t('scale'), at: at(299), value: 60 },
			{ type: 'keyframe.add', target: t('rotation'), at: at(0), value: -10 },
			{ type: 'keyframe.add', target: t('rotation'), at: at(299), value: 15 },
			{ type: 'keyframe.add', target: ['clip', clip, 'opacity'], at: at(0), value: 0 },
			{ type: 'keyframe.add', target: ['clip', clip, 'opacity'], at: at(20), value: 100 },
		]);
		return d;
	}

	/** Fixture B: a 1080p plate and three keyframed 640×360 cards flying in (motion-graphics style overlays). */
	async function cardsDoc() {
		const d = new DocBuilder();
		const plate = d.addMedia(await register(engine.app, fixture('clip-a.mp4'), hostH()));
		const card = d.addMedia(await register(engine.app, makeCard(), hostH()));
		d.tx([
			{ type: 'clip.place', source: { mediaId: plate }, at: 0 },
			{ type: 'track.add', kind: 'video', count: 2 },
		]);
		const at = (f: number) => ({ sequenceFrame: f });
		const ease = { influence: 0.5, slope: 0 };
		for (const [i, track] of ['V2', 'V3', 'V4'].entries()) {
			const clip = d.tx([
				{ type: 'clip.place', source: { mediaId: card }, at: 0, tracks: { video: track }, ref: '$c' },
			]).refs.$c!;
			d.tx([{ type: 'clip.trim', clipId: clip, edge: 'out', deltaFrames: 150 }]); // stills: 150 frames by default
			const t = (p: string) => ['clip', clip, 'transform', p];
			d.tx([
				{ type: 'keyframe.add', target: t('position'), at: at(0), value: [-300, 200 + 300 * i] },
				{
					type: 'keyframe.add',
					target: t('position'),
					at: at(40 + 20 * i),
					value: [500 + 400 * i, 250 + 280 * i],
					interpolation: 'bezier',
					easeIn: ease,
					easeOut: ease,
				},
				{ type: 'keyframe.add', target: t('position'), at: at(299), value: [600 + 400 * i, 300 + 260 * i] },
				{ type: 'keyframe.add', target: t('scale'), at: at(0), value: 20 },
				{ type: 'keyframe.add', target: t('scale'), at: at(60), value: 45 },
				{ type: 'keyframe.add', target: t('rotation'), at: at(0), value: -30 + 10 * i },
				{ type: 'keyframe.add', target: t('rotation'), at: at(299), value: 5 * i },
				{ type: 'keyframe.add', target: ['clip', clip, 'opacity'], at: at(0), value: 0 },
				{ type: 'keyframe.add', target: ['clip', clip, 'opacity'], at: at(30), value: 100 },
			]);
		}
		return d;
	}

	it('times the auto (native) path and, with NATIVE_ANIM_BENCH_REMOTION=1, the Remotion path', async () => {
		for (const [name, make] of [
			['plate + keyframed 1080p PiP', pipDoc],
			['plate + 3 keyframed 640x360 cards', cardsDoc],
		] as const) {
			const d = await make();
			const settings = { ...h264Settings(d.seqId), range: { type: 'custom', startFrame: 0, endFrame: 300 } };
			const native = await timed(d, settings);
			// A second export of the same document (caches warm: the warp stage reuses its intermediates).
			const again = await timed(d, settings);
			report(
				`[anim bench] ${name}: ${native.path} path, 300 frames 1080p30 h264: ${native.ms} ms, re-export ${again.ms} ms (${JSON.stringify(native.result)})`,
			);
			if (process.env.NATIVE_ANIM_BENCH_REMOTION === '1') {
				const remotion = await timed(d, { ...settings, engine: 'remotion' });
				report(`[anim bench] ${name}: remotion path: ${remotion.ms} ms (${JSON.stringify(remotion.result)})`);
			}
		}
	}, 3_600_000);
});
