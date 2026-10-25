// @jasper/mg-templates — template catalog, param schemas and TS SVG twins (ARCHITECTURE §10.2).
import { MG_CATALOG } from './catalog.ts';
import { createMgRegistry } from './registry.ts';

export * from './catalog.ts';
export * from './core.ts';
export * from './motion.ts';
export { type MediaParamKind, type MediaParamValue, mediaParam } from './params.ts';
export * from './registry.ts';
export * from './social/index.ts';
export * from './spec.ts';
export * from './templates/anime/index.ts';
export * from './templates/lower-third.ts';
export * from './templates/title-card.ts';
export * from './text-units.ts';
export * from './types.ts';

/** Registry over the shipped catalog; inject it as `registries.mgTemplates`. */
export const mgRegistry = createMgRegistry(MG_CATALOG);
