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
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	app,
	BrowserWindow,
	ClipboardItem,
	clipboard,
	dialog,
	ipcMain,
	Menu,
	session,
	shell,
	systemPreferences,
} from 'electron';
import { type EngineProcess, startEngineProcess } from './engine-process.ts';
import {
	CLIPBOARD_CUSTOM_FORMAT,
	CLIPBOARD_FILE_LIST_TYPE,
	clipboardReadResult,
	ELECTRON_CLIPBOARD_FORMAT,
	isCaptureRect,
	isClipboardWrite,
	isExternalUrlAllowed,
	isOpenablePath,
	isPermissionAllowed,
	isRevealablePath,
	isSameOrigin,
	isWindowAction,
	MEDIA_EXTENSIONS,
	mcpLaunchInfo,
	parseClipboardFileList,
	sessionCookies,
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
	});
	win.webContents.on('did-fail-load', (_e, code, desc, failedUrl) =>
		log(`failed to load ${failedUrl}: ${code} ${desc}`),
	);
	void win.loadURL(url);
	return win;
}

/**
 * IPC is answered only for the window's own document: the top frame, on the app origin. A subframe is never the
 * app — a motion-graphics bundle's page is a sandboxed frame whose URL is on the engine's origin although its
 * origin is opaque (security review MG-1); the preload does not run there, and this does not rely on that.
 */
