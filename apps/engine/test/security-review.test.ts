import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { quoteFilterPath } from '../src/color/extension.ts';
import { buildOcioBundle } from '../src/color/ocio-bundle.ts';
import { assertFrameSize } from '../src/export/planner.ts';
import { loadLottieFile } from '../src/imports/lottie.ts';
import { extractZip } from '../src/mg-bundles/zip.ts';
import { ModelStore } from '../src/processing/models.ts';
import { ProcessingSettingsStore } from '../src/processing/settings.ts';
import { SpeechModelStore } from '../src/speech/models.ts';
import { resolveBinaries } from '../src/tools/ffmpeg.ts';
import { closeApps, DocBuilder, H, makeApp, ROOT, register, tempAppdir } from './helpers.ts';

/** An HTTP server whose every response is an endless body (stops after 256 MiB); counts the bytes it wrote. */
async function endlessServer(): Promise<{ url: string; sent: () => number; close: () => Promise<void> }> {
	let sent = 0;
	const chunk = Buffer.alloc(64 * 1024, 7);
	const server: Server = createHttpServer((_req, res) => {
		res.writeHead(200, { 'content-type': 'application/octet-stream' });
		const pump = () => {
			while (sent < 256 * 1024 * 1024) {
				sent += chunk.length;
				if (!res.write(chunk)) return void res.once('drain', pump);
			}
			res.end();
		};
		res.on('close', () => res.removeAllListeners('drain'));
		pump();
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/model.onnx`,
		sent: () => sent,
		close: () =>
			new Promise<void>((r) => {
				server.closeAllConnections();
				server.close(() => r());
			}),
	};
}

afterEach(async () => {
	await closeApps();
});

describe('ENG-1: served user content never runs script with the engine origin', () => {
	it('an imported SVG is served sandboxed and nosniff', async () => {
		const app = await makeApp();
		const dir = tempAppdir('jasper-svg-');
		const svg = join(dir, 'evil.svg');
		writeFileSync(
			svg,
			'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>fetch("/api/projects")</script><rect width="10" height="10"/></svg>',
		);
		const reg = await register(app, svg);
		const r = await app.inject({ method: 'GET', url: `/media/${reg.mediaKey}`, headers: H });
		expect(r.statusCode).toBe(200);
		expect(r.headers['content-type']).toMatch(/svg/);
		expect(r.headers['x-content-type-options']).toBe('nosniff');
		expect(String(r.headers['content-security-policy'])).toMatch(/(^|;\s*)sandbox(;|$)/);
	});
});

describe('ENG-2: model downloads stop at the catalogue size', () => {
	it('processing models', async () => {
		const srv = await endlessServer();
		try {
			const dir = tempAppdir('jasper-models-');
			const store = new ModelStore({
				modelsDir: dir,
				bundledDir: dir,
				entries: [
					{
						id: 'm',
						name: 'M',
						architecture: 'x',
						scale: 2,
						file: 'm.onnx',
						license: 'MIT',
						attribution: null,
						sourceUrl: srv.url,
						downloadUrl: srv.url,
						sha256: '0'.repeat(64),
						sizeBytes: 100_000,
					},
				],
			});
			await expect(store.install('m')).rejects.toMatchObject({ code: 'MODEL_CHECKSUM' });
			expect(srv.sent()).toBeLessThan(32 * 1024 * 1024);
			expect(existsSync(join(dir, 'm.onnx'))).toBe(false);
			expect(existsSync(join(dir, 'm.onnx.partial'))).toBe(false);
		} finally {
			await srv.close();
		}
	});

	it('speech (and roto) models', async () => {
		const srv = await endlessServer();
		try {
			const dir = tempAppdir('jasper-speech-models-');
			const store = new SpeechModelStore(dir, [
				{
					id: 's',
					name: 'S',
					parameters: 1,
					multilingual: false,
					description: '',
					license: 'MIT',
					licenseUrl: '',
					attribution: '',
					sourceUrl: srv.url,
					upstreamUrl: srv.url,
					revision: 'r',
					files: [{ path: 'model.onnx', url: srv.url, sha256: '0'.repeat(64), sizeBytes: 100_000 }],
				},
			]);
			await expect(store.install('s')).rejects.toMatchObject({ code: 'SPEECH_MODEL_CHECKSUM' });
			expect(srv.sent()).toBeLessThan(32 * 1024 * 1024);
			expect(existsSync(join(dir, 's', 'model.onnx'))).toBe(false);
		} finally {
			await srv.close();
		}
	});
});

describe('ENG-3: file paths and text in filter text survive both FFmpeg parsing levels', () => {
	const { ffmpeg } = resolveBinaries({
		vendorDir: join(ROOT, 'vendor', 'ffmpeg-lgpl', `${process.platform}-${process.arch}`),
	});
	// An identity-ish 2³ LUT that turns red into blue: proves the LUT was really loaded.
	const LUT = 'LUT_3D_SIZE 2\n0 0 0\n0 0 1\n0 1 0\n0 1 1\n1 0 0\n1 0 1\n1 1 0\n1 1 1\n';
	const names = [
		'plain.cube',
		'drive:colon.cube',
		"it's.cube",
		'comma,semi;bracket[x].cube',
		'back\\slash.cube',
		'x:interp=nearest.cube',
		"x',hflip,'.cube",
		'spaces and = equals.cube',
	];
	it.skipIf(!ffmpeg).each(names)('lut3d loads %s', (name) => {
		const dir = join(tempAppdir('jasper-filterpath-'), 'a:b');
		mkdirSync(dir, { recursive: true });
		const file = join(dir, name);
		writeFileSync(file, LUT);
		const r = spawnSync(
			ffmpeg!,
			[
				'-hide_banner',
				'-loglevel',
				'error',
				'-f',
				'lavfi',
				'-i',
				'color=c=red:s=4x4',
				'-filter_complex',
				`[0:v]format=rgb24,lut3d=file=${quoteFilterPath(file)}:interp=tetrahedral[o]`,
				'-map',
				'[o]',
				'-frames:v',
				'1',
				'-f',
				'rawvideo',
				'-pix_fmt',
				'rgb24',
				'-',
			],
			{ encoding: 'buffer' },
		);
		expect(r.stderr.toString()).toBe('');
		expect(r.status).toBe(0);
		const [red, green, blue] = [...r.stdout.subarray(0, 3)];
		expect(red).toBeLessThan(8);
		expect(green).toBeLessThan(8);
		expect(blue).toBeGreaterThan(245);
	});
});

describe('DATA-4: an OCIO config only bundles the LUT and CDL files it names', () => {
	it('never copies other files (absolute paths, ../, non-LUT content) into the bundle', async () => {
		const root = tempAppdir('jasper-ocio-');
		const cfgDir = join(root, 'pack');
		mkdirSync(join(cfgDir, 'luts'), { recursive: true });
		writeFileSync(
			join(cfgDir, 'luts', 'good.cube'),
			'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n',
		);
		const secret = join(root, 'id_rsa');
		writeFileSync(secret, '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n');
		writeFileSync(join(root, 'notes.cube'), 'not a lut, but my private notes');
		const config = join(cfgDir, 'evil.ocio');
		writeFileSync(
			config,
			[
				'ocio_profile_version: 2',
				'search_path: "luts:.."',
				'roles:',
				'  scene_linear: lin',
				'displays:',
				'  sRGB:',
				'    - !<View> {name: Raw, colorspace: lin}',
				'colorspaces:',
				'  - !<ColorSpace>',
				'    name: lin',
				'  - !<ColorSpace>',
				'    name: good',
				'    to_reference: !<FileTransform> {src: good.cube}',
				'  - !<ColorSpace>',
				'    name: key',
				`    to_reference: !<FileTransform> {src: ${secret}}`,
				'  - !<ColorSpace>',
				'    name: notes',
				'    to_reference: !<FileTransform> {src: notes.cube}',
				'',
			].join('\n'),
		);
		const b = await buildOcioBundle(config);
		expect(Object.keys(b.files)).toEqual(['good.cube']);
		expect(b.missing).toEqual([secret, 'notes.cube'].sort());
		expect(JSON.stringify(b)).not.toContain('PRIVATE KEY');
		expect(JSON.stringify(b)).not.toContain('private notes');
	});
});

describe('DATA-5: a Lottie file embeds only picture files next to it', () => {
	it('a non-image "image" asset is left empty (with a warning), a real PNG is embedded', async () => {
		const dir = tempAppdir('jasper-lottie-');
		mkdirSync(join(dir, 'images'));
		const png = Buffer.from(
			'89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201ffa5e1a2a30000000049454e44ae426082',
			'hex',
		);
		writeFileSync(join(dir, 'images', 'img_0.png'), png);
		writeFileSync(join(dir, 'taxes.pdf'), '%PDF-1.4 my tax return');
		const anim = {
			v: '5.7.0',
			fr: 30,
			ip: 0,
			op: 30,
			w: 10,
			h: 10,
			layers: [],
			assets: [
				{ id: 'a', w: 1, h: 1, u: 'images/', p: 'img_0.png', e: 0 },
				{ id: 'b', w: 1, h: 1, u: 'images/../', p: 'taxes.pdf', e: 0 },
			],
		};
		const file = join(dir, 'anim.json');
		writeFileSync(file, JSON.stringify(anim));
		const { doc, info } = await loadLottieFile(file);
		const assets = doc.assets as { p: string }[];
		expect(assets[0]!.p.startsWith('data:image/png;base64,')).toBe(true);
		expect(assets[1]!.p).not.toContain('base64');
		expect(JSON.stringify(doc)).not.toContain(Buffer.from('%PDF-1.4 my tax').toString('base64').slice(0, 12));
		expect((info.warnings ?? []).join(' ')).toContain('taxes.pdf');
	});
});

describe('ENG-4: project ids in paths are validated', () => {
	it('recovery routes cannot leave the project folder (no rm -rf of <elsewhere>/recovery/<name>)', async () => {
		const app = await makeApp();
		const outside = tempAppdir('jasper-victim-');
		const victim = join(outside, 'recovery', 'victim');
		mkdirSync(victim, { recursive: true });
		writeFileSync(join(victim, 'thesis.txt'), 'months of work');
		writeFileSync(join(victim, 'snapshot.jasper'), '{"secret":true}');
		writeFileSync(
			join(victim, 'session.json'),
			'{"sessionId":"victim","projectId":"x","savedAt":"2026-01-01T00:00:00.000Z","baseRevision":0}',
		);
		// Traverse from <appdir>/projects through the filesystem root to the victim folder.
		// The 100-character path-parameter limit bounds the victim path's depth.
		const up = join(app.appdir, 'projects').split('/').filter(Boolean).length;
		const id = `${'..%2F'.repeat(up)}${outside.replace(/^\/+/, '').replaceAll('/', '%2F')}`;
		expect(id.length).toBeLessThanOrEqual(100);
		const del = await app.inject({
			method: 'DELETE',
			url: `/api/projects/${id}/recovery/victim`,
			headers: H,
		});
		expect(del.statusCode).toBe(404);
		expect(existsSync(join(victim, 'thesis.txt'))).toBe(true);
		const get = await app.inject({ method: 'GET', url: `/api/projects/${id}/recovery/victim`, headers: H });
		expect(get.statusCode).toBe(404);
		expect(get.body).not.toContain('secret');
	});

	it('media jobs refuse a project id that is not one', async () => {
		const app = await makeApp();
		const dir = tempAppdir('jasper-mj-');
		const svg = join(dir, 'pic.svg');
		writeFileSync(
			svg,
			'<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>',
		);
		const reg = await register(app, svg);
		const r = await app.inject({
			method: 'POST',
			url: '/api/media-jobs',
			headers: { ...H, 'content-type': 'application/json' },
			payload: {
				projectId: '../../escaped',
				op: 'copy',
				destination: { mode: 'project' },
				items: [{ mediaKey: reg.mediaKey, mediaId: 'med_1' }],
			},
		});
		expect(r.statusCode).toBe(400);
		expect(r.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
		// Validation refuses the request before submitting any media job.
		expect(existsSync(join(app.appdir, 'escaped'))).toBe(false);
	});
});

describe('ENG-5: Edit Original never runs a program', () => {
	it('only media and document files are opened; programs, launchers and extensionless files are refused', async () => {
		const app = await makeApp();
		const dir = tempAppdir('jasper-open-');
		const svgText =
			'<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>';
		const prev = process.env.JASPER_OPEN_COMMAND;
		process.env.JASPER_OPEN_COMMAND = 'true';
		try {
			// A picture by content (a PNG; media are probed by content) under names the OS opener would run or launch.
			const png = Buffer.from(
				'89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201ffa5e1a2a30000000049454e44ae426082',
				'hex',
			);
			let refused = 0;
			for (const [i, name] of ['photo.hta', 'photo.pif', 'photo.scpt', 'photo.py', 'photo'].entries()) {
				const file = join(dir, name);
				writeFileSync(file, Buffer.concat([png, Buffer.alloc(i + 1, 0x20)]));
				const reg = await register(app, file).catch(() => null);
				if (!reg) continue;
				const r = await app.inject({
					method: 'POST',
					url: `/api/media/${reg.mediaKey}/open`,
					headers: { ...H, 'content-type': 'application/json' },
					payload: { action: 'open' },
				});
				expect(r.statusCode, name).toBe(400);
				expect(r.json().code).toBe('NOT_MEDIA');
				refused++;
				const reveal = await app.inject({
					method: 'POST',
					url: `/api/media/${reg.mediaKey}/open`,
					headers: { ...H, 'content-type': 'application/json' },
					payload: { action: 'reveal' },
				});
				expect(reveal.statusCode, name).toBe(200);
			}
			expect(refused).toBeGreaterThanOrEqual(3);
			const ok = join(dir, 'photo.svg');
			writeFileSync(ok, svgText);
			const reg = await register(app, ok);
			const r = await app.inject({
				method: 'POST',
				url: `/api/media/${reg.mediaKey}/open`,
				headers: { ...H, 'content-type': 'application/json' },
				payload: { action: 'open' },
			});
			expect(r.statusCode).toBe(200);
		} finally {
			if (prev === undefined) delete process.env.JASPER_OPEN_COMMAND;
			else process.env.JASPER_OPEN_COMMAND = prev;
		}
	});
});

describe('WS /agent goes through the same Host, Origin and token checks as HTTP', () => {
	const open = (app: Awaited<ReturnType<typeof makeApp>>, headers: Record<string, string>) =>
		app.injectWS('/agent', { headers }).then(
			(ws) => {
				ws.terminate();
				return 'open';
			},
			(e: Error) => `refused: ${e.message}`,
		);

	it('refuses a foreign Origin and a foreign Host (a web page cannot attach as an editor session)', async () => {
		const app = await makeApp();
		expect(await open(app, { ...H })).toBe('open');
		expect(await open(app, { ...H, origin: 'http://127.0.0.1:47900' })).toBe('open');
		expect(await open(app, { ...H, origin: 'https://evil.example' })).toMatch(/^refused/);
		expect(await open(app, { ...H, origin: 'null' })).toMatch(/^refused/);
		expect(await open(app, { host: 'evil.example:47900' })).toMatch(/^refused/);
	});

	it('needs the token in token mode', async () => {
		const app = await makeApp({ dev: false, token: 's3cret' });
		expect(await open(app, { ...H })).toMatch(/^refused/);
		expect(await open(app, { ...H, authorization: 'Bearer wrong' })).toMatch(/^refused/);
		expect(await open(app, { ...H, authorization: 'Bearer s3cret' })).toBe('open');
		expect(await open(app, { ...H, cookie: 'jasper_session=s3cret' })).toBe('open');
	});
});

describe('ENG-6: frame sizes no path can render are refused by name', () => {
	it('assertFrameSize', () => {
		expect(() => assertFrameSize('X', 16384, 16384)).not.toThrow();
		for (const bad of [16385, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '100'])
			expect(() => assertFrameSize('X', bad, 100)).toThrow(/at most 16384/);
	});

	const video = {
		codec: 'h264',
		width: 1920,
		height: 1080,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 23 },
		encoderSpeed: 'fast',
	};
	const plan = (app: Awaited<ReturnType<typeof makeApp>>, d: DocBuilder, size: Partial<typeof video> = {}) =>
		app.inject({
			method: 'POST',
			url: '/api/exports/plan',
			headers: { ...H, 'content-type': 'application/json' },
			payload: {
				envelope: d.envelope(),
				sequenceId: d.seqId,
				settings: {
					sequenceId: d.seqId,
					range: { type: 'entire' },
					container: 'mp4',
					video: { ...video, ...size },
					audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
					engine: 'auto',
				},
			},
		});

	it('a gigantic export size is refused; a gigantic sequence in a hostile document is clamped on load', async () => {
		const app = await makeApp();
		const d = new DocBuilder();
		d.tx([{ type: 'clip.addSolid', at: 0, duration: 10, track: 'V1', color: [1, 0, 0, 1] }]);
		expect((await plan(app, d)).statusCode).toBe(200);
		// What no command produces: a document edited by hand (or sent as the envelope of an export request).
		// `repairDocument` clamps it to 8192 px on load (and says so), so it plans like any other.
		const hostile = new DocBuilder();
		hostile.tx([{ type: 'clip.addSolid', at: 0, duration: 10, track: 'V1', color: [1, 0, 0, 1] }]);
		const doc = JSON.parse(JSON.stringify(hostile.doc));
		doc.sequences[hostile.seqId].settings.width = 2_000_000;
		doc.sequences[hostile.seqId].settings.height = 2_000_000;
		hostile.doc = doc;
		expect((await plan(app, hostile)).statusCode).toBe(200);
		const big = await plan(app, d, { width: 500_000, height: 500_000 });
		expect(big.statusCode).toBe(400);
		expect(big.json().message).toMatch(/The export has a frame size/);
	});
});

/** A one-entry deflated zip whose headers declare `declared` uncompressed bytes for `data`. */
function zipOf(name: string, data: Buffer, declared = data.length): Buffer {
	const comp = deflateRawSync(data);
	const n = Buffer.from(name);
	const loc = Buffer.alloc(30);
	loc.writeUInt32LE(0x04034b50, 0);
	loc.writeUInt16LE(20, 4);
	loc.writeUInt16LE(8, 8);
	loc.writeUInt32LE(comp.length, 18);
	loc.writeUInt32LE(declared, 22);
	loc.writeUInt16LE(n.length, 26);
	const cen = Buffer.alloc(46);
	cen.writeUInt32LE(0x02014b50, 0);
	cen.writeUInt16LE(20, 4);
	cen.writeUInt16LE(20, 6);
	cen.writeUInt16LE(8, 10);
	cen.writeUInt32LE(comp.length, 20);
	cen.writeUInt32LE(declared, 24);
	cen.writeUInt16LE(n.length, 28);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(46 + n.length, 12);
	end.writeUInt32LE(30 + n.length + comp.length, 16);
	return Buffer.concat([loc, n, comp, cen, n, end]);
}

describe('ZIP-1: bundle zip entries are streamed and cut at their declared size', () => {
	it('extracts a deflated entry and refuses one whose data outgrows its declared size', async () => {
		const dir = tempAppdir('jasper-zip-');
		const good = join(dir, 'good.zip');
		writeFileSync(good, zipOf('index.html', Buffer.from('<html>ok</html>')));
		expect(await extractZip(good, join(dir, 'out'))).toBe(1);
		expect(readFileSync(join(dir, 'out', 'index.html'), 'utf8')).toBe('<html>ok</html>');
		// 8 MiB of zeros declared as 1 KiB.
		const bomb = join(dir, 'bomb.zip');
		writeFileSync(bomb, zipOf('big.bin', Buffer.alloc(8 * 1024 * 1024), 1024));
		await expect(extractZip(bomb, join(dir, 'out2'))).rejects.toThrow(/Size mismatch|Corrupt/);
		expect(existsSync(join(dir, 'out2', 'big.bin'))).toBe(false);
	});

	it('a large entry is not held in memory (128 MiB entry, peak buffers under 64 MiB)', async () => {
		const dir = tempAppdir('jasper-zip-');
		const big = join(dir, 'big.zip');
		const size = 128 * 1024 * 1024;
		writeFileSync(big, zipOf('big.bin', Buffer.alloc(size)));
		global.gc?.();
		const base = process.memoryUsage().arrayBuffers;
		let peak = 0;
		const timer = setInterval(() => {
			peak = Math.max(peak, process.memoryUsage().arrayBuffers - base);
		}, 2);
		try {
			expect(await extractZip(big, join(dir, 'out'))).toBe(1);
		} finally {
			clearInterval(timer);
		}
		expect(statSync(join(dir, 'out', 'big.bin')).size).toBe(size);
		rmSync(dir, { recursive: true, force: true });
		expect(peak).toBeLessThan(64 * 1024 * 1024);
	}, 120_000);
});

describe('SSH-1: remote executor settings', () => {
	it('refuses a user name that ssh would read as an option', async () => {
		const store = new ProcessingSettingsStore(join(tempAppdir('jasper-ssh-'), 'engine.json'));
		const remote = {
			enabled: true,
			host: 'render.example',
			port: 22,
			user: '-oProxyCommand',
			identityFile: null,
			remoteDir: '/srv/jasper',
			useFor: [],
			strictHostKeyChecking: 'accept-new' as const,
		};
		await expect(store.put({ remote })).rejects.toMatchObject({ code: 'INVALID_SETTINGS' });
		await expect(store.put({ remote: { ...remote, user: 'render' } })).resolves.toMatchObject({
			remote: { user: 'render' },
		});
	});
});
