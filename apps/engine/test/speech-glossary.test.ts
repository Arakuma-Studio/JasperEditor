// Spec 17 SC-070: the personal speech glossary on the engine — the library (atomic writes, restart, corrupt file
// moved aside and reported, entries kept aside, newer version read-only, caps, a failed write changes nothing) and
// the routes (zod refusals, merge by target, Remember, edit, export/import round trip, the change event, and the
// user's approval for an agent's delete or lossy edit).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	AGENT_NAME_HEADER,
	GlossaryImportResponseSchema,
	GlossaryLibraryResponseSchema,
	GlossarySaveResponseSchema,
} from '@jasper/api';
import { appdirPaths } from '@jasper/config';
import {
	createCounterIdSource,
	createEmptyProject,
	GLOSSARY_LIMITS,
	GlossaryFileSchema,
	glossaryIdFrom,
	makeEnvelope,
} from '@jasper/project';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { SpeechGlossary } from '../src/speech/glossary.ts';
import * as fsTools from '../src/tools/fs.ts';
import { closeApps, H, JSON_H, makeApp, tempAppdir } from './helpers.ts';

vi.mock('../src/tools/fs.ts', async (importOriginal) => {
	const m = await importOriginal<typeof import('../src/tools/fs.ts')>();
	return { ...m, atomicWriteJson: vi.fn(m.atomicWriteJson) };
});

afterEach(async () => {
	await closeApps();
	vi.mocked(fsTools.atomicWriteJson).mockClear();
});

const NOW = '2026-10-27T10:00:00.000Z';
const fileIn = (dir: string) => join(dir, 'speech', 'glossary.json');
const id = (n: number) =>
	glossaryIdFrom(Array.from({ length: 16 }, (_, i) => (i >= 13 ? n >> (5 * (15 - i)) : 0)));
const entry = (n: number, extra: Record<string, unknown> = {}) => ({
	id: id(n),
	from: [`name ${n} wrong`],
	to: `Name ${n}`,
	count: 0,
	createdAt: NOW,
	updatedAt: NOW,
	...extra,
});
const writeFile = (dir: string, value: unknown) => {
	mkdirSync(join(dir, 'speech'), { recursive: true });
	writeFileSync(fileIn(dir), typeof value === 'string' ? value : JSON.stringify(value));
};

