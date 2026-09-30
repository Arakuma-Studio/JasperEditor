// Component tests for the Timeline and Tools panels (happy-dom): virtualization on a 3 000-clip /
// 40-track sequence, playhead moves without React re-renders (TL-155), tool switching by key.
import { EngineClient } from '@jasper/engine-client';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	createCommandContext,
	registerAllCommands,
	resolveBindings,
	runCommand,
	scopeChain,
} from '../src/commands/index.ts';
import { activeTimeline, TimelineEnvProvider } from '../src/panels/timeline/env.tsx';
import { TimelinePanel } from '../src/panels/timeline/TimelinePanel.tsx';
import { ToolsPanel } from '../src/panels/tools/ToolsPanel.tsx';
import { makeSession, solid } from './timeline-helpers.ts';

beforeAll(() => registerAllCommands());
afterEach(() => cleanup());

function bigSession() {
	const { session, seqId } = makeSession();
	session.apply({
		label: 'tracks',
		origin: 'user',
		sequenceId: seqId,
		commands: [{ type: 'track.add', kind: 'video', count: 37 }] as never[],
	});
	const commands: unknown[] = [];
	for (let t = 0; t < 40; t++)
		for (let i = 0; i < 75; i++) commands.push(solid(i * 25 + (t % 5), 20, `V${t + 1}`));
	const r = session.apply({
		label: 'fill',
		origin: 'user',
		sequenceId: seqId,
		commands: commands as never[],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors.slice(0, 2)));
	return { session, seqId };
}

describe('Timeline panel rendering', () => {
	it('renders 3 000 clips on 40 tracks with virtualization; the playhead moves without React re-renders', async () => {
		const { session, seqId } = bigSession();
		expect(Object.keys(session.getCommitted().sequences[seqId]!.clips)).toHaveLength(3000);
		let commits = 0;
		render(
			<SessionProvider session={session}>
				<Profiler id="timeline" onRender={() => commits++}>
					<TimelinePanel instanceId="timeline-1" visible />
				</Profiler>
			</SessionProvider>,
		);
		const mounted = document.querySelectorAll('[data-clip-id]').length;
		expect(mounted).toBeGreaterThan(0);
		expect(mounted).toBeLessThan(600);
		const playhead = screen.getByTestId('timeline-playhead');
		const before = commits;
		const t0 = playhead.style.transform;
		await act(async () => {
			for (let i = 1; i <= 120; i++) session.transport.seek(i * 3);
		});
		expect(commits).toBe(before);
		expect(playhead.style.transform).not.toBe(t0);
		expect(playhead.style.transform).toBe(`translateX(${360 * 2}px)`);
		expect(screen.getByTestId('timeline-timecode').textContent).toBe('00:00:12:00');
	}, 60_000);

	it('scrolling mounts a different window of clips (TL-151)', async () => {
		const { session, seqId } = bigSession();
		render(
			<SessionProvider session={session}>
				<TimelinePanel instanceId="timeline-2" visible />
			</SessionProvider>,
		);
		const ids = () =>
			new Set([...document.querySelectorAll('[data-clip-id]')].map((e) => e.getAttribute('data-clip-id')));
		const a = ids();
		await act(async () => session.setView(seqId, { scrollFrame: 1500 }));
		const b = ids();
		expect([...b].some((id) => !a.has(id))).toBe(true);
	}, 60_000);

	it('shows the empty state without a session', () => {
		render(<TimelinePanel instanceId="t" visible />);
		expect(screen.getByTestId('timeline-empty')).toBeTruthy();
	});

	it('draws engine badges, linked suffixes and the render bar from the model', async () => {
		const { session, seqId } = makeSession();
		session.apply({
			label: 'x',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{ type: 'clip.addText', at: 0, duration: 120, track: 'V2', content: { text: 'Hello' } },
				solid(0, 60, 'V1'),
			] as never[],
		});
		render(
			<SessionProvider session={session}>
				<TimelinePanel instanceId="timeline-3" visible />
			</SessionProvider>,
		);
		expect(document.querySelector('[data-engine-badge="R"]')).toBeTruthy();
		const bar = screen.getByTestId('timeline-render-bar');
		expect(bar.querySelectorAll('[data-render-state="yellow"]').length).toBeGreaterThan(0);
	});
});

