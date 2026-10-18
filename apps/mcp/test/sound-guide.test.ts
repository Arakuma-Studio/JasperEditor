// SOUND_GUIDE says what spec 12 §2.10 requires an agent to be told (the Phase 1 parts), and it is part of FULL_GUIDE
// (the server instructions, the edit-video prompt and the jasper://guide resource).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROPOSALS_GUIDE } from '../src/tools/proposals.ts';
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
			// P6-E9: takes and the sourcing flags
			'takes: true',
			'~t<n>',
			'never offered',
			'vary the take, not the pitch',
			'lowpassed',
			'noisy-floor',
			'dc-offset',
			'material',
			// P6-E4 / P6-E5: the review lenses, one writer, acknowledged exceptions, how to write a query
			'review lenses',
			'sync —',
			'edges — click and edge',
			'masking — masked and layer_inaudible',
			'tonal — harsh',
			'director — arc and ending',
			'one writer, one proposal per pass',
			'sound_check {projectid, proposalid}',
			'never hand over a proposal that introduces errors without saying so',
			'acknowledge_sound_issue',
			'warnings and infos only',
			'source + material + action + character',
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

describe('PROPOSALS_GUIDE (spec 12 §2.10, P3-R5)', () => {
	it('teaches propose → wait → read the notes, and the policy gate', () => {
		const g = PROPOSALS_GUIDE.toLowerCase();
		for (const phrase of [
			"propose, don't apply",
			'review panel',
			'wait_for_proposal',
			'notes',
			'one transaction',
			'one undo step',
			'allow agents to apply sound proposals',
			'e_approval_required',
			'never accept your own proposal unless the user asked',
			'partial',
			'reject_proposal',
			'get_proposal',
			'list_proposals',
			// P6-E5
			'sound_check {projectid, proposalid}',
			'fixes and introduces',
			'one writer, one proposal per pass',
			'never hand over a proposal that introduces errors without saying so',
			'plan_sound_design {check: true}',
		])
			expect(g, phrase).toContain(phrase);
		// SOUND_GUIDE points at the workflow too
		const s = SOUND_GUIDE.toLowerCase();
		for (const phrase of ['plan_sound_design', 'wait_for_proposal', 'mode "apply"'])
			expect(s, phrase).toContain(phrase);
	});
	it('is part of FULL_GUIDE', () => {
		const src = readFileSync(join(import.meta.dirname, '..', 'src', 'server.ts'), 'utf8');
		const full = src.slice(
			src.indexOf('const FULL_GUIDE = ['),
			src.indexOf('];', src.indexOf('const FULL_GUIDE = [')),
		);
		expect(full).toContain('PROPOSALS_GUIDE');
	});
});
