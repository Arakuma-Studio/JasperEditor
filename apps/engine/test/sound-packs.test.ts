// Downloadable sound packs end to end (spec 12 P6-R1; wp-note "Phase 6 → WP6.1 sound packs"): the built-in catalogue's
// rules, the `sound-pack-install` job from a `JASPER_SOUND_CATALOG` with file:// URLs and a local HTTP server (sha256
// mismatches, zip-slip, size caps, cancel, partial-download cleanup and resume, stalls), the index picking the pack up
// with its provenance, the approval gate for agents removing a pack, and a project that uses a pack sound opening and
// exporting after the pack is gone. Generated WAVs and archives only; never the network.
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import {
	AGENT_NAME_HEADER,
	type EngineJob,
	type LicensesResponse,
	RegisterSoundResponseSchema,
	SOUND_PACK_LICENSES,
	type SoundEntry,
	SoundPackInstallResultSchema,
	SoundPackRemoveResponseSchema,
	SoundPacksResponseSchema,
	SoundSearchResponseSchema,
} from '@jasper/api';
import { encodeWav } from '@jasper/audio-dsp';
import { appdirPaths } from '@jasper/config';
import {
	createCounterIdSource,
	createEmptyProject,
	isSoundTypeId,
	makeEnvelope,
	SOUND_TYPE_IDS,
} from '@jasper/project';
import fc from 'fast-check';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { renderMixdown, WAV_F32_HEADER_BYTES } from '../src/audio/mixdown.ts';
import { audioWorld } from '../src/sound-design/bed.ts';
import builtin from '../src/sounds/packs.json' with { type: 'json' };
import { filesDigest, parsePackCatalog, partialName, SoundPackStore, safeJoin } from '../src/sounds/packs.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, DocBuilder, H, JSON_H, makeApp, tempAppdir } from './helpers.ts';
import { makeStarter, SR, samples } from './sound-fixtures.ts';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const wav = (shape: 'hit' | 'whoosh' | 'click' | 'tone', sec: number, seed: number) =>
	Buffer.from(encodeWav(samples(shape, sec, seed), SR, 's16'));

/** A ZIP archive (deflated or stored entries, UTF-8 names) — any names, including hostile ones. */
function makeZip(entries: { name: string; data: Buffer; stored?: boolean }[]): Buffer {
	const locals: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const e of entries) {
		const name = Buffer.from(e.name, 'utf8');
		const body = e.stored ? e.data : deflateRawSync(e.data);
		const method = e.stored ? 0 : 8;
		const loc = Buffer.alloc(30);
		loc.writeUInt32LE(0x04034b50, 0);
		loc.writeUInt16LE(20, 4);
		loc.writeUInt16LE(0x0800, 6);
		loc.writeUInt16LE(method, 8);
		loc.writeUInt32LE(0, 14); // crc (not checked by the reader; the catalogue's sha256 is)
		loc.writeUInt32LE(body.length, 18);
		loc.writeUInt32LE(e.data.length, 22);
		loc.writeUInt16LE(name.length, 26);
		locals.push(loc, name, body);
		const cen = Buffer.alloc(46);
		cen.writeUInt32LE(0x02014b50, 0);
		cen.writeUInt16LE(20, 4);
		cen.writeUInt16LE(20, 6);
		cen.writeUInt16LE(0x0800, 8);
		cen.writeUInt16LE(method, 10);
		cen.writeUInt32LE(body.length, 20);
		cen.writeUInt32LE(e.data.length, 24);
		cen.writeUInt16LE(name.length, 28);
		cen.writeUInt32LE(offset, 42);
		central.push(cen, name);
		offset += 30 + name.length + body.length;
	}
	const cd = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(cd.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, cd, end]);
}

type Fixture = {
	dir: string;
	zip: Buffer;
	zipPath: string;
	files: { path: string; data: Buffer; title: string; types: string[] }[];
	license: Buffer;
};

/** A Kenney-like pack: three listed sounds, an unlisted one, a licence file and a hostile entry that is never listed. */
function makePackFixture(): Fixture {
	const dir = tempAppdir('jasper-pack-src-');
	const files = [
		{ path: 'Audio/impact_heavy_000.wav', data: wav('hit', 0.6, 11), title: 'Heavy impact', types: ['hit'] },
		{
			path: 'Audio/whoosh_fast_000.wav',
			data: wav('whoosh', 0.8, 12),
			title: 'Fast whoosh',
			types: ['whoosh'],
		},
		{ path: 'Audio/Hit jingles/jingle_HIT00.wav', data: wav('tone', 0.5, 13), title: 'Jingle', types: [] },
	];
	const license = Buffer.from(
		'Test Pack\nLicense: (Creative Commons Zero, CC0)\nhttp://creativecommons.org/publicdomain/zero/1.0/\n',
	);
	const zip = makeZip([
		...files.map((f) => ({ name: f.path, data: f.data })),
		{ name: 'Audio/unlisted_000.wav', data: wav('click', 0.1, 14) },
		{ name: '../escape.wav', data: wav('click', 0.1, 15) },
		{ name: 'License.txt', data: license, stored: true },
	]);
	const zipPath = join(dir, 'test-pack.zip');
	writeFileSync(zipPath, zip);
	return { dir, zip, zipPath, files, license };
}

function packEntry(f: Fixture, over: Record<string, unknown> = {}) {
	return {
		id: 'test-pack',
		title: 'Test Pack',
		author: 'Test Author',
		description: 'Three generated sounds.',
		license: 'CC0-1.0',
		licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
		licenseEvidence: [
			{ url: 'https://example.invalid/test-pack', statement: 'License: CC0', checkedAt: '2026-10-17' },
		],
		attribution: null,
		pageUrl: 'https://example.invalid/test-pack',
		download: {
			type: 'zip',
			url: pathToFileURL(f.zipPath).href,
			sha256: sha(f.zip),
			sizeBytes: f.zip.length,
		},
		licenseFile: { path: 'License.txt', sha256: sha(f.license), sizeBytes: f.license.length },
		files: f.files.map((x) => ({
			path: x.path,
			sha256: sha(x.data),
			sizeBytes: x.data.length,
			title: x.title,
			types: x.types,
			tags: ['test'],
			...(x.types.length ? {} : { inferTypes: false }),
		})),
		...over,
	};
}

function writeCatalog(packs: unknown[]): string {
	const file = join(tempAppdir('jasper-pack-cat-'), 'catalog.json');
	writeFileSync(file, JSON.stringify({ version: 1, packs }));
	process.env.JASPER_SOUND_CATALOG = file;
	return file;
}

