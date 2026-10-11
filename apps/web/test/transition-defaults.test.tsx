import { EngineClient } from '@jasper/engine-client';
import type { Sequence } from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentBridge } from '../src/agent-bridge/bridge.ts';
import { createCommandContext, registerAllCommands, runCommand } from '../src/commands/index.ts';
import {
	endTransitionDrag,
	transitionDragId,
	writeTransitionDragPayload,
} from '../src/panels/effects/drag.ts';
import {
	parseTransitionDefaults,
	resetTransitionDefaults,
	setDefaultTransition,
	transitionDefaults,
	updateTransitionDefaults,
} from '../src/panels/effects/transition-prefs.ts';
import { applyTransitionToClips } from '../src/panels/effects/transitions.ts';
import { PreferencesDialog } from '../src/shell/preferences/index.ts';
import {
	formatStillDuration,
	formatTransitionDuration,
	parseStillDuration,
	parseTransitionDuration,
} from '../src/transitions/durations.ts';
import { TimelinePreferencesPage } from '../src/transitions/TimelinePreferencesPage.tsx';
import { makeSession, setupTimeline, videoAsset } from './timeline-helpers.ts';

beforeAll(() => registerAllCommands());
beforeEach(() => {
	globalThis.localStorage?.clear();
	resetTransitionDefaults();
});
afterEach(() => cleanup());

const R30 = { num: 30, den: 1 };
const R2997 = { num: 30000, den: 1001 };
const R25 = { num: 25, den: 1 };
const R24 = { num: 24, den: 1 };

describe('duration fields (TUI-032)', () => {
	it('frames: whole, ≥ 1, ≤ 60 s at the rate', () => {
		expect(parseTransitionDuration('30', 'frames', R30)).toEqual({ ok: true, value: 30, note: null });
		expect(parseTransitionDuration(' 12 ', 'frames', R25)).toMatchObject({ ok: true, value: 12 });
		expect(parseTransitionDuration('12.5', 'frames', R25)).toMatchObject({ ok: false });
		expect(parseTransitionDuration('0', 'frames', R25)).toMatchObject({ ok: false });
		expect(parseTransitionDuration('', 'frames', R25)).toMatchObject({ ok: false });
		expect(parseTransitionDuration('-3', 'frames', R25)).toMatchObject({ ok: false });
		expect(parseTransitionDuration('abc', 'frames', R25)).toMatchObject({ ok: false });
		expect(parseTransitionDuration('1500', 'frames', R25)).toMatchObject({ ok: true, value: 1500 });
		expect(parseTransitionDuration('1501', 'frames', R25)).toMatchObject({ ok: false });
	});

	it('seconds: converted at the sequence rate, rounded to whole frames with a note', () => {
		expect(parseTransitionDuration('1', 'seconds', R25)).toEqual({ ok: true, value: 25, note: null });
		expect(parseTransitionDuration('0,5', 'seconds', R24)).toEqual({ ok: true, value: 12, note: null });
		// 0.5 s at 29.97 = 14.985 frames → 15, and the field says so.
		expect(parseTransitionDuration('0.5', 'seconds', R2997)).toEqual({
			ok: true,
			value: 15,
			note: expect.any(String),
		});
		expect(parseTransitionDuration('0.01', 'seconds', R25)).toMatchObject({ ok: false });
		expect(parseTransitionDuration('61', 'seconds', R25)).toMatchObject({ ok: false });
	});

	it('formats duration values at the sequence rate', () => {
		expect(formatTransitionDuration(30, 'frames', R2997)).toBe('30');
		expect(formatTransitionDuration(30, 'seconds', R2997)).toBe('1.001');
		expect(formatTransitionDuration(25, 'seconds', R25)).toBe('1.00');
		expect(formatTransitionDuration(12, 'seconds', R24)).toBe('0.50');
	});

	it('stills are kept in 1/30 s and rescaled to the sequence rate like clip.place', () => {
		expect(formatStillDuration(150, 'seconds', R25)).toBe('5.00');
		expect(formatStillDuration(150, 'frames', R25)).toBe('125');
		expect(parseStillDuration('4', 'seconds', R25)).toEqual({ ok: true, value: 120, note: null });
		expect(parseStillDuration('100', 'frames', R25)).toEqual({ ok: true, value: 120, note: null });
		// 101 frames at 60 fps cannot be kept exactly in 1/30 s.
		expect(parseStillDuration('101', 'frames', { num: 60, den: 1 })).toMatchObject({
			ok: true,
			value: 51,
			note: expect.any(String),
		});
		expect(parseStillDuration('0.01', 'seconds', R25)).toMatchObject({ ok: false });
		expect(parseStillDuration('2.01', 'seconds', R25)).toMatchObject({ ok: true, value: 60 });
	});
});

