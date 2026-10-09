// Regressions of the adversarial security review (docs/security-review.md). One `it` per confirmed finding.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { quoteFilterPath } from '../src/color/extension.ts';
import { buildOcioBundle } from '../src/color/ocio-bundle.ts';
import { loadLottieFile } from '../src/imports/lottie.ts';
import { ModelStore } from '../src/processing/models.ts';
import { openerFor } from '../src/routes/gaps.ts';
import { SpeechModelStore } from '../src/speech/models.ts';
import { resolveBinaries } from '../src/tools/ffmpeg.ts';
import { filterPath, filterValue } from '../src/tools/filter-text.ts';
import { atomicCopyFile } from '../src/tools/fs.ts';
import { closeApps, H, makeApp, ROOT, register, tempAppdir } from './helpers.ts';

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

	it('filterValue escapes both levels', () => {
		expect(filterValue('C:/a.cube')).toBe("'C\\:/a.cube'");
		expect(filterValue("it's")).toBe("'it\\'\\''s'");
		expect(filterPath('C:\\a\\b.cube', 'win32')).toBe("'C\\:/a/b.cube'");
		expect(filterPath('/a\\b.cube', 'linux')).toBe("'/a\\\\b.cube'");
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
		// 1×1 PNG.
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
		// From <appdir>/projects up to the filesystem root, then down to the victim folder (a path parameter is at most
		// 100 characters, which bounds the depth, not the bug).
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
		await new Promise((res) => setTimeout(res, 300));
		expect(existsSync(join(app.appdir, 'escaped'))).toBe(false);
	});
});

describe('ENG-5: Edit Original never runs a program', () => {
	it('the Windows opener does not put the path on a command line', () => {
		const hostile = 'C:\\media\\a&calc.exe&.mp4';
		const o = openerFor('open', hostile, 'win32');
		expect(o.cmd).not.toMatch(/cmd(\.exe)?$/i);
		expect(o.args.join(' ')).not.toContain('calc');
		expect(o.env).toEqual({ JASPER_OPEN_PATH: hostile });
	});

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
				if (!reg) continue; // not registrable under that name: nothing to open
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
			// The polyglots really register as media (so the refusal above is what protects).
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

describe('DATA-6: project backups and versions are copied atomically', () => {
	it('atomicCopyFile leaves the destination complete or absent, and no temporary file', async () => {
		const dir = tempAppdir('jasper-copy-');
		const src = join(dir, 'project.jasper');
		writeFileSync(src, '{"format":"jasper-project"}');
		await atomicCopyFile(src, join(dir, 'versions', 'v1.jasper'));
		expect(readFileSync(join(dir, 'versions', 'v1.jasper'), 'utf8')).toBe('{"format":"jasper-project"}');
		expect(readdirSync(join(dir, 'versions'))).toEqual(['v1.jasper']);
		// A failing copy (the source vanished) leaves nothing under the final name.
		await expect(
			atomicCopyFile(join(dir, 'gone.jasper'), join(dir, 'versions', 'v2.jasper')),
		).rejects.toThrow();
		expect(readdirSync(join(dir, 'versions'))).toEqual(['v1.jasper']);
	});
});
