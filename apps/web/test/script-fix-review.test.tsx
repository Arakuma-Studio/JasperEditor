// Spec 17 in the editor (scapply): a transcript-correction proposal in the Review panel — Maybe rows are marked "Not
// selected" and Accept all leaves them pending (accepting one explicitly takes it), the feature's groups and noun;
// and a transcript fix makes an open Clean Up review stale through the existing detection (SC-054), while the Fix
// Transcript settings do not.
import { FLICKS_PER_SECOND, type ProjectDocument } from '@jasper/project';
import { proposalsFor } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeEngine } from '../../../packages/session/test/fake-proposals-engine.ts';
import { ReviewPanel } from '../src/panels/review/ReviewPanel.tsx';
import { analysisInputsChanged } from '../src/panels/text/cleanup/model.ts';
import { acceptAll } from '../src/proposals/actions.ts';
import { reviewVocabulary } from '../src/proposals/vocabulary.ts';
import { audioAsset } from './proposal-helpers.ts';
import { makeSession } from './timeline-helpers.ts';

afterEach(cleanup);
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
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
const maybeItem = (transcriptId: string) => ({
	id: 'fix:2',
	label: '+ → en',
	group: 'maybe',
	meta: { group: 'maybe' },
	selected: false,
	commands: [
		{
			type: 'transcript.replaceWords',
			transcriptId,
			edits: [
				{
					start: sec(1.3),
					end: sec(1.5),
					expect: [],
					words: [{ text: 'en', start: sec(1.32), end: sec(1.48), confidence: null }],
				},
			],
		},
	],
});

describe('transcript fixes in the Review panel (SC-061)', () => {
	it('marks Maybe rows "Not selected"; Accept all leaves them pending; accepting one takes it', async () => {
		const { session, seqId, transcriptId } = fixture();
		const engine = new FakeEngine(() => session);
		const c = proposalsFor(session, { engine, setTimer: () => 0, clearTimer: () => undefined });
		c.connect(engine.subscribe);
		const p = engine.create(
			{
				feature: 'transcript-correction',
				title: 'Fix transcript',
				sequenceId: seqId,
				items: [fixItem(transcriptId), maybeItem(transcriptId)],
			},
			{ agent: 'fixer' },
		);
		await c.setActive(p.id);
		render(
			<SessionProvider session={session}>
				<ReviewPanel instanceId="r1" visible />
			</SessionProvider>,
		);
		await settle();
		const row = (id: string) => document.querySelector(`[data-review-row="${id}"]`) as HTMLElement;
		expect(row('fix:2').querySelector('[data-review-unselected]')?.textContent).toBe('Not selected');
		expect(row('fix:1').querySelector('[data-review-unselected]')).toBeNull();
		expect(row('fix:2').getAttribute('aria-label')).toContain('Not selected');
		// the feature's groups (Fixes, Maybe) and noun
		expect(screen.getByTestId('review-list').textContent).toMatch(/Fixes[\s\S]*Maybe/);
		expect(reviewVocabulary('transcript-correction').itemsText(2)).toBe('2 fixes');
		await act(async () => {
			await acceptAll(session);
		});
		expect(c.acceptedIds()).toEqual(['fix:1']);
		expect(c.getState().items.find((it) => it.id === 'fix:2')!.state).toBe('pending');
		await act(async () => {
			await c.setItemDecision(['fix:2'], 'accept');
		});
		expect(c.acceptedIds()).toEqual(['fix:1', 'fix:2']);
		c.dispose();
	});
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
