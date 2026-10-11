import { EngineClient } from '@jasper/engine-client';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createCommandContext, registerAllCommands, runCommand } from '../src/commands/index.ts';
import { TrimMonitor } from '../src/panels/program/TrimMonitor.tsx';
import { patchedLabelOn, resolvePatch, setPatch, sourceTracksOf } from '../src/panels/source/patching.ts';
import { registerTimelineInstance } from '../src/panels/timeline/env.tsx';
import { exitTrimMode, trimMode } from '../src/panels/timeline/state/trim-mode.ts';
import { setupTimeline, solid, videoAsset } from './timeline-helpers.ts';

beforeAll(() => registerAllCommands());
const offs: (() => void)[] = [];
afterEach(() => {
	cleanup();
	for (const o of offs.splice(0)) o();
	exitTrimMode();
});
const engine = new EngineClient({ fetch: (async () => new Response('{}')) as unknown as typeof fetch });

function harness() {
	const t = setupTimeline({ pxPerFrame: 4 });
	offs.push(
		registerTimelineInstance({
			instanceId: 'tm',
			controller: t.controller,
			ui: t.ui,
			sequenceId: () => t.seqId,
			cancelGesture: () => t.controller.cancel(),
		}),
	);
	t.apply([solid(0, 100, 'V1'), solid(100, 150, 'V1')]);
	const b = t.clipsOn('V1')[1]!.id;
	t.apply([{ type: 'clip.trim', clipId: b, edge: 'in', deltaFrames: 50 }]);
	t.apply([{ type: 'clip.move', clipIds: [b], deltaFrames: -50 }]);
	const ctx = createCommandContext({
		engine,
		session: t.session,
		focus: { panel: 'timeline', instanceId: 'tm' },
	});
	return { ...t, ctx };
}

describe('Trim Monitor', () => {
	it('shows both sides with counters; buttons, numeric entry and the roll strip trim', async () => {
		const h = harness();
		h.session.transport.seek(100);
		await runCommand('timeline.trimEdit', h.ctx);
		render(
			<SessionProvider session={h.session}>
				<TrimMonitor session={h.session} sequenceId={h.seqId} ctx={h.ctx} />
			</SessionProvider>,
		);
		expect(screen.getByTestId('trim-monitor').dataset.trimType).toBe('roll');
		expect(screen.getByTestId('trim-monitor-outgoing')).toBeTruthy();
		expect(screen.getByTestId('trim-monitor-incoming')).toBeTruthy();
		await act(async () => {
			fireEvent.click(screen.getByTestId('trim-btn-forward-many'));
		});
		expect(h.spans('V1')).toEqual([
			[0, 105],
			[105, 200],
		]);
		expect(screen.getByTestId('trim-monitor-out-shift').textContent).toBe('+5');
		expect(screen.getByTestId('trim-monitor-in-shift').textContent).toBe('+5');
		await act(async () => {
			await runCommand('timeline.trimNumericEntry', h.ctx, { sign: -1 });
		});
		const field = screen.getByTestId('trim-numeric') as HTMLInputElement;
		act(() => {
			fireEvent.change(field, { target: { value: '-7' } });
			fireEvent.keyDown(field, { key: 'Enter' });
		});
		expect(h.spans('V1')[0]).toEqual([0, 98]);
		expect(trimMode.getState().numeric).toBeNull();
		const n = h.history().length;
		const strip = screen.getByTestId('trim-monitor-roll');
		act(() => {
			fireEvent.pointerDown(strip, { button: 0, clientX: 100, pointerId: 1 });
			fireEvent.pointerMove(strip, { clientX: 140, pointerId: 1 });
			fireEvent.pointerUp(strip, { clientX: 140, pointerId: 1 });
		});
		expect(h.spans('V1')[0]).toEqual([0, 108]);
		expect(h.history().length).toBe(n + 1);
	});
});

describe('source patching', () => {
	it('defaults to the same tracks; patches and switches off; the header label follows', () => {
		const h = harness();
		const r = h.apply([{ type: 'media.register', asset: videoAsset(10) }]);
		const mediaId = (r.results[0] as { mediaId: string }).mediaId;
		const doc = h.session.getCommitted();
		const item = Object.values(doc.items).find((i) => i.kind === 'media' && i.mediaId === mediaId)!;
		const counts = sourceTracksOf(doc, item);
		expect(counts).toEqual({ video: 1, audio: 1 });
		const seq = h.seq();
		const view = () => h.session.getState().views[h.seqId];
		expect(resolvePatch(seq, view(), counts)).toEqual({
			video: [seq.videoTracks[0]!.id],
			audio: [seq.audioTracks[0]!.id],
		});
		setPatch(h.session, h.seqId, 'V1', seq.videoTracks[1]!.id);
		setPatch(h.session, h.seqId, 'A1', null);
		expect(resolvePatch(seq, view(), counts)).toEqual({ video: [seq.videoTracks[1]!.id], audio: [null] });
		expect(patchedLabelOn(seq, view(), counts, seq.videoTracks[1]!.id)).toEqual({ label: 'V1', on: true });
		expect(patchedLabelOn(seq, view(), counts, seq.audioTracks[0]!.id)).toEqual({ label: 'A1', on: false });
	});
});
