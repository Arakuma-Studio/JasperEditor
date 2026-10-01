// Electron main (ARCHITECTURE §12, D-17; S05 §21; R-OMS §8.5). No second renderer app and no IPC byte
// bridge: the window loads the same SPA over HTTP.
//   dev             → loads JASPER_DESKTOP_DEV_URL (default http://127.0.0.1:5173; Vite proxies the dev engine)
//   packaged-like   → forks apps/engine/dist/engine.mjs (utilityProcess, --port 0, per-launch token),
//                     sets the HttpOnly SameSite=Strict jasper_session cookie, loads the engine origin,
//                     which serves apps/web/dist (`pnpm build` first)
//   packaged        → same as packaged-like with resources from process.resourcesPath (M3 installers)
// The engine writes <appdir>/engine/runtime.json, which is how the bundled jasper-mcp server
// (resources/mcp/jasper-mcp.mjs; Help ▸ Connect an AI Agent…) finds this app's engine and token.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron';
import { type EngineProcess, startEngineProcess } from './engine-process.ts';
import {
	isExternalUrlAllowed,
	isRevealablePath,
	isSameOrigin,
	isWindowAction,
	MEDIA_EXTENSIONS,
	mcpLaunchInfo,
} from './security.ts';

const here = dirname(fileURLToPath(import.meta.url)); // apps/desktop/dist-electron
const DEFAULT_DEV_URL = 'http://127.0.0.1:5173';
const BG = '#1d1d1d';
const SYMBOLS = '#e3e3e3';
const TITLE_BAR_HEIGHT = 28;

type Mode = 'dev' | 'packaged-like' | 'packaged';
const mode: Mode = app.isPackaged
	? 'packaged'
	: process.env.JASPER_DESKTOP_MODE === 'packaged-like' || process.argv.includes('--packaged-like')
		? 'packaged-like'
		: 'dev';

app.setName('JasperEditor');
// Hosts without a configured chrome-sandbox SUID helper (CI, containers) must launch with
// ELECTRON_DISABLE_SANDBOX=1 (Chromium checks it before main runs); renderers keep contextIsolation +
// sandbox: true webPreferences and the minimal preload.

let engine: EngineProcess | null = null;
let appOrigin = '';

function log(msg: string): void {
	console.log(`[desktop] ${msg}`);
}

function resources(): { engineEntry: string; webDir: string; resourcesDir: string | null; mcpEntry: string } {
	if (mode === 'packaged')
		return {
			engineEntry: join(process.resourcesPath, 'engine', 'engine.mjs'),
			webDir: join(process.resourcesPath, 'web'),
			// <resources>/ffmpeg-lgpl: the LGPL FFmpeg + Remotion binaries directory (D-13).
			resourcesDir: process.resourcesPath,
			mcpEntry: join(process.resourcesPath, 'mcp', 'jasper-mcp.mjs'),
		};
	const repo = resolve(here, '../../..');
	return {
		engineEntry: process.env.JASPER_ENGINE_ENTRY ?? join(repo, 'apps/engine/dist/engine.mjs'),
		webDir: process.env.JASPER_WEB_DIR ?? join(repo, 'apps/web/dist'),
		// packaged-like: the engine finds vendor/ffmpeg-lgpl/<platform> in the checkout (`pnpm ffmpeg:lgpl`).
		resourcesDir: process.env.JASPER_RESOURCES_DIR ?? null,
		mcpEntry: process.env.JASPER_MCP_ENTRY ?? join(repo, 'apps/mcp/dist/jasper-mcp.mjs'),
	};
}

function appdir(): string {
	return process.env.JASPER_APPDIR
		? resolve(process.env.JASPER_APPDIR)
		: join(app.getPath('userData'), 'jasper');
}

function openExternalSafe(url: string): void {
	if (isExternalUrlAllowed(url)) void shell.openExternal(url);
}

function createWindow(url: string): BrowserWindow {
	const mac = process.platform === 'darwin';
	const win = new BrowserWindow({
		width: 1600,
		height: 960,
		minWidth: 1200,
		minHeight: 720,
		title: 'JasperEditor',
		backgroundColor: BG,
		show: false,
		frame: mac,
		titleBarStyle: mac ? 'hiddenInset' : 'hidden',
		...(mac
			? { trafficLightPosition: { x: 12, y: 8 } }
			: { titleBarOverlay: { color: BG, symbolColor: SYMBOLS, height: TITLE_BAR_HEIGHT } }),
		webPreferences: {
			preload: join(here, 'preload.cjs'),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			webSecurity: true,
			spellcheck: false,
		},
	});
	win.once('ready-to-show', () => win.show());
	win.webContents.on('will-navigate', (event, target) => {
		if (!isSameOrigin(target, appOrigin)) {
			event.preventDefault();
			openExternalSafe(target);
		}
	});
	win.webContents.on('will-attach-webview', (event) => event.preventDefault());
	win.webContents.on('did-finish-load', () => {
		log(`loaded ${win.webContents.getURL()} (${mode})`);
		void maybeScreenshot(win);
	});
	win.webContents.on('did-fail-load', (_e, code, desc, failedUrl) =>
		log(`failed to load ${failedUrl}: ${code} ${desc}`),
	);
	void win.loadURL(url);
	return win;
}

