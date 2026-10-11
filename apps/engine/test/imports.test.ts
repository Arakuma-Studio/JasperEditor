import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LayeredExtractResult, RegisteredMedia } from '@jasper/api';
import { PSD_BLEND_MODES } from '@jasper/api';
import { BLEND_MODES, fileFieldOrder } from '@jasper/project';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decoderArgs, isDeep, sourceFilters } from '../src/imports/decode.ts';
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
	type TestApp,
} from './helpers.ts';

describe('zip reader', () => {
	it('round-trips stored archives and reads deflated entries', () => {
		const files = [
			{ name: 'manifest.json', data: Buffer.from('{"version":"1"}') },
			{ name: 'animations/a.json', data: Buffer.from('x'.repeat(5000)) },
		];
		const zip = writeStoredZip(files);
		const entries = listZip(zip);
		expect(entries.map((e) => e.name)).toEqual(['manifest.json', 'animations/a.json']);
		expect(readZipEntry(zip, entries[1]!).toString()).toBe('x'.repeat(5000));
		// A deflated archive written by the system zip tool when present.
		const dir = mkdtempSync(join(tmpdir(), 'jasper-zip-'));
		const r = spawnSync('python3', [
			'-c',
			`import zipfile;z=zipfile.ZipFile('${dir}/d.zip','w',zipfile.ZIP_DEFLATED);z.writestr('a.txt','hello '*1000);z.close()`,
		]);
		if (r.status === 0) {
			const buf = readFileSync(join(dir, 'd.zip'));
			const e = listZip(buf);
			expect(e[0]!.method).toBe(8);
			expect(readZipEntry(buf, e[0]!).toString()).toBe('hello '.repeat(1000));
			expect(() => readZipEntry(buf, e[0]!, 100)).toThrow(ZipError);
		}
	});

	it('never crashes on hostile bytes (fuzz)', () => {
		const good = writeStoredZip([{ name: 'a.json', data: Buffer.from('{"a":1}') }]);
		fc.assert(
			fc.property(fc.uint8Array({ maxLength: 400 }), fc.nat(good.length), fc.nat(255), (junk, at, byte) => {
				for (const buf of [
					Buffer.from(junk),
					Buffer.from(good).fill(byte, Math.min(at, good.length - 1), Math.min(at + 1, good.length)),
					good.subarray(0, at),
				]) {
					try {
						for (const e of listZip(buf)) readZipEntry(buf, e, 1 << 20);
					} catch (e) {
						expect(e).toBeInstanceOf(ZipError);
					}
				}
			}),
			{ numRuns: 300 },
		);
	});
});

describe('PSD blend modes and decode filters', () => {
	it('maps every Photoshop blend mode to an editor blend mode exactly', () => {
		for (const m of PSD_BLEND_MODES) {
			expect(psdBlendMode(m.replace(/-/g, ' ')).mode).toBe(m);
			expect(BLEND_MODES as readonly string[]).toContain(editorBlendMode(m));
		}
		expect(editorBlendMode('linear-dodge')).toBe('add');
		expect(psdBlendMode('subtraction').mode).toBe('subtract');
		expect(psdBlendMode('weird').note).toMatch(/Normal/);
	});

	it('decodes EXR with the sRGB transfer and Radiance HDR through zscale', () => {
		const rec = (codec: string, bitDepth = 8, pixelFormat = 'rgb24') => ({
			kind: 'image',
			probe: { streams: [{ type: 'video', codec, bitDepth, pixelFormat } as never] },
		});
		expect(decoderArgs(rec('exr'))).toEqual(['-apply_trc', 'iec61966_2_1']);
		expect(decoderArgs(rec('png'))).toEqual([]);
		expect(sourceFilters(rec('hdr'), null)[0]).toMatch(/^zscale=/);
		expect(sourceFilters(rec('png'), { deinterlace: 'upper' })).toEqual([
			'bwdif=mode=send_frame:parity=tff:deint=all',
		]);
		expect(isDeep(rec('tiff', 16, 'rgb48le'))).toBe(true);
		expect(isDeep(rec('png'))).toBe(false);
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

	it('makes display pictures of stills a browser cannot decode', async () => {
		const exr = await register(app, fixture('imports-still.exr'));
		const r = await post(`/api/media/${exr.mediaKey}/variants`, { kind: 'display', variant: '' });
		expect(r.statusCode, r.body).toBe(200);
		const services = app.jasper.services.imports as {
			variants: { ensureAndWait(r: unknown, kind: string, variant: string): Promise<string> };
		};
		const rec = coreServices(app).registry.get(exr.mediaKey)!;
		const path = await services.variants.ensureAndWait(rec, 'display', '');
		const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path], {
			encoding: 'utf8',
		});
		const s = JSON.parse(probe.stdout).streams[0];
		expect(s.codec_name).toBe('png');
		expect(s.pix_fmt).toMatch(/64|48/);
		const served = await get(`/media/${exr.mediaKey}/variant/display`);
		expect(served.statusCode).toBe(200);
		expect(served.headers['content-type']).toBe('image/png');
		expect((await get(`/media/${exr.mediaKey}/variant/display?v=bogus`)).statusCode).toBe(400);
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
			...['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x402010:size=1920x1080:duration=1'],
			...['-vf', "format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='128'", '-frames:v', '1', png],
		]);
		expect(mk.status).toBe(0);
		const reg = await register(app, png);
		const measure = async (interpretation: Record<string, unknown> | null) => {
			const d = new DocBuilder();
			const m = d.addMedia(reg);
			if (interpretation) d.tx([{ type: 'media.interpret', mediaIds: [m], interpretation }]);
			d.tx([{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { video: 'V1' } }]);
			const start = await post('/api/exports', {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: {
					sequenceId: d.seqId,
					range: { type: 'entire' },
					container: 'mp4',
					video: {
						codec: 'h264',
						width: 1920,
						height: 1080,
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
					'format=rgb24,crop=1:1:960:540',
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
