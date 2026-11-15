// The style recipe library (spec 15 EA-010): `<appdir>/style-recipes/` with an index and one file per recipe, atomic
// writes, repair on load reported to the user (unreadable index → rebuilt from the files, a missing file → entry
// dropped, an unlisted file → adopted, an unreadable recipe → moved aside, never deleted), newer recipes read-only,
// a newer library read-only as a whole, built-ins never stored; and the HTTP routes (approval for agents' deletes).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinStyleRecipe, type StyleRecipe } from '@jasper/project';
import { afterAll, describe, expect, it } from 'vitest';
import { StyleRecipeLibrary } from '../src/style-recipes/library.ts';
import { closeApps, editorCookie, makeApp, TEST_HOST } from './helpers.ts';

const NOW = '2026-10-26T12:00:00.000Z';
const dirOf = () => join(mkdtempSync(join(tmpdir(), 'jasper-recipes-')), 'style-recipes');
const lib = (dir: string, onChange?: (r: number) => void) =>
	new StyleRecipeLibrary(dir, { now: () => NOW, ...(onChange ? { onChange } : {}) });
const base = (): Record<string, unknown> => {
	const { builtIn: _b, ...r } = builtinStyleRecipe('builtin:fast-shorts')!;
	return { ...r, name: 'Mine' };
};
const files = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

