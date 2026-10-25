import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	glyphColor,
	INSTAGRAM_GLYPHS,
	PLATFORM_DEFAULT_AVATARS,
	PLATFORM_GLYPHS,
	type PlatformGlyph,
	scopeGlyphIds,
	TIKTOK_DEFAULT_AVATAR,
	TIKTOK_GLYPHS,
	X_GLYPHS,
	YOUTUBE_GLYPHS,
} from '../src/templates/social/glyphs.ts';

const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/** Validates SVG path data against the grammar (command letters, argument counts, arc flags); returns the commands. */
function parsePath(d: string): string[] {
	const num = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
	const cmds: string[] = [];
	let i = 0;
	let cmd = '';
	let args = 0;
	const close = () => {
		const n = ARGS[cmd.toUpperCase()] ?? -1;
		if (n === 0 ? args !== 0 : args === 0 || args % n !== 0) throw new Error(`bad argument count for ${cmd}`);
	};
	while (i < d.length) {
		const c = d[i] as string;
		if (/[\s,]/.test(c)) {
			i++;
			continue;
		}
		if (/[a-zA-Z]/.test(c)) {
			if (cmd) close();
			if (!(c.toUpperCase() in ARGS)) throw new Error(`unknown command ${c}`);
			if (cmds.length === 0 && c.toUpperCase() !== 'M') throw new Error('path must start with M');
			cmd = c;
			args = 0;
			cmds.push(c);
			i++;
			continue;
		}
		if (!cmd) throw new Error('number before a command');
		if (cmd.toUpperCase() === 'A' && (args % 7 === 3 || args % 7 === 4)) {
			if (c !== '0' && c !== '1') throw new Error('arc flag must be 0 or 1');
			i++;
			args++;
			continue;
		}
		const m = num.exec(d.slice(i));
		if (!m) throw new Error(`unexpected "${d.slice(i, i + 12)}"`);
		if (!Number.isFinite(Number(m[0]))) throw new Error('non-finite number');
		i += m[0].length;
		args++;
	}
	if (cmd) close();
	return cmds;
}

