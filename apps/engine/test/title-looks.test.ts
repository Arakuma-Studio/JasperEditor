// Spec 19 TL-054 / TL-053: the user look library through HTTP, and the display fonts the factory looks name.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appdirPaths } from '@jasper/config';
import {
	FACTORY_LOOKS,
	FACTORY_TEMPLATES,
	factoryLook,
	type LookFont,
	type LookRecipe,
} from '@jasper/project';
import { afterAll, describe, expect, it } from 'vitest';
import { DisplayFontManifestSchema, FontCatalogService } from '../src/fonts/catalog.ts';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, H, JSON_H, makeApp, tempAppdir } from './helpers.ts';

afterAll(closeApps);

const here = dirname(fileURLToPath(import.meta.url));
const DISPLAY = join(here, '..', 'fonts', 'display');
const ROOT = join(here, '..', '..', '..');

const recipe: LookRecipe = {
	palette: { face: [1, 0.8, 0.2, 1] },
	layers: [{ type: 'rim', params: { width: 5 } }, { type: 'face' }],
};

async function saved(app: Awaited<ReturnType<typeof makeApp>>, name: string) {
	const r = await app.inject({
		method: 'POST',
		url: '/api/title-looks',
		headers: JSON_H,
		payload: { name, recipe },
	});
	expect(r.statusCode).toBe(201);
	return r.json();
}

