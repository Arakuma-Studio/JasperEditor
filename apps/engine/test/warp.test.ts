import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORNER_PIN_EFFECT_ID, type Vec2 } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildNativeGraph } from '../src/export/native.ts';
import { type NativeExtension, prepareExtensions } from '../src/export/native-ext.ts';
import { createWarpExtension } from '../src/export/warp/extension.ts';
import { registerWarpStage } from '../src/export/warp/index.ts';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	H,
	JSON_H,
	makeApp,
	register,
	type TestApp,
} from './helpers.ts';

const FWD_ENV: Record<string, string> = {};
for (const k of ['JASPER_FFMPEG', 'JASPER_FFPROBE']) if (process.env[k]) FWD_ENV[k] = process.env[k]!;

let app: TestApp;
let warp: NativeExtension;
beforeAll(async () => {
	ensureFixtures();
	app = await makeApp({ env: FWD_ENV });
	warp = registerWarpStage(app);
}, 180_000);
afterAll(closeApps);

const settings = (seqId: string, extra: Record<string, unknown> = {}) => ({
	sequenceId: seqId,
	range: { type: 'entire' },
	container: 'mp4',
	video: {
		codec: 'h264',
		width: 1920,
		height: 1080,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 18 },
		encoderSpeed: 'fast',
	},
	audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
	engine: 'auto',
	...extra,
});

const PIN = {
	topLeft: [0.12, 0.1],
	topRight: [0.83, 0.18],
	bottomRight: [0.9, 0.86],
	bottomLeft: [0.08, 0.78],
};

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
function cardColorAt(u: number, v: number): [number, number, number] | null {
	// null = within 3 px of a boundary (edge-excluded) or outside.
	const { w, h, border, cols, rows } = CARD;
	if (u < 3 || v < 3 || u > w - 3 || v > h - 3) return null;
	const near = (x: number, lines: number[]) => lines.some((l) => Math.abs(x - l) < 3);
	if (near(u, [border, w - border]) || near(v, [border, h - border])) return null;
	if (u < border || v < border || u > w - border || v > h - border) return [255, 255, 255];
	const cw = (w - 2 * border) / cols;
	const ch = (h - 2 * border) / rows;
	const cu = (u - border) / cw;
	const cv = (v - border) / ch;
	if (Math.abs(cu - Math.round(cu)) * cw < 3 || Math.abs(cv - Math.round(cv)) * ch < 3) return null;
	return CELL_COLORS[(Math.floor(cu) + 3 * Math.floor(cv)) % CELL_COLORS.length]!;
}
function makeCard(): string {
	const { w, h } = CARD;
	const raw = Buffer.alloc(w * h * 3);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			// Exact cell colours at pixel centres (no exclusion when generating).
			const { border, cols, rows } = CARD;
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
	const dir = mkdtempSync(join(tmpdir(), 'jasper-warp-card-'));
	writeFileSync(join(dir, 'card.rgb'), raw);
	const out = join(dir, 'card.png');
	const r = spawnSync('ffmpeg', [
		...['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`],
		...['-i', join(dir, 'card.rgb'), '-frames:v', '1', out],
	]);
	if (r.status !== 0) throw new Error(r.stderr.toString());
	return out;
}

async function cardDoc(opts: { pin?: boolean; motion?: boolean; video?: boolean } = {}) {
	const card = await register(app, makeCard());
	const d = new DocBuilder();
	const cardId = d.addMedia(card);
	if (opts.video) {
		const plate = d.addMedia(await register(app, fixture('clip-a.mp4')));
		d.tx([{ type: 'clip.place', source: { mediaId: plate }, at: 0, ref: '$p' }]);
	} else d.tx([{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [0.08, 0.08, 0.08, 1] }]);
	const r = d.tx([
		{ type: 'clip.place', source: { mediaId: cardId }, at: 0, tracks: { video: 'V2' }, ref: '$c' },
	]);
	const clip = r.refs.$c!;
	if (opts.pin !== false) {
		d.tx([
			{ type: 'param.set', target: ['clip', clip, 'transform', 'scale'], value: 250 },
			{ type: 'effect.add', target: { clipId: clip }, effectId: CORNER_PIN_EFFECT_ID, params: PIN },
		]);
	}
	if (opts.motion) {
		const at = (f: number) => ({ sequenceFrame: f });
		const t = (p: string) => ['clip', clip, 'transform', p];
		d.tx([
			{ type: 'keyframe.add', target: t('position'), at: at(0), value: [700, 400] },
			{ type: 'keyframe.add', target: t('position'), at: at(30), value: [1200, 650] },
			{ type: 'keyframe.add', target: t('rotation'), at: at(0), value: -10 },
			{ type: 'keyframe.add', target: t('rotation'), at: at(30), value: 25 },
			{ type: 'keyframe.add', target: t('scale'), at: at(0), value: 80 },
			{ type: 'keyframe.add', target: t('scale'), at: at(30), value: 140 },
			{ type: 'keyframe.add', target: ['clip', clip, 'opacity'], at: at(0), value: 100 },
			{ type: 'keyframe.add', target: ['clip', clip, 'opacity'], at: at(40), value: 60 },
		]);
	}
	return { d, clip };
}

async function plan(d: DocBuilder, extra: Record<string, unknown> = {}) {
	const r = await app.inject({
		method: 'POST',
		url: '/api/exports/plan',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, settings: settings(d.seqId, extra) },
	});
	expect(r.statusCode).toBe(200);
	return r.json() as { path: string; blockers: { itemId?: string; reason: string }[] };
}

