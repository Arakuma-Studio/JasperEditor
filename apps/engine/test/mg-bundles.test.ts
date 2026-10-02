// Remotion bundles as clips (M2, S08 §3/§5/§8): zip reader, content hash, version pin, props schemas,
// host page, render keys, the mg native extension, routes, uploads and GC — and, with MG_E2E=1, the real
// thing on the fixture project: import (schema module + inference), zip import, ProRes 4444 masters with
// straight alpha, native exports with cached masters (S08 §8 tests 2, 5, 6) and rebuild-on-change.
import { spawnSync } from 'node:child_process';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import type { EngineJob, MgPrerenderRequest, RegisteredMedia } from '@jasper/api';
import { injectHostBootstrap, MG_HOST_QUERY } from '@jasper/compositions/mg-host';
import {
	buildRenderSnapshot,
	type CompositionClip,
	compositionTextLayers,
	EMPTY_PROBE,
	MG_REMOTION_VERSION,
	type MgBundleInfo,
	type MgTextMeasurement,
	measuredTextIssues,
	mergeProps,
	overridesWithEdits,
	type RenderSnapshot,
	textLayerValue,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildNativeGraph } from '../src/export/native.ts';
import type { NativeExtension } from '../src/export/native-ext.ts';
import { nativeBlockers } from '../src/export/planner.ts';
import { hashBundleDir } from '../src/mg-bundles/hash.ts';
import { masterRequests, mgNativeExtension } from '../src/mg-bundles/native-ext.ts';
import {
	bundleVersions,
	checkRemotionVersion,
	MgBundleError,
	readProjectPackage,
} from '../src/mg-bundles/project.ts';
import { scaffoldProject } from '../src/mg-bundles/scaffold.ts';
import { buildCompositionInfos, loadSchemaModule } from '../src/mg-bundles/schemas.ts';
import { bundleMediaKey, type MgBundleService, prerenderKey } from '../src/mg-bundles/service.ts';
import { extractZip, safeEntryPath, ZipError } from '../src/mg-bundles/zip.ts';
import { mgBundleService } from '../src/routes/mg-bundles.ts';
import { coreServices } from '../src/tools/services.ts';
import {
	closeApps,
	DocBuilder,
	ensureFixtures,
	fixture,
	H,
	JSON_H,
	makeApp,
	ROOT,
	tempAppdir,
	until,
} from './helpers.ts';

const FIXTURE_PROJECT = join(ROOT, 'fixtures', 'mg-project');
const E2E = process.env.MG_E2E === '1';

// ---------------------------------------------------------------- helpers

/** A minimal zip writer (stored or deflated entries) for the reader tests. */
function makeZip(entries: { name: string; data: Buffer | string; deflate?: boolean }[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const e of entries) {
		const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
		const body = e.deflate ? deflateRawSync(raw) : raw;
		const name = Buffer.from(e.name);
		const crc = crc32(raw) >>> 0;
		const lh = Buffer.alloc(30);
		lh.writeUInt32LE(0x04034b50, 0);
		lh.writeUInt16LE(20, 4);
		lh.writeUInt16LE(0x800, 6);
		lh.writeUInt16LE(e.deflate ? 8 : 0, 8);
		lh.writeUInt32LE(crc, 14);
		lh.writeUInt32LE(body.length, 18);
		lh.writeUInt32LE(raw.length, 22);
		lh.writeUInt16LE(name.length, 26);
		locals.push(lh, name, body);
		const ch = Buffer.alloc(46);
		ch.writeUInt32LE(0x02014b50, 0);
		ch.writeUInt16LE(20, 4);
		ch.writeUInt16LE(20, 6);
		ch.writeUInt16LE(0x800, 8);
		ch.writeUInt16LE(e.deflate ? 8 : 0, 10);
		ch.writeUInt32LE(crc, 16);
		ch.writeUInt32LE(body.length, 20);
		ch.writeUInt32LE(raw.length, 24);
		ch.writeUInt16LE(name.length, 28);
		ch.writeUInt32LE(offset, 42);
		centrals.push(ch, name);
		offset += 30 + name.length + body.length;
	}
	const cd = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(cd.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, cd, end]);
}

/** Every file of a directory as zip entries (deflated). */
function zipDir(dir: string, prefix = ''): Buffer {
	const out: { name: string; data: Buffer; deflate: boolean }[] = [];
	const walk = (d: string, rel: string) => {
		for (const n of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, n.name);
			const r = rel ? `${rel}/${n.name}` : n.name;
			if (n.isDirectory()) walk(p, r);
			else out.push({ name: `${prefix}${r}`, data: readFileSync(p), deflate: true });
		}
	};
	walk(dir, '');
	return makeZip(out);
}

/** A fake built bundle (enough for serving and version checks, not for rendering). */
function fakeBundle(dir: string, version = MG_REMOTION_VERSION): string {
	mkdirSync(join(dir, 'public'), { recursive: true });
	writeFileSync(
		join(dir, 'index.html'),
		`<!DOCTYPE html><html><head><title>x</title></head><body><script>window.siteVersion = '11'; window.remotion_version = '${version}';</script><script src="./bundle.js"></script></body></html>`,
	);
	writeFileSync(join(dir, 'bundle.js'), '/* fake */');
	writeFileSync(join(dir, 'public', 'a.txt'), 'static');
	return dir;
}

function fakeInfo(hash: string): MgBundleInfo {
	return {
		remotionVersion: MG_REMOTION_VERSION,
		bundleHash: hash,
		builtAt: '2026-10-01T00:00:00.000Z',
		source: { type: 'bundle-upload', path: null, name: 'fake' },
		compositions: [
			{
				id: 'Title',
				width: 1920,
				height: 1080,
				fps: 25,
				durationInFrames: 75,
				defaultProps: { title: 'Hi' },
				propsSchema: { type: 'object', properties: { title: { type: 'string' } } },
				schemaSource: 'inferred',
			},
		],
	};
}

/** Registers a fake bundle directory in an app's registry (no browser needed). */
async function registerFake(svc: MgBundleService, dir: string): Promise<RegisteredMedia> {
	const { hash } = await hashBundleDir(dir);
	const final = join(svc.bundlesDir, hash);
	cpSync(dir, final, { recursive: true });
	return (
		svc as unknown as { registerBundle(d: string, i: MgBundleInfo): Promise<RegisteredMedia> }
	).registerBundle(final, fakeInfo(hash));
}

function docWithComposition(reg: RegisteredMedia, extra: unknown[] = [], preset = 'hd-1080p-30') {
	const d = new DocBuilder(preset);
	const mediaId = d.addMedia(reg);
	const r = d.tx([
		{ type: 'clip.addComposition', composition: { mediaId, id: 'Title' }, at: 10, track: 'V2' },
		...extra,
	]);
	const clipId = (r.results[0] as { clipId: string }).clipId;
	return { d, mediaId, clipId };
}

afterAll(async () => {
	await closeApps();
});

// ---------------------------------------------------------------- unit

