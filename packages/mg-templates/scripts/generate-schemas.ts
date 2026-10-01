// Writes the params JSON Schemas of every TS template to packages/mg-templates/schemas/ (checked in;
// a test fails when they drift). Run: pnpm --filter @jasper/mg-templates schemas
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mgRegistry } from '../src/index.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

export function schemaFiles(): Record<string, unknown> {
	const files: Record<string, unknown> = {};
	// fframes templates only: these files mirror `jasper-mg schema` (anime templates have no Rust twin).
	const catalog = mgRegistry.catalogJson().filter((t) => t.renderer !== 'anime');
	for (const entry of catalog) files[`${entry.id}@${entry.version}.json`] = entry.paramsSchema;
	files['catalog.json'] = { templates: catalog };
	return files;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	for (const [name, json] of Object.entries(schemaFiles())) {
		writeFileSync(join(dir, name), `${JSON.stringify(json, null, 2)}\n`);
		console.log(`wrote schemas/${name}`);
	}
}
