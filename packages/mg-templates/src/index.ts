// @jasper/mg-templates — template catalog, param schemas and TS SVG twins (ARCHITECTURE §10.2).
import { MG_CATALOG } from './catalog.ts';
import { createMgRegistry } from './registry.ts';

export * from './catalog.ts';
export * from './registry.ts';
export * from './types.ts';

/** Registry over the shipped catalog; inject it as `registries.mgTemplates`. */
export const mgRegistry = createMgRegistry(MG_CATALOG);