const ENV_KEYS = [
	'JASPER_SOUND_STARTER_DIR',
	'JASPER_SOUND_SYNTH_VARIANTS',
	'JASPER_SOUND_AUTO_INDEX',
	'JASPER_SOUND_CATALOG',
	'JASPER_SOUND_PACK_STALL_MS',
	'JASPER_SOUND_PACK_FILE_INTERVAL_MS',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => {
	process.env.JASPER_SOUND_STARTER_DIR = makeStarter(tempAppdir('jasper-pack-starter-'));
	process.env.JASPER_SOUND_SYNTH_VARIANTS = '0';
	process.env.JASPER_SOUND_AUTO_INDEX = '0';
	delete process.env.JASPER_SOUND_PACK_STALL_MS;
	delete process.env.JASPER_SOUND_PACK_FILE_INTERVAL_MS;
});
afterEach(async () => {
	await closeApps();
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

async function packs(app: FastifyInstance, headers: Record<string, string> = H) {
	const r = await app.inject({ method: 'GET', url: '/api/sounds/packs', headers });
	expect(r.statusCode, r.body).toBe(200);
	return SoundPacksResponseSchema.parse(r.json());
}

async function install(app: FastifyInstance, id = 'test-pack', headers: Record<string, string> = JSON_H) {
	const r = await app.inject({
		method: 'POST',
		url: `/api/sounds/packs/${id}/install`,
		headers,
		payload: {},
	});
	expect(r.statusCode, r.body).toBe(202);
	return r.json() as EngineJob;
}

const wait = (app: FastifyInstance, id: string) => coreServices(app).queue.wait(id);

async function installed(app: FastifyInstance) {
	const job = await wait(app, (await install(app)).id);
	expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
	const result = SoundPackInstallResultSchema.parse(job.result);
	if (result.indexJobId) expect((await wait(app, result.indexJobId)).state).toBe('succeeded');
	return result;
}

/** Everything under the packs folder (relative paths), to prove nothing is left behind or written outside. */
function tree(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	const walk = (d: string, rel: string) => {
		for (const n of readdirSync(d)) {
			const p = join(d, n);
			if (statSync(p).isDirectory()) walk(p, `${rel}${n}/`);
			else out.push(`${rel}${n}`);
		}
	};
	walk(dir, '');
	return out.sort();
}

describe('the built-in catalogue (apps/engine/src/sounds/packs.json)', () => {
	const cat = parsePackCatalog(builtin, { builtin: true, base: null });

	it('validates entirely: allowlisted licences with evidence, https upstream URLs, pinned sha256 and sizes', () => {
		expect(cat.errors).toEqual([]);
		for (const e of cat.entries) {
			expect(SOUND_PACK_LICENSES).toContain(e.license);
			expect(e.license).not.toMatch(/WTFPL/i);
			expect(e.licenseEvidence.length).toBeGreaterThanOrEqual(1);
			for (const ev of e.licenseEvidence) expect(ev.url).toMatch(/^https:\/\//);
			if (e.license === 'CC0-1.0') expect(e.attribution).toBeNull();
			else expect(e.attribution).toBeTruthy();
			if (e.download.type === 'zip') {
				expect(e.download.url).toMatch(/^https:\/\//);
				expect(e.download.sha256).toMatch(/^[0-9a-f]{64}$/);
				expect(e.download.sizeBytes).toBeGreaterThan(1000);
			}
			const paths = new Set<string>();
			for (const f of e.files) {
				expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
				expect(f.sizeBytes).toBeGreaterThan(0);
				// a `files` pack downloads every file from its own https URL; a zip pack extracts them
				if (e.download.type === 'files') expect(f.url).toMatch(/^https:\/\//);
				else expect(f.url).toBeUndefined();
				expect(paths.has(f.path)).toBe(false);
				paths.add(f.path);
				// types are taxonomy ids; untyped files never let the file name guess one
				for (const t of f.types) expect(isSoundTypeId(t), `${e.id}/${f.path}: ${t}`).toBe(true);
				if (!f.types.length) expect(f.inferTypes).toBe(false);
			}
			// two files with the same bytes would be one sound: the curation lists each once
			expect(new Set(e.files.map((f) => f.sha256)).size).toBe(e.files.length);
		}
	});

	it('ties Kenney pack downloads to their CC0 provenance', () => {
		const kenney = cat.entries.filter((e) => e.id.startsWith('kenney-'));
		for (const e of kenney) {
			expect(e.license).toBe('CC0-1.0');
			expect(e.pageUrl).toBe(`https://kenney.nl/assets/${e.id.slice('kenney-'.length)}`);
			expect(e.licenseEvidence.map((x) => x.statement).join(' ')).toContain('CC0');
			expect(e.licenseEvidence[0]!.url).toBe(e.pageUrl);
			expect(e.licenseFile?.path).toBe('License.txt');
			if (e.download.type === 'zip')
				expect(e.download.url.startsWith('https://kenney.nl/media/pages/assets/')).toBe(true);
		}
	});

	it('the BigSoundBank packs: each file CC0 by its own page, by Joseph Sardin, from bigsoundbank.com/UPLOAD/', () => {
		const bsb = cat.entries.filter((e) => e.id.startsWith('bigsoundbank-'));
		const all = bsb.flatMap((e) => e.files);
		for (const e of bsb) {
			// the CC0 grant (BigSoundBank also offers WTFPL, which is not on the allowlist); no credit required
			expect(e.license).toBe('CC0-1.0');
			expect(e.licenseUrl).toBe('https://creativecommons.org/publicdomain/zero/1.0/');
			expect(e.attribution).toBeNull();
			expect(e.download).toEqual({ type: 'files' });
			expect(e.pageUrl).toBe('https://bigsoundbank.com/');
			expect(e.author).toBe('Joseph Sardin (BigSoundBank.com)');
			expect(e.licenseEvidence[0]).toMatchObject({ url: 'https://bigsoundbank.com/licenses.html' });
			expect(e.licenseEvidence[0]!.statement).toContain('Creative Commons CC0 1.0 Universal');
			expect(e.licenseFile).toBeUndefined();
			for (const f of e.files) {
				const n = /^(\d{4})-[a-z0-9-]+\.(flac|wav|ogg)$/.exec(f.path);
				expect(n, f.path).not.toBeNull();
				// the file is the sound's own upstream download, and its page is where its licence was read
				expect(f.url).toBe(
					`https://bigsoundbank.com/UPLOAD/${n![2] === 'wav' ? 'bwf-en' : n![2]}/${n![1]}.${n![2]}`,
				);
				expect(f.sourceUrl).toMatch(new RegExp(`^https://bigsoundbank\\.com/[a-z0-9-]+-s${n![1]}\\.html$`));
				expect(f.licenseEvidence).toEqual({
					url: f.sourceUrl,
					statement: 'License CC0 (public domain): Free and royalty-free',
					checkedAt: e.licenseEvidence[0]!.checkedAt,
				});
				// only Joseph Sardin's own recordings (alone or with a co-recordist), never other contributors'
				expect(f.author).toMatch(/^Joseph Sardin( & Axeline T\.)? \(BigSoundBank\.com\)$/);
				expect(f.types.length, f.path).toBeGreaterThan(0);
			}
		}
		// every sound once across the packs
		expect(new Set(all.map((f) => f.sha256)).size).toBe(all.length);
		expect(new Set(all.map((f) => f.path.slice(0, 4))).size).toBe(all.length);
		// beds are OGG (smaller downloads), effects lossless FLAC or WAV
		const beds = bsb.find((e) => e.id === 'bigsoundbank-ambience-room-tone')!;
		for (const f of beds.files) expect(f.path.endsWith('.ogg'), f.path).toBe(true);
		for (const e of bsb.filter((x) => x !== beds))
			for (const f of e.files) expect(f.path, f.path).toMatch(/\.(flac|wav)$/);
	});

	it('the catalogue as a whole has a recording of every type (BigSoundBank fills the Kenney gaps)', () => {
		const covered = new Set(cat.entries.flatMap((e) => e.files.flatMap((f) => f.types)));
		expect(SOUND_TYPE_IDS.filter((t) => !covered.has(t))).toEqual([]);
	});

	it('refuses hostile entries (zip-slip paths, non-allowlisted licences, http URLs, duplicates) and keeps the rest', () => {
		const f = makePackFixture();
		const ok = packEntry(f);
		const evil = (over: Record<string, unknown>, id: string) => ({ ...packEntry(f, over), id });
		const file = (path: string) => [{ ...ok.files[0]!, path }];
		const r = parsePackCatalog(
			{
				version: 1,
				packs: [
					ok,
					evil({ files: file('../escape.wav') }, 'slip-1'),
					evil({ files: file('/etc/passwd.wav') }, 'slip-2'),
					evil({ files: file('Audio\\..\\x.wav') }, 'slip-3'),
					evil({ files: file('Audio/.hidden.wav') }, 'hidden'),
					evil({ files: file('Audio/readme.txt') }, 'not-audio'),
					evil({ license: 'WTFPL' }, 'wtfpl'),
					evil({ license: 'CC-BY-NC-4.0' }, 'nc'),
					evil({ license: 'CC-BY-4.0' }, 'by-no-credit'),
					evil({ files: [...ok.files, { ...ok.files[0]!, path: ok.files[0]!.path.toUpperCase() }] }, 'dup'),
					evil({ licenseEvidence: [] }, 'no-evidence'),
					ok,
				],
			},
			{ builtin: false, base: f.dir },
		);
		expect(r.entries.map((e) => e.id)).toEqual(['test-pack']);
		expect(r.errors).toHaveLength(11);
		// the built-in catalogue takes https only
		expect(parsePackCatalog({ version: 1, packs: [ok] }, { builtin: true, base: null }).entries).toEqual([]);
		// … including the URL of a file's own licence evidence
		const { licenseFile: _lf, ...zipless } = ok;
		const web = (i: number) => `https://example.invalid/sound/${i}`;
		const filesOk = {
			...zipless,
			id: 'files-https',
			download: { type: 'files' },
			files: ok.files.map((x, i) => ({
				...x,
				url: `${web(i)}.wav`,
				sourceUrl: web(i),
				licenseEvidence: { url: web(i), statement: 'License CC0', checkedAt: '2026-10-17' },
			})),
		};
		const builtinOnly = (e: unknown) =>
			parsePackCatalog({ version: 1, packs: [e] }, { builtin: true, base: null });
		expect(builtinOnly(filesOk).entries.map((e) => e.id)).toEqual(['files-https']);
		const httpEvidence = {
			...filesOk,
			files: filesOk.files.map((x, i) =>
				i === 1
					? { ...x, licenseEvidence: { ...x.licenseEvidence, url: 'http://example.invalid/sound/1' } }
					: x,
			),
		};
		const refused = builtinOnly(httpEvidence);
		expect(refused.entries).toEqual([]);
		expect(refused.errors[0]).toContain('"http://example.invalid/sound/1" is not an https URL');
		// per-file evidence is validated like the pack's (a statement and a YYYY-MM-DD day)
		const badEvidence = {
			...filesOk,
			files: filesOk.files.map((x) => ({
				...x,
				licenseEvidence: { url: x.sourceUrl, statement: '', checkedAt: 'today' },
			})),
		};
		expect(
			parsePackCatalog({ version: 1, packs: [badEvidence] }, { builtin: false, base: f.dir }).entries,
		).toEqual([]);
	});

	it('safeJoin never leaves its folder (property)', () => {
		const base = resolve('/tmp/jasper-pack-base');
		fc.assert(
			fc.property(
				fc.array(fc.oneof(fc.constantFrom('..', '.', '', 'a', 'b.wav', '/', '\\', 'C:', '\0'), fc.string()), {
					maxLength: 6,
				}),
				(parts) => {
					const rel = parts.join('/');
					try {
						const out = safeJoin(base, rel);
						return out.startsWith(`${base}/`);
					} catch (e) {
						return (e as { code?: string }).code === 'PACK_INVALID';
					}
				},
			),
			{ numRuns: 2000 },
		);
	});
});

describe('installing from a file:// catalogue', { timeout: 300_000 }, () => {
	it('lists, installs only the listed files, indexes them with their provenance and shows the licence', async () => {
		const f = makePackFixture();
		writeCatalog([packEntry(f)]);
		const app = await makeApp();
		const before = await packs(app);
		expect(before.catalogErrors).toEqual([]);
		expect(before.packs).toEqual([
			expect.objectContaining({
				id: 'test-pack',
				state: 'available',
				license: 'CC0-1.0',
				sounds: 3,
				downloadBytes: f.zip.length,
				installBytes: f.files.reduce((s, x) => s + x.data.length, 0) + f.license.length,
				inCatalog: true,
				installedAt: null,
				indexedSounds: 0,
				job: null,
			}),
		]);
		const result = await installed(app);
		expect(result).toMatchObject({
			packId: 'test-pack',
			alreadyInstalled: false,
			sounds: 3,
			downloadedBytes: f.zip.length,
		});
		expect(result.indexJobId).toBeTruthy();
		const packsDir = appdirPaths(app.appdir).soundPacksDir;
		// only the listed files and the licence: no unlisted member, no escape, no partial or staging leftovers
		expect(tree(packsDir).filter((p) => !p.startsWith('.'))).toEqual(
			[
				'test-pack/Audio/Hit jingles/jingle_HIT00.wav',
				'test-pack/Audio/impact_heavy_000.wav',
				'test-pack/Audio/whoosh_fast_000.wav',
				'test-pack/License.txt',
				'test-pack/pack.json',
			].sort(),
		);
		expect(tree(join(packsDir, '.downloads'))).toEqual([]);
		expect(tree(join(packsDir, '.staging'))).toEqual([]);
		expect(existsSync(join(packsDir, 'escape.wav'))).toBe(false);
		expect(existsSync(join(packsDir, '..', 'escape.wav'))).toBe(false);
		for (const x of f.files) expect(sha(readFileSync(join(packsDir, 'test-pack', x.path)))).toBe(sha(x.data));

		// indexed: source, licence, author, page as sourceUrl, no credit for CC0; the jingle stays untyped
		const r = await app.inject({
			method: 'GET',
			url: '/api/sounds?sources=pack&license=any&limit=50',
			headers: H,
		});
		const s = SoundSearchResponseSchema.parse(r.json());
		expect(s.total).toBe(3);
		const byTitle = Object.fromEntries(s.results.map((x) => [x.sound.title, x.sound])) as Record<
			string,
			SoundEntry
		>;
		expect(byTitle['Heavy impact']).toMatchObject({
			types: ['hit'],
			source: { type: 'pack', packId: 'test-pack', file: 'Audio/impact_heavy_000.wav' },
			license: 'CC0-1.0',
			licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
			author: 'Test Author',
			sourceUrl: 'https://example.invalid/test-pack',
			attribution: null,
		});
		expect(byTitle.Jingle!.types).toEqual([]);
		// the pack filter of search (Sources › <pack> in the panel)
		const only = await app.inject({
			method: 'GET',
			url: '/api/sounds?packId=test-pack&license=any',
			headers: H,
		});
		expect(SoundSearchResponseSchema.parse(only.json()).total).toBe(3);
		const other = await app.inject({
			method: 'GET',
			url: '/api/sounds?packId=other-pack&license=any',
			headers: H,
		});
		expect(SoundSearchResponseSchema.parse(other.json()).total).toBe(0);

		const after = await packs(app);
		expect(after.packs[0]).toMatchObject({ state: 'installed', indexedSounds: 3, job: null });
		expect(after.packs[0]!.installedAt).toBeTruthy();
		const caps = await app.inject({ method: 'GET', url: '/api/capabilities', headers: H });
		expect(caps.json().features.sound.library.packs).toBe(1);

		// Help ▸ About ▸ Licenses: an entry with the licence text of the archive
		const lic = (
			await app.inject({ method: 'GET', url: '/api/licenses', headers: H })
		).json() as LicensesResponse;
		const entry = lic.components.find((c) => c.id === 'sound-pack:test-pack');
		expect(entry).toMatchObject({
			license: 'CC0-1.0',
			bundled: false,
			sourceUrl: 'https://example.invalid/test-pack',
		});
		expect(entry!.name).toContain('Test Pack');
		expect(entry!.texts[0]!.text).toContain('Creative Commons Zero');

		// installing again: nothing downloaded, no new index pass needed
		const again = await installed(app);
		expect(again).toMatchObject({ alreadyInstalled: true, downloadedBytes: 0, indexJobId: null });
	});

	it('refuses an archive whose sha256 does not match, leaving nothing behind', async () => {
		const f = makePackFixture();
		writeCatalog([
			packEntry(f, {
				download: {
					type: 'zip',
					url: pathToFileURL(f.zipPath).href,
					sha256: 'b'.repeat(64),
					sizeBytes: f.zip.length,
				},
			}),
		]);
		const app = await makeApp();
		const job = await wait(app, (await install(app)).id);
		expect(job.state).toBe('failed');
		expect(job.error?.code).toBe('PACK_CHECKSUM');
		expect(tree(appdirPaths(app.appdir).soundPacksDir).filter((p) => !p.startsWith('.trash'))).toEqual([]);
		expect((await packs(app)).packs[0]!.state).toBe('available');
	});

	it('refuses a member whose bytes or size differ from the catalogue, before anything is installed', async () => {
		const f = makePackFixture();
		const e = packEntry(f);
		const bad = { ...e, files: [e.files[0]!, { ...e.files[1]!, sha256: 'c'.repeat(64) }, e.files[2]!] };
		writeCatalog([bad]);
		const app = await makeApp();
		const job = await wait(app, (await install(app)).id);
		expect(job.error?.code).toBe('PACK_CHECKSUM');
		expect(job.error?.message).toContain('whoosh_fast_000.wav');
		const dir = appdirPaths(app.appdir).soundPacksDir;
		expect(existsSync(join(dir, 'test-pack'))).toBe(false);
		expect(tree(join(dir, '.staging'))).toEqual([]);

		// a size that differs is refused before inflating (a zip bomb never gets inflated)
		writeCatalog([{ ...e, files: [{ ...e.files[0]!, sizeBytes: 10 }] }]);
		const job2 = await wait(app, (await install(app)).id);
		expect(job2.error?.code).toBe('PACK_CHECKSUM');
		expect(job2.error?.message).toContain('10');
		// a listed member the archive lacks
		writeCatalog([{ ...e, files: [{ ...e.files[0]!, path: 'Audio/not_there.wav' }] }]);
		expect((await wait(app, (await install(app)).id)).error?.code).toBe('PACK_MEMBER_MISSING');
	});

	it('zip-slip: a catalogue naming a path outside the pack is refused; archive entries never choose where files go', async () => {
		const f = makePackFixture();
		const e = packEntry(f);
		writeCatalog([{ ...e, files: [{ ...e.files[0]!, path: '../escape.wav' }] }]);
		const app = await makeApp();
		const list = await packs(app);
		expect(list.packs).toEqual([]);
		expect(list.catalogErrors[0]).toContain('files.0.path');
		const r = await app.inject({
			method: 'POST',
			url: '/api/sounds/packs/test-pack/install',
			headers: JSON_H,
			payload: {},
		});
		expect(r.statusCode).toBe(404);
		expect(r.json().code).toBe('SOUND_PACK_UNKNOWN');
		// the fixture's archive does hold "../escape.wav": installing the valid entry never writes it
		writeCatalog([e]);
		await installed(app);
		expect(existsSync(join(appdirPaths(app.appdir).soundPacksDir, '..', 'escape.wav'))).toBe(false);
		expect(existsSync(join(appdirPaths(app.appdir).soundsDir, 'escape.wav'))).toBe(false);
	});

	it('caps the download at the pinned size and deletes what was written', async () => {
		const f = makePackFixture();
		writeCatalog([
			packEntry(f, {
				download: { type: 'zip', url: pathToFileURL(f.zipPath).href, sha256: sha(f.zip), sizeBytes: 4096 },
			}),
		]);
		const app = await makeApp();
		const job = await wait(app, (await install(app)).id);
		expect(job.error?.code).toBe('PACK_TOO_LARGE');
		expect(tree(appdirPaths(app.appdir).soundPacksDir).filter((p) => !p.startsWith('.trash'))).toEqual([]);
	});

	it('resumes a partial download from where it stopped (file source)', async () => {
		const f = makePackFixture();
		writeCatalog([packEntry(f)]);
		const app = await makeApp();
		const dl = join(appdirPaths(app.appdir).soundPacksDir, '.downloads');
		mkdirSync(dl, { recursive: true });
		const half = Math.floor(f.zip.length / 2);
		writeFileSync(join(dl, partialName('test-pack', sha(f.zip))), f.zip.subarray(0, half));
		const r = await installed(app);
		expect(r.downloadedBytes).toBe(f.zip.length - half);
		expect((await packs(app)).packs[0]!.state).toBe('installed');
		expect(tree(dl)).toEqual([]);
	});

	it('engine start deletes stale staging folders and partial downloads no catalogue entry can resume', async () => {
		const f = makePackFixture();
		writeCatalog([packEntry(f)]);
		const appdir = tempAppdir('jasper-pack-appdir-');
		const dir = appdirPaths(appdir).soundPacksDir;
		mkdirSync(join(dir, '.staging', 'test-pack-old'), { recursive: true });
		writeFileSync(join(dir, '.staging', 'test-pack-old', 'x.wav'), 'x');
		mkdirSync(join(dir, '.downloads'), { recursive: true });
		writeFileSync(join(dir, '.downloads', 'gone-0000000000000000.partial'), 'x');
		const keep = partialName('test-pack', sha(f.zip));
		writeFileSync(join(dir, '.downloads', keep), f.zip.subarray(0, 100));
		const app = await makeApp({ appdir });
		await installed(app); // waits for the cleanup first
		expect(existsSync(join(dir, '.staging', 'test-pack-old'))).toBe(false);
		expect(existsSync(join(dir, '.downloads', 'gone-0000000000000000.partial'))).toBe(false);
	});

	it('a `files` pack downloads each file, checked by its own sha256', async () => {
		const f = makePackFixture();
		const fileDir = join(f.dir, 'files');
		mkdirSync(fileDir, { recursive: true });
		const list = f.files.slice(0, 2).map((x, i) => {
			writeFileSync(join(fileDir, `${i}.wav`), x.data);
			return {
				path: `${i}-${x.path.split('/').pop()}`,
				url: `files/${i}.wav`, // relative to the catalogue's folder
				sha256: sha(x.data),
				sizeBytes: x.data.length,
				title: x.title,
				types: x.types,
				tags: [],
				sourceUrl: `https://example.invalid/sound/${i}`,
				licenseEvidence: {
					url: `https://example.invalid/sound/${i}`,
					statement: 'License CC0 (public domain): Free and royalty-free',
					checkedAt: '2026-10-17',
				},
			};
		});
		const e = { ...packEntry(f), id: 'test-files', download: { type: 'files' }, files: list };
		const { licenseFile: _l, ...noLicense } = e;
		const catFile = join(f.dir, 'catalog.json');
		writeFileSync(catFile, JSON.stringify({ version: 1, packs: [noLicense] }));
		process.env.JASPER_SOUND_CATALOG = catFile;
		const app = await makeApp();
		const p = (await packs(app)).packs[0]!;
		expect(p).toMatchObject({ id: 'test-files', downloadUrl: null, sha256: filesDigest(noLicense as never) });
		const job = await wait(app, (await install(app, 'test-files')).id);
		expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
		await wait(app, (job.result as { indexJobId: string }).indexJobId);
		const r = await app.inject({
			method: 'GET',
			url: '/api/sounds?packId=test-files&license=any',
			headers: H,
		});
		const s = SoundSearchResponseSchema.parse(r.json());
		expect(s.results.map((x) => x.sound.sourceUrl).sort()).toEqual([
			'https://example.invalid/sound/0',
			'https://example.invalid/sound/1',
		]);
		// Help ▸ About ▸ Licenses says each sound's licence was checked on its own page
		const lic = (
			await app.inject({ method: 'GET', url: '/api/licenses', headers: H })
		).json() as LicensesResponse;
		const entry = lic.components.find((c) => c.id === 'sound-pack:test-files');
		expect(entry).toMatchObject({
			license: 'CC0-1.0',
			sourceUrl: 'https://example.invalid/test-pack',
		});
	});
});

describe('downloading over HTTP (a local server; no network)', { timeout: 300_000 }, () => {
	let server: Server | null = null;
	afterEach(async () => {
		server?.closeAllConnections();
		await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
		server = null;
	});

	/** Serves the first chunk immediately; held responses continue only when the test releases them. */
	async function serve(
		body: Buffer,
		o: { range?: boolean; chunk?: number; stallAfter?: number; hold?: boolean } = {},
	) {
		const seen: { range: string | null }[] = [];
		let markStarted = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let markClosed = (_completed: boolean) => {};
		const closed = new Promise<boolean>((resolve) => {
			markClosed = resolve;
		});
		let release = () => {};
		server = createServer((req, res) => {
			res.once('close', () => markClosed(res.writableFinished));
			seen.push({ range: (req.headers.range as string | undefined) ?? null });
			let start = 0;
			const m = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ''));
			if (o.range && m) {
				start = Number(m[1]);
				res.writeHead(206, {
					'content-length': body.length - start,
					'content-range': `bytes ${start}-${body.length - 1}/${body.length}`,
				});
			} else res.writeHead(200, { 'content-length': body.length });
			const at = Math.min(body.length, start + (o.stallAfter ?? o.chunk ?? body.length));
			res.write(body.subarray(start, at));
			release = () => {
				if (!res.destroyed) res.end(body.subarray(at));
			};
			markStarted();
			if (!o.hold && o.stallAfter === undefined) release();
		});
		await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
		const port = (server!.address() as AddressInfo).port;
		return { url: `http://127.0.0.1:${port}/pack.zip`, seen, started, closed, release: () => release() };
	}

	function partialWritten(file: string, bytes: number) {
		mkdirSync(join(file, '..'), { recursive: true });
		let watcher: ReturnType<typeof watch> | undefined;
		const ready = new Promise<void>((resolve) => {
			const check = () => {
				if (existsSync(file) && statSync(file).size >= bytes) resolve();
			};
			watcher = watch(join(file, '..'), check);
			check();
		});
		onTestFinished(() => {
			watcher?.close();
		});
		return { ready, close: () => watcher?.close() };
	}

	it('resumes with a Range request, and starts over when the server ignores it', async () => {
		const f = makePackFixture();
		for (const range of [true, false]) {
			const s = await serve(f.zip, { range });
			writeCatalog([
				packEntry(f, { download: { type: 'zip', url: s.url, sha256: sha(f.zip), sizeBytes: f.zip.length } }),
			]);
			const app = await makeApp();
			const dl = join(appdirPaths(app.appdir).soundPacksDir, '.downloads');
			mkdirSync(dl, { recursive: true });
			writeFileSync(join(dl, partialName('test-pack', sha(f.zip))), f.zip.subarray(0, 1000));
			const r = await installed(app);
			expect(s.seen[0]!.range).toBe('bytes=1000-');
			expect(r.downloadedBytes).toBe(range ? f.zip.length - 1000 : f.zip.length);
			expect((await packs(app)).packs[0]!.state).toBe('installed');
			await closeApps();
			await new Promise<void>((done) => server!.close(() => done()));
			server = null;
		}
	});

	it('cancel stops the download and deletes the partial file; nothing is installed', async () => {
		const f = makePackFixture();
		const s = await serve(f.zip, { chunk: 2048, hold: true });
		const fetch = globalThis.fetch;
		let downloadSignal: AbortSignal | null | undefined;
		const network = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
			if (String(input) === s.url) downloadSignal = init?.signal;
			return fetch(input, init);
		});
		const cleanup = () => {
			s.release();
			network.mockRestore();
		};
		onTestFinished(cleanup);
		writeCatalog([
			packEntry(f, { download: { type: 'zip', url: s.url, sha256: sha(f.zip), sizeBytes: f.zip.length } }),
		]);
		const app = await makeApp();
		const dir = appdirPaths(app.appdir).soundPacksDir;
		const partial = join(dir, '.downloads', partialName('test-pack', sha(f.zip)));
		const written = partialWritten(partial, 2048);
		const job = await install(app);
		try {
			await written.ready;
		} finally {
			written.close();
		}
		expect(statSync(partial).size).toBe(2048);
		const c = await app.inject({
			method: 'POST',
			url: `/api/jobs/${job.id}/cancel`,
			headers: JSON_H,
			payload: {},
		});
		expect(c.statusCode, c.body).toBeLessThan(300);
		try {
			expect(downloadSignal?.aborted).toBe(true);
			expect(await s.closed).toBe(false);
			const end = await wait(app, job.id);
			expect(end.state).toBe('cancelled');
			expect(existsSync(partial)).toBe(false);
			expect(existsSync(join(dir, 'test-pack'))).toBe(false);
			expect(tree(join(dir, '.staging'))).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it('a stalled download fails as retryable and keeps its partial file to resume', async () => {
		const f = makePackFixture();
		const s = await serve(f.zip, { chunk: 1024, stallAfter: 2048 });
		writeCatalog([
			packEntry(f, { download: { type: 'zip', url: s.url, sha256: sha(f.zip), sizeBytes: f.zip.length } }),
		]);
		process.env.JASPER_SOUND_PACK_STALL_MS = '400';
		const app = await makeApp();
		const partial = join(
			appdirPaths(app.appdir).soundPacksDir,
			'.downloads',
			partialName('test-pack', sha(f.zip)),
		);
		const written = partialWritten(partial, 2048);
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			const job = await install(app);
			await written.ready;
			await vi.advanceTimersByTimeAsync(400);
			const end = await wait(app, job.id);
			expect(end.state).toBe('failed');
			expect(end.error).toMatchObject({ code: 'DOWNLOAD_TIMEOUT', retryable: true });
			expect(statSync(partial).size).toBe(2048);
		} finally {
			written.close();
			vi.useRealTimers();
		}
	});

	it('a removal while the pack installs is refused (409 SOUND_PACK_BUSY) and nothing breaks', async () => {
		const f = makePackFixture();
		const s = await serve(f.zip, { chunk: 16_384, hold: true });
		writeCatalog([
			packEntry(f, { download: { type: 'zip', url: s.url, sha256: sha(f.zip), sizeBytes: f.zip.length } }),
		]);
		const app = await makeApp();
		const job = await install(app);
		await s.started;
		const r = await app.inject({ method: 'DELETE', url: '/api/sounds/packs/test-pack', headers: H });
		expect(r.statusCode).toBe(409);
		expect(r.json().code).toBe('SOUND_PACK_BUSY');
		// a second install request joins the running job
		expect((await install(app)).id).toBe(job.id);
		s.release();
		const end = await wait(app, job.id);
		expect(end.state, JSON.stringify(end.error)).toBe('succeeded');
	});

	it('a `files` pack fetches one file at a time, at most one request per interval, saying who it is', async () => {
		const f = makePackFixture();
		const { licenseFile: _license, ...zipless } = packEntry(f);
		const entry = {
			...zipless,
			id: 'test-files',
			download: { type: 'files' },
			files: f.files.slice(0, 2).map((x, i) => ({
				path: `${i}.wav`,
				url: `http://127.0.0.1:47900/f/${i}.wav`,
				sha256: sha(x.data),
				sizeBytes: x.data.length,
				title: x.title,
				types: x.types,
				tags: [],
			})),
		};
		const catalog = parsePackCatalog({ version: 1, packs: [entry] }, { builtin: false, base: null });
		expect(catalog.errors).toEqual([]);
		vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
		const fakeTimeout = globalThis.setTimeout;
		let markPaced = () => {};
		let paceInterval = 1000;
		vi.spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<typeof setTimeout>) => {
			const timer = fakeTimeout(...args);
			if (args[1] === paceInterval) markPaced();
			return timer;
		}) as typeof setTimeout);
		try {
			for (const cancel of [false, true]) {
				paceInterval = cancel ? 60_000 : 1000;
				const hits: { path: string; ua: string | null }[] = [];
				const receipt = () => {
					let resolve = () => {};
					const promise = new Promise<void>((done) => {
						resolve = done;
					});
					return { promise, resolve };
				};
				const requests = [receipt(), receipt()];
				const releases: (() => void)[] = [];
				let open = 0;
				let maxOpen = 0;
				const paced = receipt();
				markPaced = paced.resolve;
				vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
					if (options?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
					const i = hits.length;
					hits.push({
						path: new URL(String(url)).pathname,
						ua: new Headers(options?.headers).get('user-agent'),
					});
					open++;
					maxOpen = Math.max(maxOpen, open);
					const body = new ReadableStream<Uint8Array>({
						start(controller) {
							let finished = false;
							releases[i] = () => {
								if (finished) return;
								finished = true;
								controller.enqueue(f.files[i]!.data);
								controller.close();
								open--;
							};
						},
					});
					requests[i]!.resolve();
					return new Response(body, { headers: { 'content-length': String(f.files[i]!.data.length) } });
				});
				const packsDir = tempAppdir('jasper-paced-pack-');
				const store = new SoundPackStore({
					packsDir,
					catalog: async () => catalog,
					stallMs: 400,
					...(cancel ? { fileIntervalMs: paceInterval } : {}),
				});
				const ac = new AbortController();
				const pending = store.install('test-files', { signal: ac.signal, jobId: 'job_pacing' });
				// Attach the rejection handler before cancelling so a synchronous refusal cannot be unhandled.
				const result = pending.then(
					(value) => ({ value }),
					(error: unknown) => ({ error }),
				);
				try {
					await requests[0]!.promise;
					expect(hits.map((h) => h.path)).toEqual(['/f/0.wav']);
					releases[0]!();
					expect(
						await Promise.race([
							paced.promise.then(() => 'waiting'),
							requests[1]!.promise.then(() => 'requested'),
						]),
					).toBe('waiting');
					if (cancel) {
						const cancelledAt = vi.getMockedSystemTime();
						ac.abort();
						await vi.runAllTimersAsync();
						const outcome = await Promise.race([
							result.then((result) => ({ kind: 'settled' as const, result })),
							requests[1]!.promise.then(() => ({ kind: 'requested' as const })),
						]);
						expect(outcome.kind).toBe('settled');
						if (outcome.kind !== 'settled') throw new Error('A cancelled pack made another request');
						expect(outcome.result).toMatchObject({ error: { code: 'JOB_CANCELLED' } });
						expect(vi.getMockedSystemTime()).toEqual(cancelledAt);
						expect(hits).toHaveLength(1);
						expect(existsSync(join(packsDir, 'test-files'))).toBe(false);
					} else {
						await vi.advanceTimersByTimeAsync(999);
						expect(hits.map((h) => h.path)).toEqual(['/f/0.wav']);
						await vi.advanceTimersByTimeAsync(1);
						await requests[1]!.promise;
						releases[1]!();
						expect(await result).toMatchObject({ value: { packId: 'test-files', sounds: 2 } });
						expect(hits.map((h) => h.path)).toEqual(['/f/0.wav', '/f/1.wav']);
					}
					expect(maxOpen).toBe(1);
					for (const h of hits) expect(h.ua).toMatch(/^JasperEditor\b/);
				} finally {
					for (const release of releases) release();
					ac.abort();
					await result;
				}
			}
		} finally {
			vi.restoreAllMocks();
			vi.useRealTimers();
		}
	});

	it('a server that sends more than the pinned size is refused', async () => {
		const f = makePackFixture();
		const s = await serve(Buffer.concat([f.zip, Buffer.alloc(5000)]));
		writeCatalog([
			packEntry(f, { download: { type: 'zip', url: s.url, sha256: sha(f.zip), sizeBytes: f.zip.length } }),
		]);
		const app = await makeApp();
		const end = await wait(app, (await install(app)).id);
		expect(end.error?.code).toBe('PACK_TOO_LARGE');
		expect(tree(join(appdirPaths(app.appdir).soundPacksDir, '.downloads'))).toEqual([]);
	});
});

