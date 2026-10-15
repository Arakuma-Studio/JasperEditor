// The sound-design texts the editor translates (src/sound/messages.ts): every refusal the sound handlers and the
// placement planners write has its template there, so a Spanish editor shows it translated (apps/web i18n).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOUND_LABELS, SOUND_MESSAGES, SOUND_MODEL_STRINGS, soundText } from '../src/index.ts';

const src = (p: string) => readFileSync(join(__dirname, '../src', p), 'utf8');

/** Message literals of `h.fail(code, …)`, `refuse(…)` and `message: …` with `${…}` turned into `{n}`. */
function messagesOf(text: string): string[] {
	const out: string[] = [];
	const re =
		/(?:fail\(\s*'[A-Z_]+'\s*,\s*|refuse\(\s*|message:\s*)(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
	for (const m of text.matchAll(re)) {
		let n = 0;
		out.push(m[1]!.slice(1, -1).replace(/\$\{[^}]*\}/g, () => `{${n++}}`));
	}
	return out;
}

/** Developer-facing input checks of `peakAlignedStart` (agents and code, never the editor's own placements). */
const INTERNAL = new Set([
	'placement input must be an object',
	'cueFrame must be a frame number ≥ 0',
	'fps must be a positive rational (num/den) up to 1000 fps',
	'rate must be between {0} and {1}',
	'durationSec must be > 0 and ≤ {0}',
	'peakSec must be a number ≥ 0',
	'headQuietSec must be a number ≥ 0',
	'align must be peak, start or end',
]);

describe('sound-design model strings', () => {
	it('every refusal of the sound handlers and planners has a template', () => {
		const found = [
			...messagesOf(src('commands/handlers/sound.ts')),
			...messagesOf(src('sound/insert.ts')),
			...messagesOf(src('sound/place.ts')),
		];
		expect(found.length).toBeGreaterThan(40);
		const known = new Set<string>(SOUND_MESSAGES);
		expect(found.filter((m) => !known.has(m) && !INTERNAL.has(m))).toEqual([]);
	});

	it('labels and messages fill their placeholders; the list has no duplicates', () => {
		expect(soundText(SOUND_LABELS.placeSounds, 3)).toBe('Place 3 Sounds');
		expect(soundText('Clip {0} cannot move to frame {1}: other audio is there', 'clp_1', 90)).toBe(
			'Clip clp_1 cannot move to frame 90: other audio is there',
		);
		expect(soundText('Media {0} has no length')).toBe('Media {0} has no length');
		expect(new Set(SOUND_MODEL_STRINGS).size).toBe(SOUND_MODEL_STRINGS.length);
	});
});
