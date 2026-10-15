import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMat3, invertMat3, layerMapOf, type Mat3, resolveSceneAt, type Vec2 } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fitPieces, pieceValue } from '../src/export/keyframed.ts';
import { buildNativeGraph } from '../src/export/native.ts';
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
const PORT = Number(process.env.JASPER_E2E_PORT ?? 0);
const W = 1920;
const H = 1080;

/** Measurements: console and `<tmp>/native-animated.txt` (Vitest hides the console of passing tests). */
function report(line: string): void {
	console.info(line);
	appendFileSync(join(tmpdir(), 'native-animated.txt'), `${new Date().toISOString()} ${line}\n`);
}

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

async function cardDoc(app: TestApp | RunningEngine['app'], hostH: Record<string, string> = {}) {
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
	animateCard(d, clip);
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
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
});

type Img = { rgb: Buffer; w: number; h: number };

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

/** Share of a pixel covered by the bright side of an edge between `plate` and `white`. */
const coverage = (v: number, plate: number, white: number) =>
	Math.min(1, Math.max(0, (v - plate) / (white - plate)));

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
				// Edge = window start + the summed dark share of its pixels (exact for any ramp width and phase).
				let dark = 0;
				for (let k = 0; k < 12; k++) dark += 1 - coverage(lum(img, x0 + k * dir, y), plate, white);
				pts.push([(dir > 0 ? x0 : x0 + 1) + dir * dark, y + 0.5]);
			} else {
				const x = Math.floor(px);
				const dir = cy > py ? 1 : -1;
				const y0 = Math.round(py) - 6 * dir;
				const white = lum(img, x, Math.round(py) + 6 * dir);
				let dark = 0;
				for (let k = 0; k < 12; k++) dark += 1 - coverage(lum(img, x, y0 + k * dir), plate, white);
				pts.push([x + 0.5, (dir > 0 ? y0 : y0 + 1) + dir * dark]);
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

/** Largest distance between measured and evaluated corners, over the corners inside the frame (others are extrapolated). */
function cornerError(corners: readonly Vec2[], quad: readonly Vec2[]): number {
	let max = 0;
	for (const [i, q] of quad.entries()) {
		if (q[0] < 4 || q[1] < 4 || q[0] > W - 4 || q[1] > H - 4) continue;
		max = Math.max(max, Math.hypot(corners[i]![0] - q[0], corners[i]![1] - q[1]));
	}
	return max;
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

describe('per-frame samples → piecewise-linear expressions (S03:ENG-032)', () => {
	it('stays within tolerance, keeps holds exact and grows with the curve, not the clip length', () => {
		const n = 3000;
		const eased = Float64Array.from({ length: n }, (_, k) => {
			const x = (k % 300) / 300;
			return 1000 * (x * x * (3 - 2 * x)) + (k >= 1500 ? 400 : 0); // eased ramps + a step at 1500
		});
		const pieces = fitPieces(eased, 0.1);
		for (let k = 0; k < n; k++) expect(Math.abs(pieceValue(pieces, k) - eased[k]!)).toBeLessThanOrEqual(0.1);
		expect(pieceValue(pieces, 1499)).toBeCloseTo(eased[1499]!, 9);
		expect(pieceValue(pieces, 1500)).toBeCloseTo(eased[1500]!, 9);
		// A 1000 px ease over 10 s (curvature ≤ 0.067 px/frame²) needs pieces of ~3 frames at 0.1 px.
		expect(pieces.length).toBeLessThan(n / 2.5);
		const linear = Float64Array.from({ length: 100_000 }, (_, k) => 3 + k * 0.25);
		expect(fitPieces(linear, 0.02).length).toBeLessThan(1000);
	});
});

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
	it('plans keyframed Motion, Opacity, crop and audio natively; animated blur uses hybrid', async () => {
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
		expect(pb).toMatchObject({ path: 'hybrid', blockers: [] });

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
		expect(await plan(a, h264Settings(a.seqId))).toMatchObject({ path: 'native', blockers: [] });
	}, 120_000);
});

