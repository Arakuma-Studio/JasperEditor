import {
	applyTransaction,
	buildRenderSnapshot,
	type Command,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
} from '@jasper/project';
import { Thumbnail } from '@remotion/player';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RENDER_OPTIONS, type RenderDoc, SequenceComposition } from '../src/index.ts';

function snapshot(commands: Command[], captions?: 'visible' | 'none'): RenderDoc {
	const ids = createCounterIdSource(1);
	const base = createEmptyProject({ ids, name: 'C', preset: 'hd-1080p-30' });
	const seqId = Object.keys(base.sequences)[0]!;
	const { document, result } = applyTransaction(
		base,
		{ label: 'setup', origin: 'user', sequenceId: seqId, commands },
		{ ids, now: () => 't', revision: 0, registries: defaultRegistries() },
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return buildRenderSnapshot(document, seqId, {
		resolveMedia: () => null,
		resolveFont: () => null,
		...(captions ? { captions } : {}),
	});
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

const base: Command[] = [
	{ type: 'clip.addSolid', at: 0, duration: 120, track: 'V1', color: [0, 0, 1, 1] } as Command,
	{ type: 'caption.add', at: 0, duration: 60, text: 'Hello <i>there</i>\nsecond line' } as Command,
	{ type: 'caption.add', at: 60, duration: 60, text: 'one two\n\nthree four' } as Command,
];

describe('caption layer', () => {
	it('draws the caption page active at the selected frame', () => {
		const doc = snapshot(base);
		const a = renderFrame(doc, 10);
		const page = a.container.querySelector('[data-caption-page]')!;
		expect(page.textContent).toBe('Hello theresecond line');
		a.unmount();
		// the second caption pages at its blank line (half way, by character weight)
		const b = renderFrame(doc, 65);
		expect(b.container.querySelector('[data-caption-page]')!.textContent).toBe('one two');
		b.unmount();
		const c = renderFrame(doc, 115);
		expect(c.container.querySelector('[data-caption-page]')!.textContent).toBe('three four');
		c.unmount();
	});
	it('hidden caption tracks are not drawn', () => {
		const doc = snapshot([
			...base,
			{ type: 'track.update', trackId: 'C1', patch: { visible: false } } as Command,
		]);
		expect(doc.videoTracks.some((t) => t.caption)).toBe(false);
		const none = snapshot(base, 'none');
		expect(none.videoTracks.some((t) => t.caption)).toBe(false);
	});
	it('karaoke highlight colours the words spoken so far', () => {
		const doc = snapshot([
			{ type: 'caption.add', at: 0, duration: 60, text: 'aa bb cc' } as Command,
			{ type: 'caption.applyPreset', presetId: 'builtin:social', trackId: 'C1' } as Command,
		]);
		const a = renderFrame(doc, 25);
		const active = [...a.container.querySelectorAll('[data-caption-word="active"]')].map(
			(e) => e.textContent,
		);
		expect(active).toEqual(['AA', 'BB']);
		a.unmount();
	});
});
