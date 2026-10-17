// The Sound Check panel's Log tab (spec 12 §4 P6-E6 / P6-E7; wp-note "Phase 6 → WP-E3") on a real session with a fake
// engine: Listen runs the `sound-listen` job and lists its lines verbatim (what MCP listen_to_sequence prints); a line
// moves the playhead and selects the clip that plays the sound; the keyboard (↓ Enter); Copy log; the spectrogram strip
// asks the engine for the mix spectrogram of the listened range; the long-sequence range; the command and menu entry.
import type { EngineJob, SoundListenRequest, SoundListenResult, SoundVisualRequest } from '@jasper/api';
import { SoundListenResultSchema } from '@jasper/api';
import type { Sequence } from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { closeAllDialogs, toasts } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommandContext } from '../src/commands/context.ts';
import { getCommand, runCommand } from '../src/commands/registry.ts';
import { listenRangeFor, listenStore, spectrogramWindow } from '../src/panels/soundCheck/listen-run.ts';
import { SoundCheckPanel } from '../src/panels/soundCheck/SoundCheckPanel.tsx';
import { MENUBAR } from '../src/shell/menus/model.ts';
import { audioAsset } from './proposal-helpers.ts';
import { makeSession } from './timeline-helpers.ts';

const mocks = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../src/state/engine.tsx', () => ({
	useEngine: () => ({ client: mocks.client, status: 'connected', subscribe: () => () => {}, capabilities: null }),
	useEngineOrNull: () => ({ client: mocks.client, status: 'connected', subscribe: () => () => {} }),
	useCapabilities: () => ({ capabilities: null, flags: new Set(['engine']) }),
	createEditorEngineClient: () => mocks.client,
}));
const { registerAllCommands } = await import('../src/commands/index.ts');

beforeAll(() => registerAllCommands());
beforeEach(() => toasts.dismissAll());
afterEach(() => {
	cleanup();
	closeAllDialogs();
});

/** Music on A1 and a hit on A2 at frame 90. */
function fixture() {
	const { session, seqId } = makeSession();
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{ type: 'media.register', asset: audioAsset(10), ref: '$music' },
			{ type: 'media.register', asset: audioAsset(1), ref: '$hit' },
			{ type: 'clip.place', source: { mediaId: '$music' }, at: 0, tracks: { audio: 'A1' }, ref: '$m' },
			{ type: 'clip.place', source: { mediaId: '$hit' }, at: 90, tracks: { audio: 'A2' }, ref: '$h' },
		] as never[],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return { session, seqId, music: r.refs.$m!, hit: r.refs.$h! };
}

function listenResult(projectId: string, sequenceId: string, hit: string, music: string): SoundListenResult {
	const stats = {
		n: 1,
		ok: 1,
		near: 0,
		swell: 0,
		none: 0,
		okShare: 1,
		okChance: 0.12,
		within100Share: 1,
		within100Chance: 0.3,
		accentOkShare: 1,
		accentOkChance: 0.04,
		accent100Share: 1,
		accent100Chance: 0.1,
		onBeatShare: null,
		onBeatChance: null,
		medianAbsOffsetMs: 0,
		frameMs: 33.3,
		spanMs: [2000, 4000] as [number, number],
	};
	const event = (frame: number, clipId: string, stem: 'sfx' | 'music', accent: boolean) => ({
		frame,
		timecode: `00:00:0${Math.floor(frame / 30)}:${String(frame % 30).padStart(2, '0')}`,
		ms: (frame / 30) * 1000,
		mixMs: (frame / 30) * 1000,
		peakMs: (frame / 30) * 1000 + 2,
		shape: 'hit' as const,
		band: 'low' as const,
		prominenceDb: accent ? 15 : 4,
		bedDb: -30,
		contrastDb: 20,
		lengthMs: 200,
		peakDb: -6,
		accent,
		guided: false,
		stem,
		clipId,
		track: stem === 'sfx' ? 'A2' : 'A1',
		clipName: stem === 'sfx' ? 'Hit' : 'Music',
		cueId: null,
		cueKind: null,
		role: null,
		explainedBy: 'event' as const,
		answers: [],
	});
	const lines = [
		{ frame: 0, timecode: '00:00:00:00', kind: 'summary' as const, text: 'Listened 00:00:00:00–00:00:10:00: 2 sound events (1 accent, 0 swells), 1 section, 0 silences; integrated -20.0 LUFS as mixed.' },
		{ frame: 0, timecode: '00:00:00:00', kind: 'section' as const, text: '== music until 00:00:10:00 · -20 LUFS' },
		{ frame: 45, timecode: '00:00:01:15', kind: 'event' as const, text: 'hit, low band, +4 dB over the bed · music, A1 "Music"', event: 0 },
		{ frame: 90, timecode: '00:00:03:00', kind: 'event' as const, text: 'hit, low band, +15 dB over the bed · accent · SFX A2 "Hit"', event: 1 },
		{ frame: 240, timecode: '00:00:08:00', kind: 'unanswered' as const, text: "NO SOUND for Cut on V1: 'A' → 'B' (nothing within 250 ms)", key: 'edit:v1:a>b' },
	];
	return SoundListenResultSchema.parse({
		projectId,
		sequenceId,
		revision: 1,
		range: { start: 0, end: 300 },
		rangeTimecode: { start: '00:00:00:00', end: '00:00:10:00' },
		wholeSequence: true,
		fps: { num: 30, den: 1 },
		detail: 'normal',
		lines,
		text: lines.map((l) => `${l.timecode}  ${l.text}`).join('\n'),
		events: [event(45, music, 'music', false), event(90, hit, 'sfx', true)],
		sections: [
			{ start: 0, end: 300, startTimecode: '00:00:00:00', endTimecode: '00:00:10:00', classes: ['music'], label: 'music', lufs: -20 },
		],
		silences: [],
		pictureEvents: [
			{ kind: 'cut', key: 'edit:v1:a>b', frame: 240, timecode: '00:00:08:00', label: "Cut on V1: 'A' → 'B'", status: 'none', offsetMs: null, event: null, nearestStrongMs: null },
		],
		unanswered: [
			{ kind: 'cut', key: 'edit:v1:a>b', frame: 240, timecode: '00:00:08:00', label: "Cut on V1: 'A' → 'B'", status: 'none', offsetMs: null, event: null, nearestStrongMs: null },
		],
		sync: { cuts: stats, transitions: null, cues: null, motion: null, all: stats, beatsKnown: false, motionAnalysed: false },
		placed: [],
		loudness: {
			integratedLufs: -20,
			maxMomentaryLufs: -14,
			maxMomentaryFrame: 90,
			maxShortTermLufs: -18,
			maxShortTermFrame: 90,
			normalization: { applied: false, gainDb: 0, reason: 'off' },
		},
		counts: { events: 2, accents: 1, swells: 0, sections: 1, silences: 0, pictureEvents: 1, unanswered: 1, lanes: 2, eventsDropped: 0 },
		warnings: [],
		timings: { totalMs: 10 },
	});
}

