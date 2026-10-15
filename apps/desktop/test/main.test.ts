import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ELECTRON_CLIPBOARD_FORMAT } from '../src/security.ts';

type PickerEvent = {
	senderFrame: { url: string; parent: { url: string } | null } | null;
	sender: { id: number };
};
type PickerHandler = (event: PickerEvent) => Promise<string | null>;

const electron = vi.hoisted(() => ({
	quit: vi.fn(),
	showErrorBox: vi.fn(),
	loadURL: vi.fn<() => Promise<void>>(),
	show: vi.fn(),
	showOpenDialog: vi.fn<() => Promise<{ canceled: boolean; filePaths: string[] }>>(),
	fromWebContents: vi.fn<() => { id: number } | null>(() => null),
	pickFolder: vi.fn<PickerHandler>(),
	clipboardHandlers: new Map<string, (event: PickerEvent) => Promise<unknown>>(),
	clipboardHas: vi.fn<() => Promise<boolean>>(),
	clipboardRead: vi.fn<() => Promise<{ types: string[]; getType(): Promise<Blob> }[]>>(),
}));

vi.mock('electron', () => ({
	app: {
		isPackaged: false,
		setName: vi.fn(),
		commandLine: { appendSwitch: vi.fn() },
		requestSingleInstanceLock: () => true,
		whenReady: () => Promise.resolve(),
		on: vi.fn(),
		quit: electron.quit,
	},
	BrowserWindow: class {
		static fromWebContents = electron.fromWebContents;
		webContents = { on: vi.fn() };
		once = vi.fn();
		loadURL = electron.loadURL;
		show = electron.show;
		isDestroyed = () => false;
	},
	ClipboardItem: class {},
	clipboard: { has: electron.clipboardHas, read: electron.clipboardRead },
	dialog: { showErrorBox: electron.showErrorBox, showOpenDialog: electron.showOpenDialog },
	ipcMain: {
		handle: (channel: string, handler: PickerHandler) => {
			if (channel === 'jasper:pick-folder') electron.pickFolder.mockImplementation(handler);
			if (channel === 'jasper:clipboard-read' || channel === 'jasper:clipboard-read-files')
				electron.clipboardHandlers.set(channel, handler);
		},
		on: vi.fn(),
	},
	Menu: { setApplicationMenu: vi.fn() },
	session: {
		defaultSession: {
			setPermissionRequestHandler: vi.fn(),
			setPermissionCheckHandler: vi.fn(),
		},
	},
	shell: {},
	systemPreferences: {},
	utilityProcess: {},
}));

describe('desktop startup failures', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		vi.stubEnv('JASPER_DESKTOP_MODE', 'dev');
	});

	afterEach(() => vi.unstubAllEnvs());

	it('reports invalid development URLs and exits through the normal shutdown path', async () => {
		vi.stubEnv('JASPER_DESKTOP_DEV_URL', 'not a URL');
		await import('../src/main.ts');
		await vi.waitFor(() => expect(electron.showErrorBox).toHaveBeenCalled());
		expect(electron.quit).toHaveBeenCalledOnce();
	});

	it('reports failed editor loads instead of leaving an invisible window', async () => {
		vi.stubEnv('JASPER_DESKTOP_DEV_URL', 'http://127.0.0.1:5173');
		electron.loadURL.mockRejectedValueOnce(new Error('connection refused'));
		await import('../src/main.ts');
		await vi.waitFor(() =>
			expect(electron.showErrorBox).toHaveBeenCalledWith(
				expect.any(String),
				expect.stringContaining('connection refused'),
			),
		);
		expect(electron.show).toHaveBeenCalledOnce();
	});
});

