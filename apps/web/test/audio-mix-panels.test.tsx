import { createCounterIdSource, createEmptyProject, defaultRegistries } from '@jasper/project';
import { EditorSession, MemoryProjectStore } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AudioTrackMixerPanel } from '../src/panels/audioTrackMixer/AudioTrackMixerPanel.tsx';

async function openSession() {
	const ids = createCounterIdSource(5);
	const store = new MemoryProjectStore({ ids });
	const doc = createEmptyProject({ ids, name: 'Mix', preset: 'hd-1080p-30' });
	store.put(doc);
	return EditorSession.open({
		store,
		projectId: doc.projectId,
		ctx: { ids, now: () => 't', registries: defaultRegistries() },
	});
}

describe('audio panels', () => {
	it('the Audio Track Mixer adds submixes and mutes a track', async () => {
		const session = await openSession();
		const r = render(
			<SessionProvider session={session}>
				<AudioTrackMixerPanel instanceId="m" visible />
			</SessionProvider>,
		);
		await act(async () => {
			fireEvent.click(r.getByTestId('mixer-add-submix'));
		});
		const seq = Object.values(session.getCommitted().sequences)[0]!;
		expect(seq.submixTracks?.length).toBe(1);
		await act(async () => {
			fireEvent.click(r.getAllByTestId('mixer-mute')[0]!);
		});
		expect(Object.values(session.getCommitted().sequences)[0]!.audioTracks[0]!.mute).toBe(true);
		r.unmount();
	});

	it('+ Effect inserts the chosen effect on the track', async () => {
		const session = await openSession();
		const r = render(
			<SessionProvider session={session}>
				<AudioTrackMixerPanel instanceId="m" visible />
			</SessionProvider>,
		);
		const trigger = r.getByTestId('mixer-add-effect-A1');
		await act(async () => {
			fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
		});
		const item = document.querySelector<HTMLElement>('[data-command-id="mixer-fx-jasper.audio.amplify"]')!;
		await act(async () => {
			fireEvent.click(item);
		});
		expect(Object.values(session.getCommitted().sequences)[0]!.audioTracks[0]!.effects).toEqual([
			expect.objectContaining({ effectId: 'jasper.audio.amplify' }),
		]);
		r.unmount();
	});
});