describe('Timeline panel gesture lifecycle', () => {
	function startMoveDrag(session: ReturnType<typeof makeSession>['session']) {
		const handle = activeTimeline()!;
		const c = handle.controller;
		const { viewport, layout } = c.env.geometry();
		const row = layout.video.rows.find((r) => r.index === 0)!; // V1
		const y = row.y + row.height / 2;
		const x = (10 - viewport.scrollFrame) * viewport.pxPerFrame;
		const mods = { shift: false, ctrl: false, alt: false, button: 0 };
		act(() => {
			c.pointerDown({ x, y, ...mods });
			c.pointerMove({ x: x + 60, y, ...mods });
		});
		expect(session.getState().gesture).not.toBeNull();
		return { handle, x, y, mods };
	}

	it('keeps the same controller when the shell re-renders the env provider mid-drag', () => {
		const { session, seqId } = makeSession();
		session.apply({
			label: 'x',
			origin: 'user',
			sequenceId: seqId,
			commands: [solid(0, 60, 'V1')] as never[],
		});
		const shell = () => (
			<SessionProvider session={session}>
				{/* inline value: a new object on every shell render */}
				<TimelineEnvProvider value={{ toast: () => {} }}>
					<TimelinePanel instanceId="timeline-life-1" visible />
				</TimelineEnvProvider>
			</SessionProvider>
		);
		const { rerender } = render(shell());
		const { handle, x, y, mods } = startMoveDrag(session);
		rerender(shell());
		expect(activeTimeline()!.controller).toBe(handle.controller);
		const n = session.getState().history.entries.length;
		act(() => handle.controller.pointerUp({ x: x + 60, y, ...mods }));
		expect(session.getState().gesture).toBeNull();
		expect(session.getState().history.entries.length).toBe(n + 1);
	});

	it('unmounting during a drag cancels the session gesture', () => {
		const { session, seqId } = makeSession();
		session.apply({
			label: 'x',
			origin: 'user',
			sequenceId: seqId,
			commands: [solid(0, 60, 'V1')] as never[],
		});
		const n = session.getState().history.entries.length;
		const { unmount } = render(
			<SessionProvider session={session}>
				<TimelinePanel instanceId="timeline-life-2" visible />
			</SessionProvider>,
		);
		startMoveDrag(session);
		unmount();
		expect(session.getState().gesture).toBeNull();
		expect(session.getState().history.entries.length).toBe(n);
		expect(() => session.beginGesture('next').cancel()).not.toThrow();
	});
});

describe('Tools panel (S05:TOOL-001…005)', () => {
	const engine = new EngineClient({ fetch: (async () => new Response('{}')) as unknown as typeof fetch });

	it('switches tools with V/A/B/N/R/C/Y/U/P/H/Z/T through the keymap and reflects the active tool', async () => {
		const { session } = makeSession();
		render(
			<SessionProvider session={session}>
				<ToolsPanel instanceId="tools-1" visible />
			</SessionProvider>,
		);
		const ctx = createCommandContext({ engine, session, focus: { panel: 'tools', instanceId: 'tools-1' } });
		const keys: [string, string][] = [
			['KeyC', 'razor'],
			['KeyA', 'trackSelectForward'],
			['Shift+KeyA', 'trackSelectBackward'],
			['KeyB', 'ripple'],
			['KeyN', 'rolling'],
			['KeyR', 'rateStretch'],
			['KeyY', 'slip'],
			['KeyU', 'slide'],
			['KeyP', 'pen'],
			['KeyH', 'hand'],
			['KeyZ', 'zoom'],
			['KeyT', 'type'],
			['KeyV', 'selection'],
		];
		for (const [chord, tool] of keys) {
			const b = resolveBindings(chord, scopeChain('tools'), { platform: 'linux', runtime: 'desktop' });
			expect(b[0]?.command, chord).toBe(`tool.${tool}`);
			await act(async () => {
				await runCommand(b[0]!.command, ctx);
			});
			expect(session.getState().toggles.activeTool).toBe(tool);
			const pressed = document.querySelector('[data-tool][aria-pressed="true"]');
			expect(pressed?.getAttribute('data-tool')).toBe(tool);
		}
	});

	it('clicking a button selects the tool; right-click opens the group flyout', async () => {
		const { session } = makeSession();
		render(
			<SessionProvider session={session}>
				<ToolsPanel instanceId="tools-2" visible />
			</SessionProvider>,
		);
		const razor = document.querySelector('[data-tool="razor"]') as HTMLElement;
		fireEvent.click(razor);
		expect(session.getState().toggles.activeTool).toBe('razor');
		const ripple = document.querySelector('[data-tool="ripple"]') as HTMLElement;
		fireEvent.contextMenu(ripple);
		expect(screen.getByTestId('tools-flyout')).toBeTruthy();
		fireEvent.click(document.querySelector('[data-tool-option="rolling"]') as HTMLElement);
		expect(session.getState().toggles.activeTool).toBe('rolling');
		expect(document.querySelector('[data-tool="rolling"]')).toBeTruthy();
	});
});