async function still(
	d: DocBuilder,
	frame: number,
): Promise<{ rgb: Buffer; w: number; h: number; renderPath: string }> {
	const r = await app.inject({
		method: 'POST',
		url: '/api/stills',
		headers: JSON_H,
		payload: { envelope: d.envelope(), sequenceId: d.seqId, frame },
	});
	expect(r.statusCode).toBe(202);
	const done = await coreServices(app).queue.wait(r.json().id);
	expect(done.error).toBeUndefined();
	const png = await app.inject({ method: 'GET', url: `/renders/${r.json().id}/output`, headers: H });
	const f = join(mkdtempSync(join(tmpdir(), 'jasper-warp-png-')), 'f.png');
	writeFileSync(f, png.rawPayload);
	const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
		maxBuffer: 64 << 20,
	});
	expect(raw.stdout.length).toBe(1920 * 1080 * 3);
	return {
		rgb: raw.stdout,
		w: 1920,
		h: 1080,
		renderPath: (done.result as { renderPath: string }).renderPath,
	};
}

const lum = (img: { rgb: Buffer; w: number }, x: number, y: number) => {
	const o = (y * img.w + x) * 3;
	return (img.rgb[o]! + img.rgb[o + 1]! + img.rgb[o + 2]!) / 3;
};

/**
 * Sub-pixel edge crossings of the (white-framed) card against the dark plate along scanlines, one straight edge
 * of the independently specified quad at a time; lines fitted through them intersect in the measured corners.
 */
function measureCorners(img: { rgb: Buffer; w: number; h: number }, quad: readonly Vec2[], plate: number) {
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
		expect(pts.length).toBeGreaterThan(10);
		// Total least squares line through the points.
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
		// Corner i is the intersection of edge i−1 (ending at i) and edge i.
		const l1 = lines[(i + 3) % 4]!;
		const l2 = lines[i]!;
		const den = l1.d[0] * l2.d[1] - l1.d[1] * l2.d[0];
		const t = ((l2.p[0] - l1.p[0]) * l2.d[1] - (l2.p[1] - l1.p[1]) * l2.d[0]) / den;
		corners.push([l1.p[0] + t * l1.d[0], l1.p[1] + t * l1.d[1]]);
	}
	return corners;
}

