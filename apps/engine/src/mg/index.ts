// Motion graphics in the engine (WP-2G, ARCHITECTURE §10.2): binary resolution + probe, render
// pipeline, cache and jobs, and the hooks other engine modules consume.
import type { MgCapability, MgService } from './service.ts';

export * from './binary.ts';
export * from './render.ts';
export * from './service.ts';

/** Service key under `app.jasper.services` (routes/mg.ts registers it at startup). */
export const MG_SERVICE_KEY = 'mg';

/**
 * Capability provider for `GET /api/capabilities` (WP-2F's `registerCapabilityProvider`): returns the
 * `render.fframes` / `render.fframesReason` part.
 */
export function mgCapabilityProvider(service: MgService): () => { render: MgCapability } {
	return () => ({ render: service.capability() });
}
