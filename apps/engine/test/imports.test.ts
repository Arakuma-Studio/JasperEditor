import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import type { LayeredExtractResult, MediaVariantStatus, RegisteredMedia } from '@jasper/api';
import { fileFieldOrder } from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { editorBlendMode, psdBlendMode } from '../src/imports/psd.ts';
import { listZip, readZipEntry, writeStoredZip, ZipError } from '../src/imports/zip.ts';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	JSON_H,
	makeApp,
	register,
	TEST_FFMPEG,
	type TestApp,
	tempAppdir,
} from './helpers.ts';

describe('zip reader', () => {
	it('writes interoperable stored ZIP records and reads bounded deflated entries', () => {
		// PKWARE APPNOTE §§4.3.7/12/16: independent wire fields, not this module's own reader.
		const zip = writeStoredZip([{ name: 'a.txt', data: Buffer.from('123456789') }]);
		expect(zip.readUInt32LE(0)).toBe(0x04034b50);
		expect(zip.readUInt16LE(8)).toBe(0);
		const payload = 30 + zip.readUInt16LE(26) + zip.readUInt16LE(28);
		expect(zip.subarray(30, 30 + zip.readUInt16LE(26)).toString()).toBe('a.txt');
		expect(zip.subarray(payload, payload + 9).toString()).toBe('123456789');
		const cd = zip.readUInt32LE(zip.lastIndexOf(Buffer.from('504b0506', 'hex')) + 16);
		expect(zip.readUInt32LE(cd)).toBe(0x02014b50);
		expect(zip.readUInt32LE(cd + 16)).toBe(crc32('123456789'));
		expect(zip.readUInt32LE(cd + 42)).toBe(0);
		const archive = readFileSync(fixture('imports-anim.lottie'));
		const manifest = listZip(archive).find((e) => e.name === 'manifest.json')!;
		expect(manifest.method).toBe(8);
		expect(JSON.parse(readZipEntry(archive, manifest).toString()).animations).toEqual([{ id: 'spin' }]);
		expect(() => readZipEntry(archive, manifest, 8)).toThrow(ZipError);
	});
});

describe('PSD blend modes and decode filters', () => {
	it('maps Photoshop aliases and falls back to normal for an unsupported mode', () => {
		expect(editorBlendMode('linear-dodge')).toBe('add');
		expect(psdBlendMode('subtraction').mode).toBe('subtract');
		expect(psdBlendMode('weird').mode).toBe('normal');
	});
});

let app: TestApp;
beforeAll(async () => {
	ensureFixtures();
	if (!existsSync(fixture('imports-layers.psd')) || !existsSync(fixture('imports-seq')))
		spawnSync(process.execPath, [fixture('../../scripts/make-fixtures.mjs')], { stdio: 'inherit' });
	app = await makeApp();
}, 300_000);
afterAll(closeApps);

async function get(url: string) {
	return app.inject({ method: 'GET', url, headers: JSON_H });
}
async function post(url: string, payload: unknown) {
	return app.inject({ method: 'POST', url, headers: JSON_H, payload: payload as never });
}