/** Max colour error over pixels whose source point is ≥ 3 px away from every card boundary. */
function colourError(
	img: { rgb: Buffer; w: number; h: number },
	sourceAt: (x: number, y: number) => Vec2,
	opacity: number,
	plate: [number, number, number],
) {
	let max = 0;
	let count = 0;
	for (let y = 0; y < img.h; y += 3)
		for (let x = 0; x < img.w; x += 3) {
			const [u, v] = sourceAt(x + 0.5, y + 0.5);
			const c = cardColorAt(u, v);
			if (!c) continue;
			const o = (y * img.w + x) * 3;
			for (let k = 0; k < 3; k++) {
				const want = c[k]! * opacity + plate[k]! * (1 - opacity);
				max = Math.max(max, Math.abs(img.rgb[o + k]! - want));
			}
			count++;
		}
	return { max, count };
}

describe('planner with the warp stage (S09 §8.5)', () => {
	it('plans native for corner-pinned still / solid / video overlays and keyframed Motion + opacity', async () => {
		const { d } = await cardDoc();
		expect(await plan(d)).toMatchObject({ path: 'native', blockers: [] });
		const m = await cardDoc({ pin: false, motion: true });
		expect(await plan(m.d)).toMatchObject({ path: 'native', blockers: [] });

		const v = new DocBuilder();
		const a = v.addMedia(await register(app, fixture('clip-a.mp4')));
		const r = v.tx([
			{ type: 'clip.place', source: { mediaId: a }, at: 0, ref: '$v' },
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V2', color: [1, 0, 0, 1], ref: '$s' },
		]);
		v.tx([
			{ type: 'effect.add', target: { clipId: r.refs.$s }, effectId: CORNER_PIN_EFFECT_ID, params: PIN },
			{ type: 'effect.add', target: { clipId: r.refs.$v }, effectId: CORNER_PIN_EFFECT_ID, params: PIN },
			{ type: 'effect.add', target: { clipId: r.refs.$s }, effectId: 'jasper.crop', params: { left: 10 } },
		]);
		expect(await plan(v)).toMatchObject({ path: 'native', blockers: [] });
	});

	it('still blocks what the warp stage cannot render; unclaimed kinds keep their M1 blockers', async () => {
		const { d, clip } = await cardDoc();
		d.tx([
			{
				type: 'effect.add',
				target: { clipId: clip },
				effectId: 'jasper.gaussian-blur',
				params: { radius: 4 },
			},
		]);
		let p = await plan(d);
		expect(p.path).toBe('remotion');
		expect(p.blockers.map((b) => b.itemId)).toContain(clip);

		const k = await cardDoc();
		const fx = k.d.tx([
			{ type: 'effect.add', target: { clipId: k.clip }, effectId: 'jasper.crop', params: {}, ref: '$fx' },
		]);
		k.d.tx([
			{ type: 'keyframe.add', target: ['effect', fx.refs.$fx, 'left'], at: { sequenceFrame: 0 }, value: 0 },
			{ type: 'keyframe.add', target: ['effect', fx.refs.$fx, 'left'], at: { sequenceFrame: 20 }, value: 30 },
		]);
		// Animated crop edges render in the source chain, so a corner-pinned layer can also use a per-frame crop mask.
		p = await plan(k.d);
		expect(p).toMatchObject({ path: 'native', blockers: [] });

		const t = new DocBuilder();
		const tr = t.tx([
			{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'Hi' }, ref: '$t' },
		]);
		t.tx([
			{ type: 'effect.add', target: { clipId: tr.refs.$t }, effectId: CORNER_PIN_EFFECT_ID, params: PIN },
		]);
		p = await plan(t);
		// Layer bakes apply matrix3d to text, so the warp stage must not claim corner-pinned text.
		expect(p.path).toBe('hybrid');
		expect(p.blockers).toEqual([]);
	});
});