describe('desktop folder picker IPC', () => {
	beforeEach(async () => {
		vi.resetModules();
		vi.clearAllMocks();
		electron.pickFolder.mockReset();
		electron.loadURL.mockResolvedValue(undefined);
		electron.fromWebContents.mockReturnValue(null);
		vi.stubEnv('JASPER_DESKTOP_MODE', 'dev');
		vi.stubEnv('JASPER_DESKTOP_DEV_URL', 'http://127.0.0.1:5173');
		await import('../src/main.ts');
		await vi.waitFor(() => expect(electron.pickFolder.getMockImplementation()).toBeTypeOf('function'));
	});

	afterEach(() => vi.unstubAllEnvs());

	const event: PickerEvent = {
		senderFrame: { url: 'http://127.0.0.1:5173/editor', parent: null },
		sender: { id: 1 },
	};

	it('opens a single-directory dialog owned by the requesting window', async () => {
		const owner = { id: 3 };
		electron.fromWebContents.mockReturnValueOnce(owner);
		electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/media/cache'] });
		await expect(electron.pickFolder(event)).resolves.toBe('/media/cache');
		expect(electron.fromWebContents).toHaveBeenCalledWith(event.sender);
		expect(electron.showOpenDialog).toHaveBeenCalledWith(
			owner,
			expect.objectContaining({ properties: ['openDirectory'] }),
		);
	});

	it('returns null on cancellation', async () => {
		electron.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
		await expect(electron.pickFolder(event)).resolves.toBeNull();
	});

	it('propagates native dialog failures instead of reporting cancellation', async () => {
		electron.showOpenDialog.mockRejectedValueOnce(new Error('native dialog unavailable'));
		await expect(electron.pickFolder(event)).rejects.toThrow('native dialog unavailable');
	});

	it.each<PickerEvent['senderFrame']>([
		null,
		{ url: 'https://example.com', parent: null },
		{ url: 'http://127.0.0.1:5173/editor', parent: { url: 'http://127.0.0.1:5173' } },
	])('refuses callers outside the app document: %j', async (senderFrame) => {
		await expect(electron.pickFolder({ ...event, senderFrame })).resolves.toBeNull();
		expect(electron.showOpenDialog).not.toHaveBeenCalled();
	});
});

describe('desktop clipboard read isolation', () => {
	beforeEach(async () => {
		vi.resetModules();
		vi.clearAllMocks();
		electron.clipboardHandlers.clear();
		electron.clipboardHas.mockResolvedValue(true);
		electron.loadURL.mockResolvedValue(undefined);
		vi.stubEnv('JASPER_DESKTOP_MODE', 'dev');
		vi.stubEnv('JASPER_DESKTOP_DEV_URL', 'http://127.0.0.1:5173');
		await import('../src/main.ts');
		await vi.waitFor(() => expect(electron.clipboardHandlers.size).toBe(2));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it.each([
		['jasper:clipboard-read', 'getType'],
		['jasper:clipboard-read', 'text'],
		['jasper:clipboard-read-files', 'getType'],
		['jasper:clipboard-read-files', 'text'],
	])('%s keeps later valid entries when %s rejects', async (channel, failure) => {
		const files = channel === 'jasper:clipboard-read-files';
		const format = files ? 'text/uri-list' : ELECTRON_CLIPBOARD_FORMAT;
		const file = new URL('../src/security.ts', import.meta.url);
		const json = JSON.stringify({ format: 'jasper-clipboard', version: 1, kind: 'clips' });
		const unreadable = new Blob();
		const error = new Error('clipboard entry unavailable');
		if (failure === 'text') vi.spyOn(unreadable, 'text').mockRejectedValue(error);
		electron.clipboardRead.mockResolvedValueOnce([
			{
				types: [format],
				getType: () => (failure === 'getType' ? Promise.reject(error) : Promise.resolve(unreadable)),
			},
			{ types: [format], getType: async () => new Blob([files ? file.href : json]) },
		]);
		const handler = electron.clipboardHandlers.get(channel)!;
		await expect(
			handler({
				senderFrame: { url: 'http://127.0.0.1:5173/editor', parent: null },
				sender: { id: 1 },
			}),
		).resolves.toEqual(files ? [fileURLToPath(file)] : json);
	});
});
