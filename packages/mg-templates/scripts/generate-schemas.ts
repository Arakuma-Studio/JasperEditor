// Writes the params JSON Schemas of every TS template to packages/mg-templates/schemas/ (checked in;
// a test fails when they drift). Run: pnpm --filter @jasper/mg-templates schemas
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type MgCatalogEntryJson, mgRegistry } from '../src/index.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

// fframes templates only: these files mirror `jasper-mg schema` (anime templates have no Rust twin).
const catalog = mgRegistry.catalogJson().filter((t) => t.renderer !== 'anime');
const files: Record<string, { templates: MgCatalogEntryJson[] } | MgCatalogEntryJson['paramsSchema']> = {
	'catalog.json': { templates: catalog },
};
for (const entry of catalog) files[`${entry.id}@${entry.version}.json`] = entry.paramsSchema;
for (const [name, json] of Object.entries(files)) {
	writeFileSync(join(dir, name), `${JSON.stringify(json, null, 2)}\n`);
	console.log(`wrote schemas/${name}`);
}