const COLOR =
	/^(?:#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}|rgba?\(\s*\d{1,3},\s*\d{1,3},\s*\d{1,3}(?:,\s*(?:0|1|0?\.\d+))?\s*\))$/;

const ALL: Array<[string, PlatformGlyph]> = [
	...Object.entries(PLATFORM_GLYPHS).flatMap(([platform, set]) =>
		Object.entries(set as Record<string, PlatformGlyph>).map(
			([name, g]) => [`${platform}.${name}`, g] as [string, PlatformGlyph],
		),
	),
	['tiktok.defaultAvatar', TIKTOK_DEFAULT_AVATAR],
];

describe('platform glyphs', () => {
	it('has the glyphs the social templates draw', () => {
		expect(Object.keys(TIKTOK_GLYPHS).sort()).toEqual(
			['chevronDown', 'creatorLiked', 'dislike', 'heartFilled', 'heartOutline', 'more', 'verified'].sort(),
		);
		expect(Object.keys(INSTAGRAM_GLYPHS).sort()).toEqual(['heartFilled', 'heartOutline', 'more', 'verified']);
		expect(Object.keys(YOUTUBE_GLYPHS).sort()).toEqual(
			[
				'chevronDown',
				'creatorHeart',
				'creatorHeartBorder',
				'more',
				'pin',
				'reply',
				'replyFilled',
				'thumbDown',
				'thumbDownFilled',
				'thumbUp',
				'thumbUpFilled',
				'verified',
			].sort(),
		);
		expect(Object.keys(X_GLYPHS).sort()).toEqual(
			[
				'bookmark',
				'grok',
				'like',
				'likeFilled',
				'more',
				'reply',
				'repost',
				'share',
				'verifiedBlue',
				'verifiedGold',
				'verifiedGrey',
				'views',
			].sort(),
		);
	});

	it.each(ALL)('%s is well-formed', (_name, g) => {
		const vb = g.viewBox.split(' ').map(Number);
		expect(vb).toHaveLength(4);
		expect(vb.every(Number.isFinite)).toBe(true);
		expect(vb[2]).toBeGreaterThan(0);
		expect(vb[3]).toBeGreaterThan(0);
		expect(g.paths.length).toBeGreaterThan(0);
		const gradientIds = new Set((g.gradients ?? []).map((x) => x.id));
		expect(gradientIds.size).toBe((g.gradients ?? []).length);
		for (const p of g.paths) {
			expect(p.d.length).toBeLessThan(8000);
			expect(() => parsePath(p.d)).not.toThrow();
			if (p.fill !== undefined) {
				const ref = /^url\(#([^)]+)\)$/.exec(p.fill);
				if (ref) expect(gradientIds.has(ref[1] as string)).toBe(true);
				else expect(p.fill).toMatch(COLOR);
			}
			if (p.fillOpacity !== undefined) {
				expect(p.fillOpacity).toBeGreaterThanOrEqual(0);
				expect(p.fillOpacity).toBeLessThanOrEqual(1);
			}
		}
		for (const gr of g.gradients ?? []) {
			expect([gr.x1, gr.y1, gr.x2, gr.y2].every(Number.isFinite)).toBe(true);
			expect(gr.stops.length).toBeGreaterThanOrEqual(2);
			for (const s of gr.stops) {
				expect(s.offset).toBeGreaterThanOrEqual(0);
				expect(s.offset).toBeLessThanOrEqual(1);
				expect(s.color).toMatch(COLOR);
			}
		}
		// A glyph either paints every path itself or tells the template its colour per theme.
		if (g.paths.some((p) => p.fill === undefined)) {
			expect(g.defaultColor?.light).toMatch(COLOR);
			expect(g.defaultColor?.dark).toMatch(COLOR);
		}
		expect(['live-dom', 'live-bundle', 'live-cdn', 'derived']).toContain(g.origin);
	});

	it('rejects malformed path data in the validator', () => {
		expect(() => parsePath('M1 2L3')).toThrow();
		expect(() => parsePath('L1 2')).toThrow();
		expect(() => parsePath('M0 0a1 1 0 2 0 1 1')).toThrow();
		expect(parsePath('M0 0a1 1 0 1 0 1 1Z')).toEqual(['M', 'a', 'Z']);
		expect(parsePath('M3 12c0-1.1.9-2 2-2s2 .9 2 2z')).toEqual(['M', 'c', 's', 'z']);
	});

	it('gives the theme colour, or the fallback for self-painted glyphs', () => {
		expect(glyphColor(X_GLYPHS.likeFilled, 'light')).toBe('#F91880');
		expect(glyphColor(YOUTUBE_GLYPHS.thumbUp, 'dark')).toBe('#F1F1F1');
		expect(glyphColor(X_GLYPHS.verifiedBlue, 'dark')).toBe('currentColor');
		expect(glyphColor(X_GLYPHS.verifiedBlue, 'dark', '#123456')).toBe('#123456');
	});

	it('lists every default avatar with a usable source', () => {
		expect(PLATFORM_DEFAULT_AVATARS.tiktok).toEqual({ kind: 'glyph', glyph: TIKTOK_DEFAULT_AVATAR });
		for (const p of ['x', 'youtube'] as const) {
			const a = PLATFORM_DEFAULT_AVATARS[p];
			expect(a.kind).toBe('remote');
			if (a.kind !== 'remote') continue;
			expect(new URL(a.image.url).protocol).toBe('https:');
			expect(a.image.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(a.image.width).toBeGreaterThan(0);
		}
		expect(PLATFORM_DEFAULT_AVATARS.instagram.kind).toBe('none');
	});
});

describe('provenance record (licenses/platform-assets.md, AGENTS.md §3 item 5)', () => {
	const record = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'licenses', 'platform-assets.md'),
		'utf8',
	);
	const section = (heading: string): string => {
		const start = record.indexOf(`## ${heading}`);
		expect(start).toBeGreaterThanOrEqual(0);
		const end = record.indexOf('\n## ', start + 3);
		return record.slice(start, end < 0 ? undefined : end);
	};
	const sets: Array<[string, Record<string, PlatformGlyph>]> = [
		['TikTok', TIKTOK_GLYPHS],
		['Instagram', INSTAGRAM_GLYPHS],
		['YouTube', YOUTUBE_GLYPHS],
		['X', X_GLYPHS],
	];

	it.each(sets)('lists every %s glyph with the method the module records', (heading, set) => {
		const text = section(heading);
		for (const [name, g] of Object.entries(set)) {
			const row = text.split('\n').find((l) => l.startsWith(`| \`${name}\` |`));
			expect(row, `${heading} ${name}`).toBeDefined();
			expect(row?.trim().endsWith(`| ${g.origin} |`), `${heading} ${name}: ${g.origin}`).toBe(true);
		}
	});

	it('lists the TikTok default avatar and the raster avatars by URL and hash', () => {
		expect(section('TikTok')).toContain(`| \`TIKTOK_DEFAULT_AVATAR\` |`);
		for (const p of ['x', 'youtube'] as const) {
			const a = PLATFORM_DEFAULT_AVATARS[p];
			if (a.kind !== 'remote') throw new Error(`${p} avatar is not remote`);
			expect(record).toContain(a.image.url);
			expect(record).toContain(a.image.sha256);
		}
	});
});

describe('scopeGlyphIds', () => {
	it('prefixes gradient ids and the fills that reference them', () => {
		const g = scopeGlyphIds(X_GLYPHS.verifiedGold, 'clip-1');
		expect(g.gradients?.map((x) => x.id)).toEqual([
			'clip-1-icon-verified-business-color_a',
			'clip-1-icon-verified-business-color_b',
		]);
		expect(g.paths.map((p) => p.fill)).toEqual([
			'url(#clip-1-icon-verified-business-color_a)',
			'url(#clip-1-icon-verified-business-color_b)',
			'#d18800',
		]);
		// The source data is untouched.
		expect(X_GLYPHS.verifiedGold.gradients[0].id).toBe('icon-verified-business-color_a');
	});

	it('returns glyphs without gradients unchanged', () => {
		expect(scopeGlyphIds(X_GLYPHS.like, 'a')).toBe(X_GLYPHS.like);
	});

	it('keeps ids valid and references consistent for any scope', () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 40 }), (scope) => {
				const g = scopeGlyphIds(X_GLYPHS.verifiedGold, scope);
				const ids = new Set(g.gradients?.map((x) => x.id));
				for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]*-icon-verified-business-color_[ab]$/);
				for (const p of g.paths) {
					const ref = p.fill ? /^url\(#([^)]+)\)$/.exec(p.fill) : null;
					if (ref) expect(ids.has(ref[1] as string)).toBe(true);
				}
			}),
		);
	});

	it('gives two instances distinct ids', () => {
		const a = scopeGlyphIds(X_GLYPHS.verifiedGold, 'a');
		const b = scopeGlyphIds(X_GLYPHS.verifiedGold, 'b');
		expect(a.gradients?.[0]?.id).not.toBe(b.gradients?.[0]?.id);
	});
});
