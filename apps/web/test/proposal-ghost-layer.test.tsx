// The proposal ghost layer in the Timeline (spec 12 §2.7 "Review", P3-R6 ghost part) on a real session with a fake
// engine: ghosts drawn with their state, the agent bar, ghost track headers, a click selects the item and opens its
// card (why-line, Accept / Reject / Alternate / Note), the keyboard composite (arrows, Enter, Delete, U, A), Apply
// refused without a trusted click, high contrast (2 px solid, state by glyph), and ghost cues on the Cue Seam.
import type { Sequence, SoundCue } from '@jasper/project';
import { proposalsFor } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeLayout } from '../src/panels/timeline/model/layout.ts';
import { createTimelineUiStore } from '../src/panels/timeline/state/ui-store.ts';
import { reviewAnnouncer } from '../src/proposals/actions.ts';
import { GhostTrackHeaders, ProposalGhostLayer } from '../src/proposals/GhostLayer.tsx';
import { useGhostModel } from '../src/proposals/state.ts';
import { CueSeam } from '../src/sound/cues/CueSeam.tsx';
import { SEAM_PX } from '../src/sound/cues/model.ts';
import { proposalFixture } from './proposal-helpers.ts';

afterEach(() => {
	cleanup();
	document.documentElement.removeAttribute('data-pr-contrast');
});

const V = { scrollFrame: 0, pxPerFrame: 2, width: 1200 };
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

async function setup() {
	const f = await proposalFixture();
	const toasts: string[] = [];
	const layout = () =>
		computeLayout({
			height: 500,
			dividerRatio: 0.4,
			videoTracks: f.seq().videoTracks,
			audioTracks: f.seq().audioTracks,
			heights: {},
			scrollYVideo: 0,
			scrollYAudio: 0,
		});
	function Harness() {
		const model = useGhostModel(f.session, f.seqId);
		if (!model) return <div data-testid="no-ghosts" />;
		return (
			<>
				<GhostTrackHeaders session={f.session} model={model} layout={layout()} />
				<ProposalGhostLayer
					session={f.session}
					seq={f.seq()}
					model={model}
					layout={layout()}
					viewport={V}
					instanceId="t1"
					reveal={() => {}}
					toast={(_k, m) => toasts.push(m)}
				/>
			</>
		);
	}
	render(
		<SessionProvider session={f.session}>
			<Harness />
		</SessionProvider>,
	);
	const ghost = (item: string) =>
		document.querySelector<HTMLElement>(`[data-ghost-clip][data-ghost-item="${item}"]`)!;
	const card = () => screen.getByTestId('proposal-ghost-card');
	const action = async (name: string) => {
		await act(async () => {
			fireEvent.click(card().querySelector(`[data-ghost-action="${name}"]`)!);
		});
		await settle();
		act(() => f.flush());
	};
	const open = (item: string) => act(() => fireEvent.pointerDown(ghost(item), { button: 0, pointerId: 1 }));
	return { ...f, toasts, ghost, card, action, open, list: () => screen.getByTestId('proposal-ghost-items') };
}

