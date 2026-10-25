// Link Media dialog (docs/wp-notes/link-media.md §5): locate one Windows-path file, the engine finds the others from
// it, everything links as one undoable transaction; ambiguous and differing files wait; Offline / Offline All; the
// dialog opens when a project opens with offline media; thousands of relinks in one transaction.
import type { RegisteredMedia, RelinkScanResult } from '@jasper/api';
import { EngineClient } from '@jasper/engine-client';
import type { MediaAsset } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { closeAllDialogs, DialogHost } from '@jasper/ui';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { registerAllCommands } from '../src/commands/index.ts';
import { applyLinks, criteriaOf, DEFAULT_LINK_OPTIONS } from '../src/interchange/link-media/flow.ts';
import { LinkMediaDialog, offlineMedia } from '../src/interchange/link-media/LinkMediaDialog.tsx';
import { useLinkMediaOnOpen } from '../src/interchange/link-media/on-open.ts';
import { makeSession, videoAsset } from './timeline-helpers.ts';

beforeAll(() => registerAllCommands());
afterEach(() => {
	act(() => closeAllDialogs());
	cleanup();
});

/** Registers offline placeholders with Windows paths (as an imported Premiere project has them). */
function withPlaceholders(session: EditorSession, paths: string[]): string[] {
	const r = session.apply({
		label: 'import',
		origin: 'user',
		commands: paths.map((p, i) => {
			const a = videoAsset(4);
			return {
				type: 'media.register',
				ref: `$m${i}`,
				asset: {
					...a,
					fingerprint: `pending:interchange:${i}`,
					originalName: p.split('\\').pop(),
					sizeBytes: 0,
					locators: [{ type: 'path', path: p, relativeToProject: null }],
				},
			};
		}) as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return paths.map((_, i) => r.refs[`$m${i}`]!);
}

const lastLabel = (s: EditorSession) => {
	const h = s.getState().history;
	return h.entries[h.index - 1]?.label;
};

const reg = (path: string): RegisteredMedia => {
	const a = videoAsset(5);
	const key = `mk_${path.replace(/\W/g, '_')}`;
	return {
		mediaKey: key,
		fingerprint: `q1:${key}`,
		originalName: path.split('/').pop()!,
		sizeBytes: 100,
		container: 'mov,mp4',
		kind: 'video',
		probe: a.probe,
		locators: [{ type: 'path', path, relativeToProject: null }],
		browserPlayable: 'yes',
	};
};

type Call = { method: string; url: string; body: Record<string, unknown> | undefined };

/** An engine whose relink-scan answers from `answer(body)`; the file browser shows `/Volumes/Mac/Shoot/Day 1`. */
function fakeEngine(calls: Call[], answer: (body: Record<string, unknown>) => RelinkScanResult) {
	let scans = 0;
	let last: RelinkScanResult | null = null;
	const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
		calls.push({ method: init?.method ?? 'GET', url, body });
		const json = (v: unknown, status = 200) =>
			new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
		const job = (id: string, state: string) => ({
			id,
			kind: 'relink-scan',
			state,
			title: 'Link Media',
			priority: 'user',
			cpuSlots: 1,
			progress: state === 'succeeded' ? 1 : 0,
			createdAt: '2026-10-25T00:00:00.000Z',
			origin: { type: 'user' },
			projectId: 'p',
			...(state === 'succeeded' ? { result: { found: 0 }, finishedAt: '2026-10-25T00:00:01.000Z' } : {}),
		});
		if (url.includes('/relink-scan/')) return json(last);
		if (url.endsWith('/relink-scan')) {
			last = answer(body);
			return json(job(`job_${++scans}`, 'queued'), 202);
		}
		if (url.includes('/api/jobs/job_')) return json(job(url.split('/').pop()!, 'succeeded'));
		if (/\/api\/assets\/[^/]+\/relink$/.test(url))
			return json({ media: reg(body.path), match: 'placeholder', diff: [], failed: [], needsConfirm: false });
		if (url.includes('/api/browse/roots'))
			return json({
				sep: '/',
				home: '/Users/me',
				roots: [{ label: 'Mac', path: '/Volumes/Mac', kind: 'volume' }],
			});
		if (url.includes('/api/browse/list')) {
			const path = new URL(url, 'http://x').searchParams.get('path')!;
			if (path === '/Users/me') return json({ path, parent: '/Users', truncated: false, entries: [] });
			if (path !== '/Volumes/Mac/Shoot/Day 1')
				return json({ code: 'NOT_FOUND', message: 'no', retryable: false }, 404);
			return json({
				path,
				parent: '/Volumes/Mac/Shoot',
				truncated: false,
				entries: [
					{
						name: 'A001.mov',
						path: `${path}/A001.mov`,
						kind: 'file',
						size: 9,
						modifiedAt: null,
						category: 'video',
						hidden: false,
					},
					{
						name: 'notes.txt',
						path: `${path}/notes.txt`,
						kind: 'file',
						size: 9,
						modifiedAt: null,
						category: null,
						hidden: false,
					},
				],
			});
		}
		return json({ code: 'NOT_FOUND', message: url, retryable: false }, 404);
	};
	return new EngineClient({ fetch: fetchImpl as typeof fetch });
}

const empty: RelinkScanResult = {
	found: [],
	ambiguous: [],
	notFound: [],
	scannedFiles: 0,
	truncated: false,
	timedOut: false,
	mappings: [],
};

describe('Link Media dialog', () => {
	it('locate one file: the others link automatically in one undoable transaction', async () => {
		const { session } = makeSession();
		const ids = withPlaceholders(session, [
			'D:\\Shoot\\Day 1\\A001.mov',
			'D:\\Shoot\\Day 1\\A002.mov',
			'D:\\Shoot\\Day 2\\B001.mov',
			'D:\\Shoot\\Day 2\\B002.mov',
			'D:\\Shoot\\Day 3\\C001.mov',
		]);
		const [a1, a2, b1, b2, c1] = ids as [string, string, string, string, string];
		const calls: Call[] = [];
		const engine = fakeEngine(calls, (body) => {
			if (!body.anchors) return { ...empty, notFound: (body.assets as { id: string }[]).map((x) => x.id) };
			return {
				...empty,
				found: [
					{
						assetId: a2,
						path: '/Volumes/Mac/Shoot/Day 1/A002.mov',
						media: reg('/Volumes/Mac/Shoot/Day 1/A002.mov'),
						matched: ['name', 'extension', 'duration', 'streams'],
						match: 'placeholder',
						diff: [],
						step: 'mapping',
						needsConfirm: false,
					},
					{
						assetId: b1,
						path: '/Volumes/Mac/Shoot/Day 2/B001.mov',
						media: reg('/Volumes/Mac/Shoot/Day 2/B001.mov'),
						matched: ['name'],
						match: 'placeholder',
						diff: [],
						step: 'mapping',
						needsConfirm: false,
					},
					{
						assetId: b2,
						path: '/Volumes/Mac/Shoot/Day 2/B002.mov',
						media: { ...reg('/Volumes/Mac/Shoot/Day 2/B002.mov'), kind: 'audio' },
						matched: [],
						match: 'placeholder',
						diff: [{ field: 'kind', was: 'video', now: 'audio' }],
						step: 'mapping',
						needsConfirm: true,
					},
				],
				ambiguous: [
					{ assetId: c1, step: 'search', candidates: ['/Volumes/Mac/x/C001.mov', '/Volumes/Mac/y/C001.mov'] },
				],
				mappings: [{ from: 'D:\\', to: '/Volumes/Mac' }],
			};
		});
		render(<DialogHost />);
		let closed: unknown = null;
		render(<LinkMediaDialog session={session} engine={engine} close={(r) => (closed = r)} />);
		const dlg = await screen.findByTestId('link-media-dialog');
		// the last known paths were checked first (nothing there)
		await waitFor(() => expect(calls.some((c) => c.url.endsWith('/relink-scan'))).toBe(true));
		expect(within(dlg).getAllByTestId('link-media-row').length).toBe(5);
		expect(dlg.textContent).toContain('D:\\Shoot\\Day 1\\A001.mov');
		expect(dlg.textContent).toContain('another computer');
		// Locate the first: the media browser opens where the file should be (nothing maps yet: the home folder)
		await waitFor(() =>
			expect((within(dlg).getByRole('button', { name: 'Locate' }) as HTMLButtonElement).disabled).toBe(false),
		);
		await act(async () => {
			fireEvent.click(within(dlg).getByRole('button', { name: 'Locate' }));
		});
		await screen.findByTestId('link-media-locate');
		fireEvent.change(screen.getByTestId('link-media-locate-folder'), {
			target: { value: '/Volumes/Mac/Shoot/Day 1' },
		});
		await act(async () => {
			fireEvent.keyDown(screen.getByTestId('link-media-locate-folder'), { key: 'Enter' });
		});
		await waitFor(() =>
			expect(screen.getByTestId('link-media-locate-list').textContent).toContain('A001.mov'),
		);
		// only exact name matches are listed by default
		expect(screen.getByTestId('link-media-locate-list').textContent).not.toContain('notes.txt');
		fireEvent.click(screen.getByText('A001.mov'));
		await act(async () => {
			fireEvent.click(within(dlg).getByRole('button', { name: 'OK' }));
		});
		await waitFor(() => expect(screen.getByTestId('link-media-status').textContent).toMatch(/Linked 3/));
		// the verification used the selected match properties; the search got the located file as anchor
		const verify = calls.find((c) => /\/relink$/.test(c.url))!.body!;
		expect(verify.match).toEqual(criteriaOf(DEFAULT_LINK_OPTIONS).match);
		const scan = calls.filter((c) => c.url.endsWith('/relink-scan')).at(-1)!.body!;
		expect(scan.anchors).toEqual([
			{ from: 'D:\\Shoot\\Day 1\\A001.mov', to: '/Volumes/Mac/Shoot/Day 1/A001.mov', relativePath: null },
		]);
		expect((scan.assets as { id: string }[]).map((x) => x.id)).toEqual([a2, b1, b2, c1]);
		// one transaction for the located file and the two found ones
		const doc = session.getCommitted();
		for (const id of [a1, a2, b1]) expect((doc.media[id] as MediaAsset).fingerprint).toMatch(/^q1:/);
		for (const id of [b2, c1]) expect((doc.media[id] as MediaAsset).fingerprint).toMatch(/^pending:/);
		expect(lastLabel(session)).toBe('Link Media (3)');
		// the differing file waits for confirmation; the ambiguous one offers its candidates
		const rows = within(dlg).getAllByTestId('link-media-row');
		const row = (id: string) => rows.find((r) => r.getAttribute('data-media-id') === id)!;
		expect(row(b2).textContent).toContain('Differs');
		expect(within(row(c1)).getByRole('combobox')).toBeTruthy();
		await act(async () => {
			fireEvent.click(within(row(b2)).getByRole('button', { name: 'Link anyway' }));
		});
		await waitFor(() => expect((session.getCommitted().media[b2] as MediaAsset).fingerprint).toMatch(/^q1:/));
		// undo takes back the forced link, then the three in one step; redo brings them back
		session.undo();
		expect((session.getCommitted().media[b2] as MediaAsset).fingerprint).toMatch(/^pending:/);
		session.undo();
		for (const id of [a1, a2, b1])
			expect((session.getCommitted().media[id] as MediaAsset).fingerprint).toMatch(/^pending:/);
		session.redo();
		for (const id of [a1, a2, b1])
			expect((session.getCommitted().media[id] as MediaAsset).fingerprint).toMatch(/^q1:/);
		// Offline leaves the selected row offline; with nothing left to locate the dialog is done
		fireEvent.click(row(c1));
		fireEvent.click(within(dlg).getByTestId('link-media-offline'));
		await waitFor(() => expect(closed).toEqual({ linked: 4 }));
	});

	it('Offline All closes with every row still offline', async () => {
		const { session } = makeSession();
		withPlaceholders(session, ['D:\\a.mov', 'D:\\b.mov']);
		const engine = fakeEngine([], (b) => ({
			...empty,
			notFound: (b.assets as { id: string }[]).map((x) => x.id),
		}));
		render(<DialogHost />);
		let closed: unknown = null;
		render(<LinkMediaDialog session={session} engine={engine} close={(r) => (closed = r)} />);
		const dlg = await screen.findByTestId('link-media-dialog');
		await waitFor(() => expect(screen.queryByTestId('link-media-cancel-search')).toBeNull());
		fireEvent.click(within(dlg).getByTestId('link-media-offline-all'));
		await waitFor(() => expect(closed).toEqual({ linked: 0, offline: 2 }));
		expect(offlineMedia(session).length).toBe(2);
	});

	it('links thousands of offline media as one transaction; undo and redo restore it', async () => {
		const { session } = makeSession();
		const N = 2000;
		const ids = withPlaceholders(
			session,
			Array.from({ length: N }, (_, i) => `D:\\Media\\p${i % 50}\\clip ${i}.mov`),
		);
		expect(offlineMedia(session).length).toBe(N);
		const t0 = performance.now();
		const r = await applyLinks(
			session,
			ids.map((id, i) => ({
				assetId: id,
				media: reg(`/Volumes/Mac/Media/p${i % 50}/clip ${i}.mov`),
				force: false,
			})),
			DEFAULT_LINK_OPTIONS,
		);
		expect(r.ok).toBe(true);
		expect(performance.now() - t0).toBeLessThan(30_000);
		expect(offlineMedia(session).length).toBe(0);
		expect(lastLabel(session)).toBe(`Link Media (${N})`);
		session.undo();
		expect(offlineMedia(session).length).toBe(N);
		session.redo();
		expect(offlineMedia(session).length).toBe(0);
	});

	it('a refused transaction is reported, not half applied', async () => {
		const { session } = makeSession();
		const [id] = withPlaceholders(session, ['D:\\a.mov']);
		const r = await applyLinks(
			session,
			[{ assetId: id!, media: reg('/a.mov'), force: false }],
			DEFAULT_LINK_OPTIONS,
		);
		expect(r.ok).toBe(true);
		// relinking the now real asset to another file without force is refused (E_INVALID_PARAM)
		const again = await applyLinks(
			session,
			[{ assetId: id!, media: reg('/b.mov'), force: false }],
			DEFAULT_LINK_OPTIONS,
		);
		expect(again.ok).toBe(false);
		expect((session.getCommitted().media[id!] as MediaAsset).locators[1]).toMatchObject({ path: '/a.mov' });
	});
});

describe('Link Media when a project opens', () => {
	it('opens once the media are resolved and some are offline; never for read-only projects', async () => {
		const { session } = makeSession();
		const [id] = withPlaceholders(session, ['D:\\Shoot\\A001.mov']);
		session.setMediaRuntime(id!, { availability: 'resolving' });
		const calls: Call[] = [];
		const engine = fakeEngine(calls, (b) => ({
			...empty,
			notFound: (b.assets as { id: string }[]).map((x) => x.id),
		}));
		render(<DialogHost />);
		renderHook(() => useLinkMediaOnOpen(session, engine, true));
		expect(screen.queryByTestId('link-media-dialog')).toBeNull();
		act(() => session.setMediaRuntime(id!, { availability: 'offline' }));
		expect(await screen.findByTestId('link-media-dialog')).toBeTruthy();
		act(() => closeAllDialogs());
		// a second session that is read-only: nothing opens
		const ro = makeSession({ seed: 9 }).session;
		withPlaceholders(ro, ['D:\\x.mov']);
		ro.store.setState({ readOnly: true });
		renderHook(() => useLinkMediaOnOpen(ro, engine, true));
		await new Promise((r) => setTimeout(r, 50));
		expect(screen.queryByTestId('link-media-dialog')).toBeNull();
	});
});
