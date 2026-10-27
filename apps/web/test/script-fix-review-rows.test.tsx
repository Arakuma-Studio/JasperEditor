// Spec 17 SC-082 … SC-084 in the Review panel: transcript-correction items render as text-diff rows (context ·
// before → after · category · confidence from Δ_tok with its rule), in the feature's groups with Maybe unselected;
// ▶ plays the source recording ±1 s; per-group Accept / None; stale rows marked; Apply shows the patch report with
// "Show skipped subtitles", which selects them; one undo restores transcript and subtitles.
import type { ProjectDocument, TextClip } from '@jasper/project';
import { proposalsFor } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeEngine } from '../../../packages/session/test/fake-proposals-engine.ts';
import { ReviewPanel } from '../src/panels/review/ReviewPanel.tsx';
import { acceptAll, applyReview, decideGroup, playReviewItem } from '../src/proposals/actions.ts';
import { dismissFixReport, fixReportStore } from '../src/script-fix/review.ts';
import {
	type SourceAudioElement,
	setSourceAudioFactory,
	sourcePlayStore,
} from '../src/script-fix/source-audio.ts';
import { fixItems, fixSession } from './script-fix-helpers.ts';

afterEach(() => {
	cleanup();
	dismissFixReport();
});
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const row = (id: string) => document.querySelector(`[data-review-row="${id}"]`) as HTMLElement;

async function reviewFixture(opts: { subtitles?: boolean; lockSubtitles?: boolean } = {}) {
	const f = fixSession({ engine: { mediaUrl: (k: string) => `/media/${k}` } });
	const { session, seqId } = f;
	if (opts.subtitles) {
		const g = session.apply({
			label: 'subs',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{ type: 'captions.generate', cutAware: false, template: 'builtin:pixel-pop', rules: { maxWords: 4 } },
			] as never[],
		});
		if (!g.ok) throw new Error(JSON.stringify(g.errors));
		if (opts.lockSubtitles) {
			const sub = Object.values(f.seq().clips).find((c) => c.kind === 'text')!;
			const l = session.apply({
				label: 'lock',
				origin: 'user',
				sequenceId: seqId,
				commands: [{ type: 'track.update', trackId: sub.trackId, patch: { locked: true } }] as never[],
			});
			if (!l.ok) throw new Error(JSON.stringify(l.errors));
		}
	}
	const engine = new FakeEngine(() => session);
	const timers: (() => void)[] = [];
	const c = proposalsFor(session, {
		engine,
		setTimer: (fn) => {
			timers.push(fn);
			return 0;
		},
		clearTimer: () => undefined,
	});
	c.connect(engine.subscribe);
	const p = engine.create(
		{
			feature: 'transcript-correction',
			title: 'Fix transcript',
			sequenceId: seqId,
			items: fixItems(f.transcriptId, f.mediaId),
		},
		{ agent: 'jasper' },
	);
	await c.setActive(p.id);
	render(
		<SessionProvider session={session}>
			<ReviewPanel instanceId="r1" visible />
		</SessionProvider>,
	);
	await settle();
	const flush = async () => {
		for (const fn of timers.splice(0)) fn();
		await settle();
	};
	return { ...f, c, engine, flush };
}

