import { evaluate } from '@jasper/project';
import { describe, expect, it, vi } from 'vitest';
import { MixerController } from '../src/audio/automation.ts';
import { parseAudioPrefs } from '../src/audio/prefs.ts';
import { makeSession } from './timeline-helpers.ts';

describe('audio UI helpers', () => {
	it('audio prefs parse tolerantly', () => {
		const p = parseAudioPrefs({
			scrub: false,
			mixdown: 'bogus',
			voiceOver: { prerollSeconds: 999, name: '  ' },
		});
		expect(p.scrub).toBe(false);
		expect(p.mixdown).toBe('frontRear');
		expect(p.voiceOver.prerollSeconds).toBe(60);
		expect(p.voiceOver.name).toBe('Voice-over');
	});

	it('a held control records constant gain until the next move, in one undoable pass', () => {
		const { session, seqId } = makeSession();
		const stripId = session.getCommitted().sequences[seqId]!.audioTracks[0]!.id;
		session.apply({
			label: 'Latch',
			origin: 'user',
			commands: [{ type: 'mixer.updateStrip', stripId, patch: { automation: 'latch' } }],
		});
		const before = session.getCommitted();
		const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
		const controller = new MixerController(session);
		try {
			session.transport.play(1);
			controller.touch(stripId, 'volume', -6);
			for (const frame of [100, 200]) {
				session.transport.seek(frame);
				controller.touch(stripId, 'volume', -6);
			}
			session.transport.seek(210);
			controller.touch(stripId, 'volume', -3);
			session.transport.pause();
			const volume = session.getCommitted().sequences[seqId]!.audioTracks[0]!.volumeDb!;
			expect(evaluate(volume, 100 * 23_520_000)).toBe(-6);
			expect(evaluate(volume, 200 * 23_520_000)).toBe(-6);
			expect(evaluate(volume, 210 * 23_520_000)).toBe(-3);
			session.undo();
			expect(session.getCommitted()).toEqual(before);
		} finally {
			controller.dispose();
			clock.mockRestore();
		}
	});
});
