// wp fonts: the user font library — store persistence and repair (FontLibrary), the HTTP routes (auth, size caps,
// bad bytes, approval of agent removals, usage), and resolution in the export planner (a library font is used on
// every path, no FONT_FALLBACK; a missing one keeps the fallback and is named).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	AGENT_NAME_HEADER,
	FontCatalogSchema,
	FontInstallResponseSchema,
	FontLibraryResponseSchema,
	FontUsageResponseSchema,
	type LibraryFont,
} from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import { createCounterIdSource, createEmptyProject, makeEnvelope } from '@jasper/project';
import type { FastifyInstance } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { FONT_LIBRARY_LIMITS, FontLibrary } from '../src/fonts/library.ts';
import { coreServices } from '../src/tools/services.ts';
import { makeTestTtc, makeTestTtf, toWoff, toWoff2 } from './font-fixtures.ts';
import { closeApps, DocBuilder, H, JSON_H, makeApp, tempAppdir } from './helpers.ts';

afterAll(closeApps);

const BIN_H = { ...H, 'content-type': 'application/octet-stream' };

const pixel = () => makeTestTtf({ family: 'Pixel12x10', postscriptName: 'Pixel12x10', seed: 3 });
const circular = () =>
	makeTestTtf({
		family: 'Circular Std Medium',
		typographicFamily: 'Circular Std',
		typographicSubfamily: 'Medium',
		postscriptName: 'CircularStd-Medium',
		weight: 500,
		seed: 4,
	});

async function upload(
	app: FastifyInstance,
	bytes: Uint8Array,
	fileName = 'font.ttf',
	headers: Record<string, string> = BIN_H,
) {
	return app.inject({
		method: 'POST',
		url: `/api/fonts/library?fileName=${encodeURIComponent(fileName)}`,
		headers,
		payload: Buffer.from(bytes),
	});
}

