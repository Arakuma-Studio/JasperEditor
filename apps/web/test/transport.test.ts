import { EngineClient } from '@jasper/engine-client';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
} from '@jasper/project';
import { EditorSession, TransportStore } from '@jasper/session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createCommandContext,
	registerCommands,
	resetCommandRegistry,
	runCommand,
} from '../src/commands/index.ts';
import { transportCommands } from '../src/commands/transport.ts';
import { handleMonitorKey } from '../src/panels/program/monitor-commands.ts';
import {
	type Clock,
	PLAY_WATCHDOG_MS,
	PlaybackDriver,
	type PlayerLike,
	SEEK_HZ,
} from '../src/panels/program/playback-driver.ts';
import { Shuttle, type ShuttleTarget, type TimerApi } from '../src/panels/program/shuttle.ts';
import { registerDriver, shuttleFor } from '../src/panels/program/transport-registry.ts';
import { PanelServices } from '../src/state/panel-services.ts';

// ------------------------------------------------------------------ fakes

function fakeTimers(): TimerApi & { advance(ms: number): void } {
	let now = 0;
	const timers: { at: number; cb: () => void; id: number }[] = [];
	let id = 0;
	return {
		setTimeout: (cb, ms) => {
			timers.push({ at: now + ms, cb, id: ++id });
			return id;
		},
		clearTimeout: (h) => {
			const i = timers.findIndex((t) => t.id === h);
			if (i >= 0) timers.splice(i, 1);
		},
		advance(ms) {
			now += ms;
			for (const t of [...timers].sort((a, b) => a.at - b.at)) {
				if (t.at <= now) {
					timers.splice(timers.indexOf(t), 1);
					t.cb();
				}
			}
		},
	};
}

function transportTarget(t: TransportStore): ShuttleTarget {
	return {
		play: (r) => t.play(r),
		pause: () => t.pause(),
		step: (n) => t.step(n),
		isPlaying: () => t.getState().playing,
		currentRate: () => t.getState().rate,
	};
}

type Ev = 'frameupdate' | 'ended' | 'pause' | 'play' | 'waiting' | 'resume';
class FakePlayer implements PlayerLike {
	frame = 0;
	playing = false;
	muted = false;
	seeks: number[] = [];
	listeners = new Map<Ev, Set<(e: { detail: unknown }) => void>>();
	seekTo(f: number) {
		this.frame = f;
		this.seeks.push(f);
	}
	play() {
		this.playing = true;
	}
	pause() {
		this.playing = false;
	}
	getCurrentFrame() {
		return this.frame;
	}
	isPlaying() {
		return this.playing;
	}
	mute() {
		this.muted = true;
	}
	unmute() {
		this.muted = false;
	}
	addEventListener(n: Ev, cb: (e: { detail: unknown }) => void) {
		if (!this.listeners.has(n)) this.listeners.set(n, new Set());
		this.listeners.get(n)!.add(cb);
	}
	removeEventListener(n: Ev, cb: (e: { detail: unknown }) => void) {
		this.listeners.get(n)?.delete(cb);
	}
	emit(n: Ev, detail: unknown = {}) {
		for (const cb of this.listeners.get(n) ?? []) cb({ detail });
	}
	/** Simulates native playback of `n` frames. */
	advance(n: number) {
		for (let i = 0; i < n; i++) {
			this.frame += 1;
			this.emit('frameupdate', { frame: this.frame });
		}
	}
}

function fakeClock(): Clock & { t: number; step(ms: number): void; pending: number } {
	let cbs: (() => void)[] = [];
	const c = {
		t: 0,
		pending: 0,
		now: () => c.t,
		requestFrame: (cb: () => void) => {
			cbs.push(cb);
			c.pending = cbs.length;
			return cb;
		},
		cancelFrame: (h: unknown) => {
			cbs = cbs.filter((x) => x !== h);
			c.pending = cbs.length;
		},
		step(ms: number) {
			c.t += ms;
			const run = cbs;
			cbs = [];
			for (const cb of run) cb();
			c.pending = cbs.length;
		},
	};
	return c;
}