describe('removing a pack', { timeout: 300_000 }, () => {
	const TOKEN = 'tok_packs_0123456789abcdef';
	const KEY = 'key_packs_0123456789abcdef';
	const AGENT = {
		...H,
		authorization: `Bearer ${TOKEN}`,
		[AGENT_NAME_HEADER]: 'pack-agent',
		'content-type': 'application/json',
	};
	const EDITOR = {
		...H,
		cookie: `jasper_session_47900=${TOKEN}; jasper_editor_47900=${KEY}`,
		'content-type': 'application/json',
	};

	async function editorWindow(app: FastifyInstance & { appdir: string }) {
		const doc = createEmptyProject({ ids: createCounterIdSource(5), name: 'Packs', preset: 'hd-1080p-30' });
		const file = appdirPaths(app.appdir).projectFile(doc.projectId);
		mkdirSync(join(file, '..'), { recursive: true });
		writeFileSync(
			file,
			JSON.stringify(
				makeEnvelope(doc, { revision: 1, savedAt: '2026-10-17T00:00:00.000Z', platform: 'test' }),
			),
		);
		const ws: WebSocket = await app.injectWS('/agent', { headers: EDITOR });
		const cards: { approvalId: string; answerKey: string; summary: string; label: string }[] = [];
		let wake: (() => void) | null = null;
		ws.on('message', (d) => {
			const m = JSON.parse(String(d)) as { type: string; event?: string; payload?: unknown };
			if (m.type === 'event' && m.event === 'agent.approval.requested') {
				cards.push(m.payload as (typeof cards)[number]);
				wake?.();
			}
		});
		const welcome = once(ws, 'message');
		ws.send(
			JSON.stringify({ type: 'hello', projectId: doc.projectId, sessionId: 'ses_1', leaseId: 'lease_1' }),
		);
		await welcome;
		const card = async (n: number) => {
			while (cards.length < n) await new Promise<void>((r) => (wake = r));
			return cards[n - 1]!;
		};
		const answer = (c: (typeof cards)[number], decision: 'approved' | 'denied') =>
			ws.send(
				JSON.stringify({
					type: 'event',
					event: 'agent.approval.resolve',
					payload: { approvalId: c.approvalId, decision, answerKey: c.answerKey },
				}),
			);
		return { card, answer, cards };
	}

	const del = (app: FastifyInstance, headers: Record<string, string>, id = 'test-pack') => {
		const { 'content-type': _json, ...plain } = headers;
		return app.inject({ method: 'DELETE', url: `/api/sounds/packs/${id}`, headers: plain });
	};

	it('agents may install; an agent removing a pack needs the user; the editor does not', async () => {
		const f = makePackFixture();
		writeCatalog([packEntry(f)]);
		const app = await makeApp({ dev: false, token: TOKEN, editorKey: KEY });
		// installs are open to agents (catalogue-pinned, size-bounded: like model downloads)
		const job = await wait(app, (await install(app, 'test-pack', AGENT)).id);
		expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
		expect(job.origin).toMatchObject({ type: 'agent' });
		await wait(app, (job.result as { indexJobId: string }).indexJobId);

		// No editor window to ask: refused, nothing removed.
		const refused = await del(app, AGENT);
		expect(refused.statusCode).toBe(403);
		expect(refused.json()).toMatchObject({ code: 'APPROVAL_DENIED', detail: { code: 'E_APPROVAL_DENIED' } });
		expect((await packs(app, AGENT)).packs[0]!.state).toBe('installed');

		const editor = await editorWindow(app);
		const denied = del(app, AGENT);
		const c1 = await editor.card(1);
		expect(c1.summary).toContain('Test Pack');
		editor.answer(c1, 'denied');
		expect((await denied).statusCode).toBe(403);
		expect((await packs(app, AGENT)).packs[0]!.state).toBe('installed');

		const approved = del(app, AGENT);
		editor.answer(await editor.card(2), 'approved');
		const ok = await approved;
		expect(ok.statusCode, ok.body).toBe(200);
		const body = SoundPackRemoveResponseSchema.parse(ok.json());
		expect(body).toMatchObject({ packId: 'test-pack', removed: true, removedSounds: 3 });
		expect(body.freedBytes).toBeGreaterThan(0);
		if (body.job) await wait(app, body.job.id);
		expect((await packs(app, AGENT)).packs[0]).toMatchObject({ state: 'available', indexedSounds: 0 });

		// Removing what is not installed changes nothing and asks nothing (idempotent); unknown ids are 404.
		const again = await del(app, AGENT);
		expect(again.statusCode).toBe(200);
		expect(again.json()).toMatchObject({ removed: false });
		expect(editor.cards).toHaveLength(2);
		expect((await del(app, AGENT, 'no-such-pack')).statusCode).toBe(404);

		// The editor window itself is never asked.
		await wait(app, (await install(app, 'test-pack', EDITOR)).id);
		expect((await del(app, EDITOR)).statusCode).toBe(200);
		expect(editor.cards).toHaveLength(2);
	});

	it('a project that uses a pack sound still opens, plays and exports after the pack is removed', async () => {
		const f = makePackFixture();
		writeCatalog([packEntry(f)]);
		const app = await makeApp();
		await installed(app);
		const created = await app.inject({
			method: 'POST',
			url: '/api/projects',
			headers: JSON_H,
			payload: { name: 'Uses a pack', preset: 'hd-1080p-30' },
		});
		const projectId = (created.json() as { projectId: string }).projectId;
		const s = SoundSearchResponseSchema.parse(
			(
				await app.inject({
					method: 'GET',
					url: '/api/sounds?packId=test-pack&q=heavy%20impact&license=any',
					headers: H,
				})
			).json(),
		);
		const sound = s.results[0]!.sound;
		const reg = RegisterSoundResponseSchema.parse(
			(
				await app.inject({
					method: 'POST',
					url: `/api/sounds/${sound.id}/register`,
					headers: JSON_H,
					payload: { projectId },
				})
			).json(),
		);
		expect(reg.library.source).toMatchObject({ type: 'pack', packId: 'test-pack' });
		const b = new DocBuilder('hd-1080p-30', 700);
		const { mediaKey, browserPlayable: _b, library, existingMediaId: _x, ...asset } = reg;
		const r0 = b.tx([{ type: 'media.register', asset: { ...asset, derivation: null, library } }]);
		const mediaId = (r0.results[0] as { mediaId: string }).mediaId;
		b.tx([
			{
				type: 'soundCue.add',
				cues: [{ frame: 15, kind: 'cut', weight: 'support', source: 'user', align: 'peak', ref: '$c' }],
			},
			{ type: 'soundDesign.place', cueId: '$c', layers: [{ mediaId, gainDb: 0 }] },
		]);
		// the registered file is a managed copy, not the pack's file
		const managed = coreServices(app).registry.get(mediaKey);
		expect(managed).toBeTruthy();

		const rm = await del(app, JSON_H);
		expect(rm.statusCode, rm.body).toBe(200);
		expect(existsSync(join(appdirPaths(app.appdir).soundPacksDir, 'test-pack'))).toBe(false);

		// the media is still online and the mix still has the sound in it
		const world = await audioWorld(b.doc, b.seqId, coreServices(app).registry);
		const scratch = tempAppdir('jasper-pack-render-');
		const out = await renderMixdown({
			ff: coreServices(app).ffmpeg,
			snapshot: world.snapshot,
			media: world.media,
			range: { start: 0, end: 45 },
			outputLayout: 'stereo',
			scratchDir: scratch,
			withoutLoudness: true,
		});
		const buf = readFileSync(out.path!);
		const pcm = new Float32Array(buf.buffer.slice(buf.byteOffset + WAV_F32_HEADER_BYTES));
		let peak = 0;
		for (const v of pcm) peak = Math.max(peak, Math.abs(v));
		expect(peak).toBeGreaterThan(0.2);

		// and a real export (the engine's export job) of that project succeeds with audio
		const start = await app.inject({
			method: 'POST',
			url: '/api/exports',
			headers: JSON_H,
			payload: {
				envelope: b.envelope(),
				sequenceId: b.seqId,
				settings: {
					sequenceId: b.seqId,
					range: { type: 'custom', startFrame: 0, endFrame: 45 },
					container: 'mp4',
					video: {
						codec: 'h264',
						width: 320,
						height: 180,
						frameRate: { num: 30, den: 1 },
						scaling: 'fit',
						quality: { mode: 'crf', value: 30 },
						encoderSpeed: 'fast',
					},
					audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
					engine: 'native',
				},
			},
		});
		expect(start.statusCode, start.body).toBe(202);
		const done = await wait(app, start.json().id);
		expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
	});
});
