// social-comment §7.8: remote fonts / emoji — manifest loading, downloads against a local fixture server (hash checks,
// override manifest, network policy, offline, timeouts, size caps, retries, concurrent dedup, per-host limit), the emoji
// pin index and the first-fetch notice.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMOJI_PACK_IDS } from '@jasper/mg-templates';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkImage, RemoteAssetError } from '../src/remote-assets/fetcher.ts';
import { loadManifest, mergeManifests, parseOverride, shippedManifest } from '../src/remote-assets/manifest.ts';
import { RemoteManifestSchema } from '../src/remote-assets/schema.ts';
import { RemoteAssetService } from '../src/remote-assets/service.ts';
import shipped from '../src/remote-assets/manifest.json' with { type: 'json' };
import { FixtureServer, FONT_BYTES, fixtureManifest, pngBytes, sha256 } from './remote-assets-fixture.ts';
import { tempAppdir } from './temp.ts';

const GRIN = '\u{1F600}';
const HEART = '❤️';
const RED = pngBytes(4, 4, [255, 0, 0, 255]);
const BLUE = pngBytes(4, 4, [0, 0, 255, 255]);

const EMPTY = { version: 1 as const, fonts: [], emojiPacks: [] };
const fast = { timeoutMs: 400, retries: 1, backoffMs: 10 };

let server: FixtureServer;
let dir: string;

function service(o: Partial<ConstructorParameters<typeof RemoteAssetService>[0]> = {}) {
	return new RemoteAssetService({
		dir: join(dir, 'assets', 'remote'),
		overridePath: join(dir, 'assets', 'remote-manifest.override.json'),
		settingsPath: join(dir, 'engine', 'network.json'),
		manifest: RemoteManifestSchema.parse(fixtureManifest(server.url)),
		fontLimits: fast,
		emojiLimits: fast,
		...o,
	});
}

async function rejects(p: Promise<unknown>): Promise<RemoteAssetError> {
	try {
		await p;
	} catch (e) {
		expect(e).toBeInstanceOf(RemoteAssetError);
		return e as RemoteAssetError;
	}
	throw new Error('expected a rejection');
}