describe('export through the warp stage (TRK-032, S09 §8.5)', () => {
	it('exports a corner-pinned still over a video plate natively; the second export reuses the cache', async () => {
		const { d } = await cardDoc({ video: true });
		const cacheDir = join(app.jasper.config.paths.cacheDir, 'warp');
		const run = async () => {
			const start = await app.inject({
				method: 'POST',
				url: '/api/exports',
				headers: JSON_H,
				payload: {
					envelope: d.envelope(),
					sequenceId: d.seqId,
					settings: settings(d.seqId, { range: { type: 'custom', startFrame: 0, endFrame: 45 } }),
				},
			});
			expect(start.statusCode).toBe(202);
			const done = await coreServices(app).queue.wait(start.json().id);
			expect(done.error).toBeUndefined();
			expect(done.result).toMatchObject({ renderPath: 'native', frames: 45 });
			return done;
		};
		await run();
		const files = readdirSync(cacheDir).filter((f) => f.endsWith('.mov'));
		expect(files).toHaveLength(1);
		expect(readdirSync(cacheDir).some((f) => f.endsWith('.tmp'))).toBe(false);

		// An old timestamp makes a rewrite observable even on coarse filesystems.
		const cached = join(cacheDir, files[0]!);
		const old = new Date('2020-01-01T00:00:00Z');
		utimesSync(cached, old, old);
		const size = statSync(cached).size;
		await run();
		expect(readdirSync(cacheDir).filter((f) => f.endsWith('.mov'))).toEqual(files);
		expect(statSync(cached).size).toBe(size);
		expect(statSync(cached).mtimeMs).toBe(old.getTime());

		const probe = spawnSync('ffprobe', [
			...['-v', 'error', '-count_frames', '-show_entries'],
			'stream=codec_name,profile,pix_fmt,width,height,nb_read_frames,color_space',
			...['-of', 'json', join(cacheDir, files[0]!)],
		]);
		const s = JSON.parse(probe.stdout.toString()).streams[0];
		expect(s).toMatchObject({ codec_name: 'prores', width: 1920, height: 1080, color_space: 'bt709' });
		expect(s.pix_fmt).toMatch(/^yuva444p1[02]le$/);
		expect(Number(s.nb_read_frames)).toBe(45);
	}, 180_000);

	it('the generated filter text (builder + warp decode) uses no GPL-only filter (D-13)', async () => {
		const { d } = await cardDoc({ motion: true });
		const planned = await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId) as never,
		});
		const exts = coreServices(app).exports.nativeExtensions.all();
		const ctx = {
			signal: new AbortController().signal,
			stage: () => {},
			scratchDir: async () => tmpdir(),
			log: (t: string) => logs.push(t),
			jobId: 'job_0000000000000000',
		};
		const logs: string[] = [];
		const prepared = new Map([
			['warp', await warp.prepare!(planned, { ...ctx, extensions: exts, preparedSoFar: new Map() })],
		]);
		const g = buildNativeGraph({
			snapshot: planned.snapshot,
			output: planned.output,
			outputFile: '/tmp/x.mp4',
			sources: { media: (id) => planned.media[id] ?? null, mgMaster: () => null },
			threads: 2,
			extensions: { list: exts, prepared },
		});
		const decode = logs.filter((l) => l.startsWith('warp: ffmpeg')).join('\n');
		const text = `${g.filter}\n${decode}`;
		const GPL = [
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
		for (const name of GPL)
			expect(text, name).not.toMatch(new RegExp(`(^|[\\[\\],;\\s])${name}(=|[,;\\[\\s]|$)`, 'm'));
	}, 120_000);
});

