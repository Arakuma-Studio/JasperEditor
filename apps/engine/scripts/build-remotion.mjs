// Pre-bundles @jasper/compositions for packaged engines (S04:RR-001, R-OMS §8.6): writes the Remotion serve
// folder to dist/remotion-bundle and copies the bundled font files to dist/fonts, so a packaged engine never
// runs webpack and never needs node_modules for fonts. Dev engines bundle on demand into <appdir>/remotion.
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const out = join(root, 'dist', 'remotion-bundle');
const tmp = `${out}.partial`;

const entryPoint = require.resolve('@jasper/compositions/remotion-entry');
rmSync(tmp, { recursive: true, force: true });
const started = Date.now();
await bundle({
	entryPoint,
	outDir: tmp,
	enableCaching: true,
	onProgress: (p) => {
		if (p % 25 === 0) console.log(`[build:remotion] bundling ${p}%`);
	},
});
rmSync(out, { recursive: true, force: true });
renameSync(tmp, out);
console.log(`[build:remotion] ${out} (${((Date.now() - started) / 1000).toFixed(1)} s)`);

// Fonts: the curated catalog (src/fonts/catalog.ts) looks for <dist>/fonts/<id>/{metadata.json,files/*.woff2}.
const FONT_IDS = [
	'inter',
	'source-sans-3',
	'roboto',
	'montserrat',
	'open-sans',
	'lato',
	'poppins',
	'oswald',
	'playfair-display',
	'jetbrains-mono',
];
const fontsOut = join(root, 'dist', 'fonts');
for (const id of FONT_IDS) {
	const pkgDir = dirname(require.resolve(`@fontsource/${id}/metadata.json`));
	const dest = join(fontsOut, id);
	mkdirSync(join(dest, 'files'), { recursive: true });
	cpSync(join(pkgDir, 'metadata.json'), join(dest, 'metadata.json'));
	if (existsSync(join(pkgDir, 'LICENSE'))) cpSync(join(pkgDir, 'LICENSE'), join(dest, 'LICENSE'));
	cpSync(join(pkgDir, 'files'), join(dest, 'files'), {
		recursive: true,
		filter: (src) => !src.endsWith('.woff') && (/-(latin|latin-ext)-/.test(src) || !src.includes('.woff')),
	});
}
console.log(`[build:remotion] fonts copied to ${fontsOut}`);
