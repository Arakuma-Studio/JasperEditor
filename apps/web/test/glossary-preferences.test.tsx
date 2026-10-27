// Spec 17 SC-072: Preferences ▸ Transcription ▸ Glossary against a fake engine: list and search, add (merge notice),
// edit (with the engine's refusal shown), delete after a confirmation (cancel keeps it), import (summary and skipped
// reasons, invalid JSON), export (download), the read-only state, the repair notice and a load failure; the page is a
// sub-page of Transcription in the Preferences dialog.
import type { GlossaryEntry } from '@jasper/project';
import { EngineClient } from '@jasper/engine-client';
import { closeAllDialogs, DialogHost, openDialog } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PREFERENCES_DIALOG, registerPreferencesDialog } from '../src/shell/preferences/index.ts';
import { GlossaryPreferencesPage, parseSpellings } from '../src/speech/GlossaryPage.tsx';
import { registerSpeechUi } from '../src/speech/register.ts';
import { EngineProvider } from '../src/state/engine.tsx';

const downloads: { name: string; text: string }[] = [];
vi.mock('../src/panels/text/state.ts', async (orig) => ({
	...((await orig()) as Record<string, unknown>),
	downloadBytes: (bytes: Uint8Array, name: string) =>
		downloads.push({ name, text: new TextDecoder().decode(bytes) }),
}));

const NOW = '2026-10-27T10:00:00.000Z';
const entry = (n: number, to: string, from: string[], extra: Partial<GlossaryEntry> = {}): GlossaryEntry => ({
	id: `gle_000000000000000${n}`,
	from,
	to,
	count: 0,
	createdAt: NOW,
	updatedAt: NOW,
	...extra,
});

type Call = { method: string; url: string; body?: unknown };

function fakeEngine(state: {
	entries: GlossaryEntry[];
	readOnly?: boolean;
	repairs?: string[];
	failList?: boolean;
	refusePut?: boolean;
}) {
	const calls: Call[] = [];
	let revision = 1;
	const json = (b: unknown, status = 200) =>
		new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		const method = init?.method ?? 'GET';
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ method, url, ...(body !== undefined ? { body } : {}) });
		if (url === '/health') return json({ ok: true, version: '0.1.0', apiVersion: 1 });
		if (url === '/api/speech/glossary' && method === 'GET') {
			if (state.failList) return json({ code: 'INTERNAL', message: 'disk on fire', retryable: false }, 500);
			return json({
				revision,
				readOnly: !!state.readOnly,
				repairs: state.repairs ?? [],
				limits: { maxEntries: 2000, maxSpellings: 20, maxChars: 64 },
				entries: state.entries,
			});
		}
		if (url === '/api/speech/glossary' && method === 'POST') {
			const existing = state.entries.find((e) => e.to === body.to);
			if (existing) {
				existing.from = [...existing.from, ...body.from];
				return json({ revision: ++revision, created: false, changed: true, entry: existing });
			}
			const e = entry(state.entries.length + 1, body.to, body.from, body.lang ? { lang: body.lang } : {});
			state.entries.push(e);
			return json({ revision: ++revision, created: true, changed: true, entry: e }, 201);
		}
		if (url === '/api/speech/glossary/export')
			return json({ format: 'jasper-speech-glossary', version: 1, revision, entries: state.entries });
		if (url === '/api/speech/glossary/import')
			return json({
				revision: ++revision,
				added: 1,
				merged: 2,
				unchanged: 0,
				skipped: [{ index: 3, reason: 'no right spelling (“to”)' }],
			});
		const m = /^\/api\/speech\/glossary\/(gle_\w+)$/.exec(url);
		if (m && method === 'PUT') {
			if (state.refusePut)
				return json(
					{ code: 'GLOSSARY_DUPLICATE', message: 'Another entry already corrects to “Glimmerbox”', retryable: false },
					409,
				);
			const e = state.entries.find((x) => x.id === m[1])!;
			Object.assign(e, { to: body.to, from: body.from });
			if (body.lang === null) delete e.lang;
			else if (body.lang) e.lang = body.lang;
			return json({ revision: ++revision, entry: e });
		}
		if (m && method === 'DELETE') {
			state.entries = state.entries.filter((x) => x.id !== m[1]);
			return json({ ok: true, removed: m[1], revision: ++revision });
		}
		return json({ code: 'NOT_FOUND', message: url, retryable: false }, 404);
	}) as unknown as typeof fetch;
	return { client: new EngineClient({ baseUrl: '', fetch: fetchImpl }), calls, state };
}

function renderPage(engine: ReturnType<typeof fakeEngine>) {
	return render(
		<EngineProvider client={engine.client}>
			<GlossaryPreferencesPage />
			<DialogHost />
		</EngineProvider>,
	);
}

const rows = () => screen.queryAllByTestId('glossary-entry-to').map((e) => e.textContent);

beforeEach(() => {
	downloads.length = 0;
});
afterEach(() => {
	closeAllDialogs();
	cleanup();
});

