// Curated bundled font catalog (S04:FT-001…003 subset, ARCHITECTURE §9.2): OFL/Apache families from
// @fontsource packages, served at `/fonts/<id>/<file>.woff2` so the Player, headless Remotion renders and
// stills load the same files. Unknown families fall back to the default family (FONT_FALLBACK).
// social-comment §7.8: TikTok Sans (OFL) is bundled for the TikTok templates; the remote platform fonts of the
// remote-asset manifest are listed with `source: 'remote'` (served at `/fonts/remote/…`) for the templates that declare
// them — text clips never resolve them, and a template face never falls back to another family.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FontCatalog, FontFamily } from '@jasper/api';
import type { RemoteAssetService } from '../remote-assets/service.ts';

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
	'tiktok-sans',
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

export class FontCatalogService {
	private readonly families: ResolvedFamily[] = [];

	constructor(
		env: Record<string, string | undefined> = process.env,
		/** social-comment §7.8: remote platform fonts and emoji packs (absent: bundled fonts only). */
		readonly remote: RemoteAssetService | null = null,
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
		return this.families.length > 0;
	}

	catalog(): FontCatalog {
		const bundled = this.families.map(({ id: _id, dir: _dir, ...f }) => f);
		if (!this.remote) return { fonts: bundled };
		return { fonts: [...bundled, ...this.remote.catalogFamilies()], emojiPacks: this.remote.emojiPacks() };
	}

	/** The bundled file of exactly this face (`latin` subset), or null. */
	private bundledFace(face: { family: string; weight: number; style: 'normal' | 'italic' }): string | null {
		const fam = this.byFamily(face.family);
		if (!fam || fam.family.toLowerCase() !== face.family.trim().toLowerCase()) return null;
		const files = fam.files.filter((f) => f.weight === face.weight && f.style === face.style);
		return (files.find((f) => f.subset === 'latin') ?? files[0])?.url ?? null;
	}

	/** Whether exactly this face is bundled (no download needed). */
	isBundledFace(face: { family: string; weight: number; style: 'normal' | 'italic' }): boolean {
		return this.bundledFace(face) !== null;
	}

	/**
	 * social-comment §7.8: engine-relative URL of a template face — the bundled catalogue first, then the remote
	 * manifest — or null. Exact family, weight and style: never a fallback (AGENTS §4). Remote files may still need
	 * downloading (`remote.prefetch`).
	 */
	templateFaceUrl(face: { family: string; weight: number; style: 'normal' | 'italic' }): string | null {
		return this.bundledFace(face) ?? this.remote?.fontUrl(face) ?? null;
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

	/**
	 * Absolute path of `/fonts/<id>/<file>` or null (validated: catalog id + plain file name). `remote/<file>`: the
	 * cached, verified remote font (null when not downloaded yet).
	 */
	filePath(rest: string): string | null {
		if (rest.startsWith('remote/')) return this.remote?.cachedFontPath(rest.slice('remote/'.length)) ?? null;
		const m = /^([a-z0-9-]+)\/([a-z0-9-]+\.(woff2|woff))$/.exec(rest);
		if (!m) return null;
		const fam = this.families.find((f) => f.id === m[1]);
		if (!fam) return null;
		const p = join(fam.dir, 'files', m[2]!);
		return existsSync(p) ? p : null;
	}
}
