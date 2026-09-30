// Electron main (ARCHITECTURE §12, D-17). WP-00 minimal shell: loads the Vite dev server (or
// JASPER_DESKTOP_DEV_URL) in a sandboxed window. WP-2H adds the packaged mode (engine fork + token).
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';

const here = dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.JASPER_DESKTOP_DEV_URL ?? 'http://127.0.0.1:5173';

function createWindow(): BrowserWindow {
	const win = new BrowserWindow({
		width: 1600,
		height: 960,
		minWidth: 1200,
		minHeight: 720,
		backgroundColor: '#1d1d1d',
		show: false,
		title: 'JasperEditor',
		webPreferences: {
			preload: join(here, 'preload.cjs'),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
		},
	});
	win.once('ready-to-show', () => win.show());
	const origin = new URL(DEV_URL).origin;
	win.webContents.setWindowOpenHandler(({ url }) => {
		void shell.openExternal(url);
		return { action: 'deny' };
	});
	win.webContents.on('will-navigate', (event, url) => {
		if (new URL(url).origin !== origin) {
			event.preventDefault();
			void shell.openExternal(url);
		}
	});
	void win.loadURL(DEV_URL);
	return win;
}

ipcMain.handle('jasper:pick-media', async () => {
	const r = await dialog.showOpenDialog({
		properties: ['openFile', 'multiSelections'],
		filters: [
			{
				name: 'Media',
				extensions: [
					'mp4',
					'mov',
					'm4v',
					'mkv',
					'webm',
					'mp3',
					'wav',
					'aac',
					'm4a',
					'flac',
					'png',
					'jpg',
					'jpeg',
					'webp',
					'gif',
				],
			},
		],
	});
	return r.canceled ? [] : r.filePaths;
});
ipcMain.on('jasper:reveal', (_e, path: string) => shell.showItemInFolder(path));
ipcMain.on('jasper:window', (e, action: 'minimize' | 'toggleMaximize' | 'close') => {
	const win = BrowserWindow.fromWebContents(e.sender);
	if (!win) return;
	if (action === 'minimize') win.minimize();
	else if (action === 'toggleMaximize') {
		if (win.isMaximized()) win.unmaximize();
		else win.maximize();
	} else win.close();
});

app.whenReady().then(() => {
	createWindow();
	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});
