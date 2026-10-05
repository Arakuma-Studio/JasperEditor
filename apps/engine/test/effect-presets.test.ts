// The user effect preset library (S03:FX-030, AGT-020): `<appdir>/presets/effect-presets.json`, shared by projects,
// sessions, editor windows and agents. CRUD, bins (nested, recursive delete, no cycles), import, validation, the
// change event, persistence across engine restarts, and unknown effect ids / fields kept verbatim.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { appdirPaths } from '@jasper/config';
import { buildPresetBundle, builtinEffectPreset, type EffectPreset } from '@jasper/project';
import { afterAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, H, JSON_H, makeApp, tempAppdir } from './helpers.ts';

afterAll(closeApps);

const fadeIn = () => JSON.parse(JSON.stringify(builtinEffectPreset('builtin.fade-in'))) as EffectPreset;

describe('effect preset library (FX-030)', () => {
	it('saves, lists, edits, deletes and persists across restarts', async () => {
		const appdir = tempAppdir();
		const app = await makeApp({ appdir });
		const events: unknown[] = [];
		coreServices(app).broadcaster.subscribe(
			(e) => e.type === 'effectPresets.changed' && events.push(e.payload),
		);
		const empty = (await app.inject({ method: 'GET', url: '/api/effect-presets', headers: H })).json();
		expect(empty).toEqual({ revision: 0, folders: [], presets: [] });

		const created = await app.inject({
			method: 'POST',
			url: '/api/effect-presets',
			headers: JSON_H,
			payload: { preset: { ...fadeIn(), name: 'My Fade', futureField: 7 } },
		});
		expect(created.statusCode).toBe(201);
		const p = created.json();
		expect(p.id).toMatch(/^fxp_[0-9A-Z]{16}$/);
		expect(p).toMatchObject({ name: 'My Fade', type: 'anchor-in', futureField: 7 });
		expect(p.builtIn).toBeUndefined();
		expect(p.createdAt).toBeTypeOf('string');

		const bin = (
			await app.inject({
				method: 'POST',
				url: '/api/effect-presets/folders',
				headers: JSON_H,
				payload: { name: 'Mine' },
			})
		).json();
		const upd = await app.inject({
			method: 'PUT',
			url: `/api/effect-presets/${p.id}`,
			headers: JSON_H,
			payload: { name: 'Renamed', type: 'scale', description: 'hello', folderId: bin.id },
		});
		expect(upd.json()).toMatchObject({
			name: 'Renamed',
			type: 'scale',
			description: 'hello',
			folderId: bin.id,
		});
		expect(events).toEqual([{ revision: 1 }, { revision: 2 }, { revision: 3 }]);

		// Persisted on disk (pretty JSON) and reloaded by a new engine on the same appdir.
		const file = appdirPaths(appdir).effectPresetsFile;
		expect(JSON.parse(readFileSync(file, 'utf8')).presets[0].name).toBe('Renamed');
		await app.close();
		const again = await makeApp({ appdir });
		const list = (await again.inject({ method: 'GET', url: '/api/effect-presets', headers: H })).json();
		expect(list.revision).toBe(3);
		expect(list.presets.map((x: EffectPreset) => x.name)).toEqual(['Renamed']);
		expect(list.folders.map((x: { name: string }) => x.name)).toEqual(['Mine']);

		const del = await again.inject({ method: 'DELETE', url: `/api/effect-presets/${p.id}`, headers: H });
		expect(del.json()).toEqual({ ok: true, removedPresets: [p.id], removedFolders: [] });
		expect(
			(await again.inject({ method: 'DELETE', url: `/api/effect-presets/${p.id}`, headers: H })).statusCode,
		).toBe(404);
	});

	it('validates presets and protects built-ins', async () => {
		const app = await makeApp();
		const bad = await app.inject({
			method: 'POST',
			url: '/api/effect-presets',
			headers: JSON_H,
			payload: { preset: { ...fadeIn(), type: 'sideways' } },
		});
		expect(bad.statusCode).toBe(400);
		expect(bad.json().code).toBe('PRESET_INVALID');
		const builtin = await app.inject({
			method: 'PUT',
			url: '/api/effect-presets/builtin.fade-in',
			headers: JSON_H,
			payload: { name: 'x' },
		});
		expect(builtin.statusCode).toBe(404);
		expect(builtin.json().message).toMatch(/read-only/);
		// Unknown effect ids are kept as they are.
		const odd = (
			await app.inject({
				method: 'POST',
				url: '/api/effect-presets',
				headers: JSON_H,
				payload: {
					preset: { ...fadeIn(), effects: [{ effectId: 'acme.glow', params: { a: { value: 1 } } }] },
				},
			})
		).json();
		expect(odd.effects).toEqual([{ effectId: 'acme.glow', params: { a: { value: 1 } } }]);
		// Unknown bins are refused.
		const noBin = await app.inject({
			method: 'POST',
			url: '/api/effect-presets',
			headers: JSON_H,
			payload: { preset: fadeIn(), folderId: 'fxb_NOPE' },
		});
		expect(noBin.statusCode).toBe(404);
	});

	it('nests bins, refuses cycles, deletes a bin with its contents', async () => {
		const app = await makeApp();
		const mk = async (name: string, parentId?: string) =>
			(
				await app.inject({
					method: 'POST',
					url: '/api/effect-presets/folders',
					headers: JSON_H,
					payload: { name, ...(parentId ? { parentId } : {}) },
				})
			).json() as { id: string };
		const a = await mk('A');
		const b = await mk('B', a.id);
		const cycle = await app.inject({
			method: 'PUT',
			url: `/api/effect-presets/folders/${a.id}`,
			headers: JSON_H,
			payload: { parentId: b.id },
		});
		expect(cycle.statusCode).toBe(400);
		const inB = (
			await app.inject({
				method: 'POST',
				url: '/api/effect-presets',
				headers: JSON_H,
				payload: { preset: fadeIn(), folderId: b.id },
			})
		).json();
		const root = (
			await app.inject({
				method: 'POST',
				url: '/api/effect-presets',
				headers: JSON_H,
				payload: { preset: fadeIn() },
			})
		).json();
		const del = (
			await app.inject({ method: 'DELETE', url: `/api/effect-presets/folders/${a.id}`, headers: H })
		).json();
		expect(del.removedFolders.sort()).toEqual([a.id, b.id].sort());
		expect(del.removedPresets).toEqual([inB.id]);
		const list = (await app.inject({ method: 'GET', url: '/api/effect-presets', headers: H })).json();
		expect(list.presets.map((x: EffectPreset) => x.id)).toEqual([root.id]);
		expect(list.folders).toEqual([]);
	});

	it('imports bundles with their bins (new ids) and reports invalid entries', async () => {
		const app = await makeApp();
		const p1 = { ...fadeIn(), id: 'fxp_SRC1', folderId: 'b2' };
		const bundle = buildPresetBundle(
			[p1],
			[
				{ id: 'b1', name: 'Shared', parentId: null },
				{ id: 'b2', name: 'Fades', parentId: 'b1' },
			],
		);
		const r = await app.inject({
			method: 'POST',
			url: '/api/effect-presets/import',
			headers: JSON_H,
			payload: {
				file: { ...bundle, presets: [...bundle.presets, { format: 'jasper-effect-preset', name: 'broken' }] },
			},
		});
		expect(r.statusCode).toBe(200);
		const out = r.json();
		expect(out.presets).toHaveLength(1);
		expect(out.presets[0].id).not.toBe('fxp_SRC1');
		expect(out.errors).toEqual([{ index: 1, message: expect.any(String) }]);
		const fades = out.folders.find((f: { name: string }) => f.name === 'Fades');
		const shared = out.folders.find((f: { name: string }) => f.name === 'Shared');
		expect(fades.parentId).toBe(shared.id);
		expect(out.presets[0].folderId).toBe(fades.id);
		const nothing = await app.inject({
			method: 'POST',
			url: '/api/effect-presets/import',
			headers: JSON_H,
			payload: { file: { format: 'something-else' } },
		});
		expect(nothing.statusCode).toBe(400);
	});

	it('keeps an unreadable library aside and invalid entries in the file', async () => {
		const appdir = tempAppdir();
		const file = appdirPaths(appdir).effectPresetsFile;
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, '{not json');
		const app = await makeApp({ appdir });
		expect(
			(await app.inject({ method: 'GET', url: '/api/effect-presets', headers: H })).json().presets,
		).toEqual([]);
		expect(readdirSync(dirname(file)).some((n) => n.startsWith('effect-presets.json.corrupt-'))).toBe(true);
		await app.close();
		writeFileSync(
			file,
			JSON.stringify({
				format: 'jasper-effect-preset-library',
				version: 1,
				revision: 4,
				folders: [],
				presets: [fadeIn(), { junk: true }],
			}),
		);
		const again = await makeApp({ appdir });
		const list = (await again.inject({ method: 'GET', url: '/api/effect-presets', headers: H })).json();
		expect(list.presets).toHaveLength(1);
		await again.inject({
			method: 'POST',
			url: '/api/effect-presets/folders',
			headers: JSON_H,
			payload: { name: 'X' },
		});
		expect(JSON.parse(readFileSync(file, 'utf8')).invalid).toEqual([{ junk: true }]);
	});
});
