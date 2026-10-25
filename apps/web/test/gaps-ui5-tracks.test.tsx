import { EngineClient } from '@jasper/engine-client';
import type { Sequence } from '@jasper/project';
import { DialogHost } from '@jasper/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createCommandContext, getCommand, registerAllCommands } from '../src/commands/index.ts';
import { registerFindDialog, runFind } from '../src/gaps/FindDialog.tsx';
import { addTracksCommands, deleteTracksPlan } from '../src/gaps/TrackDialogs.tsx';
import { parsePresets, presetHeights, trackHeightPresets } from '../src/gaps/track-heights.ts';
import { MENUBAR } from '../src/shell/menus/model.ts';
import { resolveMenu } from '../src/shell/menus/resolve.ts';
import { makeSession, videoAsset } from './timeline-helpers.ts';

beforeAll(() => registerAllCommands());
afterEach(() => cleanup());

const engine = new EngineClient({
	baseUrl: 'http://127.0.0.1:9',
	fetch: (async () => new Response('{}')) as typeof fetch,
});

function withClips() {
	const { session, seqId } = makeSession();
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{ type: 'media.register', asset: videoAsset(10), ref: '$m1' },
			{ type: 'media.register', asset: videoAsset(10), ref: '$m2' },
			{ type: 'clip.place', source: { mediaId: '$m1' }, at: 0 },
			{ type: 'clip.place', source: { mediaId: '$m2' }, at: 300 },
			{ type: 'marker.add', frame: 120, name: 'Chorus' },
		] as never[],
	});
	expect(r.ok).toBe(true);
	return { session, seqId, seq: () => session.getCommitted().sequences[seqId] as Sequence };
}

describe('menus', () => {
	it('shows File ▸ Exit only in the desktop app', () => {
		const ctx = createCommandContext({ engine });
		const file = MENUBAR.find((m) => m.id === 'file')!.items;
		const web = resolveMenu(file, { ctx, platform: 'linux', runtime: 'web', run: () => {} });
		const desk = resolveMenu(file, { ctx, platform: 'linux', runtime: 'desktop', run: () => {} });
		expect(web.some((i) => i.id === 'app.quit')).toBe(false);
		expect(desk.some((i) => i.id === 'app.quit')).toBe(true);
	});
});

describe('Find', () => {
	it('Find steps through timeline hits and moves the playhead; Find All selects every clip', () => {
		const { session, seqId, seq } = withClips();
		const clips = Object.values(seq().clips).filter((c) => c.kind === 'video');
		session.apply({
			label: 'n',
			origin: 'user',
			sequenceId: seqId,
			commands: [{ type: 'clip.update', clipId: clips[1]!.id, patch: { name: 'Hero shot' } }] as never[],
		});
		const seek = (frame: number) => session.transport.seek(frame);
		const cursor = { key: null as string | null };
		const q = {
			criteria: [{ field: 'any', operator: 'contains' as const, value: 'o' }],
			match: 'any' as const,
		};
		const props = { session, scope: 'timeline' as const, sequenceId: seqId, seek };
		runFind(props, q, 'next', cursor);
		expect(session.transport.getState().frame).toBe(120);
		runFind(props, q, 'next', cursor);
		expect(session.transport.getState().frame).toBe(300);
		expect(session.getState().selection.timeline.clips).toContain(clips[1]!.id);
		runFind(props, { criteria: [{ field: 'clipName', operator: 'contains', value: 'clip' }] }, 'all', {
			key: null,
		});
		expect(new Set(session.getState().selection.timeline.clips)).toEqual(new Set(Object.keys(seq().clips)));
	});

	it('the dialog runs Find from its fields', () => {
		const { session } = withClips();
		registerFindDialog();
		render(<DialogHost />);
		act(() => {
			void getCommand('edit.find')!.run(
				createCommandContext({
					engine,
					session,
					openDialog: (kind, props) => void import('@jasper/ui').then((m) => m.openDialog(kind, props)),
				}),
			);
		});
		return screen.findByTestId('find-dialog').then(() => {
			fireEvent.change(screen.getByTestId('find-value-0'), { target: { value: 'clip' } });
			fireEvent.click(screen.getByText('Find'));
			expect(session.getState().selection.project.items).toHaveLength(1);
			expect(session.getCommitted().items[session.getState().selection.project.items[0]!]!.name).toContain(
				'clip',
			);
		});
	});
});

describe('Add / Delete Tracks', () => {
	it('adds tracks at chosen positions with audio formats in one undoable transaction', () => {
		const { session, seq } = withClips();
		const cmds = addTracksCommands(seq(), {
			video: { count: 2, index: 0 },
			audio: { count: 1, index: 99, type: '5.1' },
			submix: { count: 1, index: 0, type: 'stereo' },
		});
		const r = session.apply({
			label: 'Add Tracks',
			origin: 'user',
			sequenceId: seq().id,
			commands: cmds as never[],
		});
		expect(r.ok).toBe(true);
		expect(seq().videoTracks).toHaveLength(5);
		expect(seq().audioTracks.at(-1)!.channelFormat).toBe('5.1');
		expect(seq().submixTracks).toHaveLength(1);
		const v1clip = Object.values(seq().clips).find((c) => c.kind === 'video')!;
		expect(seq().videoTracks.findIndex((t) => t.id === v1clip.trackId)).toBe(2);
		session.undo();
		expect(seq().videoTracks).toHaveLength(3);
	});

	it('delete plans: empty tracks keep one track, named tracks report their clips, last track refused', () => {
		const { seq } = withClips();
		const s = seq();
		const empty = deleteTracksPlan(s, {
			video: { enabled: true, target: 'empty' },
			audio: { enabled: false, target: 'empty' },
			submix: { enabled: false, target: 'unassigned' },
		});
		expect(empty.trackIds).toEqual(s.videoTracks.slice(1).map((t) => t.id));
		expect(empty.clips).toBe(0);
		const named = deleteTracksPlan(s, {
			video: { enabled: true, target: s.videoTracks[0]!.id },
			audio: { enabled: false, target: 'empty' },
			submix: { enabled: false, target: 'unassigned' },
		});
		expect(named.clips).toBe(2);
		const one = { ...s, videoTracks: [s.videoTracks[0]!] } as Sequence;
		const last = deleteTracksPlan(one, {
			video: { enabled: true, target: s.videoTracks[0]!.id },
			audio: { enabled: false, target: 'empty' },
			submix: { enabled: false, target: 'unassigned' },
		});
		expect(last.error).toMatch(/at least one/);
	});
});

describe('track height presets', () => {
	it('saves, applies by position, survives bad storage', () => {
		localStorage.removeItem('jasper:track-height-presets');
		trackHeightPresets.set([]);
		const p = trackHeightPresets.save('Tall', [108, 72], [48]);
		expect(trackHeightPresets.list()).toHaveLength(1);
		const seq = { videoTracks: [{ id: 'v1' }, { id: 'v2' }, { id: 'v3' }], audioTracks: [{ id: 'a1' }] };
		expect(presetHeights(p, seq, { v3: 20 })).toEqual({ v1: 108, v2: 72, v3: 20, a1: 48 });
		expect(parsePresets('nope')).toEqual([]);
		expect(parsePresets([{ id: 'x', name: 'n', video: [9999, 'a'], audio: null }])).toEqual([
			{ id: 'x', name: 'n', video: [240, 32], audio: [] },
		]);
		trackHeightPresets.rename(p.id, 'Taller');
		expect(trackHeightPresets.list()[0]!.name).toBe('Taller');
		trackHeightPresets.remove(p.id);
		expect(trackHeightPresets.list()).toEqual([]);
	});
});
