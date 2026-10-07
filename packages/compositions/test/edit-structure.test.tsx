// edit-structure: the composition draws nested sequences (recursively, at the nested frame), adjustment scopes
// around the tracks below, generator pictures and frame holds (structure checks in happy-dom; pixels are checked by
// edit-structure-render.e2e.test.ts in Chrome).
import {
	applyTransaction,
	buildRenderSnapshot,
	type Command,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type RenderVisualClip,
} from '@jasper/project';
import { Thumbnail } from '@remotion/player';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { pictureLocalFrame } from '../src/SequenceComposition.tsx';
import { cssExactAdjustment } from '../src/layers/AdjustmentScope.tsx';
import { DEFAULT_RENDER_OPTIONS, type RenderDoc, SequenceComposition } from '../src/index.ts';

function snapshot(commands: Command[]): RenderDoc {
	const ids = createCounterIdSource(1);
	const base = createEmptyProject({ ids, name: 'E', preset: 'hd-1080p-30' });
	const seqId = Object.keys(base.sequences)[0]!;
	const { document, result } = applyTransaction(
		base,
		{ label: 'setup', origin: 'user', sequenceId: seqId, commands },
		{ ids, now: () => 't', revision: 0, registries: defaultRegistries() },
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return buildRenderSnapshot(document, seqId, { resolveMedia: () => null, resolveFont: () => null });
}

function renderFrame(doc: RenderDoc, frame: number) {
	return render(
		<Thumbnail
			component={SequenceComposition}
			inputProps={{ doc, options: { ...DEFAULT_RENDER_OPTIONS, isPreview: true } }}
			compositionWidth={doc.settings.width}
			compositionHeight={doc.settings.height}
			durationInFrames={Math.max(1, doc.durationFrames)}
			fps={30}
			frameToDisplay={frame}
		/>,
	);
}

const nestCommands: Command[] = [
	{ type: 'sequence.create', name: 'Inner', ref: '$s' } as Command,
	{ type: 'clip.addSolid', sequenceId: '$s', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1] } as Command,
	{ type: 'clip.addSolid', sequenceId: '$s', at: 30, duration: 30, track: 'V1', color: [0, 0, 1, 1] } as Command,
	{ type: 'clip.place', source: { sequenceId: '$s' }, at: 10, tracks: { video: 'V2' } } as Command,
];

describe('nested sequences in the composition', () => {
	it('draws the nested clip shown at the nested frame', () => {
		const doc = snapshot(nestCommands);
		const nest = doc.videoTracks[1]!.clips[0]!;
		expect(nest.kind).toBe('nest-video');
		// Frame 15 = nested frame 5 (red), frame 50 = nested frame 40 (blue).
		const a = renderFrame(doc, 15);
		const nestEl = a.container.querySelector('[data-nest]')!;
		expect(nestEl).not.toBeNull();
		expect(nestEl.innerHTML).toContain('rgba(255, 0, 0, 1)');
		expect(nestEl.innerHTML).not.toContain('rgba(0, 0, 255, 1)');
		a.unmount();
		const b = renderFrame(doc, 50);
		expect(b.container.querySelector('[data-nest]')!.innerHTML).toContain('rgba(0, 0, 255, 1)');
		b.unmount();
	});
});