function setup(range = { end: 300, loopStart: 0, loopEnd: 300 }) {
	const transport = new TransportStore();
	const player = new FakePlayer();
	const clock = fakeClock();
	const rates: number[] = [];
	const driver = new PlaybackDriver({
		transport,
		clock,
		getFps: () => 30,
		getRange: () => range,
		setPlayerRate: (r) => rates.push(r),
	});
	transport.attachPlayer(driver);
	driver.setPlayer(player);
	return { transport, player, clock, driver, rates };
}

// ------------------------------------------------------------------ JKL (S02 Appendix A.8)

describe('JKL shuttle', () => {
	it('L L L yields 4×; J then yields −1×; K stops (AC-18a)', () => {
		const t = new TransportStore();
		const s = new Shuttle(transportTarget(t), fakeTimers());
		s.keyDown('L');
		s.keyUp('L');
		expect(t.getState()).toMatchObject({ playing: true, rate: 1 });
		s.keyDown('L');
		s.keyUp('L');
		s.keyDown('L');
		s.keyUp('L');
		expect(t.getState().rate).toBe(4);
		s.keyDown('L');
		s.keyUp('L');
		s.keyDown('L');
		s.keyUp('L');
		expect(t.getState().rate).toBe(8);
		s.keyDown('J');
		s.keyUp('J');
		expect(t.getState()).toMatchObject({ playing: true, rate: -1 });
		s.keyDown('K');
		expect(t.getState().playing).toBe(false);
		s.keyUp('K');
	});

	it('hold K + tap L five times advances exactly five frames (AC-18c)', () => {
		const t = new TransportStore({ frame: 100 });
		const timers = fakeTimers();
		const s = new Shuttle(transportTarget(t), timers);
		s.keyDown('K');
		for (let i = 0; i < 5; i++) {
			s.keyDown('L');
			timers.advance(50);
			s.keyUp('L');
		}
		s.keyUp('K');
		expect(t.getState()).toMatchObject({ frame: 105, playing: false });
	});

	it('hold K + hold L plays at 0.25× until release; repeats are ignored', () => {
		const t = new TransportStore({ frame: 10 });
		const timers = fakeTimers();
		const s = new Shuttle(transportTarget(t), timers);
		s.keyDown('K');
		s.keyDown('L');
		s.keyDown('L'); // auto-repeat
		expect(t.getState().frame).toBe(11);
		timers.advance(260);
		expect(t.getState()).toMatchObject({ playing: true, rate: 0.25 });
		s.keyUp('L');
		expect(t.getState().playing).toBe(false);
	});

	it('Space toggles 1× forward play; Shift+L/J steps the slow rate by 0.1', () => {
		const t = new TransportStore();
		const s = new Shuttle(transportTarget(t), fakeTimers());
		s.playStop();
		expect(t.getState()).toMatchObject({ playing: true, rate: 1 });
		s.playStop();
		expect(t.getState().playing).toBe(false);
		s.slow(1);
		expect(t.getState()).toMatchObject({ playing: true, rate: 0.1 });
		s.slow(1);
		expect(t.getState().rate).toBeCloseTo(0.2, 9);
		s.slow(-1);
		s.slow(-1);
		expect(t.getState().playing).toBe(false);
		s.slow(-1);
		expect(t.getState().rate).toBeCloseTo(-0.1, 9);
	});

	it('restarts at 1× after the transport stopped on its own', () => {
		const t = new TransportStore();
		const s = shuttleFor(t);
		s.keyDown('L');
		s.keyUp('L');
		s.keyDown('L');
		s.keyUp('L');
		expect(t.getState().rate).toBe(2);
		t.pause(); // e.g. end of sequence
		s.keyDown('L');
		s.keyUp('L');
		expect(t.getState()).toMatchObject({ playing: true, rate: 1 });
	});
});

// ------------------------------------------------------------------ Player ↔ TransportStore