describe('transcript fixes as Review rows (SC-082)', () => {
	it('draws the text diff, category and confidence label per row, in the feature’s groups', async () => {
		await reviewFixture();
		const fix = row('fix:1');
		expect(fix.querySelector('[data-fix-before]')?.textContent).toBe('Glimer box');
		expect(fix.querySelector('[data-fix-after]')?.textContent).toBe('Glimmerbox');
		expect(fix.querySelector('[data-fix-diff]')?.textContent).toContain('Hoy probamos');
		expect(fix.querySelector('[data-fix-category]')?.textContent).toBe('Name');
		expect(fix.querySelector('[data-fix-confidence]')?.getAttribute('data-fix-confidence')).toBe('high');
		expect(fix.querySelector('[data-fix-rule]')?.textContent).toMatch(/Audio check · Δ \+2\.3 per token/);
		// heard in the sequence at 1.0 s (frame 30 at 30 fps): a timecode, not "—"
		expect(fix.textContent).toContain('00:00:01:00');
		expect(fix.getAttribute('aria-label')).toContain('Glimer box to Glimmerbox');
		const sp = row('fix:2');
		expect(sp.querySelector('[data-fix-confidence]')?.textContent).toBe('No audio check');
		expect(sp.querySelector('[data-fix-rule]')?.textContent).toMatch(/Script spelling/);
		const maybe = row('fix:3');
		expect(maybe.querySelector('[data-fix-confidence]')?.getAttribute('data-fix-confidence')).toBe('low');
		expect(maybe.querySelector('[data-review-unselected]')?.textContent).toBe('Not selected');
		expect(screen.getByTestId('review-list').textContent).toMatch(/Fixes[\s\S]*Spelling[\s\S]*Maybe/);
	});

	it('▶ plays the source recording from 1 s before to 1 s after the words', async () => {
		const { session, mediaKey } = await reviewFixture();
		const played: Partial<SourceAudioElement>[] = [];
		const prev = setSourceAudioFactory(() => {
			const el = {
				src: '',
				preload: '',
				currentTime: 0,
				onerror: null,
				ontimeupdate: null,
				onloadedmetadata: null,
				play: () => Promise.resolve(),
				pause: () => undefined,
				removeAttribute: () => undefined,
				load: () => undefined,
			} as SourceAudioElement;
			played.push(el);
			return el;
		});
		try {
			act(() => {
				fireEvent.click(row('fix:2').querySelector('[data-review-tool="play"]')!);
			});
			expect(played).toHaveLength(1);
			expect(played[0]!.src).toBe(`/media/${mediaKey}`);
			expect(played[0]!.currentTime).toBeCloseTo(1.0, 5); // 2.0 s − 1 s
			expect(sourcePlayStore.getState().itemId).toBe('fix:2');
			// past the end (2.6 s + 1 s) it stops by itself
			played[0]!.currentTime = 3.7;
			act(() => (played[0]!.ontimeupdate as () => void)());
			expect(sourcePlayStore.getState().itemId).toBeNull();
			// Space (the review key) takes the same path
			expect(playReviewItem(session, 'fix:1')).toBe(true);
			expect(played[1]!.currentTime).toBeCloseTo(0, 5);
		} finally {
			setSourceAudioFactory(prev);
		}
	});

	it('accepts and clears a whole group; Accept all leaves Maybe out', async () => {
		const { session, c } = await reviewFixture();
		await act(async () => {
			fireEvent.click(document.querySelector('[data-review-group-action="maybe:accept"]')!);
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(c.acceptedIds()).toEqual(['fix:3']);
		await act(async () => {
			await decideGroup(session, 'clear', 'maybe');
		});
		expect(c.acceptedIds()).toEqual([]);
		await act(async () => {
			await acceptAll(session);
		});
		expect(c.acceptedIds()).toEqual(['fix:1', 'fix:2']);
	});

	it('marks a row stale when its words changed since', async () => {
		const { session, seqId, transcriptId, flush } = await reviewFixture();
		const r = session.apply({
			label: 'hand fix',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{ type: 'transcript.editText', transcriptId, fromWord: 2, toWord: 3, text: 'Glimmer box' },
			] as never[],
		});
		expect(r.ok).toBe(true);
		await flush();
		expect(row('fix:1').getAttribute('data-review-state')).toBe('stale');
		expect(row('fix:1').querySelector('[data-review-problem]')).not.toBeNull();
		expect(row('fix:2').getAttribute('data-review-state')).toBe('pending');
	});
});

describe('the patch report after Apply (SC-084)', () => {
	it('says how many fixes applied; subtitles patched in place, one undo restores both', async () => {
		const { session, seq, doc, transcriptId } = await reviewFixture({ subtitles: true });
		const subs0 = Object.values(seq().clips).filter((x): x is TextClip => x.kind === 'text');
		const glim = subs0.find((x) => x.content.text.includes('Glimer'))!;
		await act(async () => {
			await acceptAll(session);
		});
		await act(async () => {
			const r = await applyReview(session, { trusted: true });
			expect(r.ok).toBe(true);
		});
		await settle();
		expect(screen.getByTestId('review-fix-report').textContent).toContain('2 fixes applied');
		expect(screen.queryByTestId('review-fix-show-skipped')).toBeNull();
		expect(fixReportStore.getState().notice?.report.skipped).toEqual([]);
		const after = seq().clips[glim.id] as TextClip;
		expect(after.content.text).toContain('Glimmerbox');
		expect(after.effects).toEqual(glim.effects);
		expect(doc().transcripts[transcriptId]!.words.map((w) => w.text)).toContain('NovaPlay');
		act(() => session.undo());
		expect((seq().clips[glim.id] as TextClip).content.text).toBe(glim.content.text);
		expect((doc() as ProjectDocument).transcripts[transcriptId]!.words.map((w) => w.text)).toContain(
			'Glimer',
		);
	});

	it('names the subtitles left unchanged, and “Show skipped subtitles” selects them', async () => {
		const { session, seq } = await reviewFixture({ subtitles: true, lockSubtitles: true });
		await act(async () => {
			await acceptAll(session);
		});
		await act(async () => {
			await applyReview(session, { trusted: true });
		});
		await settle();
		const bar = screen.getByTestId('review-fix-report');
		expect(bar.textContent).toMatch(/2 fixes applied · \d+ subtitles? not updated: on a locked track/);
		const skipped = fixReportStore.getState().notice!.report.skipped.map((s) => s.clipId);
		expect(skipped.length).toBeGreaterThan(0);
		act(() => {
			fireEvent.click(screen.getByTestId('review-fix-show-skipped'));
		});
		expect([...session.getState().selection.timeline.clips].sort()).toEqual([...skipped].sort());
		for (const id of skipped) expect(seq().clips[id]!.kind).toBe('text');
		act(() => {
			fireEvent.click(screen.getByTestId('review-fix-report-dismiss'));
		});
		expect(screen.queryByTestId('review-fix-report')).toBeNull();
	});
});