describe('font library store (persistence, idempotence, caps)', () => {
	it('installs, lists, persists across reopen; same bytes again are "existing"; collections split into faces', async () => {
		const dir = join(tempAppdir(), 'fonts');
		const changes: number[] = [];
		const lib = await FontLibrary.open(dir, {
			onChange: (r) => changes.push(r),
			now: () => '2026-10-25T00:00:00.000Z',
		});
		expect(lib.list()).toMatchObject({ revision: 0, fonts: [], repairs: [], readOnly: false });
		const a = await lib.install(pixel(), 'Pixel12x10.ttf');
		expect(a.installed).toHaveLength(1);
		const face = a.installed[0]!;
		expect(face).toMatchObject({
			family: 'Pixel12x10',
			postscriptName: 'Pixel12x10',
			format: 'ttf',
			originalName: 'Pixel12x10.ttf',
			addedAt: '2026-10-25T00:00:00.000Z',
		});
		expect(face.id).toMatch(/^f[0-9a-f]{24}$/);
		expect(readFileSync(join(dir, 'files', `${face.id}.ttf`))).toEqual(Buffer.from(pixel()));
		const again = await lib.install(pixel(), 'copy.ttf');
		expect(again).toMatchObject({ installed: [], existing: [{ id: face.id }], revision: 1 });

		const ttc = makeTestTtc([
			makeTestTtf({ family: 'Coll', weight: 400 }),
			makeTestTtf({ family: 'Coll', weight: 700, subfamily: 'Bold', seed: 9 }),
		]);
		const c = await lib.install(ttc, 'Coll.ttc');
		expect(c.installed.map((f) => [f.family, f.weight, f.collectionIndex, f.format])).toEqual([
			['Coll', 400, 0, 'ttf'],
			['Coll', 700, 1, 'ttf'],
		]);
		expect(changes).toEqual([1, 2]);

		const reopened = await FontLibrary.open(dir);
		expect(reopened.list()).toMatchObject({ revision: 2, repairs: [] });
		expect(reopened.fonts().map((f) => f.fullName)).toEqual(lib.fonts().map((f) => f.fullName));
		const removed = await reopened.remove(face.id);
		expect(removed).toEqual({ revision: 3, removed: [face.id] });
		expect(existsSync(join(dir, 'files', `${face.id}.ttf`))).toBe(false);
		expect((await FontLibrary.open(dir)).fonts().map((f) => f.family)).toEqual(['Coll', 'Coll']);
	});

	it('refuses bad bytes, oversized files, a full library and a different face with an installed PostScript name', async () => {
		const dir = join(tempAppdir(), 'fonts');
		const lib = await FontLibrary.open(dir, {
			limits: { maxFonts: 2, maxTotalBytes: 60_000, maxFileBytes: 40_000 },
		});
		await expect(lib.install(new TextEncoder().encode('not a font at all'), 'x.ttf')).rejects.toMatchObject({
			status: 400,
			code: 'FONT_INVALID',
		});
		await expect(lib.install(new Uint8Array(40_001), 'big.ttf')).rejects.toMatchObject({
			status: 413,
			code: 'FONT_TOO_LARGE',
		});
		await lib.install(pixel(), 'a.ttf');
		// same PostScript name, different bytes
		await expect(
			lib.install(makeTestTtf({ family: 'Pixel12x10', postscriptName: 'Pixel12x10', seed: 99 }), 'b.ttf'),
		).rejects.toMatchObject({ status: 409, code: 'FONT_EXISTS' });
		await lib.install(circular(), 'c.ttf');
		await expect(lib.install(makeTestTtf({ family: 'Third' }), 'd.ttf')).rejects.toMatchObject({
			status: 409,
			code: 'FONT_LIBRARY_FULL',
		});
		const small = await FontLibrary.open(join(tempAppdir(), 'fonts'), { limits: { maxTotalBytes: 30_000 } });
		await small.install(pixel(), 'a.ttf');
		await expect(small.install(circular(), 'c.ttf')).rejects.toMatchObject({ code: 'FONT_LIBRARY_FULL' });
		// nothing written for refused installs
		expect(readdirSync(join(dir, 'files')).sort()).toEqual(
			lib
				.fonts()
				.map((f) => `${f.id}.ttf`)
				.sort(),
		);
	});

	it('accepts WOFF and WOFF2 and keeps them as they are', async () => {
		const lib = await FontLibrary.open(join(tempAppdir(), 'fonts'));
		const w1 = (await lib.install(toWoff(makeTestTtf({ family: 'W One' })), 'one.woff')).installed[0]!;
		const w2 = (await lib.install(toWoff2(makeTestTtf({ family: 'W Two' })), 'two.woff2')).installed[0]!;
		expect([w1.format, w2.format]).toEqual(['woff', 'woff2']);
		expect(lib.filePath(`${w2.id}.woff2`)).toMatch(/\.woff2$/);
		expect(lib.filePath(`${w2.id}.ttf`)).toBeNull();
		expect(lib.filePath('../library.json')).toBeNull();
	});
});

