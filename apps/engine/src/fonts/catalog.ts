// Curated bundled font catalog (S04:FT-001…003 subset, ARCHITECTURE §9.2): ten OFL/Apache families from
// @fontsource packages, served at `/fonts/<id>/<file>.woff2` so the Player, headless Remotion renders and
// stills load the same files. Unknown families fall back to the default family (FONT_FALLBACK).
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FontCatalog, FontFamily } from '@jasper/api';

const CATALOG_IDS = [
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
] as const;

/** Default family for unknown fonts (the app UI font, ARCHITECTURE §7.4). */
const FALLBACK_FAMILY = 'Source Sans 3';
const SUBSETS = ['latin', 'latin-ext'] as const;

type Metadata = {
	id: string;
	family: string;
	weights: number[];
	styles: ('normal' | 'italic')[];
	category?: string;
	subsets: string[];
};

export type ResolvedFamily = FontFamily & { id: string; dir: string };

function packageDir(id: string, env: Record<string, string | undefined>): string | null {
	const custom = env.JASPER_FONTS_DIR;
	if (custom && existsSync(join(custom, id, 'metadata.json'))) return join(custom, id);
	// Packaged engine bundle: fonts copied next to dist/engine.mjs by the build script.
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		const bundled = join(here, 'fonts', id);
		if (existsSync(join(bundled, 'metadata.json'))) return bundled;
	} catch {
		// not a file URL
	}
	try {
		const req = createRequire(import.meta.url);
		return dirname(req.resolve(`@fontsource/${id}/metadata.json`));
	} catch {
		return null;
	}
}

export class FontCatalogService {
	private readonly families: ResolvedFamily[] = [];

	constructor(env: Record<string, string | undefined> = process.env) {
		for (const id of CATALOG_IDS) {
			const dir = packageDir(id, env);
			if (!dir) continue;
			let meta: Metadata;
			try {
				meta = JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8')) as Metadata;
			} catch {
				continue;
			}
			const files: FontFamily['files'] = [];
			for (const subset of SUBSETS) {
				if (!meta.subsets.includes(subset)) continue;
				for (const weight of meta.weights) {
					for (const style of meta.styles) {
						const file = `${id}-${subset}-${weight}-${style}.woff2`;
						if (!existsSync(join(dir, 'files', file))) continue;
						files.push({ weight, style, subset, url: `/fonts/${id}/${file}` });
					}
				}
			}
			this.families.push({
				id,
				dir,
				family: meta.family,
				...(meta.category ? { category: meta.category } : {}),
				source: 'bundled',
				weights: [...meta.weights],
				styles: [...meta.styles],
				files,
			});
		}
	}

	get available(): boolean {
		return this.families.length > 0;
	}

	catalog(): FontCatalog {
		return { fonts: this.families.map(({ id: _id, dir: _dir, ...f }) => f) };
	}

	byFamily(family: string): ResolvedFamily | null {
		const f = family.trim().toLowerCase();
		return this.families.find((x) => x.family.toLowerCase() === f || x.id === f) ?? null;
	}

	/**
	 * Engine-relative URL of the best file for a family/weight/style (nearest weight, italic falls back
	 * to normal). Unknown families use the fallback family; `fallback` reports it (FT-003).
	 */
	resolve(
		family: string,
		weight: number,
		italic: boolean,
	): { url: string; family: string; fallback: boolean } | null {
		let fam = this.byFamily(family);
		let fallback = false;
		if (!fam) {
			fam = this.byFamily(FALLBACK_FAMILY) ?? this.families[0] ?? null;
			fallback = true;
		}
		if (!fam) return null;
		const latin = fam.files.filter((f) => f.subset === 'latin');
		const style = italic && latin.some((f) => f.style === 'italic') ? 'italic' : 'normal';
		const candidates = latin.filter((f) => f.style === style);
		if (candidates.length === 0) return null;
		const best = candidates.reduce((a, b) =>
			Math.abs(b.weight - weight) < Math.abs(a.weight - weight) ? b : a,
		);
		return { url: best.url, family: fam.family, fallback };
	}

	/** Absolute path of `/fonts/<id>/<file>` or null (validated: catalog id + plain file name). */
	filePath(rest: string): string | null {
		const m = /^([a-z0-9-]+)\/([a-z0-9-]+\.(woff2|woff))$/.exec(rest);
		if (!m) return null;
		const fam = this.families.find((f) => f.id === m[1]);
		if (!fam) return null;
		const p = join(fam.dir, 'files', m[2]!);
		return existsSync(p) ? p : null;
	}
}
