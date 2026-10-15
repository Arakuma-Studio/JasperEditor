import {
	applyTransaction,
	buildRenderSnapshot,
	type Command,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type EffectParams,
	type RenderSnapshot,
} from '@jasper/project';
import { Thumbnail } from '@remotion/player';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_RENDER_OPTIONS, SequenceComposition } from '../src/index.ts';

vi.mock('../src/color/gl.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/color/gl.ts')>()),
	canUseWebGl2: () => false,
	colorStageBackend: () => 'webgl',
}));

function makeDoc(commands: Command[]): RenderSnapshot {
	const ids = createCounterIdSource(1);
	const base = createEmptyProject({ ids, name: 'F', preset: 'hd-1080p-25' });
	const { document, result } = applyTransaction(
		base,
		{ label: 'setup', origin: 'user', commands },
		{ ids, now: () => 't', revision: 0, registries: defaultRegistries() },
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return buildRenderSnapshot(document, Object.keys(document.sequences)[0]!, {
		resolveMedia: () => null,
		resolveFont: () => null,
	});
}

const solid = (effects: Command[]): Command[] => [
	{ type: 'clip.addSolid', at: 0, duration: 50, track: 'V1', color: [0, 0.5, 1, 1], ref: '$s' },
	...effects,
];
const add = (effectId: string, params?: EffectParams): Command => ({
	type: 'effect.add',
	target: { clipId: '$s' },
	effectId,
	...(params ? { params } : {}),
});

function renderFrame(doc: RenderSnapshot, frame = 3) {
	return render(
		<Thumbnail
			component={SequenceComposition}
			inputProps={{ doc, options: DEFAULT_RENDER_OPTIONS }}
			compositionWidth={doc.settings.width}
			compositionHeight={doc.settings.height}
			durationInFrames={Math.max(1, doc.durationFrames)}
			fps={doc.settings.fps.num / doc.settings.fps.den}
			frameToDisplay={frame}
		/>,
	);
}

describe('GPU shader effects unavailable in preview', () => {
	it('without WebGL2 the preview bypasses shader effects visibly (chip), never silently', () => {
		const doc = makeDoc(solid([add('jasper.s.glow')]));
		const view = renderFrame(doc);
		expect(view.getByText(/WebGL2/)).toBeTruthy();
	});
});
