// social-comment §7.8: remote fonts / emoji through the engine — catalogue, font and emoji routes (auth and signed
// URLs), Settings ▸ Privacy & Network (approval for agents), prefetch / status / notice routes, the export planner's
// blocker and the layer-bake key (font hashes, emoji pack id + version). Downloads come from a local fixture server.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FontCatalogSchema, RemoteAssetsStatusSchema } from '@jasper/api';
import { type AnyMgTemplate, emojiGraphemes, mgRegistry } from '@jasper/mg-templates';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	makeEnvelope,
	type ProjectDocument,
	type RenderSnapshot,
	type RenderVisualClip,
} from '@jasper/project';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PlanError, planExport } from '../src/export/planner.ts';
import type { BakeEnvironment } from '../src/layer-bake/key.ts';
import type { LayerBakeService } from '../src/layer-bake/service.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, H, makeApp, type TestApp, tempAppdir } from './helpers.ts';
import { FixtureServer, FONT_BYTES, fixtureManifest, pngBytes, sha256 } from './remote-assets-fixture.ts';

const GRIN = '\u{1F600}';
const TOKEN = 'tok-remote-assets';
const AUTH = { ...H, authorization: `Bearer ${TOKEN}` };
const JSON_AUTH = { ...AUTH, 'content-type': 'application/json' };
const FONT_FILE = `chirp-700-${sha256(FONT_BYTES).slice(0, 16)}.woff2`;
const ENV: BakeEnvironment = { bundleId: 'b1', animejs: '4.5.0', remotion: '4.0.499', browser: 'chrome', gl: 'swiftshader' };

let server: FixtureServer;

function writeOverride(appdir: string, manifest: unknown) {
	mkdirSync(join(appdir, 'assets'), { recursive: true });
	writeFileSync(join(appdir, 'assets', 'remote-manifest.override.json'), JSON.stringify(manifest));
}

async function appWithFixtures(o: { editorKey?: string } = {}): Promise<TestApp> {
	const appdir = tempAppdir();
	writeOverride(appdir, fixtureManifest(server.url));
	return makeApp({ appdir, token: TOKEN, ...(o.editorKey ? { editorKey: o.editorKey } : {}) });
}

beforeAll(async () => {
	server = await new FixtureServer().start();
	server.routes.set('/fonts/chirp-700.woff2', { body: FONT_BYTES, contentType: 'font/woff2' });
	server.routes.set('/emoji/1f600.png', { body: pngBytes(4, 4, [255, 0, 0, 255]), contentType: 'image/png' });
	server.routes.set('/emoji/1f680.png', { body: pngBytes(4, 4, [0, 255, 0, 255]), contentType: 'image/png' });
});
afterAll(async () => {
	await closeApps();
	await server.close();
});

