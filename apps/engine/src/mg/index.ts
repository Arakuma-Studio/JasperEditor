// Motion graphics in the engine (WP-2G, ARCHITECTURE §10.2): binary resolution + probe, render
// pipeline, cache and jobs, and the hooks other engine modules consume.

import type { MgRational } from '@jasper/mg-templates';
import type { RenderVisualClip } from '@jasper/project';
import type { MgCapability, MgService } from './service.ts';

export * from './binary.ts';
export * from './render.ts';
export * from './service.ts';
export * from './templates.ts';

/** Service key under `app.jasper.services` (routes/mg.ts registers it at startup). */
export const MG_SERVICE_KEY = 'mg';

/**
 * Capability provider for `GET /api/capabilities` (WP-2F's `registerCapabilityProvider`): returns the
 * `render.fframes` / `render.fframesReason` part.
 */
export function mgCapabilityProvider(service: MgService): () => { render: MgCapability } {
	return () => ({ render: service.capability() });
}

/** Request shape of WP-2F's export `MgMasterProvider` (structurally compatible, no import cycle). */
export type MgMasterHookRequest = {
	clip: Pick<RenderVisualClip, 'source' | 'duration' | 'sourceIn'>;
	fps: MgRational;
	projectId?: string;
	parentId?: string;
	signal?: AbortSignal;
};

/**
 * Adapter for WP-2F's `registerMgMasterProvider(fn)`: `(req) => Promise<path | null>`. The master's
 * frame 0 is the clip's first frame (sourceIn applied) and its size is the clip canvas; null means
 * "plan this range with Remotion". Aborting `req.signal` cancels a render this request started.
 */
export function mgMasterHook(service: MgService): (req: MgMasterHookRequest) => Promise<string | null> {
	return (req) =>
		service.mgMasterProvider(req.clip, {
			fps: req.fps,
			projectId: req.projectId,
			parentId: req.parentId,
			signal: req.signal,
		});
}
