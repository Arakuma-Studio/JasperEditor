// Spec 19 §12 end to end: real renders through the engine's routes, outputs opened and inspected. `REMOTION_E2E=1`.
//   TL-112: the PSD is opened with ag-psd: layers, registration, pixels against the composite.
//   TL-114: PNGs read with ffprobe and pixel reads: real alpha, straight, trimmed around a glow, ZIP entries.
//   TL-115: a logo cut with a faint glow keeps its colour under low alpha, byte for byte.
//   TL-116: a wide-gamut frame is measured.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineJob } from '@jasper/api';
import { type LookRecipe, sequenceColorInfo } from '@jasper/project';
import { decodePng } from '@jasper/testkit/png';
import { initializeCanvas, type Layer, readPsd } from 'ag-psd';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listZip } from '../src/imports/zip.ts';
import { type RunningEngine, startEngine } from '../src/index.ts';
import { DocBuilder, JSON_H, register, TEST_FFMPEG, TEST_FFPROBE, tempAppdir, until } from './helpers.ts';

const enabled = process.env.REMOTION_E2E === '1';
const out = mkdtempSync(join(tmpdir(), 'jasper-delivery-'));
// `JASPER_FFMPEG_LGPL_ONLY=1` and the binaries in use reach the engine, so the deliveries can be run as shipped (AGENTS §2).
const FWD_ENV: Record<string, string> = {};
for (const k of [
	'JASPER_FFMPEG',
	'JASPER_FFPROBE',
	'JASPER_FFMPEG_LGPL_ONLY',
	'JASPER_REMOTION_BIN_DIR',
	'JASPER_BROWSER_EXECUTABLE',
])
	if (process.env[k]) FWD_ENV[k] = process.env[k]!;