function fromApp(e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
	const frame = e.senderFrame;
	const url = frame?.url;
	return !!frame && frame.parent === null && !!url && !!appOrigin && isSameOrigin(url, appOrigin);
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
		// A Node runtime shipped in the resources runs jasper-mcp (and the engine's workers) instead of the app
		// binary as Node; without one the binary does (which is why the runAsNode fuse stays on, RUN-1).
		const node =
			mode === 'packaged'
				? join(process.resourcesPath, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
				: null;
		return mcpLaunchInfo({
			packaged: mode === 'packaged',
			entry: mcpEntry,
			exists: existsSync(mcpEntry),
			execPath: process.execPath,
			bundledNode: node && existsSync(node) ? node : null,
		});
	});
	// mcp-cli (live-UI automation, ui_screenshot): the window's own pixels (WebGL included), cropped and scaled.
	ipcMain.handle('jasper:capture-page', async (e, rect: unknown, maxWidth: unknown) => {
		if (!fromApp(e) || !isCaptureRect(rect)) return null;
		const image = await e.sender.capturePage({
			x: Math.round(rect.x),
			y: Math.round(rect.y),
			width: Math.round(rect.width),
			height: Math.round(rect.height),
		});
		const size = image.getSize();
		const limit = typeof maxWidth === 'number' && maxWidth >= 64 ? Math.min(4096, maxWidth) : 1600;
		const out = size.width > limit ? image.resize({ width: limit, quality: 'best' }) : image;
		const s = out.getSize();
		return { png: out.toPNG().toString('base64'), width: s.width, height: s.height };
	});
	// wp-clipboard (S01:CLB-002): the JasperEditor payload as the custom application/x-jasper-clipboard format,
	// written atomically with its text/html and text/plain forms; reads return only that format's JSON.
	ipcMain.handle('jasper:clipboard-write', async (e, data: unknown) => {
		if (!fromApp(e) || !isClipboardWrite(data)) return false;
		try {
			await clipboard.write([
				new ClipboardItem({
					'text/plain': data.text,
					'text/html': data.html,
					[ELECTRON_CLIPBOARD_FORMAT]: new Blob([data.json], { type: CLIPBOARD_CUSTOM_FORMAT }),
				}),
			]);
			return true;
		} catch (err) {
			log(`clipboard write failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	});
	ipcMain.handle('jasper:clipboard-read', async (e) => {
		if (!fromApp(e)) return null;
		try {
			if (!(await clipboard.has(ELECTRON_CLIPBOARD_FORMAT))) return null;
			for (const item of await clipboard.read()) {
				try {
					const blob = (await item.getType(ELECTRON_CLIPBOARD_FORMAT)) as Blob;
					const json = clipboardReadResult(await blob.text());
					if (json) return json;
				} catch {
					// this entry does not carry the format
				}
			}
		} catch (err) {
			log(`clipboard read failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		return null;
	});
	// wp-clipboard-2 (S01:CLB-010): files copied in the OS file manager, as absolute paths that exist; the
	// renderer registers them in place (S04:IN-003). Edit ▸ Paste needs this: the web API exposes no files.
	ipcMain.handle('jasper:clipboard-read-files', async (e) => {
		if (!fromApp(e)) return [];
		const paths: string[] = [];
		try {
			for (const item of await clipboard.read()) {
				for (const type of item.types) {
					if (!CLIPBOARD_FILE_LIST_TYPE.test(type)) continue;
					try {
						const blob = (await item.getType(type)) as Blob;
						for (const p of parseClipboardFileList(await blob.text()))
							if (!paths.includes(p) && existsSync(p)) paths.push(p);
					} catch {
						// unreadable entry
					}
				}
			}
		} catch (err) {
			log(`clipboard file read failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		return paths;
	});
	ipcMain.on('jasper:reveal', (e, p: unknown) => {
		if (fromApp(e) && isRevealablePath(p) && existsSync(p)) shell.showItemInFolder(p);
	});
	// gaps (Edit Original): open a media file in the OS default application.
	ipcMain.handle('jasper:open-path', async (e, p: unknown) => {
		if (!fromApp(e) || !isOpenablePath(p)) return 'This file cannot be opened from JasperEditor';
		if (!existsSync(p)) return 'The file does not exist';
		return shell.openPath(p);
	});
	// gaps (File ▸ Exit): the renderer asked about unsaved changes first.
	ipcMain.on('jasper:quit', (e) => {
		if (fromApp(e)) app.quit();
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
	// Security review AGT-2: the editor key. The engine's runtime file tells local tools (jasper-mcp) the token; the
	// key is known to the engine and to this window only, which is how the engine tells the user from an agent.
	const editorKey = randomBytes(32).toString('base64url');
	const dir = appdir();
	mkdirSync(dir, { recursive: true });
	engine = await startEngineProcess({
		entry: engineEntry,
		appdir: dir,
		webDir,
		token,
		editorKey,
		resourcesDir,
	});
	log(`engine ready on ${engine.origin} (appdir ${dir})`);
	// HttpOnly SameSite=Strict cookies: media elements, fetches and the /agent WebSocket carry them, page scripts
	// (and anything a page loads) cannot read them (ARCH §4.2).
	for (const [name, value] of Object.entries(sessionCookies(new URL(engine.origin).port, token, editorKey)))
		await session.defaultSession.cookies.set({
			url: engine.origin,
			name,
			value,
			httpOnly: true,
			sameSite: 'strict',
			secure: false,
		});
	return `${engine.origin}/`;
}

/**
 * audio-mix: media permissions for voice-over recording. Microphone requests from the app origin are granted (on
 * macOS after the system prompt, `askForMediaAccess`); every other permission request and origin is denied.
 */
function registerPermissions(): void {
	const ses = session.defaultSession;
	ses.setPermissionRequestHandler((wc, permission, callback, details) => {
		const url = (details as { requestingUrl?: string }).requestingUrl ?? wc.getURL();
		const types = ((details as { mediaTypes?: string[] }).mediaTypes ?? []) as string[];
		if (!isPermissionAllowed(permission, url, appOrigin, types)) return callback(false);
		if (permission === 'media' && process.platform === 'darwin') {
			systemPreferences
				.askForMediaAccess('microphone')
				.then(callback)
				.catch(() => callback(false));
			return;
		}
		callback(true);
	});
	ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
		const types = (details as { mediaType?: string }).mediaType
			? [(details as { mediaType: string }).mediaType]
			: ['audio'];
		return isPermissionAllowed(permission, requestingOrigin, appOrigin, permission === 'media' ? types : []);
	});
}

async function boot(): Promise<void> {
	registerIpc();
	registerPermissions();
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

// fx framework (wave 1): Chrome's HTML-in-Canvas lets the Program monitor run GPU shader effects on DOM layers
// (text, shapes, motion graphics) — Remotion's render browser always enables it; must be set before `ready`.
app.commandLine.appendSwitch('enable-features', 'CanvasDrawElement');

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
