// Edit ▸ Preferences ▸ Media Cache (M3, S04:CA-013/CA-014): usage per kind, Clean Unused, Clean All (not in use)…
// behind a confirmation, and the automatic-cleaning settings (age limit, total budget, per-kind limits) saved as one
// engine settings object; the command and the Edit ▸ Preferences menu entry.
import type { CacheGcReport, CacheKind, CacheSettings, CacheUsage } from '@jasper/api';
import { CACHE_KINDS } from '@jasper/api';
import { EngineClient } from '@jasper/engine-client';
import { DialogHost } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MediaCachePreferencesPage } from '../src/cache/MediaCachePage.tsx';
import { cacheCommands } from '../src/commands/cache.ts';
import { MENUBAR } from '../src/shell/menus/model.ts';
import { PreferencesDialog } from '../src/shell/preferences/index.ts';
import { EngineProvider } from '../src/state/engine.tsx';

afterEach(cleanup);

const GB = 1024 ** 3;
const MB = 1024 ** 2;

type Call = { method: string; url: string; body: unknown };

function usageOf(settings: CacheSettings, lastGc: CacheGcReport | null = null): CacheUsage {
	const kinds = CACHE_KINDS.map((kind) => ({
		kind,
		label: kind === 'luts' ? 'Colour LUTs' : kind === 'proxies' ? 'Proxies' : kind,
		description: `${kind} files`,
		entries: kind === 'luts' ? 30 : kind === 'proxies' ? 2 : 0,
		bytes: kind === 'luts' ? 30 * MB : kind === 'proxies' ? 400 * MB : 0,
		inUseBytes: kind === 'proxies' ? 200 * MB : 0,
		referencedBytes: kind === 'proxies' ? 200 * MB : 10 * MB * Number(kind === 'luts'),
		unusedBytes: kind === 'luts' ? 20 * MB : 0,
		maxBytes: settings.kinds[kind]?.maxBytes ?? null,
		maxAgeDays: settings.kinds[kind]?.maxAgeDays ?? (kind === 'exports' ? 7 : settings.maxAgeDays),
		defaultMaxAgeDays: kind === 'exports' ? 7 : settings.maxAgeDays,
		oldestAccess: null,
	}));
	return {
		location: '/home/me/.local/share/jasper',
		totalBytes: 430 * MB,
		inUseBytes: 200 * MB,
		referencedBytes: 210 * MB,
		unusedBytes: 20 * MB,
		maxTotalBytes: settings.maxTotalBytes ?? 25 * GB,
		automaticBudget: settings.maxTotalBytes === null,
		freeDiskBytes: 120 * GB,
		kinds,
		other: [],
		settings,
		lastGc,
		scannedAt: '2026-10-01T10:00:00.000Z',
	};
}

const REPORT: CacheGcReport = {
	at: new Date().toISOString(),
	mode: 'unused',
	removedEntries: 29,
	removedBytes: 20 * MB,
	removedOrphans: 0,
	keptInUse: 2,
	keptReferenced: 1,
	failed: 0,
	byKind: { luts: { entries: 29, bytes: 20 * MB } },
};

function moveJob(state: string, progress = 0, stage?: string) {
	return {
		id: 'job_move000000000001',
		kind: 'cache-move',
		title: 'Move media cache',
		origin: { type: 'user' },
		state,
		progress,
		...(stage ? { stage } : {}),
		createdAt: '2026-10-01T10:00:00.000Z',
		priority: 'interactive',
		cpuSlots: 8,
	};
}

function fakeEngine() {
	const calls: Call[] = [];
	let settings: CacheSettings = {
		autoClean: true,
		maxTotalBytes: null,
		maxAgeDays: 30,
		kinds: {},
		logs: { maxAgeDays: 30, maxBytes: 256 * MB },
		location: null,
	};
	let jobPolls = 0;
	let last: CacheGcReport | null = null;
	const json = (b: unknown, status = 200) =>
		new Response(JSON.stringify(b), { status, headers: { 'x-jasper-api': '1' } });
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		const method = init?.method ?? 'GET';
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ method, url, body });
		if (url === '/health') return json({ ok: true, version: '0.1.0', apiVersion: 1 });
		if (url === '/api/cache')
			return json({
				...usageOf(settings, last),
				...(settings.location
					? { location: `${settings.location}/JasperEditor Media Cache`, locationIsDefault: false }
					: { locationIsDefault: true }),
				logs: { bytes: 3 * MB, files: 12, journalBytes: MB },
			});
		if (url === '/api/cache/settings' && method === 'PUT') {
			settings = body;
			return json(body);
		}
		if (url === '/api/cache/location/check')
			return json({
				path: `${body.path}/JasperEditor Media Cache`,
				isDefault: body.path === null,
				ok: body.path !== '/full',
				message: body.path === '/full' ? 'Not enough free space there: the cache needs 430 MB' : null,
				exists: true,
				writable: true,
				freeBytes: 500 * GB,
				requiredBytes: 430 * MB,
				sameDevice: false,
				sameAsCurrent: false,
			});
		if (url === '/api/cache/location') {
			settings = { ...settings, location: body.path };
			return json(moveJob('queued'), 202);
		}
		if (url === '/api/jobs/job_move000000000001')
			return json(
				++jobPolls < 2 ? moveJob('running', 0.5, 'Copying cache/ · 215 MB') : moveJob('succeeded', 1),
			);
		if (url === '/api/cache/clean') {
			last = { ...REPORT, mode: body.mode };
			return json(last);
		}
		return json({ code: 'NOT_FOUND', message: url }, 404);
	}) as unknown as typeof fetch;
	return { client: new EngineClient({ baseUrl: '', fetch: fetchImpl }), calls };
}