describe('catalogue and routes', () => {
	let app: TestApp;
	beforeAll(async () => {
		app = await appWithFixtures();
	});

	it('lists TikTok Sans (bundled), Roboto 400/500/700 and the remote families and emoji packs', async () => {
		const res = await app.inject({ method: 'GET', url: '/api/fonts', headers: AUTH });
		const cat = FontCatalogSchema.parse(res.json());
		const tiktok = cat.fonts.find((f) => f.family === 'TikTok Sans');
		expect(tiktok).toMatchObject({ source: 'bundled' });
		for (const w of [400, 500, 600, 700])
			for (const subset of ['latin', 'latin-ext'])
				expect(tiktok!.files.some((f) => f.weight === w && f.subset === subset && f.style === 'normal')).toBe(true);
		const roboto = cat.fonts.find((f) => f.family === 'Roboto')!;
		for (const w of [400, 500, 700]) expect(roboto.files.some((f) => f.weight === w && f.subset === 'latin')).toBe(true);
		expect(cat.fonts.find((f) => f.family === 'Chirp')).toMatchObject({
			source: 'remote',
			files: [{ weight: 700, style: 'normal', url: `/fonts/remote/${FONT_FILE}` }],
		});
		expect(cat.emojiPacks).toEqual([
			{ id: 'apple', name: 'Apple', version: '1', format: 'png', licence: 'test fixture', attribution: null },
		]);
		const bundled = await app.inject({ method: 'GET', url: tiktok!.files[0]!.url, headers: AUTH });
		expect(bundled.statusCode).toBe(200);
	});

	it('serves remote fonts and emoji with the session token or a signed URL, never anonymously', async () => {
		const core = coreServices(app);
		for (const path of [`/fonts/remote/${FONT_FILE}`, '/fonts/emoji/apple/1/1f600.png']) {
			const anon = await app.inject({ method: 'GET', url: path, headers: H });
			expect(anon.statusCode, path).toBe(401);
			const signed = core.signer.signUrl('', path);
			const r = await app.inject({ method: 'GET', url: signed, headers: H });
			expect(r.statusCode, path).toBe(200);
			expect(r.headers['access-control-allow-origin']).toBe('*');
			const forged = await app.inject({ method: 'GET', url: `${path}?sig=AAAA&exp=99999999999`, headers: H });
			expect(forged.statusCode).toBe(401);
			const authed = await app.inject({ method: 'GET', url: path, headers: AUTH });
			expect(authed.statusCode).toBe(200);
			expect(authed.headers['cache-control']).toContain('immutable');
		}
		const font = await app.inject({ method: 'GET', url: `/fonts/remote/${FONT_FILE}`, headers: AUTH });
		expect(font.rawPayload.equals(FONT_BYTES)).toBe(true);
		expect(font.headers['content-type']).toBe('font/woff2');
		const img = await app.inject({ method: 'GET', url: '/fonts/emoji/apple/1/1f600.png', headers: AUTH });
		expect(img.headers['content-type']).toBe('image/png');
		expect(img.headers['x-content-type-options']).toBe('nosniff');
		// a signature never authorises a write, and does not cover other paths
		const sig = core.signer.signUrl('', '/fonts/emoji/apple/1/1f600.png').split('?')[1];
		const other = await app.inject({ method: 'GET', url: `/fonts/emoji/apple/1/1f680.png?${sig}`, headers: H });
		expect(other.statusCode).toBe(401);
	});

	it('answers unknown and unavailable assets with error bodies, without caching them', async () => {
		const unknown = await app.inject({ method: 'GET', url: '/fonts/remote/nope-0000.woff2', headers: AUTH });
		expect(unknown.statusCode).toBe(404);
		expect(unknown.json()).toMatchObject({ code: 'REMOTE_ASSET_UNKNOWN', retryable: false });
		const missing = await app.inject({ method: 'GET', url: '/fonts/emoji/apple/1/1fae8.png', headers: AUTH });
		expect(missing.statusCode).toBe(404);
		expect(missing.headers['cache-control']).toBe('no-store');
		const badKey = await app.inject({ method: 'GET', url: '/fonts/emoji/apple/1/..%2F..%2Fx.png', headers: AUTH });
		expect(badKey.statusCode).toBe(404);
	});

	it('Settings ▸ Privacy & Network: off stops downloads (409), prefetch names what is missing', async () => {
		const get = await app.inject({ method: 'GET', url: '/api/settings/network', headers: AUTH });
		expect(get.json()).toEqual({ platformAssets: true });
		const off = await app.inject({
			method: 'PUT',
			url: '/api/settings/network',
			headers: JSON_AUTH,
			payload: { platformAssets: false },
		});
		expect(off.json()).toEqual({ platformAssets: false });
		const r = await app.inject({ method: 'GET', url: '/fonts/emoji/apple/1/1f680.png', headers: AUTH });
		expect(r.statusCode).toBe(409);
		expect(r.json()).toMatchObject({ code: 'REMOTE_ASSETS_OFF', retryable: false });
		const pre = await app.inject({
			method: 'POST',
			url: '/api/remote-assets/prefetch',
			headers: JSON_AUTH,
			payload: { emoji: [{ pack: 'apple', graphemes: ['\u{1F680}', GRIN] }] },
		});
		expect(pre.json()).toMatchObject({ available: 1, missing: [{ kind: 'emoji', error: { code: 'REMOTE_ASSETS_OFF' } }] });
		const invalid = await app.inject({
			method: 'PUT',
			url: '/api/settings/network',
			headers: JSON_AUTH,
			payload: { platformAssets: 'yes' },
		});
		expect(invalid.statusCode).toBe(400);
		await app.inject({
			method: 'PUT',
			url: '/api/settings/network',
			headers: JSON_AUTH,
			payload: { platformAssets: true },
		});
	});

	it('status and the one-time notice', async () => {
		await coreServices(app).remoteAssets.flush();
		const st = RemoteAssetsStatusSchema.parse(
			(await app.inject({ method: 'GET', url: '/api/remote-assets', headers: AUTH })).json(),
		);
		expect(st.notice.pending).toBe(true);
		expect(st.notice.items[0]).toMatchObject({ host: server.host });
		expect(st.manifest.override.status).toBe('loaded');
		const ack = await app.inject({ method: 'POST', url: '/api/remote-assets/notice/ack', headers: AUTH });
		expect(RemoteAssetsStatusSchema.parse(ack.json()).notice.pending).toBe(false);
	});
});