describe('SpeechGlossary (library)', () => {
	it('saves atomically, survives a restart and announces each change once', async () => {
		const dir = tempAppdir('jasper-glossary-');
		const changes: number[] = [];
		const g = new SpeechGlossary(fileIn(dir), { onChange: (r) => changes.push(r) });
		expect(await g.list()).toMatchObject({ revision: 0, readOnly: false, repairs: [], entries: [] });
		const a = await g.save({ from: ['nova play'], to: 'NovaPlay', lang: 'es' });
		expect(a).toMatchObject({ revision: 1, created: true, changed: true });
		expect(a.entry.id).toMatch(/^gle_[0-9A-Z]{16}$/);
		// saving the same again writes nothing
		expect(await g.save({ from: ['Nova Play'], to: 'NovaPlay', lang: 'es' })).toMatchObject({
			revision: 1,
			changed: false,
		});
		const r = await g.save({ from: ['novaplei'], to: 'NovaPlay', lang: 'es' }, true);
		expect(r.entry).toMatchObject({ from: ['nova play', 'novaplei'], count: 1 });
		expect(changes).toEqual([1, 2]);
		expect(fsTools.atomicWriteJson).toHaveBeenCalledTimes(2);
		// the file is complete, valid and nothing temporary is left behind
		const saved = GlossaryFileSchema.parse(JSON.parse(readFileSync(fileIn(dir), 'utf8')));
		expect(saved.revision).toBe(2);
		expect(readdirSync(join(dir, 'speech'))).toEqual(['glossary.json']);
		const reopened = await new SpeechGlossary(fileIn(dir)).list();
		expect(reopened.entries).toEqual(saved.entries);
		expect(reopened.revision).toBe(2);
	});

	it('a failed write changes nothing: the file, the revision and the listing stay as they were', async () => {
		const dir = tempAppdir('jasper-glossary-');
		const g = new SpeechGlossary(fileIn(dir));
		await g.save({ from: ['glimer box'], to: 'Glimmerbox' });
		const before = readFileSync(fileIn(dir), 'utf8');
		vi.mocked(fsTools.atomicWriteJson).mockRejectedValueOnce(
			Object.assign(new Error('no space'), { code: 'ENOSPC', syscall: 'write' }),
		);
		await expect(g.save({ from: ['pixel forge'], to: 'Pixelforge' })).rejects.toThrow('no space');
		expect(readFileSync(fileIn(dir), 'utf8')).toBe(before);
		const l = await g.list();
		expect(l.revision).toBe(1);
		expect(l.entries.map((e) => e.to)).toEqual(['Glimmerbox']);
		// the next write works and continues from the stored revision
		expect((await g.save({ from: ['pixel forge'], to: 'Pixelforge' })).revision).toBe(2);
	});

	it('moves an unreadable file aside, reports it and starts empty', async () => {
		for (const bad of ['{not json', '[1,2]', JSON.stringify({ format: 'other', version: 1, entries: [] })]) {
			const dir = tempAppdir('jasper-glossary-');
			writeFile(dir, bad);
			const g = new SpeechGlossary(fileIn(dir));
			const l = await g.list();
			expect(l.entries).toEqual([]);
			expect(l.repairs).toHaveLength(1);
			expect(l.repairs[0]).toMatch(/unreadable; it was moved aside as glossary\.json\.corrupt-\d+/);
			const aside = readdirSync(join(dir, 'speech')).find((n) => n.startsWith('glossary.json.corrupt-'))!;
			expect(readFileSync(join(dir, 'speech', aside), 'utf8')).toBe(bad);
			await g.save({ from: [], to: 'Glimmerbox' });
			expect(GlossaryFileSchema.parse(JSON.parse(readFileSync(fileIn(dir), 'utf8'))).entries).toHaveLength(1);
		}
	});

	it('keeps invalid, duplicate and over-the-cap entries aside in the file and reports them', async () => {
		const dir = tempAppdir('jasper-glossary-');
		const entries = [
			entry(1),
			entry(2, { to: '  bad spacing' }),
			entry(1, { to: 'Same id' }),
			entry(3, { to: 'Name 1' }),
			...Array.from({ length: GLOSSARY_LIMITS.maxEntries }, (_, i) => entry(10 + i)),
		];
		writeFile(dir, { format: 'jasper-speech-glossary', version: 1, revision: 9, entries });
		const g = new SpeechGlossary(fileIn(dir));
		const l = await g.list();
		expect(l.revision).toBe(9);
		expect(l.entries).toHaveLength(GLOSSARY_LIMITS.maxEntries);
		expect(l.repairs).toEqual([
			expect.stringContaining('3 glossary entries that no longer validate were kept aside'),
			expect.stringContaining('1 entry over the limit of 2000 was kept aside'),
		]);
		await g.remove(id(1));
		const saved = JSON.parse(readFileSync(fileIn(dir), 'utf8'));
		expect(saved.invalid).toHaveLength(4);
		expect(saved.entries).toHaveLength(GLOSSARY_LIMITS.maxEntries - 1);
		expect(saved.revision).toBe(10);
	});

	it('a file written by a newer version is listed but never written', async () => {
		const dir = tempAppdir('jasper-glossary-');
		const raw = JSON.stringify({
			format: 'jasper-speech-glossary',
			version: 2,
			revision: 4,
			entries: [entry(1, { future: { x: 1 } }), { what: 'unknown' }],
			future: true,
		});
		writeFile(dir, raw);
		const g = new SpeechGlossary(fileIn(dir));
		const l = await g.list();
		expect(l.readOnly).toBe(true);
		expect(l.entries.map((e) => e.to)).toEqual(['Name 1']);
		expect(l.entries[0]).not.toHaveProperty('future');
		expect(l.repairs[0]).toMatch(/newer JasperEditor \(version 2\); it is read-only here/);
		for (const write of [
			() => g.save({ from: [], to: 'X1' }),
			() => g.save({ from: [], to: 'X1' }, true),
			() => g.update(id(1), { lang: 'es' }),
			() => g.remove(id(1)),
			() => g.import([{ to: 'X2' }]),
		])
			await expect(write()).rejects.toMatchObject({ status: 409, code: 'GLOSSARY_READ_ONLY' });
		expect(readFileSync(fileIn(dir), 'utf8')).toBe(raw);
		expect(fsTools.atomicWriteJson).not.toHaveBeenCalled();
		// the export still works (known fields only)
		expect((await g.exportFile()).entries).toHaveLength(1);
	});

	it('maps refusals of the rules to route errors', async () => {
		const dir = tempAppdir('jasper-glossary-');
		const g = new SpeechGlossary(fileIn(dir));
		await expect(g.save({ from: [], to: '   ' })).rejects.toMatchObject({
			status: 400,
			code: 'GLOSSARY_INVALID',
		});
		await expect(g.save({ from: [], to: 'x'.repeat(65) })).rejects.toMatchObject({ status: 400 });
		await expect(
			g.save({ from: Array.from({ length: 21 }, (_, i) => `w${i}`), to: 'Pixelforge' }),
		).rejects.toMatchObject({ status: 409, code: 'GLOSSARY_LIMIT' });
		const a = await g.save({ from: [], to: 'Glimmerbox' });
		await g.save({ from: [], to: 'Pixelforge' });
		await expect(g.update(a.entry.id, { to: 'Pixelforge' })).rejects.toMatchObject({
			status: 409,
			code: 'GLOSSARY_DUPLICATE',
		});
		await expect(g.remove('gle_0000000000000000')).rejects.toMatchObject({ status: 404 });
		await expect(
			g.import({ format: 'jasper-speech-glossary', version: 3, entries: [] }),
		).rejects.toMatchObject({
			status: 400,
			code: 'GLOSSARY_IMPORT_INVALID',
		});
	});
});

