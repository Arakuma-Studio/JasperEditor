import { evaluate, flicksPerFrame, type Sequence } from '@jasper/project';
import { describe, expect, it, vi } from 'vitest';
import { CLIP_LANE_VOLUME, clipLaneValue, MixerController } from '../src/audio/automation.ts';
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

	it('Clip Mixer reads a reversed clip at the content time the preview and the export play (phase 0 verification)', () => {
		const rate = { num: 30, den: 1 };
		const F = flicksPerFrame(rate);
		const ease = { influence: 1 / 3, slope: 0 };
		const kf = (frame: number, value: number) => ({
			id: `kf_${frame}`,
			time: frame * F,
			value,
			interpolation: 'linear',
			easeIn: ease,
			easeOut: ease,
		});
		// Volume ramps −20 → −11 dB over content frames 0…9 of a reversed 10-frame clip at frame 10
		const clip = {
			id: 'c1',
			kind: 'audio',
			trackId: 'A1',
			start: 10,
			duration: 10,
			sourceIn: 0,
			speed: { rate: 1, reverse: true },
			volumeDb: { value: 0, keyframes: [kf(0, -20), kf(9, -11)] },
			pan: { value: 0, keyframes: [] },
		};
		const seq = { settings: { frameRate: rate }, clips: { c1: clip } } as unknown as Sequence;
		for (const local of [0, 3, 9]) {
			const v = clipLaneValue(seq, 'A1', CLIP_LANE_VOLUME, (10 + local) * F);
			expect(v).toBeCloseTo(-11 - local, 9);
		}
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
