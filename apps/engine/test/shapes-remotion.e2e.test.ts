// Shapes rendered for real (S11:SHP-004, wp-m2-shapes, REMOTION_E2E=1): a still of a 720p frame with a filled
// rectangle with an inside stroke, a circle with an outside stroke and no fill, a centre-stroked rectangle and a
// filled ellipse is compared with an analytic reference (4×4 supersampled coverage of the exact geometry):
// edge positions, visible stroke widths (inside / center / outside all equal `width`) and colours.
// Before wp-m2-layer-bake the still renders on the Remotion path; with the layer bake it renders natively with
// the shapes baked by Remotion — the pixels must match the same reference either way.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { coreServices } from '../src/tools/services.ts';
import { DocBuilder, ROOT, tempAppdir } from './helpers.ts';

const enabled = process.env.REMOTION_E2E === '1';
const PORT = Number(process.env.JASPER_E2E_PORT ?? 0);
const W = 1280;
const H = 720;

const FFMPEG = (() => {
	const vendor = join(ROOT, 'vendor', 'ffmpeg-lgpl', 'linux-x64', 'ffmpeg');
	return process.env.JASPER_FFMPEG || (spawnSync(vendor, ['-version']).status === 0 ? vendor : 'ffmpeg');
})();

type RGB = [number, number, number];
const RED: RGB = [255, 0, 0];
const BLUE: RGB = [0, 0, 255];
const GREEN: RGB = [0, 255, 0];
const WHITE: RGB = [255, 255, 255];
const YELLOW: RGB = [255, 255, 0];
const BLACK: RGB = [0, 0, 0];

/** Colour of the analytic scene at a sub-pixel point (later shapes on higher tracks win). */
function sceneAt(x: number, y: number): RGB {
	let c = BLACK;
	// V1: rect 400×200 centred at (320, 200), red fill, blue 10 px inside stroke.
	if (x >= 120 && x <= 520 && y >= 100 && y <= 300)
		c = Math.min(x - 120, 520 - x, y - 100, 300 - y) < 10 ? BLUE : RED;
	// V2: circle d = 300 centred at (900, 250), no fill, green 8 px outside stroke.
	const r = Math.hypot(x - 900, y - 250);
	if (r > 150 && r <= 158) c = GREEN;
	// V3: rect 200×100 centred at (300, 560), no fill, white 20 px stroke centred on the outline (miter corners).
	const inOuter = x >= 190 && x <= 410 && y >= 500 && y <= 620;
	const inInner = x > 210 && x < 390 && y > 520 && y < 600;
	if (inOuter && !inInner) c = WHITE;
	// V4: ellipse 300×160 centred at (900, 560), yellow fill.
	if (((x - 900) / 150) ** 2 + ((y - 560) / 80) ** 2 <= 1) c = YELLOW;
	return c;
}

function reference(): Uint8Array {
	const out = new Uint8Array(W * H * 3);
	const S = 4;
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const acc = [0, 0, 0];
			for (let j = 0; j < S; j++)
				for (let i = 0; i < S; i++) {
					const c = sceneAt(x + (i + 0.5) / S, y + (j + 0.5) / S);
					acc[0]! += c[0];
					acc[1]! += c[1];
					acc[2]! += c[2];
				}
			for (let k = 0; k < 3; k++) out[(y * W + x) * 3 + k] = Math.round(acc[k]! / (S * S));
		}
	return out;
}

/** Length of the run of pixels matching `pred` along a row or column starting at (x, y). */
function run(
	img: Uint8Array,
	x: number,
	y: number,
	dx: number,
	dy: number,
	pred: (c: RGB) => boolean,
): number {
	let n = 0;
	for (; x >= 0 && y >= 0 && x < W && y < H; x += dx, y += dy) {
		const i = (y * W + x) * 3;
		if (!pred([img[i]!, img[i + 1]!, img[i + 2]!])) break;
		n++;
	}
	return n;
}
const near =
	(want: RGB, tol = 40) =>
	(c: RGB) =>
		c.every((v, k) => Math.abs(v - want[k]!) <= tol);

