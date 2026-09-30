// Preload (sandboxed, CommonJS): exposes the minimal desktop bridge (ARCHITECTURE §12). No media bytes
// cross IPC; the renderer talks HTTP to the engine like the web build.
import { contextBridge, ipcRenderer } from 'electron';

const bridge = {
	runtime: 'desktop' as const,
	pickMedia: (): Promise<string[]> => ipcRenderer.invoke('jasper:pick-media'),
	revealInFolder: (path: string): void => ipcRenderer.send('jasper:reveal', path),
	windowControls: {
		minimize: (): void => ipcRenderer.send('jasper:window', 'minimize'),
		toggleMaximize: (): void => ipcRenderer.send('jasper:window', 'toggleMaximize'),
		close: (): void => ipcRenderer.send('jasper:window', 'close'),
	},
	onMenuCommand: (cb: (commandId: string) => void): (() => void) => {
		const listener = (_e: unknown, id: string) => cb(id);
		ipcRenderer.on('jasper:menu-command', listener);
		return () => ipcRenderer.removeListener('jasper:menu-command', listener);
	},
};

contextBridge.exposeInMainWorld('jasperDesktop', bridge);

export type JasperDesktopBridge = typeof bridge;