function mount() {
	const engine = fakeEngine();
	render(
		<EngineProvider client={engine.client} connectEvents={false}>
			<MediaCachePreferencesPage />
			<DialogHost />
		</EngineProvider>,
	);
	return engine;
}

describe('Preferences ▸ Media Cache (S04:CA-013/CA-014)', () => {
	it('shows the usage per kind, the total against the limit and the location', async () => {
		mount();
		await waitFor(() =>
			expect(screen.getByTestId('cache-total').textContent).toBe('430.0 MB of 25.0 GB (automatic limit)'),
		);
		expect(screen.getByTestId('cache-location').textContent).toBe('/home/me/.local/share/jasper');
		const rows = within(screen.getByTestId('cache-table')).getAllByRole('row');
		expect(rows).toHaveLength(2 + CACHE_KINDS.length); // header, kinds, logs
		expect(screen.getByTestId('cache-kind-luts-entries').textContent).toBe('30');
		expect(screen.getByTestId('cache-kind-proxies-bytes').textContent).toBe('400.0 MB');
		// Per-kind age placeholders show the defaults (exports: 7 days).
		expect((screen.getByTestId('cache-kind-exports-days') as HTMLInputElement).placeholder).toBe('7');
		expect((screen.getByTestId('cache-kind-luts-days') as HTMLInputElement).placeholder).toBe('30');
		expect(screen.getByTestId('cache-bar')).toBeTruthy();
	});

	it('Clean Unused runs at once; Clean All asks first and runs only when confirmed', async () => {
		const { calls } = mount();
		await waitFor(() => expect(screen.getByTestId('cache-total').textContent).toContain('430.0 MB'));
		await act(async () => {
			fireEvent.click(screen.getByTestId('cache-clean-unused'));
		});
		await waitFor(() =>
			expect(screen.getByTestId('cache-status').textContent).toBe(
				'Clean Unused: removed 29 items (20.0 MB) · 2 in use kept · 1 used by saved projects kept',
			),
		);
		expect(calls.filter((c) => c.url === '/api/cache/clean').map((c) => c.body)).toEqual([
			{ mode: 'unused' },
		]);
		await waitFor(() => expect(screen.getByTestId('cache-last-gc').textContent).toContain('Clean Unused'));

		// Clean All: cancelled, then confirmed.
		await act(async () => {
			fireEvent.click(screen.getByTestId('cache-clean-all'));
		});
		const dialog = await screen.findByTestId('confirm-dialog');
		expect(dialog.textContent).toContain('saved projects use');
		await act(async () => {
			fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
		});
		expect(calls.filter((c) => c.url === '/api/cache/clean')).toHaveLength(1);
		await act(async () => {
			fireEvent.click(screen.getByTestId('cache-clean-all'));
		});
		const again = await screen.findByTestId('confirm-dialog');
		await act(async () => {
			fireEvent.click(within(again).getByRole('button', { name: 'Clean All' }));
		});
		await waitFor(() =>
			expect(screen.getByTestId('cache-status').textContent).toContain('Clean All: removed'),
		);
		expect(calls.filter((c) => c.url === '/api/cache/clean').map((c) => c.body)).toEqual([
			{ mode: 'unused' },
			{ mode: 'all' },
		]);
	});

	it('saves the automatic-cleaning settings as one object and validates them', async () => {
		const { calls } = mount();
		await waitFor(() => expect((screen.getByTestId('cache-max-age') as HTMLInputElement).value).toBe('30'));
		expect((screen.getByTestId('cache-save') as HTMLButtonElement).disabled).toBe(true);
		fireEvent.change(screen.getByTestId('cache-max-age'), { target: { value: '-2' } });
		await act(async () => {
			fireEvent.click(screen.getByTestId('cache-save'));
		});
		expect(screen.getByTestId('cache-status').textContent).toBe('Enter the number of days (more than 0)');
		fireEvent.change(screen.getByTestId('cache-max-age'), { target: { value: '14' } });
		fireEvent.change(screen.getByTestId('cache-kind-proxies-max'), { target: { value: '8,5' } });
		fireEvent.change(screen.getByTestId('cache-kind-luts-days'), { target: { value: '3' } });
		await act(async () => {
			fireEvent.click(screen.getByTestId('cache-save'));
		});
		await waitFor(() => expect(screen.getByTestId('cache-status').textContent).toBe('Settings saved'));
		const put = calls.filter((c) => c.method === 'PUT').at(-1)!;
		expect(put.url).toBe('/api/cache/settings');
		expect(put.body).toEqual({
			autoClean: true,
			maxAgeDays: 14,
			maxTotalBytes: null,
			kinds: { proxies: { maxBytes: Math.round(8.5 * GB) }, luts: { maxAgeDays: 3 } } satisfies Partial<
				Record<CacheKind, unknown>
			>,
			logs: { maxAgeDays: 30, maxBytes: 256 * MB },
			location: null,
		});
		// The saved values come back into the form.
		expect((screen.getByTestId('cache-kind-proxies-max') as HTMLInputElement).value).toBe('8.5');
	});
});