describe.runIf(enabled)('shape stills against the analytic reference (REMOTION_E2E=1)', () => {
	it('edges, stroke widths and colours of rect / circle / ellipse with inside, outside and centre strokes', async () => {
		const engine: RunningEngine = await startEngine({
			appdir: tempAppdir(),
			port: PORT,
			dev: true,
			env: {
				PATH: process.env.PATH,
				...(process.env.JASPER_BROWSER_EXECUTABLE
					? { JASPER_BROWSER_EXECUTABLE: process.env.JASPER_BROWSER_EXECUTABLE }
					: {}),
			},
		});
		try {
			const d = new DocBuilder('hd-720p-30');
			const shape = (track: string, shape: Record<string, unknown>, position: [number, number]) => ({
				type: 'clip.addShape',
				at: 0,
				duration: 30,
				track,
				shape,
				transform: { position },
			});
			d.tx([
				shape(
					'V1',
					{
						type: 'rect',
						size: [400, 200],
						fill: [1, 0, 0, 1],
						stroke: { color: [0, 0, 1, 1], width: 10, position: 'inside' },
					},
					[320, 200],
				),
				shape(
					'V2',
					{
						type: 'ellipse',
						size: [300, 300],
						fill: null,
						stroke: { color: [0, 1, 0, 1], width: 8, position: 'outside' },
					},
					[900, 250],
				),
				shape(
					'V3',
					{
						type: 'rect',
						size: [200, 100],
						fill: null,
						stroke: { color: [1, 1, 1, 1], width: 20, position: 'center' },
					},
					[300, 560],
				),
				shape('V4', { type: 'ellipse', size: [300, 160], fill: [1, 1, 0, 1] }, [900, 560]),
			]);
			const res = await fetch(`${engine.url}/api/stills`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ envelope: d.envelope(), sequenceId: d.seqId, frame: 5 }),
			});
			const job = await res.json();
			const done = await coreServices(engine.app).queue.wait(job.id);
			expect(done.error).toBeUndefined();
			expect(done.state).toBe('succeeded');
			// Remotion path today; native with baked layers once wp-m2-layer-bake is merged (LBK-025).
			expect(['remotion', 'native', 'hybrid']).toContain((done.result as { renderPath: string }).renderPath);
			const png = await fetch(`${engine.url}${(done.result as { url: string }).url}`);
			expect(png.status).toBe(200);
			const file = join(mkdtempSync(join(tmpdir(), 'jasper-shapes-')), 'still.png');
			writeFileSync(file, Buffer.from(await png.arrayBuffer()));
			const raw = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
				maxBuffer: 1 << 26,
			}).stdout;
			const img = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
			expect(img.length).toBe(W * H * 3);

			// Visible stroke widths along the middle rows/columns (±1 px for anti-aliasing).
			expect(run(img, 121, 200, 1, 0, near(BLUE))).toBeGreaterThanOrEqual(8); // inside: 10 px from x = 120
			expect(run(img, 121, 200, 1, 0, near(BLUE))).toBeLessThanOrEqual(10);
			expect(run(img, 320, 101, 0, 1, near(BLUE))).toBeGreaterThanOrEqual(8);
			expect(run(img, 1051, 250, 1, 0, near(GREEN))).toBeGreaterThanOrEqual(6); // outside: 8 px from r = 150
			expect(run(img, 1051, 250, 1, 0, near(GREEN))).toBeLessThanOrEqual(8);
			expect(run(img, 900, 92, 0, 1, near(GREEN))).toBeGreaterThanOrEqual(6);
			expect(run(img, 191, 560, 1, 0, near(WHITE))).toBeGreaterThanOrEqual(18); // centre: 20 px across x = 200
			expect(run(img, 191, 560, 1, 0, near(WHITE))).toBeLessThanOrEqual(20);
			// Interiors and outsides.
			const px = (x: number, y: number): RGB => {
				const i = (y * W + x) * 3;
				return [img[i]!, img[i + 1]!, img[i + 2]!];
			};
			expect(near(RED, 3)(px(320, 200))).toBe(true);
			expect(near(BLACK, 3)(px(900, 250))).toBe(true); // circle without fill
			expect(near(BLACK, 3)(px(300, 560))).toBe(true); // centre-stroked rect without fill
			expect(near(YELLOW, 3)(px(900, 560))).toBe(true);
			expect(near(BLACK, 3)(px(1045, 495))).toBe(true); // ellipse box corner, outside the ellipse
			expect(near(WHITE, 3)(px(192, 502))).toBe(true); // square (miter) outer corner of the centre stroke

			// Whole frame against the analytic reference: AA differences only on edge pixels.
			const ref = reference();
			let worst = 0;
			let off = 0;
			for (let i = 0; i < img.length; i += 3) {
				const dmax = Math.max(
					Math.abs(img[i]! - ref[i]!),
					Math.abs(img[i + 1]! - ref[i + 1]!),
					Math.abs(img[i + 2]! - ref[i + 2]!),
				);
				worst = Math.max(worst, dmax);
				if (dmax > 3) off++;
			}
			const share = off / (W * H);
			console.info(
				`[S11:SHP-004] shapes still vs analytic reference: ${(share * 100).toFixed(3)} % pixels > 3/255, worst ${worst}`,
			);
			expect(share).toBeLessThan(0.005);
			// AA conflation at fill|stroke edges stays well below a half-pixel shift (≈ 170 on these edges).
			expect(worst).toBeLessThan(100);
		} finally {
			await engine.stop();
		}
	}, 300_000);
});
