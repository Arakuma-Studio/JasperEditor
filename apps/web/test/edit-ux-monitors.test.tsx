import { EngineClient } from '@jasper/engine-client';
import { TransportStore } from '@jasper/session';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCommandContext, registerAllCommands, runCommand } from '../src/commands/index.ts';
import { parseGuidePosition } from '../src/panels/program/guide-dialogs.tsx';
import {
	addGuide,
	applyGuideTemplate,
	clearGuides,
	guidesOf,
	monitorExtras,
	moveGuide,
	parseMonitorExtras,
	removeGuide,
	saveGuidesAsTemplate,
} from '../src/panels/program/monitor-view.ts';
import { PlaybackDriver, type PlayerLike } from '../src/panels/program/playback-driver.ts';
import { TransportBar } from '../src/panels/program/TransportBar.tsx';
import { makeSession } from './timeline-helpers.ts';

beforeAll(() => registerAllCommands());
beforeEach(() => monitorExtras.setState(parseMonitorExtras({})));
afterEach(() => cleanup());

const engine = new EngineClient({ fetch: (async () => new Response('{}')) as unknown as typeof fetch });

describe('guides', () => {
	it('guide edits and templates survive persisted preference parsing', () => {
		const g = addGuide('seq_a', { orientation: 'vertical', position: 960.123 });
		moveGuide('seq_a', g.id, 100);
		expect(guidesOf('seq_a')[0]!.position).toBe(100);
		addGuide('seq_a', { orientation: 'horizontal', position: 540 });
		expect(saveGuidesAsTemplate('seq_a', 'Mine')).toBeNull();
		expect(saveGuidesAsTemplate('seq_a', 'Center Cross')).toMatch(/built-in/);
		removeGuide('seq_a', g.id);
		expect(guidesOf('seq_a')).toHaveLength(1);
		clearGuides('seq_a');
		expect(guidesOf('seq_a')).toEqual([]);
		expect(applyGuideTemplate('seq_a', 'Rule of Thirds', 1920, 1080)).toBe(true);
		expect(guidesOf('seq_a').map((x) => [x.orientation, x.position])).toEqual([
			['vertical', 640],
			['vertical', 1280],
			['horizontal', 360],
			['horizontal', 720],
		]);
		const re = parseMonitorExtras(JSON.parse(JSON.stringify(monitorExtras.getState())));
		expect(re.guides.seq_a).toHaveLength(4);
		expect(re.templates.map((x) => x.name)).toEqual(['Mine']);
		expect(
			parseMonitorExtras({ guides: { s: [{ orientation: 'diagonal', position: 1 }] } }).guides.s,
		).toEqual([]);
	});

	it('accepts guide positions in px or percent and refuses invalid positions', () => {
		expect(parseGuidePosition('50%', 1080)).toBe(540);
		expect(parseGuidePosition('120', 1080)).toBe(120);
		expect(parseGuidePosition('2000', 1080)).toBeNull();
		expect(parseGuidePosition('abc', 1080)).toBeNull();
	});
});

describe('comparison view', () => {
	it('toggling the comparison view sets the reference to the playhead', async () => {
		const { session, seqId } = makeSession();
		session.transport.seek(42);
		const ctx = createCommandContext({ engine, session, focus: { panel: 'program', instanceId: 'p' } });
		await runCommand('program.toggleComparisonView', ctx);
		expect(monitorExtras.getState().comparison).toMatchObject({
			enabled: true,
			reference: { kind: 'sequence-frame', sequenceId: seqId, frame: 42 },
		});
	});
});

describe('dropped frames', () => {
	it('counts frames skipped during native playback and resets on play', () => {
		const transport = new TransportStore();
		const counts: number[] = [];
		const listeners = new Map<string, (e: { detail: unknown }) => void>();
		const player: PlayerLike = {
			seekTo: () => {},
			play: () => {},
			pause: () => {},
			getCurrentFrame: () => 0,
			isPlaying: () => true,
			mute: () => {},
			unmute: () => {},
			addEventListener: (n, cb) => listeners.set(n, cb),
			removeEventListener: (n) => listeners.delete(n),
		};
		const driver = new PlaybackDriver({
			transport,
			getFps: () => 30,
			getRange: () => ({ end: 1000, loopStart: 0, loopEnd: 1000 }),
			setPlayerRate: () => {},
			onDroppedFrames: (n) => counts.push(n),
		});
		transport.attachPlayer(driver);
		driver.setPlayer(player);
		transport.play(1);
		const frame = (f: number) => listeners.get('frameupdate')!({ detail: { frame: f } });
		frame(1);
		frame(2);
		frame(5);
		frame(6);
		frame(9);
		expect(driver.droppedFrames).toBe(4);
		expect(counts.at(-1)).toBe(4);
		transport.pause();
		transport.play(1);
		expect(driver.droppedFrames).toBe(0);
		driver.dispose();
	});
});

describe('Button Editor', () => {
	it('adds, removes and resets the Program transport buttons', () => {
		const { session } = makeSession();
		const ctx = createCommandContext({ engine, session, focus: { panel: 'program', instanceId: 'p' } });
		render(<TransportBar monitor="program" ctx={() => ctx} playing={false} testId="bar" />);
		expect(screen.getByTestId('btn-mark-in')).toBeTruthy();
		fireEvent.click(screen.getByTestId('program-button-editor'));
		act(() => {
			fireEvent.click(screen.getByTestId('program-palette-matchFrame'));
		});
		expect(monitorExtras.getState().buttons.program).toContain('matchFrame');
		expect(screen.getByTestId('program-btn-matchFrame')).toBeTruthy();
		act(() => {
			fireEvent.click(screen.getByTestId('program-btn-remove-lift'));
		});
		expect(monitorExtras.getState().buttons.program).not.toContain('lift');
		act(() => {
			fireEvent.click(screen.getByTestId('program-button-editor-reset'));
		});
		expect(monitorExtras.getState().buttons.program).toBeNull();
	});

	it('buttons run their commands (Mark In on the sequence)', async () => {
		const { session, seqId } = makeSession();
		const ctx = createCommandContext({ engine, session, focus: { panel: 'program', instanceId: 'p' } });
		render(<TransportBar monitor="program" ctx={() => ctx} playing={false} testId="bar" />);
		session.transport.seek(12);
		await act(async () => {
			fireEvent.click(screen.getByTestId('btn-mark-in'));
		});
		expect(session.getCommitted().sequences[seqId]!.inPoint).toBe(12);
	});
});

describe('monitor commands', () => {
	it('toggles ruler, guide-lock and dropped-frame preferences', async () => {
		const { session } = makeSession();
		monitorExtras.setState({ showRulers: false, lockGuides: false, showDroppedFrames: false });
		const ctx = createCommandContext({ engine, session, focus: { panel: 'program', instanceId: 'p' } });
		await runCommand('program.showRulers', ctx);
		await runCommand('program.lockGuides', ctx);
		await runCommand('program.toggleDroppedFrames', ctx);
		expect(monitorExtras.getState()).toMatchObject({
			showRulers: true,
			lockGuides: true,
			showDroppedFrames: true,
		});
	});
});
