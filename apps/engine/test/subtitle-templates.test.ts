// spec 13 AS-020: the user subtitle template library (atomic, validated, repaired on open, newer files read-only).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { appdirPaths } from '@jasper/config';
import { builtinSubtitleTemplate, type SubtitleTemplate } from '@jasper/project';
import { afterAll, describe, expect, it } from 'vitest';
import { coreServices } from '../src/tools/services.ts';
import { closeApps, H, JSON_H, makeApp, tempAppdir } from './helpers.ts';

afterAll(closeApps);

const pop = (id: string, name = 'Mine'): SubtitleTemplate => ({
	...(JSON.parse(JSON.stringify(builtinSubtitleTemplate('builtin:pixel-pop'))) as SubtitleTemplate),
	id,
	name,
	builtIn: undefined as never,
});

describe('subtitle template library (AS-020)', () => {
	it('saves, replaces, lists, deletes and persists across restarts', async () => {
		const appdir = tempAppdir();
		const app = await makeApp({ appdir });
		const events: unknown[] = [];
		coreServices(app).broadcaster.subscribe(
			(e) => e.type === 'subtitleTemplates.changed' && events.push(e.payload),
		);
		expect((await app.inject({ method: 'GET', url: '/api/subtitle-templates', headers: H })).json()).toEqual({
			revision: 0,
			templates: [],
		});
		const saved = await app.inject({
			method: 'PUT',
			url: '/api/subtitle-templates/stm_A',
			headers: JSON_H,
			payload: { template: { ...pop('ignored'), futureField: 3 } },
		});
		expect(saved.statusCode).toBe(200);
		expect(saved.json()).toMatchObject({ id: 'stm_A', name: 'Mine', futureField: 3 });
		expect(saved.json().builtIn).toBeUndefined();
		const again = await app.inject({
			method: 'PUT',
			url: '/api/subtitle-templates/stm_A',
			headers: JSON_H,
			payload: { template: pop('stm_A', 'Renamed') },
		});
		expect(again.json().createdAt).toBe(saved.json().createdAt);
		expect(events).toEqual([{ revision: 1 }, { revision: 2 }]);
		const file = appdirPaths(appdir).subtitleTemplatesFile;
		expect(JSON.parse(readFileSync(file, 'utf8')).templates.map((t: SubtitleTemplate) => t.name)).toEqual([
			'Renamed',
		]);
		await app.close();
		const next = await makeApp({ appdir });
		const list = (await next.inject({ method: 'GET', url: '/api/subtitle-templates', headers: H })).json();
		expect(list.revision).toBe(2);
		const del = await next.inject({ method: 'DELETE', url: '/api/subtitle-templates/stm_A', headers: H });
		expect(del.json()).toEqual({ ok: true, removed: 'stm_A' });
		expect(
			(await next.inject({ method: 'DELETE', url: '/api/subtitle-templates/stm_A', headers: H })).statusCode,
		).toBe(404);
	});

	it('refuses invalid templates and built-in ids', async () => {
		const app = await makeApp({ appdir: tempAppdir() });
		const bad = await app.inject({
			method: 'PUT',
			url: '/api/subtitle-templates/stm_B',
			headers: JSON_H,
			payload: { template: { format: 'jasper-subtitle-template', version: 1, name: 'x' } },
		});
		expect(bad.statusCode).toBe(400);
		const builtin = await app.inject({
			method: 'PUT',
			url: '/api/subtitle-templates/builtin:pixel-pop',
			headers: JSON_H,
			payload: { template: pop('x') },
		});
		expect(builtin.statusCode).toBe(404);
	});

	it('keeps an unreadable library aside, invalid entries in the file, newer libraries read-only', async () => {
		const appdir = tempAppdir();
		const file = appdirPaths(appdir).subtitleTemplatesFile;
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, '{not json');
		const app = await makeApp({ appdir });
		expect(
			(await app.inject({ method: 'GET', url: '/api/subtitle-templates', headers: H })).json().templates,
		).toEqual([]);
		expect(readdirSync(dirname(file)).some((n) => n.startsWith('subtitle-templates.json.corrupt-'))).toBe(
			true,
		);
		await app.close();
		writeFileSync(
			file,
			JSON.stringify({
				format: 'jasper-subtitle-template-library',
				version: 1,
				revision: 4,
				templates: [pop('stm_C'), { junk: true }],
			}),
		);
		const two = await makeApp({ appdir });
		expect(
			(await two.inject({ method: 'GET', url: '/api/subtitle-templates', headers: H })).json().templates,
		).toHaveLength(1);
		await two.inject({
			method: 'PUT',
			url: '/api/subtitle-templates/stm_D',
			headers: JSON_H,
			payload: { template: pop('stm_D') },
		});
		expect(JSON.parse(readFileSync(file, 'utf8')).invalid).toEqual([{ junk: true }]);
		await two.close();
		writeFileSync(
			file,
			JSON.stringify({ format: 'jasper-subtitle-template-library', version: 9, revision: 1, templates: [] }),
		);
		const three = await makeApp({ appdir });
		const w = await three.inject({
			method: 'PUT',
			url: '/api/subtitle-templates/stm_E',
			headers: JSON_H,
			payload: { template: pop('stm_E') },
		});
		expect(w.statusCode).toBe(409);
	});
});