describe('zip reader (bundle uploads)', () => {
	it('extracts stored and deflated entries and refuses unsafe paths', async () => {
		const dir = tempAppdir('jasper-zip-');
		const zip = join(dir, 'b.zip');
		writeFileSync(
			zip,
			makeZip([
				{ name: 'bundle/index.html', data: '<html></html>' },
				{ name: 'bundle/js/bundle.js', data: 'x'.repeat(5000), deflate: true },
				{ name: '__MACOSX/._x', data: 'junk' },
			]),
		);
		const out = join(dir, 'out');
		mkdirSync(out);
		expect(await extractZip(zip, out)).toBe(2);
		expect(readFileSync(join(out, 'bundle/js/bundle.js'), 'utf8')).toBe('x'.repeat(5000));
		expect(existsSync(join(out, '__MACOSX'))).toBe(false);
		writeFileSync(zip, makeZip([{ name: '../evil.txt', data: 'no' }]));
		await expect(extractZip(zip, join(dir, 'out2'))).rejects.toBeInstanceOf(ZipError);
		expect(safeEntryPath('/a/b', '/etc/passwd')).toBeNull();
		writeFileSync(zip, 'not a zip');
		await expect(extractZip(zip, join(dir, 'out3'))).rejects.toThrow(/Not a zip/);
	});
});

describe('bundle identity and versions (S08:MGC-001/010)', () => {
	it('hashes paths and bytes deterministically', async () => {
		const a = fakeBundle(tempAppdir('jasper-b1-'));
		const b = fakeBundle(tempAppdir('jasper-b2-'));
		const ha = await hashBundleDir(a);
		expect((await hashBundleDir(b)).hash).toBe(ha.hash);
		expect(ha.hash).toMatch(/^[0-9a-f]{64}$/);
		writeFileSync(join(b, 'public', 'a.txt'), 'changed');
		expect((await hashBundleDir(b)).hash).not.toBe(ha.hash);
		expect(bundleMediaKey(ha.hash)).toBe(`mk_${ha.hash.slice(0, 24)}`);
		expect(await bundleVersions(a)).toEqual({ remotion: MG_REMOTION_VERSION, site: '11' });
	});

	it('refuses projects that do not pin remotion 4.0.499 (MG_REMOTION_VERSION with a hint)', async () => {
		const dir = tempAppdir('jasper-proj-');
		const pkg = (deps: Record<string, string>) =>
			writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', dependencies: deps }));
		pkg({ remotion: '4.0.498', '@remotion/cli': '4.0.498' });
		const err = await checkRemotionVersion(dir, await readProjectPackage(dir)).catch((e) => e);
		expect(err).toBeInstanceOf(MgBundleError);
		expect(err.code).toBe('MG_REMOTION_VERSION');
		expect(err.hint).toMatch(/needs 4\.0\.499 — pin/);
		expect(err.detail).toMatchObject({ found: '4.0.498', required: '4.0.499' });
		pkg({ remotion: '^4.0.499' });
		expect((await checkRemotionVersion(dir, await readProjectPackage(dir)).catch((e) => e)).code).toBe(
			'MG_REMOTION_VERSION',
		);
		pkg({ remotion: '4.0.499' });
		expect((await checkRemotionVersion(dir, await readProjectPackage(dir)).catch((e) => e)).code).toBe(
			'MG_NOT_INSTALLED',
		);
		pkg({ react: '19.0.0' });
		expect((await checkRemotionVersion(dir, await readProjectPackage(dir)).catch((e) => e)).code).toBe(
			'MG_NOT_A_BUNDLE',
		);
		// The fixture project is pinned and installed.
		await expect(
			checkRemotionVersion(FIXTURE_PROJECT, await readProjectPackage(FIXTURE_PROJECT)),
		).resolves.toBeUndefined();
	});
});

describe('new composition project (S08:MGC-015)', () => {
	it('writes the template pinned to 4.0.499 with a schema module and manifest; refuses non-empty dirs', async () => {
		const parent = tempAppdir('jasper-scaffold-');
		const dir = await scaffoldProject(parent, 'my-graphics', { install: false });
		expect(dir).toBe(join(parent, 'my-graphics'));
		const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
		expect(pkg.name).toBe('my-graphics');
		expect(pkg.dependencies).toMatchObject({
			remotion: MG_REMOTION_VERSION,
			'@remotion/cli': MG_REMOTION_VERSION,
		});
		expect(pkg.jasper.schemas).toBe('./src/jasper-schemas.ts');
		for (const f of [
			'src/index.ts',
			'src/Root.tsx',
			'src/jasper-schemas.ts',
			'jasper.mg.json',
			'remotion.config.ts',
		])
			expect(existsSync(join(dir, f)), f).toBe(true);
		expect(() => JSON.parse(readFileSync(join(dir, 'jasper.mg.json'), 'utf8'))).not.toThrow();
		// Pinned correctly: the only complaint left is the missing install.
		expect((await checkRemotionVersion(dir, await readProjectPackage(dir)).catch((e) => e)).code).toBe(
			'MG_NOT_INSTALLED',
		);
		const again = await scaffoldProject(parent, 'my-graphics', { install: false }).catch((e) => e);
		expect(again).toBeInstanceOf(MgBundleError);
		expect(again.status).toBe(409);
		expect((await scaffoldProject('relative/dir', 'x', { install: false }).catch((e) => e)).code).toBe(
			'BAD_REQUEST',
		);
	});
});

describe('props schemas (S08:MGC-011)', () => {
	it('converts the fixture schema module (zod 4) in a child process', async () => {
		const r = await loadSchemaModule(FIXTURE_PROJECT, './src/jasper-schemas.ts', {
			scratchDir: tempAppdir('jasper-sch-'),
		});
		expect(r.warnings).toEqual([]);
		expect(r.schemas.Title).toMatchObject({
			type: 'object',
			properties: {
				title: { type: 'string', minLength: 1, maxLength: 80 },
				accent: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
				delay: { type: 'integer', minimum: 0, maximum: 60 },
			},
			required: ['title', 'accent', 'delay'],
		});
		expect(r.schemas.Badge).toBeUndefined();
	});

	it('converts zod 3 schemas with zod-to-json-schema and reports broken modules as warnings', async () => {
		const dir = tempAppdir('jasper-z3-');
		writeFileSync(join(dir, 'package.json'), '{"name":"z3"}');
		mkdirSync(join(dir, 'node_modules'));
		symlinkSync(join(FIXTURE_PROJECT, 'node_modules', 'zod'), join(dir, 'node_modules', 'zod'));
		writeFileSync(
			join(dir, 's.ts'),
			"import { z } from 'zod/v3';\nexport const schemas = { Card: z.object({ name: z.string().max(10), n: z.number().int() }) };\n",
		);
		const r = await loadSchemaModule(dir, './s.ts', { scratchDir: join(dir, '.scratch') });
		expect(r.warnings).toEqual([]);
		expect(r.schemas.Card).toMatchObject({
			type: 'object',
			properties: { name: { type: 'string', maxLength: 10 }, n: { type: 'integer' } },
		});
		writeFileSync(join(dir, 'bad.ts'), "throw new Error('boom');\nexport default {};\n");
		const bad = await loadSchemaModule(dir, './bad.ts', { scratchDir: join(dir, '.scratch') });
		expect(bad.schemas).toEqual({});
		expect(bad.warnings[0]).toMatch(/boom/);
		const missing = await loadSchemaModule(dir, './nope.ts', { scratchDir: join(dir, '.scratch') });
		expect(missing.warnings[0]).toMatch(/not found/);
	});

	it('takes the manifest first, then the schema module, then inference; merges UI hints', () => {
		const raw = [
			{ id: 'A', width: 10, height: 10, fps: 30, durationInFrames: 30, defaultProps: { c: '#fff', n: 1 } },
			{ id: 'B', width: 10, height: 10, fps: 30, durationInFrames: 30, defaultProps: { t: 'x' } },
			{ id: 'C', width: 10, height: 10, fps: 30, durationInFrames: 30, defaultProps: { when: new Date(0) } },
		];
		const infos = buildCompositionInfos(raw, {
			manifest: {
				compositions: {
					A: { propsSchema: { type: 'object', properties: { n: { type: 'number' } } }, category: 'Cat' },
					B: { ui: { t: { control: 'textarea' } }, thumbnailFrame: 5 },
				},
			},
			moduleSchemas: { A: { type: 'object' }, B: { type: 'object', properties: { t: { type: 'string' } } } },
		});
		expect(infos.map((i) => i.schemaSource)).toEqual(['manifest', 'bundle', 'inferred']);
		expect(infos[0]!.category).toBe('Cat');
		expect(infos[1]!.ui).toEqual({ t: { control: 'textarea' } });
		expect(infos[1]!.thumbnailFrame).toBe(5);
		expect(infos[2]!.defaultProps).toEqual({ when: '1970-01-01T00:00:00.000Z' });
		// "*" applies to every composition without its own entry.
		const wild = buildCompositionInfos(raw.slice(1, 2), {
			manifest: {
				compositions: {
					'*': {
						propsSchema: { type: 'object', properties: { bg: { type: 'string' } } },
						ui: { bg: { control: 'color' } },
						category: 'Shots',
					},
				},
			},
			moduleSchemas: {},
		});
		expect(wild[0]).toMatchObject({
			schemaSource: 'manifest',
			category: 'Shots',
			ui: { bg: { control: 'color' } },
		});
		// wp-m3-mgtext (S08:MGC-036): `texts` declarations merge entry by entry ("*" + the id's own).
		const texts = buildCompositionInfos(raw.slice(1, 2), {
			manifest: {
				compositions: {
					'*': { texts: { t: { label: 'Headline', maxChars: 30 }, other: false } },
					B: { texts: { t: { label: 'Copy', maxLines: 2 } } },
				},
			},
			moduleSchemas: {},
		});
		expect(texts[0]!.texts).toEqual({ t: { label: 'Copy', maxLines: 2 }, other: false });
	});
});

