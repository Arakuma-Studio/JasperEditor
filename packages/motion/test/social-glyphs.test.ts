import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	APP_STORE_GLYPHS,
	INSTAGRAM_GLYPHS,
	PLATFORM_DEFAULT_AVATARS,
	PLAY_STORE_GLYPHS,
	type PlatformGlyph,
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

function expectColor(color: string): void {
	const style = document.createElement('span').style;
	style.color = color;
	expect(style.color, color).not.toBe('');
}

const ALL: Array<[string, PlatformGlyph]> = [
	...Object.entries({
		tiktok: TIKTOK_GLYPHS,
		instagram: INSTAGRAM_GLYPHS,
		youtube: YOUTUBE_GLYPHS,
		x: X_GLYPHS,
		'play-store': PLAY_STORE_GLYPHS,
		'app-store': APP_STORE_GLYPHS,
	}).flatMap(([platform, set]) =>
		Object.entries(set as Record<string, PlatformGlyph>).map(
			([name, g]) => [`${platform}.${name}`, g] as [string, PlatformGlyph],
		),
	),
	['tiktok.defaultAvatar', TIKTOK_DEFAULT_AVATAR],
];

describe('platform glyphs', () => {
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
			expect(() => parsePath(p.d)).not.toThrow();
			if (p.fill !== undefined) {
				const ref = /^url\(#([^)]+)\)$/.exec(p.fill);
				if (ref) expect(gradientIds.has(ref[1] as string)).toBe(true);
				else expectColor(p.fill);
			}
			if (p.fillOpacity !== undefined) {
				expect(p.fillOpacity).toBeGreaterThanOrEqual(0);
				expect(p.fillOpacity).toBeLessThanOrEqual(1);
			}
		}
		for (const gr of g.gradients ?? []) {
			expect([gr.x1, gr.y1, gr.x2, gr.y2].every(Number.isFinite)).toBe(true);
			for (const s of gr.stops) {
				expect(s.offset).toBeGreaterThanOrEqual(0);
				expect(s.offset).toBeLessThanOrEqual(1);
				expectColor(s.color);
			}
		}
	});
});

describe('provenance record (licenses/platform-assets.md, AGENTS.md §3 item 5)', () => {
	const record = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'licenses', 'platform-assets.md'),
		'utf8',
	);
	it('records the remote avatar URLs and hashes', () => {
		for (const p of ['x', 'youtube'] as const) {
			const a = PLATFORM_DEFAULT_AVATARS[p];
			if (a.kind !== 'remote') throw new Error(`${p} avatar is not remote`);
			expect(record).toContain(a.image.url);
			expect(record).toContain(a.image.sha256);
		}
	});
});
