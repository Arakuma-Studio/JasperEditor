// previews workstream (playback robustness): HTML-in-Canvas never captures what a `desynchronized` 2D canvas draws
// after the first capture. Measured with `chrome --enable-features=CanvasDrawElement` (Chrome 150 headless) and in the
// desktop app's Electron 44 (Chrome 152) under xvfb: a low-latency canvas drawn after the host's first paint stays
// transparent in every later `drawElementImage`, even after `requestPaint()`; an ordinary 2D canvas updates (headful
// Chrome 150 under xvfb captured both). @remotion/media's preview `<Video>` draws its frames into exactly such a
// canvas, so every Program-monitor scope that captures a video below it — a 3D run, a GL blend mode, a canvas-mode
// adjustment layer, the colour display stage — showed it black. Exports were right (renders draw video as images).
//
// The fix: 2D contexts are created without `desynchronized` (a latency hint the compositions never need: the Player
// paints on its own clock). Installed once per page by the compositions; idempotent; a no-op outside browsers.
// Self-contained (no module state), so tests can run its source in a page.
export function installCaptureSafeCanvases(): void {
	if (typeof HTMLCanvasElement === 'undefined') return;
	const proto = HTMLCanvasElement.prototype as HTMLCanvasElement & { __jasperCaptureSafe?: true };
	if (proto.__jasperCaptureSafe) return;
	const original = proto.getContext;
	const patched = function (this: HTMLCanvasElement, type: string, options?: unknown) {
		const o = options as { desynchronized?: boolean } | undefined;
		if (type === '2d' && o && typeof o === 'object' && o.desynchronized)
			return original.call(this, type, { ...o, desynchronized: false } as never);
		return original.call(this, type as never, options as never);
	};
	Object.defineProperty(proto, 'getContext', { value: patched, writable: true, configurable: true });
	Object.defineProperty(proto, '__jasperCaptureSafe', { value: true, configurable: true });
}