describe('font library store: conservative repair on open', () => {
	async function seeded() {
		const dir = join(tempAppdir(), 'fonts');
		const lib = await FontLibrary.open(dir);
		const a = (await lib.install(pixel(), 'Pixel12x10.ttf')).installed[0]!;
		const b = (await lib.install(circular(), 'Circular.ttf')).installed[0]!;
		return { dir, a, b, index: join(dir, 'library.json') };
	}

	it('an unreadable index is kept aside and rebuilt from the font files', async () => {
		const { dir, index } = await seeded();
		writeFileSync(index, '{"format": "jasper-font-library", "fonts": [ {"trunc');
		const lib = await FontLibrary.open(dir);
		expect(
			lib
				.fonts()
				.map((f) => f.postscriptName)
				.sort(),
		).toEqual(['CircularStd-Medium', 'Pixel12x10']);
		expect(lib.repairs.join('\n')).toMatch(/unreadable.*rebuilt/);
		expect(readdirSync(dir).some((n) => n.startsWith('library.json.corrupt-'))).toBe(true);
		// the rebuilt index is valid and needs no repair next time
		expect((await FontLibrary.open(dir)).repairs).toEqual([]);
	});

	it('an entry whose file is missing is dropped; a stray face file is adopted; temp files are removed', async () => {
		const { dir, a, b } = await seeded();
		// a crash mid-removal: file gone, entry still there
		const files = join(dir, 'files');
		const { rmSync } = await import('node:fs');
		rmSync(join(files, `${a.id}.ttf`));
		// a crash mid-install: file written, index not
		const stray = (await FontLibrary.open(join(tempAppdir(), 'fonts'))).install(
			makeTestTtf({ family: 'Stray' }),
			's.ttf',
		);
		const strayFace = (await stray).installed[0]!;
		const strayBytes = makeTestTtf({ family: 'Stray' });
		writeFileSync(join(files, `${strayFace.id}.ttf`), strayBytes);
		writeFileSync(join(files, '.x.ttf.1234.tmp'), 'partial');
		writeFileSync(join(files, 'notes.txt'), 'unrelated');
		const lib = await FontLibrary.open(dir);
		expect(
			lib
				.fonts()
				.map((f) => f.family)
				.sort(),
		).toEqual(['Circular Std', 'Stray']);
		expect(lib.repairs.some((r) => /Pixel12x10.*missing/.test(r))).toBe(true);
		expect(lib.repairs.some((r) => /Stray.*added back/.test(r))).toBe(true);
		expect(readdirSync(files).includes('.x.ttf.1234.tmp')).toBe(false);
		expect(readdirSync(files).includes('notes.txt')).toBe(true); // not ours: left alone
		expect(lib.get(b.id)).not.toBeNull();
		expect((await FontLibrary.open(dir)).repairs).toEqual([]);
	});

	it('entries that no longer validate are kept aside, never silently dropped; a damaged face file is dropped', async () => {
		const { dir, a, b, index } = await seeded();
		const raw = JSON.parse(readFileSync(index, 'utf8'));
		raw.fonts.push({ id: 'nonsense', family: 7 });
		writeFileSync(index, JSON.stringify(raw));
		writeFileSync(join(dir, 'files', `${b.id}.ttf`), 'truncated');
		const lib = await FontLibrary.open(dir);
		expect(lib.fonts().map((f) => f.id)).toEqual([a.id]);
		const after = JSON.parse(readFileSync(index, 'utf8'));
		expect(after.invalid).toEqual(expect.arrayContaining([{ id: 'nonsense', family: 7 }]));
		expect(lib.repairs.some((r) => /Circular Std Medium.*damaged/.test(r))).toBe(true);
	});

	it('an index written by a newer build is listed but never rewritten (read-only)', async () => {
		const { dir, index } = await seeded();
		const raw = JSON.parse(readFileSync(index, 'utf8'));
		raw.version = 2;
		raw.futureField = { keep: true };
		writeFileSync(index, JSON.stringify(raw));
		const before = readFileSync(index, 'utf8');
		const lib = await FontLibrary.open(dir);
		expect(lib.readOnly).toBe(true);
		expect(lib.fonts()).toHaveLength(2);
		await expect(lib.install(makeTestTtf({ family: 'New' }), 'n.ttf')).rejects.toMatchObject({
			code: 'FONT_LIBRARY_READ_ONLY',
		});
		await expect(lib.remove(lib.fonts()[0]!.id)).rejects.toMatchObject({ code: 'FONT_LIBRARY_READ_ONLY' });
		expect(readFileSync(index, 'utf8')).toBe(before);
	});
});

