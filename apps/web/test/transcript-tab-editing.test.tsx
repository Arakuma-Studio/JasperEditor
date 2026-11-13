// Text ▸ Transcript editing (spec 17 SC-071 / SC-080 / SC-083 / SC-085; the tab had no editing test before): a
// double-click word fix and Correct… commit `transcript.editText`, then offer "Replace all N" (the other occurrences
// of the recogniser's spelling, ONE transaction and one undo step) and "Remember" (the personal glossary); no offer
// when nothing changes in spelling; the offer is dismissable and never applies itself. The toolbar's Script… opens
// the Script drawer with its summary and Fix Transcript… the Fix dialog. While a fix proposal is under review its
// words are marked and a click selects its Review row. Remove Pauses / Remove Fillers cut hard unless "Fade joins" is
// checked.
import { EngineClient } from '@jasper/engine-client';
import type { ProjectDocument, Sequence } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { proposalsFor } from '@jasper/session';
import { SessionProvider, useStoreSelector } from '@jasper/session/react';
import { closeAllDialogs, DialogHost } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { FakeEngine } from '../../../packages/session/test/fake-proposals-engine.ts';
import { registerAllCommands } from '../src/commands/index.ts';
import { TranscriptTab } from '../src/panels/text/TranscriptTab.tsx';
import { EngineProvider } from '../src/state/engine.tsx';
import { fixItems, fixSession, WORDS } from './script-fix-helpers.ts';

beforeAll(() => registerAllCommands());
afterEach(() => {
	closeAllDialogs();
	cleanup();
	vi.restoreAllMocks();
});

/** The fixture's words, with "Glimer" and "Nova play" said a second time. */
const TWICE: Array<[string, number, number]> = [
	...WORDS,
	['otra', 4.0, 4.3],
	['vez', 4.3, 4.6],
	['Glimer', 4.8, 5.1],
	['con', 5.2, 5.4],
	['Nova', 5.5, 5.8],
	['play.', 5.8, 6.1],
];

function fakeClient() {
	const calls: { method: string; url: string; body?: unknown }[] = [];
	const json = (b: unknown, status = 200) =>
		new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		const method = init?.method ?? 'GET';
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ method, url, ...(body !== undefined ? { body } : {}) });
		if (url === '/api/speech/glossary/remember')
			return json({
				revision: 2,
				created: true,
				changed: true,
				entry: {
					id: 'gle_0000000000000001',
					from: body.from,
					to: body.to,
					lang: body.lang,
					count: 1,
					createdAt: '2026-10-27T00:00:00.000Z',
					updatedAt: '2026-10-27T00:00:00.000Z',
				},
			});
		return json({ code: 'NOT_FOUND', message: url, retryable: false }, 404);
	}) as unknown as typeof fetch;
	return { client: new EngineClient({ baseUrl: '', fetch: fetchImpl }), calls };
}

/** The tab as the Text panel mounts it: with the live sequence. */
function Host(p: { session: EditorSession; seqId: string }) {
	const seq = useStoreSelector(p.session.store, (s) => s.document.sequences[p.seqId] as Sequence);
	return <TranscriptTab session={p.session} seq={seq} />;
}

function setup(words = TWICE) {
	const f = fixSession({ words });
	const engine = fakeClient();
	const ui = render(
		<EngineProvider client={engine.client}>
			<SessionProvider session={f.session}>
				<Host session={f.session} seqId={f.seqId} />
				<DialogHost />
			</SessionProvider>
		</EngineProvider>,
	);
	const texts = () =>
		(f.session.getCommitted() as ProjectDocument).transcripts[f.transcriptId]!.words.map((w) => w.text);
	return { ...f, ...engine, ui, texts };
}

const word = (i: number) => screen.getByTestId(`text.transcript.word.${i}`);

function editWordTo(i: number, text: string) {
	act(() => {
		fireEvent.doubleClick(word(i));
	});
	const input = screen.getByTestId('text.transcript.wordEdit') as HTMLInputElement;
	act(() => {
		fireEvent.change(input, { target: { value: text } });
		fireEvent.keyDown(input, { key: 'Enter' });
	});
}

