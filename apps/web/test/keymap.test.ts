import { describe, expect, it } from 'vitest';
import {
	DEFAULT_KEYMAP,
	effectiveKey,
	normalizeChord,
	type Platform,
	type Runtime,
} from '../src/commands/keymap-defaults.ts';

describe('default keymap (S02:TL-903, R-PUI §16, S05:KB-010/011/013)', () => {
	const combos: [Platform, Runtime][] = [
		['win', 'desktop'],
		['linux', 'web'],
		['linux', 'desktop'],
		['win', 'web'],
		['mac', 'desktop'],
		['mac', 'web'],
	];
	for (const [platform, runtime] of combos) {
		it(`has no duplicate bindings within a scope (${platform}/${runtime}, KB-011)`, () => {
			const seen = new Map<string, string>();
			const contextual = new Set<string>();
			const dups: string[] = [];
			for (const b of DEFAULT_KEYMAP) {
				const key = effectiveKey(b, platform, runtime);
				if (!key) continue;
				const k = `${b.scope}|${normalizeChord(key)}`;
				const prev = seen.get(k);
				// edit-ux: a contextual binding shares its chord on purpose (first enabled wins); it must come first.
				if (prev && prev !== b.command && !b.contextual && !contextual.has(k))
					dups.push(`${k}: ${prev} vs ${b.command}`);
				if (b.contextual && prev && prev !== b.command && !contextual.has(k))
					dups.push(`${k}: contextual ${b.command} must precede ${prev}`);
				if (b.contextual) contextual.add(k);
				else if (!seen.has(k) || contextual.has(k)) contextual.delete(k);
				seen.set(k, b.command);
			}
			expect(dups).toEqual([]);
		});
	}
	it('uses web fallbacks for browser-reserved chords (KB-013)', () => {
		const newSeq = DEFAULT_KEYMAP.find((b) => b.command === 'app.newSequence')!;
		expect(effectiveKey(newSeq, 'linux', 'web')).toBe('Alt+KeyN');
		expect(effectiveKey(newSeq, 'linux', 'desktop')).toBe('Ctrl+KeyN');
		expect(
			effectiveKey(DEFAULT_KEYMAP.find((b) => b.command === 'graphics.newTextLayer')!, 'win', 'pwa'),
		).toBe('Alt+KeyT');
	});
});