describe('PlaybackDriver (S03:ARC-010, S02:TL-873)', () => {
	it('plays natively at 1×: the Player is the clock and frames are reported', () => {
		const { transport, player, rates } = setup();
		transport.play(1);
		expect(player.playing).toBe(true);
		expect(player.muted).toBe(false);
		expect(rates.at(-1)).toBe(1);
		player.advance(10);
		expect(transport.getState().frame).toBe(10);
		transport.pause();
		expect(player.playing).toBe(false);
		transport.seek(42);
		expect(player.frame).toBe(42);
	});

	it('re-issues play() when the Player does not start or stalls while playing (no frameupdate, not buffering) — WP-3I', () => {
		vi.useFakeTimers();
		try {
			const { transport, player } = setup();
			transport.seek(61);
			let plays = 0;
			const orig = player.play.bind(player);
			player.play = () => {
				plays++;
				orig();
			};
			transport.play(1);
			expect(plays).toBe(1);
			vi.advanceTimersByTime(PLAY_WATCHDOG_MS + 10); // no frames arrived: kicked again
			expect(plays).toBe(2);
			expect(player.seeks.at(-1)).toBe(61);
			// Progressing: no kicks while frames keep arriving.
			for (let i = 0; i < 6; i++) {
				player.advance(5);
				vi.advanceTimersByTime(PLAY_WATCHDOG_MS / 2);
			}
			expect(plays).toBe(2);
			expect(transport.getState().frame).toBe(91);
			// Stalls mid-play (seen in the E2E suite: 61 → 62, then nothing): kicked again.
			vi.advanceTimersByTime(PLAY_WATCHDOG_MS + 10);
			expect(plays).toBe(3);
			expect(player.seeks.at(-1)).toBe(91);
			// A permanently stuck Player is kicked at most PLAY_WATCHDOG_RETRIES times in a row.
			vi.advanceTimersByTime(PLAY_WATCHDOG_MS * 10);
			expect(plays).toBe(5);
			// Buffering (waiting) is legitimate: no kick while waiting.
			transport.pause();
			transport.play(1);
			expect(plays).toBe(6);
			player.emit('waiting');
			vi.advanceTimersByTime(PLAY_WATCHDOG_MS * 4);
			expect(plays).toBe(6);
			transport.pause();
			vi.advanceTimersByTime(PLAY_WATCHDOG_MS * 4);
			expect(plays).toBe(6);
		} finally {
			vi.useRealTimers();
		}
	});

	it('mutes below 1× (TL-874) and steps above 1× (measured Player limit)', () => {
		const { transport, player, driver, rates } = setup();
		transport.play(0.25);
		expect(driver.currentMode).toBe('native');
		expect(rates.at(-1)).toBe(0.25);
		expect(player.muted).toBe(true);
		transport.play(2);
		expect(driver.currentMode).toBe('stepping');
		expect(player.playing).toBe(false);
	});

	it('uses seek-stepping at 8×: timecode advances 8× real time, seeks ≤ 30/s (AC-18b)', () => {
		const { transport, player, clock, driver } = setup({ end: 100000, loopStart: 0, loopEnd: 100000 });
		transport.play(8);
		expect(driver.currentMode).toBe('stepping');
		expect(player.playing).toBe(false);
		player.seeks.length = 0;
		for (let i = 0; i < 60; i++) clock.step(1000 / 60);
		const expected = 8 * 30; // 1 s at 30 fps × 8
		expect(Math.abs(transport.getState().frame - expected) / expected).toBeLessThan(0.05);
		expect(player.seeks.length).toBeLessThanOrEqual(SEEK_HZ + 1);
		expect(player.seeks.length).toBeGreaterThan(20);
		transport.pause();
		expect(clock.pending).toBe(0);
	});

	it('plays reverse by stepping and stops at 0', () => {
		const { transport, clock, driver } = setup();
		transport.seek(30);
		transport.play(-1);
		expect(driver.currentMode).toBe('stepping');
		for (let i = 0; i < 120; i++) clock.step(1000 / 60);
		expect(transport.getState()).toMatchObject({ frame: 0, playing: false });
	});

	it('stops at the sequence end, or loops In→Out when loop is on (TL-875)', () => {
		const { transport, player } = setup({ end: 50, loopStart: 10, loopEnd: 20 });
		transport.seek(45);
		transport.play(1);
		player.advance(5);
		player.playing = false;
		player.emit('ended');
		expect(transport.getState().playing).toBe(false);
		transport.setLoop(true);
		transport.seek(15);
		transport.play(1);
		player.advance(5); // reaches 20 → back to 10
		expect(transport.getState().frame).toBe(10);
		expect(player.frame).toBe(10);
	});

	it('Play In to Out stops on the last marked frame (TL-877)', () => {
		const { transport, player, driver } = setup();
		driver.playRange(10, 20);
		expect(transport.getState()).toMatchObject({ playing: true, frame: 10 });
		player.frame = 10;
		player.advance(12);
		expect(transport.getState()).toMatchObject({ playing: false, frame: 19 });
	});

	it('follows external seeks while playing', () => {
		const { transport, player } = setup();
		transport.play(1);
		player.advance(3);
		transport.reportFrame(80); // e.g. the timeline scrubbed
		expect(player.frame).toBe(80);
	});
});

