// `@jasper/mg-templates` with the test-only asset probe template added to the registry (test bundle alias).

import { MG_CATALOG } from '../../../mg-templates/src/catalog.ts';
import { createMgRegistry } from '../../../mg-templates/src/registry.ts';
import { PROBE_DEF } from './probe-def.ts';

export * from '../../../mg-templates/src/index.ts';
export const mgRegistry = createMgRegistry([...MG_CATALOG, PROBE_DEF]);