describe('font library routes', () => {
	it('upload → list → catalog → served file; events; restart keeps it', async () => {
		const appdir = tempAppdir();
		const app = await makeApp({ appdir });
		const events: unknown[] = [];
		coreServices(app).broadcaster.subscribe((e) => e.type === 'fonts.changed' && events.push(e.payload));
		const r = await upload(app, pixel(), 'Pixel12x10.ttf');
		expect(r.statusCode, r.body).toBe(201);
		const body = FontInstallResponseSchema.parse(r.json());
		const face = body.installed[0]!;
		expect(events).toEqual([{ revision: 1 }]);
		// same file again: 200, nothing new, no event
		const again = await upload(app, pixel(), 'Pixel12x10.ttf');
		expect(again.statusCode).toBe(200);
		expect(again.json()).toMatchObject({ installed: [], existing: [{ id: face.id }] });
		expect(events).toHaveLength(1);

		const list = FontLibraryResponseSchema.parse(
			(await app.inject({ method: 'GET', url: '/api/fonts/library', headers: H })).json(),
		);
		expect(list.fonts.map((f) => f.id)).toEqual([face.id]);
		expect(list.limits.maxFileBytes).toBe(FONT_LIBRARY_LIMITS.maxFileBytes);
		const cat = FontCatalogSchema.parse(
			(await app.inject({ method: 'GET', url: '/api/fonts', headers: H })).json(),
		);
		const fam = cat.fonts.find((f) => f.family === 'Pixel12x10')!;
		expect(fam).toMatchObject({ source: 'custom', weights: [400], styles: ['normal'] });
		expect(fam.files[0]).toMatchObject({
			postscriptName: 'Pixel12x10',
			fontId: face.id,
			url: `/fonts/library/${face.id}.ttf`,
		});
		// bundled families first (they win a name clash), then the library
		const sources = cat.fonts.map((f) => f.source);
		expect(sources.indexOf('custom')).toBeGreaterThan(sources.lastIndexOf('bundled'));
		const file = await app.inject({ method: 'GET', url: fam.files[0]!.url, headers: H });
		expect(file.statusCode).toBe(200);
		expect(file.headers['content-type']).toBe('font/ttf');
		expect(file.headers['cache-control']).toContain('immutable');
		expect(file.rawPayload).toEqual(Buffer.from(pixel()));
		for (const bad of [
			`/fonts/library/${face.id}.woff2`,
			'/fonts/library/../library.json',
			'/fonts/library/library.json',
			`/fonts/library/${face.id}`,
		])
			expect((await app.inject({ method: 'GET', url: bad, headers: H })).statusCode, bad).toBe(404);
		const caps = (await app.inject({ method: 'GET', url: '/api/capabilities', headers: H })).json();
		expect(caps.fonts).toMatchObject({ customUpload: true });

		await app.close();
		const back = await makeApp({ appdir });
		const cat2 = FontCatalogSchema.parse(
			(await back.inject({ method: 'GET', url: '/api/fonts', headers: H })).json(),
		);
		expect(cat2.fonts.some((f) => f.family === 'Pixel12x10')).toBe(true);
	});

	it('refuses bad bytes (400), unsupported kinds (415), oversized bodies (413) and JSON bodies (415)', async () => {
		const app = await makeApp();
		const html = await upload(app, new TextEncoder().encode('<!doctype html><title>x</title>'), 'x.ttf');
		expect(html.statusCode).toBe(400);
		expect(html.json()).toMatchObject({ code: 'FONT_INVALID' });
		const t1 = await upload(app, new TextEncoder().encode('typ1 and some bytes after it'), 'x.pfb');
		expect([t1.statusCode, t1.json().code]).toEqual([415, 'FONT_UNSUPPORTED']);
		const big = Buffer.alloc(FONT_LIBRARY_LIMITS.maxFileBytes + 1);
		Buffer.from(pixel()).copy(big);
		const tooBig = await upload(app, big, 'big.ttf');
		expect([tooBig.statusCode, tooBig.json().code]).toEqual([413, 'FONT_TOO_LARGE']);
		const json = await app.inject({
			method: 'POST',
			url: '/api/fonts/library',
			headers: JSON_H,
			payload: { a: 1 },
		});
		expect(json.statusCode).toBe(415);
		const longName = await app.inject({
			method: 'POST',
			url: `/api/fonts/library?fileName=${'x'.repeat(300)}`,
			headers: BIN_H,
			payload: Buffer.from(pixel()),
		});
		expect(longName.statusCode).toBe(400);
		expect(
			FontLibraryResponseSchema.parse(
				(await app.inject({ method: 'GET', url: '/api/fonts/library', headers: H })).json(),
			).fonts,
		).toEqual([]);
	});

	it('requires the engine token on every font library route; signed URLs serve the files to renderers', async () => {
		const TOKEN = 'tok_fonts_0123456789abcdef';
		const app = await makeApp({ dev: false, token: TOKEN });
		const auth = { authorization: `Bearer ${TOKEN}` };
		for (const [method, url] of [
			['GET', '/api/fonts/library'],
			['POST', '/api/fonts/library'],
			['POST', '/api/fonts/library/install-path'],
			['DELETE', '/api/fonts/library/f000000000000000000000000'],
			['GET', '/api/fonts/library/f000000000000000000000000/usage'],
		] as const)
			expect((await app.inject({ method, url, headers: BIN_H })).statusCode, url).toBe(401);
		const r = await upload(app, pixel(), 'p.ttf', { ...BIN_H, ...auth });
		expect(r.statusCode, r.body).toBe(201);
		const url = `/fonts/library/${r.json().installed[0].id}.ttf`;
		expect((await app.inject({ method: 'GET', url, headers: H })).statusCode).toBe(401);
		const signed = coreServices(app).signer.signUrl('http://127.0.0.1:47900', url);
		const viaSig = await app.inject({
			method: 'GET',
			url: signed.replace('http://127.0.0.1:47900', ''),
			headers: H,
		});
		expect(viaSig.statusCode).toBe(200);
	});

	it('installs from an absolute local path (relative, missing and directory paths are refused)', async () => {
		const app = await makeApp();
		const dir = tempAppdir('jasper-fontfile-');
		const file = join(dir, 'CircularStd-Medium.otf.ttf');
		writeFileSync(file, circular());
		const post = (path: string) =>
			app.inject({
				method: 'POST',
				url: '/api/fonts/library/install-path',
				headers: JSON_H,
				payload: { path },
			});
		const ok = await post(file);
		expect(ok.statusCode, ok.body).toBe(201);
		expect(ok.json().installed[0]).toMatchObject({
			family: 'Circular Std',
			originalName: 'CircularStd-Medium.otf.ttf',
		});
		expect((await post('relative/font.ttf')).statusCode).toBe(400);
		expect((await post(join(dir, 'missing.ttf'))).statusCode).toBe(404);
		expect((await post(dir)).statusCode).toBe(400);
	});

	it('usage lists the saved projects whose fonts resolve to the face', async () => {
		const app = await makeApp();
		const face = (await upload(app, circular(), 'c.ttf')).json().installed[0] as LibraryFont;
		let seed = 100;
		const save = (name: string, family: string) => {
			const d = new DocBuilder('hd-1080p-30', (seed += 100));
			d.tx([{ type: 'font.add', family }]);
			d.doc = { ...d.doc, name };
			const file = appdirPaths(app.appdir).projectFile(d.doc.projectId);
			mkdirSync(join(file, '..'), { recursive: true });
			writeFileSync(file, JSON.stringify(d.envelope()));
			return d.doc.projectId;
		};
		const byPs = save('Uses PS name', 'CircularStd-Medium');
		const byFamily = save('Uses family', 'Circular Std');
		save('Other', 'Inter');
		const usage = FontUsageResponseSchema.parse(
			(await app.inject({ method: 'GET', url: `/api/fonts/library/${face.id}/usage`, headers: H })).json(),
		);
		expect(usage.projects.map((p) => p.projectId).sort()).toEqual([byPs, byFamily].sort());
		expect(usage).toMatchObject({ scanned: 3, truncated: false });
		expect(
			(await app.inject({ method: 'GET', url: '/api/fonts/library/fnope/usage', headers: H })).statusCode,
		).toBe(404);
	});
});

