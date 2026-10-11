import {
	type CacheLocationCheck,
	CacheSettingsSchema,
	type CacheUsage,
	type DesktopBridge,
} from '@jasper/api';
import { closeAllDialogs, DialogHost, openDialog } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaCachePreferencesPage } from '../src/cache/MediaCachePage.tsx';
import { MG_IMPORT_DIALOG, registerImportRemotionDialog } from '../src/mg-bundles/ImportDialog.tsx';

const mocks = vi.hoisted(() => ({
	desktop: true,
	pickFolder: vi.fn<DesktopBridge['pickFolder']>(),
	client: { call: vi.fn<(route: string) => Promise<CacheUsage | CacheLocationCheck>>() },
	subscribe: () => () => {},
}));

vi.mock('../src/runtime/platform.ts', () => ({
	getDesktopBridge: () => (mocks.desktop ? { pickFolder: mocks.pickFolder } : null),
}));
vi.mock('../src/state/engine.tsx', () => ({
	useEngine: () => ({ client: mocks.client, subscribe: mocks.subscribe }),
	useEngineOrNull: () => null,
}));

const usage: CacheUsage = {
	location: '/media/current-cache',
	totalBytes: 0,
	inUseBytes: 0,
	referencedBytes: 0,
	unusedBytes: 0,
	maxTotalBytes: null,
	automaticBudget: true,
	freeDiskBytes: null,
	kinds: [],
	other: [],
	settings: CacheSettingsSchema.parse({}),
	lastGc: null,
	scannedAt: '2026-10-11T00:00:00Z',
};

async function openCacheLocation() {
	render(<MediaCachePreferencesPage />);
	await act(async () => {});
	fireEvent.click(screen.getByTestId('cache-location-change'));
}

async function openRemotionImport() {
	registerImportRemotionDialog();
	render(<DialogHost />);
	await act(async () => {
		void openDialog(MG_IMPORT_DIALOG, {});
	});
}

beforeEach(() => {
	mocks.desktop = true;
	mocks.pickFolder.mockReset();
	mocks.client.call.mockReset().mockResolvedValue(usage);
});
afterEach(() => {
	cleanup();
	closeAllDialogs();
});

describe.each([
	{
		name: 'cache location',
		open: openCacheLocation,
		input: 'cache-location-path',
		error: 'cache-location-error',
	},
	{ name: 'Remotion import', open: openRemotionImport, input: 'mg-import-path', error: 'mg-import-error' },
])('$name folder picker', ({ open, input, error }) => {
	it('disables the form while choosing and writes the selected path', async () => {
		let resolveSelection: ((path: string | null) => void) | undefined;
		mocks.pickFolder.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveSelection = resolve;
				}),
		);
		await open();
		const browse = screen.getByRole<HTMLButtonElement>('button', { name: 'Browse…' });
		const path = screen.getByTestId<HTMLInputElement>(input);
		fireEvent.click(browse);
		expect(browse.disabled).toBe(true);
		expect(path.disabled).toBe(true);
		await act(async () => resolveSelection?.('/media/selected'));
		expect(path.value).toBe('/media/selected');
		expect(browse.disabled).toBe(false);
		expect(path.disabled).toBe(false);
		expect(mocks.pickFolder).toHaveBeenCalledExactlyOnceWith();
	});

	it('preserves the typed path when the dialog is cancelled', async () => {
		mocks.pickFolder.mockResolvedValueOnce(null);
		await open();
		const path = screen.getByTestId<HTMLInputElement>(input);
		fireEvent.change(path, { target: { value: '/media/typed' } });
		await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Browse…' })));
		expect(path.value).toBe('/media/typed');
		expect(screen.queryByTestId(error)).toBeNull();
	});

	it('reports dialog errors, preserves the path, and allows retrying', async () => {
		mocks.pickFolder.mockRejectedValueOnce(new Error('native dialog unavailable'));
		await open();
		const path = screen.getByTestId<HTMLInputElement>(input);
		const browse = screen.getByRole<HTMLButtonElement>('button', { name: 'Browse…' });
		fireEvent.change(path, { target: { value: '/media/typed' } });
		await act(async () => fireEvent.click(browse));
		expect(screen.getByTestId(error).textContent).toBe(
			'Could not choose a folder: native dialog unavailable',
		);
		expect(path.value).toBe('/media/typed');
		expect(browse.disabled).toBe(false);
		mocks.pickFolder.mockResolvedValueOnce('/media/retried');
		await act(async () => fireEvent.click(browse));
		expect(path.value).toBe('/media/retried');
		expect(screen.queryByTestId(error)).toBeNull();
	});

	it('keeps path entry available without a desktop bridge', async () => {
		mocks.desktop = false;
		await open();
		expect(screen.queryByRole('button', { name: 'Browse…' })).toBeNull();
		expect(screen.getByTestId<HTMLInputElement>(input).disabled).toBe(false);
	});
});

it('keeps a cache location check on cancellation and invalidates it after a selection', async () => {
	await openCacheLocation();
	const path = screen.getByTestId<HTMLInputElement>('cache-location-path');
	fireEvent.change(path, { target: { value: '/media/checked' } });
	const check: CacheLocationCheck = {
		path: '/media/checked',
		isDefault: false,
		ok: true,
		message: null,
		exists: true,
		writable: true,
		freeBytes: null,
		requiredBytes: 0,
		sameDevice: true,
		sameAsCurrent: false,
	};
	mocks.client.call.mockResolvedValueOnce(check);
	await act(async () => fireEvent.click(screen.getByTestId('cache-location-check')));
	expect(screen.getByTestId('cache-location-result').textContent).toContain('/media/checked');
	mocks.pickFolder.mockResolvedValueOnce(null);
	await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Browse…' })));
	expect(screen.getByTestId('cache-location-result').textContent).toContain('/media/checked');
	mocks.pickFolder.mockResolvedValueOnce('/media/selected');
	await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Browse…' })));
	expect(screen.queryByTestId('cache-location-result')).toBeNull();
});
