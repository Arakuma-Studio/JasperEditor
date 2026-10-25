// One-click Trim Paths animations and trim tracers on every export path the planner routes vector shapes to
// (docs/wp-notes/shapes.md § 12, expressions note § path methods): the hybrid path (native composite with each
// shape layer baked through Remotion) and the Remotion path (the compositions in Chrome, as Program preview draws
// them). Both exports are compared frame by frame (SSIM, per-pixel) and against the shared evaluator: the tracer
// dot / bar must sit on the evaluated Trim Paths tip with the evaluated orientation, and the drawn stroke share of
// each trimmed layer must equal its evaluated Start / End.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type Animatable,
	clipContentTime,
	evaluate,
	type RenderSnapshot,
	type RenderVisualClip,
	resolveLayerProps,
	type ShapeItem,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import { DocBuilder, JSON_H, tempAppdir, until } from './helpers.ts';

const enabled = process.env.REMOTION_E2E === '1';
const PORT = Number(process.env.JASPER_E2E_PORT ?? 0);
const W = 1280;
const H = 720;
const N = 36;
const FWD_ENV: Record<string, string> = {};
for (const k of [
	'JASPER_FFMPEG',
	'JASPER_FFPROBE',
	'JASPER_FFMPEG_LGPL_ONLY',
	'JASPER_REMOTION_BIN_DIR',
	'JASPER_BROWSER_EXECUTABLE',
])
	if (process.env[k]) FWD_ENV[k] = process.env[k]!;

/** Measurements: console and `<tmp>/trim-paths-export.txt` (Vitest hides the console of passing tests). */
function report(line: string): void {
	console.info(line);
	appendFileSync(join(tmpdir(), 'trim-paths-export.txt'), `${new Date().toISOString()} ${line}\n`);
}

type Img = Uint8Array;

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
	return Array.from({ length: r.stdout.length / size }, (_, i) =>
		r.stdout.subarray(i * size, (i + 1) * size),
	);
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

/** TRIM_EXPORT_DUMP=<dir>: PNGs of some frames of an export, for inspection. */
function dump(file: string, name: string, frames: number[]): void {
	const dir = process.env.TRIM_EXPORT_DUMP;
	if (!dir) return;
	mkdirSync(dir, { recursive: true });
	for (const f of frames)
		spawnSync('ffmpeg', [
			...['-v', 'error', '-y', '-i', file, '-vf', `select=eq(n\\,${f})`, '-frames:v', '1'],
			join(dir, `${name}-${String(f).padStart(2, '0')}.png`),
		]);
}

type Box = { x0: number; y0: number; x1: number; y1: number };
const px = (img: Img, x: number, y: number) => {
	const i = (y * W + x) * 3;
	return [img[i]!, img[i + 1]!, img[i + 2]!] as const;
};