// ------------------------------------------------------------------ commands

function makeSession(): EditorSession {
	const ids = createCounterIdSource(1);
	const doc = createEmptyProject({ ids, name: 'T', preset: 'hd-1080p-30' });
	const ctx = { ids, now: () => 't', registries: defaultRegistries() };
	const { document } = applyTransaction(
		doc,
		{
			label: 'setup',
			origin: 'user',
			commands: [
				{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [1, 0, 0, 1] },
				{ type: 'clip.addText', at: 90, duration: 30, track: 'V2', content: { text: 'Hi' } },
			],
		},
		{ ...ctx, revision: 0 },
	);
	return new EditorSession({ projectId: (document as ProjectDocument).projectId, document, ctx });
}

describe('transport commands', () => {
	beforeEach(() => {
		resetCommandRegistry();
		registerCommands(transportCommands);
	});
	afterEach(() => resetCommandRegistry());

	it('steps, jumps to start/end and edit points', async () => {
		const session = makeSession();
		const ctx = createCommandContext({ engine: new EngineClient({ baseUrl: '' }), session });
		const t = session.transport;
		await runCommand('transport.stepForward', ctx);
		await runCommand('transport.stepForwardMany', ctx);
		expect(t.getState().frame).toBe(6);
		await runCommand('transport.stepBack', ctx);
		expect(t.getState().frame).toBe(5);
		await runCommand('transport.goToEnd', ctx);
		expect(t.getState().frame).toBe(120);
		await runCommand('transport.goToStart', ctx);
		await runCommand('transport.nextEdit', ctx);
		expect(t.getState().frame).toBe(60);
		await runCommand('transport.nextEdit', ctx);
		expect(t.getState().frame).toBe(90);
		await runCommand('transport.prevEditAny', ctx);
		expect(t.getState().frame).toBe(60);
		await runCommand('transport.stepBack', ctx);
		await runCommand('transport.goToStart', ctx);
		await runCommand('transport.stepBack', ctx);
		expect(t.getState().frame).toBe(0);
	});

	it('edit-point and step seeks reveal the playhead in the timeline (TL-120, WP-3I)', async () => {
		const session = makeSession();
		const services = new PanelServices();
		const revealed: number[] = [];
		services.register('timelineViewport', 'tl1', {
			scrollToFrame: (f) => revealed.push(f),
			frameAtClientX: () => 0,
			getScrollContainer: () => null,
		});
		const ctx = createCommandContext({ engine: new EngineClient({ baseUrl: '' }), session, services });
		await runCommand('transport.nextEdit', ctx);
		await runCommand('transport.goToEnd', ctx);
		expect(revealed).toEqual([60, 120]);
	});

	it('Space and JKL go through the shuttle; K keyup releases', async () => {
		const session = makeSession();
		const ctx = createCommandContext({ engine: new EngineClient({ baseUrl: '' }), session });
		const t = session.transport;
		await runCommand('transport.playStop', ctx);
		expect(t.getState()).toMatchObject({ playing: true, rate: 1 });
		await runCommand('transport.shuttleForward', ctx);
		transportCommands.find((c) => c.id === 'transport.shuttleForward')!.onKeyUp!(ctx);
		expect(t.getState().rate).toBe(2);
		await runCommand('transport.shuttleStop', ctx);
		expect(t.getState().playing).toBe(false);
		transportCommands.find((c) => c.id === 'transport.shuttleStop')!.onKeyUp!(ctx);
	});

	it('monitor key fallback only fires keyup for keys it handled itself', () => {
		const session = makeSession();
		const ctx = createCommandContext({ engine: new EngineClient({ baseUrl: '' }), session });
		const cmd = transportCommands.find((c) => c.id === 'transport.shuttleForward')!;
		const onKeyUp = vi.spyOn(cmd, 'onKeyUp');
		const ev = (defaultPrevented: boolean) => ({
			code: 'KeyL',
			ctrlKey: false,
			altKey: false,
			shiftKey: false,
			metaKey: false,
			repeat: false,
			target: null,
			defaultPrevented,
			preventDefault: () => undefined,
		});
		// The global dispatcher handled keydown (preventDefault) but not keyup: no second onKeyUp here.
		expect(handleMonitorKey(ev(true), 'down', ctx, 'program', 'linux')).toBe(false);
		expect(handleMonitorKey(ev(false), 'up', ctx, 'program', 'linux')).toBe(false);
		expect(onKeyUp).not.toHaveBeenCalled();
		// Handled by the fallback: keyup runs once.
		expect(handleMonitorKey(ev(false), 'down', ctx, 'program', 'linux')).toBe(true);
		expect(handleMonitorKey(ev(false), 'up', ctx, 'program', 'linux')).toBe(true);
		expect(onKeyUp).toHaveBeenCalledTimes(1);
		onKeyUp.mockRestore();
		session.transport.pause();
	});

	it('Play In to Out uses the mounted driver', async () => {
		const session = makeSession();
		const ctx = createCommandContext({ engine: new EngineClient({ baseUrl: '' }), session });
		const seqId = session.getState().activeSequenceId!;
		session.apply({
			label: 'io',
			origin: 'user',
			commands: [{ type: 'sequence.setInOut', sequenceId: seqId, in: 5, out: 25 }],
		});
		const driver = { playRange: vi.fn() } as unknown as PlaybackDriver;
		const off = registerDriver(session.transport, driver);
		await runCommand('transport.playInToOut', ctx);
		expect(driver.playRange).toHaveBeenCalledWith(5, 25);
		off();
	});

	it('nudges the selected layer by 1 and 5 px with one coalesced undo step (XF-023)', async () => {
		const session = makeSession();
		const ctx = createCommandContext({
			engine: new EngineClient({ baseUrl: '' }),
			session,
			focus: { panel: 'program', instanceId: 'p' },
		});
		const seqId = session.getState().activeSequenceId!;
		const text = Object.values(session.getCommitted().sequences[seqId]!.clips).find(
			(c) => c.kind === 'text',
		)!;
		session.select('timeline', [text.id]);
		session.transport.seek(100);
		const before = session.getState().history.entries.length;
		await runCommand('program.nudgeRight', ctx);
		await runCommand('program.nudgeRight', ctx);
		await runCommand('program.nudgeDownMany', ctx);
		const after = session.getCommitted().sequences[seqId]!.clips[text.id] as {
			transform: { position: { value: number[] } };
		};
		expect(after.transform.position.value).toEqual([962, 545]);
		expect(session.getState().history.entries.length).toBe(before + 1);
	});
});