describe('live host page and render keys (S08:MGC-021/031)', () => {
	it('injects the protocol bootstrap before the bundle scripts', () => {
		const html = injectHostBootstrap(
			'<html><head><title>x</title></head><body><script src="b.js"></script></body></html>',
		);
		const boot = html.indexOf('remotion_puppeteerTimeout');
		expect(boot).toBeGreaterThan(html.indexOf('<head>'));
		expect(boot).toBeLessThan(html.indexOf('b.js'));
		expect(html).toContain("process.env.NODE_ENV='production'");
		expect(html).toContain('background:transparent');
	});

	it('changes with props, bundle, size, fps and range — never with key order', () => {
		const req: MgPrerenderRequest = {
			mediaKey: 'mk_x',
			compositionId: 'Title',
			props: { a: 1, b: 2 },
			width: 1920,
			height: 1080,
			fps: { num: 30, den: 1 },
			startFrame: 0,
			durationFrames: 90,
			quality: 'master',
		};
		const k = prerenderKey(req, 'h1');
		expect(k).toMatch(/^[0-9a-f]{40}$/);
		expect(prerenderKey({ ...req, props: { b: 2, a: 1 } }, 'h1')).toBe(k);
		expect(prerenderKey({ ...req, quality: 'preview' } as MgPrerenderRequest, 'h1')).toBe(k);
		for (const other of [
			prerenderKey(req, 'h2'),
			prerenderKey({ ...req, props: { a: 2, b: 2 } }, 'h1'),
			prerenderKey({ ...req, width: 1280 }, 'h1'),
			prerenderKey({ ...req, fps: { num: 25, den: 1 } }, 'h1'),
			prerenderKey({ ...req, startFrame: 1 }, 'h1'),
		])
			expect(other).not.toBe(k);
	});
});

describe('mg native extension (S08:MGC-032…034)', () => {
	const reg: RegisteredMedia = {
		mediaKey: bundleMediaKey('a'.repeat(64)),
		fingerprint: `q1:${'a'.repeat(64)}`,
		originalName: 'fake',
		sizeBytes: 10,
		container: 'remotion-bundle',
		kind: 'mg-bundle',
		probe: EMPTY_PROBE,
		locators: [{ type: 'engine-store', engineId: 'local', key: bundleMediaKey('a'.repeat(64)) }],
		browserPlayable: 'no',
		mgBundle: fakeInfo('a'.repeat(64)),
	};
	const fakeSvc = (status: 'ready' | 'unavailable', known = true) =>
		({
			capability: () => ({
				status,
				...(status === 'unavailable' ? { reason: 'no browser' } : {}),
				projectImport: true,
			}),
			record: () => (known ? ({} as never) : null),
			renderKeyOf: () => 'f'.repeat(40),
			masterPath: () => null,
		}) as unknown as MgBundleService;
	const snapOf = (d: DocBuilder): RenderSnapshot =>
		buildRenderSnapshot(d.doc, d.seqId, { resolveMedia: () => null, resolveFont: () => null });
	const caps = { native: true, remotionLocal: 'ready', fframes: 'unavailable', mgMasters: false } as const;

	it('makes composition clips native-capable, with blockers when the renderer or the bundle is missing', () => {
		const { d } = docWithComposition(reg);
		const clip = snapOf(d)
			.videoTracks.flatMap((t) => t.clips)
			.find((c) => c.kind === 'composition')!;
		expect(nativeBlockers(clip, caps, [])).toEqual([expect.stringMatching(/requires graphics rendering/)]);
		expect(nativeBlockers(clip, caps, [mgNativeExtension(fakeSvc('ready'))])).toEqual([]);
		expect(nativeBlockers(clip, caps, [mgNativeExtension(fakeSvc('unavailable'))])).toEqual([
			expect.stringMatching(/need the Remotion renderer to pre-render/),
		]);
		expect(nativeBlockers(clip, caps, [mgNativeExtension(fakeSvc('ready', false))])[0]).toMatch(
			/bundle is not available/,
		);
		// A 25 fps composition in a 30 fps sequence renders at the sequence rate, with a plan warning.
		expect(mgNativeExtension(fakeSvc('ready')).warnings!(clip, { fps: { num: 30, den: 1 } })[0]!.code).toBe(
			'MG_FPS_MISMATCH',
		);
	});

	it('requests masters for the drawn span (handles included) and overrides the layer source', () => {
		const { d, clipId } = docWithComposition(reg, [
			{ type: 'clip.addSolid', at: 0, duration: 40, track: 'V2', color: [1, 0, 0, 1] },
		]);
		// Composition at 10…100 (75 frames at 25 fps = 90 at 30 fps), overwritten 10…40 by the solid: 40…100.
		const snap = snapOf(d);
		const reqs = masterRequests(snap);
		expect(reqs).toHaveLength(1);
		expect(reqs[0]!.req).toMatchObject({
			compositionId: 'Title',
			props: { title: 'Hi' },
			width: 1920,
			height: 1080,
			fps: { num: 30, den: 1 },
			// The overwrite trimmed the head: content starts 30 frames in.
			startFrame: 30,
			durationFrames: 60,
			quality: 'master',
		});
		expect(reqs[0]!.layerStart).toBe(40);
		const ext = mgNativeExtension(fakeSvc('ready'));
		const prepared = new Map([
			[clipId, { path: '/m/master.mov', renderKey: 'k'.repeat(40), layerStart: 40 }],
		]);
		const clip = snap.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === clipId)!;
		expect(ext.override!(clip, prepared)).toEqual({ path: '/m/master.mov', space: 'layer', startFrame: 40 });
		const graph = buildNativeGraph({
			snapshot: snap,
			output: {
				width: 1920,
				height: 1080,
				fps: { num: 30, den: 1 },
				frames: 100,
				durationSec: 100 / 30,
				scaling: 'fit',
				crf: 18,
				x264Preset: 'veryfast',
				audioChannels: 2,
				audioBitrateKbps: 192,
			} as never,
			outputFile: '/tmp/x.mp4',
			sources: { media: () => null, mgMaster: () => null },
			threads: 2,
			extensions: { list: [ext as NativeExtension], prepared: new Map([['mg', prepared]]) },
		});
		expect(graph.inputs.some((i) => i.includes('/m/master.mov'))).toBe(true);
		for (const gpl of ['eq=', 'hqdn3d', 'perspective', 'boxblur', 'smartblur', 'delogo', 'frei0r'])
			expect(graph.filter).not.toContain(gpl);
		// Remotion path: the signed master URL goes into the snapshot.
		const adapted = ext.adaptRemotionDoc!(snap, prepared, { signUrl: (p) => `http://e${p}?sig=1` });
		const src = adapted.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === clipId)!.source as {
			composition: { prerender: unknown };
		};
		expect(src.composition.prerender).toEqual({
			masterUrl: `http://e/mg/${'k'.repeat(40)}/master.mov?sig=1`,
			previewUrl: null,
			startFrame: 40,
		});
		expect(snap).not.toBe(adapted);
	});
});

