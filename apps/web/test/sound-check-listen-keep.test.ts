// Phase 5 verification, follow-up (b): Play all (the Sound Check's listen-here windows through `playTimelineWindow`) keeps
// playing while the listener uses the verdict controls — Sounds right, Flag, the note field — and stops on any other key
// or click (the In Context rule), including Escape in the note field and the row's own ▶ / Play all buttons.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keepsListening, LISTEN_KEEP_ATTR } from '../src/sound/check-run.ts';
import { inContextStore, playTimelineWindow, stopInContext } from '../src/sound/in-context.ts';
import { makeSession } from './timeline-helpers.ts';

const tick = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));

function dom() {
	document.body.innerHTML = `
		<section>
			<button data-testid="play">▶</button>
			<span ${LISTEN_KEEP_ATTR}>
				<button data-testid="ok">Sounds right</button>
				<button data-testid="flag">Flag</button>
			</span>
			<div ${LISTEN_KEEP_ATTR}><input data-testid="note" /></div>
		</section>`;
	const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
	return { play: q('play'), ok: q('ok'), flag: q('flag'), note: q('note') };
}

afterEach(() => {
	stopInContext({ returnToAnchor: false });
	document.body.innerHTML = '';
	vi.useRealTimers();
});

describe('listen-here windows keep playing on the verdict controls', () => {
	it('playTimelineWindow with keepPlayingOn: a click on a verdict button does not stop it, a click elsewhere does', async () => {
		const el = dom();
		const { session } = makeSession();
		const ends: string[] = [];
		const play = () =>
			playTimelineWindow(session, session.getCommitted().sequences[session.getState().activeSequenceId!]!, {
				center: 60,
				returnTo: 0,
				title: 'Listen here',
				before: 2,
				after: 2,
				keepPlayingOn: keepsListening,
				onEnd: (how) => ends.push(how),
			});
		play();
		await tick(); // the window listens for input from the next task
		expect(inContextStore.getState().active).toBe(true);
		el.ok.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
		el.note.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', code: 'KeyX', bubbles: true }));
		for (const [key, code] of [
			['Enter', 'Enter'],
			[' ', 'Space'],
			['Tab', 'Tab'],
		])
			el.ok.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true }));
		await tick();
		expect(inContextStore.getState().active).toBe(true);
		expect(ends).toEqual([]);
		el.play.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
		await tick();
		expect(inContextStore.getState().active).toBe(false);
		expect(ends).toEqual(['stopped']);
		// Escape in the note field and ordinary shortcuts on verdict buttons must still stop playback.
		for (const [target, key, code] of [
			[el.note, 'Escape', 'Escape'],
			[el.ok, 'j', 'KeyJ'],
		] as const) {
			play();
			await tick();
			target.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true }));
			await tick();
			expect(inContextStore.getState().active).toBe(false);
		}
		expect(ends).toEqual(['stopped', 'stopped', 'stopped']);
	});

	it('without keepPlayingOn any click stops it (the In Context rule is unchanged)', async () => {
		const el = dom();
		const { session } = makeSession();
		const ends: string[] = [];
		playTimelineWindow(session, session.getCommitted().sequences[session.getState().activeSequenceId!]!, {
			center: 60,
			returnTo: 0,
			title: 'Listen here',
			onEnd: (how) => ends.push(how),
		});
		await tick();
		el.ok.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
		await tick();
		expect(ends).toEqual(['stopped']);
	});
});