function fakeEngine(session: ReturnType<typeof fixture>['session'], seqId: string, hit: string, music: string) {
	const listens: SoundListenRequest[] = [];
	const visuals: SoundVisualRequest[] = [];
	const jobs = new Map<string, () => unknown>();
	let n = 0;
	const job = (id: string, state: EngineJob['state'], extra: Partial<EngineJob> = {}): EngineJob =>
		({
			id,
			kind: 'sound-listen',
			title: 'Listen to the mix',
			origin: { type: 'user' },
			projectId: session.projectId,
			state,
			progress: state === 'succeeded' ? 1 : 0.5,
			stage: state === 'running' ? 'Listening' : undefined,
			createdAt: '2026-10-18T10:00:00.000Z',
			priority: 'user',
			cpuSlots: 1,
			...extra,
		}) as EngineJob;
	const client = {
		async soundListen(req: SoundListenRequest) {
			listens.push(req);
			const id = `job_${++n}`;
			jobs.set(id, () => listenResult(session.projectId, seqId, hit, music));
			return job(id, 'running');
		},
		async soundVisual(req: SoundVisualRequest) {
			visuals.push(req);
			const frames = Math.round(((req.range.end - req.range.start) / 30) * 100);
			const bytes = new Uint8Array(frames * 96).fill(40);
			for (let b = 0; b < 30; b++) bytes[300 * 96 + b] = 250;
			return {
				range: req.range,
				points: frames,
				spectrogram: {
					hopSec: 0.01,
					bands: 96,
					frames,
					fMinHz: 30,
					fMaxHz: 16000,
					floorDb: -100,
					data: Buffer.from(bytes).toString('base64'),
				},
			};
		},
		async getJob(id: string) {
			const run = jobs.get(id);
			if (!run) throw Object.assign(new Error('no job'), { code: 'JOB_NOT_FOUND' });
			jobs.delete(id);
			return job(id, 'succeeded', { result: run() });
		},
		async cancelJob(id: string) {
			jobs.delete(id);
			return job(id, 'cancelled');
		},
	};
	return { client, listens, visuals };
}

function mount(session: ReturnType<typeof fixture>['session']) {
	return render(
		<SessionProvider session={session}>
			<SoundCheckPanel instanceId="sc1" visible />
		</SessionProvider>,
	);
}

