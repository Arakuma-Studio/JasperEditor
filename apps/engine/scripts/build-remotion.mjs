// Pre-bundles @jasper/compositions for packaged engines (S04:RR-001, R-OMS §8.6): writes the Remotion serve
// folder to dist/remotion-bundle and copies the bundled font files to dist/fonts, so a packaged engine never
// runs webpack and never needs node_modules for fonts. Dev engines bundle on demand into <appdir>/remotion.
import { createHash } from 'node:crypto';
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const out = join(root, 'dist', 'remotion-bundle');
const tmp = `${out}.partial`;

/** sha256 (16 hex) over the bundle's files (relative path + bytes, sorted): the bundle id of S11:LBK-020. */
function bundleContentHash(dir) {
	const files = [];
	const stack = [dir];
	while (stack.length) {
		const d = stack.pop();
		for (const n of readdirSync(d)) {
			const p = join(d, n);
			if (statSync(p).isDirectory()) stack.push(p);
			else if (n !== 'jasper-bundle.json') files.push(p);
		}
	}
	const h = createHash('sha256');
	for (const f of files.sort()) {
		h.update(relative(dir, f));
		h.update(readFileSync(f));
	}
	return h.digest('hex').slice(0, 16);
}

/** anime.js version bundled with the compositions (compositions → @jasper/motion → animejs). */
function animejsVersion() {
	const fromPkg = (dirOfPkg, name) => {
		let dir = dirname(createRequire(join(dirOfPkg, 'package.json')).resolve(name));
		for (;;) {
			const pkg = join(dir, 'package.json');
			if (existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).name === name) return dir;
			const up = dirname(dir);
			if (up === dir) throw new Error(`${name} not found`);
			dir = up;
		}
	};
	const compositions = fromPkg(root, '@jasper/compositions');
	const motion = fromPkg(compositions, '@jasper/motion');
	return JSON.parse(readFileSync(join(fromPkg(motion, 'animejs'), 'package.json'), 'utf8')).version;
}

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
// M2 (S11:LBK-020, ANM-011): stamp the bundle with its content hash and the anime.js version inside it. Layer
// bakes key their cached masters by these (the packaged engine has no sources to hash).
const stamp = {
	bundleId: bundleContentHash(tmp),
	animejs: animejsVersion(),
	remotion: JSON.parse(readFileSync(require.resolve('remotion/package.json'), 'utf8')).version,
};
writeFileSync(join(tmp, 'jasper-bundle.json'), `${JSON.stringify(stamp, null, 2)}\n`);
rmSync(out, { recursive: true, force: true });
renameSync(tmp, out);
console.log(
	`[build:remotion] ${out} (${((Date.now() - started) / 1000).toFixed(1)} s, bundle ${stamp.bundleId}, animejs ${stamp.animejs})`,
);

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
	'tiktok-sans',
];
const fontsOut = join(root, 'dist', 'fonts');
for (const id of FONT_IDS) {
	const pkgDir = dirname(require.resolve(`@fontsource/${id}/metadata.json`));
	const dest = join(fontsOut, id);
	mkdirSync(join(dest, 'files'), { recursive: true });
	cpSync(join(pkgDir, 'metadata.json'), join(dest, 'metadata.json'));
	// unicode ranges of the subset files (template faces load latin + latin-ext together)
	if (existsSync(join(pkgDir, 'unicode.json')))
		cpSync(join(pkgDir, 'unicode.json'), join(dest, 'unicode.json'));
	if (existsSync(join(pkgDir, 'LICENSE'))) cpSync(join(pkgDir, 'LICENSE'), join(dest, 'LICENSE'));
	cpSync(join(pkgDir, 'files'), join(dest, 'files'), {
		recursive: true,
		filter: (src) => !src.endsWith('.woff') && (/-(latin|latin-ext)-/.test(src) || !src.includes('.woff')),
	});
}
// text-animators: variable families (`<id>-variable`, the "standard" axes files).
for (const id of ['inter']) {
	const pkgDir = dirname(require.resolve(`@fontsource-variable/${id}/metadata.json`));
	const dest = join(fontsOut, `${id}-variable`);
	mkdirSync(join(dest, 'files'), { recursive: true });
	cpSync(join(pkgDir, 'metadata.json'), join(dest, 'metadata.json'));
	if (existsSync(join(pkgDir, 'LICENSE'))) cpSync(join(pkgDir, 'LICENSE'), join(dest, 'LICENSE'));
	cpSync(join(pkgDir, 'files'), join(dest, 'files'), {
		recursive: true,
		filter: (src) =>
			!src.endsWith('.woff') && (/-(latin|latin-ext)-standard-/.test(src) || !src.includes('.woff')),
	});
}
console.log(`[build:remotion] fonts copied to ${fontsOut}`);