describe('manual fixes and their offers (SC-071 / SC-085)', () => {
	it('a double-click fix offers Replace all N: one transaction, one undo step', () => {
		const { session, texts } = setup();
		editWordTo(2, 'Glimmer');
		expect(texts()[2]).toBe('Glimmer');
		expect(texts()[12]).toBe('Glimer');
		const bar = screen.getByTestId('text.transcript.offer');
		expect(bar.textContent).toContain('“Glimer” → “Glimmer”');
		const entries = session.getState().history.entries.length;
		act(() => {
			fireEvent.click(screen.getByTestId('text.transcript.offer.replaceAll'));
		});
		expect(screen.getByTestId('text.transcript.offer.replaced').textContent).toBe('Replaced 1 more');
		expect(texts()[12]).toBe('Glimmer');
		expect(session.getState().history.entries.length).toBe(entries + 1);
		expect(session.getState().history.entries.at(-1)!.label).toBe('Replace All: Glimer → Glimmer');
		act(() => session.undo());
		expect(texts()[12]).toBe('Glimer');
		expect(texts()[2]).toBe('Glimmer'); // the manual fix is its own step
	});

	it('Correct… over two words offers the other occurrence, keeping its punctuation', () => {
		const { texts } = setup();
		const prompt = window.prompt;
		window.prompt = vi.fn(() => 'NovaPlay');
		onTestFinished(() => {
			window.prompt = prompt;
		});
		act(() => {
			fireEvent.pointerDown(word(5), { button: 0 });
			fireEvent.pointerUp(word(5));
		});
		act(() => {
			fireEvent.pointerDown(word(6), { button: 0, shiftKey: true });
		});
		act(() => {
			fireEvent.click(screen.getByTestId('text.transcript.correct'));
		});
		expect(texts().slice(5, 6)).toEqual(['NovaPlay']);
		act(() => {
			fireEvent.click(screen.getByTestId('text.transcript.offer.replaceAll'));
		});
		expect(texts().at(-1)).toBe('NovaPlay.');
	});

	it('Remember teaches the personal glossary; the result is said in the bar', async () => {
		const { calls } = setup();
		editWordTo(2, 'Glimmer');
		await act(async () => {
			fireEvent.click(screen.getByTestId('text.transcript.offer.remember'));
		});
		await waitFor(() => expect(screen.getByTestId('text.transcript.offer.remembered')).toBeTruthy());
		expect(calls.find((c) => c.url === '/api/speech/glossary/remember')?.body).toEqual({
			from: ['Glimer'],
			to: 'Glimmer',
			lang: 'es',
		});
	});

	it('no offer when the spelling does not change; the offer is dismissable and never applies itself', () => {
		const { texts } = setup();
		editWordTo(9, 'demo.');
		expect(texts()[9]).toBe('demo.');
		expect(screen.queryByTestId('text.transcript.offer')).toBeNull();
		editWordTo(2, 'Glimmer');
		expect(screen.getByTestId('text.transcript.offer')).toBeTruthy();
		expect(texts()[12]).toBe('Glimer');
		act(() => {
			fireEvent.click(screen.getByTestId('text.transcript.offer.dismiss'));
		});
		expect(screen.queryByTestId('text.transcript.offer')).toBeNull();
		expect(texts()[12]).toBe('Glimer');
	});

	it('a correction with no other occurrence offers Remember only', () => {
		setup(WORDS);
		editWordTo(1, 'probaremos');
		expect(screen.getByTestId('text.transcript.offer')).toBeTruthy();
		expect(screen.queryByTestId('text.transcript.offer.replaceAll')).toBeNull();
		expect(screen.getByTestId('text.transcript.offer.remember')).toBeTruthy();
	});
});

describe('toolbar entries (SC-080)', () => {
	it('Script… opens the drawer with the parsed summary; attaching is one undo step', () => {
		const { session, seq } = setup();
		act(() => {
			fireEvent.click(screen.getByTestId('text.transcript.script'));
		});
		const text = screen.getByTestId('text.cleanup.script.text');
		act(() => {
			fireEvent.change(text, {
				target: {
					value: 'INTRO\nHoy probamos Glimmerbox (mostrar la caja).\nOutro:\nY la demo de NovaPlay.',
				},
			});
		});
		expect(screen.getByTestId('text.cleanup.script.summary').textContent).toMatch(
			/\d+ sections? · \d+ words read · 1 direction \(3 words\) and 2 headings skipped/,
		);
		act(() => {
			fireEvent.click(screen.getByTestId('text.cleanup.script.attach'));
		});
		expect(session.getState().history.entries.at(-1)!.label).toBe('Attach Script');
		expect((seq().cleanup as { script?: { text: string } }).script?.text).toContain('Glimmerbox');
	});

	it('Fix Transcript… opens the Fix dialog', async () => {
		setup();
		act(() => {
			fireEvent.click(screen.getByTestId('text.transcript.fix'));
		});
		expect(await screen.findByTestId('fix-transcript-dialog')).toBeTruthy();
	});
});

