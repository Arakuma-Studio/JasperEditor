// wp fonts: catalog font resolution shared by the engine's exports and the web Player.
import { describe, expect, it } from 'vitest';
import { catalogFaceFiles, type FontCatalog, resolveCatalogFont } from '../src/index.ts';

const catalog: FontCatalog = {
	fonts: [
		{
			family: 'Inter',
			source: 'bundled',
			weights: [400, 700],
			styles: ['normal', 'italic'],
			files: [
				{ weight: 400, style: 'normal', subset: 'latin-ext', url: '/fonts/inter/ext-400.woff2' },
				{ weight: 400, style: 'normal', subset: 'latin', url: '/fonts/inter/400.woff2' },
				{ weight: 700, style: 'normal', subset: 'latin', url: '/fonts/inter/700.woff2' },
				{ weight: 400, style: 'italic', subset: 'latin', url: '/fonts/inter/400i.woff2' },
			],
		},
		{
			family: 'Inter',
			source: 'custom',
			weights: [400],
			styles: ['normal'],
			files: [
				{
					weight: 400,
					style: 'normal',
					url: '/fonts/library/fa.ttf',
					postscriptName: 'Inter-Regular',
					fontId: 'fa',
				},
			],
		},
		{
			family: 'Circular Std',
			source: 'custom',
			weights: [500, 700],
			styles: ['normal'],
			files: [
				{
					weight: 500,
					style: 'normal',
					url: '/fonts/library/fb.otf',
					postscriptName: 'CircularStd-Medium',
					fullName: 'Circular Std Medium',
					legacyFamily: 'Circular Std Medium',
					fontId: 'fb',
				},
				{
					weight: 700,
					style: 'normal',
					url: '/fonts/library/fc.otf',
					postscriptName: 'CircularStd-Bold',
					fontId: 'fc',
				},
			],
		},
		{
			family: 'Pixel 12x10',
			source: 'custom',
			weights: [400],
			styles: ['normal'],
			files: [
				{
					weight: 400,
					style: 'normal',
					url: '/fonts/library/fd.ttf',
					postscriptName: 'Pixel12x10',
					fontId: 'fd',
				},
			],
		},
	],
};

const url = (name: string, weight = 400, italic = false) =>
	resolveCatalogFont(catalog, name, weight, italic)?.file.url ?? null;

describe('resolveCatalogFont', () => {
	it('matches families exactly (case-insensitive), bundled first, latin subset, nearest weight, italic when present', () => {
		expect(url('inter')).toBe('/fonts/inter/400.woff2');
		expect(url('Inter', 650)).toBe('/fonts/inter/700.woff2');
		expect(url('Inter', 400, true)).toBe('/fonts/inter/400i.woff2');
		expect(url('Circular Std', 800, true)).toBe('/fonts/library/fc.otf');
		expect(url('Circular Std', 300)).toBe('/fonts/library/fb.otf');
	});

	it('matches families loosely, then a face by PostScript, full or legacy family name (that face, any weight)', () => {
		expect(url('CircularStd')).toBe('/fonts/library/fb.otf');
		expect(url(' CIRCULAR_STD ')).toBe('/fonts/library/fb.otf');
		expect(url('Pixel12x10')).toBe('/fonts/library/fd.ttf');
		expect(url('CircularStd-Bold', 400)).toBe('/fonts/library/fc.otf');
		expect(url('circular std medium', 900)).toBe('/fonts/library/fb.otf');
		expect(resolveCatalogFont(catalog, 'CircularStd-Bold', 400, false)?.via).toBe('face');
	});

	it('returns null for unknown or empty names and without a catalog', () => {
		expect(url('Minion Pro')).toBeNull();
		expect(url('  ')).toBeNull();
		expect(resolveCatalogFont(null, 'Inter', 400, false)).toBeNull();
	});
});

// Merge of the user font library (wp fonts) with the social-comment remote platform fonts (§7.8): text never resolves
// a template-only remote family, and template faces never come from the user library.
describe('remote platform fonts and the user library', () => {
	const mixed: FontCatalog = {
		fonts: [
			{
				family: 'TikTok Sans',
				source: 'bundled',
				weights: [400],
				styles: ['normal'],
				files: [{ weight: 400, style: 'normal', subset: 'latin', url: '/fonts/tiktok-sans/400.woff2' }],
			},
			{
				family: 'Chirp',
				source: 'custom',
				weights: [700],
				styles: ['normal'],
				files: [{ weight: 700, style: 'normal', url: '/fonts/library/fc.otf', fontId: 'fc' }],
			},
			{
				family: 'Chirp',
				source: 'remote',
				weights: [700],
				styles: ['normal'],
				files: [{ weight: 700, style: 'normal', url: '/fonts/remote/chirp-700-abc.woff2' }],
			},
			{
				family: 'Segoe UI',
				source: 'remote',
				weights: [400],
				styles: ['normal'],
				files: [{ weight: 400, style: 'normal', url: '/fonts/remote/segoe-400-def.woff2' }],
			},
		],
	};

	it('text never resolves a remote family (exact, loose or by face name)', () => {
		expect(resolveCatalogFont(mixed, 'Segoe UI', 400, false)).toBeNull();
		expect(resolveCatalogFont(mixed, 'segoe-ui', 400, false)).toBeNull();
		// a library family of the same name is the text font
		expect(resolveCatalogFont(mixed, 'Chirp', 700, false)?.file.url).toBe('/fonts/library/fc.otf');
		expect(resolveCatalogFont(mixed, 'TikTok Sans', 400, false)?.file.url).toBe(
			'/fonts/tiktok-sans/400.woff2',
		);
	});

	it('template faces come from bundled or remote families, never the library', () => {
		expect(catalogFaceFiles(mixed, { family: 'Chirp', weight: 700, style: 'normal' })).toEqual([
			{ url: '/fonts/remote/chirp-700-abc.woff2' },
		]);
		expect(catalogFaceFiles(mixed, { family: 'TikTok Sans', weight: 400, style: 'normal' })).toEqual([
			{ url: '/fonts/tiktok-sans/400.woff2' },
		]);
		const libraryOnly: FontCatalog = { fonts: [mixed.fonts[1]!] };
		expect(catalogFaceFiles(libraryOnly, { family: 'Chirp', weight: 700, style: 'normal' })).toBeNull();
	});
});
