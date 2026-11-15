// A render page's frame-extraction channel (docs/wp-notes/wp-m2-layer-bake.md "Failed bakes"). The Remotion renderer
// gives every page `window.remotion_broadcastChannel = new BroadcastChannel('remotion-video-frame-extraction')`; in a
// render's main tab, @remotion/media 4.0.499 (`addBroadcastChannelListener`) answers the `request`s of the render's
// other pages and throws "Invalid message" on any other message. A BroadcastChannel reaches every page of the browser
// on the same origin: the engine serves one bundle to every render (`RemotionService.renderServeUrl`) and layer bakes
// share browsers, so a bake's main tab heard another render's main tab answer (`response-success`) and its render
// failed (`RENDER_FAILED: Invalid message: {"type":"response-success",…}`). This module, imported before anything
// loads @remotion/media, hands a main tab a channel that only delivers the messages addressed to a main tab.

type Listener = (event: MessageEvent) => unknown;
type FrameChannel = {
	postMessage(message: unknown): void;
	addEventListener(type: string, listener: Listener): void;
	removeEventListener(type: string, listener: Listener): void;
	close?(): void;
};

/** What a main tab's listener handles (`request` it answers, `main-tab-ready` it ignores). */
const MAIN_TAB_MESSAGES = new Set(['request', 'main-tab-ready']);

/** `inner` as a main tab sees it: its `message` listeners never get other main tabs' answers. */
export function mainTabChannel(inner: FrameChannel): FrameChannel {
	const filtered = new Map<Listener, Listener>();
	return {
		postMessage: (message) => inner.postMessage(message),
		addEventListener(type, listener) {
			if (type !== 'message') return inner.addEventListener(type, listener);
			if (filtered.has(listener)) return;
			const only: Listener = (event) =>
				MAIN_TAB_MESSAGES.has((event.data as { type?: string } | null)?.type ?? '')
					? listener(event)
					: undefined;
			filtered.set(listener, only);
			inner.addEventListener(type, only);
		},
		removeEventListener(type, listener) {
			const only = type === 'message' ? filtered.get(listener) : undefined;
			if (only) filtered.delete(listener);
			inner.removeEventListener(type, only ?? listener);
		},
		close: () => inner.close?.(),
	};
}

const page = (typeof window !== 'undefined' ? window : globalThis) as {
	remotion_isMainTab?: boolean;
	remotion_broadcastChannel?: FrameChannel;
};
if (page.remotion_isMainTab && page.remotion_broadcastChannel)
	page.remotion_broadcastChannel = mainTabChannel(page.remotion_broadcastChannel);
