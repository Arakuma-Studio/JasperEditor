// WP5.2 Sound Check panel on a real session with a fake engine (spec 12 §2.7 "Sound Check panel", P5-R3): Run (the job,
// progress, the stored summary, the verdict announced), the summary chips and the stale badge with Re-run, findings by
// category with severity shape + word, timecode jump (playhead + selection), translated messages, a single Fix (one
// History entry), Fix all safe (commands + a sound swap in ONE transaction, the ducking job after it, the check again),
// the keyboard in the findings list, the sync strip (5 frames + waveform with the picture and measured lines), the
// listen-here verdicts as user comment markers (read back by `soundCheckHumanVerdicts`, what MCP returns), Play all,
// "Use as sequence target" (preset / custom), the Export dialog's check (pass goes on; fail prompts Export anyway /
// Review issues) and the menu entry.
import type {
	EngineJob,
	SoundCheckRequest,
	SoundDeliveryRequest,
	SoundVisualRequest,
	StillRequest,
} from '@jasper/api';
import {
	mixFingerprint,
	type Sequence,
	SOUND_CHECK_VERDICT_MARKER,
	soundCheckHumanVerdicts,
	soundCheckInputsHash,
	soundCheckStatus,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { closeAllDialogs, DialogHost, toasts } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resultFixture } from '../../mcp/test/sound-check-report-fixture.ts';
import { createCommandContext } from '../src/commands/context.ts';
import { getActiveKeymap } from '../src/commands/keymap-defaults.ts';
import { getCommand, runCommand } from '../src/commands/registry.ts';
import { useExportSoundCheck } from '../src/export/SoundCheckGate.tsx';
import { SoundCheckPanel } from '../src/panels/soundCheck/SoundCheckPanel.tsx';
import { shortcutRows } from '../src/shell/keymap/KeyboardShortcutsDialog.tsx';
import { assignShortcut, restoreBindings } from '../src/shell/keymap/store.ts';
import { MENUBAR } from '../src/shell/menus/model.ts';
import { soundCheckStore } from '../src/sound/check-run.ts';
import { cuesOf } from '../src/sound/cues/model.ts';
import { audioAsset } from './proposal-helpers.ts';
import { registered, soundEntry } from './sound-helpers.ts';
import { makeSession } from './timeline-helpers.ts';

const mocks = vi.hoisted(() => ({
	client: null as unknown,
	windows: [] as {
		center: number;
		before?: number;
		after?: number;
		onEnd?: (how: 'window' | 'stopped') => void;
		keepPlayingOn?: (e: Event) => boolean;
	}[],
}));
vi.mock('../src/state/engine.tsx', () => ({
	useEngine: () => ({
		client: mocks.client,
		status: 'connected',
		subscribe: () => () => {},
		capabilities: null,
	}),
	useEngineOrNull: () => ({ client: mocks.client, status: 'connected', subscribe: () => () => {} }),
	useCapabilities: () => ({ capabilities: null, flags: new Set(['engine']) }),
	createEditorEngineClient: () => mocks.client,
}));
// the Program transport is not playing in jsdom: the listen windows are recorded and ended by the test
vi.mock('../src/sound/in-context.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return {
		...real,
		playTimelineWindow: (_s: unknown, _q: unknown, o: (typeof mocks.windows)[number]) => {
			mocks.windows.push(o);
		},
	};
});
const { registerAllCommands } = await import('../src/commands/index.ts');