describe('ensureMasters: pre-renders of one export side by side (S11:LBK-022 page pool)', () => {
	it('renders distinct keys within the page budget, reuses cached ones, cancels the rest on abort', async () => {
		const app = await makeApp({ totalSlots: 12 });
		const svc = mgBundleService(app)!;
		const queue = coreServices(app).queue;
		let active = { renders: 0, pages: 0 };
		let peak = { renders: 0, pages: 0 };
		const rendered: { key: string; pages: number }[] = [];
		let delayMs = 200;
		// Stand-in pre-render: a child job whose runner "renders" for a while and writes the master.
		queue.registerRunner('mg-prerender', async (ctx) => {
			const { renderKey, concurrency } = ctx.input as { renderKey: string; concurrency: number };
			rendered.push({ key: renderKey, pages: concurrency });
			active = { renders: active.renders + 1, pages: active.pages + concurrency };
			peak = { renders: Math.max(peak.renders, active.renders), pages: Math.max(peak.pages, active.pages) };
			try {
				await new Promise<void>((res, rej) => {
					const t = setTimeout(res, delayMs);
					ctx.signal.addEventListener('abort', () => {
						clearTimeout(t);
						rej(new Error('cancelled'));
					});
				});
				mkdirSync(join(svc.mgDir, renderKey), { recursive: true });
				writeFileSync(join(svc.mgDir, renderKey, 'master.mov'), 'x');
				return null;
			} finally {
				active = { renders: active.renders - 1, pages: active.pages - concurrency };
			}
		});
		const keyOf = (r: MgPrerenderRequest) => r.compositionId.padStart(40, '0');
		svc.renderKeyOf = keyOf;
		svc.prerender = (req, meta = {}) =>
			queue.submit({
				kind: 'mg-prerender',
				title: req.compositionId,
				priority: 'user',
				cpuSlots: 0,
				...(meta.parentId ? { parentId: meta.parentId } : {}),
				input: { req, renderKey: keyOf(req), concurrency: meta.concurrency },
			});
		const req = (id: string, durationFrames: number) =>
			({ compositionId: id, durationFrames }) as unknown as MgPrerenderRequest;
		// Cached already: not rendered again.
		mkdirSync(join(svc.mgDir, keyOf(req('c0', 30))), { recursive: true });
		writeFileSync(join(svc.mgDir, keyOf(req('c0', 30)), 'master.mov'), 'x');
		const stages: string[] = [];
		const out = await svc.ensureMasters(
			[req('a1', 90), req('a2', 30), req('a3', 30), req('a2', 30), req('c0', 30)],
			{
				parentId: 'job_MGPARENT0000001',
				signal: new AbortController().signal,
				concurrency: 4,
				stage: (t) => stages.push(t),
			},
		);
		expect([...out.keys()].sort()).toEqual(['a1', 'a2', 'a3', 'c0'].map((c) => c.padStart(40, '0')).sort());
		expect(rendered.map((r) => r.key).sort()).toEqual(
			['a1', 'a2', 'a3'].map((c) => c.padStart(40, '0')).sort(),
		);
		expect(peak.renders).toBeGreaterThanOrEqual(2);
		expect(peak.pages).toBeLessThanOrEqual(4);
		// The budget split by length: 90 frames → 2 pages, 30 → 1 each.
		expect(rendered.find((r) => r.key.endsWith('a1'))!.pages).toBe(2);
		expect(stages[0]).toBe('Rendering compositions 0/3');
		expect(stages.at(-1)).toBe('Rendering compositions 3/3');
		// Abort: every pre-render in flight is cancelled, none is left running.
		delayMs = 5_000;
		const ac = new AbortController();
		const p = svc.ensureMasters([req('b1', 30), req('b2', 30), req('b3', 30)], {
			parentId: 'job_MGPARENT0000002',
			signal: ac.signal,
			concurrency: 2,
			stage: () => undefined,
		});
		await until(() => active.renders === 2, 10_000, 10);
		ac.abort();
		await expect(p).rejects.toMatchObject({ code: 'JOB_CANCELLED' });
		await until(() => active.renders === 0, 10_000, 10);
		expect(
			queue
				.list({})
				.filter((j) => j.parentId === 'job_MGPARENT0000002')
				.map((j) => j.state),
		).toEqual(['cancelled', 'cancelled']);
		await app.close();
	}, 60_000);
});