/** Weighted centroid, total weight and principal-axis angle (degrees, mod 180) of `weight` over a box. */
function blob(img: Img, b: Box, weight: (r: number, g: number, b: number) => number) {
	let s = 0;
	let sx = 0;
	let sy = 0;
	for (let y = b.y0; y < b.y1; y++)
		for (let x = b.x0; x < b.x1; x++) {
			const [r, g, bl] = px(img, x, y);
			const w = weight(r, g, bl);
			if (w <= 0) continue;
			s += w;
			sx += w * (x + 0.5);
			sy += w * (y + 0.5);
		}
	const cx = sx / s;
	const cy = sy / s;
	let xx = 0;
	let xy = 0;
	let yy = 0;
	for (let y = b.y0; y < b.y1; y++)
		for (let x = b.x0; x < b.x1; x++) {
			const [r, g, bl] = px(img, x, y);
			const w = weight(r, g, bl);
			if (w <= 0) continue;
			xx += w * (x + 0.5 - cx) ** 2;
			xy += w * (x + 0.5 - cx) * (y + 0.5 - cy);
			yy += w * (y + 0.5 - cy) ** 2;
		}
	return { s, c: [cx, cy] as [number, number], angle: (0.5 * Math.atan2(2 * xy, xx - yy) * 180) / Math.PI };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** Coverage weights over the black background. */
const WHITE = (r: number, g: number, b: number) => (Math.min(r, g, b) > 150 ? Math.min(r, g, b) / 255 : 0);
const YELLOW = (r: number, g: number, b: number) => (b < 90 && r > 60 && g > 60 ? Math.min(r, g) / 255 : 0);
const GREEN = (r: number, g: number, b: number) => (r < 90 && b < 90 ? g / 255 : 0);
const CYAN = (r: number, g: number, b: number) => (r < 90 ? clamp01(Math.min(g, b) / 255) : 0);
const MAGENTA = (r: number, g: number, b: number) => (g < 90 ? clamp01(Math.min(r, b) / 255) : 0);

const angleDiff = (a: number, b: number) => {
	const d = (((a - b) % 180) + 180) % 180;
	return Math.min(d, 180 - d);
};

type Scene = {
	d: DocBuilder;
	line: { clipId: string; trimId: string };
	dot: string;
	curve: { clipId: string; trimId: string };
	bar: string;
	middle: { clipId: string; trimId: string };
	divide: { clipId: string; trimId: string; parts: number };
};

type TrimResult = { clips: { clipId: string; trimIds: string[]; partIds: string[] }[] };

/**
 * V1: a 600 px horizontal line (y = 140) drawing on (`in`) with a created tracer dot (orient); V3/V4: a curved
 * path drawing on from its end (`in` + reverse) with a yellow bar following it, oriented; V5: a rectangle growing
 * from its path start both ways (`middleIn` + reverse: Offset expression linked to End), starting at frame 6; V6: a
 * rectangle divided into 4 parts drawing on together (`divideIn`, parts driven by expressions, Offset turning),
 * starting at frame 3.
 */
function scene(): Scene {
	const d = new DocBuilder('hd-720p-30');
	d.tx([{ type: 'track.add', kind: 'video', count: 6 }]);
	const first = <T>(r: { results: unknown[] }) => r.results[0] as T;
	const lineId = first<{ clipId: string }>(
		d.tx([
			{
				type: 'shape.addLine',
				orientation: 'horizontal',
				length: 600,
				strokeWidth: 10,
				color: [0, 1, 0, 1],
				at: 0,
				durationFrames: N,
				trackId: d.track('V1'),
			},
		]),
	).clipId;
	d.tx([{ type: 'param.set', target: ['clip', lineId, 'transform', 'position'], value: [640, 140] }]);
	const lineTrim = first<TrimResult>(
		d.tx([{ type: 'shape.animateTrim', clipIds: [lineId], style: 'in', durationFrames: 24, at: 4 }]),
	).clips[0]!;
	const dot = first<{ clipId: string; created: boolean }>(
		d.tx([{ type: 'shape.addTrimTracer', clipId: lineId, orient: true }]),
	);
	expect(dot.created).toBe(true);

	const vector = (track: string, at: number, contents: unknown[], position: [number, number]) =>
		first<{ clipId: string }>(
			d.tx([
				{
					type: 'clip.addShape',
					at,
					duration: N - at,
					track,
					shape: { type: 'vector', contents },
					transform: { position },
				},
			]),
		).clipId;
	const curveId = vector(
		'V3',
		0,
		[
			{ type: 'path', path: 'M -250 0 C -80 -170 80 170 250 0' },
			{ type: 'stroke', color: [1, 0, 0, 1], width: 8 },
		],
		[640, 330],
	);
	const curveTrim = first<TrimResult>(
		d.tx([
			{
				type: 'shape.animateTrim',
				clipIds: [curveId],
				style: 'in',
				reverse: true,
				durationFrames: 24,
				at: 4,
			},
		]),
	).clips[0]!;
	const bar = vector(
		'V4',
		0,
		[
			{ type: 'rect', size: [36, 10] },
			{ type: 'fill', color: [1, 1, 0, 1] },
		],
		[0, 0],
	);
	d.tx([{ type: 'shape.addTrimTracer', clipId: curveId, follower: { clipId: bar }, orient: true }]);

	const rect = (track: string, at: number, color: number[], position: [number, number]) =>
		vector(
			track,
			at,
			[
				{ type: 'rect', size: [300, 160] },
				{ type: 'stroke', color, width: 8 },
			],
			position,
		);
	const middleId = rect('V5', 6, [0, 1, 1, 1], [330, 560]);
	const middleTrim = first<TrimResult>(
		d.tx([
			{
				type: 'shape.animateTrim',
				clipIds: [middleId],
				style: 'middleIn',
				reverse: true,
				durationFrames: 20,
			},
		]),
	).clips[0]!;
	const divideId = rect('V6', 3, [1, 0, 1, 1], [950, 560]);
	const divideTrim = first<TrimResult>(
		d.tx([
			{
				type: 'shape.animateTrim',
				clipIds: [divideId],
				style: 'divideIn',
				copies: 4,
				animateOffset: true,
				durationFrames: 20,
			},
		]),
	).clips[0]!;
	expect(divideTrim.partIds).toHaveLength(4);
	return {
		d,
		line: { clipId: lineId, trimId: lineTrim.trimIds[0]! },
		dot: dot.clipId,
		curve: { clipId: curveId, trimId: curveTrim.trimIds[0]! },
		bar,
		middle: { clipId: middleId, trimId: middleTrim.trimIds[0]! },
		divide: { clipId: divideId, trimId: divideTrim.trimIds[0]!, parts: 4 },
	};
}

const settingsFor = (seqId: string, engine: 'auto' | 'remotion') => ({
	sequenceId: seqId,
	range: { type: 'custom', startFrame: 0, endFrame: N },
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

const layerOf = (snap: RenderSnapshot, clipId: string): RenderVisualClip =>
	snap.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === clipId)!;

function findItem(items: readonly ShapeItem[], id: string): ShapeItem | null {
	for (const it of items) {
		if (it.id === id) return it;
		if (it.type === 'group') {
			const r = findItem(it.contents, id);
			if (r) return r;
		}
	}
	return null;
}

/** Evaluated Start / End (percent) of a trim item of a shape layer at sequence frame `f`. */
function trimAt(snap: RenderSnapshot, clipId: string, trimId: string, f: number) {
	const layer = layerOf(snap, clipId);
	const src = layer.source as { shape: { type: 'vector'; contents: ShapeItem[] } };
	const trim = findItem(src.shape.contents, trimId) as unknown as {
		start: Animatable<number>;
		end: Animatable<number>;
	};
	const t = clipContentTime(layer, f, snap.settings.fps);
	return { start: evaluate(trim.start, t), end: evaluate(trim.end, t) };
}

/** Evaluated centre (sequence px) and Rotation of a follower layer at sequence frame `f`. */
function followerAt(snap: RenderSnapshot, clipId: string, f: number) {
	const layer = layerOf(snap, clipId);
	const p = resolveLayerProps(layer, clipContentTime(layer, f, snap.settings.fps));
	const q = p.quad;
	return {
		c: [(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2] as [number, number],
		rotation: p.transform!.rotation,
	};
}

describe.runIf(enabled)(
	'Trim Paths animations and tracers: hybrid and Remotion exports (REMOTION_E2E=1)',
	() => {
		let engine: RunningEngine;
		const hostH = () => ({ host: `127.0.0.1:${engine.port}` });

		beforeAll(async () => {
			engine = await startEngine({
				appdir: tempAppdir('jasper-trim-e2e-'),
				port: PORT,
				// These tests drive the engine itself, not its authentication (server.test.ts, security-hardening.test.ts).
				insecure: true,
				dev: true,
				env: { PATH: process.env.PATH, ...FWD_ENV },
			});
		}, 600_000);
		afterAll(async () => {
			await engine?.stop();
		});

		async function plan(s: Scene, which: 'auto' | 'remotion') {
			return coreServices(engine.app).exports.plan({
				envelope: s.d.envelope(),
				sequenceId: s.d.seqId,
				settings: settingsFor(s.d.seqId, which) as never,
			});
		}

		async function exportWith(s: Scene, which: 'auto' | 'remotion') {
			const r = await engine.app.inject({
				method: 'POST',
				url: '/api/exports',
				headers: { ...JSON_H, ...hostH() },
				payload: { envelope: s.d.envelope(), sequenceId: s.d.seqId, settings: settingsFor(s.d.seqId, which) },
			});
			expect(r.statusCode, r.body).toBe(202);
			const queue = coreServices(engine.app).queue;
			await until(
				() => ['succeeded', 'failed', 'cancelled'].includes(queue.get(r.json().id)?.state ?? ''),
				2_400_000,
				250,
			);
			const done = queue.get(r.json().id)!;
			expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
			const file = (await coreServices(engine.app).exports.outputFile(done.id))!;
			return { file, result: done.result as { renderPath?: string; warnings?: { code: string }[] } };
		}

		/** Evaluator oracles on one export's frames. */
		function checkOracles(name: string, frames: Img[], s: Scene, snap: RenderSnapshot) {
			const stats = { dot: 0, dotModel: 0, bar: 0, barAngle: 0, green: 0, middle: 0, divide: 0 };
			const full = (box: Box, w: typeof CYAN) => blob(frames[N - 1]!, box, w).s;
			const middleBox: Box = { x0: 160, y0: 460, x1: 500, y1: 660 };
			const divideBox: Box = { x0: 780, y0: 460, x1: 1120, y1: 660 };
			const middleFull = full(middleBox, CYAN);
			const divideFull = full(divideBox, MAGENTA);
			for (let f = 0; f < N; f++) {
				const img = frames[f]!;
				// Line + created dot: the dot sits on the evaluated End tip of the straight line (x = 340 + 6 · End).
				const lt = trimAt(snap, s.line.clipId, s.line.trimId, f);
				const dot = followerAt(snap, s.dot, f);
				if (lt.end > 3 && lt.end < 97) {
					const tipX = 340 + 6 * lt.end;
					stats.dotModel = Math.max(stats.dotModel, Math.hypot(dot.c[0] - tipX, dot.c[1] - 140));
					expect(Math.hypot(dot.c[0] - tipX, dot.c[1] - 140), `${name} f${f} evaluated dot`).toBeLessThan(
						0.5,
					);
					const m = blob(img, { x0: 300, y0: 110, x1: 980, y1: 170 }, WHITE);
					const e = Math.hypot(m.c[0] - dot.c[0], m.c[1] - dot.c[1]);
					stats.dot = Math.max(stats.dot, e);
					expect(e, `${name} f${f} dot centroid ${m.c} vs ${dot.c}`).toBeLessThanOrEqual(1);
					// The green stroke reaches the dot (hidden under it) and never passes its centre.
					let right = -1;
					for (let x = 330; x < 960; x++) if (GREEN(...px(img, x, 140)) > 0.5) right = x;
					const gap = dot.c[0] - (right + 1);
					stats.green = Math.max(stats.green, Math.abs(gap));
					expect(gap, `${name} f${f} green end ${right} vs tip ${dot.c[0]}`).toBeGreaterThanOrEqual(-1);
					expect(gap, `${name} f${f} green end ${right} vs tip ${dot.c[0]}`).toBeLessThanOrEqual(9);
				}
				// Curve + oriented bar: centre on the evaluated tip, long axis along the evaluated Rotation.
				const ct = trimAt(snap, s.curve.clipId, s.curve.trimId, f);
				if (ct.start > 3 && ct.start < 97) {
					const bar = followerAt(snap, s.bar, f);
					const m = blob(img, { x0: 340, y0: 200, x1: 940, y1: 460 }, YELLOW);
					const e = Math.hypot(m.c[0] - bar.c[0], m.c[1] - bar.c[1]);
					const a = angleDiff(m.angle, bar.rotation);
					stats.bar = Math.max(stats.bar, e);
					stats.barAngle = Math.max(stats.barAngle, a);
					expect(e, `${name} f${f} bar centroid ${m.c} vs ${bar.c}`).toBeLessThanOrEqual(1);
					expect(a, `${name} f${f} bar angle ${m.angle} vs ${bar.rotation}`).toBeLessThanOrEqual(3);
				}
				// Middle In (reverse): the drawn share of the outline is End (one piece across the path start).
				const mt = trimAt(snap, s.middle.clipId, s.middle.trimId, f);
				const mShare = blob(img, middleBox, CYAN).s / middleFull || 0;
				stats.middle = Math.max(stats.middle, Math.abs(mShare - (mt.end - mt.start) / 100));
				expect(
					Math.abs(mShare - (mt.end - mt.start) / 100),
					`${name} f${f} middle share`,
				).toBeLessThanOrEqual(0.05);
				// Divide In: N parts each drawing End − Start of the outline.
				const dt = trimAt(snap, s.divide.clipId, s.divide.trimId, f);
				const want = Math.min(1, (s.divide.parts * (dt.end - dt.start)) / 100);
				const dShare = blob(img, divideBox, MAGENTA).s / divideFull || 0;
				stats.divide = Math.max(stats.divide, Math.abs(dShare - want));
				expect(
					Math.abs(dShare - want),
					`${name} f${f} divide share ${dShare} vs ${want}`,
				).toBeLessThanOrEqual(0.05);
			}
			report(
				`[trim] ${name}: dot centroid ≤ ${stats.dot.toFixed(3)} px (evaluated dot vs analytic tip ≤ ${stats.dotModel.toFixed(3)} px), green end gap ≤ ${stats.green.toFixed(2)} px, bar centroid ≤ ${stats.bar.toFixed(3)} px / angle ≤ ${stats.barAngle.toFixed(2)}°, drawn share error middleIn ≤ ${stats.middle.toFixed(4)}, divideIn ≤ ${stats.divide.toFixed(4)}`,
			);
		}

		it('hybrid (layer bake) and Remotion exports match each other and the evaluated trims and tracer tips', async () => {
			const s = scene();
			const autoPlan = await plan(s, 'auto');
			const remotionPlan = await plan(s, 'remotion');
			// Vector shapes are DOM layers: baked through Remotion on the native composite, or the whole Remotion path.
			expect(autoPlan.plan).toMatchObject({ path: 'hybrid', blockers: [] });
			expect(remotionPlan.plan.path).toBe('remotion');
			const caps = await engine.app.inject({ method: 'GET', url: '/api/capabilities', headers: hostH() });
			report(`[trim] remotion binaries: ${JSON.stringify(caps.json().render?.remotionBinaries)}`);

			const hybrid = await exportWith(s, 'auto');
			const remotion = await exportWith(s, 'remotion');
			expect(hybrid.result.renderPath).toBe('hybrid');
			expect(remotion.result.renderPath).toBe('remotion');
			const sample = [0, 6, 10, 14, 18, 22, 26, 30, 35];
			dump(hybrid.file, 'hybrid', sample);
			dump(remotion.file, 'remotion', sample);
			const fh = decodeAll(hybrid.file);
			const fr = decodeAll(remotion.file);
			expect(fh).toHaveLength(N);
			expect(fr).toHaveLength(N);

			checkOracles('hybrid', fh, s, autoPlan.snapshot);
			checkOracles('remotion', fr, s, remotionPlan.snapshot);

			const values: number[] = [];
			let worstMean = 0;
			let worstBig = 0;
			for (let f = 0; f < N; f++) {
				const v = ssim(hybrid.file, remotion.file, f);
				values.push(v);
				let sum = 0;
				let big = 0;
				const a = fh[f]!;
				const b = fr[f]!;
				for (let i = 0; i < a.length; i++) {
					const dv = Math.abs(a[i]! - b[i]!);
					sum += dv;
					if (dv > 24) big++;
				}
				worstMean = Math.max(worstMean, sum / a.length);
				worstBig = Math.max(worstBig, big / a.length);
				expect(v, `frame ${f} SSIM`).toBeGreaterThanOrEqual(0.98);
				expect(sum / a.length, `frame ${f} mean difference`).toBeLessThan(1.5);
				expect(big / a.length, `frame ${f} share of values > 24`).toBeLessThan(0.003);
			}
			report(
				`[trim parity] hybrid vs Remotion, ${N} frames: SSIM min ${Math.min(...values).toFixed(4)} mean ${(values.reduce((x, y) => x + y, 0) / N).toFixed(4)}; worst mean |Δ| ${worstMean.toFixed(3)}, worst share of values > 24 ${(worstBig * 100).toFixed(3)} %`,
			);
		}, 3_600_000);
	},
);
