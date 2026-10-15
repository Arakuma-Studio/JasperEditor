import type { DesktopBridge } from '@jasper/api';
import { describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
	exposeInMainWorld: vi.fn<(name: string, bridge: DesktopBridge) => void>(),
	invoke: vi.fn<(channel: string) => Promise<string | null>>(),
}));

vi.mock('electron', () => ({
	contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
	ipcRenderer: { invoke: electron.invoke },
	webUtils: {},
}));

describe('desktop folder picker preload', () => {
	it('invokes the folder channel without renderer-controlled dialog options', async () => {
		await import('../src/preload.cts');
		const [name, bridge] = electron.exposeInMainWorld.mock.calls[0]!;
		expect(name).toBe('jasperDesktop');
		await (bridge.pickFolder as (...args: unknown[]) => Promise<string | null>)({
			properties: ['openFile', 'multiSelections'],
		});
		expect(electron.invoke).toHaveBeenCalledExactlyOnceWith('jasper:pick-folder');
	});
});