describe('Preferences ▸ Transcription ▸ Glossary (spec 17 SC-072)', () => {
	it('lists sorted entries with counts and languages; search filters by any spelling', async () => {
		const engine = fakeEngine({
			entries: [
				entry(1, 'Pixelforge', ['pixel forge'], { count: 3, lang: 'es' }),
				entry(2, 'Glimmerbox', ['glimer box', 'glimerbox']),
			],
			repairs: ['the glossary file was unreadable; it was moved aside as glossary.json.corrupt-1 and an empty glossary was started'],
		});
		renderPage(engine);
		await waitFor(() => expect(rows()).toEqual(['Glimmerbox', 'Pixelforge']));
		expect(screen.getByTestId('glossary-count').textContent).toBe('2 / 2000');
		const pixel = screen.getAllByTestId('glossary-entry')[1]!;
		expect(pixel.textContent).toContain('Spanish');
		expect(pixel.textContent).toContain('taught 3 times');
		expect(within(screen.getAllByTestId('glossary-entry')[0]!).getByTestId('glossary-entry-from').textContent).toBe(
			'Recognised as: glimer box · glimerbox',
		);
		expect(screen.getByTestId('glossary-repairs').textContent).toContain('moved aside as glossary.json.corrupt-1');
		fireEvent.change(screen.getByRole('searchbox', { name: 'Search the glossary' }), { target: { value: 'FORGE' } });
		expect(rows()).toEqual(['Pixelforge']);
		fireEvent.change(screen.getByRole('searchbox', { name: 'Search the glossary' }), { target: { value: 'nothing' } });
		expect(rows()).toEqual([]);
		expect(screen.getByText('No entry matches the search.')).toBeTruthy();
	});

	it('adds an entry (spellings one per line), and says when the right spelling already existed', async () => {
		const engine = fakeEngine({ entries: [] });
		renderPage(engine);
		await screen.findByTestId('glossary-empty');
		fireEvent.click(screen.getByTestId('glossary-new'));
		const form = screen.getByTestId('glossary-editor-new');
		expect(within(form).getByTestId('glossary-edit-save').getAttribute('aria-disabled')).toBe('true');
		fireEvent.change(within(form).getByTestId('glossary-edit-to'), { target: { value: 'NovaPlay Studio' } });
		fireEvent.change(within(form).getByTestId('glossary-edit-from'), {
			target: { value: 'nova play studio\n\n novaplei estudio ' },
		});
		await act(async () => {
			fireEvent.click(within(form).getByTestId('glossary-edit-save'));
		});
		await waitFor(() => expect(rows()).toEqual(['NovaPlay Studio']));
		expect(engine.calls.find((c) => c.method === 'POST')?.body).toEqual({
			to: 'NovaPlay Studio',
			from: ['nova play studio', 'novaplei estudio'],
		});
		expect(screen.queryByTestId('glossary-editor-new')).toBeNull();
		// the same right spelling again: merged, and the page says so
		fireEvent.click(screen.getByTestId('glossary-new'));
		const again = screen.getByTestId('glossary-editor-new');
		fireEvent.change(within(again).getByTestId('glossary-edit-to'), { target: { value: 'NovaPlay Studio' } });
		fireEvent.change(within(again).getByTestId('glossary-edit-from'), { target: { value: 'nobaplay' } });
		await act(async () => {
			fireEvent.click(within(again).getByTestId('glossary-edit-save'));
		});
		expect((await screen.findByTestId('glossary-notice')).textContent).toContain(
			'“NovaPlay Studio” was already in the glossary: the spellings were added to it.',
		);
	});

	it('edits an entry; a refusal is shown in the form and nothing is lost', async () => {
		const engine = fakeEngine({ entries: [entry(1, 'Pixelforge', ['pixel forge'], { lang: 'es' })] });
		renderPage(engine);
		await waitFor(() => expect(rows()).toEqual(['Pixelforge']));
		fireEvent.click(screen.getByRole('button', { name: 'Edit Pixelforge' }));
		const form = screen.getByTestId('glossary-editor');
		expect((within(form).getByTestId('glossary-edit-from') as HTMLTextAreaElement).value).toBe('pixel forge');
		fireEvent.change(within(form).getByTestId('glossary-edit-from'), { target: { value: 'pixel forge, pixelforch' } });
		engine.state.refusePut = true;
		await act(async () => {
			fireEvent.click(within(form).getByTestId('glossary-edit-save'));
		});
		expect((await screen.findByTestId('glossary-edit-error')).textContent).toContain(
			'Another entry already corrects to “Glimmerbox” (GLOSSARY_DUPLICATE)',
		);
		expect((within(form).getByTestId('glossary-edit-from') as HTMLTextAreaElement).value).toBe(
			'pixel forge, pixelforch',
		);
		engine.state.refusePut = false;
		await act(async () => {
			fireEvent.click(within(form).getByTestId('glossary-edit-save'));
		});
		await waitFor(() => expect(screen.queryByTestId('glossary-editor')).toBeNull());
		expect(engine.calls.filter((c) => c.method === 'PUT').at(-1)?.body).toEqual({
			to: 'Pixelforge',
			from: ['pixel forge', 'pixelforch'],
			lang: 'es',
		});
		expect(screen.getByTestId('glossary-entry-from').textContent).toBe('Recognised as: pixel forge · pixelforch');
	});

	it('deletes only after the confirmation (Cancel keeps it)', async () => {
		const engine = fakeEngine({ entries: [entry(1, 'Glimmerbox', ['glimer box'])] });
		renderPage(engine);
		await waitFor(() => expect(rows()).toEqual(['Glimmerbox']));
		fireEvent.click(screen.getByRole('button', { name: 'Delete Glimmerbox' }));
		const confirm = await screen.findByTestId('confirm-dialog');
		expect(within(confirm).getByText(/This cannot be undone/)).toBeTruthy();
		fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
		await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
		expect(engine.calls.some((c) => c.method === 'DELETE')).toBe(false);
		fireEvent.click(screen.getByRole('button', { name: 'Delete Glimmerbox' }));
		fireEvent.click(within(await screen.findByTestId('confirm-dialog')).getByRole('button', { name: 'Delete Entry' }));
		await waitFor(() => expect(rows()).toEqual([]));
		expect(engine.calls.find((c) => c.method === 'DELETE')?.url).toBe('/api/speech/glossary/gle_0000000000000001');
	});

	it('imports a file with a summary, refuses invalid JSON, exports a download', async () => {
		const engine = fakeEngine({ entries: [entry(1, 'Glimmerbox', ['glimer box'])] });
		renderPage(engine);
		await waitFor(() => expect(rows()).toEqual(['Glimmerbox']));
		const file = new File([JSON.stringify([{ to: 'NovaPlay', from: ['nova play'] }])], 'shared.json', {
			type: 'application/json',
		});
		await act(async () => {
			fireEvent.change(screen.getByTestId('glossary-import-file'), { target: { files: [file] } });
		});
		const notice = await screen.findByTestId('glossary-notice');
		await waitFor(() =>
			expect(notice.textContent).toContain('Imported: 1 added, 2 merged, 0 already there, 1 skipped.'),
		);
		expect(notice.textContent).toContain('Entry 4: no right spelling (“to”)');
		expect(engine.calls.find((c) => c.url === '/api/speech/glossary/import')?.body).toEqual({
			file: [{ to: 'NovaPlay', from: ['nova play'] }],
		});
		const junk = new File(['{nope'], 'junk.json', { type: 'application/json' });
		await act(async () => {
			fireEvent.change(screen.getByTestId('glossary-import-file'), { target: { files: [junk] } });
		});
		await waitFor(() =>
			expect(screen.getByTestId('glossary-notice').textContent).toBe(
				'The file is not valid JSON: nothing was imported.',
			),
		);
		await act(async () => {
			fireEvent.click(screen.getByTestId('glossary-export'));
		});
		await waitFor(() => expect(downloads).toHaveLength(1));
		expect(downloads[0]!.name).toBe('glossary.json');
		expect(JSON.parse(downloads[0]!.text)).toMatchObject({
			format: 'jasper-speech-glossary',
			version: 1,
			entries: [{ to: 'Glimmerbox' }],
		});
	});

	it('read-only glossary: banner, editing disabled, export still works; a load failure is shown', async () => {
		const engine = fakeEngine({ entries: [entry(1, 'Glimmerbox', [])], readOnly: true });
		renderPage(engine);
		await screen.findByTestId('glossary-read-only');
		for (const id of ['glossary-new', 'glossary-import', 'glossary-entry-edit', 'glossary-entry-delete'])
			expect(screen.getByTestId(id).getAttribute('aria-disabled'), id).toBe('true');
		expect(screen.getByTestId('glossary-export').getAttribute('aria-disabled')).toBeNull();
		expect(screen.getByTestId('glossary-entry-from').textContent).toBe('No misspellings yet');
		cleanup();
		renderPage(fakeEngine({ entries: [], failList: true }));
		expect((await screen.findByTestId('glossary-load-error')).textContent).toContain('disk on fire');
	});

	it('is the Glossary sub-page of Transcription in the Preferences dialog', async () => {
		registerPreferencesDialog();
		registerSpeechUi();
		const engine = fakeEngine({ entries: [] });
		render(
			<EngineProvider client={engine.client}>
				<DialogHost />
			</EngineProvider>,
		);
		act(() => void openDialog(PREFERENCES_DIALOG, { page: 'speech-glossary' }));
		const dialog = await screen.findByTestId('preferences-dialog');
		expect(within(dialog).getByText('Preferences — Transcription ▸ Glossary')).toBeTruthy();
		const nav = within(dialog).getByTestId('prefs-page-speech-glossary');
		expect(nav.className).toContain('pl-6');
		expect(nav.getAttribute('aria-current')).toBe('page');
		await within(dialog).findByTestId('prefs-glossary');
	});

	it('parses spellings one per line or comma-separated', () => {
		expect(parseSpellings(' a b \n\n c, d ,\n')).toEqual(['a b', 'c', 'd']);
		expect(parseSpellings('')).toEqual([]);
	});
});