describe('mg-bundles routes (no browser)', () => {
	it('serves bundle files (Range, traversal-safe) and the live host page; caches and GC', async () => {
		const app = await makeApp();
		const svc = mgBundleService(app)!;
		expect(svc).toBeTruthy();
		const reg = await registerFake(svc, fakeBundle(tempAppdir('jasper-fake-')));
		expect(reg.kind).toBe('mg-bundle');
		expect(reg.mgBundle?.compositions[0]?.id).toBe('Title');
		const base = `/mg/bundles/${reg.mediaKey}`;
		const js = await app.inject({ method: 'GET', url: `${base}/bundle.js`, headers: JSON_H });
		expect(js.statusCode).toBe(200);
		expect(js.headers['content-type']).toMatch(/javascript/);
		expect(js.headers['cache-control']).toMatch(/immutable/);
		const part = await app.inject({
			method: 'GET',
			url: `${base}/public/a.txt`,
			headers: { ...JSON_H, range: 'bytes=0-2' },
		});
		expect([part.statusCode, part.body]).toEqual([206, 'sta']);
		expect(
			(
				await app.inject({
					method: 'GET',
					url: `${base}/..%2F..%2Fengine%2Fmedia-index.json`,
					headers: JSON_H,
				})
			).statusCode,
		).toBe(404);
		expect(
			(
				await app.inject({
					method: 'GET',
					url: `/mg/bundles/mk_000000000000000000000000/index.html`,
					headers: JSON_H,
				})
			).statusCode,
		).toBe(404);
		const plain = await app.inject({ method: 'GET', url: `${base}/index.html`, headers: JSON_H });
		expect(plain.body).not.toContain('remotion_puppeteerTimeout');
		const host = await app.inject({
			method: 'GET',
			url: `${base}/index.html?${MG_HOST_QUERY}=1`,
			headers: JSON_H,
		});
		expect(host.statusCode).toBe(200);
		expect(host.body).toContain('remotion_puppeteerTimeout');
		expect(host.headers['cache-control']).toBe('no-store');
		// Media status works for bundles (availability = the index file).
		expect(
			(await app.inject({ method: 'GET', url: `/api/media/${reg.mediaKey}`, headers: JSON_H })).json().status,
		).toMatch(/online|processing/);
		// Pre-render cache lookups and GC of composition renders only.
		const key = 'c'.repeat(40);
		expect(
			(await app.inject({ method: 'GET', url: `/api/mg-bundles/prerender/${key}`, headers: JSON_H }))
				.statusCode,
		).toBe(404);
		const dir = join(svc.mgDir, key);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'master.mov'), 'x');
		const req: MgPrerenderRequest = {
			mediaKey: reg.mediaKey,
			compositionId: 'Title',
			props: {},
			width: 2,
			height: 2,
			fps: { num: 30, den: 1 },
			startFrame: 0,
			durationFrames: 1,
			quality: 'master',
		};
		const t = new Date().toISOString();
		writeFileSync(
			join(dir, 'meta.json'),
			JSON.stringify({
				kind: 'composition',
				renderKey: key,
				request: req,
				bundleHash: 'x',
				files: ['master.mov'],
				createdAt: t,
				lastUsedAt: t,
			}),
		);
		const hit = (
			await app.inject({ method: 'GET', url: `/api/mg-bundles/prerender/${key}`, headers: JSON_H })
		).json();
		expect(hit).toMatchObject({ renderKey: key, masterUrl: `/mg/${key}/master.mov`, durationFrames: 1 });
		const fframes = join(svc.mgDir, 'd'.repeat(40));
		mkdirSync(fframes);
		writeFileSync(join(fframes, 'meta.json'), JSON.stringify({ key: 'd', verified: true }));
		expect(await svc.gc()).toBe(0);
		const metaFile = join(dir, 'meta.json');
		const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
		meta.lastUsedAt = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
		writeFileSync(metaFile, JSON.stringify(meta));
		expect(await svc.gc()).toBe(1);
		expect(existsSync(dir)).toBe(false);
		expect(existsSync(fframes)).toBe(true);
	});

	it('reports features.mgBundles; validates imports; refuses unknown bundles and non-rebuildable ones', async () => {
		const app = await makeApp();
		const caps = (await app.inject({ method: 'GET', url: '/api/capabilities', headers: JSON_H })).json();
		expect(caps.features.mgBundles).toMatchObject({ projectImport: true });
		expect(['ready', 'unavailable']).toContain(caps.features.mgBundles.status);
		const bad = await app.inject({
			method: 'POST',
			url: '/api/mg-bundles/import',
			headers: JSON_H,
			payload: {},
		});
		expect(bad.statusCode).toBe(400);
		const rel = await app.inject({
			method: 'POST',
			url: '/api/mg-bundles/import',
			headers: JSON_H,
			payload: { path: 'relative/dir' },
		});
		expect(rel.json().code).toBe('BAD_REQUEST');
		const svc = mgBundleService(app)!;
		const reg = await registerFake(svc, fakeBundle(tempAppdir('jasper-fake2-')));
		const rb = await app.inject({
			method: 'POST',
			url: `/api/mg-bundles/${reg.mediaKey}/rebuild`,
			headers: JSON_H,
			payload: {},
		});
		expect([rb.statusCode, rb.json().code]).toEqual([409, 'MG_NOT_A_BUNDLE']);
		const pr = await app.inject({
			method: 'POST',
			url: '/api/mg-bundles/prerender',
			headers: JSON_H,
			payload: {
				mediaKey: 'mk_000000000000000000000000',
				compositionId: 'Title',
				props: {},
				width: 2,
				height: 2,
				fps: { num: 30, den: 1 },
				startFrame: 0,
				durationFrames: 1,
				quality: 'preview',
			},
		});
		expect(pr.statusCode).toBe(404);
	});

	it('bundle uploads are completed by the import, not by the media registry', async () => {
		const app = await makeApp();
		const zip = makeZip([{ name: 'index.html', data: '<html></html>' }]);
		const up = (
			await app.inject({
				method: 'POST',
				url: '/api/uploads',
				headers: JSON_H,
				payload: {
					projectId: 'prj_x',
					fileName: 'b.zip',
					byteSize: zip.length,
					mimeType: 'application/zip',
					purpose: 'mg-bundle',
				},
			})
		).json();
		await app.inject({
			method: 'PUT',
			url: `/api/uploads/${up.uploadId}?offset=0`,
			headers: { ...JSON_H, 'content-type': 'application/octet-stream' },
			payload: zip,
		});
		const done = await app.inject({
			method: 'POST',
			url: `/api/uploads/${up.uploadId}/complete`,
			headers: H,
		});
		expect(done.statusCode, done.body).toBe(409);
		expect(done.json().message).toMatch(/mg-bundles\/import/);
		const core = coreServices(app);
		const taken = await core.uploads.take(up.uploadId, 'mg-bundle');
		expect(readFileSync(taken.file)).toEqual(zip);
		await taken.release();
		await expect(core.uploads.take(up.uploadId, 'mg-bundle')).rejects.toThrow();
	});
});

// ---------------------------------------------------------------- the real thing (MG_E2E=1)

type Rgba = Uint8Array;

/** Decodes frame `n` of a video (or a PNG) to raw RGBA (straight alpha) / RGB. */
function decode(
	file: string,
	opts: { frame?: number; pix: 'rgba' | 'rgb24'; decoder?: string; ffmpeg: string },
): Buffer {
	const args = [
		'-v',
		'error',
		...(opts.decoder ? ['-c:v', opts.decoder] : []),
		'-i',
		file,
		...(opts.frame !== undefined
			? ['-vf', `select=eq(n\\,${opts.frame})`, '-frames:v', '1']
			: ['-frames:v', '1']),
		'-pix_fmt',
		opts.pix,
		'-f',
		'rawvideo',
		'pipe:1',
	];
	const r = spawnSync(opts.ffmpeg, args, { maxBuffer: 1 << 28 });
	if (r.status !== 0) throw new Error(`ffmpeg decode failed: ${r.stderr}`);
	return r.stdout;
}

/** Straight-alpha composite of `fg` over a flat colour → RGB. */
function over(fg: Rgba, bg: [number, number, number]): Uint8Array {
	const out = new Uint8Array((fg.length / 4) * 3);
	for (let i = 0, j = 0; i < fg.length; i += 4, j += 3) {
		const a = fg[i + 3]! / 255;
		for (let c = 0; c < 3; c++) out[j + c] = Math.round(fg[i + c]! * a + bg[c]! * (1 - a));
	}
	return out;
}

