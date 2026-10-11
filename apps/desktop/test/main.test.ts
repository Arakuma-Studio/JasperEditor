import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
	quit: vi.fn(),
	showErrorBox: vi.fn(),
	loadURL: vi.fn<() => Promise<void>>(),
	show: vi.fn(),
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
		webContents = { on: vi.fn() };
		once = vi.fn();
		loadURL = electron.loadURL;
		show = electron.show;
		isDestroyed = () => false;
	},
	ClipboardItem: class {},
	clipboard: {},
	dialog: { showErrorBox: electron.showErrorBox },
	ipcMain: { handle: vi.fn(), on: vi.fn() },
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