describe('native rendering against authored geometry (TRK-030/032)', () => {
	const PLATE: [number, number, number] = [20, 20, 20];

	it('a corner-pinned trapezoid matches authored corners and colours within 1 px and 3/255', async () => {
		const { d, clip } = await cardDoc({ pin: false });
		d.tx([
			{ type: 'param.set', target: ['clip', clip, 'transform', 'scale'], value: 250 },
			{
				type: 'effect.add',
				target: { clipId: clip },
				effectId: CORNER_PIN_EFFECT_ID,
				params: { topLeft: [0.25, 0], topRight: [0.75, 0], bottomRight: [1, 1], bottomLeft: [0, 1] },
			},
		]);
		const img = await still(d, 12);
		expect(img.renderPath).toBe('native');
		// S09 TRK-030: pin in the 640×360 box, then 250% scale around (320,180), position (960,540).
		const quad: Vec2[] = [
			[560, 90],
			[1360, 90],
			[1760, 990],
			[160, 990],
		];
		// Unit square → trapezoid: X=(u+.5-.5v)/(2-v), Y=v/(2-v).
		// Solve for (u,v), after undoing the authored scale and translation.
		const sourceAt = (x: number, y: number): Vec2 => {
			const nx = (x - 160) / 1600;
			const ny = (y - 90) / 900;
			return [(640 * (2 * nx - 0.5 + 0.5 * ny)) / (1 + ny), (720 * ny) / (1 + ny)];
		};
		const corners = measureCorners(img, quad, PLATE[0]);
		const err = Math.max(...corners.map((c, i) => Math.hypot(c[0] - quad[i]![0], c[1] - quad[i]![1])));
		const col = colourError(img, sourceAt, 1, PLATE);
		console.info(
			`[warp parity] pin: corner error ${err.toFixed(3)} px, colour ${col.max.toFixed(1)}/255 over ${col.count} px`,
		);
		expect(err).toBeLessThanOrEqual(1);
		expect(col.count).toBeGreaterThan(0);
		expect(col.max).toBeLessThanOrEqual(3);
	}, 120_000);

	it('keyframed Motion + opacity mid-animation: corners ≤ 1 px, colour ≤ 3/255', async () => {
		const { d } = await cardDoc({ pin: false, motion: true });
		const img = await still(d, 17);
		expect(img.renderPath).toBe('native');
		// S03 DM-012: P + R*S*(q-A). Linear keys at frame17 give these authored values.
		const position: Vec2 = [700 + (500 * 17) / 30, 400 + (250 * 17) / 30];
		const scale = 1.14;
		const angle = ((-10 + (35 * 17) / 30) * Math.PI) / 180;
		const c = Math.cos(angle);
		const s = Math.sin(angle);
		const quad: Vec2[] = [
			[0, 0],
			[640, 0],
			[640, 360],
			[0, 360],
		].map(
			([x, y]): Vec2 => [
				position[0]! + scale * (c * (x! - 320) - s * (y! - 180)),
				position[1]! + scale * (s * (x! - 320) + c * (y! - 180)),
			],
		);
		const sourceAt = (x: number, y: number): Vec2 => {
			const dx = x - position[0]!;
			const dy = y - position[1]!;
			return [320 + (c * dx + s * dy) / scale, 180 + (-s * dx + c * dy) / scale];
		};
		const opacity = 0.83; // 100% → 60% over 40 frames, evaluated at 17.
		// Edge crossings at 50 % between the plate and the (partly transparent) white frame.
		const corners = measureCorners(img, quad, PLATE[0]);
		const err = Math.max(...corners.map((c, i) => Math.hypot(c[0] - quad[i]![0], c[1] - quad[i]![1])));
		const col = colourError(img, sourceAt, opacity, PLATE);
		console.info(
			`[warp parity] motion: corner error ${err.toFixed(3)} px, colour ${col.max.toFixed(1)}/255 over ${col.count} px`,
		);
		expect(err).toBeLessThanOrEqual(1);
		expect(col.count).toBeGreaterThan(0);
		expect(col.max).toBeLessThanOrEqual(3);
	}, 120_000);
});

