// Link Media dialog (docs/wp-notes/link-media.md §5): locate one Windows-path file, the engine finds the others from
// it, everything links as one undoable transaction; ambiguous and differing files wait; Offline / Offline All; the
// dialog opens after media resolution for writable projects with offline media.
import type { RegisteredMedia, RelinkScanResult } from '@jasper/api';
import { EngineClient } from '@jasper/engine-client';
import type { MediaAsset } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { closeAllDialogs, DialogHost } from '@jasper/ui';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { registerAllCommands } from '../src/commands/index.ts';
import { createMediaRuntimeSync } from '../src/import/media-runtime.ts';
import { LinkMediaDialog, offlineMedia } from '../src/interchange/link-media/LinkMediaDialog.tsx';
import { useLinkMediaOnOpen } from '../src/interchange/link-media/on-open.ts';
import { ProjectPanel } from '../src/panels/project/ProjectPanel.tsx';
import { EngineProvider } from '../src/state/engine.tsx';
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
function fakeEngine(
	calls: Call[],
	answer: (body: Record<string, unknown>) => RelinkScanResult,
	relinkAnswer?: (body: Record<string, unknown>) => unknown,
) {
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
			return json(
				relinkAnswer?.(body) ?? {
					media: reg(body.path),
					match: 'placeholder',
					diff: [],
					failed: [],
					needsConfirm: false,
				},
			);
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
		expect(dlg.textContent).toContain('D:\\Shoot\\Day 1\\A001.mov');
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
		expect(verify.match).toEqual(['name', 'extension', 'duration', 'streams']);
		const scan = calls.filter((c) => c.url.endsWith('/relink-scan')).at(-1)!.body!;
		expect(scan.anchors).toEqual([
			{ from: 'D:\\Shoot\\Day 1\\A001.mov', to: '/Volumes/Mac/Shoot/Day 1/A001.mov', relativePath: null },
		]);
		expect((scan.assets as { id: string }[]).map((x) => x.id)).toEqual([a2, b1, b2, c1]);
		// one transaction for the located file and the two found ones
		const doc = session.getCommitted();
		for (const id of [a1, a2, b1]) expect((doc.media[id] as MediaAsset).fingerprint).toMatch(/^q1:/);
		for (const id of [b2, c1]) expect((doc.media[id] as MediaAsset).fingerprint).toMatch(/^pending:/);
		// the differing file waits for confirmation; the ambiguous one offers its candidates
		const rows = within(dlg).getAllByTestId('link-media-row');
		const row = (id: string) => rows.find((r) => r.getAttribute('data-media-id') === id)!;
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
});

describe('Link Media when a project opens', () => {
	it('opens once the media are resolved and some used ones are offline; never for read-only projects', async () => {
		const { session } = makeSession();
		const [id] = withPlaceholders(session, ['D:\\Shoot\\A001.mov']);
		useInNest(session, id!);
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
		const [roId] = withPlaceholders(ro, ['D:\\x.mov']);
		useInNest(ro, roId!);
		ro.store.setState({ readOnly: true });
		ro.setMediaRuntime(roId!, { availability: 'offline' });
		renderHook(() => useLinkMediaOnOpen(ro, engine, true));
		expect(screen.queryByTestId('link-media-dialog')).toBeNull();
	});
});