describe('StyleRecipeLibrary (persistence)', () => {
	it('creates, lists, updates, duplicates and removes with atomic files; built-ins are listed, never stored', async () => {
		const dir = dirOf();
		const seen: number[] = [];
		const l = lib(dir, (r) => seen.push(r));
		const empty = await l.list();
		expect(empty.recipes.filter((r) => r.source === 'builtin').map((r) => r.name)).toEqual([
			'Fast Shorts',
			'Fast Long-form',
			'Clean',
		]);
		expect(files(dir)).toEqual([]);
		const a = await l.create({ ...base(), id: 'builtin:fast-shorts' });
		expect(a.id).toMatch(/^rcp_[0-9A-Z]{16}$/);
		expect(a.recipe).toMatchObject({
			revision: 1,
			basedOn: 'builtin:fast-shorts',
			createdAt: NOW,
			name: 'Mine',
		});
		expect(files(dir)).toEqual(['index.json', `${a.id}.json`]);
		const b = await l.update(a.id, { name: 'Mine 2' });
		expect(b.recipe).toMatchObject({ revision: 2, name: 'Mine 2' });
		const c = await l.duplicate('builtin:clean');
		expect(c.recipe).toMatchObject({ name: 'Clean copy', basedOn: 'builtin:clean', revision: 1 });
		// a new instance reads the same
		const again = await lib(dir).list();
		expect(again.recipes.filter((r) => r.source === 'library').map((r) => r.name)).toEqual([
			'Clean copy',
			'Mine 2',
		]);
		expect(again.repairs).toEqual([]);
		await l.remove(c.id);
		expect(files(dir)).toEqual(['index.json', `${a.id}.json`]);
		expect(seen).toEqual([1, 2, 3, 4]);
		// no temp files left behind
		expect(files(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
	});

	it('refuses invalid recipes, unknown ids and changes to built-ins', async () => {
		const l = lib(dirOf());
		await expect(
			l.create({ ...base(), passes: { 'ken-burns': { enabled: true, params: { share: 5 } } } }),
		).rejects.toMatchObject({
			status: 400,
		});
		await expect(l.create({ ...base(), surprise: 1 })).rejects.toMatchObject({ status: 400 });
		await expect(l.update('rcp_0000000000000000', { name: 'x' })).rejects.toMatchObject({ status: 404 });
		await expect(l.update('builtin:clean', { name: 'x' })).rejects.toMatchObject({ status: 409 });
		await expect(l.remove('builtin:clean')).rejects.toMatchObject({ status: 409 });
		await expect(l.get('builtin:nope')).rejects.toMatchObject({ status: 404 });
	});

	it('repairs on load and reports it: unreadable index rebuilt, missing file dropped, unlisted file adopted, junk moved aside', async () => {
		const dir = dirOf();
		const l = lib(dir);
		const a = await l.create(base());
		const b = await l.create({ ...base(), name: 'Second' });
		// an orphan recipe file (a crash between the file and the index), a junk file, a missing one, a torn index
		const orphan = { ...(a.recipe as StyleRecipe), id: 'rcp_ZZZZZZZZZZZZZZZ1', name: 'Orphan' };
		writeFileSync(join(dir, `${orphan.id}.json`), JSON.stringify(orphan));
		writeFileSync(
			join(dir, 'rcp_ZZZZZZZZZZZZZZZ2.json'),
			'{"format":"jasper-style-recipe","version":1,"broken":',
		);
		writeFileSync(
			join(dir, 'rcp_ZZZZZZZZZZZZZZZ3.json'),
			JSON.stringify({ ...orphan, id: 'rcp_ZZZZZZZZZZZZZZZ3', passes: { nope: 1 } }),
		);
		const idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
		idx.recipes.push({ id: 'rcp_ZZZZZZZZZZZZZZZ4', file: 'rcp_ZZZZZZZZZZZZZZZ4.json', name: 'Gone' });
		writeFileSync(join(dir, 'index.json'), JSON.stringify(idx));
		const r = await lib(dir).list();
		const actions = r.repairs.map((x) => `${x.action}:${x.entity}`);
		expect(actions).toEqual(
			expect.arrayContaining([
				'drop-entry:rcp_ZZZZZZZZZZZZZZZ4',
				'adopt:rcp_ZZZZZZZZZZZZZZZ1',
				'set-aside:rcp_ZZZZZZZZZZZZZZZ2',
				'set-aside:rcp_ZZZZZZZZZZZZZZZ3',
			]),
		);
		expect(
			r.recipes
				.filter((x) => x.source === 'library')
				.map((x) => x.name)
				.sort(),
		).toEqual(['Mine', 'Orphan', 'Second']);
		// nothing deleted: the junk is kept aside
		expect(files(dir).filter((f) => f.includes('.invalid-')).length).toBe(2);
		// the repaired index was written: a fresh load repairs nothing
		expect((await lib(dir).list()).repairs).toEqual([]);
		// a torn index is moved aside and rebuilt from the files
		writeFileSync(join(dir, 'index.json'), '{"format":"jasper-style-recipe-library","rev');
		const t = await lib(dir).list();
		expect(t.repairs.map((x) => x.action)).toEqual(expect.arrayContaining(['rebuild-index', 'adopt']));
		expect(
			t.recipes
				.filter((x) => x.source === 'library')
				.map((x) => x.id)
				.sort(),
		).toEqual([a.id, b.id, orphan.id].sort());
		expect(files(dir).some((f) => f.startsWith('index.json.corrupt-'))).toBe(true);
	});

	it('keeps recipes of a newer JasperEditor read-only and a newer library read-only as a whole', async () => {
		const dir = dirOf();
		const l = lib(dir);
		const a = await l.create(base());
		const newer = {
			...(a.recipe as StyleRecipe),
			id: 'rcp_ZZZZZZZZZZZZZZZ5',
			name: 'Future',
			version: 7,
			futureField: [1],
		};
		const raw = JSON.stringify(newer);
		writeFileSync(join(dir, `${newer.id}.json`), raw);
		const l2 = lib(dir);
		const r = await l2.list();
		expect(r.recipes.find((x) => x.id === newer.id)).toMatchObject({
			newer: true,
			readOnly: true,
			name: 'Future',
		});
		await expect(l2.get(newer.id)).rejects.toMatchObject({ status: 409 });
		await expect(l2.update(newer.id, { name: 'x' })).rejects.toMatchObject({ status: 409 });
		expect(readFileSync(join(dir, `${newer.id}.json`), 'utf8')).toBe(raw);
		// a newer library index: listed, never written
		const idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
		const future = JSON.stringify({ ...idx, version: 3 });
		writeFileSync(join(dir, 'index.json'), future);
		const l3 = lib(dir);
		const ro = await l3.list();
		expect(ro.readOnly).toBe(true);
		expect(ro.recipes.filter((x) => x.source === 'library').every((x) => x.readOnly)).toBe(true);
		await expect(l3.create(base())).rejects.toMatchObject({ status: 409, code: 'LIBRARY_READ_ONLY' });
		await expect(l3.remove(a.id)).rejects.toMatchObject({ status: 409 });
		expect(readFileSync(join(dir, 'index.json'), 'utf8')).toBe(future);
	});

	it('serialises concurrent writes (every change one revision)', async () => {
		const dir = dirOf();
		const l = lib(dir);
		await Promise.all(Array.from({ length: 8 }, (_, i) => l.create({ ...base(), name: `R${i}` })));
		const r = await lib(dir).list();
		expect(r.revision).toBe(8);
		expect(r.recipes.filter((x) => x.source === 'library')).toHaveLength(8);
	});
});

describe('style recipe routes', { timeout: 120_000 }, () => {
	const TOKEN = 'tok_style_0123456789abcdef0123';
	const KEY = 'key_style_0123456789abcdef0123';
	const HOST = { host: TEST_HOST };
	const AGENT_H = {
		...HOST,
		authorization: `Bearer ${TOKEN}`,
		'x-jasper-agent': 'style-agent',
		'content-type': 'application/json',
	};
	const EDITOR_H = {
		...HOST,
		cookie: editorCookie(TOKEN, KEY),
		'content-type': 'application/json',
	};
	const noBody = (h: Record<string, string>) =>
		Object.fromEntries(Object.entries(h).filter(([k]) => k !== 'content-type'));
	afterAll(closeApps);

	it('list / create / get / update / duplicate; deletes ask an agent for approval; built-ins are read-only', async () => {
		const app = await makeApp({ token: TOKEN, editorKey: KEY });
		const list = await app.inject({ method: 'GET', url: '/api/style-recipes', headers: noBody(AGENT_H) });
		expect(list.statusCode).toBe(200);
		expect(list.json()).toMatchObject({ revision: 0, repairs: [], readOnly: false });
		const made = await app.inject({
			method: 'POST',
			url: '/api/style-recipes',
			headers: AGENT_H,
			payload: JSON.stringify({ recipe: base() }),
		});
		expect(made.statusCode, made.body).toBe(201);
		const id = (made.json() as { id: string }).id;
		const got = await app.inject({
			method: 'GET',
			url: `/api/style-recipes/${id}`,
			headers: noBody(AGENT_H),
		});
		expect(got.json()).toMatchObject({ id, name: 'Mine', source: 'library' });
		const up = await app.inject({
			method: 'PUT',
			url: `/api/style-recipes/${id}`,
			headers: AGENT_H,
			payload: JSON.stringify({ name: 'Renamed' }),
		});
		expect(up.json()).toMatchObject({ name: 'Renamed', recipe: { revision: 2 } });
		const dup = await app.inject({
			method: 'POST',
			url: '/api/style-recipes/builtin:fast-long-form/duplicate',
			headers: AGENT_H,
			payload: '{}',
		});
		expect(dup.statusCode).toBe(201);
		expect(dup.json()).toMatchObject({ name: 'Fast Long-form copy' });
		const bad = await app.inject({
			method: 'POST',
			url: '/api/style-recipes',
			headers: AGENT_H,
			payload: JSON.stringify({ recipe: base(), extra: 1 }),
		});
		expect(bad.statusCode).toBe(400);
		const del = await app.inject({
			method: 'DELETE',
			url: `/api/style-recipes/${id}`,
			headers: noBody(AGENT_H),
		});
		expect(del.statusCode).toBe(403);
		expect(del.json()).toMatchObject({ code: 'APPROVAL_DENIED', detail: { code: 'E_APPROVAL_DENIED' } });
		const builtin = await app.inject({
			method: 'DELETE',
			url: '/api/style-recipes/builtin:clean',
			headers: noBody(EDITOR_H),
		});
		expect(builtin.statusCode).toBe(409);
		const ok = await app.inject({
			method: 'DELETE',
			url: `/api/style-recipes/${id}`,
			headers: noBody(EDITOR_H),
		});
		expect(ok.json()).toEqual({ ok: true, removed: id });
		expect(existsSync(join(app.appdir, 'style-recipes', `${id}.json`))).toBe(false);
		mkdirSync(join(app.appdir, 'style-recipes'), { recursive: true });
	});
});
