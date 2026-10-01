// Component tests for the Timeline and Tools panels (happy-dom): virtualization on a 3 000-clip /
// 40-track sequence, playhead moves without React re-renders (TL-155), tool switching by key.
import { EngineClient } from '@jasper/engine-client';
import { checkInvariants } from '@jasper/project';
import { EditorSession } from '@jasper/session';
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
import { TimelinePanel } from '../src/panels/timeline/TimelinePanel.tsx';
import { ToolsPanel } from '../src/panels/tools/ToolsPanel.tsx';
import { makeSession, solid } from './timeline-helpers.ts';

beforeAll(() => registerAllCommands());
afterEach(() => cleanup());

function bigSession() {
	const { session, seqId } = makeSession();
	const r = session.apply({
		label: 'fixture',
		origin: 'user',
		sequenceId: seqId,
		commands: [{ type: 'track.add', kind: 'video', count: 37 }, solid(0, 20, 'V1')] as never[],
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	// Rendering needs a large valid document; thousands of placement commands only repeat handler work.
	const document = structuredClone(session.getCommitted());
	const seq = document.sequences[seqId]!;
	const template = Object.values(seq.clips)[0]!;
	seq.clips = {};
	for (let t = 0; t < seq.videoTracks.length; t++) {
		for (let i = 0; i < 75; i++) {
			const id = session.ctx.ids.next('clp');
			seq.clips[id] = {
				...structuredClone(template),
				id,
				trackId: seq.videoTracks[t]!.id,
				start: i * 25 + (t % 5),
			};
		}
	}
	expect(checkInvariants(document)).toEqual([]);
	return {
		session: new EditorSession({ projectId: document.projectId, document, ctx: session.ctx }),
		seqId,
	};
}

describe('Timeline panel rendering', () => {
	it('virtualizes and scrolls 3 000 clips on 40 tracks; the playhead moves without React re-renders', async () => {
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
		expect(screen.getByTestId('timeline-timecode').textContent).toBe('00:00:12:00');

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