beforeAll(() => registerAllCommands());
beforeEach(() => {
	toasts.dismissAll();
	mocks.windows.length = 0;
});
afterEach(() => {
	cleanup();
	closeAllDialogs();
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const SND_B1 = 'snd_00000000000000b1';

/** Music on A1; a hit filling a cut cue at 90 on A2 (clip A); a click at 150 on A3 (clip B). */
function fixture() {
	const { session, seqId } = makeSession();
	const ok = (commands: unknown[], label = 'setup') => {
		const r = session.apply({ label, origin: 'user', sequenceId: seqId, commands: commands as never[] });
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		return r;
	};
	const reg = ok([
		{ type: 'media.register', asset: audioAsset(10), ref: '$music' },
		{ type: 'media.register', asset: audioAsset(1), ref: '$hit' },
		{ type: 'media.register', asset: audioAsset(1), ref: '$click' },
		{ type: 'clip.place', source: { mediaId: '$music' }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
		{ type: 'essentialSound.setType', clipIds: ['$m'], audioType: 'music' },
		{
			type: 'soundCue.add',
			cues: [
				{ frame: 90, kind: 'cut', weight: 'hero', source: 'user' },
				{ frame: 150, kind: 'cut', weight: 'support', source: 'user' },
			],
		},
	]);
	const seq = () => session.getCommitted().sequences[seqId] as Sequence;
	const [cueA, cueB] = cuesOf(seq()).map((c) => c.id) as [string, string];
	ok([
		{
			type: 'soundDesign.place',
			cueId: cueA,
			layers: [{ mediaId: reg.refs.$hit!, track: 'A2', align: 'start' }],
		},
		{
			type: 'soundDesign.place',
			cueId: cueB,
			layers: [{ mediaId: reg.refs.$click!, track: 'A3', align: 'start' }],
		},
	]);
	const onTrack = (n: number) =>
		Object.values(seq().clips).find((c) => c.trackId === seq().audioTracks[n]!.id)!.id;
	const clipA = onTrack(1);
	const clipB = onTrack(2);
	const engine = fakeCheckEngine(session, seqId, { clipA, clipB, cueA });
	mocks.client = engine.client;
	const labels = () => session.getState().history.entries.map((e) => e.label);
	return { session, seqId, ok, seq, cueA, clipA, clipB, engine, labels };
}

/** The engine's check job: it stores the summary in the session (the engine relays it as the user's edit). */
function fakeCheckEngine(
	session: EditorSession,
	seqId: string,
	ids: { clipA: string; clipB: string; cueA: string },
) {
	const checks: SoundCheckRequest[] = [];
	const deliveries: SoundDeliveryRequest[] = [];
	const registers: string[] = [];
	const stills: StillRequest[] = [];
	const visuals: SoundVisualRequest[] = [];
	const cancelled: string[] = [];
	let without: Parameters<typeof resultFixture>[0]['without'] = [];
	const jobs = new Map<string, () => unknown>();
	let n = 0;
	let gate: Promise<void> | null = null;
	let open: (() => void) | null = null;
	const job = (id: string, state: EngineJob['state'], extra: Partial<EngineJob> = {}): EngineJob => ({
		id,
		kind: 'sound-check',
		title: 'Sound Check',
		origin: { type: 'user' },
		projectId: session.projectId,
		state,
		progress: state === 'succeeded' ? 1 : 0.4,
		stage: state === 'running' ? 'Measuring the mix' : undefined,
		createdAt: '2026-10-17T10:00:00.000Z',
		priority: 'interactive',
		cpuSlots: 1,
		...extra,
	});
	const start = (run: () => unknown, kind = 'sound-check') => {
		const id = `job_${++n}`;
		jobs.set(id, run);
		return job(id, 'running', { kind: kind as never });
	};
	const client = {
		async soundCheck(req: SoundCheckRequest) {
			checks.push(req);
			return start(() => {
				const doc = session.getCommitted();
				const mixHash = mixFingerprint(doc, seqId);
				const inputsHash = soundCheckInputsHash(doc, seqId, req.preset ?? 'web', req.target);
				const result = resultFixture({
					projectId: session.projectId,
					sequenceId: seqId,
					...ids,
					mixHash,
					inputsHash,
					without,
					stored: !!req.store,
				});
				if (req.store) {
					const r = session.apply({
						label: 'Sound Check Result',
						origin: 'user',
						sequenceId: seqId,
						commands: [
							{
								type: 'soundDesign.setCheck',
								summary: {
									mixHash,
									inputsHash,
									verdict: result.report.verdict,
									counts: result.report.counts,
									at: '2026-10-17T10:00:00.000Z',
									preset: req.preset ?? 'web',
									...(req.target ? { target: req.target } : {}),
									jobId: `job_${n}`,
								},
							} as never,
						],
					});
					if (!r.ok) throw new Error(JSON.stringify(r.errors));
				}
				return result;
			});
		},
		async applyDelivery(req: SoundDeliveryRequest) {
			deliveries.push(req);
			return start(
				() => ({
					projectId: session.projectId,
					sequenceId: seqId,
					mode: 'apply',
					applied: true,
					revision: session.revision,
					proposalId: null,
					report: {
						version: 1,
						sequenceId: seqId,
						delivery: 'web',
						preset: { label: 'Web', integratedLufs: -14, truePeakDb: -1, source: 'x' },
						hasDialogue: true,
						clips: [],
						ducking: [{ clipIds: ['c'], triggers: ['d'], regions: 1 }],
						sfx: null,
						measure: null,
						warnings: [],
						ms: 1,
					},
				}),
				'sound-design',
			);
		},
		async rebalanceSfx() {
			throw new Error('not expected');
		},
		async registerSound(soundId: string) {
			registers.push(soundId);
			return registered(soundEntry({ id: soundId, title: 'Click (padded)' }));
		},
		async requestStill(req: StillRequest) {
			stills.push(req);
			return start(() => ({ url: `/api/jobs/still/${req.frame}.jpg` }), 'still');
		},
		async soundVisual(req: SoundVisualRequest) {
			visuals.push(req);
			const points = Math.round(((req.range.end - req.range.start) / 30) * 100);
			return {
				waveformPeakDb: Array.from({ length: points }, (_, i) => (i === 30 ? -3 : -40)),
				// the sound effects stem (the hit) over the bed (the music)
				stemPeakDb: {
					sfx: Array.from({ length: points }, (_, i) => (i === 30 ? -3 : -120)),
					bed: Array.from({ length: points }, () => -40),
				},
				range: req.range,
			};
		},
		url: (p: string) => `http://engine.test${p}`,
		async getJob(id: string) {
			if (gate) await gate;
			const run = jobs.get(id);
			if (!run) throw Object.assign(new Error('no job'), { code: 'JOB_NOT_FOUND' });
			jobs.delete(id);
			return job(id, 'succeeded', { result: run() });
		},
		async cancelJob(id: string) {
			cancelled.push(id);
			jobs.delete(id);
			return job(id, 'cancelled');
		},
	};
	return {
		client,
		checks,
		deliveries,
		registers,
		stills,
		visuals,
		cancelled,
		/** The next checks leave out these codes (the fixes worked). */
		fixedCodes(codes: NonNullable<typeof without>) {
			without = codes;
		},
		/** Hold the next poll until released (a run in progress). */
		holdPolls() {
			gate = new Promise<void>((r) => {
				open = r;
			});
			return {
				release: () => {
					const o = open;
					gate = null;
					open = null;
					o?.();
				},
			};
		},
	};
}

function mount(f: ReturnType<typeof fixture>) {
	const view = () => (
		<SessionProvider session={f.session}>
			<SoundCheckPanel instanceId="sc1" visible />
		</SessionProvider>
	);
	return render(view());
}

async function run() {
	await act(async () => {
		fireEvent.click(screen.getByTestId('sound-check-run'));
	});
	await waitFor(() => expect(screen.getByTestId('sound-check-verdict')).toBeTruthy(), { timeout: 5000 });
	await settle();
}

const rowOf = (code: string) => document.querySelector(`[data-code="${code}"]`) as HTMLElement;

describe('Sound Check panel', () => {
	it('runs the check (progress, stored summary), shows the chips, the findings by category and the listen-here moments', async () => {
		const f = fixture();
		mount(f);
		expect(screen.getByTestId('sound-check-panel').textContent).toContain('Sound Check measures the mix');
		const held = f.engine.holdPolls();
		await act(async () => {
			fireEvent.click(screen.getByTestId('sound-check-run'));
		});
		await waitFor(() =>
			expect(screen.getByTestId('sound-check-progress').textContent).toContain('Measuring the mix'),
		);
		expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40');
		expect(screen.getByTestId('sound-check-cancel')).toBeTruthy();
		held.release();
		await waitFor(() =>
			expect(screen.getByTestId('sound-check-verdict').getAttribute('data-verdict')).toBe('fail'),
		);
		// the request: the sequence's preset, stored as the user's edit
		expect(f.engine.checks[0]).toMatchObject({
			projectId: f.session.projectId,
			sequenceId: f.seqId,
			preset: 'web',
			store: true,
		});
		expect(f.labels().at(-1)).toBe('Sound Check Result');
		expect(soundCheckStatus(f.session.getCommitted(), f.seqId).state).toBe('current');
		expect(screen.queryByTestId('sound-check-stale')).toBeNull();
		// chips
		expect(screen.getByTestId('sound-check-chip-integrated').textContent).toContain('−17.2 LUFS');
		expect(screen.getByTestId('sound-check-chip-truePeak').textContent).toContain('−2.1 dBTP');
		expect(screen.getByTestId('sound-check-chip-lra').textContent).toContain('6.3 LU');
		expect(screen.getByTestId('sound-check-chip-errors').textContent).toContain('1');
		expect(screen.getByTestId('sound-check-chip-warnings').textContent).toContain('4');
		expect(screen.getByTestId('sound-check-verdict').textContent).toBe('Fail');
		// categories in order, severity in words, the translated message, the timecode
		const groups = [...document.querySelectorAll('[data-category]')].map((g) =>
			g.getAttribute('data-category'),
		);
		expect(groups).toEqual(['sync', 'loudness', 'mix']);
		const sync = rowOf('OUT_OF_SYNC');
		expect(sync.getAttribute('aria-label')).toBe(
			'Error. 00:00:03:00. Impact plays 66.7 ms late on its cut cue at 00:00:03:00 (tolerance ±1 frames). safe fix: Align its peak to the cue. sync strip: press the right arrow',
		);
		expect(within(sync).getByTestId('sound-check-timecode').textContent).toBe('00:00:03:00');
		expect(within(sync).getByText('Error')).toBeTruthy();
		// a finding without a timecode is about the whole mix
		expect(within(rowOf('LOUDNESS')).getByText('whole mix')).toBeTruthy();
		// unsafe fixes say so
		expect(within(rowOf('SILENCE')).getByTestId('sound-check-fix').textContent).toBe('Fix…');
		expect(within(rowOf('SILENCE')).getByText(/needs your judgement/)).toBeTruthy();
		// listen-here rows and the announcement
		const rows = screen.getAllByTestId('sound-check-listen-row');
		expect(rows.map((r) => r.getAttribute('data-slot'))).toEqual([
			'worst',
			'hero',
			'loudest',
			'densest',
			'passing',
		]);
		expect(rows[1]!.textContent).toContain('Biggest hero: Impact (-9.5 LUFS momentary)');
		expect(screen.getByTestId('sound-check-live').textContent).toContain(
			'Sound Check Fail: 1 error, 4 warnings',
		);
	});

	it('cancel stops the job; a run that fails says why', async () => {
		const f = fixture();
		mount(f);
		const held = f.engine.holdPolls();
		await act(async () => {
			fireEvent.click(screen.getByTestId('sound-check-run'));
		});
		await waitFor(() => screen.getByTestId('sound-check-cancel'));
		await act(async () => {
			fireEvent.click(screen.getByTestId('sound-check-cancel'));
		});
		held.release();
		await waitFor(() => expect(f.engine.cancelled).toContain('job_1'));
		await waitFor(() =>
			expect(screen.getByTestId('sound-check-live').textContent).toContain('Sound Check cancelled'),
		);
		expect(screen.queryByTestId('sound-check-verdict')).toBeNull();
		expect(f.labels()).not.toContain('Sound Check Result');
	});

	it('is stale after the mix changes (Re-run runs it again); a stored summary without its job shows its chips', async () => {
		const f = fixture();
		const view = mount(f);
		await run();
		await act(async () => {
			f.ok([{ type: 'audio.setGain', clipIds: [f.clipA], mode: 'adjust', db: -3 }], 'Gain');
		});
		const stale = await screen.findByTestId('sound-check-stale');
		expect(stale.textContent).toContain('Stale: the mix changed since this check');
		await act(async () => {
			fireEvent.click(screen.getByTestId('sound-check-rerun'));
		});
		await waitFor(() => expect(f.engine.checks).toHaveLength(2));
		await waitFor(() => expect(screen.queryByTestId('sound-check-stale')).toBeNull());
		// another window opens the project: no report in its store, the engine forgot the job → the summary's chips
		view.unmount();
		soundCheckStore(f.session).setState({ result: null, jobId: null });
		mount(f);
		await settle();
		expect(screen.getByTestId('sound-check-verdict').getAttribute('data-verdict')).toBe('fail');
		expect(screen.getByTestId('sound-check-chip-errors').textContent).toContain('1');
		expect(screen.getByTestId('sound-check-panel').textContent).toContain(
			'Run the check to see its findings',
		);
	});

	it('a timecode jumps the playhead and selects the clip; the keyboard moves, jumps, fixes and opens the sync strip', async () => {
		const f = fixture();
		mount(f);
		await run();
		await act(async () => {
			fireEvent.click(within(rowOf('OUT_OF_SYNC')).getByTestId('sound-check-timecode'));
		});
		expect(f.session.transport.getState().frame).toBe(90);
		expect(f.session.getState().selection.timeline.clips).toEqual([f.clipA]);
		const list = screen.getByTestId('sound-check-findings');
		// the list's keys are the Sound Check scope's commands: resolved by the key's code, as the keymap does
		const CODE: Record<string, string> = { f: 'KeyF', ' ': 'Space' };
		const key = async (k: string) => {
			await act(async () => {
				fireEvent.keyDown(list, { key: k, code: CODE[k] ?? k });
			});
			await settle();
		};
		await act(async () => {
			fireEvent.focus(list);
		});
		expect(list.getAttribute('aria-activedescendant')).toBe(`sound-check-sc1-OUT_OF_SYNC:${f.clipA}`);
		await key('ArrowDown');
		expect(rowOf('TRUNCATED').getAttribute('aria-selected')).toBe('true');
		await key('Enter');
		expect(f.session.transport.getState().frame).toBe(150);
		expect(f.session.getState().selection.timeline.clips).toEqual([f.clipB]);
		// → opens the sync strip: 5 stills around 150 and the waveform with both lines
		await key('ArrowRight');
		const strip = await screen.findByTestId('sound-check-sync-strip');
		expect(strip.getAttribute('data-cue-frame')).toBe('150');
		await waitFor(() => expect(within(strip).getAllByTestId('sound-check-thumb')).toHaveLength(5), {
			timeout: 5000,
		});
		expect(f.engine.stills.map((s) => s.frame)).toEqual([148, 149, 150, 151, 152]);
		expect(f.engine.visuals[0]).toMatchObject({ sequenceId: f.seqId, range: { start: 141, end: 160 } });
		expect(within(strip).getByTestId('sound-check-event-line')).toBeTruthy();
		// the sound-effects stem is drawn over the bed (not the mix), with a legend
		await waitFor(() => expect(within(strip).getByTestId('sound-check-wave-sfx')).toBeTruthy());
		expect(within(strip).getByTestId('sound-check-wave-bed')).toBeTruthy();
		expect(within(strip).queryByTestId('sound-check-wave-path')).toBeNull();
		expect(within(strip).getByTestId('sound-check-wave-legend').textContent).toContain('Sound effects');
		// TRUNCATED has no offset: no measured line; the summary says so
		expect(within(strip).queryByTestId('sound-check-peak-line')).toBeNull();
		await key('ArrowLeft');
		expect(screen.queryByTestId('sound-check-sync-strip')).toBeNull();
		// the late hit's strip has both lines, the sound 2 frames after the picture
		await key('Home');
		await key('ArrowRight');
		const s2 = await screen.findByTestId('sound-check-sync-strip');
		const ev = Number(within(s2).getByTestId('sound-check-event-line').getAttribute('x1'));
		const pk = Number(within(s2).getByTestId('sound-check-peak-line').getAttribute('x1'));
		expect(pk).toBeGreaterThan(ev);
		expect(within(s2).getByRole('img').getAttribute('aria-label')).toBe(
			'Picture event at 00:00:03:00; sound measured 66.7 ms late (2.0 frames)',
		);
		// F fixes the current finding
		const before = f.seq().clips[f.clipA]!.start;
		await key('f');
		await waitFor(() => expect(f.labels().at(-1)).toBe('Sound Check Fix: Align its peak to the cue'));
		expect(f.seq().clips[f.clipA]!.start).toBe(before - 2);
	});

	it('the findings list keys are Sound Check commands: listed in Keyboard Shortcuts and remappable', async () => {
		const rows = shortcutRows(getActiveKeymap()).filter((r) => r.scope === 'soundCheck');
		const keysOf = (id: string) => rows.find((r) => r.id === id)?.bindings.map((b) => b.key) ?? [];
		expect(keysOf('soundCheck.nextFinding')).toEqual(['ArrowDown']);
		expect(keysOf('soundCheck.prevFinding')).toEqual(['ArrowUp']);
		expect(keysOf('soundCheck.firstFinding')).toEqual(['Home']);
		expect(keysOf('soundCheck.lastFinding')).toEqual(['End']);
		expect(keysOf('soundCheck.goToFinding')).toEqual(['Enter', 'NumpadEnter']);
		expect(keysOf('soundCheck.fixFinding')).toEqual(['KeyF']);
		expect(keysOf('soundCheck.openSyncStrip')).toEqual(['ArrowRight']);
		expect(keysOf('soundCheck.closeSyncStrip')).toEqual(['ArrowLeft']);
		expect(keysOf('soundCheck.playFinding')).toEqual(['Space']);
		expect(rows.find((r) => r.id === 'soundCheck.fixFinding')?.label).toBe('Fix Sound Check Finding');
		// remap Fix to X: X fixes the current finding, F no longer does
		const f = fixture();
		mount(f);
		await run();
		const previous = getActiveKeymap();
		try {
			// (the Keyboard Shortcuts dialog's change of a key: the F binding replaced by X)
			const fKey = previous.find((b) => b.command === 'soundCheck.fixFinding' && b.key === 'KeyF');
			assignShortcut('soundCheck.fixFinding', 'soundCheck', 'KeyX', 'linux', 'web', fKey);
			const list = screen.getByTestId('sound-check-findings');
			await act(async () => {
				fireEvent.focus(list);
			});
			const n = f.labels().length;
			await act(async () => {
				fireEvent.keyDown(list, { key: 'f', code: 'KeyF' });
			});
			await settle();
			expect(f.labels()).toHaveLength(n);
			await act(async () => {
				fireEvent.keyDown(list, { key: 'x', code: 'KeyX' });
			});
			await waitFor(() => expect(f.labels().at(-1)).toBe('Sound Check Fix: Align its peak to the cue'));
		} finally {
			restoreBindings(previous);
		}
	});

	it('Fix: one History entry; the row says fixed and the summary goes stale', async () => {
		const f = fixture();
		mount(f);
		await run();
		const n = f.labels().length;
		await act(async () => {
			fireEvent.click(within(rowOf('LOUDNESS')).getByTestId('sound-check-fix'));
		});
		await waitFor(() => expect(f.labels()).toHaveLength(n + 1));
		expect(f.labels().at(-1)).toBe('Sound Check Fix: Normalise the mix to -14 LUFS / -1 dBTP');
		const loud = (f.seq().master as { loudness?: { enabled: boolean; targetLufs: number } }).loudness!;
		expect(loud).toMatchObject({ enabled: true, targetLufs: -14 });
		expect(within(rowOf('LOUDNESS')).getByTestId('sound-check-fixed')).toBeTruthy();
		expect(within(rowOf('LOUDNESS')).queryByTestId('sound-check-fix')).toBeNull();
		expect((await screen.findByTestId('sound-check-stale')).textContent).toContain(
			'cues, loudness or credits settings changed',
		);
		// undo restores it (an ordinary edit)
		act(() => f.session.undo());
		expect((f.seq().master as { loudness?: { enabled?: boolean } }).loudness?.enabled ?? false).toBe(false);
	});

	it('Fix… (a fix that needs judgement) asks first, naming what it changes; Cancel applies nothing', async () => {
		const f = fixture();
		render(<DialogHost />);
		mount(f);
		await run();
		const n = f.labels().length;
		await act(async () => {
			fireEvent.click(within(rowOf('SILENCE')).getByTestId('sound-check-fix'));
		});
		let dialog = await screen.findByTestId('confirm-dialog');
		expect(dialog.textContent).toContain('Apply “Mark it as intended silence (a silence cue)”?');
		expect(dialog.textContent).toContain(
			'This will change: Adds a silence cue at 00:00:07:00: Sound Check no longer reports silence there.',
		);
		expect(dialog.textContent).toContain('Why it needs your judgement: Only if the silence is intended.');
		expect(dialog.textContent).toContain('one undo step');
		// Cancel: nothing changes
		await act(async () => {
			fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
		});
		await waitFor(() => expect(screen.queryByTestId('confirm-dialog')).toBeNull());
		await settle();
		expect(f.labels()).toHaveLength(n);
		expect(cuesOf(f.seq()).some((c) => c.kind === 'silence')).toBe(false);
		expect(screen.getByTestId('sound-check-live').textContent).toContain('Fix not applied');
		expect(within(rowOf('SILENCE')).getByTestId('sound-check-fix')).toBeTruthy();
		// Apply Fix: one History entry
		await act(async () => {
			fireEvent.click(within(rowOf('SILENCE')).getByTestId('sound-check-fix'));
		});
		dialog = await screen.findByTestId('confirm-dialog');
		await act(async () => {
			fireEvent.click(within(dialog).getByRole('button', { name: 'Apply Fix' }));
		});
		await waitFor(() => expect(f.labels()).toHaveLength(n + 1));
		expect(f.labels().at(-1)).toBe('Sound Check Fix: Mark it as intended silence (a silence cue)');
		expect(cuesOf(f.seq()).some((c) => c.kind === 'silence' && c.frame === 210)).toBe(true);
		// a safe fix never asks
		await act(async () => {
			fireEvent.click(within(rowOf('LOUDNESS')).getByTestId('sound-check-fix'));
		});
		await waitFor(() => expect(f.labels()).toHaveLength(n + 2));
		expect(screen.queryByTestId('confirm-dialog')).toBeNull();
	});

	it('a report the engine kept is reloaded after a restart (the job is gone) and judged stale by its own hashes', async () => {
		const f = fixture();
		const view = mount(f);
		await run();
		const kept = soundCheckStore(f.session).getState().result!;
		view.unmount();
		// the engine restarted: it forgot the job but kept the report per sequence
		soundCheckStore(f.session).setState({ result: null, jobId: null });
		const asked: unknown[] = [];
		(f.engine.client as { lastSoundCheck?: unknown }).lastSoundCheck = async (req: unknown) => {
			asked.push(req);
			return {
				projectId: f.session.projectId,
				sequenceId: f.seqId,
				jobId: 'job_1',
				savedAt: '2026-10-17T10:00:00.000Z',
				state: 'current',
				reasons: [],
				result: kept,
			};
		};
		mount(f);
		await waitFor(() => expect(document.querySelector('[data-code="OUT_OF_SYNC"]')).toBeTruthy());
		expect(asked).toEqual([{ projectId: f.session.projectId, sequenceId: f.seqId }]);
		expect(screen.queryByTestId('sound-check-stale')).toBeNull();
		// an edit since: the kept report is stale (the panel compares its own hashes)
		await act(async () => {
			f.ok([{ type: 'audio.setGain', clipIds: [f.clipA], mode: 'adjust', db: -3 }], 'Gain');
		});
		expect((await screen.findByTestId('sound-check-stale')).textContent).toContain('the mix changed');
	});

	it('Fix all safe: commands and the swap in ONE transaction, the ducking job after it, then the check again', async () => {
		const f = fixture();
		mount(f);
		await run();
		expect(screen.getByTestId('sound-check-fix-all').textContent).toBe('Fix all safe (4)');
		const n = f.labels().length;
		const startA = f.seq().clips[f.clipA]!.start;
		const mediaB = (f.seq().clips[f.clipB] as { mediaId: string }).mediaId;
		f.engine.fixedCodes(['OUT_OF_SYNC', 'TRUNCATED', 'LOUDNESS', 'MUSIC_OVER_VOICE']);
		await act(async () => {
			fireEvent.click(screen.getByTestId('sound-check-fix-all'));
		});
		await waitFor(() => expect(f.engine.checks).toHaveLength(2), { timeout: 5000 });
		await waitFor(() => expect(f.labels().at(-1)).toBe('Sound Check Result'), { timeout: 5000 });
		// ONE entry for the document fixes (then the re-check's stored summary)
		expect(f.labels().slice(n)).toEqual(['Fix 3 Sound Check Findings', 'Sound Check Result']);
		expect(f.seq().clips[f.clipA]!.start).toBe(startA - 2);
		expect(f.engine.registers).toEqual([SND_B1]);
		expect((f.seq().clips[f.clipB] as { mediaId: string }).mediaId).not.toBe(mediaB);
		expect((f.seq().master as { loudness?: { enabled: boolean } }).loudness?.enabled).toBe(true);
		// the job fix: delivery with ducking only, apply mode
		expect(f.engine.deliveries).toEqual([
			expect.objectContaining({ mode: 'apply', loudness: false, autoMatch: false, rebalance: false }),
		]);
		// re-run: only the unsafe finding is left
		await waitFor(() =>
			expect(screen.getByTestId('sound-check-verdict').getAttribute('data-verdict')).toBe('warn'),
		);
		expect([...document.querySelectorAll('[data-code]')].map((r) => r.getAttribute('data-code'))).toEqual([
			'SILENCE',
		]);
		expect(screen.getByTestId('sound-check-fix-all').textContent).toBe('Fix all safe (0)');
		// one undo takes the document fixes back at once (after the summary)
		act(() => {
			f.session.undo();
			f.session.undo();
		});
		expect(f.seq().clips[f.clipA]!.start).toBe(startA);
		expect((f.seq().clips[f.clipB] as { mediaId: string }).mediaId).toBe(mediaB);
	});

	it('listen here: ▶ plays 4 s around the moment; Sounds right / Flag + note are user comment markers; Play all chains', async () => {
		const f = fixture();
		mount(f);
		await run();
		const rows = () => screen.getAllByTestId('sound-check-listen-row');
		await act(async () => {
			fireEvent.click(within(rows()[0]!).getByTestId('sound-check-listen-play'));
		});
		expect(mocks.windows[0]).toMatchObject({ center: 90, before: 2, after: 2 });
		// Sounds right on the hero
		await act(async () => {
			fireEvent.click(within(rows()[1]!).getByTestId('sound-check-sounds-right'));
		});
		expect(f.labels().at(-1)).toBe('Sounds Right at 00:00:03:01');
		// Flag the worst with a note (Enter saves)
		await act(async () => {
			fireEvent.click(within(rows()[0]!).getByTestId('sound-check-flag'));
		});
		const input = screen.getByTestId('sound-check-note-input');
		fireEvent.change(input, { target: { value: 'Still late by a frame' } });
		await act(async () => {
			fireEvent.keyDown(input, { key: 'Enter' });
		});
		expect(f.labels().at(-1)).toBe('Flag Sound at 00:00:03:00');
		expect(rows()[0]!.getAttribute('data-verdict')).toBe('flag');
		expect(rows()[1]!.getAttribute('data-verdict')).toBe('ok');
		expect(within(rows()[0]!).getByTestId('sound-check-note').textContent).toBe(
			'Note: Still late by a frame',
		);
		const markers = f
			.seq()
			.markers.filter((m) => m.name.startsWith('Sound Check'))
			.sort((a, b) => b.frame - a.frame);
		expect(markers).toEqual([
			expect.objectContaining({
				frame: 91,
				name: SOUND_CHECK_VERDICT_MARKER.ok,
				type: 'comment',
				author: 'user',
			}),
			expect.objectContaining({
				frame: 90,
				name: SOUND_CHECK_VERDICT_MARKER.flag,
				type: 'comment',
				author: 'user',
				comment: 'Still late by a frame',
			}),
		]);
		// what MCP sound_check returns as humanVerdicts: bound to the moment (slot, clip), current
		expect(
			soundCheckHumanVerdicts(f.seq(), { doc: f.session.getCommitted() }).map((v) => [
				v.frame,
				v.verdict,
				v.note,
				v.slot,
				v.clipId,
				v.stale,
			]),
		).toEqual([
			[90, 'flag', 'Still late by a frame', 'worst', f.clipA, false],
			[91, 'ok', null, 'hero', f.clipA, false],
		]);
		// changing a verdict updates the marker there (no second one)
		await act(async () => {
			fireEvent.click(within(rows()[0]!).getByTestId('sound-check-sounds-right'));
		});
		expect(f.seq().markers.filter((m) => m.frame === 90)).toHaveLength(1);
		expect(soundCheckHumanVerdicts(f.seq())[0]).toMatchObject({
			frame: 90,
			verdict: 'ok',
			note: 'Still late by a frame',
		});
		// Play all: each window plays to its end, then the next starts; a stop ends the chain
		mocks.windows.length = 0;
		await act(async () => {
			fireEvent.click(screen.getByTestId('sound-check-play-all'));
		});
		expect(mocks.windows.map((w) => w.center)).toEqual([90]);
		// the verdict controls keep Play all going (the window's input filter accepts them), its buttons do not
		const keep = (mocks.windows[0] as { keepPlayingOn?: (e: Event) => boolean }).keepPlayingOn!;
		const press = (el: Element) => {
			const e = new MouseEvent('pointerdown', { bubbles: true });
			Object.defineProperty(e, 'target', { value: el });
			return e;
		};
		expect(keep(press(within(rows()[2]!).getByTestId('sound-check-sounds-right')))).toBe(true);
		expect(keep(press(within(rows()[2]!).getByTestId('sound-check-flag')))).toBe(true);
		expect(keep(press(within(rows()[2]!).getByTestId('sound-check-listen-play')))).toBe(false);
		expect(keep(press(screen.getByTestId('sound-check-play-all')))).toBe(false);
		// a verdict during Play all: recorded, and the chain goes on
		await act(async () => {
			fireEvent.click(within(rows()[0]!).getByTestId('sound-check-sounds-right'));
		});
		expect(screen.getByTestId('sound-check-play-all').textContent).toBe('Stop');
		for (let i = 0; i < 2; i++) {
			await act(async () => {
				mocks.windows.at(-1)!.onEnd!('window');
				await new Promise((r) => setTimeout(r, 5));
			});
		}
		expect(mocks.windows.map((w) => w.center)).toEqual([90, 91, 120]);
		expect(screen.getByTestId('sound-check-play-all').textContent).toBe('Stop');
		await act(async () => {
			mocks.windows.at(-1)!.onEnd!('stopped');
			await new Promise((r) => setTimeout(r, 5));
		});
		expect(mocks.windows).toHaveLength(3);
		expect(screen.getByTestId('sound-check-play-all').textContent).toBe('Play all');
		// an edit of the sound the verdicts judged: they are out of date (the row says so; MCP reports stale)
		await act(async () => {
			f.ok([{ type: 'audio.setGain', clipIds: [f.clipA], mode: 'adjust', db: 4 }], 'Gain');
		});
		expect(rows()[0]!.getAttribute('data-verdict-stale')).toBe('true');
		expect(within(rows()[0]!).getByTestId('sound-check-verdict-stale').textContent).toBe(
			'Out of date: the sound here changed since you listened',
		);
		expect(rows()[3]!.getAttribute('data-verdict-stale')).toBeNull();
	});

	it('Use as sequence target: a preset applies the delivery; Custom… checks against its numbers and normalises there', async () => {
		const f = fixture();
		mount(f);
		await act(async () => {
			fireEvent.click(screen.getByTestId('sound-check-use-target'));
		});
		expect(f.labels().at(-1)).toBe('Use Delivery Target: Web / streaming · −14 LUFS · −1 dBTP');
		expect(
			(f.seq().master as { loudness?: { enabled: boolean; targetLufs: number } }).loudness,
		).toMatchObject({
			enabled: true,
			targetLufs: -14,
		});
		// now it is the target: the button says so
		expect(screen.getByTestId('sound-check-use-target').getAttribute('aria-disabled')).toBe('true');
		// Custom…
		const trigger = screen.getByRole('combobox', { name: 'Delivery target' });
		await act(async () => {
			fireEvent.keyDown(trigger, { key: 'Enter' });
		});
		await act(async () => {
			fireEvent.keyDown(await screen.findByRole('option', { name: 'Custom…' }), { key: 'Enter' });
		});
		const lufs = screen.getByTestId('sound-check-custom-lufs');
		fireEvent.change(lufs, { target: { value: '-70' } });
		fireEvent.blur(lufs);
		expect(screen.getByRole('alert').textContent).toBe('Integrated loudness from -40 to -5 LUFS');
		expect(lufs.getAttribute('aria-invalid')).toBe('true');
		fireEvent.change(lufs, { target: { value: '−18,5' } });
		fireEvent.blur(lufs);
		const tp = screen.getByTestId('sound-check-custom-tp');
		fireEvent.change(tp, { target: { value: '-2' } });
		fireEvent.blur(tp);
		expect(screen.queryByRole('alert')).toBeNull();
		await run();
		expect(f.engine.checks.at(-1)).toMatchObject({
			preset: 'web',
			target: { integratedLufs: -18.5, truePeakDb: -2 },
		});
		expect(soundCheckStatus(f.session.getCommitted(), f.seqId).summary).toMatchObject({
			target: { integratedLufs: -18.5, truePeakDb: -2 },
		});
		await act(async () => {
			fireEvent.click(screen.getByTestId('sound-check-use-target'));
		});
		expect(f.labels().at(-1)).toBe('Use Delivery Target: Custom · −18.5 LUFS · −2.0 dBTP');
		expect(
			(f.seq().master as { loudness?: { targetLufs: number; truePeakDb: number } }).loudness,
		).toMatchObject({
			targetLufs: -18.5,
			truePeakDb: -2,
		});
	});

	it('Sequence ▸ Sound Design ▸ Run Sound Check opens the panel and runs; Fix All Safe is a command too', async () => {
		const f = fixture();
		const seqMenu = MENUBAR.find((m) => m.label === 'Sequence')!;
		const sd = seqMenu.items.find((i) => i.type === 'submenu' && i.label === 'Sound Design') as {
			items: { command?: string }[];
		};
		expect(sd.items.map((i) => i.command)).toContain('sound.runSoundCheck');
		expect(getCommand('sound.runSoundCheck')?.agentExposed).toBe(true);
		const ctx = createCommandContext({
			engine: f.engine.client as never,
			session: f.session,
			capabilities: ['engine'],
		});
		expect(getCommand('sound.fixAllSafe')!.when!(ctx)).toBe(false);
		await act(async () => {
			await runCommand('sound.runSoundCheck', ctx);
		});
		expect(f.engine.checks).toHaveLength(1);
		expect(soundCheckStore(f.session).getState().result?.report.verdict).toBe('fail');
		expect(getCommand('sound.fixAllSafe')!.when!(ctx)).toBe(true);
	});
});

function GateHarness(props: {
	session: EditorSession;
	seq: Sequence;
	onExport(): void;
	onReview(): void;
	notes: string[];
}) {
	const g = useExportSoundCheck({
		session: props.session,
		engine: mocks.client as never,
		seq: props.seq,
		onReview: props.onReview,
		notify: (m) => props.notes.push(m),
	});
	return (
		<div>
			{g.section}
			{g.prompt}
			<button
				type="button"
				data-testid="harness-export"
				disabled={g.busy}
				onClick={async () => {
					if (await g.gate()) props.onExport();
				}}
			>
				Export
			</button>
		</div>
	);
}

describe('Export dialog: Run Sound Check before export', () => {
	it('is offered with sound effects; a fail stops with Export anyway / Review issues; a pass exports', async () => {
		localStorage.removeItem('jasper:sound-check-before-export');
		const f = fixture();
		const exports: number[] = [];
		const reviews: number[] = [];
		const notes: string[] = [];
		const view = () => (
			<SessionProvider session={f.session}>
				<GateHarness
					session={f.session}
					seq={f.seq()}
					onExport={() => exports.push(1)}
					onReview={() => reviews.push(1)}
					notes={notes}
				/>
			</SessionProvider>
		);
		const r = render(view());
		const box = screen.getByTestId('export-sound-check-toggle') as HTMLInputElement;
		expect(box.checked).toBe(false);
		// off: exports at once, no check
		await act(async () => {
			fireEvent.click(screen.getByTestId('harness-export'));
		});
		expect(exports).toHaveLength(1);
		expect(f.engine.checks).toHaveLength(0);
		fireEvent.click(box);
		expect(localStorage.getItem('jasper:sound-check-before-export')).toBe('1');
		// on, the check fails → the prompt
		await act(async () => {
			fireEvent.click(screen.getByTestId('harness-export'));
		});
		const prompt = await screen.findByTestId('export-sound-check-prompt', {}, { timeout: 5000 });
		expect(prompt.getAttribute('role')).toBe('alertdialog');
		expect(prompt.textContent).toContain(
			'FailSound Check: 1 error, 4 warnings. Integrated −17.2 LUFS, true peak −2.1 dBTP. Review the findings, or export anyway.',
		);
		expect(exports).toHaveLength(1);
		await act(async () => {
			fireEvent.click(screen.getByTestId('export-sound-check-review'));
		});
		expect(reviews).toHaveLength(1);
		expect(exports).toHaveLength(1);
		// again → Export anyway
		await act(async () => {
			fireEvent.click(screen.getByTestId('harness-export'));
		});
		const anyway = await screen.findByTestId('export-sound-check-anyway', {}, { timeout: 5000 });
		await act(async () => {
			fireEvent.click(anyway);
		});
		await settle();
		expect(exports).toHaveLength(2);
		// the mix passes now: the export goes on by itself, the verdict is said
		f.engine.fixedCodes(['OUT_OF_SYNC', 'TRUNCATED', 'LOUDNESS', 'MUSIC_OVER_VOICE', 'SILENCE']);
		await act(async () => {
			fireEvent.click(screen.getByTestId('harness-export'));
		});
		await waitFor(() => expect(exports).toHaveLength(3), { timeout: 5000 });
		expect(notes.at(-1)).toBe('Sound Check Pass: 0 errors, 0 warnings');
		expect(f.engine.checks).toHaveLength(3);
		r.unmount();
		localStorage.removeItem('jasper:sound-check-before-export');
	});

	it('is not offered for a sequence without sound effects', () => {
		const { session, seqId } = makeSession();
		render(
			<SessionProvider session={session}>
				<GateHarness
					session={session}
					seq={session.getCommitted().sequences[seqId] as Sequence}
					onExport={() => {}}
					onReview={() => {}}
					notes={[]}
				/>
			</SessionProvider>,
		);
		expect(screen.queryByTestId('export-sound-check')).toBeNull();
	});
});
