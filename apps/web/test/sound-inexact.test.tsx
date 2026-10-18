// A library sound the engine registered as it is, not as a sample-exact copy (WP6.5b `inexact`: over 1 h, a copy over
// the size cap, or not enough free disk; final carry-over cleanup, item 3): MCP reported it, the editor said nothing.
// Now an insert warns (a toast with the engine's numbers, in the UI language), Properties ▸ Sound says so from the
// media's provenance, and the In Context audition (a transient document) stays quiet.
import type { RegisterSoundResponse } from '@jasper/api';
import { SessionProvider } from '@jasper/session/react';
import { toasts } from '@jasper/ui';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __setCatalogForTests } from '../src/i18n/runtime.ts';
import { inexactDetail, inexactReasonText } from '../src/sound/inexact.ts';
import { insertLibrarySound } from '../src/sound/insert.ts';
import { registerLibrarySounds } from '../src/sound/library-media.ts';
import { SoundSection } from '../src/sound/SoundSection.tsx';
import { registered, soundEntry } from './sound-helpers.ts';
import { makeSession } from './timeline-helpers.ts';

const MiB = 1_048_576;
const bigCopy = (e: ReturnType<typeof soundEntry>): RegisterSoundResponse => {
	const base = registered(e);
	return {
		...base,
		library: { ...base.library, inexact: { reason: 'too-large' } },
		inexact: {
			reason: 'too-large',
			message: 'A sample-exact copy would take 2500 MB (at most 2048 MB): the sound is used as it is',
			bytes: 2500 * MiB,
			maxBytes: 2048 * MiB,
		},
	};
};
const titles = () => toasts.getState().toasts.map((x) => [x.kind, x.title, x.detail]);

beforeEach(() => toasts.dismissAll());
afterEach(() => {
	cleanup();
	__setCatalogForTests('en', null);
	toasts.dismissAll();
});

describe('a sound registered as it is', () => {
	it('Insert warns with the engine numbers and keeps the reason on the media; an exact sound gives no warning', async () => {
		const { session, seqId } = makeSession();
		const e = soundEntry({ title: 'Long Rain', types: ['ambience'], peakSec: 1, durationSec: 4000 });
		const r = await insertLibrarySound(session, { registerSound: async () => bigCopy(e) }, e, { at: 30 });
		expect(titles()).toEqual([
			[
				'warning',
				'“Long Rain” is not sample-exact',
				'A sample-exact copy would take 2500 MB (at most 2048 MB): the sound is used as it is, placement exact to a frame',
			],
		]);
		const doc = session.getCommitted();
		expect(doc.media[r.mediaId]!.library!.inexact).toEqual({ reason: 'too-large' });
		expect(doc.sequences[seqId]!.clips[r.clipId]).toBeDefined();

		toasts.dismissAll();
		const ok = soundEntry({ title: 'Tick' });
		await insertLibrarySound(session, { registerSound: async () => registered(ok) }, ok, { at: 60 });
		expect(titles().filter(([k]) => k === 'warning')).toEqual([]);
	});

	it('the In Context audition registers quietly; several sounds make one toast', async () => {
		const a = soundEntry({ title: 'A', durationSec: 4000 });
		const b = soundEntry({ title: 'B', durationSec: 4000 });
		const engine = { registerSound: async (id: string) => bigCopy(id === a.id ? a : b) };
		await registerLibrarySounds(engine, 'prj_x', [a], undefined, { notifyInexact: false });
		expect(titles()).toEqual([]);
		await registerLibrarySounds(engine, 'prj_x', [a, b]);
		expect(titles()).toHaveLength(1);
		expect(titles()[0]![1]).toBe('2 sounds are not sample-exact');
		expect(titles()[0]![2]).toMatch(/^“A”, “B”: A sample-exact copy would take 2500 MB/);
	});

	it('every reason has words, with its numbers; Spanish too', () => {
		expect(inexactDetail({ reason: 'too-long', message: '', limitSeconds: 3600 })).toBe(
			'Sounds over 60 min are used as they are: placement is exact to a frame, not to the sample',
		);
		expect(inexactDetail({ reason: 'disk-space', message: '', bytes: 300 * MiB, freeBytes: 100 * MiB })).toBe(
			'Not enough free disk space for a sample-exact copy (300 MB needed, 100 MB free): the sound is used as it is, placement exact to a frame',
		);
		// without numbers (an older engine): the reason alone
		expect(inexactDetail({ reason: 'too-large', message: '' })).toBe(inexactReasonText('too-large'));
		__setCatalogForTests('es', {
			'“{0}” is not sample-exact': '«{0}» no es exacto a la muestra',
			'Not sample-exact: sounds over {0} min are used as they are (placement exact to a frame)':
				'No es exacto a la muestra: los sonidos de más de {0} min se usan tal cual (colocación exacta al fotograma)',
		});
		expect(inexactReasonText('too-long')).toBe(
			'No es exacto a la muestra: los sonidos de más de 60 min se usan tal cual (colocación exacta al fotograma)',
		);
	});

	it('Properties ▸ Sound says why the clip is not sample-exact', async () => {
		const { session, seqId } = makeSession();
		const e = soundEntry({ title: 'Long Rain', types: ['ambience'], peakSec: 1, durationSec: 4000 });
		const r = await insertLibrarySound(session, { registerSound: async () => bigCopy(e) }, e, { at: 30 });
		const clip = session.getCommitted().sequences[seqId]!.clips[r.clipId]!;
		render(
			<SessionProvider session={session}>
				<SoundSection session={session} clips={[clip]} frame={0} sequenceId={seqId} />
			</SessionProvider>,
		);
		expect(screen.getByTestId('sound-section-inexact').textContent).toBe(
			'Not sample-exact: its sample-exact copy would be too large (placement exact to a frame)',
		);
		cleanup();
		// an exact sound has no such line
		const ok = soundEntry({ title: 'Tick' });
		const r2 = await insertLibrarySound(session, { registerSound: async () => registered(ok) }, ok, { at: 90 });
		const clip2 = session.getCommitted().sequences[seqId]!.clips[r2.clipId]!;
		render(
			<SessionProvider session={session}>
				<SoundSection session={session} clips={[clip2]} frame={0} sequenceId={seqId} />
			</SessionProvider>,
		);
		expect(screen.queryByTestId('sound-section-inexact')).toBeNull();
	});
});