describe('Sound Check ▸ Log tab', () => {
	it('lists the transcript lines verbatim; a line jumps the playhead and selects its clip; keys; copy; spectrogram', async () => {
		const f = fixture();
		const eng = fakeEngine(f.session, f.seqId, f.hit, f.music);
		mocks.client = eng.client;
		mount(f.session);
		fireEvent.click(screen.getByTestId('sound-check-tab-log'));
		expect(screen.getByTestId('sound-check-tab-log').getAttribute('aria-selected')).toBe('true');
		const log = screen.getByTestId('sound-listen-log');
		expect(within(log).getByTestId('sound-listen-copy').getAttribute('aria-disabled')).toBe('true');
		fireEvent.click(within(log).getByTestId('sound-listen-run'));
		await waitFor(() => expect(within(log).getAllByTestId('sound-listen-line')).toHaveLength(5), { timeout: 3000 });
		expect(eng.listens).toEqual([{ projectId: f.session.projectId, sequenceId: f.seqId, detail: 'normal' }]);
		// verbatim: the same lines MCP prints (timecode, two spaces, text)
		const result = listenStore(f.session).getState().result!;
		const shown = within(log)
			.getAllByTestId('sound-listen-line')
			.map(
				(row) =>
					`${within(row).getByTestId('sound-listen-timecode').textContent}  ${within(row).getByTestId('sound-listen-text').textContent}`,
			);
		expect(shown.join('\n')).toBe(result.text);
		// the no-sound line is marked (icon + danger tone), not by colour alone
		const unanswered = within(log).getAllByTestId('sound-listen-line')[4]!;
		expect(unanswered.getAttribute('data-kind')).toBe('unanswered');
		expect(unanswered.querySelector('svg')).not.toBeNull();
		// a line moves the playhead and selects the clip that plays the sound
		fireEvent.click(within(log).getAllByTestId('sound-listen-line')[3]!);
		expect(f.session.transport.getState().frame).toBe(90);
		expect(JSON.stringify(f.session.getState().selection)).toContain(f.hit);
		expect(within(log).getAllByTestId('sound-listen-line')[3]!.getAttribute('aria-selected')).toBe('true');
		// keys: ↑ to the music line, Enter jumps there and selects the music clip
		const list = within(log).getByTestId('sound-listen-lines');
		fireEvent.keyDown(list, { key: 'ArrowUp' });
		fireEvent.keyDown(list, { key: 'Enter' });
		expect(f.session.transport.getState().frame).toBe(45);
		expect(JSON.stringify(f.session.getState().selection)).toContain(f.music);
		fireEvent.keyDown(list, { key: 'End' });
		expect(listenStore(f.session).getState().cursor).toBe(4);
		// copy log
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		fireEvent.click(within(log).getByTestId('sound-listen-copy'));
		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect((writeText.mock.calls[0] as unknown as [string])[0]).toContain(result.text);
		// the spectrogram of the listened range, marked at the current line
		fireEvent.click(within(log).getByTestId('sound-listen-spectrogram'));
		await waitFor(() => expect(eng.visuals).toHaveLength(1));
		expect(eng.visuals[0]).toMatchObject({ sequenceId: f.seqId, range: { start: 0, end: 300 }, spectrogram: true });
		expect(await within(log).findByTestId('sound-listen-spectrogram-mark')).toBeDefined();
		// back to the findings
		fireEvent.click(screen.getByTestId('sound-check-tab-findings'));
		expect(screen.queryByTestId('sound-listen-log')).toBeNull();
	});

	it('Listen to Sequence opens the Log tab and listens; the menu has it', async () => {
		const f = fixture();
		const eng = fakeEngine(f.session, f.seqId, f.hit, f.music);
		mocks.client = eng.client;
		const cmd = getCommand('sound.listenToSequence');
		expect(cmd).toMatchObject({ agentExposed: true, capability: 'engine' });
		const ctx = createCommandContext({ engine: eng.client as never, session: f.session, capabilities: ['engine'] });
		await act(async () => {
			await runCommand('sound.listenToSequence', ctx);
		});
		expect(listenStore(f.session).getState()).toMatchObject({ tab: 'log', error: null });
		expect(listenStore(f.session).getState().result?.lines).toHaveLength(5);
		const menu = JSON.stringify(MENUBAR);
		expect(menu).toContain('sound.listenToSequence');
	});

	it('listens to 10 minutes from the playhead of a longer sequence; the spectrogram window follows the line', () => {
		const seq = {
			clips: { a: { start: 0, duration: 30 * 60 * 15 } },
			settings: { frameRate: { num: 30, den: 1 } },
		} as unknown as Sequence;
		expect(listenRangeFor(seq, 30 * 60 * 2)).toMatchObject({ range: { start: 3600, end: 3600 + 18_000 } });
		expect(listenRangeFor(seq, 30 * 60 * 14).range).toEqual({ start: 27_000 - 18_000, end: 27_000 });
		expect(listenRangeFor({ ...seq, clips: { a: { start: 0, duration: 300 } } } as never, 0)).toEqual({ note: null });
		const r = { range: { start: 0, end: 18_000 }, fps: { num: 30, den: 1 }, lines: [{ frame: 9000 }] } as never;
		expect(spectrogramWindow(r, null)).toEqual({ start: 0, end: 3600 });
		expect(spectrogramWindow(r, 0)).toEqual({ start: 9000 - 1800, end: 9000 + 1800 });
	});
});
