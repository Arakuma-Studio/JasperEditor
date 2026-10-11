import { createCounterIdSource, createEmptyProject, defaultRegistries } from '@jasper/project';
import { EditorSession, MemoryProjectStore } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AudioClipMixerPanel } from '../src/panels/audioClipMixer/AudioClipMixerPanel.tsx';
import { AudioMetersPanel } from '../src/panels/audioMeters/AudioMetersPanel.tsx';
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
	it('the Audio Track Mixer shows a strip per track plus the Mix and adds submixes', async () => {
		const session = await openSession();
		const r = render(
			<SessionProvider session={session}>
				<AudioTrackMixerPanel instanceId="m" visible />
			</SessionProvider>,
		);
		expect(r.getByTestId('mixer-strip-A1')).toBeTruthy();
		expect(r.getByTestId('mixer-strip-Mix')).toBeTruthy();
		await act(async () => {
			fireEvent.click(r.getByTestId('mixer-add-submix'));
		});
		expect(r.getByTestId('mixer-strip-S1')).toBeTruthy();
		const seq = Object.values(session.getCommitted().sequences)[0]!;
		expect(seq.submixTracks?.length).toBe(1);
		await act(async () => {
			fireEvent.click(r.getAllByTestId('mixer-mute')[0]!);
		});
		expect(Object.values(session.getCommitted().sequences)[0]!.audioTracks[0]!.mute).toBe(true);
		r.unmount();
	});

	it('+ Effect builds its menu only when it opens, and inserts the chosen effect on the strip (wp fixups)', async () => {
		const session = await openSession();
		const r = render(
			<SessionProvider session={session}>
				<AudioTrackMixerPanel instanceId="m" visible />
			</SessionProvider>,
		);
		expect(document.querySelectorAll('[data-command-id^="mixer-fx-"]')).toHaveLength(0);
		const trigger = r.getByTestId('mixer-add-effect-A1');
		await act(async () => {
			fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
		});
		expect(JSON.stringify(Object.values(session.getCommitted().sequences)[0])).not.toContain('"effectId"');
		const items = document.querySelectorAll<HTMLElement>('[data-command-id^="mixer-fx-"]');
		const audio = session.ctx.registries.effects.list().filter((e) => e.appliesTo === 'audio');
		expect(items).toHaveLength(audio.length);
		await act(async () => {
			fireEvent.click(items[0]!);
		});
		expect(JSON.stringify(Object.values(session.getCommitted().sequences)[0])).toContain(`"${audio[0]!.id}"`);
		expect(r.getByTestId('mixer-strip-A1').textContent).toContain(audio[0]!.label);
		r.unmount();
	});

	it('the Audio Clip Mixer and Audio Meters render', async () => {
		const session = await openSession();
		const r = render(
			<SessionProvider session={session}>
				<AudioClipMixerPanel instanceId="c" visible />
				<AudioMetersPanel instanceId="a" visible />
			</SessionProvider>,
		);
		expect(r.getByTestId('clip-mixer-strip-A1')).toBeTruthy();
		expect(r.getByTestId('audio-meters-loudness').textContent).toContain('LRA');
		r.unmount();
	});
});