describe('user look library (TL-054)', () => {
	it('saves, lists, renames, deletes, announces and persists across restarts', async () => {
		const appdir = tempAppdir();
		const app = await makeApp({ appdir });
		const events: unknown[] = [];
		coreServices(app).broadcaster.subscribe((e) => e.type === 'titleLooks.changed' && events.push(e.payload));
		const empty = (await app.inject({ method: 'GET', url: '/api/title-looks', headers: H })).json();
		expect(empty).toEqual({ revision: 0, readOnly: false, looks: [] });

		const a = await saved(app, 'Gold');
		expect(a.id).toMatch(/^ulk_[0-9A-Z]{16}$/);
		expect(a.version).toBe(1);
		expect(a.createdAt).toBeTypeOf('string');

		const put = await app.inject({
			method: 'PUT',
			url: `/api/title-looks/${a.id}`,
			headers: JSON_H,
			payload: { name: 'Renamed', tags: ['mine'], category: 'luxury' },
		});
		expect(put.json()).toMatchObject({ name: 'Renamed', tags: ['mine'], category: 'luxury' });
		expect(events).toEqual([{ revision: 1 }, { revision: 2 }]);

		const file = appdirPaths(appdir).titleLooksFile;
		const onDisk = JSON.parse(readFileSync(file, 'utf8'));
		expect(onDisk).toMatchObject({ format: 'jasper-title-look-library', version: 1, revision: 2 });
		expect(onDisk.looks[0].name).toBe('Renamed');
		await app.close();

		const again = await makeApp({ appdir });
		const list = (await again.inject({ method: 'GET', url: '/api/title-looks', headers: H })).json();
		expect(list.revision).toBe(2);
		expect(list.looks).toHaveLength(1);
		const del = await again.inject({
			method: 'DELETE',
			url: `/api/title-looks/${a.id}`,
			headers: H,
		});
		expect(del.json()).toEqual({ ok: true, removed: a.id });
		expect((await again.inject({ method: 'GET', url: '/api/title-looks', headers: H })).json().looks).toEqual(
			[],
		);
	});

	it('refuses an invalid recipe, a duplicate name and an unknown id', async () => {
		const app = await makeApp();
		await saved(app, 'Taken');
		const bad = await app.inject({
			method: 'POST',
			url: '/api/title-looks',
			headers: JSON_H,
			payload: { name: 'X', recipe: { layers: [{ type: 'nope' }] } },
		});
		expect(bad.statusCode).toBe(400);
		expect(bad.json().error?.code ?? bad.json().code).toBe('LOOK_INVALID');
		const dup = await app.inject({
			method: 'POST',
			url: '/api/title-looks',
			headers: JSON_H,
			payload: { name: 'taken', recipe },
		});
		expect(dup.statusCode).toBe(409);
		const none = await app.inject({
			method: 'PUT',
			url: '/api/title-looks/ulk_0000000000000000',
			headers: JSON_H,
			payload: { name: 'Y' },
		});
		expect(none.statusCode).toBe(404);
	});

	it('round-trips through export and import: new ids, free names, bad entries reported', async () => {
		const app = await makeApp();
		const a = await saved(app, 'Gold');
		const exported = (
			await app.inject({ method: 'POST', url: '/api/title-looks/export', headers: JSON_H, payload: {} })
		).json();
		expect(exported).toMatchObject({ format: 'jasper-title-looks', version: 1 });
		expect(exported.looks).toHaveLength(1);
		exported.looks.push({ name: 'Broken', recipe: { layers: [{ type: 'nope' }] } }, 'not an object');
		const imported = await app.inject({
			method: 'POST',
			url: '/api/title-looks/import',
			headers: JSON_H,
			payload: { file: exported },
		});
		const body = imported.json();
		expect(body.looks).toHaveLength(1);
		expect(body.looks[0].id).not.toBe(a.id);
		expect(body.looks[0].name).toBe('Gold (2)');
		expect(body.looks[0].recipe).toEqual(a.recipe);
		expect(body.errors.map((e: { index: number }) => e.index)).toEqual([1, 2]);
	});

	it('exports a chosen look and refuses an unknown one', async () => {
		const app = await makeApp();
		const a = await saved(app, 'One');
		await saved(app, 'Two');
		const one = await app.inject({
			method: 'POST',
			url: '/api/title-looks/export',
			headers: JSON_H,
			payload: { ids: [a.id] },
		});
		expect(one.json().looks.map((l: { name: string }) => l.name)).toEqual(['One']);
		const none = await app.inject({
			method: 'POST',
			url: '/api/title-looks/export',
			headers: JSON_H,
			payload: { ids: ['ulk_0000000000000000'] },
		});
		expect(none.statusCode).toBe(404);
	});

	it('refuses an import with nothing usable, changing nothing', async () => {
		const app = await makeApp();
		const r = await app.inject({
			method: 'POST',
			url: '/api/title-looks/import',
			headers: JSON_H,
			payload: { file: { hello: 1 } },
		});
		expect(r.statusCode).toBe(400);
		expect((await app.inject({ method: 'GET', url: '/api/title-looks', headers: H })).json().revision).toBe(
			0,
		);
	});

	it('keeps entries that no longer validate aside, and writes them back', async () => {
		const appdir = tempAppdir();
		const file = appdirPaths(appdir).titleLooksFile;
		mkdirSync(dirname(file), { recursive: true });
		const broken = {
			id: 'ulk_ZZZZZZZZZZZZZZZZ',
			name: 'From the future',
			recipe: { layers: [{ type: 'hologram' }] },
		};
		writeFileSync(
			file,
			JSON.stringify({ format: 'jasper-title-look-library', version: 1, revision: 4, looks: [broken] }),
		);
		const app = await makeApp({ appdir });
		const list = (await app.inject({ method: 'GET', url: '/api/title-looks', headers: H })).json();
		expect(list.looks).toEqual([]);
		await saved(app, 'New');
		const onDisk = JSON.parse(readFileSync(file, 'utf8'));
		expect(onDisk.invalid).toEqual([broken]);
		expect(onDisk.revision).toBe(5);
	});

	it('moves an unreadable file aside and starts empty', async () => {
		const appdir = tempAppdir();
		const file = appdirPaths(appdir).titleLooksFile;
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, '{not json');
		const app = await makeApp({ appdir });
		expect((await app.inject({ method: 'GET', url: '/api/title-looks', headers: H })).json().looks).toEqual(
			[],
		);
		expect(readdirSync(dirname(file)).some((f) => f.includes('.corrupt-'))).toBe(true);
	});

	for (const [what, value] of [
		[
			'looks that is not a list',
			{ format: 'jasper-title-look-library', version: 1, revision: 3, looks: { a: 1 } },
		],
		['another object', { hello: 'world', looks: [] }],
		['a list', [{ name: 'x' }]],
		[
			'invalid entries that are not a list',
			{ format: 'jasper-title-look-library', version: 1, looks: [], invalid: 5 },
		],
		['an unreadable version', { format: 'jasper-title-look-library', version: 'one', looks: [] }],
	] as const)
		it(`moves valid JSON of the wrong shape (${what}) aside before a save could overwrite it`, async () => {
			const appdir = tempAppdir();
			const file = appdirPaths(appdir).titleLooksFile;
			mkdirSync(dirname(file), { recursive: true });
			const text = JSON.stringify(value);
			writeFileSync(file, text);
			const app = await makeApp({ appdir });
			const list = (await app.inject({ method: 'GET', url: '/api/title-looks', headers: H })).json();
			expect(list.looks).toEqual([]);
			expect(list.movedAside).toMatch(/title-looks\.json\.corrupt-\d+$/);
			await saved(app, 'New');
			// The file that could not be read is kept byte for byte; the new library is a separate file.
			expect(readFileSync(list.movedAside, 'utf8')).toBe(text);
			expect(JSON.parse(readFileSync(file, 'utf8')).looks.map((l: { name: string }) => l.name)).toEqual([
				'New',
			]);
		});

	it('answers 400 LOOK_TOO_DEEP to a body nested too deep to measure (a RangeError, a 500, on Node 20 and 22), on import and save', async () => {
		const app = await makeApp();
		const depth = 20_000;
		const deep = `${'['.repeat(depth)}${']'.repeat(depth)}`;
		const imp = await app.inject({
			method: 'POST',
			url: '/api/title-looks/import',
			headers: JSON_H,
			payload: `{"file":{"format":"jasper-title-looks","version":1,"looks":[{"name":"Deep","recipe":${deep}}]}}`,
		});
		expect([imp.statusCode, imp.json().code]).toEqual([400, 'LOOK_TOO_DEEP']);
		const save = await app.inject({
			method: 'POST',
			url: '/api/title-looks',
			headers: JSON_H,
			payload: `{"name":"Deep","recipe":{"layers":${deep}}}`,
		});
		expect([save.statusCode, save.json().code]).toEqual([400, 'LOOK_TOO_DEEP']);
		expect((await app.inject({ method: 'GET', url: '/api/title-looks', headers: H })).json().revision).toBe(
			0,
		);
	});

	it('never writes a newer library: it is read-only here', async () => {
		const appdir = tempAppdir();
		const file = appdirPaths(appdir).titleLooksFile;
		mkdirSync(dirname(file), { recursive: true });
		const text = JSON.stringify({ format: 'jasper-title-look-library', version: 99, revision: 1, looks: [] });
		writeFileSync(file, text);
		const app = await makeApp({ appdir });
		expect((await app.inject({ method: 'GET', url: '/api/title-looks', headers: H })).json().readOnly).toBe(
			true,
		);
		const r = await app.inject({
			method: 'POST',
			url: '/api/title-looks',
			headers: JSON_H,
			payload: { name: 'X', recipe },
		});
		expect(r.statusCode).toBe(409);
		expect(readFileSync(file, 'utf8')).toBe(text);
	});

	it('serializes concurrent saves: nothing is lost', async () => {
		const app = await makeApp();
		await Promise.all(Array.from({ length: 12 }, (_, i) => saved(app, `Look ${i}`)));
		const list = (await app.inject({ method: 'GET', url: '/api/title-looks', headers: H })).json();
		expect(list.looks).toHaveLength(12);
		expect(list.revision).toBe(12);
	});

	it('writes atomically: no temp file stays behind', async () => {
		const appdir = tempAppdir();
		const app = await makeApp({ appdir });
		await saved(app, 'One');
		const dir = dirname(appdirPaths(appdir).titleLooksFile);
		expect(readdirSync(dir).filter((f) => f.includes('title-looks'))).toEqual(['title-looks.json']);
	});
});

