// "Hear proposal" in the Program monitor (spec 12 §2.5, P3-R4): with it on, the monitor's document is the proposal's
// preview (picture AND sound: the render document the Player and its audio graph get), the session's document and
// History stay untouched, and switching keeps every unchanged clip's render object (so the Player keeps its media
// players and playback goes on).
import { proposalsFor } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { registerAllCommands } from '../src/commands/index.ts';
import { ProgramMonitor } from '../src/panels/program/ProgramMonitor.tsx';
import { buildProgramDoc } from '../src/panels/program/render-doc.ts';
import { proposalFixture } from './proposal-helpers.ts';

beforeAll(() => registerAllCommands());
afterEach(() => cleanup());

describe('Hear proposal', () => {
	it('the Program monitor plays the preview document while it is on; the session document is untouched', async () => {
		const f = await proposalFixture();
		const c = proposalsFor(f.session);
		render(
			<SessionProvider session={f.session}>
				<ProgramMonitor instanceId="program-1" visible />
			</SessionProvider>,
		);
		const committed = f.session.getCommitted();
		const duration = () => screen.getByTestId('program-duration').textContent;
		// the sequence ends at 4 s (the solid and the sound); the proposal moves the sound to 400 → ends past 17 s
		expect(duration()).toBe('00:00:04:00');
		expect(screen.queryByTestId('proposal-hear-chip')).toBeNull();
		act(() => c.setHear(true));
		expect(duration()).toBe('00:00:17:10');
		expect(screen.getByTestId('proposal-hear-chip').textContent).toBe('Hearing proposal: Sound pass');
		expect(f.session.getCommitted()).toBe(committed);
		expect(f.session.getState().history.entries.map((e) => e.label)).toEqual(['setup']);
		// a gesture draws its own transient: the monitor shows it, not the proposal
		const g = f.session.beginGesture('drag');
		act(() => g.update([{ type: 'marker.add', frame: 5, name: 'x' }] as never[]));
		expect(duration()).toBe('00:00:04:00');
		act(() => g.cancel());
		expect(duration()).toBe('00:00:17:10');
		act(() => c.setHear(false));
		expect(duration()).toBe('00:00:04:00');
		expect(screen.queryByTestId('proposal-hear-chip')).toBeNull();
	});

	it('the render document carries the proposal audio, and A/B switching keeps the unchanged clips', async () => {
		const f = await proposalFixture();
		const c = proposalsFor(f.session);
		const media = {};
		const a = buildProgramDoc({ doc: f.session.getCommitted(), sequenceId: f.seqId, media }, null);
		c.setHear(true);
		const heard = c.getState().preview!.document;
		const b = buildProgramDoc({ doc: heard, sequenceId: f.seqId, media }, a);
		const ids = (d: typeof a) => d.audioClips.map((x) => x.clipId).sort();
		const created = c.getState().preview!.result.items;
		const hit = created.hit!.created.find((id) => heard.sequences[f.seqId]!.clips[id])!;
		const boom = created.boom!.created.find((id) => heard.sequences[f.seqId]!.clips[id])!;
		expect(ids(a)).toEqual([f.bed.id]);
		expect(ids(b)).toEqual([f.bed.id, hit, boom].sort());
		// the solid on V1 is the same render object in A and B (unchanged clips keep their Player state)
		const solid = (d: typeof a) => d.videoTracks.flatMap((t) => t.clips)[0]!;
		expect(solid(b)).toBe(solid(a));
		const back = buildProgramDoc({ doc: f.session.getCommitted(), sequenceId: f.seqId, media }, b);
		expect(solid(back)).toBe(solid(a));
		expect(ids(back)).toEqual([f.bed.id]);
		// recomputing the preview (a document change elsewhere) keeps the proposal's clips on the same ids
		f.session.apply({
			label: 'Marker',
			origin: 'user',
			sequenceId: f.seqId,
			commands: [{ type: 'marker.add', frame: 3, name: 'm' }] as never[],
		});
		f.flush();
		const again = c.getState().preview!;
		expect(again.document).not.toBe(heard);
		expect(again.result.items.hit!.created).toEqual(created.hit!.created);
	});
});
