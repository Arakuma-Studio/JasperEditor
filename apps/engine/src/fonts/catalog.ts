// Curated bundled font catalog (S04:FT-001…003 subset, ARCHITECTURE §9.2): ten OFL/Apache families from
// @fontsource packages, served at `/fonts/<id>/<file>.woff2` so the Player, headless Remotion renders and
// stills load the same files. wp fonts: plus the user font library (`library.ts`), served at
// `/fonts/library/<fontId>.<ext>`, listed after the bundled families (source `custom`). Names resolve with
// `resolveCatalogFont` (@jasper/api, shared with the web Player): family, then a face's PostScript / full / legacy
// family name. Unknown families fall back to the default family (FONT_FALLBACK).
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type FontCatalog, type FontFamily, resolveCatalogFont } from '@jasper/api';
import type { FontLibrary } from './library.ts';

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

/**
 * text-animators: variable families from @fontsource-variable packages (catalog id `<id>-variable`): one file per
 * subset and style ("standard" axes) serves every weight, and the axes are listed for Variable Font Axes.
 */
const VARIABLE_IDS = ['inter'] as const;

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
	variable?: Record<string, { min: string; max: string; default: string }>;
};

type ResolvedFamily = FontFamily & { id: string; dir: string };

function packageDir(
	id: string,
	env: Record<string, string | undefined>,
	scope = '@fontsource',
): string | null {
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
		return dirname(req.resolve(`${scope}/${id.replace(/-variable$/, '')}/metadata.json`));
	} catch {
		return null;
	}
}

/** Weights a variable library face is listed under (its `wght` range, in steps of 100). */
function variableWeights(min: number, max: number): number[] {
	const out: number[] = [];
	for (let w = 100; w <= 900; w += 100) if (w >= min && w <= max) out.push(w);
	return out.length ? out : [Math.round(Math.min(Math.max(400, min), max))];
}

export class FontCatalogService {
	private readonly families: ResolvedFamily[] = [];
	private libraryCache: { revision: number; families: ResolvedFamily[] } | null = null;

	constructor(
		env: Record<string, string | undefined> = process.env,
		private readonly library: FontLibrary | null = null,
	) {
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
		this.addVariableFamilies(env);
	}