describe('warp sources and cancellation', () => {
	const ctxOf = (signal: AbortSignal) => ({
		signal,
		stage: () => {},
		scratchDir: async () => tmpdir(),
		log: () => {},
		jobId: 'job_0000000000000000',
	});

	it('warps a composition clip from an earlier extension’s `layer` override; fails clearly without one', async () => {
		const { d, clip } = await cardDoc();
		const planned = await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId) as never,
		});
		planned.range = { start: 0, end: 20 };
		const c = planned.snapshot.videoTracks.flatMap((t) => t.clips).find((x) => x.clipId === clip)!;
		c.kind = 'composition';
		c.source = {
			composition: {
				mediaId: 'mg1',
				compositionId: 'Lower',
				props: {},
				canvas: { width: 1920, height: 1080 },
			},
		};
		c.intrinsicBox = { width: 1920, height: 1080 };
		const master = fixture('overlay-alpha.mov');
		let provide = true;
		const mg: NativeExtension = {
			id: 'mg',
			kinds: new Set(['composition']),
			prepare: async () => 'mg-prepared',
			override: (x, prepared) =>
				provide && prepared === 'mg-prepared' && x.kind === 'composition'
					? { path: master, space: 'layer', startFrame: 0 }
					: null,
		};
		const cacheDir = mkdtempSync(join(tmpdir(), 'jasper-warp-cache-'));
		const w2: NativeExtension = createWarpExtension({
			ffmpeg: coreServices(app).ffmpeg,
			cacheDir,
			getExtensions: () => [mg, w2],
			threads: 4,
		});
		expect(w2.blockers!(c)).toEqual([]);
		const logs: string[] = [];
		const prepared = await prepareExtensions([mg, w2], planned, {
			...ctxOf(new AbortController().signal),
			log: (text) => logs.push(text),
		});
		const o = w2.override!(c, prepared.get('warp'));
		expect(o).toMatchObject({ space: 'sequence', startFrame: 0 });
		expect(logs.find((line) => line.startsWith('warp: ffmpeg'))).toContain(master);
		const probe = spawnSync('ffprobe', [
			...[
				'-v',
				'error',
				'-count_frames',
				'-show_entries',
				'stream=nb_read_frames',
				'-of',
				'csv=p=0',
				o!.path,
			],
		]);
		expect(Number(probe.stdout.toString().trim())).toBe(20);

		provide = false;
		await expect(
			prepareExtensions(
				[mg, createWarpExtension({ ffmpeg: coreServices(app).ffmpeg, cacheDir, getExtensions: () => [] })],
				planned,
				ctxOf(new AbortController().signal),
			),
		).rejects.toMatchObject({ code: 'WARP_SOURCE_UNAVAILABLE' });
	}, 120_000);

	it('cancels mid-render: children stopped, no partial or cached file left', async () => {
		const v = new DocBuilder();
		const a = v.addMedia(await register(app, fixture('clip-a.mp4')));
		const r = v.tx([{ type: 'clip.place', source: { mediaId: a }, at: 0, ref: '$v' }]);
		// A corner pin: the warp stage claims it (keyframed Motion alone is animated by the builder itself).
		const t = ['clip', r.refs.$v, 'transform', 'rotation'];
		v.tx([
			{ type: 'effect.add', target: { clipId: r.refs.$v }, effectId: CORNER_PIN_EFFECT_ID, params: PIN },
			{ type: 'keyframe.add', target: t, at: { sequenceFrame: 0 }, value: 0 },
			{ type: 'keyframe.add', target: t, at: { sequenceFrame: 200 }, value: 20 },
		]);
		const planned = await coreServices(app).exports.plan({
			envelope: v.envelope(),
			sequenceId: v.seqId,
			settings: settings(v.seqId) as never,
		});
		const cacheDir = mkdtempSync(join(tmpdir(), 'jasper-warp-cache-'));
		const w3 = createWarpExtension({ ffmpeg: coreServices(app).ffmpeg, cacheDir, getExtensions: () => [] });
		const ac = new AbortController();
		const ctx = { ...ctxOf(ac.signal), stage: (s: string) => (s.includes('%') ? ac.abort() : undefined) };
		await expect(w3.prepare!(planned, ctx)).rejects.toMatchObject({ code: 'JOB_CANCELLED' });
		expect(readdirSync(cacheDir)).toEqual([]);
	}, 120_000);
});