describe('imports on the engine', () => {
	it('probes every imported format', async () => {
		const svg = await register(app, fixture('imports-logo.svg'));
		expect(svg).toMatchObject({ kind: 'image', vector: { format: 'svg' } });
		const pdf = await register(app, fixture('imports-doc.pdf'));
		expect(pdf.vector).toMatchObject({ format: 'pdf', pageCount: 2, page: 1, source: 'pdf' });
		// Same bytes as the PDF would dedupe to it: a copy with a trailing comment is a different file.
		const aiCopy = join(mkdtempSync(join(tmpdir(), 'jasper-ai-')), 'doc.ai');
		writeFileSync(
			aiCopy,
			Buffer.concat([readFileSync(fixture('imports-doc.ai')), Buffer.from('\n% ai copy\n')]),
		);
		const ai = await register(app, aiCopy);
		expect(ai.vector).toMatchObject({ format: 'pdf', source: 'ai' });
		for (const f of ['imports-anim.json', 'imports-anim.lottie']) {
			const l = await register(app, fixture(f));
			expect(l.kind).toBe('animated-image');
			expect(l.lottie!.fps).toBeGreaterThan(0);
			expect(l.probe.durationFlicks).toBeGreaterThan(0);
		}
		const psd = await register(app, fixture('imports-layers.psd'));
		expect(psd.layered).toMatchObject({ format: 'psd' });
		expect(psd.layered!.layerCount).toBeGreaterThan(2);
		for (const f of [
			'imports-still.exr',
			'imports-still-16.tif',
			'imports-still.tga',
			'imports-still.bmp',
			'imports-still.dpx',
			'imports-still.heic',
			'imports-still.jxl',
		]) {
			if (!existsSync(fixture(f))) continue;
			const m = await register(app, fixture(f));
			expect(m.kind, f).toBe('image');
			expect(
				m.probe.streams.find((s) => s.type === 'video'),
				f,
			).toBeTruthy();
		}
		const tga = await register(app, fixture('imports-still.tga'));
		expect(tga.probe.hasAlpha).toBe(true);
		const inter = await register(app, fixture('imports-interlaced.mkv'));
		const vs = inter.probe.streams.find((s) => s.type === 'video') as { fieldOrder?: string };
		// ffmpeg's own encoders tag top-field-first frames `tb` (fftools) and the mov/mkv demuxers read `tt`/`tb` for
		// "top displayed first": both are Upper Field First.
		expect(['tt', 'tb']).toContain(vs.fieldOrder);
		expect(fileFieldOrder(inter as never)).toBe('upper');
		const ana = await register(app, fixture('imports-anamorphic.mkv'));
		expect(ana.probe.streams.find((s) => s.type === 'video')).toMatchObject({
			pixelAspect: { num: 10, den: 11 },
		});
	}, 120_000);

	it('serves Lottie documents, SVG text and PDF pages', async () => {
		const lottie = await register(app, fixture('imports-anim.lottie'));
		const doc = await get(`/media/${lottie.mediaKey}/lottie.json`);
		expect(doc.statusCode).toBe(200);
		expect(Array.isArray(doc.json().layers)).toBe(true);
		const svg = await register(app, fixture('imports-logo.svg'));
		const text = await get(`/media/${svg.mediaKey}/vector`);
		expect(text.statusCode).toBe(200);
		expect(text.headers['content-security-policy']).toMatch(/default-src 'none'/);
		expect(text.body).toMatch(/<svg/);
		const pdf = await register(app, fixture('imports-doc.pdf'));
		const pages = await get(`/api/imports/vector/${pdf.mediaKey}`);
		expect(pages.json().pages).toHaveLength(2);
		expect((await get(`/media/${svg.mediaKey}/lottie.json`)).statusCode).toBe(404);
	});

	it('conforms an image sequence with a gap holding the previous frame', async () => {
		const r = await post('/api/imports/image-sequence?wait=1', {
			projectId: 'prj_0000000000000001',
			path: fixture('imports-seq/shot_0001.png'),
			frameRate: { num: 12, den: 1 },
		});
		expect(r.statusCode, r.body).toBe(200);
		const reg = r.json().result as RegisteredMedia;
		expect(reg.kind).toBe('video');
		expect(reg.imageSequence).toMatchObject({
			first: 1,
			last: 12,
			frames: 12,
			missing: [7],
			frameRate: { num: 12, den: 1 },
		});
		expect(reg.probe.durationFlicks).toBe(705_600_000);
		const file = await coreServices(app).registry.resolvePath(reg.mediaKey);
		const md5 = spawnSync('ffmpeg', ['-v', 'error', '-i', file!, '-f', 'framemd5', '-'], { encoding: 'utf8' })
			.stdout.split('\n')
			.filter((l) => /^\d/.test(l))
			.map((l) => l.split(',').pop()!.trim());
		expect(md5).toHaveLength(12);
		expect(md5[6]).toBe(md5[5]);
		expect(md5[7]).not.toBe(md5[6]);
		const detect = await post('/api/imports/image-sequence/detect', {
			path: fixture('imports-seq/shot_0004.png'),
		});
		expect(detect.json()).toMatchObject({ first: 1, last: 12, count: 11, missing: [7] });
	}, 120_000);

	it('extracts PSD layers with blend modes, opacity, visibility and groups', async () => {
		const psd = await register(app, fixture('imports-layers.psd'));
		const r = await post('/api/imports/layers?wait=1', {
			mediaKey: psd.mediaKey,
			projectId: 'prj_0000000000000001',
		});
		expect(r.statusCode, r.body).toBe(200);
		const res = r.json().result as LayeredExtractResult;
		expect(res.info.width).toBe(psd.layered!.width);
		const flat: LayeredExtractResult['layers'] = [];
		const walk = (ls: LayeredExtractResult['layers']) => {
			for (const l of ls) {
				flat.push(l);
				if (l.children) walk(l.children);
			}
		};
		walk(res.layers);
		const group = flat.find((l) => l.kind === 'group');
		expect(group?.name).toBe('Badge');
		expect(group?.opacity).toBeCloseTo(0.8, 2);
		expect(flat.some((l) => l.blendMode !== 'normal' && l.blendMode !== 'pass-through')).toBe(true);
		expect(flat.some((l) => !l.visible)).toBe(true);
		expect(flat.filter((l) => l.media).every((l) => l.media!.kind === 'image')).toBe(true);
		const pixel = flat.filter((l) => l.media).map((l) => l.index);
		const m = await post('/api/imports/layers?wait=1', { mediaKey: psd.mediaKey, merge: pixel.slice(0, 2) });
		const merged = (m.json().result as LayeredExtractResult).merged!;
		expect(merged.probe.streams[0]).toMatchObject({ width: psd.layered!.width, height: psd.layered!.height });
	}, 120_000);

	it('makes sRGB display pictures of linear EXR without losing deep-source precision', async () => {
		const linear = join(tempAppdir('jasper-linear-exr-'), 'gray.exr');
		// Four nearly equal scene-linear grays per RGB plane: all round to the same 8-bit sRGB code.
		const data = Float32Array.from({ length: 12 }, (_, i) => 0.25 + (i % 4) * 0.0002);
		const encodeArgs = [
			...['-v', 'error', '-f', 'rawvideo', '-pixel_format', 'gbrpf32le', '-video_size', '2x2', '-i', '-'],
			...['-frames:v', '1', '-c:v', 'exr', '-format', 'half', linear],
		];
		const made = spawnSync(TEST_FFMPEG, encodeArgs, { input: Buffer.from(data.buffer) });
		expect(made.status, made.stderr?.toString()).toBe(0);
		for (const file of [linear, fixture('imports-still-16.tif')]) {
			const media = await register(app, file);
			const r = await post(`/api/media/${media.mediaKey}/variants`, { kind: 'display', variant: '' });
			expect(r.statusCode, r.body).toBe(200);
			const { jobId } = r.json() as MediaVariantStatus;
			if (jobId) expect((await coreServices(app).queue.wait(jobId)).state).toBe('succeeded');
			const served = await get(`/media/${media.mediaKey}/variant/display`);
			expect(served.statusCode, served.body).toBe(200);
			expect(served.headers['content-type']).toBe('image/png');
			expect(served.rawPayload.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
			expect(served.rawPayload[24]).toBe(16); // PNG IHDR bit depth, independently specified on the wire.
			if (file === linear) {
				const decodeArgs = ['-v', 'error', '-i', '-', '-pix_fmt', 'rgb48le', '-f', 'rawvideo', '-'];
				const rgb = spawnSync(TEST_FFMPEG, decodeArgs, { input: served.rawPayload });
				expect(rgb.status, rgb.stderr?.toString()).toBe(0);
				expect(rgb.stdout.length).toBe(24);
				const grays = Array.from({ length: 4 }, (_, i) => rgb.stdout.readUInt16LE(i * 6));
				expect(grays.every((v) => Math.abs(v / 257 - 137) <= 1)).toBe(true); // sRGB(.25) ≈ .5371
				const span = Math.max(...grays) - Math.min(...grays);
				expect(span).toBeGreaterThan(0);
				expect(span).toBeLessThan(257); // Preserve differences smaller than one 8-bit code.
				expect((await get(`/media/${media.mediaKey}/variant/display?v=bogus`)).statusCode).toBe(400);
			}
		}
	}, 120_000);

	it('exports a sequence with a still and a Lottie clip as Lottie', async () => {
		const d = new DocBuilder();
		const still = d.addMedia(await register(app, fixture('still.png')));
		const anim = d.addMedia(await register(app, fixture('imports-anim.json')));
		d.tx([
			{ type: 'clip.place', source: { mediaId: still }, at: 0, tracks: { video: 'V1' } },
			{ type: 'clip.place', source: { mediaId: anim }, at: 0, tracks: { video: 'V2' } },
		]);
		const r = await post('/api/imports/lottie/export', {
			envelope: d.envelope(),
			sequenceId: d.seqId,
			format: 'json',
		});
		expect(r.statusCode, r.body).toBe(200);
		const out = r.json();
		const json = JSON.parse(Buffer.from(out.contentBase64, 'base64').toString());
		const types = (json.layers as { ty: number }[]).map((l) => l.ty);
		expect(types).toContain(2);
		expect(types).toContain(0);
		expect((json.assets as { p?: string }[]).some((a) => a.p?.startsWith('data:image/png;base64,'))).toBe(
			true,
		);
		const lot = await post('/api/imports/lottie/export', {
			envelope: d.envelope(),
			sequenceId: d.seqId,
			format: 'dotlottie',
		});
		const zip = Buffer.from(lot.json().contentBase64, 'base64');
		expect(listZip(zip).map((e) => e.name)).toEqual(expect.arrayContaining(['manifest.json']));
	}, 120_000);

	it('Interpret Footage ▸ Alpha Channel changes the native export (measured pixels)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-alpha-'));
		const png = join(dir, 'premul.png');
		// Premultiplied colour (64, 32, 16) at alpha 128 = straight (128, 64, 32).
		const mk = spawnSync('ffmpeg', [
			...['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x402010:size=64x36:duration=1'],
			...['-vf', "format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='128'", '-frames:v', '1', png],
		]);
		expect(mk.status).toBe(0);
		const reg = await register(app, png);
		const measure = async (interpretation: Record<string, unknown> | null) => {
			const d = new DocBuilder();
			d.tx([{ type: 'sequence.updateSettings', settings: { width: 64, height: 36 } }]);
			const m = d.addMedia(reg);
			if (interpretation) d.tx([{ type: 'media.interpret', mediaIds: [m], interpretation }]);
			d.tx([{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { video: 'V1' } }]);
			const start = await post('/api/exports', {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: {
					sequenceId: d.seqId,
					range: { type: 'custom', startFrame: 0, endFrame: 1 },
					container: 'mp4',
					video: {
						codec: 'h264',
						width: 64,
						height: 36,
						frameRate: { num: 30, den: 1 },
						scaling: 'fit',
						quality: { mode: 'crf', value: 12 },
						encoderSpeed: 'fast',
					},
					audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
					engine: 'native',
				},
			});
			expect(start.statusCode, start.body).toBe(202);
			const done = await coreServices(app).queue.wait(start.json().id);
			expect(done.error, JSON.stringify(done.error)).toBeUndefined();
			const file = (await coreServices(app).exports.outputFile(start.json().id))!;
			const px = spawnSync('ffmpeg', [
				...[
					'-v',
					'error',
					'-i',
					file,
					'-vf',
					'format=rgb24,crop=1:1:32:18',
					'-frames:v',
					'1',
					'-f',
					'rawvideo',
					'-',
				],
			]).stdout;
			return [px[0]!, px[1]!, px[2]!];
		};
		const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) <= 5);
		const straight = await measure(null);
		const premul = await measure({ alpha: { mode: 'premultiplied' } });
		const ignore = await measure({ alpha: { mode: 'ignore' } });
		const hidden = await measure({ alpha: { mode: 'ignore', invert: true } });
		expect(near(straight, [32, 16, 8]), String(straight)).toBe(true);
		expect(near(premul, [64, 32, 16]), String(premul)).toBe(true);
		expect(near(ignore, [64, 32, 16]), String(ignore)).toBe(true);
		expect(near(hidden, [0, 0, 0]), String(hidden)).toBe(true);
	}, 300_000);
});