describe('the speech worker stays light', () => {
	// It starts per job, and per request for a forced probe: in development it transpiles what it imports, so the package root
	// costs about 7 s a start and grows with every feature, which leaves `POST /api/speech/probe` at the edge of its 10 s budget.
	const walk = (d: string): string[] =>
		readdirSync(d).flatMap((f) => {
			const p = join(d, f);
			return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
		});

	it('imports no package root of the model', () => {
		const speech = join(here, '..', 'src', 'speech');
		const files = [...walk(join(speech, 'worker')), ...walk(join(speech, 'core'))];
		expect(files.length).toBeGreaterThan(5);
		for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/from '@jasper\/project'/);
	});
});

describe('display fonts (TL-053)', () => {
	const manifest = DisplayFontManifestSchema.parse(
		JSON.parse(readFileSync(join(DISPLAY, 'manifest.json'), 'utf8')),
	);
	const fonts = new FontCatalogService({});

	it('pins a google/fonts commit and matches every file byte for byte', () => {
		expect(manifest.source).toBe('https://github.com/google/fonts');
		for (const f of manifest.families)
			for (const file of f.files) {
				const bytes = readFileSync(join(DISPLAY, f.id, 'files', file.file));
				expect(bytes.length, file.file).toBe(file.bytes);
				expect(createHash('sha256').update(bytes).digest('hex'), file.file).toBe(file.sha256);
				expect(file.upstream.startsWith('ofl/'), file.file).toBe(true);
			}
	});

	it('ships the OFL text with every family and credits it in ATTRIBUTION.md', () => {
		const attribution = readFileSync(join(ROOT, 'ATTRIBUTION.md'), 'utf8');
		for (const f of manifest.families) {
			expect(readFileSync(join(DISPLAY, f.id, 'OFL.txt'), 'utf8'), f.id).toContain('SIL OPEN FONT LICENSE');
			expect(attribution, f.family).toContain(`| ${f.family} |`);
		}
	});

	it('covers Latin and Japanese display styles', () => {
		expect(manifest.families.filter((f) => f.script === 'latin').length).toBeGreaterThanOrEqual(15);
		expect(manifest.families.filter((f) => f.script === 'japanese').length).toBeGreaterThanOrEqual(6);
	});

	it('lists them in the catalogue as bundled faces, with files the route serves', () => {
		const list = fonts.catalog().fonts;
		for (const f of manifest.families) {
			const fam = list.find((x) => x.family === f.family);
			expect(fam?.source, f.family).toBe('bundled');
			for (const file of fam!.files) {
				const path = fonts.filePath(file.url.replace(/^\/fonts\//, ''));
				expect(path && statSync(path).size, file.url).toBeGreaterThan(1000);
			}
		}
	});

	it('resolves a family by name, without falling back', () => {
		expect(fonts.resolve('Dela Gothic One', 400, false)).toMatchObject({ fallback: false });
		expect(fonts.resolve('Cinzel', 700, false)?.url).toContain('/fonts/cinzel/');
		expect(fonts.resolve('No Such Family', 400, false)?.fallback).toBe(true);
	});

	it('refuses paths outside the catalogue', () => {
		expect(fonts.filePath('anton/../../etc/passwd')).toBeNull();
		expect(fonts.filePath('anton/nope.ttf')).toBeNull();
		expect(fonts.filePath('anton/OFL.txt')).toBeNull();
	});

	it('serves a file over HTTP', async () => {
		const app = await makeApp();
		const r = await app.inject({ method: 'GET', url: '/fonts/anton/anton-regular.ttf', headers: H });
		expect(r.statusCode).toBe(200);
		expect(r.rawPayload.length).toBe(manifest.families.find((f) => f.id === 'anton')!.files[0]!.bytes);
	});

	it('bundles every face a factory look names, at its weight, with its fallback and Japanese face', () => {
		const has = (family: string, weight: number) => fonts.isBundledFace({ family, weight, style: 'normal' });
		const bundled = (who: string, f: LookFont) => {
			expect(has(f.family, f.weight ?? 400), `${who}: ${f.family} ${f.weight}`).toBe(true);
			if (f.fallback) expect(fonts.byFamily(f.fallback), `${who}: ${f.fallback}`).toBeTruthy();
			if (f.ja) expect(has(f.ja.family, f.ja.weight ?? 400), `${who}: ${f.ja.family}`).toBe(true);
		};
		for (const l of FACTORY_LOOKS) bundled(l.libraryId, l.recipe.font!);
		// A template's text names a library look, or (under a 3D solid) a bare face in a font of its own.
		for (const t of FACTORY_TEMPLATES)
			for (const c of t.clips)
				if (c.kind === 'text')
					if (typeof c.look === 'string') expect(factoryLook(c.look), `${t.id}: ${c.look}`).toBeTruthy();
					else bundled(`${t.id} ${c.slot}`, c.look.font);
	});

	it('finds the fonts in a packaged layout through JASPER_FONTS_DIR', () => {
		expect(existsSync(join(DISPLAY, 'manifest.json'))).toBe(true);
		const custom = new FontCatalogService({ JASPER_FONTS_DIR: join(here, '..', 'fonts') });
		expect(custom.byFamily('Anton')?.source).toBe('bundled');
	});
});