describe('glossary routes', () => {
	it('save, merge, Remember, get, edit, export and import, with zod refusals', async () => {
		const app = await makeApp();
		const list = async () =>
			GlossaryLibraryResponseSchema.parse(
				(await app.inject({ method: 'GET', url: '/api/speech/glossary', headers: H })).json(),
			);
		expect(await list()).toMatchObject({ revision: 0, readOnly: false, entries: [] });
		const post = (url: string, payload: unknown) =>
			app.inject({ method: 'POST', url, headers: JSON_H, payload: payload as object });
		const c = await post('/api/speech/glossary', { from: ['glimer box'], to: 'Glimmerbox', lang: 'es' });
		expect(c.statusCode).toBe(201);
		const created = GlossarySaveResponseSchema.parse(c.json());
		const m = await post('/api/speech/glossary/remember', {
			from: ['glimerbox'],
			to: 'Glimmerbox',
			lang: 'es',
		});
		expect(m.statusCode).toBe(200);
		expect(m.json()).toMatchObject({
			created: false,
			changed: true,
			entry: { count: 1, from: ['glimer box', 'glimerbox'] },
		});
		for (const bad of [
			{ to: 'x' },
			{ from: ['a'], to: 'b', bogus: 1 },
			{ from: 'a', to: 'b' },
			{ from: [], to: 'b', lang: 'Spanish' },
			{ from: [], to: 'x'.repeat(2000) },
		]) {
			const r = await post('/api/speech/glossary', bad);
			expect(r.statusCode, JSON.stringify(bad)).toBe(400);
			expect(r.json().code).toBe('VALIDATION_FAILED');
		}
		const blank = await post('/api/speech/glossary', { from: [], to: '  ' });
		expect(blank.json()).toMatchObject({ code: 'GLOSSARY_INVALID' });
		const eid = created.entry.id;
		expect(
			(await app.inject({ method: 'GET', url: `/api/speech/glossary/${eid}`, headers: H })).json(),
		).toMatchObject({
			to: 'Glimmerbox',
		});
		expect(
			(await app.inject({ method: 'GET', url: '/api/speech/glossary/gle_nope', headers: H })).statusCode,
		).toBe(404);
		const u = await app.inject({
			method: 'PUT',
			url: `/api/speech/glossary/${eid}`,
			headers: JSON_H,
			payload: { lang: null, from: ['glimer box'] },
		});
		expect(u.statusCode).toBe(200);
		expect(u.json().entry).toMatchObject({ from: ['glimer box'] });
		expect(u.json().entry.lang).toBeUndefined();
		expect(
			(
				await app.inject({
					method: 'PUT',
					url: `/api/speech/glossary/${eid}`,
					headers: JSON_H,
					payload: { name: 'x' },
				})
			).statusCode,
		).toBe(400);
		// export → import into a fresh engine gives the same entries
		const exported = (
			await app.inject({ method: 'GET', url: '/api/speech/glossary/export', headers: H })
		).json();
		expect(GlossaryFileSchema.parse(exported).entries).toHaveLength(1);
		const app2 = await makeApp();
		const imp = await app2.inject({
			method: 'POST',
			url: '/api/speech/glossary/import',
			headers: JSON_H,
			payload: {
				file: {
					...exported,
					entries: [...exported.entries, { to: '' }, { to: 'Pixelforge', from: 'pixel forge' }],
				},
			},
		});
		expect(GlossaryImportResponseSchema.parse(imp.json())).toMatchObject({
			added: 2,
			merged: 0,
			skipped: [{ index: 1 }],
		});
		const again = await app2.inject({
			method: 'POST',
			url: '/api/speech/glossary/import',
			headers: JSON_H,
			payload: { file: exported },
		});
		expect(again.json()).toMatchObject({ added: 0, merged: 0, unchanged: 1 });
		const refused = await app2.inject({
			method: 'POST',
			url: '/api/speech/glossary/import',
			headers: JSON_H,
			payload: { file: { format: 'jasper-speech-glossary', version: 9, entries: [] } },
		});
		expect(refused.statusCode).toBe(400);
		expect(refused.json().code).toBe('GLOSSARY_IMPORT_INVALID');
		// the editor (dev engine: every client is the editor) deletes without a card
		const d = await app.inject({ method: 'DELETE', url: `/api/speech/glossary/${eid}`, headers: H });
		expect(d.json()).toMatchObject({ ok: true, removed: eid });
		expect((await list()).entries).toEqual([]);
	});

	it('read-only glossary: writes are refused with GLOSSARY_READ_ONLY, the listing says so', async () => {
		const appdir = tempAppdir('jasper-glossary-');
		writeFile(appdir, { format: 'jasper-speech-glossary', version: 2, revision: 1, entries: [entry(1)] });
		const app = await makeApp({ appdir });
		const l = (await app.inject({ method: 'GET', url: '/api/speech/glossary', headers: H })).json();
		expect(l).toMatchObject({ readOnly: true, entries: [{ to: 'Name 1' }] });
		const r = await app.inject({
			method: 'POST',
			url: '/api/speech/glossary',
			headers: JSON_H,
			payload: { from: [], to: 'X1' },
		});
		expect(r.statusCode).toBe(409);
		expect(r.json().code).toBe('GLOSSARY_READ_ONLY');
	});
});