describe('agents need the user to turn network use on', () => {
	it('an agent switching it on is asked about in the editor; switching it off is not', async () => {
		const app = await appWithFixtures({ editorKey: 'editor-key' });
		const off = await app.inject({
			method: 'PUT',
			url: '/api/settings/network',
			headers: JSON_AUTH,
			payload: { platformAssets: false },
		});
		expect(off.statusCode).toBe(200);
		const on = await app.inject({
			method: 'PUT',
			url: '/api/settings/network',
			headers: JSON_AUTH,
			payload: { platformAssets: true },
		});
		expect(on.statusCode).toBe(409);
		expect(on.json()).toMatchObject({ code: 'NO_SESSION' });
		expect(await coreServices(app).remoteAssets.settings.get()).toEqual({ platformAssets: false });
	});
});

// ── planner and bake keys ────────────────────────────────────────────────────────────────────────────────────────

const def = mgRegistry.getDefinition('title-reveal', 1) as AnyMgTemplate & { requiredAssets?: unknown };

describe('export planner and layer-bake keys', () => {
	let app: TestApp;
	beforeAll(async () => {
		app = await appWithFixtures();
		// A template that declares a remote font and the emoji of its title (the social-comment template does this).
		def.requiredAssets = (p: Record<string, unknown>) => ({
			fonts: [
				{ family: 'Chirp', weight: 700, style: 'normal' },
				{ family: 'Inter', weight: 400, style: 'normal' },
			],
			emoji: { pack: 'apple', graphemes: emojiGraphemes(String(p.title ?? '')) },
		});
	});
	afterAll(() => {
		delete def.requiredAssets;
	});
	afterEach(async () => {
		await coreServices(app).remoteAssets.putSettings({ platformAssets: true });
	});

	function build(title: string): { doc: ProjectDocument; seqId: string; clipId: string } {
		const ids = createCounterIdSource(5);
		const doc = createEmptyProject({ ids, name: 'Assets', preset: 'hd-1080p-30' });
		const seqId = Object.keys(doc.sequences)[0]!;
		const { document, result } = applyTransaction(
			doc,
			{
				label: 'mg',
				origin: 'user',
				sequenceId: seqId,
				commands: [
					{
						type: 'clip.addMotionGraphic',
						at: 0,
						duration: 60,
						track: 'V1',
						template: { id: 'title-reveal', version: 1 },
						params: { title },
						ref: '$a',
					},
				],
			},
			{ ids, now: () => 't', revision: 0, registries: defaultRegistries(mgRegistry) },
		);
		if (!result.ok) throw new Error(JSON.stringify(result.errors));
		return { doc: document, seqId, clipId: result.refs.$a! };
	}

	const settings = (seqId: string) =>
		({
			sequenceId: seqId,
			range: { type: 'entire' },
			container: 'mp4',
			video: {
				codec: 'h264',
				width: 1920,
				height: 1080,
				frameRate: { num: 30, den: 1 },
				scaling: 'fit',
				quality: { mode: 'crf', value: 23 },
				encoderSpeed: 'fast',
			},
			audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
			engine: 'auto',
		}) as never;

	function plan(doc: ProjectDocument, seqId: string) {
		const core = coreServices(app);
		return planExport(
			{ envelope: makeEnvelope(doc, { revision: 1, savedAt: 't', platform: 'test' }), sequenceId: seqId, settings: settings(seqId) },
			{
				registry: core.registry,
				fonts: core.fonts,
				capabilities: { native: true, remotionLocal: 'ready', fframes: 'ready', mgMasters: true },
				extensions: [],
			},
		);
	}

	async function planError(doc: ProjectDocument, seqId: string): Promise<PlanError> {
		try {
			await plan(doc, seqId);
		} catch (e) {
			expect(e).toBeInstanceOf(PlanError);
			return e as PlanError;
		}
		throw new Error('expected a PlanError');
	}

	const clipOf = (snap: RenderSnapshot, id: string): RenderVisualClip =>
		snap.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === id)!;

	it('downloads the declared assets before rendering and loads the template faces in the snapshot', async () => {
		const b = build(`Hello ${GRIN}`);
		const p = await plan(b.doc, b.seqId);
		const faces = p.snapshot.fonts.filter((f) => f.fontId.startsWith('template:'));
		expect(faces.map((f) => [f.family, f.weight, f.url])).toEqual([
			['Chirp', 700, `/fonts/remote/${FONT_FILE}`],
			['Inter', 400, expect.stringMatching(/^\/fonts\/inter\/inter-latin-400-normal\.woff2$/)],
		]);
		expect(p.snapshot.emoji).toEqual({ [`apple:${GRIN}`]: '/fonts/emoji/apple/1/1f600.png' });
		const mg = clipOf(p.snapshot, b.clipId).source as { mg: { assets?: unknown } };
		expect(mg.mg.assets).toEqual({
			fonts: [
				{ family: 'Chirp', weight: 700, style: 'normal' },
				{ family: 'Inter', weight: 400, style: 'normal' },
			],
			emoji: [{ pack: 'apple', graphemes: [GRIN] }],
		});
		expect(coreServices(app).fonts.filePath(`remote/${FONT_FILE}`)).toBeTruthy();
	});

	it('blocks the export naming the missing font, or the emoji and its pack (policy off, unknown, failed)', async () => {
		const missingEmoji = build(`Hi \u{1FAE8}`);
		const e1 = await planError(missingEmoji.doc, missingEmoji.seqId);
		expect(e1.code).toBe('TEMPLATE_ASSETS_UNAVAILABLE');
		expect(e1.status).toBe(409);
		expect(e1.message).toContain('emoji \u{1FAE8} of the apple pack');
		expect(e1.message).toContain('Title Reveal');
		expect(e1.detail).toMatchObject({ assets: [{ kind: 'emoji', code: 'DOWNLOAD_NOT_FOUND', clipIds: [missingEmoji.clipId] }] });

		def.requiredAssets = () => ({ fonts: [{ family: 'SF Pro', weight: 400, style: 'normal' }] });
		const unknown = build('x');
		const e2 = await planError(unknown.doc, unknown.seqId);
		expect(e2.message).toContain('font "SF Pro" 400');
		expect(e2.message).toContain('neither bundled nor in the remote-asset manifest');

		def.requiredAssets = () => ({ fonts: [], emoji: { pack: 'twemoji', graphemes: [GRIN] } });
		const e3 = await planError(unknown.doc, unknown.seqId);
		expect(e3.message).toContain('the pack is not in the remote-asset manifest');

		def.requiredAssets = () => ({ fonts: [], emoji: { pack: 'apple', graphemes: ['\u{1F680}'] } });
		await coreServices(app).remoteAssets.putSettings({ platformAssets: false });
		const e4 = await planError(unknown.doc, unknown.seqId);
		expect(e4.message).toContain('Privacy & Network');
		expect(e4.detail).toMatchObject({ assets: [{ code: 'REMOTE_ASSETS_OFF' }] });
		await coreServices(app).remoteAssets.putSettings({ platformAssets: true });
		await expect(plan(unknown.doc, unknown.seqId)).resolves.toBeTruthy();
	});

	it('the bake key covers the template font files and the emoji pack id + version', async () => {
		def.requiredAssets = (p: Record<string, unknown>) => ({
			fonts: [{ family: 'Chirp', weight: 700, style: 'normal' }],
			emoji: { pack: 'apple', graphemes: emojiGraphemes(String(p.title ?? '')) },
		});
		const svc = app.jasper.services.layerBake as LayerBakeService;
		const b = build(`Hey ${GRIN}`);
		const keyOf = async () => {
			const p = await plan(b.doc, b.seqId);
			const bake = await svc.planBake(p, clipOf(p.snapshot, b.clipId), { env: ENV });
			return { key: bake.key, material: bake.material, doc: bake.doc };
		};
		const k0 = await keyOf();
		expect(k0.material.fonts).toEqual([
			{ family: 'Chirp', weight: 700, style: 'normal', fileSha256: sha256(FONT_BYTES) },
		]);
		expect(k0.material.emoji).toEqual([
			{ pack: 'apple', version: '1', files: [{ key: '1f600', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }] },
		]);
		// the bake document carries signed URLs of the clip's font and emoji
		expect(k0.doc.fonts[0]!.url).toMatch(/\/fonts\/remote\/.*\?sig=/);
		expect(k0.doc.emoji?.[`apple:${GRIN}`]).toMatch(/\/fonts\/emoji\/apple\/1\/1f600\.png\?sig=/);
		expect((await keyOf()).key).toBe(k0.key);
		// a new pack version (override manifest) gives a new key
		writeOverride(app.appdir, fixtureManifest(server.url, { version: '2' }));
		const k1 = await keyOf();
		expect(k1.material.emoji?.[0]?.version).toBe('2');
		expect(k1.key).not.toBe(k0.key);
		writeOverride(app.appdir, fixtureManifest(server.url));
	});
});