describe('proposal ghost layer', () => {
	it('draws the ghosts of the proposal with their state, the agent bar and a ghost track header', async () => {
		const t = await setup();
		const hit = t.ghost('hit');
		expect(hit.getAttribute('data-ghost-state')).toBe('pending');
		expect(hit.getAttribute('data-ghost-new-track')).toBe('true');
		expect(hit.style.left).toBe('60px');
		expect(hit.getAttribute('data-ghost-border')).toBe('1px dashed var(--pr-ghost-stroke)');
		expect(hit.getAttribute('data-ghost-agent')).toBe('true');
		expect(hit.style.borderLeft).toContain('var(--pr-agent)');
		expect(hit.style.background).toContain('var(--pr-ghost-fill)');
		expect(document.querySelector('[data-ghost-remove="changed"]')).not.toBeNull();
		const header = document.querySelector('[data-ghost-header]')!;
		expect(header.textContent).toBe(`A${t.seq().audioTracks.length + 1} · SFX 1 (new)`);
		const opts = within(t.list()).getAllByRole('option');
		expect(opts.map((o) => o.getAttribute('data-ghost-option'))).toEqual([
			'trk',
			'move',
			'hit',
			'cue',
			'boom',
		]);
		expect(opts[2]!.getAttribute('aria-label')).toBe(
			'Proposed: Hit on the cut, pending, at 00:00:01:00. Cut from Shot A to Shot B',
		);
	});

	it('a click selects the item and opens its card; Accept / Reject / Alternate / Note act on it', async () => {
		const t = await setup();
		t.open('hit');
		expect(proposalsFor(t.session).getState().selection).toEqual(['hit']);
		expect(t.card().textContent).toContain('Cut from Shot A to Shot B');
		expect(t.card().textContent).toContain('support · Impacts');
		await t.action('accept');
		expect(t.ghost('hit').getAttribute('data-ghost-state')).toBe('accepted');
		expect(t.ghost('hit').querySelector('[data-ghost-glyph]')!.textContent).toBe('✓');
		expect(t.ghost('hit').getAttribute('data-ghost-border')).toBe('2px solid var(--pr-focus-ring)');
		// the Apply footer counts the accepted items (the track comes with the hit)
		expect(t.card().querySelector('[data-ghost-action="apply"]')!.textContent).toBe('Apply 2 of 5');
		await t.action('alternate');
		expect(t.engine.proposals.get(t.p.id)!.items.find((i) => i.id === 'hit')!.selectedAlternative).toBe(1);
		expect(t.card().textContent).toContain('Alternate 2/2');
		await t.action('note');
		fireEvent.change(t.card().querySelector('[data-ghost-note-input]')!, { target: { value: 'softer' } });
		await t.action('save-note');
		expect(t.engine.proposals.get(t.p.id)!.items.find((i) => i.id === 'hit')!.note).toBe('softer');
		t.open('boom');
		await t.action('reject');
		const boom = t.ghost('boom');
		expect(boom.getAttribute('data-ghost-state')).toBe('rejected');
		expect(boom.style.opacity).toBe('0.35');
		expect(boom.style.backgroundImage).toContain('repeating-linear-gradient');
		expect(boom.querySelector('[data-ghost-glyph]')!.textContent).toBe('✕');
		expect(t.engine.proposals.get(t.p.id)!.items.find((i) => i.id === 'boom')!.state).toBe('rejected');
		// nothing was applied by any of it
		expect(t.session.getState().history.entries.map((e) => e.label)).toEqual(['setup']);
	});

	it('Apply needs a trusted click: a synthetic one is refused and nothing changes', async () => {
		const t = await setup();
		t.open('hit');
		await t.action('accept');
		const before = t.session.getCommitted();
		await t.action('apply');
		// WP3.3b: the card's Apply is the review's shared Apply (announced, and a toast of the window)
		expect(reviewAnnouncer.getState().message).toMatch(/^Only you can apply a proposal/);
		expect(t.engine.calls.some((c) => c.startsWith('accept'))).toBe(false);
		expect(t.session.getCommitted()).toBe(before);
	});

	it('keyboard: one tab stop; arrows move in time order, Enter accepts, Delete rejects, U clears, A toggles hearing', async () => {
		const t = await setup();
		const list = t.list();
		act(() => list.focus());
		const key = async (k: string) => {
			await act(async () => {
				fireEvent.keyDown(list, { key: k });
			});
			await settle();
			act(() => t.flush());
		};
		await key('ArrowRight');
		await key('ArrowRight');
		const sel = () => proposalsFor(t.session).getState().selection;
		expect(sel()).toEqual(['hit']);
		expect(list.getAttribute('aria-activedescendant')).toBe('ghost-t1-hit');
		expect(t.ghost('hit').style.outline).toContain('var(--pr-focus-ring)');
		await key('Enter');
		expect(t.ghost('hit').getAttribute('data-ghost-state')).toBe('accepted');
		await key('ArrowRight');
		await key('ArrowRight');
		expect(sel()).toEqual(['boom']);
		await key('Delete');
		expect(t.ghost('boom').getAttribute('data-ghost-state')).toBe('rejected');
		await key('u');
		expect(t.ghost('boom').getAttribute('data-ghost-state')).toBe('pending');
		await key('a');
		expect(proposalsFor(t.session).getState().hear).toBe(true);
		await key('i');
		expect(t.card().getAttribute('data-ghost-card')).toBe('boom');
		await key('End');
		await key('Home');
		expect(sel()).toEqual(['trk']);
	});

	it('high contrast: every ghost 2 px solid, the state told by a glyph (pending ○)', async () => {
		document.documentElement.setAttribute('data-pr-contrast', 'high');
		const t = await setup();
		const hit = t.ghost('hit');
		expect(hit.getAttribute('data-ghost-border')).toBe('2px solid var(--pr-ghost-stroke)');
		expect(hit.querySelector('[data-ghost-glyph]')!.textContent).toBe('○');
		const header = document.querySelector<HTMLElement>('[data-ghost-header]')!;
		expect(header.getAttribute('data-ghost-border')).toBe('2px solid');
	});

	it('nothing animates (reduced motion has nothing to stop)', async () => {
		const t = await setup();
		for (const el of document.querySelectorAll<HTMLElement>('[data-ghost-item]')) {
			expect(el.style.animation).toBe('');
			expect(el.style.transition).toBe('');
			expect(el.className).not.toMatch(/animate-|transition/);
		}
		expect(t.ghost('hit')).toBeTruthy();
	});
});