describe('native export of keyframed Motion and Opacity (S03:ENG-030/032)', () => {
	it('every sampled frame matches the evaluated layer: corners ≤ 0.1 px (sub-pixel), colour ≤ 8/255; LGPL filters only', async () => {
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
		for (const stream of g.streams)
			for (const name of GPL_FILTERS)
				expect(stream.plan.filter, name).not.toMatch(
					new RegExp(`(^|[\\[\\],;\\s])${name}(=|[,;\\[\\s]|$)`, 'm'),
				);

		const started = Date.now();
		const { done, out } = await runExport(d, settings);
		expect(done.result).toMatchObject({ renderPath: 'native', frames: 48 });
		report(`[anim] 48-frame card export (native, ProRes 4444): ${Date.now() - started} ms`);
		const frames = decodeAll(out);
		expect(frames).toHaveLength(48);
		let worst = 0;
		let worstColour = 0;
		for (const [f, img] of frames.entries()) {
			const layer = resolveSceneAt(planned.snapshot, f).find((l) => l.clip.clipId === clip)!;
			const quad = layer.props.quad;
			const corners = measureCorners(img, quad, PLATE[0]);
			const err = cornerError(corners, quad);
			const col = colourError(img, layerMapOf(layer.props), layer.props.opacity / 100);
			worst = Math.max(worst, err);
			worstColour = Math.max(worstColour, col.max);
			expect(col.count).toBeGreaterThan(1000);
			expect(err, `frame ${f} corners`).toBeLessThanOrEqual(0.1);
			// ProRes 4444 is lossy: DCT ringing next to saturated edges reaches a few code values.
			expect(col.max, `frame ${f} colour ${col.where}`).toBeLessThanOrEqual(8);
			expect(col.mean, `frame ${f} mean colour error`).toBeLessThan(1);
		}
		report(
			`[anim] geometry: worst corner error ${worst.toFixed(3)} px, worst colour error ${worstColour}/255`,
		);
	}, 300_000);

	it('keyframed crop edges with keyframed non-uniform scale: the visible rect follows the evaluated quad (≤ 0.1 px)', async () => {
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
			const err = cornerError(corners, quad);
			worst = Math.max(worst, err);
			expect(err, `frame ${f} corners`).toBeLessThanOrEqual(0.1);
		}
		report(`[anim] crop + non-uniform scale: worst corner error ${worst.toFixed(3)} px`);
	}, 300_000);
});

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
	it('a 0.05 px/frame pan over 300 frames moves smoothly: per-frame centroid ≤ 0.05 px RMS from the prescribed motion, monotonic, no jumps', async () => {
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
		const want = Array.from({ length: 300 }, (_, f) => [800.3 + f * 0.05, 500.6]);
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
		expect(minStep).toBeGreaterThan(0);
		expect(worstStep).toBeLessThan(0.05);
		expect(worstY).toBeLessThanOrEqual(0.05);
	}, 600_000);
});

describe('native export of keyframed audio levels (S01:FX-010)', () => {
	it('clip, track and master volume keyframes are applied per sample (≤ 0.05 dB)', async () => {
		const d = new DocBuilder();
		const tone = d.addMedia(await register(app, fixture('tone.wav')));
		d.tx([{ type: 'clip.place', source: { mediaId: tone }, at: 0 }]);
		const clip = d.clipIds()[0]!;
		// PCM (ProRes MOV): a lossless audio stream, so the comparison measures the mixer, not the AAC coder.
		const settings = proresSettings(d.seqId);
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

		// Independent dB curves in sequence frames: clip 0→−18 then hold until 36,
		// track −4→1 from 8 to 40, and master 0→−3 from 0 to 47.
		const gainDbAt = (frame: number) => {
			const clipDb = frame < 30 ? (-18 * frame) / 30 : frame < 36 ? -18 : -6;
			const trackDb = -4 + 5 * Math.max(0, Math.min(1, (frame - 8) / 32));
			return clipDb + trackDb - (3 * frame) / 47;
		};
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
			// The middle of the frame: the reference shaped by the per-sample gain of the lanes.
			const a0 = f * 1600 + 200;
			const a1 = (f + 1) * 1600 - 200;
			let num = 0;
			let den = 0;
			for (let i = a0; i < a1; i++) {
				const g = 10 ** (gainDbAt(i / 1600) / 20);
				num += (g * ref[i]!) ** 2;
				den += ref[i]! ** 2;
			}
			const want = 10 * Math.log10(num / den);
			const db = 20 * Math.log10(rms(got, a0, a1) / rms(ref, a0, a1));
			worst = Math.max(worst, Math.abs(db - want));
			expect(Math.abs(db - want), `frame ${f}: ${db.toFixed(2)} dB vs ${want.toFixed(2)}`).toBeLessThan(0.05);
		}
		report(`[anim] keyframed volume: worst per-frame gain error ${worst.toFixed(3)} dB`);
	}, 300_000);
});

describe.runIf(REMOTION)('native vs Remotion render of the keyframed fixture (REMOTION_E2E=1)', () => {
	let engine: RunningEngine;
	const hostH = () => ({ host: `127.0.0.1:${engine.port}` });

	beforeAll(async () => {
		engine = await startEngine({
			appdir: tempAppdir('jasper-anim-e2e-'),
			port: PORT,
			// These tests drive the engine itself, not its authentication (server.test.ts, security-hardening.test.ts).
			insecure: true,
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
		// NATIVE_ANIM_KEEP=<dir>: keep both renders for inspection.
		if (process.env.NATIVE_ANIM_KEEP) {
			copyFileSync(native, join(process.env.NATIVE_ANIM_KEEP, `native-${frames}-${Date.now()}.mov`));
			copyFileSync(remotion, join(process.env.NATIVE_ANIM_KEEP, `remotion-${frames}-${Date.now()}.mov`));
		}
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
			const err = (img: Img) => cornerError(measureCorners(img, quad, PLATE[0]), quad);
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

	it('every frame of the keyframed card: native vs Remotion SSIM ≥ 0.98 (FX-040)', async () => {
		const { d, clip } = await cardDoc(engine.app, hostH());
		const animated = await compare(d, clip, 48);
		report(`[anim parity] keyframed card, 48 frames: ${animated.line}`);
		for (const [f, v] of animated.ssim.entries()) expect(v, `frame ${f}`).toBeGreaterThanOrEqual(0.98);
	}, 1_800_000);
});