beforeEach(async () => {
	server = await new FixtureServer().start();
	dir = tempAppdir('jasper-remote-assets-');
	server.routes.set('/fonts/chirp-700.woff2', { body: FONT_BYTES, contentType: 'font/woff2' });
	server.routes.set('/emoji/1f600.png', { body: RED, contentType: 'image/png' });
	server.routes.set('/emoji/2764.png', { body: BLUE, contentType: 'image/png' });
});
afterEach(async () => {
	await server.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('manifest', () => {
	it('ships a valid manifest (entries are filled by the platform-glyphs work package)', () => {
		expect(RemoteManifestSchema.safeParse(shipped).success).toBe(true);
		expect(shippedManifest().version).toBe(1);
	});

	it('merges the appdir override by id and reports an invalid override without failing', () => {
		const base = RemoteManifestSchema.parse(fixtureManifest('https://cdn.example'));
		const path = join(dir, 'override.json');
		expect(loadManifest(base, path).override.status).toBe('absent');
		const moved = { ...base.fonts[0]!, url: 'https://mirror.example/chirp.woff2' };
		const extra = { ...base.fonts[0]!, id: 'chirp-400', weight: 400 };
		writeFileSync(path, JSON.stringify({ version: 1, fonts: [moved, extra], emojiPacks: [] }));
		const r = loadManifest(base, path);
		expect(r.override.status).toBe('loaded');
		expect(r.manifest.fonts.map((f) => [f.id, f.url])).toEqual([
			['chirp-700', 'https://mirror.example/chirp.woff2'],
			['chirp-400', base.fonts[0]!.url],
		]);
		expect(r.manifest.emojiPacks).toEqual(base.emojiPacks);
		writeFileSync(path, '{"version":1,"fonts":[{"id":"Bad Id"}],"emojiPacks":[]}');
		const bad = loadManifest(base, path);
		expect(bad.override.status).toBe('invalid');
		expect(bad.override.message).toMatch(/fonts\.0/);
		expect(bad.manifest).toEqual(base);
		writeFileSync(path, 'not json');
		expect(loadManifest(base, path).override).toMatchObject({ status: 'invalid' });
	});

	it('refuses duplicate ids, non-http URLs, templates without placeholders and unpinned fonts', () => {
		const m = fixtureManifest('https://cdn.example');
		const bad = (patch: (x: typeof m) => unknown) =>
			RemoteManifestSchema.safeParse(patch(structuredClone(m))).success;
		expect(bad((x) => x)).toBe(true);
		expect(bad((x) => ({ ...x, fonts: [...x.fonts, x.fonts[0]] }))).toBe(false);
		expect(bad((x) => ({ ...x, fonts: [{ ...x.fonts[0], url: 'file:///etc/passwd' }] }))).toBe(false);
		expect(bad((x) => ({ ...x, fonts: [{ ...x.fonts[0], url: 'https://u:p@cdn.example/a' }] }))).toBe(false);
		expect(bad((x) => ({ ...x, fonts: [{ ...x.fonts[0], sha256: 'abc' }] }))).toBe(false);
		expect(bad((x) => ({ ...x, emojiPacks: [{ ...x.emojiPacks[0], urlTemplate: 'https://cdn/x.png' }] }))).toBe(
			false,
		);
		expect(
			bad((x) => ({ ...x, emojiPacks: [{ ...x.emojiPacks[0], urlTemplate: 'https://cdn/{name}.png' }] })),
		).toBe(false);
		expect(bad((x) => ({ ...x, emojiPacks: [{ ...x.emojiPacks[0], pixelSize: null }] }))).toBe(false);
		expect(bad((x) => ({ ...x, emojiPacks: [{ ...x.emojiPacks[0], id: 'other' }] }))).toBe(false);
		expect(bad((x) => ({ ...x, version: 2 }))).toBe(false);
	});

	it('parseOverride never throws and only accepts schema-valid manifests (fuzz)', () => {
		const font = fc.record({
			id: fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,10}$/),
			family: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
			weight: fc.integer({ min: 1, max: 1000 }),
			style: fc.constantFrom('normal', 'italic'),
			format: fc.constantFrom('woff2', 'woff', 'ttf', 'otf'),
			url: fc.webUrl({ withQueryParameters: true }),
			sha256: fc.stringMatching(/^[0-9a-f]{64}$/),
			licence: fc.string({ minLength: 1, maxLength: 30 }),
			source: fc.string({ minLength: 1, maxLength: 30 }),
		});
		const pack = fc.record({
			id: fc.constantFrom(...EMOJI_PACK_IDS),
			name: fc.string({ minLength: 1, maxLength: 20 }),
			version: fc.stringMatching(/^[A-Za-z0-9._-]{1,8}$/),
			urlTemplate: fc.constantFrom('https://cdn.example/{cp}.png', 'http://127.0.0.1:9/e/{cp}.png'),
			fe0f: fc.constantFrom('keep', 'strip', 'try-both'),
			format: fc.constant('png'),
			pixelSize: fc.integer({ min: 1, max: 512 }),
			licence: fc.string({ minLength: 1, maxLength: 20 }),
			attribution: fc.option(fc.string({ maxLength: 20 }), { nil: null }),
		});
		const manifest = fc.record({
			version: fc.constant(1),
			fonts: fc.uniqueArray(font, { selector: (f) => f.id, maxLength: 4 }),
			emojiPacks: fc.uniqueArray(pack, { selector: (p) => p.id, maxLength: 3 }),
		});
		fc.assert(
			fc.property(fc.oneof(manifest.map((m) => JSON.stringify(m)), fc.json(), fc.string()), (text) => {
				const r = parseOverride(text);
				if ('manifest' in r) {
					expect(RemoteManifestSchema.safeParse(r.manifest).success).toBe(true);
					// merging is idempotent and keeps every override entry
					const merged = mergeManifests(EMPTY, r.manifest);
					expect(mergeManifests(merged, r.manifest)).toEqual(merged);
					expect(merged.fonts.map((f) => f.id).sort()).toEqual(r.manifest.fonts.map((f) => f.id).sort());
				} else expect(typeof r.error).toBe('string');
			}),
			{ numRuns: 300 },
		);
		// every generated valid manifest parses
		fc.assert(
			fc.property(manifest, (m) => {
				expect('manifest' in parseOverride(JSON.stringify(m))).toBe(true);
			}),
			{ numRuns: 200 },
		);
	});
});

