import type { DesktopBridge } from '@jasper/api';
import { contextBridge, ipcRenderer, webUtils } from 'electron';

const bridge: DesktopBridge = {
	runtime: 'desktop' as const,
	pickMedia: (): Promise<string[]> => ipcRenderer.invoke('jasper:pick-media'),
	revealInFolder: (path: string): void => ipcRenderer.send('jasper:reveal', path),
	windowControls: {
		minimize: (): void => ipcRenderer.send('jasper:window', 'minimize'),
		toggleMaximize: (): void => ipcRenderer.send('jasper:window', 'toggleMaximize'),
		close: (): void => ipcRenderer.send('jasper:window', 'close'),
	},
	focusWindow: (): void => ipcRenderer.send('jasper:window', 'focus'),
	mcpInfo: () => ipcRenderer.invoke('jasper:mcp-info'),
	clipboard: {
		write: (data) => ipcRenderer.invoke('jasper:clipboard-write', data),
		read: (): Promise<string | null> => ipcRenderer.invoke('jasper:clipboard-read'),
		readFiles: (): Promise<string[]> => ipcRenderer.invoke('jasper:clipboard-read-files'),
	},
	/** The path of a pasted File ('' for data that is not a file on disk). */
	filePath: (file: File): string => {
		try {
			return webUtils.getPathForFile(file);
		} catch {
			return '';
		}
	},
	/** mcp-cli (live-UI automation): a PNG (base64) of the window or a CSS-px rect of it, at most maxWidth wide. */
	capturePage: (rect, maxWidth) => ipcRenderer.invoke('jasper:capture-page', rect, maxWidth),
	/** Opens a file in its default application ('' = ok, else the error). */
	openPath: (path: string): Promise<string> => ipcRenderer.invoke('jasper:open-path', path),
	quit: (): void => ipcRenderer.send('jasper:quit'),
};

contextBridge.exposeInMainWorld('jasperDesktop', bridge);