describe('Media Cache: never-expiring kinds, logs, location (CA-020, CA-021)', () => {
	it('a kind can be set to "never"; logs show their size and their own limits', async () => {
		const { calls } = mount();
		await waitFor(() => expect(screen.getByTestId('cache-logs-bytes').textContent).toBe('3.0 MB'));
		expect((screen.getByTestId('cache-logs-days') as HTMLInputElement).value).toBe('30');
		expect((screen.getByTestId('cache-logs-max') as HTMLInputElement).value).toBe('256');
		fireEvent.change(screen.getByTestId('cache-kind-exports-days'), { target: { value: 'Never' } });
		fireEvent.change(screen.getByTestId('cache-logs-days'), { target: { value: 'never' } });
		fireEvent.change(screen.getByTestId('cache-logs-max'), { target: { value: '64' } });
		await act(async () => {
			fireEvent.click(screen.getByTestId('cache-save'));
		});
		await waitFor(() => expect(screen.getByTestId('cache-status').textContent).toBe('Settings saved'));
		const put = calls.filter((c) => c.method === 'PUT').at(-1)!;
		expect(put.body).toMatchObject({
			kinds: { exports: { maxAgeDays: null } },
			logs: { maxAgeDays: null, maxBytes: 64 * MB },
		});
		// Shown back as "never".
		expect((screen.getByTestId('cache-kind-exports-days') as HTMLInputElement).value).toBe('never');
		fireEvent.change(screen.getByTestId('cache-kind-exports-days'), { target: { value: 'soon' } });
		await act(async () => {
			fireEvent.click(screen.getByTestId('cache-save'));
		});
		expect(screen.getByTestId('cache-status').textContent).toContain('"never"');
	});

	it('Change… checks a folder, refuses an unusable one, moves with progress and refreshes', async () => {
		const { calls } = mount();
		await waitFor(() =>
			expect(screen.getByTestId('cache-location').textContent).toBe('/home/me/.local/share/jasper'),
		);
		fireEvent.click(screen.getByTestId('cache-location-change'));
		fireEvent.change(screen.getByTestId('cache-location-path'), { target: { value: '/full' } });
		await act(async () => {
			fireEvent.click(screen.getByTestId('cache-location-check'));
		});
		await waitFor(() =>
			expect(screen.getByTestId('cache-location-result').textContent).toContain('Not enough free space'),
		);
		expect((screen.getByTestId('cache-location-move') as HTMLButtonElement).disabled).toBe(true);
		fireEvent.change(screen.getByTestId('cache-location-path'), { target: { value: '/mnt/fast' } });
		await act(async () => {
			fireEvent.click(screen.getByTestId('cache-location-check'));
		});
		await waitFor(() =>
			expect(screen.getByTestId('cache-location-result').textContent).toContain('copies 430.0 MB'),
		);
		await act(async () => {
			fireEvent.click(screen.getByTestId('cache-location-move'));
		});
		await waitFor(
			() => expect(screen.getByTestId('cache-status').textContent).toBe('The media cache location changed'),
			{
				timeout: 5000,
			},
		);
		expect(calls.find((c) => c.url === '/api/cache/location')?.body).toEqual({
			path: '/mnt/fast',
			mode: 'move',
		});
		await waitFor(() =>
			expect(screen.getByTestId('cache-location').textContent).toBe('/mnt/fast/JasperEditor Media Cache'),
		);
		expect(screen.queryByTestId('cache-location-panel')).toBeNull();
	});
});

describe('Media Cache command and menu', () => {
	it('Edit ▸ Preferences ▸ Media Cache… opens the page', async () => {
		expect(cacheCommands.map((c) => c.id)).toEqual(['cache.preferences']);
		const ids: string[] = [];
		const walk = (x: unknown): void => {
			if (Array.isArray(x)) {
				for (const v of x) walk(v);
				return;
			}
			if (!x || typeof x !== 'object') return;
			const o = x as Record<string, unknown>;
			if (o.type === 'command') ids.push(o.command as string);
			for (const v of Object.values(o)) if (typeof v === 'object') walk(v);
		};
		walk(MENUBAR);
		expect(ids).toContain('cache.preferences');
		const engine = fakeEngine();
		render(
			<EngineProvider client={engine.client} connectEvents={false}>
				<PreferencesDialog page="media-cache" close={() => {}} />
			</EngineProvider>,
		);
		expect(screen.getByTestId('prefs-page-media-cache').getAttribute('aria-current')).toBe('page');
		await waitFor(() => expect(screen.getByTestId('prefs-cache')).toBeTruthy());
	});
});