	/** text-animators: the variable families (`Inter Variable`, …). */
	private addVariableFamilies(env: Record<string, string | undefined>): void {
		for (const base of VARIABLE_IDS) {
			const id = `${base}-variable`;
			const dir = packageDir(id, env, '@fontsource-variable');
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
				for (const style of meta.styles) {
					const file = `${base}-${subset}-standard-${style}.woff2`;
					if (!existsSync(join(dir, 'files', file))) continue;
					for (const weight of meta.weights)
						files.push({ weight, style, subset, url: `/fonts/${id}/${file}` });
				}
			}
			if (!files.length) continue;
			const axes: NonNullable<FontFamily['axes']> = {};
			for (const [tag, a] of Object.entries(meta.variable ?? {}))
				if (tag !== 'ital')
					axes[tag] = { min: Number(a.min), max: Number(a.max), default: Number(a.default) };
			this.families.push({
				id,
				dir,
				family: `${meta.family} Variable`,
				...(meta.category ? { category: meta.category } : {}),
				source: 'bundled',
				weights: [...meta.weights],
				styles: [...meta.styles],
				files,
				axes,
			});
		}
	}

	get available(): boolean {
		return this.families.length > 0 || (this.library?.faces.length ?? 0) > 0;
	}

	/** True when the user font library is attached (uploads are possible). */
	get libraryAvailable(): boolean {
		return this.library !== null && !this.library.readOnly;
	}

	/** The user library's faces grouped into families (cached per library revision). */
	private libraryFamilies(): ResolvedFamily[] {
		const lib = this.library;
		if (!lib) return [];
		if (this.libraryCache?.revision === lib.revision) return this.libraryCache.families;
		const byName = new Map<string, ResolvedFamily>();
		for (const face of lib.faces) {
			const key = face.family.toLowerCase();
			let fam = byName.get(key);
			if (!fam) {
				fam = {
					id: 'library',
					dir: lib.filesDir,
					family: face.family,
					source: 'custom',
					weights: [],
					styles: [],
					files: [],
				};
				byName.set(key, fam);
			}
			const style = face.italic ? 'italic' : 'normal';
			const wght = face.axes?.wght;
			const weights = wght ? variableWeights(wght.min, wght.max) : [face.weight];
			for (const weight of weights)
				fam.files.push({
					weight,
					style,
					url: `/fonts/library/${face.id}.${face.format}`,
					postscriptName: face.postscriptName,
					fullName: face.fullName,
					...(face.legacyFamily ? { legacyFamily: face.legacyFamily } : {}),
					fontId: face.id,
				});
			if (face.axes && !fam.axes) {
				const { ital: _ital, ...axes } = face.axes;
				if (Object.keys(axes).length) fam.axes = axes;
			}
		}
		const families = [...byName.values()].map((f) => ({
			...f,
			weights: [...new Set(f.files.map((x) => x.weight))].sort((a, b) => a - b),
			styles: (['normal', 'italic'] as const).filter((s) => f.files.some((x) => x.style === s)),
		}));
		families.sort((a, b) => a.family.localeCompare(b.family));
		this.libraryCache = { revision: lib.revision, families };
		return families;
	}

	/** Bundled families first (they win a name clash), then the user library. */
	private all(): ResolvedFamily[] {
		return [...this.families, ...this.libraryFamilies()];
	}

	catalog(): FontCatalog {
		return { fonts: this.all().map(({ id: _id, dir: _dir, ...f }) => f) };
	}

	byFamily(family: string): ResolvedFamily | null {
		const f = family.trim().toLowerCase();
		return this.all().find((x) => x.family.toLowerCase() === f || x.id === f) ?? null;
	}

	/**
	 * Engine-relative URL of the best file for a family/weight/style (`resolveCatalogFont`: family, then a library
	 * face's PostScript / full / legacy family name; nearest weight, italic falls back to normal). Unknown names use
	 * the fallback family; `fallback` reports it (FT-003).
	 */
	resolve(
		family: string,
		weight: number,
		italic: boolean,
	): { url: string; family: string; fallback: boolean } | null {
		const found = resolveCatalogFont({ fonts: this.all() }, family, weight, italic);
		if (found) return { url: found.file.url, family: found.family.family, fallback: false };
		const fb =
			resolveCatalogFont({ fonts: this.families }, FALLBACK_FAMILY, weight, italic) ??
			resolveCatalogFont({ fonts: this.families }, this.families[0]?.family ?? '', weight, italic);
		if (!fb) return null;
		return { url: fb.file.url, family: fb.family.family, fallback: true };
	}

	/**
	 * True when text set in `name` renders with library face `fontId` or its family (the family resolves to the face's
	 * library family, or the name is one of the face's own names). For "used by saved projects" checks.
	 */
	usesLibraryFace(name: string, fontId: string): boolean {
		const face = this.library?.get(fontId);
		if (!face) return false;
		const found = resolveCatalogFont({ fonts: this.all() }, name, face.weight, face.italic);
		if (!found) return false;
		if (found.via === 'face') return found.file.fontId === fontId;
		return found.family.source === 'custom' && found.family.files.some((f) => f.fontId === fontId);
	}

	/** Absolute path of `/fonts/<id>/<file>` (or `/fonts/library/<fontId>.<ext>`) or null (validated names). */
	filePath(rest: string): string | null {
		if (rest.startsWith('library/')) return this.library?.filePath(rest.slice('library/'.length)) ?? null;
		const m = /^([a-z0-9-]+)\/([a-z0-9-]+\.(woff2|woff))$/.exec(rest);
		if (!m) return null;
		const fam = this.families.find((f) => f.id === m[1]);
		if (!fam) return null;
		const p = join(fam.dir, 'files', m[2]!);
		return existsSync(p) ? p : null;
	}
}
