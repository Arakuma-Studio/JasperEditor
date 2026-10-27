// EngineClient personal glossary calls (spec 17 SC-070 / SC-071): methods, paths and bodies; responses are validated;
// refusals become EngineErrors with the engine's code.
import { describe, expect, it } from 'vitest';
import { EngineClient, EngineError } from '../src/index.ts';

const NOW = '2026-10-27T10:00:00.000Z';
const ENTRY = {
	id: 'gle_0000000000000001',
	from: ['nova play'],
	to: 'NovaPlay',
	count: 1,
	createdAt: NOW,
	updatedAt: NOW,
};

function client(handler: (method: string, url: string) => Response) {
	const calls: Array<{ method: string; url: string; body?: unknown }> = [];
	const c = new EngineClient({
		baseUrl: 'http://e',
		token: 't',
		fetch: async (input, init) => {
			const method = init?.method ?? 'GET';
			calls.push({
				method,
				url: String(input),
				...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
			});
			return handler(method, String(input));
		},
	});
	return { c, calls };
}

const json = (v: unknown, status = 200) =>
	new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

describe('EngineClient glossary', () => {
	it('calls every glossary route with its method, path and body', async () => {
		const lib = {
			revision: 3,
			readOnly: false,
			repairs: [],
			limits: { maxEntries: 2000, maxSpellings: 20, maxChars: 64 },
			entries: [ENTRY],
		};
		const saved = { revision: 4, created: false, changed: true, entry: ENTRY };
		const { c, calls } = client((method, url) => {
			if (url.endsWith('/export'))
				return json({ format: 'jasper-speech-glossary', version: 1, revision: 3, entries: [ENTRY] });
			if (url.endsWith('/import')) return json({ revision: 5, added: 1, merged: 0, unchanged: 0, skipped: [] });
			if (method === 'DELETE') return json({ ok: true, removed: ENTRY.id, revision: 6 });
			if (method === 'PUT') return json({ revision: 7, entry: ENTRY });
			if (method === 'POST') return json(saved, url.endsWith('/remember') ? 200 : 201);
			if (url.endsWith(ENTRY.id)) return json(ENTRY);
			return json(lib);
		});
		expect((await c.listGlossary()).entries[0]!.to).toBe('NovaPlay');
		expect((await c.getGlossaryEntry(ENTRY.id)).id).toBe(ENTRY.id);
		expect((await c.saveGlossaryEntry({ from: ['nova play'], to: 'NovaPlay', lang: 'es' })).changed).toBe(true);
		expect((await c.rememberGlossaryEntry({ from: ['novaplei'], to: 'NovaPlay' })).entry.count).toBe(1);
		expect((await c.updateGlossaryEntry(ENTRY.id, { lang: null })).revision).toBe(7);
		expect(await c.removeGlossaryEntry(ENTRY.id)).toEqual({ ok: true, removed: ENTRY.id, revision: 6 });
		expect((await c.importGlossary([{ to: 'Glimmerbox' }])).added).toBe(1);
		expect((await c.exportGlossary()).format).toBe('jasper-speech-glossary');
		expect(calls).toEqual([
			{ method: 'GET', url: 'http://e/api/speech/glossary' },
			{ method: 'GET', url: `http://e/api/speech/glossary/${ENTRY.id}` },
			{
				method: 'POST',
				url: 'http://e/api/speech/glossary',
				body: { from: ['nova play'], to: 'NovaPlay', lang: 'es' },
			},
			{ method: 'POST', url: 'http://e/api/speech/glossary/remember', body: { from: ['novaplei'], to: 'NovaPlay' } },
			{ method: 'PUT', url: `http://e/api/speech/glossary/${ENTRY.id}`, body: { lang: null } },
			{ method: 'DELETE', url: `http://e/api/speech/glossary/${ENTRY.id}` },
			{ method: 'POST', url: 'http://e/api/speech/glossary/import', body: { file: [{ to: 'Glimmerbox' }] } },
			{ method: 'GET', url: 'http://e/api/speech/glossary/export' },
		]);
	});

	it('refusals and invalid responses become EngineErrors', async () => {
		const { c } = client((method) =>
			method === 'POST'
				? json({ code: 'GLOSSARY_READ_ONLY', message: 'read-only', retryable: false }, 409)
				: json({ revision: 0, entries: 'nope' }),
		);
		await expect(c.saveGlossaryEntry({ from: [], to: 'X1' })).rejects.toMatchObject({
			code: 'GLOSSARY_READ_ONLY',
			status: 409,
		});
		const e = await c.listGlossary().catch((x: unknown) => x);
		expect(e).toBeInstanceOf(EngineError);
		expect((e as EngineError).code).toBe('INVALID_RESPONSE');
	});
});
