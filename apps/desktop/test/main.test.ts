import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
	clipboard: {},
	dialog: { showErrorBox: electron.showErrorBox, showOpenDialog: electron.showOpenDialog },
	ipcMain: {
		handle: (channel: string, handler: PickerHandler) => {
			if (channel === 'jasper:pick-folder') electron.pickFolder.mockImplementation(handler);
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
		await vi.waitFor(() =>
			expect(electron.showErrorBox).toHaveBeenCalledWith(
				'JasperEditor',
				expect.stringContaining('Could not start the editor:'),
			),
		);
		expect(electron.quit).toHaveBeenCalledOnce();
	});

	it('reports failed editor loads instead of leaving an invisible window', async () => {
		vi.stubEnv('JASPER_DESKTOP_DEV_URL', 'http://127.0.0.1:5173');
		electron.loadURL.mockRejectedValueOnce(new Error('connection refused'));
		await import('../src/main.ts');
		await vi.waitFor(() =>
			expect(electron.showErrorBox).toHaveBeenCalledWith(
				'JasperEditor',
				'Could not load the editor:\nconnection refused',
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
		expect(electron.showOpenDialog).toHaveBeenCalledWith(owner, {
			title: 'Choose Folder',
			properties: ['openDirectory'],
		});
	});

	it('returns null on cancellation', async () => {
		electron.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
		await expect(electron.pickFolder(event)).resolves.toBeNull();
		expect(electron.showOpenDialog).toHaveBeenCalledWith({
			title: 'Choose Folder',
			properties: ['openDirectory'],
		});
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