describe('preference store (TUI-031/033)', () => {
	it('reads v1 values, fills the new fields and drops wrong-medium ids', () => {
		expect(
			parseTransitionDefaults({ version: 1, video: 'jasper.dip-to-black', audio: 'jasper.constant-gain' }),
		).toEqual({
			version: 2,
			video: 'jasper.dip-to-black',
			audio: 'jasper.constant-gain',
			alignment: 'center',
			units: { video: 'frames', audio: 'seconds', still: 'seconds' },
		});
		expect(
			parseTransitionDefaults({
				video: 'jasper.constant-power',
				audio: 'nope',
				alignment: 'middle',
				units: { video: 'seconds', audio: 'parsecs' },
			}),
		).toEqual({
			version: 2,
			video: 'jasper.cross-dissolve',
			audio: 'jasper.constant-power',
			alignment: 'center',
			units: { video: 'seconds', audio: 'seconds', still: 'seconds' },
		});
	});

	it('persists the default type and alignment to localStorage', () => {
		setDefaultTransition('jasper.dip-to-black');
		updateTransitionDefaults({ alignment: 'end-at-cut' });
		const stored = JSON.parse(globalThis.localStorage.getItem('jasper.transitions.defaults.v1')!);
		expect(stored).toMatchObject({ version: 2, video: 'jasper.dip-to-black', alignment: 'end-at-cut' });
	});
});

/** Two adjacent clips with linked audio, cut at frame 120, handles on both sides. */
function cut(t: ReturnType<typeof setupTimeline>) {
	const reg = () =>
		(t.apply([{ type: 'media.register', asset: videoAsset(20) }]).results[0] as { mediaId: string }).mediaId;
	const a = reg();
	const b = reg();
	const r = t.apply([
		{
			type: 'clip.place',
			source: { mediaId: a },
			at: 0,
			sourceRange: { in: { seconds: 2 }, out: { seconds: 6 } },
		},
		{
			type: 'clip.place',
			source: { mediaId: b },
			at: 120,
			sourceRange: { in: { seconds: 2 }, out: { seconds: 6 } },
		},
	]);
	const [va, aa] = (r.results[0] as { clipIds: string[] }).clipIds as [string, string];
	const [vb, ab] = (r.results[1] as { clipIds: string[] }).clipIds as [string, string];
	return { va, aa, vb, ab };
}

describe('the defaults are applied immediately (TUI-030…033)', () => {
	const ctxOf = (t: ReturnType<typeof setupTimeline>) =>
		createCommandContext({ engine: new EngineClient({ baseUrl: '' }), session: t.session });
	const twoSided = (t: ReturnType<typeof setupTimeline>) =>
		Object.values((t.seq() as Sequence).transitions).filter((x) => x.outgoingClipId && x.incomingClipId);

	it('Shift+D uses each medium’s own duration and the user alignment', async () => {
		const t = setupTimeline();
		const { va, vb } = cut(t);
		t.apply([
			{
				type: 'project.updateSettings',
				settings: { defaultTransitionFrames: 20, defaultAudioTransitionFrames: 10 },
			},
		]);
		updateTransitionDefaults({ audio: 'jasper.constant-gain', alignment: 'end-at-cut' });
		t.session.select('timeline', [va, vb], 'replace');
		await runCommand('timeline.applyDefaultTransitionsToSelection', ctxOf(t));
		const seq = t.seq() as Sequence;
		const all = Object.values(seq.transitions);
		const isVideo = (trackId: string) => seq.videoTracks.some((v) => v.id === trackId);
		expect(all).toHaveLength(6);
		for (const x of all) {
			expect(x.duration).toBe(isVideo(x.trackId) ? 20 : 10);
			if (!isVideo(x.trackId)) expect(x.effectId).toBe('jasper.constant-gain');
		}
		expect(twoSided(t).every((x) => x.alignment === 'end-at-cut')).toBe(true);
	});

	it('Effects ▸ Apply to Selected Clips uses the user’s alignment too', () => {
		const t = setupTimeline();
		const { va, vb } = cut(t);
		updateTransitionDefaults({ alignment: 'end-at-cut' });
		expect(applyTransitionToClips(t.session, 'jasper.cross-dissolve', [va, vb])).toEqual({
			ok: true,
			count: 3,
		});
		expect(twoSided(t)[0]).toMatchObject({ alignment: 'end-at-cut' });
	});
});

