import type { DesktopBridge } from '@jasper/api';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
	exposeInMainWorld: vi.fn<(name: string, bridge: DesktopBridge) => void>(),
	invoke: vi.fn<(channel: string) => Promise<string | null>>(),
}));

vi.mock('electron', () => ({
	contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
	ipcRenderer: { invoke: electron.invoke },
	webUtils: {},
}));

beforeAll(async () => {
	await import('../src/preload.cts');
});
beforeEach(() => electron.invoke.mockReset());

function exposedBridge(): DesktopBridge {
	const exposed = electron.exposeInMainWorld.mock.calls[0];
	expect(exposed?.[0]).toBe('jasperDesktop');
	if (!exposed) throw new Error('Desktop bridge was not exposed');
	return exposed[1];
}

describe('desktop folder picker preload', () => {
	it('invokes the folder channel without renderer-controlled dialog options', async () => {
		electron.invoke.mockResolvedValueOnce('/media/cache');
		await expect(exposedBridge().pickFolder()).resolves.toBe('/media/cache');
		expect(electron.invoke).toHaveBeenCalledExactlyOnceWith('jasper:pick-folder');
	});

	it('preserves cancellation as null', async () => {
		electron.invoke.mockResolvedValueOnce(null);
		await expect(exposedBridge().pickFolder()).resolves.toBeNull();
	});

	it('preserves failures for the renderer error boundary', async () => {
		electron.invoke.mockRejectedValueOnce(new Error('native dialog unavailable'));
		await expect(exposedBridge().pickFolder()).rejects.toThrow('native dialog unavailable');
	});
});
