// Preload (sandboxed, CommonJS): exposes the minimal desktop bridge (ARCHITECTURE §12). No media bytes
// cross IPC; the renderer talks HTTP to the engine like the web build.
import { contextBridge, ipcRenderer, webUtils } from 'electron';

const bridge = {
	runtime: 'desktop' as const,
	pickMedia: (): Promise<string[]> => ipcRenderer.invoke('jasper:pick-media'),
	revealInFolder: (path: string): void => ipcRenderer.send('jasper:reveal', path),
	windowControls: {
		minimize: (): void => ipcRenderer.send('jasper:window', 'minimize'),
		toggleMaximize: (): void => ipcRenderer.send('jasper:window', 'toggleMaximize'),
		close: (): void => ipcRenderer.send('jasper:window', 'close'),
	},
	/** Brings the window to the front (an agent asked the editor to show a project). */
	focusWindow: (): void => ipcRenderer.send('jasper:window', 'focus'),
	/** The bundled jasper-mcp server and how to launch it (Help ▸ Connect an AI Agent…). */
	mcpInfo: (): Promise<{ entry: string | null; command: string; env: Record<string, string> }> =>
		ipcRenderer.invoke('jasper:mcp-info'),
	/** wp-clipboard (S01:CLB-002): the custom application/x-jasper-clipboard format (validated in main). */
	clipboard: {
		write: (data: { json: string; html: string; text: string }): Promise<boolean> =>
			ipcRenderer.invoke('jasper:clipboard-write', data),
		read: (): Promise<string | null> => ipcRenderer.invoke('jasper:clipboard-read'),
		/** wp-clipboard-2 (S01:CLB-010): paths of the files copied in the OS file manager. */
		readFiles: (): Promise<string[]> => ipcRenderer.invoke('jasper:clipboard-read-files'),
	},
	/** wp-clipboard-2 (S01:CLB-010): the path of a pasted File ('' for data that is not a file on disk). */
	filePath: (file: File): string => {
		try {
			return webUtils.getPathForFile(file);
		} catch {
			return '';
		}
	},
	/** mcp-cli (live-UI automation): a PNG (base64) of the window or a CSS-px rect of it, at most maxWidth wide. */
	capturePage: (
		rect: { x: number; y: number; width: number; height: number },
		maxWidth: number,
	): Promise<{ png: string; width: number; height: number }> =>
		ipcRenderer.invoke('jasper:capture-page', rect, maxWidth),
	/** gaps (Edit Original): opens a file in its default application ('' = ok, else the error). */
	openPath: (path: string): Promise<string> => ipcRenderer.invoke('jasper:open-path', path),
	/** gaps (File ▸ Exit): quits the app after the renderer handled unsaved changes. */
	quit: (): void => ipcRenderer.send('jasper:quit'),
	onMenuCommand: (cb: (commandId: string) => void): (() => void) => {
		const listener = (_e: unknown, id: string) => cb(id);
		ipcRenderer.on('jasper:menu-command', listener);
		return () => ipcRenderer.removeListener('jasper:menu-command', listener);
	},
};

contextBridge.exposeInMainWorld('jasperDesktop', bridge);
