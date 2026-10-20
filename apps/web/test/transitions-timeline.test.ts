import { EngineClient } from '@jasper/engine-client';
import { type Sequence, transitionSpec } from '@jasper/project';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCommandContext, registerAllCommands, runCommand } from '../src/commands/index.ts';
import { resetTransitionDefaults, setDefaultTransition } from '../src/panels/effects/transition-prefs.ts';
import {
	dropCommand,
	resolveTransitionDrop,
	transitionIndex,
} from '../src/panels/timeline/model/transitions.ts';
import { setupTimeline, videoAsset } from './timeline-helpers.ts';

beforeAll(() => registerAllCommands());

type T = ReturnType<typeof setupTimeline>;

/**
 * Two adjacent video clips with linked audio, cut at frame 120: A = media 2 s…6 s (tail handle 420 frames),
 * B = media `bIn` s…`bIn`+4 s (head handle `bIn`·30 frames).
 */
function cut(t: T, bIn = 2) {
	const reg = (s: number) =>
		(t.apply([{ type: 'media.register', asset: videoAsset(s) }]).results[0] as { mediaId: string }).mediaId;
	const a = reg(20);
	const b = reg(20);
	const r = t.apply([
		{
			type: 'clip.place',
			source: { mediaId: a },
			at: 0,
			sourceRange: { in: { seconds: 2 }, out: { seconds: 6 } },
		},
		{
			type: 'clip.place',
			source: { mediaId: b },
			at: 120,
			sourceRange: { in: { seconds: bIn }, out: { seconds: bIn + 4 } },
		},
	]);
	const [va, aa] = (r.results[0] as { clipIds: string[] }).clipIds as [string, string];
	const [vb, ab] = (r.results[1] as { clipIds: string[] }).clipIds as [string, string];
	return { va, aa, vb, ab };
}

function addAt(t: T, cmd: Record<string, unknown>) {
	const r = t.apply([{ type: 'transition.add', effectId: 'jasper.cross-dissolve', ref: '$t', ...cmd }]);
	return r.refs.$t!;
}

const seqOf = (t: T) => t.seq() as Sequence;
const index = (t: T) => transitionIndex(seqOf(t), t.session.getCommitted().media);
const geomOf = (t: T, id: string) => [...index(t).values()].flat().find((g) => g.t.id === id)!;
const v1 = (t: T) => t.geometry().layout.video.rows.find((r) => r.index === 0)!;

describe('gesture → command mapping (S10 §8 test 2, TUI-012…015)', () => {
	it('Alt-dragging the start edge onto the cut makes it start-at-cut', () => {
		const t = setupTimeline({ pxPerFrame: 10 });
		t.session.setToggles({ snapping: false });
		cut(t);
		const id = addAt(t, { trackId: 'V1', at: 120, duration: 20 });
		const y = v1(t).y + 20;
		t.drag(t.x(110) + 1, y, t.x(121) + 1, y, { alt: true });
		expect(seqOf(t).transitions[id]).toMatchObject({ duration: 10, alignment: 'start-at-cut' });
	});

	it('clamps to the media handles live with fitTransitionDuration and says so', () => {
		const t = setupTimeline({ pxPerFrame: 10 });
		t.session.setToggles({ snapping: false });
		cut(t, 0.5); // 15 frames before B's in-point
		const id = addAt(t, { trackId: 'V1', at: 120, duration: 20 });
		const y = v1(t).y + 20;
		t.drag(t.x(130) - 1, y, t.x(150), y, {}, false);
		t.controller.pointerUp(t.pt(t.x(150), y));
		expect(seqOf(t).transitions[id]!.duration).toBe(31);
	});

	it('snaps the dragged edge to the playhead', () => {
		const t = setupTimeline({ pxPerFrame: 2 });
		cut(t);
		const id = addAt(t, { trackId: 'V1', at: 120, duration: 10, alignment: 'start-at-cut' }); // 120…130
		t.session.transport.seek(140);
		const y = v1(t).y + 20;
		t.drag(t.x(130) - 1, y, t.x(137) - 1, y, {}, false); // raw 137: 6 px from the playhead
		expect(t.ui.getState().snapFrame).toBe(140);
		t.controller.pointerUp(t.pt(t.x(137) - 1, y));
		expect(seqOf(t).transitions[id]!.duration).toBe(20);
	});

	it('body drag snaps the alignment (one "Transition Alignment" entry); Esc cancels with none', () => {
		const t = setupTimeline({ pxPerFrame: 10 });
		cut(t);
		const id = addAt(t, { trackId: 'V1', at: 120, duration: 20 });
		const y = v1(t).y + 20;
		const before = t.history().length;
		t.drag(t.x(120), y, t.x(128), y);
		expect(seqOf(t).transitions[id]).toMatchObject({ alignment: 'start-at-cut', duration: 20 });
		expect(t.history()).toHaveLength(before + 1);
		const doc = t.session.getCommitted();
		t.drag(t.x(130), y, t.x(110), y, {}, false);
		expect(t.session.getDrawn()).not.toEqual(doc);
		expect(t.controller.cancel()).toBe(true);
		expect(t.session.getDrawn()).toEqual(doc);
		t.controller.pointerUp(t.pt(t.x(110), y));
		expect(t.history().length).toBe(before + 1);
		t.drag(t.x(130), y, t.x(131), y);
		expect(t.history().length).toBe(before + 1);
	});
});