describe('glossary and agents (approval gate, security review AGT-3)', { timeout: 120_000 }, () => {
	const TOKEN = 'tok_glossary_0123456789abcdef';
	const KEY = 'key_glossary_0123456789abcdef';
	const AGENT = { ...H, authorization: `Bearer ${TOKEN}`, [AGENT_NAME_HEADER]: 'glossary-agent' };
	const EDITOR = { ...H, cookie: `jasper_session_47900=${TOKEN}; jasper_editor_47900=${KEY}` };
	const json = (h: Record<string, string>) => ({ ...h, 'content-type': 'application/json' });

	async function editorWindow(app: Awaited<ReturnType<typeof makeApp>>) {
		const doc = createEmptyProject({
			ids: createCounterIdSource(5),
			name: 'Glossary',
			preset: 'hd-1080p-30',
		});
		const file = appdirPaths(app.appdir).projectFile(doc.projectId);
		mkdirSync(join(file, '..'), { recursive: true });
		writeFileSync(file, JSON.stringify(makeEnvelope(doc, { revision: 1, savedAt: NOW, platform: 'test' })));
		const ws: WebSocket = await app.injectWS('/agent', { headers: EDITOR });
		const cards: { approvalId: string; answerKey: string; summary: string; label: string }[] = [];
		let wake: (() => void) | null = null;
		const welcome = new Promise<void>((resolve) =>
			ws.on('message', (d) => {
				const m = JSON.parse(String(d)) as { type: string; event?: string; payload?: unknown };
				if (m.type === 'welcome') resolve();
				if (m.type === 'event' && m.event === 'agent.approval.requested') {
					cards.push(m.payload as (typeof cards)[number]);
					wake?.();
				}
			}),
		);
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

	it('an agent adds freely, but deleting or dropping spellings needs the user', async () => {
		const app = await makeApp({ dev: false, token: TOKEN, editorKey: KEY });
		const saved = await app.inject({
			method: 'POST',
			url: '/api/speech/glossary',
			headers: json(AGENT),
			payload: { from: ['nova play'], to: 'NovaPlay' },
		});
		expect(saved.statusCode).toBe(201);
		const eid = saved.json().entry.id as string;
		const del = () => app.inject({ method: 'DELETE', url: `/api/speech/glossary/${eid}`, headers: AGENT });
		const entries = async () =>
			(await app.inject({ method: 'GET', url: '/api/speech/glossary', headers: EDITOR })).json().entries as {
				from: string[];
			}[];

		// no editor window to ask: refused, nothing changes
		const refused = await del();
		expect(refused.statusCode).toBe(403);
		expect(refused.json()).toMatchObject({ code: 'APPROVAL_DENIED', detail: { code: 'E_APPROVAL_DENIED' } });
		expect(await entries()).toHaveLength(1);

		// adding a spelling is not lossy: no card
		const add = await app.inject({
			method: 'PUT',
			url: `/api/speech/glossary/${eid}`,
			headers: json(AGENT),
			payload: { from: ['nova play', 'novaplei'] },
		});
		expect(add.statusCode).toBe(200);

		const editor = await editorWindow(app);
		const drop = app.inject({
			method: 'PUT',
			url: `/api/speech/glossary/${eid}`,
			headers: json(AGENT),
			payload: { from: ['novaplei'] },
		});
		const c1 = await editor.card(1);
		expect(c1.label).toBe('Change glossary entry');
		expect(c1.summary).toContain('removing “nova play”');
		editor.answer(c1, 'denied');
		expect((await drop).statusCode).toBe(403);
		expect((await entries())[0]!.from).toEqual(['nova play', 'novaplei']);

		const pending = del();
		const c2 = await editor.card(2);
		expect(c2).toMatchObject({ label: 'Delete glossary entry' });
		expect(c2.summary).toContain('“NovaPlay”');
		editor.answer(c2, 'approved');
		expect((await pending).json()).toMatchObject({ ok: true, removed: eid });
		expect(await entries()).toEqual([]);

		// the editor window itself deletes without a card
		const own = await app.inject({
			method: 'POST',
			url: '/api/speech/glossary',
			headers: json(EDITOR),
			payload: { from: [], to: 'Glimmerbox' },
		});
		const del2 = await app.inject({
			method: 'DELETE',
			url: `/api/speech/glossary/${own.json().entry.id}`,
			headers: EDITOR,
		});
		expect(del2.statusCode).toBe(200);
		expect(editor.cards).toHaveLength(2);
	});
});