/** Smoke-test hook: JASPER_DESKTOP_SCREENSHOT=<png> captures the window after load; *_EXIT=1 then quits. */
async function maybeScreenshot(win: BrowserWindow): Promise<void> {
	const target = process.env.JASPER_DESKTOP_SCREENSHOT;
	if (!target) return;
	await new Promise((r) => setTimeout(r, Number(process.env.JASPER_DESKTOP_SCREENSHOT_DELAY_MS ?? 3000)));
	if (win.isDestroyed()) return;
	const image = await win.webContents.capturePage();
	mkdirSync(dirname(resolve(target)), { recursive: true });
	writeFileSync(resolve(target), image.toPNG());
	log(`screenshot ${resolve(target)} (${image.getSize().width}x${image.getSize().height})`);
	if (process.env.JASPER_DESKTOP_EXIT === '1') app.quit();
}

/** IPC is answered only for frames on the app origin (not for any other frame that might get loaded). */
function fromApp(e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
	const url = e.senderFrame?.url;
	return !!url && !!appOrigin && isSameOrigin(url, appOrigin);
}

function registerIpc(): void {
	ipcMain.handle('jasper:pick-media', async (e) => {
		if (!fromApp(e)) return [];
		const win = BrowserWindow.fromWebContents(e.sender);
		const opts: Electron.OpenDialogOptions = {
			title: 'Import Media',
			properties: ['openFile', 'multiSelections'],
			filters: [
				{ name: 'Media', extensions: [...MEDIA_EXTENSIONS] },
				{ name: 'All Files', extensions: ['*'] },
			],
		};
		const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
		return r.canceled ? [] : r.filePaths;
	});
	// Help ▸ Connect an AI Agent…: where the bundled jasper-mcp lives and how an MCP client launches it.
	ipcMain.handle('jasper:mcp-info', (e) => {
		if (!fromApp(e)) return null;
		const { mcpEntry } = resources();
		return mcpLaunchInfo({
			packaged: mode === 'packaged',
			entry: mcpEntry,
			exists: existsSync(mcpEntry),
			execPath: process.execPath,
		});
	});
	ipcMain.on('jasper:reveal', (e, p: unknown) => {
		if (fromApp(e) && isRevealablePath(p) && existsSync(p)) shell.showItemInFolder(p);
	});
	ipcMain.on('jasper:window', (e, action: unknown) => {
		const win = BrowserWindow.fromWebContents(e.sender);
		if (!win || !fromApp(e) || !isWindowAction(action)) return;
		if (action === 'minimize') win.minimize();
		else if (action === 'focus') {
			// An agent asked the editor to show a project (jasper-mcp open_project_in_editor).
			if (win.isMinimized()) win.restore();
			win.show();
			win.focus();
		} else if (action === 'toggleMaximize') {
			if (win.isMaximized()) win.unmaximize();
			else win.maximize();
		} else win.close();
	});
}

async function startPackagedLike(): Promise<string> {
	const { engineEntry, webDir, resourcesDir } = resources();
	if (!existsSync(engineEntry)) throw new Error(`engine bundle missing: ${engineEntry} (run pnpm build)`);
	if (!existsSync(join(webDir, 'index.html')))
		throw new Error(`web build missing: ${webDir} (run pnpm build)`);
	const token = randomBytes(32).toString('base64url');
	const dir = appdir();
	mkdirSync(dir, { recursive: true });
	engine = await startEngineProcess({ entry: engineEntry, appdir: dir, webDir, token, resourcesDir });
	log(`engine ready on ${engine.origin} (appdir ${dir})`);
	// HttpOnly SameSite=Strict session cookie so media elements and fetches carry the token (ARCH §4.2).
	await session.defaultSession.cookies.set({
		url: engine.origin,
		name: 'jasper_session',
		value: token,
		httpOnly: true,
		sameSite: 'strict',
		secure: false,
	});
	return `${engine.origin}/`;
}

async function boot(): Promise<void> {
	registerIpc();
	if (process.platform !== 'darwin') Menu.setApplicationMenu(null); // Row A renders the in-app menubar (S05:EL-002)
	let url: string;
	if (mode === 'dev') {
		url = process.env.JASPER_DESKTOP_DEV_URL ?? DEFAULT_DEV_URL;
		log(`dev mode: loading ${url} (expects pnpm dev: Vite on 5173 + engine on 47900)`);
	} else {
		try {
			url = await startPackagedLike();
		} catch (e) {
			log(`could not start the engine: ${(e as Error).message}`);
			dialog.showErrorBox('JasperEditor', `Could not start the engine:\n${(e as Error).message}`);
			app.exit(1);
			return;
		}
	}
	appOrigin = new URL(url).origin;
	createWindow(url);
	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow(url);
	});
}

// One instance per user profile: a second launch focuses the first window.
if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', () => {
		const win = BrowserWindow.getAllWindows()[0];
		if (win) {
			if (win.isMinimized()) win.restore();
			win.focus();
		}
	});
	app.whenReady().then(boot);
}

app.on('web-contents-created', (_e, contents) => {
	contents.setWindowOpenHandler(({ url }) => {
		openExternalSafe(url);
		return { action: 'deny' };
	});
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});

let stopping = false;
app.on('before-quit', (event) => {
	if (!engine || stopping) return;
	stopping = true;
	event.preventDefault();
	const e = engine;
	engine = null;
	void e.stop().finally(() => app.quit());
});
