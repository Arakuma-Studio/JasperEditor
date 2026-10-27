// A transcript fix makes an open Clean Up review stale (SC-054); changing Fix Transcript settings does not.
import { FLICKS_PER_SECOND, type ProjectDocument } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { analysisInputsChanged } from '../src/panels/text/cleanup/model.ts';
import { audioAsset } from './proposal-helpers.ts';
import { makeSession } from './timeline-helpers.ts';

const sec = (x: number) => Math.round(x * FLICKS_PER_SECOND);

function fixture() {
	const { session, seqId } = makeSession();
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{ type: 'media.register', asset: audioAsset(10), ref: '$m' },
			{ type: 'clip.place', source: { mediaId: '$m' }, at: 0, tracks: { audio: 'A1' } },
		] as never[],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const t = session.apply({
		label: 'transcript',
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{
				type: 'transcript.create',
				mediaId: r.refs.$m!,
				language: 'es',
				origin: 'whisper-local',
				words: [
					{ text: 'Hoy', start: sec(0.2), end: sec(0.5) },
					{ text: 'Glimer', start: sec(0.5), end: sec(0.9) },
					{ text: 'box', start: sec(0.9), end: sec(1.2) },
					{ text: 'y', start: sec(1.2), end: sec(1.3) },
					{ text: 'la', start: sec(1.5), end: sec(1.7) },
				],
			},
		] as never[],
	});
	if (!t.ok) throw new Error(JSON.stringify(t.errors));
	const transcriptId = (t.results[0] as { transcriptId: string }).transcriptId;
	return { session, seqId, transcriptId };
}

const fixItem = (transcriptId: string) => ({
	id: 'fix:1',
	label: 'Glimer box → Glimmerbox',
	group: 'fix',
	meta: { group: 'fix' },
	commands: [
		{
			type: 'transcript.replaceWords',
			transcriptId,
			edits: [
				{
					start: sec(0.5),
					end: sec(1.2),
					expect: ['Glimer', 'box'],
					words: [{ text: 'Glimmerbox', start: sec(0.5), end: sec(1.2), confidence: 0.8 }],
				},
			],
		},
	],
});
describe('Clean Up goes stale after a transcript fix (SC-054)', () => {
	it('analysisInputsChanged is true after replaceWords, false after scriptFix.configure', () => {
		const { session, seqId, transcriptId } = fixture();
		const before = session.getCommitted() as ProjectDocument;
		const r = session.apply({
			label: 'fix',
			origin: 'user',
			sequenceId: seqId,
			commands: [fixItem(transcriptId).commands[0]] as never[],
		});
		expect(r.ok).toBe(true);
		const fixed = session.getCommitted() as ProjectDocument;
		expect(analysisInputsChanged(before, fixed, seqId)).toBe(true);
		const s = session.apply({
			label: 'settings',
			origin: 'user',
			sequenceId: seqId,
			commands: [{ type: 'scriptFix.configure', reject: ['fp:x'] }] as never[],
		});
		expect(s.ok).toBe(true);
		expect(analysisInputsChanged(fixed, session.getCommitted() as ProjectDocument, seqId)).toBe(false);
	});
});
