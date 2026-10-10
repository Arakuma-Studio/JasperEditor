// anime.js lives in the compositions bundle. The engine reports its capabilities and licence without importing
// @jasper/motion; packaged builds read the committed licence copy next to the bundled engine.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LicenseComponent, M2Features } from '@jasper/api';
import { mgRegistry } from '@jasper/mg-templates';
import { LATEST_TEXT_ANIMATION_SPECS } from '@jasper/project';

const here = dirname(fileURLToPath(import.meta.url));

/** The pin of `packages/motion/package.json` (tested); used when the package cannot be resolved (packaged). */
const ANIMEJS_PINNED_VERSION = '4.5.0';

/** Directory of the package that `fromPackageJson`'s package resolves `name` to, or null. */
function packageRoot(fromPackageJson: string, name: string): string | null {
	try {
		const req = createRequire(fromPackageJson);
		let dir = dirname(req.resolve(name));
		for (;;) {
			const pkg = join(dir, 'package.json');
			if (existsSync(pkg) && (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === name)
				return dir;
			const up = dirname(dir);
			if (up === dir) return null;
			dir = up;
		}
	} catch {
		return null;
	}
}

/** The installed anime.js (dev/workspace): compositions → @jasper/motion → animejs. Null in packaged builds. */
function animejsPackageDir(): string | null {
	const compositions = packageRoot(join(here, 'x.js'), '@jasper/compositions');
	const motion = compositions && packageRoot(join(compositions, 'package.json'), '@jasper/motion');
	return motion ? packageRoot(join(motion, 'package.json'), 'animejs') : null;
}

function readFirst(paths: string[]): string | null {
	for (const p of paths) if (existsSync(p)) return readFileSync(p, 'utf8');
	return null;
}

export function animejsVersion(dir = animejsPackageDir()): string {
	const text = dir ? readFirst([join(dir, 'package.json')]) : null;
	return text
		? ((JSON.parse(text) as { version?: string }).version ?? ANIMEJS_PINNED_VERSION)
		: ANIMEJS_PINNED_VERSION;
}

/**
 * About ▸ Licenses entry. `dir` is the anime.js package directory (dev/workspace runs);
 * packaged engines cannot resolve it (anime.js lives in the Remotion bundle) and read the committed copy.
 */
export function animeLicense(dir: string | null = animejsPackageDir()): LicenseComponent {
	const text =
		(dir && readFirst([join(dir, 'LICENSE.md'), join(dir, 'LICENSE')])) ??
		// Committed copy (src/anime/third-party), copied next to the bundled engine by scripts/build.mjs.
		readFirst([join(here, 'third-party', 'LICENSE-animejs.txt'), join(here, 'LICENSE-animejs.txt')]);
	return {
		id: 'animejs',
		name: 'anime.js',
		version: animejsVersion(dir),
		license: 'MIT',
		bundled: true,
		sourceUrl: 'https://github.com/juliangarnier/anime',
		notice: 'Drives animated titles and anime motion templates inside the rendered video.',
		texts: text ? [{ title: 'MIT License', text }] : [],
	};
}

/** `features.anime` (S11:LBK-030). */
export function animeCapability(): NonNullable<M2Features['anime']> {
	return {
		animejs: animejsVersion(),
		textPresets: LATEST_TEXT_ANIMATION_SPECS.length,
		templates: mgRegistry.list().filter((t) => t.renderer === 'anime').length,
	};
}