describe('adjustment layers in the composition', () => {
	it('wraps the tracks below in a CSS scope that filters only while the adjustment is active', () => {
		const doc = snapshot([
			{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [1, 0, 0, 1] } as Command,
			{ type: 'clip.addAdjustment', at: 20, duration: 20, track: 'V2', ref: '$a' } as Command,
			{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.gaussian-blur' } as Command,
		]);
		const adj = doc.videoTracks[1]!.clips[0]!;
		expect(cssExactAdjustment(adj)).toBe(true);
		const off = renderFrame(doc, 5);
		const scope = off.container.querySelector('[data-adjustment-scope="css"]') as HTMLElement;
		expect(scope).not.toBeNull();
		expect(scope.style.filter).toBe('');
		expect(scope.querySelector('[data-sequence-background]')).not.toBeNull();
		off.unmount();
		const on = renderFrame(doc, 25);
		const s2 = on.container.querySelector('[data-adjustment-scope="css"]') as HTMLElement;
		expect(s2.style.filter).toContain('blur');
		expect(s2.getAttribute('data-adjustment-active')).toBe(adj.clipId);
		on.unmount();
	});

	it('uses the canvas chain for opacity, blend or crop (and says so without HTML-in-Canvas)', () => {
		const doc = snapshot([
			{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [1, 0, 0, 1] } as Command,
			{ type: 'clip.addAdjustment', at: 0, duration: 60, track: 'V2', ref: '$a' } as Command,
			{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.black-white' } as Command,
			{ type: 'param.set', target: ['clip', '$a', 'opacity'], value: 50 } as Command,
		]);
		expect(cssExactAdjustment(doc.videoTracks[1]!.clips[0]!)).toBe(false);
		const r = renderFrame(doc, 10);
		// happy-dom has no HTML-in-Canvas: the composite stays visible, with the preview chip.
		expect(r.container.querySelector('[data-adjustment-scope="bypass"]')).not.toBeNull();
		expect(r.container.textContent).toContain('Adjustment layers need HTML-in-Canvas');
		r.unmount();
	});
});

describe('generators and frame holds', () => {
	it('draws Bars and Tone on a canvas', () => {
		const doc = snapshot([
			{ type: 'synthetic.create', kind: 'bars-and-tone', ref: '$b' } as Command,
			{ type: 'clip.place', source: { syntheticId: '$b' }, at: 0 } as Command,
		]);
		const clip = doc.videoTracks[0]!.clips[0]!;
		expect(clip.source).toEqual({ generator: { kind: 'bars' } });
		expect(doc.audioClips[0]!.generator?.kind).toBe('tone');
		const r = renderFrame(doc, 5);
		expect(r.container.querySelector('canvas[data-generator]')).not.toBeNull();
		r.unmount();
	});

	it('maps frame holds and freeze-frame handles to the picture frame', () => {
		const fps = { num: 30, den: 1 };
		const F = 705_600_000 / 30;
		const base = {
			start: 100,
			duration: 50,
			sourceIn: 10 * F,
			speed: { rate: 1, reverse: false, maintainPitch: true },
		} as unknown as RenderVisualClip;
		expect(pictureLocalFrame(base, 7, fps)).toBe(7);
		expect(pictureLocalFrame({ ...base, frameHold: { flicks: 30 * F } }, 7, fps)).toBe(20);
		expect(pictureLocalFrame({ ...base, headHandle: 10, freezeHead: 4 }, -9, fps)).toBe(-6);
		expect(pictureLocalFrame({ ...base, tailHandle: 10, freezeTail: 4 }, 58, fps)).toBe(55);
	});
});

describe('nest speed', () => {
	it('shows the nested frame at 2× through Freeze', () => {
		const doc = snapshot([
			{ type: 'sequence.create', name: 'Inner', ref: '$s' } as Command,
			{ type: 'clip.addSolid', sequenceId: '$s', at: 0, duration: 30, track: 'V1', color: [1, 0, 0, 1] } as Command,
			{ type: 'clip.addSolid', sequenceId: '$s', at: 30, duration: 30, track: 'V1', color: [0, 0, 1, 1] } as Command,
			{ type: 'clip.addSolid', sequenceId: '$s', at: 60, duration: 30, track: 'V1', color: [0, 1, 0, 1] } as Command,
			{ type: 'clip.place', source: { sequenceId: '$s' }, at: 0, tracks: { video: 'V1' }, ref: '$n' } as Command,
			{ type: 'clip.setSpeed', clipIds: ['$n'], rate: 2, ripple: false } as Command,
		]);
		const nest = doc.videoTracks[0]!.clips[0]!;
		expect([nest.duration, nest.speed.rate]).toEqual([45, 2]);
		const sub = (nest.source as { nest: { snapshot: RenderDoc } }).nest.snapshot;
		expect(sub.range).toEqual({ start: 0, end: 90 });
		const r = renderFrame(doc, 35);
		expect(r.container.querySelector('[data-nest]')!.getAttribute('data-nest-frame')).toBe('70');
		expect(r.container.querySelector('[data-nest]')!.innerHTML.match(/rgba\([^)]*\)/g)).toEqual(['rgba(0, 255, 0, 1)']);
		r.unmount();
	});
});