function rawRgba(file: string): { px: Buffer; w: number; h: number } {
	const probe = spawnSync(
		TEST_FFPROBE,
		[
			'-v',
			'error',
			'-select_streams',
			'v:0',
			'-show_entries',
			'stream=width,height,pix_fmt',
			'-of',
			'json',
			file,
		],
		{ encoding: 'utf8' },
	);
	const s = JSON.parse(probe.stdout).streams[0] as { width: number; height: number; pix_fmt: string };
	expect(s.pix_fmt).toBe('rgba');
	const r = spawnSync(
		TEST_FFMPEG,
		['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
		{
			maxBuffer: 1 << 29,
		},
	);
	return { px: r.stdout, w: s.width, h: s.height };
}

describe.runIf(enabled)('delivery end to end (REMOTION_E2E=1)', () => {
	let engine: RunningEngine;
	const base = () => ({ host: `127.0.0.1:${engine.port}` });

	beforeAll(async () => {
		initializeCanvas(
			() => {
				throw new Error('no canvas');
			},
			(width: number, height: number) =>
				({
					width,
					height,
					data: new Uint8ClampedArray(width * height * 4),
					colorSpace: 'srgb',
				}) as unknown as ImageData,
		);
		engine = await startEngine({
			appdir: tempAppdir('jasper-delivery-e2e-'),
			port: Number(process.env.JASPER_E2E_PORT ?? 0),
			insecure: true,
			dev: true,
			env: { PATH: process.env.PATH, ...FWD_ENV },
		});
		// Which FFmpeg the engine and the Remotion path use, so a run with `JASPER_FFMPEG_LGPL_ONLY=1` is shown to be one.
		const caps = (
			await engine.app.inject({ method: 'GET', url: '/api/capabilities', headers: base() })
		).json();
		console.info(
			`[toolchain] ffmpeg ${caps.media.ffmpegSource} (${caps.media.encoding?.license}, lgplOnly ${caps.media.encoding?.lgplOnly}); Remotion ${JSON.stringify(caps.render.remotionBinaries)}`,
		);
		if (FWD_ENV.JASPER_FFMPEG_LGPL_ONLY === '1') expect(caps.media.encoding?.lgplOnly).toBe(true);
	}, 600_000);
	afterAll(async () => {
		await engine?.stop();
	});

	const post = async (url: string, payload: unknown) =>
		engine.app.inject({
			method: 'POST',
			url,
			headers: { ...base(), ...JSON_H, host: base().host },
			payload: payload as never,
		});
	const job = async (url: string, payload: unknown): Promise<EngineJob> => {
		const r = await post(url, payload);
		expect(r.statusCode, r.body).toBe(202);
		const id = (r.json() as EngineJob).id;
		let done: EngineJob | null = null;
		await until(
			async () => {
				const g = await engine.app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: base() });
				done = g.json() as EngineJob;
				return ['succeeded', 'failed', 'cancelled'].includes(done.state);
			},
			600_000,
			250,
		);
		const j = done as unknown as EngineJob;
		expect(j.state, JSON.stringify(j.error)).toBe('succeeded');
		return j;
	};
	const fetchTo = async (url: string, name: string) => {
		const r = await engine.app.inject({ method: 'GET', url, headers: base() });
		expect(r.statusCode).toBe(200);
		const file = join(out, name);
		writeFileSync(file, r.rawPayload);
		return file;
	};

	const glow: LookRecipe = {
		palette: { face: [1, 1, 1, 1], glow: [1, 0.2, 0.1, 1] },
		layers: [
			{ type: 'glow', params: { radius: 30 } },
			{ type: 'rim', name: 'Edge', params: { width: 4 } },
			{ type: 'face' },
		],
	};

	function title() {
		const d = new DocBuilder('hd-720p-30');
		const r = d.tx([
			{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color: [0.1, 0.3, 0.6, 1], ref: '$s' },
			{
				type: 'clip.addText',
				at: 0,
				duration: 30,
				track: 'V2',
				content: { text: 'Delivery' },
				name: 'Headline',
				ref: '$t',
			},
		]);
		d.tx([{ type: 'look.apply', clipIds: [r.refs.$t!], look: { name: 'Hot', recipe: glow } }]);
		return { d, t: r.refs.$t!, s: r.refs.$s! };
	}

	it('TL-114: a transparent still has real alpha, in PNG, TIFF and Targa', async () => {
		const { d, t, s } = title();
		d.tx([{ type: 'clip.lift', clipIds: [s] }]);
		const j = await job('/api/stills', {
			envelope: d.envelope(),
			sequenceId: d.seqId,
			frame: 10,
			alpha: true,
		});
		const file = await fetchTo((j.result as { url: string }).url, 'still.png');
		const { px, w, h } = rawRgba(file);
		expect([w, h]).toEqual([1280, 720]);
		expect(px[3]).toBe(0); // the corner is transparent, not the sequence's black
		let opaque = 0;
		let partial = 0;
		for (let i = 3; i < px.length; i += 4) {
			if (px[i] === 255) opaque++;
			else if (px[i]! > 0) partial++;
		}
		expect(opaque).toBeGreaterThan(500);
		expect(partial).toBeGreaterThan(500); // the glow
		void t;
		for (const format of ['tiff', 'tga'] as const) {
			const a = await job('/api/stills', {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				frame: 10,
				alpha: true,
				format,
			});
			const f = await fetchTo((a.result as { url: string }).url, `still.${format}`);
			const p = spawnSync(
				TEST_FFPROBE,
				['-v', 'error', '-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0', f],
				{
					encoding: 'utf8',
				},
			);
			expect(p.stdout.trim()).toMatch(/^(rgba|bgra)$/);
		}
		const refused = await post('/api/stills', {
			envelope: d.envelope(),
			sequenceId: d.seqId,
			frame: 0,
			alpha: true,
			format: 'jpeg',
		});
		expect(refused.statusCode).toBe(400);
	}, 600_000);

	it('TL-114: a PNG sequence with alpha is a ZIP of numbered frames', async () => {
		const { d, s } = title();
		d.tx([{ type: 'clip.lift', clipIds: [s] }]);
		const j = await job('/api/alpha-delivery', {
			envelope: d.envelope(),
			sequenceId: d.seqId,
			range: { start: 0, end: 3 },
		});
		const r = j.result as { url: string; format: string; frames: number; width: number };
		expect(r).toMatchObject({ format: 'zip', frames: 3, width: 1280 });
		const zip = await fetchTo(r.url, 'seq.zip');
		const entries = listZip(readFileSync(zip));
		expect(entries.map((e) => e.name)).toEqual(['frame_000000.png', 'frame_000001.png', 'frame_000002.png']);
	}, 600_000);

	it('TL-114: Export Title trims to the content with a margin, and renders past the frame so the glow is whole', async () => {
		const { d, t } = title();
		// Against the left edge: half the glow is outside the sequence frame.
		d.tx([{ type: 'param.set', target: ['clip', t, 'transform', 'position'], value: [120, 360] }]);
		const margin = 12;
		const j = await job('/api/alpha-delivery', {
			envelope: d.envelope(),
			sequenceId: d.seqId,
			range: { start: 5, end: 6 },
			clipIds: [t],
			trim: { marginPx: margin },
		});
		const r = j.result as {
			url: string;
			width: number;
			height: number;
			origin: { x: number; y: number };
			format: string;
			warnings: unknown[];
		};
		expect(r.format).toBe('png');
		expect(r.warnings).toEqual([]);
		expect(r.width).toBeLessThan(1280);
		expect(r.height).toBeLessThan(360);
		expect(r.origin.x).toBeLessThan(0); // the picture starts left of the frame: the glow was not cut there
		const { px, w, h } = rawRgba(await fetchTo(r.url, 'title.png'));
		expect([w, h]).toEqual([r.width, r.height]);
		// The margin is clear and the content starts right after it.
		const rowHas = (y: number) => {
			for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3]! > 0) return true;
			return false;
		};
		const colHas = (x: number) => {
			for (let y = 0; y < h; y++) if (px[(y * w + x) * 4 + 3]! > 0) return true;
			return false;
		};
		for (let i = 0; i < margin; i++) {
			expect(rowHas(i)).toBe(false);
			expect(rowHas(h - 1 - i)).toBe(false);
			expect(colHas(i)).toBe(false);
			expect(colHas(w - 1 - i)).toBe(false);
		}
		expect(rowHas(margin)).toBe(true);
		expect(colHas(margin)).toBe(true);
	}, 900_000);

	it('TL-112: the frame as a PSD: layers registered, text rasterised, composite the render', async () => {
		const { d, t } = title();
		const body = { envelope: d.envelope(), sequenceId: d.seqId, frame: 10, splitTitles: true };
		const planned = await post('/api/psd/plan', body);
		expect(planned.statusCode, planned.body).toBe(200);
		const plan = planned.json() as { blockers: unknown[]; baked: string[]; layers: { name: string }[] };
		expect(plan.blockers).toEqual([]);
		expect(plan.baked.join()).toContain('Headline: text rasterised');
		const j = await job('/api/psd', body);
		const r = j.result as { url: string; bytes: number };
		const file = await fetchTo(r.url, 'frame.psd');
		const psd = readPsd(readFileSync(file), { useImageData: true });
		expect([psd.width, psd.height, psd.bitsPerChannel]).toEqual([1280, 720, 8]);
		expect(psd.children!.map((l) => l.name)).toEqual(['Background', expect.any(String), 'Headline']);
		// The background is a layer with pixels, full frame, regression of an empty one.
		expect([psd.children![0]!.right, psd.children![0]!.bottom]).toEqual([1280, 720]);
		const group = psd.children![2]!;
		expect(group.children!.map((l: Layer) => l.name)).toEqual(['Edge', 'face', 'fx']);
		const fx = group.children![2]!;
		const face = group.children![1]!;
		const edge = group.children![0]!;
		// Registered: the parts nest, inside the full look, at real positions.
		expect(fx.left!).toBeLessThan(face.left!);
		expect(edge.left!).toBeLessThanOrEqual(face.left!);
		expect(edge.right!).toBeGreaterThanOrEqual(face.right!);
		expect(fx.right!).toBeGreaterThan(face.right!);
		// The solid and the title recombine to the composite (normal blending, an opaque solid under the title).
		const comp = psd.imageData as unknown as { data: Uint8Array; width: number };
		const cx = Math.floor(((fx.left ?? 0) + (fx.right ?? 0)) / 2);
		const cy = Math.floor(((fx.top ?? 0) + (fx.bottom ?? 0)) / 2);
		const fxData = fx.imageData as unknown as { data: Uint8Array; width: number };
		const i = ((cy - fx.top!) * fxData.width + (cx - fx.left!)) * 4;
		const a = fxData.data[i + 3]! / 255;
		const under = [0.1, 0.3, 0.6].map((v) => v * 255);
		const c = (cy * comp.width + cx) * 4;
		for (const k of [0, 1, 2]) {
			const recombined = fxData.data[i + k]! * a + under[k]! * (1 - a);
			expect(Math.abs(recombined - comp.data[c + k]!)).toBeLessThan(6);
		}
		void t;
	}, 900_000);

	it('TL-115: a split keeps colour under low alpha, byte for byte, and registers parts', async () => {
		const w = 300;
		const h = 80;
		const px = new Uint8Array(w * h * 4);
		const put = (x: number, y: number, c: number[]) => px.set(c, (y * w + x) * 4);
		for (let y = 20; y < 60; y++) for (let x = 20; x < 60; x++) put(x, y, [200, 40, 40, 255]);
		// A glow with colours a canvas would destroy (premultiplied at alpha 2, 91 becomes 89 or 102).
		for (let y = 10; y < 70; y++)
			for (let x = 10; x < 70; x++)
				if (!(y >= 20 && y < 60 && x >= 20 && x < 60)) put(x, y, [91, 173, 37, 2]);
		for (let y = 20; y < 60; y++) for (let x = 220; x < 280; x++) put(x, y, [10, 200, 90, 255]);
		const png = join(out, 'logo.png');
		const raw = join(out, 'logo.rgba');
		writeFileSync(raw, px);
		const e = spawnSync(TEST_FFMPEG, [
			'-y',
			'-v',
			'error',
			'-f',
			'rawvideo',
			'-pix_fmt',
			'rgba',
			'-s',
			`${w}x${h}`,
			'-i',
			raw,
			'-frames:v',
			'1',
			'-c:v',
			'png',
			'-pix_fmt',
			'rgba',
			png,
		]);
		expect(e.status, String(e.stderr)).toBe(0);
		const media = await register(engine.app as never, png, base());
		const a = await job(`/api/media/${media.mediaKey}/split-image/analyze`, {});
		const analysis = a.result as { islands: unknown[]; labelMapUrl: string; cols: number; rows: number };
		expect(analysis.islands).toHaveLength(2);
		const map = decodePng(readFileSync(await fetchTo(analysis.labelMapUrl, 'labels.png')));
		expect(map.width).toBe(analysis.cols);
		const j = await job(`/api/media/${media.mediaKey}/split-image`, { groups: [[0], [1]] });
		const parts = (
			j.result as {
				parts: { media: { mediaKey: string }; box: { x: number; y: number; w: number; h: number } }[];
			}
		).parts;
		expect(parts).toHaveLength(2);
		const back = Buffer.alloc(px.length);
		for (const p of parts) {
			const got = rawRgba(
				await fetchTo(`/media/${encodeURIComponent(p.media.mediaKey)}`, `${p.media.mediaKey}.png`),
			);
			expect([got.w, got.h]).toEqual([p.box.w, p.box.h]);
			for (let y = 0; y < got.h; y++)
				for (let x = 0; x < got.w; x++) {
					const s = (y * got.w + x) * 4;
					if (got.px[s + 3]! === 0) continue;
					got.px.copy(back, ((y + p.box.y) * w + x + p.box.x) * 4, s, s + 4);
				}
		}
		expect(Buffer.compare(back, Buffer.from(px))).toBe(0);
	}, 600_000);

	it('TL-116: a wide-gamut frame is outside Rec. 709, and the mask marks it', async () => {
		// Graphics are SDR by rule; a still interpreted as Rec. 2020 holds the colours that do not fit.
		const raw = join(out, 'red.rgba');
		writeFileSync(raw, Buffer.alloc(64 * 64 * 4, Buffer.from([255, 0, 0, 255])));
		const png = join(out, 'red.png');
		const e = spawnSync(TEST_FFMPEG, [
			'-y',
			'-v',
			'error',
			'-f',
			'rawvideo',
			'-pix_fmt',
			'rgba',
			'-s',
			'64x64',
			'-i',
			raw,
			'-frames:v',
			'1',
			png,
		]);
		expect(e.status, String(e.stderr)).toBe(0);
		const media = await register(engine.app as never, png, base());
		const d = new DocBuilder('hd-720p-30');
		const mediaId = d.addMedia(media);
		d.tx([
			{ type: 'sequence.updateSettings', settings: { workingColorSpace: 'rec2020' } },
			{ type: 'media.interpretColor', mediaIds: [mediaId], color: { space: 'rec2020' } },
			{ type: 'clip.place', source: { mediaId }, at: 0, tracks: { video: 'V1' }, scaling: 'fill' },
		]);
		const seq = d.doc.sequences[d.seqId]!;
		expect(sequenceColorInfo(seq.settings).space).toBe('rec2020');
		const j = await job('/api/gamut-check', {
			envelope: d.envelope(),
			sequenceId: d.seqId,
			frame: 0,
			output: 'rec709',
		});
		const r = j.result as { gamutPercent: number; outputLabel: string; maskUrl: string };
		expect(r.gamutPercent).toBeGreaterThan(90);
		const mask = rawRgba(await fetchTo(r.maskUrl, 'mask.png'));
		expect(mask.px[3]).toBe(255);
		const inside = await job('/api/gamut-check', {
			envelope: d.envelope(),
			sequenceId: d.seqId,
			frame: 0,
			output: 'rec2020',
		});
		expect((inside.result as { gamutPercent: number }).gamutPercent).toBe(0);
	}, 600_000);
});