describe('removing a library font', { timeout: 120_000 }, () => {
	const TOKEN = 'tok_fonts_0123456789abcdef';
	const KEY = 'key_fonts_0123456789abcdef';
	const AGENT = { ...H, authorization: `Bearer ${TOKEN}`, [AGENT_NAME_HEADER]: 'font-agent' };
	const EDITOR = { ...H, cookie: `jasper_session_47900=${TOKEN}; jasper_editor_47900=${KEY}` };

	async function editorWindow(
		app: FastifyInstance & { appdir: string },
		projectName: string,
		family: string,
	) {
		const doc = createEmptyProject({
			ids: createCounterIdSource(5),
			name: projectName,
			preset: 'hd-1080p-30',
		});
		doc.fonts.fnt_x = { id: 'fnt_x', family, source: { type: 'bundled' } } as never;
		const file = appdirPaths(app.appdir).projectFile(doc.projectId);
		mkdirSync(join(file, '..'), { recursive: true });
		writeFileSync(
			file,
			JSON.stringify(
				makeEnvelope(doc, { revision: 1, savedAt: '2026-10-25T00:00:00.000Z', platform: 'test' }),
			),
		);
		const ws: WebSocket = await app.injectWS('/agent', {
			headers: { ...EDITOR, 'content-type': 'application/json' },
		});
		const cards: {
			approvalId: string;
			answerKey: string;
			summary: string;
			label: string;
			reasons?: string[];
		}[] = [];
		let wake: (() => void) | null = null;
		ws.on('message', (d) => {
			const m = JSON.parse(String(d)) as { type: string; event?: string; payload?: unknown };
			if (m.type === 'event' && m.event === 'agent.approval.requested') {
				cards.push(m.payload as (typeof cards)[number]);
				wake?.();
			}
		});
		ws.send(
			JSON.stringify({ type: 'hello', projectId: doc.projectId, sessionId: 'ses_1', leaseId: 'lease_1' }),
		);
		await new Promise((r) => setTimeout(r, 100));
		return {
			cards,
			card: async (n: number) => {
				while (cards.length < n) await new Promise<void>((r) => (wake = r));
				return cards[n - 1]!;
			},
			answer: (c: (typeof cards)[number], decision: 'approved' | 'denied') =>
				ws.send(
					JSON.stringify({
						type: 'event',
						event: 'agent.approval.resolve',
						payload: { approvalId: c.approvalId, decision, answerKey: c.answerKey },
					}),
				),
		};
	}

	it('an agent removing a font needs the user (the card names projects that use it); the editor does not', async () => {
		const app = await makeApp({ dev: false, token: TOKEN, editorKey: KEY });
		const face = (await upload(app, pixel(), 'Pixel12x10.ttf', { ...BIN_H, ...AGENT })).json()
			.installed[0] as LibraryFont;
		const del = (headers: Record<string, string>, id = face.id) =>
			app.inject({ method: 'DELETE', url: `/api/fonts/library/${id}`, headers });
		const refused = await del(AGENT);
		expect(refused.statusCode).toBe(403);
		expect(refused.json()).toMatchObject({ code: 'APPROVAL_DENIED', detail: { code: 'E_APPROVAL_DENIED' } });
		expect(coreServices(app).fontLibrary.get(face.id)).not.toBeNull();

		const editor = await editorWindow(app, 'Shorts 12', 'Pixel12x10');
		const denied = del(AGENT);
		const c1 = await editor.card(1);
		expect(c1.label).toBe('Remove font');
		expect(c1.summary).toContain('Pixel12x10');
		expect(c1.summary).toContain('"Shorts 12"');
		editor.answer(c1, 'denied');
		expect((await denied).statusCode).toBe(403);
		expect(coreServices(app).fontLibrary.get(face.id)).not.toBeNull();

		const approved = del(AGENT);
		editor.answer(await editor.card(2), 'approved');
		const ok = await approved;
		expect(ok.statusCode, ok.body).toBe(200);
		expect(ok.json()).toMatchObject({ ok: true, removed: [face.id] });
		expect((await del(AGENT)).statusCode).toBe(404);

		// the editor window itself is not asked
		const again = (await upload(app, pixel(), 'Pixel12x10.ttf', { ...BIN_H, ...EDITOR })).json()
			.installed[0] as LibraryFont;
		expect((await del(EDITOR, again.id)).statusCode).toBe(200);
		expect(editor.cards).toHaveLength(2);
	});
});