describe('drop resolution (S10 §8 test 3, TUI-021…024)', () => {
	const drop = (
		t: T,
		x: number,
		effectId = 'jasper.cross-dissolve',
		wanted = 30,
		kind: 'video' | 'audio' = 'video',
	) => {
		const seq = seqOf(t);
		const trackId = (kind === 'video' ? seq.videoTracks : seq.audioTracks)[0]!.id;
		return resolveTransitionDrop({
			seq,
			media: t.session.getCommitted().media,
			trackId,
			trackKind: kind,
			spec: transitionSpec(effectId)!,
			v: t.geometry().viewport,
			x,
			over: null,
			wanted,
		});
	};

	it('maps the ±12 px band around a cut in thirds and free edges to fades', () => {
		const t = setupTimeline({ pxPerFrame: 2 });
		cut(t);
		const x = t.x(120);
		expect(drop(t, x - 10)).toMatchObject({ alignment: 'end-at-cut' });
		expect(drop(t, x)).toMatchObject({ alignment: 'center' });
		expect(drop(t, x + 10)).toMatchObject({ alignment: 'start-at-cut' });
		expect(drop(t, t.x(0) + 5)).toMatchObject({ oneSided: 'in' });
		expect(drop(t, t.x(240) - 3)).toMatchObject({ oneSided: 'out' });
		expect(drop(t, x, 'jasper.constant-power')).toBeNull();
		expect(drop(t, x, 'jasper.constant-power', 30, 'audio')).toMatchObject({ cut: 120, oneSided: null });
	});

	it('reports handle availability and refuses when nothing fits', () => {
		const t = setupTimeline({ pxPerFrame: 2 });
		cut(t, 0.5); // 15 frames before B
		const d = drop(t, t.x(120) - 10); // end-at-cut, 30 wanted: all before the cut
		if (d?.kind !== 'add') throw new Error('expected an add target');
		expect(d.feedback.fittedDuration).toBe(15);
		expect(d.refused).toBeNull();
		const t2 = setupTimeline({ pxPerFrame: 2 });
		cut(t2, 0);
		const r = drop(t2, t2.x(120) - 10);
		expect(r?.refused).toBeTruthy();
		// A centred dip to black needs no handles.
		expect(drop(t2, t2.x(120), 'jasper.dip-to-black')?.refused).toBeNull();
	});

	it('an existing transition under the pointer is replaced (same medium)', () => {
		const t = setupTimeline({ pxPerFrame: 2 });
		cut(t);
		const id = addAt(t, { trackId: 'V1', at: 120, duration: 20 });
		const g = geomOf(t, id);
		const seq = seqOf(t);
		const target = resolveTransitionDrop({
			seq,
			media: t.session.getCommitted().media,
			trackId: seq.videoTracks[0]!.id,
			trackKind: 'video',
			spec: transitionSpec('jasper.dip-to-black')!,
			v: t.geometry().viewport,
			x: t.x(120),
			over: g,
			wanted: 30,
		});
		expect(target).toMatchObject({ kind: 'replace', refused: null });
		t.apply([dropCommand(target!, 'jasper.dip-to-black')!]);
		expect(seqOf(t).transitions[id]!.effectId).toBe('jasper.dip-to-black');
	});
});

describe('keyboard: Ctrl+D family (S10 §8 test 6, TUI-030)', () => {
	const ctxOf = (t: T) =>
		createCommandContext({ engine: new EngineClient({ baseUrl: '' }), session: t.session });
	const kinds = (t: T) => {
		const seq = seqOf(t);
		return Object.values(seq.transitions).map((x) => ({
			video: seq.videoTracks.some((v) => v.id === x.trackId),
			two: !!x.outgoingClipId && !!x.incomingClipId,
			effectId: x.effectId,
		}));
	};

	it('Ctrl+D with two clips selected: edges of both, two-sided at the cut, one entry', async () => {
		resetTransitionDefaults();
		const t = setupTimeline();
		const { va, vb } = cut(t);
		t.session.select('timeline', [va, vb], 'replace'); // linked selection adds the audio
		const before = t.history().length;
		await runCommand('timeline.applyDefaultVideoTransition', ctxOf(t));
		expect(t.history()).toHaveLength(before + 1);
		const k = kinds(t);
		expect(k).toHaveLength(3);
		expect(k.every((x) => x.video && x.effectId === 'jasper.cross-dissolve')).toBe(true);
		expect(k.filter((x) => x.two)).toHaveLength(1);
	});

	it('Ctrl+Shift+D adds audio transitions with the default audio transition; Shift+D both', async () => {
		resetTransitionDefaults();
		const t = setupTimeline();
		const { va, vb } = cut(t);
		t.session.select('timeline', [va, vb], 'replace');
		const before = t.history().length;
		await runCommand('timeline.applyDefaultAudioTransition', ctxOf(t));
		expect(t.history()).toHaveLength(before + 1);
		expect(kinds(t).every((x) => !x.video && x.effectId === 'jasper.constant-power')).toBe(true);
		expect(kinds(t)).toHaveLength(3); // fade in, crossfade at the cut, fade out
		t.session.undo();
		setDefaultTransition('jasper.dip-to-black');
		await runCommand('timeline.applyDefaultTransitionsToSelection', ctxOf(t));
		expect(t.history()).toHaveLength(before + 1);
		expect(kinds(t)).toHaveLength(6);
		expect(
			kinds(t)
				.filter((x) => x.video)
				.every((x) => x.effectId === 'jasper.dip-to-black'),
		).toBe(true);
		resetTransitionDefaults();
	});
});