describe('Preferences ▸ Timeline page', () => {
	function page() {
		const { session } = makeSession({ preset: 'hd-1080p-29.97' });
		const history = () => session.getState().history.entries;
		render(
			<SessionProvider session={session}>
				<TimelinePreferencesPage />
			</SessionProvider>,
		);
		return { session, history };
	}
	const field = (id: string) => screen.getByTestId(id) as HTMLInputElement;
	const enter = (id: string, text: string) => {
		const el = field(id);
		fireEvent.focus(el);
		fireEvent.change(el, { target: { value: text } });
		fireEvent.keyDown(el, { key: 'Enter' });
	};

	it('a duration change is one History step; undo restores the field; the audio length is pinned', () => {
		const { session, history } = page();
		enter('pref-video-duration', '20');
		expect(history()).toHaveLength(1);
		expect(session.getCommitted().settings).toMatchObject({
			defaultTransitionFrames: 20,
			defaultAudioTransitionFrames: 30,
		});
		expect(field('pref-audio-duration').value).toBe('1.001');
		act(() => void session.undo());
		expect(field('pref-video-duration').value).toBe('30');
		expect(session.getCommitted().settings.defaultAudioTransitionFrames).toBeUndefined();
	});

	it('seconds round to frames; invalid text is marked invalid and commits nothing', () => {
		const { session, history } = page();
		enter('pref-audio-duration', '0.5');
		expect(session.getCommitted().settings.defaultAudioTransitionFrames).toBe(15);
		enter('pref-video-duration', '12.5');
		expect(field('pref-video-duration').getAttribute('aria-invalid')).toBe('true');
		fireEvent.blur(field('pref-video-duration'));
		expect(history()).toHaveLength(1);
		fireEvent.keyDown(field('pref-video-duration'), { key: 'Escape' });
		expect(field('pref-video-duration').value).toBe('30');
		enter('pref-still-duration', '3');
		expect(session.getCommitted().settings.defaultStillDurationFrames).toBe(90);
		expect(history()).toHaveLength(2);
	});

	it('preference changes (type, alignment, unit) apply immediately and are not in History', () => {
		const { history } = page();
		act(() => {
			setDefaultTransition('jasper.dip-to-black');
			updateTransitionDefaults({
				alignment: 'end-at-cut',
				units: { video: 'seconds', audio: 'frames', still: 'frames' },
			});
		});
		expect(field('pref-video-duration').value).toBe('1.001');
		expect(field('pref-audio-duration').value).toBe('30');
		expect(field('pref-still-duration').value).toBe('150');
		fireEvent.click(screen.getByTestId('prefs-transitions-reset'));
		expect(transitionDefaults().getState()).toMatchObject({
			video: 'jasper.cross-dissolve',
			alignment: 'center',
		});
		expect(history()).toHaveLength(0);
	});
});

describe('Esc in the Preferences dialog', () => {
	it('the first Esc reverts the edited duration and keeps the dialog open; the next one closes it', () => {
		const { session } = makeSession({ preset: 'hd-1080p-29.97' });
		const close = vi.fn();
		render(<PreferencesDialog page="timeline" session={session} close={close} />);
		const el = screen.getByTestId('pref-video-duration') as HTMLInputElement;
		fireEvent.focus(el);
		fireEvent.change(el, { target: { value: '15' } });
		fireEvent.keyDown(el, { key: 'Escape' });
		expect(close).not.toHaveBeenCalled();
		expect(el.value).toBe('30');
		expect(session.getState().history.entries).toEqual([]);
		fireEvent.keyDown(el, { key: 'Escape' });
		expect(close).toHaveBeenCalled();
		expect(session.getCommitted().settings.defaultTransitionFrames).toBe(30);
	});
});

describe('agents and drag (TUI-034, TUI-021)', () => {
	it('the bridge answers preferences.get with the user’s default transitions', async () => {
		const { session } = makeSession();
		const bridge = new AgentBridge(session, null, {}).start();
		try {
			updateTransitionDefaults({ video: 'jasper.dip-to-black', alignment: 'start-at-cut' });
			expect(await bridge.api().query('preferences.get')).toEqual({
				preferences: {
					transitions: {
						video: 'jasper.dip-to-black',
						audio: 'jasper.constant-power',
						alignment: 'start-at-cut',
					},
					timeline: { insertSequencesAsNests: true, showThroughEdits: true },
				},
			});
		} finally {
			bridge.dispose();
		}
	});

	it('the dragged transition id is readable from the types during dragover (another window)', () => {
		const data = new Map<string, string>();
		const dt = {
			setData: (k: string, v: string) => data.set(k, v),
			getData: (k: string) => data.get(k) ?? '',
			get types() {
				return [...data.keys()];
			},
			effectAllowed: 'none',
		} as unknown as DataTransfer;
		writeTransitionDragPayload(dt, 'jasper.dip-to-black');
		// Another window: no in-memory drag, only the types.
		const other = { types: [...data.keys()] } as unknown as DataTransfer;
		endTransitionDrag();
		expect(transitionDragId(other)).toBe('jasper.dip-to-black');
		expect(transitionDragId({ types: ['text/plain'] } as unknown as DataTransfer)).toBeNull();
	});
});