/** Registers an imported file (engine record, path locator) the engine now reports offline (`reason`). */
function withImported(session: EditorSession, path: string, reason: 'missing' | 'changed'): string {
	const a = videoAsset(4);
	const r = session.apply({
		label: 'import',
		origin: 'user',
		commands: [
			{
				type: 'media.register',
				ref: '$m',
				asset: {
					...a,
					originalName: path.split('/').pop(),
					locators: [...a.locators, { type: 'path', path, relativeToProject: null }],
				},
			},
		] as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const id = r.refs.$m!;
	session.setMediaRuntime(id, { availability: 'offline', offlineReason: reason });
	return id;
}

/** Puts a clip of `mediaId` in a nested sequence of the active one (the media is used only inside the nest). */
function useInNest(session: EditorSession, mediaId: string) {
	const placed = session.apply({
		label: 'place',
		origin: 'user',
		commands: [{ type: 'clip.place', source: { mediaId }, at: 0 }] as never,
	});
	if (!placed.ok) throw new Error(JSON.stringify(placed.errors));
	const seqId = session.getState().activeSequenceId!;
	const clipIds = Object.keys(session.getCommitted().sequences[seqId]!.clips);
	const nested = session.apply({
		label: 'nest',
		origin: 'user',
		commands: [{ type: 'clip.nest', clipIds, name: 'N' }] as never,
	});
	if (!nested.ok) throw new Error(JSON.stringify(nested.errors));
	const { sequenceId } = nested.results[0] as { sequenceId: string };
	// the outer sequence holds only the nest; the media's clip lives in the nested sequence
	expect(
		Object.values(session.getCommitted().sequences[seqId]!.clips).some(
			(c) => (c as { mediaId?: string }).mediaId === mediaId,
		),
	).toBe(false);
	expect(
		Object.values(session.getCommitted().sequences[sequenceId]!.clips).some(
			(c) => (c as { mediaId?: string }).mediaId === mediaId,
		),
	).toBe(true);
}

describe('Link Media on open: unused offline media', () => {
	it('an offline medium no clip uses opens no dialog; the Project panel shows a badge that opens Link Media', async () => {
		const { session } = makeSession();
		const id = withImported(session, '/renders/MGB_S62_cpu_huesos_alpha.mov', 'changed');
		const engine = fakeEngine([], (b) => ({
			...empty,
			notFound: (b.assets as { id: string }[]).map((x) => x.id),
		}));
		render(<DialogHost />);
		renderHook(() => useLinkMediaOnOpen(session, engine, true));
		render(
			<EngineProvider client={engine}>
				<SessionProvider session={session}>
					<ProjectPanel instanceId="lm-badge" visible />
				</SessionProvider>
			</EngineProvider>,
		);
		const badge = await screen.findByTestId('project-offline-badge');
		expect(badge.getAttribute('data-offline-unused')).toBe('1');
		expect(badge.getAttribute('data-offline-used')).toBe('0');
		expect(badge.textContent).toContain('1 offline (1 changed)');
		await act(async () => undefined);
		expect(screen.queryByTestId('link-media-dialog')).toBeNull();
		// the badge opens Link Media with the medium listed
		await act(async () => {
			fireEvent.click(badge);
		});
		const dlg = await screen.findByTestId('link-media-dialog');
		expect(
			within(dlg)
				.getAllByTestId('link-media-row')
				.map((r) => r.getAttribute('data-media-id')),
		).toEqual([id]);
	});

	it('an offline medium used only inside a nested sequence opens the dialog', async () => {
		const { session } = makeSession();
		const id = withImported(session, '/renders/plate.mov', 'missing');
		useInNest(session, id);
		const engine = fakeEngine([], (b) => ({
			...empty,
			notFound: (b.assets as { id: string }[]).map((x) => x.id),
		}));
		render(<DialogHost />);
		renderHook(() => useLinkMediaOnOpen(session, engine, true));
		expect(await screen.findByTestId('link-media-dialog')).toBeTruthy();
	});
});

describe('Link Media: a file re-rendered at the same path', () => {
	const updated = (body: Record<string, unknown>, diff: { field: string; was: string; now: string }[]) => ({
		media: { ...reg(body.path as string), fingerprint: 'q1:rerendered' },
		match: 'different',
		diff,
		failed: [],
		needsConfirm: true,
	});

	it('an unused changed file: one click re-registers it at its path and updates the record (undoable)', async () => {
		const { session } = makeSession();
		const id = withImported(session, '/renders/MGB_S62_cpu_huesos_alpha.mov', 'changed');
		const before = session.getCommitted().media[id] as MediaAsset;
		const calls: Call[] = [];
		const engine = fakeEngine(
			calls,
			(b) => ({ ...empty, notFound: (b.assets as { id: string }[]).map((x) => x.id) }),
			(b) => updated(b, [{ field: 'duration', was: '4 s', now: '6 s' }]),
		);
		render(<DialogHost />);
		render(<LinkMediaDialog session={session} engine={engine} close={() => undefined} />);
		const dlg = await screen.findByTestId('link-media-dialog');
		await waitFor(() => expect(screen.queryByTestId('link-media-cancel-search')).toBeNull());
		const row = within(dlg).getByTestId('link-media-row');
		expect(row.textContent).toContain('Changed on disk');
		await act(async () => {
			fireEvent.click(within(row).getByTestId('link-media-use-updated'));
		});
		await waitFor(() =>
			expect((session.getCommitted().media[id] as MediaAsset).fingerprint).toBe('q1:rerendered'),
		);
		// re-probed at the same path, no match properties asked for
		const verify = calls.find((c) => /\/relink$/.test(c.url))!.body!;
		expect(verify.path).toBe('/renders/MGB_S62_cpu_huesos_alpha.mov');
		expect(verify.match).toEqual([]);
		expect(screen.queryByTestId('link-media-confirm')).toBeNull();
		session.undo();
		expect((session.getCommitted().media[id] as MediaAsset).fingerprint).toBe(before.fingerprint);
	});

	it('a used changed file whose duration changed shows the differences before it is used', async () => {
		const { session } = makeSession();
		const id = withImported(session, '/renders/plate.mov', 'changed');
		useInNest(session, id);
		const before = (session.getCommitted().media[id] as MediaAsset).fingerprint;
		const engine = fakeEngine(
			[],
			(b) => ({ ...empty, notFound: (b.assets as { id: string }[]).map((x) => x.id) }),
			(b) => updated(b, [{ field: 'duration', was: '4 s', now: '6 s' }]),
		);
		render(<DialogHost />);
		render(<LinkMediaDialog session={session} engine={engine} close={() => undefined} />);
		const dlg = await screen.findByTestId('link-media-dialog');
		await waitFor(() => expect(screen.queryByTestId('link-media-cancel-search')).toBeNull());
		await act(async () => {
			fireEvent.click(within(dlg).getByTestId('link-media-use-updated'));
		});
		const confirm = await screen.findByTestId('link-media-confirm');
		expect(confirm.textContent).toContain('Duration: 4 s → 6 s');
		expect((session.getCommitted().media[id] as MediaAsset).fingerprint).toBe(before);
		await act(async () => {
			fireEvent.click(within(confirm).getByTestId('link-media-link-anyway'));
		});
		await waitFor(() =>
			expect((session.getCommitted().media[id] as MediaAsset).fingerprint).toBe('q1:rerendered'),
		);
	});
});

describe('media runtime: changed files and relinks', () => {
	it('carries the engine\'s "changed" reason and resolves the new file after a relink', async () => {
		const { session } = makeSession();
		const a = videoAsset(4);
		const r = session.apply({
			label: 'import',
			origin: 'user',
			commands: [{ type: 'media.register', ref: '$m', asset: a }] as never,
		});
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		const id = r.refs.$m!;
		const oldKey = (a.locators[0] as { key: string }).key;
		const status = (mediaKey: string) =>
			mediaKey === oldKey
				? { mediaKey, status: 'missing', offline: 'changed', derivatives: {} }
				: { mediaKey, status: 'online', derivatives: {} };
		const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const json = (v: unknown) =>
				new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
			if (url.endsWith('/api/media/status')) {
				const keys = (JSON.parse(String(init?.body)) as { mediaKeys: string[] }).mediaKeys;
				return json({ statuses: keys.map(status), unknown: [] });
			}
			const m = /\/api\/media\/([^/?]+)$/.exec(url);
			if (m) return json(status(decodeURIComponent(m[1]!)));
			return new Response(JSON.stringify({ code: 'NOT_FOUND', message: url, retryable: false }), {
				status: 404,
			});
		};
		const sync = createMediaRuntimeSync(
			session,
			new EngineClient({ fetch: fetchImpl as typeof fetch }),
			null,
		);
		await waitFor(() => expect(session.getState().media[id]?.availability).toBe('offline'));
		expect(session.getState().media[id]?.offlineReason).toBe('changed');
		const relinked = session.apply({
			label: 'Link Media',
			origin: 'user',
			commands: [
				{
					type: 'media.relink',
					mediaId: id,
					locator: { type: 'engine-store', engineId: 'local', key: 'mk_rerendered' },
					fingerprint: 'q1:rerendered',
					force: true,
				},
			] as never,
		});
		if (!relinked.ok) throw new Error(JSON.stringify(relinked.errors));
		await waitFor(() => expect(session.getState().media[id]?.availability).toBe('online'));
		expect(session.getState().media[id]?.offlineReason).toBeUndefined();
		sync.dispose();
	});
});
