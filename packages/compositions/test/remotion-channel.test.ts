// A render's main tab must not fail on another render's frame answers (src/remotion-channel.ts): renders that share a
// browser and the bundle's origin share @remotion/media's frame-extraction BroadcastChannel.
import { expect, it, vi } from 'vitest';

it('a main tab ignores another main tab’s answer instead of failing its render', async () => {
	vi.useFakeTimers(); // (@remotion/media repeats `main-tab-ready` on an interval)
	const listeners: ((event: MessageEvent) => unknown)[] = [];
	const channel = {
		postMessage: () => undefined,
		addEventListener: (_type: string, l: (event: MessageEvent) => unknown) => void listeners.push(l),
		removeEventListener: () => undefined,
	};
	Object.assign(window, { remotion_isMainTab: true, remotion_broadcastChannel: channel });
	await import('../src/remotion-channel.ts');
	await import('@remotion/media');
	expect(listeners.length).toBeGreaterThan(0);
	// what another render's main tab posts after answering one of its pages
	const data = {
		type: 'response-success',
		id: 'other-render',
		frame: {},
		audio: null,
		durationInSeconds: null,
	};
	const handled = listeners.map((l) => l(new MessageEvent('message', { data })));
	await expect(Promise.all(handled)).resolves.toBeDefined();
	vi.useRealTimers();
});
