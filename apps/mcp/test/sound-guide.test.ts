// SOUND_GUIDE says what spec 12 §2.10 requires an agent to be told (the Phase 1 parts), and it is part of FULL_GUIDE
// (the server instructions, the edit-video prompt and the jasper://guide resource).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOUND_GUIDE } from '../src/tools/sound.ts';

describe('SOUND_GUIDE (spec 12 §2.10)', () => {
	it('says what the spec requires', () => {
		const g = SOUND_GUIDE.toLowerCase();
		for (const phrase of [
			'you cannot hear',
			'descriptors',
			'pictures',
			'sync by structure',
			'never claim',
			'sounds good',
			'peak',
			'risers and reverses align their end',
			'one family of sounds per type',
			'one hero',
			'per ~2 s',
			'never two heroes within 0.5 s',
			'no heroes under spoken words',
			"propose, don't apply",
			'a reason and 1–3 alternates',
			'commercial-safe',
			'credit',
		])
			expect(g, phrase).toContain(phrase);
	});
	it('is part of FULL_GUIDE', () => {
		const src = readFileSync(join(import.meta.dirname, '..', 'src', 'server.ts'), 'utf8');
		const full = src.slice(
			src.indexOf('const FULL_GUIDE = ['),
			src.indexOf('];', src.indexOf('const FULL_GUIDE = [')),
		);
		expect(full).toContain('SOUND_GUIDE');
	});
});