describe.runIf(E2E)('Remotion bundles end to end (MG_E2E=1, S08 §8)', () => {
	let app: Awaited<ReturnType<typeof makeApp>>;
	let svc: MgBundleService;
	let ff: string;
	let title: RegisteredMedia;
	const projectId = 'prj_MGTEST000000001';

	beforeAll(async () => {
		ensureFixtures();
		app = await makeApp({ totalSlots: 12 });
		svc = mgBundleService(app)!;
		ff = coreServices(app).ffmpeg.bins.ffmpeg!;
		const r = await app.inject({
			method: 'POST',
			url: '/api/mg-bundles/import',
			headers: JSON_H,
			payload: { path: FIXTURE_PROJECT, projectId },
		});
		expect(r.statusCode, r.body).toBe(200);
		title = r.json();
	}, 600_000);

	const job = async (id: string): Promise<EngineJob> => {
		await until(
			() => {
				const j = coreServices(app).queue.get(id);
				return j && ['succeeded', 'failed', 'cancelled'].includes(j.state);
			},
			900_000,
			200,
		);
		return coreServices(app).queue.get(id)!;
	};

	it('test 2: imports the project — Title schema from the module, Badge inferred, manifest hints', () => {
		expect(title.kind).toBe('mg-bundle');
		const info = title.mgBundle!;
		expect(info.remotionVersion).toBe('4.0.499');
		expect(info.source).toMatchObject({
			type: 'project-dir',
			path: FIXTURE_PROJECT,
			name: '@jasper/fixture-mg-project',
		});
		const t = info.compositions.find((c) => c.id === 'Title')!;
		const b = info.compositions.find((c) => c.id === 'Badge')!;
		expect(t).toMatchObject({
			width: 1920,
			height: 1080,
			fps: 30,
			durationInFrames: 90,
			schemaSource: 'bundle',
			category: 'Titles',
			thumbnailFrame: 45,
		});
		expect(t.defaultProps).toEqual({ title: 'Hello Jasper', accent: '#ff3366', delay: 6 });
		expect((t.propsSchema as { required: string[] }).required).toEqual(['title', 'accent', 'delay']);
		expect(t.ui?.accent?.control).toBe('color');
		expect(b).toMatchObject({ width: 640, height: 360, schemaSource: 'inferred' });
		expect(b.propsSchema).toMatchObject({
			properties: { size: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } } },
		});
		expect(b.ui?.color?.control).toBe('color');
	});

	it('test 2: a project pinned to another Remotion version fails with MG_REMOTION_VERSION', async () => {
		const dir = tempAppdir('jasper-oldremotion-');
		cpSync(join(FIXTURE_PROJECT, 'src'), join(dir, 'src'), { recursive: true });
		writeFileSync(
			join(dir, 'package.json'),
			JSON.stringify({ name: 'old', dependencies: { remotion: '4.0.400', '@remotion/cli': '4.0.400' } }),
		);
		const r = await app.inject({
			method: 'POST',
			url: '/api/mg-bundles/import',
			headers: JSON_H,
			payload: { path: dir },
		});
		expect(r.statusCode).toBe(422);
		expect(r.json()).toMatchObject({
			code: 'MG_REMOTION_VERSION',
			detail: { found: '4.0.400', hint: expect.stringMatching(/pin/) },
		});
	});

	it('test 2: a zip of the built bundle imports on the web (upload) path', async () => {
		const zip = zipDir(svc.bundleDir(title.mediaKey)!, 'my-bundle/');
		const up = (
			await app.inject({
				method: 'POST',
				url: '/api/uploads',
				headers: JSON_H,
				payload: {
					projectId,
					fileName: 'my-bundle.zip',
					byteSize: zip.length,
					mimeType: 'application/zip',
					purpose: 'mg-bundle',
				},
			})
		).json();
		const put = await app.inject({
			method: 'PUT',
			url: `/api/uploads/${up.uploadId}?offset=0`,
			headers: { ...JSON_H, 'content-type': 'application/octet-stream' },
			payload: zip,
		});
		expect(put.statusCode, put.body).toBe(200);
		const r = await app.inject({
			method: 'POST',
			url: '/api/mg-bundles/import',
			headers: JSON_H,
			payload: { uploadId: up.uploadId, projectId },
		});
		expect(r.statusCode, r.body).toBe(200);
		const z = r.json() as RegisteredMedia;
		// Same content → same content address and key; source says it was uploaded.
		expect(z.mediaKey).toBe(title.mediaKey);
		expect(z.mgBundle?.source).toMatchObject({ type: 'bundle-upload', path: null, name: 'my-bundle' });
		expect(z.mgBundle?.compositions.map((c) => c.id).sort()).toEqual(['Badge', 'LowerThird', 'Title']);
		// Re-register the project-dir header for the next tests.
		title = (
			await app.inject({
				method: 'POST',
				url: '/api/mg-bundles/import',
				headers: JSON_H,
				payload: { path: FIXTURE_PROJECT, projectId },
			})
		).json();
	}, 600_000);

	/** Exports a sequence (ProRes HQ for exact comparisons); returns the job and its child jobs. */
	async function exportDoc(d: DocBuilder, opts: { frames?: [number, number]; profile?: 'hq' | '4444' } = {}) {
		const settings = {
			sequenceId: d.seqId,
			range: opts.frames
				? { type: 'custom', startFrame: opts.frames[0], endFrame: opts.frames[1] }
				: { type: 'entire' },
			container: 'mov',
			engine: 'native',
			video: {
				codec: 'prores',
				proresProfile: opts.profile ?? 'hq',
				width: 1920,
				height: 1080,
				frameRate: { num: 30, den: 1 },
				scaling: 'fit',
				quality: { mode: 'crf', value: 10 },
				encoderSpeed: 'fast',
				colorTags: 'rec709',
			},
		};
		const plan = (
			await app.inject({
				method: 'POST',
				url: '/api/exports/plan',
				headers: JSON_H,
				payload: { envelope: d.envelope(), sequenceId: d.seqId, settings },
			})
		).json();
		const started = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: { envelope: d.envelope(), sequenceId: d.seqId, settings },
		});
		expect(started.statusCode, started.body).toBeLessThan(300);
		const done = await job(started.json().id);
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
		const children = coreServices(app)
			.queue.list({})
			.filter((j) => j.parentId === done.id);
		const out = join(coreServices(app).config.paths.rendersDir, done.id, 'output.mov');
		return { plan, done, children, out };
	}

	/** A direct Remotion still of a fixture composition (RGBA, straight alpha); default Title. */
	async function directStill(props: Record<string, unknown>, frame: number, id = 'Title'): Promise<Buffer> {
		const r = await import('@remotion/renderer');
		const dir = svc.bundleDir(title.mediaKey)!;
		const opts = (svc as unknown as { remotionOptions(): Record<string, unknown> }).remotionOptions();
		const comp = await r.selectComposition({
			serveUrl: dir,
			id,
			inputProps: props,
			logLevel: 'error',
			...opts,
		});
		const out = join(tempAppdir('jasper-still-'), 'still.png');
		await r.renderStill({
			serveUrl: dir,
			composition: comp,
			inputProps: props,
			frame,
			output: out,
			imageFormat: 'png',
			logLevel: 'error',
			overwrite: true,
			...opts,
		});
		return decode(out, { pix: 'rgba', ffmpeg: ff });
	}

	it('tests 5 + 6: native export with a cached master, frame-exact, straight alpha; cache hits and invalidation', async () => {
		const d = new DocBuilder('hd-1080p-30');
		const mediaId = d.addMedia(title);
		// A flat grey background makes the expected frame computable: still composited over grey.
		d.tx([
			{
				type: 'sequence.updateSettings',
				sequenceId: d.seqId,
				settings: { backgroundColor: [0.5, 0.5, 0.5, 1] },
			},
		]);
		const props = { title: 'Export test', accent: '#22aa66', delay: 0 };
		const { clipId } = (() => {
			const r = d.tx([
				{
					type: 'clip.addComposition',
					composition: { mediaId, id: 'Title' },
					at: 15,
					track: 'V1',
					props,
					duration: 60,
				},
			]);
			return { clipId: (r.results[0] as { clipId: string }).clipId };
		})();
		const first = await exportDoc(d);
		expect(first.plan.path).toBe('native');
		expect(first.children.filter((j) => j.kind === 'mg-prerender')).toHaveLength(1);
		// Midpoint of the clip: sequence frame 45 = composition frame 30.
		const got = decode(first.out, { frame: 45, pix: 'rgb24', ffmpeg: ff });
		const still = await directStill(props, 30);
		const expected = over(still, [128, 128, 128]);
		let within = 0;
		for (let i = 0; i < expected.length; i++) if (Math.abs(got[i]! - expected[i]!) <= 3) within++;
		expect(within / expected.length).toBeGreaterThanOrEqual(0.99);
		// Frame exactness: before the clip the output is the plain background; during the entrance (the panel
		// still moving) sequence frame 25 is exactly composition frame 10, not 9 or 11.
		const before = decode(first.out, { frame: 14, pix: 'rgb24', ffmpeg: ff });
		expect(Math.max(...before.subarray(0, 3000).map((v) => Math.abs(v - 128)))).toBeLessThanOrEqual(3);
		const moving = decode(first.out, { frame: 25, pix: 'rgb24', ffmpeg: ff });
		const share = (exp: Uint8Array) => {
			let n = 0;
			for (let i = 0; i < exp.length; i++) if (Math.abs(moving[i]! - exp[i]!) <= 3) n++;
			return n / exp.length;
		};
		expect(share(over(await directStill(props, 10), [128, 128, 128]))).toBeGreaterThanOrEqual(0.99);
		expect(share(over(await directStill(props, 9), [128, 128, 128]))).toBeLessThan(0.99);
		expect(share(over(await directStill(props, 11), [128, 128, 128]))).toBeLessThan(0.99);

		// Test 6: the master over four flat colours equals the straight-alpha expectation (Chrome's own pixels).
		const masterKey = svc.renderKeyOf(
			masterRequests(
				buildRenderSnapshot(d.doc, d.seqId, { resolveMedia: () => null, resolveFont: () => null }),
			)[0]!.req,
		)!;
		const master = svc.masterPath(masterKey)!;
		const probe = spawnSync(
			coreServices(app).ffmpeg.bins.ffprobe!,
			['-v', 'error', '-show_streams', '-of', 'json', master],
			{ encoding: 'utf8' },
		);
		const s = JSON.parse(probe.stdout).streams[0];
		expect(s).toMatchObject({
			codec_name: 'prores',
			profile: '4444',
			color_space: 'bt709',
			color_primaries: 'bt709',
			color_transfer: 'bt709',
		});
		expect(s.pix_fmt).toMatch(/^yuva444p/);
		const mframe = decode(master, { frame: 30, pix: 'rgba', ffmpeg: ff });
		for (const bg of [
			[255, 0, 0],
			[0, 255, 0],
			[0, 0, 255],
			[255, 255, 255],
		] as [number, number, number][]) {
			const a = over(mframe, bg);
			const b = over(still, bg);
			let worstSemi = 0;
			let semi = 0;
			for (let i = 0, j = 0; i < still.length; i += 4, j += 3) {
				const alpha = still[i + 3]!;
				if (alpha === 0 || alpha === 255) continue;
				semi++;
				for (let c = 0; c < 3; c++) worstSemi = Math.max(worstSemi, Math.abs(a[j + c]! - b[j + c]!));
			}
			expect(semi).toBeGreaterThan(1000); // the panel and its shadow
			// No dark fringes / halos: semi-transparent pixels within 2/255 (+1 for 10-bit 4:4:4 rounding).
			expect(worstSemi).toBeLessThanOrEqual(3);
		}

		// Second export: no master render (cache hit).
		const second = await exportDoc(d);
		expect(second.children.filter((j) => j.kind === 'mg-prerender')).toHaveLength(0);
		// Changing a prop renders a new master.
		d.tx([{ type: 'param.set', target: ['clip', clipId, 'props', 'title'], value: 'Changed' }]);
		const third = await exportDoc(d, { frames: [15, 75] });
		expect(third.children.filter((j) => j.kind === 'mg-prerender')).toHaveLength(1);
	}, 1_200_000);

	it('hybrid text layers (S08 §8 test 9): a text + style edit renders a new master; the export is frame-exact with the embedded font', async () => {
		const lt = title.mgBundle!.compositions.find((c) => c.id === 'LowerThird')!;
		expect(lt.texts).toMatchObject({ 'name.text': { label: 'Name', maxChars: 24 }, quote: { maxLines: 2 } });
		const layers = compositionTextLayers(lt);
		expect(layers.map((l) => l.path.join('.'))).toEqual(['name.text', 'role', 'quote']);
		const name = layers[0]!;
		expect(Object.keys(name.style).sort()).toEqual([
			'align',
			'color',
			'fontFamily',
			'fontSize',
			'fontWeight',
		]);

		const d = new DocBuilder('hd-1080p-30');
		const mediaId = d.addMedia(title);
		d.tx([
			{
				type: 'sequence.updateSettings',
				sequenceId: d.seqId,
				settings: { backgroundColor: [0.5, 0.5, 0.5, 1] },
			},
		]);
		const r0 = d.tx([
			{
				type: 'clip.addComposition',
				composition: { mediaId, id: 'LowerThird' },
				at: 15,
				track: 'V1',
				duration: 60,
			},
		]);
		const clipId = (r0.results[0] as { clipId: string }).clipId;
		const first = await exportDoc(d);
		expect(first.plan.path).toBe('native');
		expect(first.children.filter((j) => j.kind === 'mg-prerender')).toHaveLength(1);

		// The edit an editor makes: the text and two of its style props in one override object, one step.
		const clip = d.doc.sequences[d.seqId]!.clips[clipId] as CompositionClip;
		const next = overridesWithEdits(lt.defaultProps, clip.props, [
			{ path: name.path, value: 'Grace Hopper' },
			{ path: name.style.color!.path, value: '#ffcc00' },
			{ path: name.style.fontSize!.path, value: 100 },
			{ path: ['quote'], value: 'It is easier to ask forgiveness\nthan it is to get permission.' },
		]);
		d.tx([{ type: 'clip.update', clipId, patch: { props: next } }]);
		// ProRes 4444 out: saturated yellow type on a dark panel loses colour at its edges in 4:2:2 (HQ), which
		// is the codec, not the placement or the text being compared here.
		const second = await exportDoc(d, { profile: '4444' });
		expect(second.children.filter((j) => j.kind === 'mg-prerender')).toHaveLength(1); // new render key
		const props = mergeProps(lt.defaultProps, next);
		const share = (got: Uint8Array, exp: Uint8Array) => {
			let n = 0;
			for (let i = 0; i < exp.length; i++) if (Math.abs(got[i]! - exp[i]!) <= 3) n++;
			return n / exp.length;
		};
		const grey = [128, 128, 128] as [number, number, number];
		// Held text: sequence frame 60 = composition frame 45.
		const held = decode(second.out, { frame: 60, pix: 'rgb24', ffmpeg: ff });
		const heldExpected = over(await directStill(props, 45, 'LowerThird'), grey);
		expect(share(held, heldExpected)).toBeGreaterThanOrEqual(0.99);
		// The previous text is gone (the master was re-rendered, not reused).
		expect(share(held, over(await directStill(lt.defaultProps, 45, 'LowerThird'), grey))).toBeLessThan(0.99);
		// Frame-exact during the entrance: sequence frame 20 = composition frame 5, not 4 or 6.
		const moving = decode(second.out, { frame: 20, pix: 'rgb24', ffmpeg: ff });
		expect(share(moving, over(await directStill(props, 5, 'LowerThird'), grey))).toBeGreaterThanOrEqual(0.99);
		expect(share(moving, over(await directStill(props, 4, 'LowerThird'), grey))).toBeLessThan(0.99);
		expect(share(moving, over(await directStill(props, 6, 'LowerThird'), grey))).toBeLessThan(0.99);
		// The embedded face is what the export drew: inside the name's box the export matches the Inter render and
		// not the same props drawn with a system family.
		const box = (exp: Uint8Array) => {
			let n = 0;
			let all = 0;
			for (let y = 690; y < 830; y++)
				for (let x = 130; x < 1190; x++)
					for (let c = 0; c < 3; c++) {
						const i = (y * 1920 + x) * 3 + c;
						all++;
						if (Math.abs(held[i]! - exp[i]!) <= 3) n++;
					}
			return n / all;
		};
		const sans = mergeProps(props, { name: { fontFamily: 'sans-serif' } });
		// (Glyph edges dominate this box, so the bar is lower than the whole-frame 99 %: measured 97 %.)
		const withInter = box(heldExpected);
		const withSans = box(over(await directStill(sans, 45, 'LowerThird'), grey));
		expect(withInter).toBeGreaterThanOrEqual(0.95);
		expect(withSans).toBeLessThan(withInter - 0.03);
	}, 1_200_000);

	it('measures text layout in the engine browser (S08:MGC-037): clipped name, quote off frame and outside its box', async () => {
		const lt = title.mgBundle!.compositions.find((c) => c.id === 'LowerThird')!;
		const layers = compositionTextLayers(lt);
		const props = mergeProps(lt.defaultProps, {
			name: { text: 'Augusta Ada King, Countess of Lovelace' },
			quote:
				'Imagination is the *Discovering Faculty*, pre-eminently. It is that which penetrates into the unseen worlds around us, the worlds of Science. It is that which feels and discovers.',
		});
		const items = layers.map((l) => ({ id: l.path.join('.'), text: textLayerValue(props, l) }));
		const payload = {
			mediaKey: title.mediaKey,
			compositionId: 'LowerThird',
			props,
			width: 1920,
			height: 1080,
			fps: 30,
			durationInFrames: 120,
			frames: [{ frame: 60, items }],
		};
		const r = await app.inject({
			method: 'POST',
			url: '/api/mg-bundles/measure-texts',
			headers: JSON_H,
			payload,
		});
		expect(r.statusCode, r.body).toBe(200);
		const body = r.json() as { measurements: MgTextMeasurement[]; fonts: string[] };
		expect(body.fonts).toContain('Inter');
		const by = new Map(body.measurements.map((m) => [m.id, m]));
		const issues = (id: string) =>
			measuredTextIssues(layers.find((l) => l.path.join('.') === id)!, by.get(id)!, {
				width: 1920,
				height: 1080,
			}).map((i) => i.code);
		// The name runs past its panel (overflow hidden): cut off.
		expect(by.get('name.text')).toMatchObject({ found: true, visible: true });
		expect(by.get('name.text')!.clippedBy).toMatchObject({ x: 96, width: 1100 });
		expect(issues('name.text')).toEqual(['MG_TEXT_CLIPPED']);
		expect(issues('role')).toEqual([]);
		// The quote (markup ignored when matching) wraps to more rows than designed and leaves its safe box.
		expect(by.get('quote')).toMatchObject({ found: true });
		expect(by.get('quote')!.lines.length).toBeGreaterThan(2);
		expect(issues('quote')).toEqual(['MG_TEXT_OUTSIDE_BOX', 'MG_TEXT_LINES']);
		expect(by.get('quote')!.style).toMatchObject({ fontSize: 54 });
		// Cached: the same request answers without a browser.
		const t0 = Date.now();
		const again = await app.inject({
			method: 'POST',
			url: '/api/mg-bundles/measure-texts',
			headers: JSON_H,
			payload,
		});
		expect(again.json()).toEqual(body);
		expect(Date.now() - t0).toBeLessThan(5000);
	}, 600_000);

	it('rebuilds a watched project after a source edit: new bundle hash, new master (MGC-013)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-watch-'));
		for (const f of ['src', 'remotion.config.ts', 'jasper.mg.json', 'package.json', 'tsconfig.json'])
			cpSync(join(FIXTURE_PROJECT, f), join(dir, f), { recursive: true });
		symlinkSync(join(FIXTURE_PROJECT, 'node_modules'), join(dir, 'node_modules'));
		const events: { type: string; payload: unknown }[] = [];
		const off = coreServices(app).broadcaster.subscribe((e) => events.push(e), {});
		const response = await app.inject({
			method: 'POST',
			url: '/api/mg-bundles/import',
			headers: JSON_H,
			payload: { path: dir, watch: true, projectId },
		});
		expect(response.statusCode, response.body).toBe(200);
		const first = response.json() as RegisteredMedia;
		expect(svc.watching().some((w) => w.dir === dir)).toBe(true);
		const src = join(dir, 'src', 'Title.tsx');
		writeFileSync(src, readFileSync(src, 'utf8').replace('borderRadius: 24', 'borderRadius: 4'));
		await until(() => events.find((e) => e.type === 'mgBundle.rebuilt'), 600_000, 500);
		off();
		const ev = events.find((e) => e.type === 'mgBundle.rebuilt')!.payload as {
			oldKey: string;
			newKey: string;
			mgBundle: MgBundleInfo;
		};
		expect(ev.oldKey).toBe(first.mediaKey);
		expect(ev.newKey).not.toBe(first.mediaKey);
		expect(ev.mgBundle.bundleHash).not.toBe(first.mgBundle!.bundleHash);
		// Masters of the old and the new bundle have different keys (never reused, MGC-031).
		const req = {
			mediaKey: first.mediaKey,
			compositionId: 'Title',
			props: {},
			width: 1920,
			height: 1080,
			fps: { num: 30, den: 1 },
			startFrame: 0,
			durationFrames: 90,
			quality: 'master' as const,
		};
		expect(svc.renderKeyOf(req)).not.toBe(svc.renderKeyOf({ ...req, mediaKey: ev.newKey }));
		svc.stopWatch(dir);
		rmSync(dir, { recursive: true, force: true });
	}, 900_000);

	it('the clip document keeps working with the relinked bundle (composition model)', () => {
		const { d, clipId } = docWithComposition(title);
		expect((d.doc.sequences[d.seqId]!.clips[clipId] as CompositionClip).composition.id).toBe('Title');
		expect(fixture('clip-a.mp4')).toMatch(/clip-a/);
	});
});
