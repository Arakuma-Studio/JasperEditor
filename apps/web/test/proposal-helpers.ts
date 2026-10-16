// Shared fixture of the proposal review tests: a session with a solid on V1, a sound on A1 and a cue, the fake engine
// of the session package, and a 5-item agent proposal under review (preview computed).
import type { Sequence } from '@jasper/project';
import { proposalsFor } from '@jasper/session';
import { FakeEngine } from '../../../packages/session/test/fake-proposals-engine.ts';
import { makeSession, videoAsset } from './timeline-helpers.ts';

/** An audio-only asset (a sound file). */
export function audioAsset(seconds = 10) {
	const a = videoAsset(seconds);
	return {
		...a,
		kind: 'audio' as const,
		originalName: a.originalName.replace('.mp4', '.wav'),
		probe: {
			...a.probe,
			streams: a.probe.streams.filter((s) => s.type === 'audio').map((s) => ({ ...s, index: 0 })),
		},
	};
}

/** A session with V1 solid, an audio clip on A1 and a cue; a fake engine; a 5-item proposal. */
export async function proposalFixture() {
	const { session, seqId } = makeSession();
	const setup = session.apply({
		label: 'setup',
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{ type: 'media.register', asset: audioAsset(4), ref: '$m' },
			{ type: 'clip.addSolid', at: 0, duration: 120, track: 'V1', color: [0, 0, 1, 1] },
			{ type: 'clip.place', source: { mediaId: '$m' }, at: 0, tracks: { audio: 'A1' } },
			{ type: 'soundCue.add', cues: [{ frame: 60, kind: 'cut', weight: 'support', source: 'derived' }] },
		] as never[],
	});
	if (!setup.ok) throw new Error(JSON.stringify(setup.errors));
	const seq = () => session.getCommitted().sequences[seqId] as Sequence;
	const mediaId = setup.refs.$m!;
	const bed = Object.values(seq().clips).find((c) => c.kind === 'audio')!;
	const cueId = Object.keys(seq().soundDesign?.cues ?? {})[0]!;
	const engine = new FakeEngine(() => session);
	const timers: (() => void)[] = [];
	const c = proposalsFor(session, {
		engine,
		setTimer: (fn) => timers.push(fn),
		clearTimer: () => undefined,
	});
	c.connect(engine.subscribe);
	const place = (at: number) => ({ type: 'clip.place', source: { mediaId }, at, tracks: { audio: '$sfx' } });
	const p = engine.create({
		feature: 'sound-design',
		title: 'Sound pass',
		sequenceId: seqId,
		items: [
			{
				id: 'trk',
				label: 'SFX track',
				commands: [{ type: 'track.add', kind: 'audio', name: 'SFX 1', ref: '$sfx' }],
			},
			{
				id: 'hit',
				label: 'Hit on the cut',
				requires: ['trk'],
				commands: [place(30)],
				meta: { why: 'Cut from Shot A to Shot B', facts: ['support · Impacts'] },
				alternatives: [{ label: 'Hit later', commands: [place(32)] }],
			},
			{
				id: 'boom',
				label: 'Boom',
				requires: ['trk'],
				commands: [place(200)],
			},
			{
				id: 'move',
				label: 'Move the bed',
				commands: [{ type: 'clip.move', clipIds: [bed.id], deltaFrames: 400 }],
			},
			{
				id: 'cue',
				label: 'Cue later',
				commands: [{ type: 'soundCue.update', cueId, frame: 70 }],
			},
		],
	});
	await c.setActive(p.id);
	const flush = () => {
		while (timers.length) timers.shift()!();
	};
	flush();
	return { session, seqId, seq, engine, c, p, bed, cueId, mediaId, flush };
}
