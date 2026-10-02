// Preview runtime of composition clips (M2, S08:MGC-020…025). The composition stays a pure function of its
// props; what it cannot know from the snapshot — which VP9-alpha previews are cached for the clips' current
// props, how many live frame hosts may run — comes from a runtime the host app installs (the web app's
// apps/web/src/mg-bundles/runtime.ts) through `setCompositionPreviewRuntime`.
// Engine renders never use it (they get `prerender.masterUrl` in the snapshot).
import type { RenderCompositionSource, RenderVisualClip } from '@jasper/project';
import { useSyncExternalStore } from 'react';

/** A cached preview of a clip: VP9 alpha WebM covering composition frames `startFrame…` at the sequence rate. */
export type CompositionPreview = { url: string; startFrame: number; durationFrames: number };

/** What the Composition clip layer asks the host app. */
export type CompositionPreviewRuntime = {
	/** Cached preview for the clip's current props (null → live frame host). */
	previewFor(clip: RenderVisualClip, source: RenderCompositionSource, fps: number): CompositionPreview | null;
	/** Re-render notifications (a preview landed, host budget changed). */
	subscribe(cb: () => void): () => void;
	/** Monotonic version (changes on every notification): the layer's external-store snapshot. */
	version(): number;
	/** Serve URL of a bundle (default `/mg/bundles/<key>/`). */
	bundleUrl?(mediaKey: string): string;
	/** Live host budget (MGC-024: at most 4 at once); returns a release function or null (budget exhausted). */
	acquireHost?(clipId: string): (() => void) | null;
	/**
	 * wp-m3-mgtext (additive): whether a mounted clip may show its live host now. When present it overrides the
	 * null of `acquireHost` (the runtime re-evaluates on every notification, e.g. to make room for a clip whose
	 * texts are edited on canvas).
	 */
	hostAllowed?(clipId: string): boolean;
	/** Live host status reports (Properties "live / preview ready / rendering"). */
	reportHost?(
		clipId: string,
		status: { state: 'loading' | 'rendering' | 'ready' | 'error'; message?: string },
	): void;
};

let installed: CompositionPreviewRuntime | null = null;
const listeners = new Set<() => void>();

/** Installs the process-wide runtime (the web app does this once at start-up). */
export function setCompositionPreviewRuntime(r: CompositionPreviewRuntime | null): void {
	installed = r;
	for (const l of listeners) l();
}

const subscribeRuntime = (cb: () => void) => {
	listeners.add(cb);
	return () => listeners.delete(cb);
};

/** The runtime in effect and a version that changes whenever it notifies. */
export function useCompositionPreviewRuntime(): CompositionPreviewRuntime | null {
	const rt = installed;
	useSyncExternalStore(
		rt ? rt.subscribe : subscribeRuntime,
		() => (rt ? rt.version() : 0),
		() => 0,
	);
	return rt;
}