describe('fonts', () => {
	it('downloads on first need, verifies the pinned hash, writes atomically and reuses the cache', async () => {
		const s = service();
		const path = await s.ensureFace({ family: 'chirp', weight: 700, style: 'normal' });
		expect(readFileSync(path).equals(FONT_BYTES)).toBe(true);
		expect(readdirSync(join(dir, 'assets', 'remote', 'fonts')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
		await s.ensureFace({ family: 'Chirp', weight: 700, style: 'normal' });
		// a new process verifies the cached file instead of downloading
		await service().ensureFace({ family: 'Chirp', weight: 700, style: 'normal' });
		expect(server.hits.get('/fonts/chirp-700.woff2')).toBe(1);
		expect(s.fontUrl({ family: 'Chirp', weight: 700, style: 'normal' })).toBe(
			`/fonts/remote/chirp-700-${sha256(FONT_BYTES).slice(0, 16)}.woff2`,
		);
		expect(s.fontUrl({ family: 'Chirp', weight: 400, style: 'normal' })).toBeNull();
		expect(s.cachedFontPath(`chirp-700-${sha256(FONT_BYTES).slice(0, 16)}.woff2`)).toBe(path);
	});

	it('refuses a download whose hash differs from the pin and caches nothing', async () => {
		server.routes.set('/fonts/chirp-700.woff2', { body: Buffer.concat([FONT_BYTES, Buffer.from('x')]) });
		const s = service();
		const e = await rejects(s.ensureFace({ family: 'Chirp', weight: 700, style: 'normal' }));
		expect(e.code).toBe('ASSET_HASH_MISMATCH');
		expect(e.retryable).toBe(false);
		expect(existsSync(join(dir, 'assets', 'remote', 'fonts'))).toBe(false);
	});

	it('detects a damaged cached file', async () => {
		const s = service();
		const path = await s.ensureFace({ family: 'Chirp', weight: 700, style: 'normal' });
		writeFileSync(path, 'garbage');
		const e = await rejects(service().ensureFace({ family: 'Chirp', weight: 700, style: 'normal' }));
		expect(e.code).toBe('ASSET_HASH_MISMATCH');
	});

	it('refuses HTML error pages served with 200', async () => {
		const html = '<!doctype html><title>Moved</title>';
		const m = fixtureManifest(server.url);
		m.fonts[0]!.sha256 = sha256(html);
		server.routes.set('/fonts/chirp-700.woff2', { body: html, contentType: 'text/html' });
		const e = await rejects(
			service({ manifest: RemoteManifestSchema.parse(m) }).ensureFace({
				family: 'Chirp',
				weight: 700,
				style: 'normal',
			}),
		);
		expect(e.code).toBe('ASSET_BAD_CONTENT');
	});

	it('names an unknown face', async () => {
		const e = await rejects(service().ensureFace({ family: 'SF Pro', weight: 400, style: 'normal' }));
		expect(e.code).toBe('REMOTE_ASSET_UNKNOWN');
		expect(e.message).toContain('SF Pro');
	});
});

describe('network policy', () => {
	it('downloads nothing when off, but still serves what is cached', async () => {
		const s = service();
		await s.putSettings({ platformAssets: false });
		const e = await rejects(s.ensureFace({ family: 'Chirp', weight: 700, style: 'normal' }));
		expect(e.code).toBe('REMOTE_ASSETS_OFF');
		expect(e.message).toContain('Privacy & Network');
		expect(server.hits.size).toBe(0);
		await s.putSettings({ platformAssets: true });
		await s.ensureFace({ family: 'Chirp', weight: 700, style: 'normal' });
		await s.putSettings({ platformAssets: false });
		await expect(s.ensureFace({ family: 'Chirp', weight: 700, style: 'normal' })).resolves.toBeTruthy();
		expect(server.hits.get('/fonts/chirp-700.woff2')).toBe(1);
	});

	it('defaults to on, persists the setting and survives a corrupt file', async () => {
		expect(await service().settings.get()).toEqual({ platformAssets: true });
		await service().putSettings({ platformAssets: false });
		expect(await service().settings.get()).toEqual({ platformAssets: false });
		writeFileSync(join(dir, 'engine', 'network.json'), '{broken');
		expect(await service().settings.get()).toEqual({ platformAssets: true });
	});
});

describe('download failures', () => {
	it('offline: an unreachable host is a retryable DOWNLOAD_FAILED', async () => {
		await server.close();
		const e = await rejects(service().ensureFace({ family: 'Chirp', weight: 700, style: 'normal' }));
		expect(e.code).toBe('DOWNLOAD_FAILED');
		expect(e.retryable).toBe(true);
	});

	it('times out a host that never answers', async () => {
		server.routes.set('/fonts/chirp-700.woff2', { hang: true });
		const e = await rejects(
			service({ fontLimits: { timeoutMs: 150, retries: 0 } }).ensureFace({
				family: 'Chirp',
				weight: 700,
				style: 'normal',
			}),
		);
		expect(e.code).toBe('DOWNLOAD_TIMEOUT');
	});

	it('caps sizes (declared and streamed)', async () => {
		const small = { maxBytes: 1000 };
		const e = await rejects(
			service({ fontLimits: { ...fast, ...small } }).ensureFace({ family: 'Chirp', weight: 700, style: 'normal' }),
		);
		expect(e.code).toBe('DOWNLOAD_TOO_LARGE');
		server.routes.set('/emoji/1f600.png', { body: RED, declaredLength: 10_000_000 });
		const e2 = await rejects(service().ensureEmojiImage('apple', GRIN));
		expect(e2.code).toBe('DOWNLOAD_TOO_LARGE');
	});

	it('retries 5xx a bounded number of times', async () => {
		server.routes.set('/fonts/chirp-700.woff2', { body: FONT_BYTES, failTimes: 1 });
		await service().ensureFace({ family: 'Chirp', weight: 700, style: 'normal' });
		expect(server.hits.get('/fonts/chirp-700.woff2')).toBe(2);
		server.routes.set('/emoji/1f600.png', { body: RED, failTimes: 5 });
		const e = await rejects(service().ensureEmojiImage('apple', GRIN));
		expect(e.code).toBe('DOWNLOAD_FAILED');
		expect(server.hits.get('/emoji/1f600.png')).toBe(2); // 1 + retries (1)
	});

	it('shares one download between concurrent requests and limits downloads per host', async () => {
		server.routes.set('/fonts/chirp-700.woff2', { body: FONT_BYTES, delayMs: 50 });
		const s = service({ perHost: 2 });
		const faces = Array.from({ length: 10 }, () => s.ensureFace({ family: 'Chirp', weight: 700, style: 'normal' }));
		const paths = await Promise.all(faces);
		expect(new Set(paths).size).toBe(1);
		expect(server.hits.get('/fonts/chirp-700.woff2')).toBe(1);
		const many = Array.from({ length: 8 }, (_, i) => String.fromCodePoint(0x1f601 + i));
		for (const g of many)
			server.routes.set(`/emoji/${g.codePointAt(0)!.toString(16)}.png`, { body: RED, delayMs: 40 });
		server.maxActive = 0;
		await Promise.all(many.map((g) => s.ensureEmojiImage('apple', g)));
		expect(server.maxActive).toBeLessThanOrEqual(2);
		expect(server.maxActive).toBeGreaterThan(0);
	});
});

describe('emoji', () => {
	it('maps graphemes to pack URLs, tries both FE0F spellings and pins the first verified fetch', async () => {
		const s = service();
		expect(RemoteAssetService.emojiSourceUrls(s.pack('apple')!, HEART)).toEqual([
			`${server.url}/emoji/2764-fe0f.png`,
			`${server.url}/emoji/2764.png`,
		]);
		const path = await s.ensureEmojiImage('apple', HEART);
		expect(readFileSync(path).equals(BLUE)).toBe(true);
		expect(server.hits.get('/emoji/2764-fe0f.png')).toBe(1);
		expect(await s.emojiHash('apple', HEART)).toBe(sha256(BLUE));
		const index = JSON.parse(readFileSync(join(dir, 'assets', 'remote', 'emoji', 'apple', '1', 'index.json'), 'utf8'));
		expect(index.entries['2764-fe0f']).toMatchObject({ sha256: sha256(BLUE), url: `${server.url}/emoji/2764.png` });
		expect(s.emojiUrl('apple', HEART)).toBe('/fonts/emoji/apple/1/2764-fe0f.png');
		expect(s.emojiUrl('apple', 'a')).toBeNull();
		expect(s.emojiUrl('noto', GRIN)).toBeNull();
	});

	it('refuses an image that changed upstream after it was pinned', async () => {
		const s = service();
		const path = await s.ensureEmojiImage('apple', GRIN);
		rmSync(path);
		server.routes.set('/emoji/1f600.png', { body: BLUE, contentType: 'image/png' });
		const e = await rejects(service().ensureEmojiImage('apple', GRIN));
		expect(e.code).toBe('ASSET_HASH_MISMATCH');
		expect(e.message).toContain('version');
	});

	it('reports a grapheme the pack does not have', async () => {
		const e = await rejects(service().ensureEmojiImage('apple', '\u{1FAE8}'));
		expect(e.code).toBe('DOWNLOAD_NOT_FOUND');
		expect(e.message).toContain('Apple');
	});

	it('checks content: PNG magic, HTML pages, active SVG', () => {
		const f = (bytes: Buffer | string, contentType = '') => ({
			bytes: Buffer.from(bytes),
			contentType,
			url: 'x',
		});
		expect(() => checkImage(f(RED, 'image/png'), 'png')).not.toThrow();
		expect(() => checkImage(f(RED, 'text/html'), 'png')).toThrow(/HTML/);
		expect(() => checkImage(f('GIF89a'), 'png')).toThrow(/magic/);
		expect(() => checkImage(f('<?xml version="1.0"?><svg viewBox="0 0 1 1"/>'), 'svg')).not.toThrow();
		expect(() => checkImage(f('<svg><use xlink:href="#a"/></svg>'), 'svg')).not.toThrow();
		expect(() => checkImage(f('<svg><script>alert(1)</script></svg>'), 'svg')).toThrow(/scripts/);
		expect(() => checkImage(f('<svg onload="x()"></svg>'), 'svg')).toThrow(/scripts/);
		expect(() => checkImage(f('<svg><image href="https://x/y.png"/></svg>'), 'svg')).toThrow();
		expect(() => checkImage(f('<html><svg/></html>'), 'svg')).toThrow();
	});

	it('serves only canonical keys of the current pack version', async () => {
		const s = service();
		await expect(s.ensureEmojiFile('apple', '1', '1f600.png')).resolves.toMatchObject({ contentType: 'image/png' });
		for (const [pack, version, file] of [
			['apple', '2', '1f600.png'],
			['apple', '1', '1F600.png'],
			['apple', '1', '41.png'],
			['apple', '1', '1f600.svg'],
			['apple', '1', '../../x.png'],
			['noto', '1', '1f600.png'],
		] as const)
			expect((await rejects(s.ensureEmojiFile(pack, version, file))).code).toBe('REMOTE_ASSET_UNKNOWN');
	});

	it('uses a {name} map when the pack needs one', () => {
		const m = fixtureManifest('https://em.example');
		const p = RemoteManifestSchema.parse({
			...m,
			emojiPacks: [
				{
					...m.emojiPacks[0],
					urlTemplate: 'https://em.example/apple/{name}_{cp}.png',
					names: { '1f600': 'grinning-face' },
					fe0f: 'strip',
				},
			],
		}).emojiPacks[0]!;
		expect(RemoteAssetService.emojiSourceUrls(p, GRIN)).toEqual(['https://em.example/apple/grinning-face_1f600.png']);
		expect(RemoteAssetService.emojiSourceUrls(p, HEART)).toEqual([]);
	});
});

describe('override manifest, prefetch and notice', () => {
	it('picks up the appdir override when it changes (a moved file is fixed without a release)', async () => {
		const s = service({ manifest: RemoteManifestSchema.parse(fixtureManifest('http://127.0.0.1:9')) });
		const e = await rejects(s.ensureFace({ family: 'Chirp', weight: 700, style: 'normal' }));
		expect(e.code).toBe('DOWNLOAD_FAILED');
		mkdirSync(join(dir, 'assets'), { recursive: true });
		writeFileSync(join(dir, 'assets', 'remote-manifest.override.json'), JSON.stringify(fixtureManifest(server.url)));
		await expect(s.ensureFace({ family: 'Chirp', weight: 700, style: 'normal' })).resolves.toBeTruthy();
		expect((await s.status()).manifest.override.status).toBe('loaded');
	});

	it('prefetch reports what is missing with why, and the first fetch raises a one-time notice', async () => {
		const events: unknown[] = [];
		const s = service({ onChanged: (e) => events.push(e) });
		expect((await s.status()).notice).toEqual({ pending: false, firstFetchAt: null, items: [] });
		const r = await s.prefetch({
			fonts: [
				{ family: 'Chirp', weight: 700, style: 'normal' },
				{ family: 'Inter', weight: 400, style: 'normal' },
				{ family: 'Nope', weight: 400, style: 'normal' },
			],
			emoji: [{ pack: 'apple', graphemes: [GRIN, GRIN, '\u{1FAE8}'] }],
		}, (f) => f.family === 'Inter');
		expect(r.available).toBe(3);
		expect(r.missing.map((m) => [m.kind, m.error.code])).toEqual([
			['font', 'REMOTE_ASSET_UNKNOWN'],
			['emoji', 'DOWNLOAD_NOT_FOUND'],
		]);
		await s.flush();
		const st = await s.status();
		expect(st.notice.pending).toBe(true);
		expect(st.notice.items.map((i) => [i.kind, i.label, i.host])).toEqual([
			['font', 'Chirp 700', server.host],
			['emoji', `${GRIN} (Apple)`, server.host],
		]);
		expect(st.fonts[0]).toMatchObject({ family: 'Chirp', cached: true });
		expect(st.emojiPacks[0]).toMatchObject({ id: 'apple', cached: 1 });
		expect(events).toContainEqual(expect.objectContaining({ reason: 'fetched', notice: true }));
		const acked = await s.acknowledgeNotice();
		expect(acked.notice.pending).toBe(false);
		await s.ensureEmojiImage('apple', HEART);
		await s.flush();
		expect((await service().status()).notice.pending).toBe(false);
	});
});
