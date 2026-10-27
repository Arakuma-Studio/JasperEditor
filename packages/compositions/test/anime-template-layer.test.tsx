import { mgRegistry } from '@jasper/mg-templates';
import {
	applyTransaction,
	buildRenderSnapshot,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
	resolveSceneAt,
} from '@jasper/project';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RENDER_OPTIONS, type LayerProps, MotionGraphicLayer } from '../src/index.ts';

function setup(): { doc: ProjectDocument; clipId: string } {
	const ids = createCounterIdSource(1);
	const base = createEmptyProject({ ids, name: 'A', preset: 'hd-1080p-30' });
	const { document, result } = applyTransaction(
		base,
		{
			label: 'setup',
			origin: 'user',
			commands: [
				{
					type: 'clip.addMotionGraphic',
					at: 0,
					duration: 150,
					track: 'V1',
					template: { id: 'title-reveal', version: 1 },
					params: { title: 'Hi there' },
					ref: '$a',
				},
			],
		},
		{ ids, now: () => 't', revision: 0, registries: defaultRegistries(mgRegistry) },
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return { doc: document, clipId: result.refs.$a! };
}

function layerAt(doc: ProjectDocument, clipId: string, frame: number): LayerProps {
	const snap = buildRenderSnapshot(doc, Object.keys(doc.sequences)[0]!, {
		resolveMedia: () => null,
		resolveFont: () => null,
	});
	const layer = resolveSceneAt(snap, frame).find((l) => l.clip.clipId === clipId)!;
	return {
		clip: layer.clip,
		props: layer.props,
		localFrame: layer.localFrame,
		contentTime: layer.contentTime,
		fps: 30,
		media: null,
		options: DEFAULT_RENDER_OPTIONS,
	};
}

describe('anime template rendering', () => {
	it('draws the "not installed" card for unknown templates, whatever their stamp (S11:ATP-010)', () => {
		const { doc, clipId } = setup();
		const layer = layerAt(doc, clipId, 10);
		for (const renderer of ['anime', undefined] as const) {
			const clip = {
				...layer.clip,
				source: {
					mg: {
						template: { id: 'later', version: 9 },
						params: {},
						canvas: { width: 1920, height: 1080 },
						...(renderer ? { renderer } : {}),
					},
				},
			};
			const r = render(<MotionGraphicLayer {...layer} clip={clip} />);
			expect(r.container.textContent).toContain('later@9');
			r.unmount();
		}
	});
});