describe('ghost cues on the Cue Seam', () => {
	it('draws them as ghosts; a click or Enter on one asks for its item, the arrows reach them', async () => {
		const f = await proposalFixture();
		const ghost: SoundCue = {
			id: 'cue_ghost~ghost',
			frame: 80,
			kind: 'land',
			weight: 'hero',
			source: 'agent',
		} as SoundCue;
		const onGhost = vi.fn();
		const onGhostFocus = vi.fn();
		const layout = computeLayout({
			height: 400,
			dividerRatio: 0.5,
			videoTracks: f.seq().videoTracks,
			audioTracks: f.seq().audioTracks,
			heights: {},
			scrollYVideo: 0,
			scrollYAudio: 0,
			dividerPx: SEAM_PX,
		});
		render(
			<SessionProvider session={f.session}>
				<CueSeam
					session={f.session}
					seq={f.seq() as Sequence}
					layout={layout}
					viewport={{ scrollFrame: 0, pxPerFrame: 10, width: 1200 }}
					media={{}}
					ui={createTimelineUiStore()}
					instanceId="s1"
					snapping={false}
					run={() => {}}
					openMenu={() => {}}
					toast={() => {}}
					reveal={() => {}}
					ghosts={[ghost]}
					onGhost={onGhost}
					onGhostFocus={onGhostFocus}
				/>
			</SessionProvider>,
		);
		const lane = screen.getByTestId('cue-seam');
		const glyph = lane.querySelector('[data-cue-id="cue_ghost~ghost"]')!;
		expect(glyph.getAttribute('data-cue-state')).toContain('ghost');
		expect(glyph.getAttribute('aria-label')).toMatch(/^Proposed: Hero Land cue at 00:00:02:20/);
		fireEvent.pointerDown(lane, { clientX: 800, clientY: 9, button: 0, pointerId: 1 });
		expect(onGhost).toHaveBeenCalledWith('cue_ghost~ghost', expect.objectContaining({ y: SEAM_PX }));
		// the real cue at 60 is not touched by the click
		expect(f.session.getState().selection.cues ?? []).toEqual([]);
		act(() => lane.focus());
		fireEvent.keyDown(lane, { key: 'Home' });
		fireEvent.keyDown(lane, { key: 'ArrowRight' });
		expect(onGhostFocus).toHaveBeenCalledWith('cue_ghost~ghost');
		fireEvent.keyDown(lane, { key: 'Enter' });
		expect(onGhost).toHaveBeenCalledTimes(2);
	});
});