describe('resolution in the export planner (wp fonts)', () => {
	const settings = (seqId: string) => ({
		sequenceId: seqId,
		range: { type: 'entire' },
		container: 'mp4',
		video: {
			codec: 'h264',
			width: 1920,
			height: 1080,
			frameRate: { num: 30, den: 1 },
			scaling: 'fit',
			quality: { mode: 'crf', value: 18 },
			encoderSpeed: 'fast',
		},
		audio: null,
	});

	function textDoc(families: string[]) {
		const d = new DocBuilder();
		for (const [i, family] of families.entries())
			d.tx([
				{ type: 'font.add', family, ref: '$f' },
				{
					type: 'clip.addText',
					at: i * 30,
					duration: 30,
					track: 'V1',
					content: { text: `Text ${i}`, style: { fontId: '$f', weight: 500 } },
				},
			]);
		return d;
	}

	async function plan(app: FastifyInstance, d: DocBuilder) {
		const p = await coreServices(app).exports.plan({
			envelope: d.envelope(),
			sequenceId: d.seqId,
			settings: settings(d.seqId) as never,
		});
		return { warnings: p.plan.warnings, snapshot: p.snapshot };
	}

	it('a missing font keeps the fallback and is named; installing it later makes the same project use it', async () => {
		const app = await makeApp();
		const d = textDoc(['Pixel12x10', 'CircularStd-Medium', 'Inter']);
		const before = await plan(app, d);
		const warn = before.warnings.find((w) => w.code === 'FONT_FALLBACK');
		expect(warn?.message).toContain('CircularStd-Medium, Pixel12x10');
		expect(warn?.itemIds).toHaveLength(2);
		expect(before.snapshot.fonts.filter((f) => f.url.includes('source-sans-3'))).toHaveLength(2);

		await upload(app, pixel(), 'Pixel12x10.ttf');
		const one = await plan(app, d);
		expect(one.warnings.find((w) => w.code === 'FONT_FALLBACK')?.message).toContain(
			'not installed: CircularStd-Medium.',
		);

		const circ = (await upload(app, circular(), 'Circular.ttf')).json().installed[0] as LibraryFont;
		const after = await plan(app, d);
		expect(after.warnings.some((w) => w.code === 'FONT_FALLBACK')).toBe(false);
		const byFamily = Object.fromEntries(after.snapshot.fonts.map((f) => [f.family, f.url]));
		expect(byFamily.Pixel12x10).toMatch(/^\/fonts\/library\/f[0-9a-f]{24}\.ttf$/);
		// the PostScript name Premiere stores resolves to that face
		expect(byFamily['CircularStd-Medium']).toBe(`/fonts/library/${circ.id}.ttf`);
		// bundled families are unaffected
		expect(byFamily.Inter).toMatch(/^\/fonts\/inter\//);
		// every path loads these URLs: the Remotion path signs them, the layer bake keys and loads them
		expect(coreServices(app).fonts.filePath(byFamily.Pixel12x10!.slice('/fonts/'.length))).toMatch(/\.ttf$/);
	});

	it('removing the font brings the fallback back', async () => {
		const app = await makeApp();
		const face = (await upload(app, pixel(), 'Pixel12x10.ttf')).json().installed[0] as LibraryFont;
		const d = textDoc(['Pixel12x10']);
		expect((await plan(app, d)).warnings.some((w) => w.code === 'FONT_FALLBACK')).toBe(false);
		await app.inject({ method: 'DELETE', url: `/api/fonts/library/${face.id}`, headers: H });
		const gone = await plan(app, d);
		expect(gone.warnings.find((w) => w.code === 'FONT_FALLBACK')?.message).toContain('Pixel12x10');
	});
});
