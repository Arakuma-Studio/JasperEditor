// HTML-in-Canvas cannot capture updates from desynchronized 2D canvases in headless Chrome or Electron.
// Disable this latency hint for Remotion video canvases; the Player owns their paint timing.
// This function is self-contained so browser tests can evaluate its source.
export function installCaptureSafeCanvases(): void {
	if (typeof HTMLCanvasElement === 'undefined') return;
	const proto = HTMLCanvasElement.prototype as HTMLCanvasElement & { __jasperCaptureSafe?: true };
	if (proto.__jasperCaptureSafe) return;
	const original = proto.getContext;
	const patched = function (
		this: HTMLCanvasElement,
		type: string,
		options?: CanvasRenderingContext2DSettings | WebGLContextAttributes | ImageBitmapRenderingContextSettings,
	) {
		if (
			type === '2d' &&
			options &&
			typeof options === 'object' &&
			'desynchronized' in options &&
			options.desynchronized
		)
			return original.call(this, type, { ...options, desynchronized: false });
		return original.call(this, type, options);
	};
	Object.defineProperty(proto, 'getContext', { value: patched, writable: true, configurable: true });
	Object.defineProperty(proto, '__jasperCaptureSafe', { value: true, configurable: true });
}
