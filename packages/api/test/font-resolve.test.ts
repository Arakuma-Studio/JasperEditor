// wp fonts: catalog font resolution shared by the engine's exports and the web Player.
import { describe, expect, it } from 'vitest';
import { type FontCatalog, resolveCatalogFont } from '../src/index.ts';

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