describe('proposed fixes in the transcript (SC-083)', () => {
	it('marks the words of an open fix proposal; a click selects its Review row', async () => {
		const f = fixSession({ words: TWICE });
		const engine = new FakeEngine(() => f.session);
		const c = proposalsFor(f.session, { engine, setTimer: () => 0, clearTimer: () => undefined });
		c.connect(engine.subscribe);
		const p = engine.create(
			{
				feature: 'transcript-correction',
				title: 'Fix transcript',
				sequenceId: f.seqId,
				items: fixItems(f.transcriptId, f.mediaId),
			},
			{ agent: 'jasper' },
		);
		render(
			<EngineProvider client={fakeClient().client}>
				<SessionProvider session={f.session}>
					<Host session={f.session} seqId={f.seqId} />
				</SessionProvider>
			</EngineProvider>,
		);
		expect(word(2).getAttribute('data-fix-item')).toBeNull();
		await act(async () => {
			await c.setActive(p.id);
		});
		expect(word(2).getAttribute('data-fix-item')).toBe('fix:1');
		expect(word(3).getAttribute('data-fix-item')).toBe('fix:1');
		expect(word(2).getAttribute('title')).toBe('Proposed fix: Glimer box → Glimmerbox. Click to review it');
		expect(word(5).getAttribute('data-fix-item')).toBe('fix:2');
		expect(word(4).getAttribute('data-fix-item')).toBeNull();
		expect(word(12).getAttribute('data-fix-item')).toBeNull(); // the second take was not proposed
		act(() => {
			fireEvent.click(word(5));
		});
		expect(c.getState().selection).toEqual(['fix:2']);
		// a rejected item is no longer marked
		await act(async () => {
			await c.setItemDecision(['fix:2'], 'reject');
		});
		expect(word(5).getAttribute('data-fix-item')).toBeNull();
		c.exit();
		await act(async () => Promise.resolve());
		expect(word(2).getAttribute('data-fix-item')).toBeNull();
	});
});

describe('cut tools: hard cuts unless Fade joins is checked', () => {
	it('Remove Pauses leaves no edge fades by default; with Fade joins every cut edge fades, in one undo step', () => {
		const run = (fade: boolean) => {
			const f = setup(WORDS);
			fireEvent.click(screen.getByTestId('text.transcript.pauses'));
			fireEvent.change(screen.getByTestId('text.transcript.pauseMin'), { target: { value: '0.15' } });
			fireEvent.change(screen.getByTestId('text.transcript.pauseKeep'), { target: { value: '0' } });
			const box = within(screen.getByTestId('text.transcript.pausesFade')).getByRole('checkbox');
			expect(box.getAttribute('aria-checked')).toBe('false');
			if (fade) fireEvent.click(box);
			const entries = f.session.getState().history.entries.length;
			fireEvent.click(screen.getByTestId('text.transcript.pausesApply'));
			expect(f.session.getState().history.entries.length).toBe(entries + 1);
			const fades = (doc: ProjectDocument) =>
				Object.values(doc.sequences[f.seqId]!.clips)
					.filter((c) => c.kind === 'audio')
					.map((c) => (c as { edgeFades?: Record<string, number> }).edgeFades ?? null);
			const after = fades(f.session.getCommitted() as ProjectDocument);
			f.session.undo();
			expect(fades(f.session.getCommitted() as ProjectDocument)).toEqual([null]);
			cleanup();
			return after;
		};
		const hard = run(false);
		expect(hard.length).toBeGreaterThan(1);
		expect(hard.every((x) => x === null)).toBe(true);
		const faded = run(true);
		expect(faded).toHaveLength(hard.length);
		expect(faded.every((x) => x !== null && Object.values(x).every((ms) => ms === 4))).toBe(true);
	});
});
