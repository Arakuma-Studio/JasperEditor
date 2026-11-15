import { Thumbnail } from '@remotion/player';
import { render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HtmlInCanvas } from 'remotion';
import { afterEach, expect, it, vi } from 'vitest';
import { CanvasScopeContext, ScopedHtmlInCanvas } from '../src/fx/canvas-scope.tsx';
import { AdjustmentScope } from '../src/layers/AdjustmentScope.tsx';
import { DEFAULT_RENDER_OPTIONS } from '../src/types.ts';
import { fxSnapshot } from './fx-media.ts';

afterEach(() => {
	vi.restoreAllMocks();
});

it('a render refuses an unsupported nested canvas and identifies both scopes', () => {
	const render = () =>
		renderToStaticMarkup(
			<CanvasScopeContext.Provider value={{ kind: 'scope', name: 'Foreign canvas' }}>
				<ScopedHtmlInCanvas scope="Adjustment layer" width={64} height={36}>
					<span>content</span>
				</ScopedHtmlInCanvas>
			</CanvasScopeContext.Provider>,
		);
	expect(render).toThrow(/CANVAS_NESTED/);
	expect(render).toThrow(/Foreign canvas/);
	expect(render).toThrow(/Adjustment layer/);
});

it("an adjustment layer's refusal names its clips and the sequence frame", () => {
	// Renders always have HTML-in-Canvas; happy-dom does not.
	vi.spyOn(HtmlInCanvas, 'isSupported').mockReturnValue(true);
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const doc = fxSnapshot([
		{ type: 'clip.addAdjustment', at: 10, duration: 5, track: 'V2', ref: '$a' },
		{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.invert' },
	]);
	const clips = doc.videoTracks.flatMap((t) => t.clips.filter((c) => c.kind === 'adjustment'));
	const Scene = () => (
		<CanvasScopeContext.Provider value={{ kind: 'scope', name: 'Foreign canvas' }}>
			<AdjustmentScope
				clips={clips}
				doc={doc}
				options={{ ...DEFAULT_RENDER_OPTIONS, isPreview: false }}
				offset={100}
			/>
		</CanvasScopeContext.Provider>
	);
	let message = '';
	render(
		<Thumbnail
			component={Scene}
			compositionWidth={16}
			compositionHeight={9}
			durationInFrames={30}
			fps={30}
			frameToDisplay={3}
			errorFallback={({ error }) => {
				message = error.message;
				return null;
			}}
		/>,
	);
	expect(message).toMatch(/CANVAS_NESTED/);
	expect(message).toContain(clips[0]!.clipId);
	expect(message).toContain('frame 103');
});
