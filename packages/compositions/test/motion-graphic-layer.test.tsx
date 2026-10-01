import { lowerThird, mgRegistry } from '@jasper/mg-templates';
import {
	applyTransaction,
	buildRenderSnapshot,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	resolveSceneAt,
} from '@jasper/project';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RENDER_OPTIONS, type LayerProps, MotionGraphicLayer } from '../src/index.ts';
import { MgRenderStateContext } from '../src/layers/MotionGraphicLayer.tsx';

function mgLayer(frame: number, params: Record<string, unknown> = { name: 'Ana Ruiz' }) {
	const ids = createCounterIdSource(1);
	const doc = createEmptyProject({ ids, name: 'MG', preset: 'hd-1080p-30' });
	const { document, result } = applyTransaction(
		doc,
		{
			label: 'mg',
			origin: 'user',
			commands: [
				{
					type: 'clip.addMotionGraphic',
					at: 10,
					duration: 150,
					track: 'V1',
					template: { id: 'lower-third', version: 1 },
					params,
				},
			],
		},
		{ ids, now: () => 't', revision: 0, registries: defaultRegistries(mgRegistry) },
	);
	expect(result.ok).toBe(true);
	const snap = buildRenderSnapshot(document, Object.keys(document.sequences)[0]!, {
		resolveMedia: () => null,
		resolveFont: () => null,
	});
	const [layer] = resolveSceneAt(snap, 10 + frame);
	expect(layer?.clip.kind).toBe('motion-graphic');
	const fps = snap.settings.fps.num / snap.settings.fps.den;
	return (options = DEFAULT_RENDER_OPTIONS): LayerProps => ({
		clip: layer!.clip,
		props: layer!.props,
		localFrame: layer!.localFrame,
		contentTime: 0,
		fps,
		media: null,
		options,
	});
}

describe('MotionGraphicLayer', () => {
	it('injects the TS twin SVG for the clip-local frame, sized to the template canvas', () => {
		const props = mgLayer(60)();
		const { container } = render(<MotionGraphicLayer {...props} />);
		const root = container.querySelector('[data-kind="motion-graphic"]') as HTMLElement;
		// S11:FIX-001: the box is LayerBox; the template attributes sit on its content.
		expect(root.querySelector<HTMLElement>('[data-mg-template]')?.dataset.mgTemplate).toBe('lower-third@1');
		expect(root.style.width).toBe('1920px');
		expect(root.style.transformOrigin).toBe('0 0');
		const svg = container.querySelector('svg')!;
		expect(svg.getAttribute('width')).toBe('1920');
		expect(svg.textContent).toContain('Ana Ruiz');
		const expected = lowerThird.renderSvg({ ...lowerThird.defaults, name: 'Ana Ruiz' }, 60, 30, HD, {
			durationFrames: 150,
			idPrefix: `mg-${props.clip.clipId}`,
		});
		// same markup as the twin (the DOM serializer only expands self-closing tags)
		const normalize = (html: string) => html.replace(/<(rect)([^>]*)\/>/g, '<$1$2></$1>');
		expect(container.innerHTML).toContain(normalize(expected));
	});

	it('shows the render-state badge only in preview', () => {
		const make = mgLayer(30);
		const preview = render(<MotionGraphicLayer {...make()} />);
		expect(preview.container.querySelector('[data-mg-badge]')?.textContent).toBe('F · SVG preview');
		const final = render(<MotionGraphicLayer {...make({ ...DEFAULT_RENDER_OPTIONS, isPreview: false })} />);
		expect(final.container.querySelector('[data-mg-badge]')).toBeNull();
		const withState = render(
			<MgRenderStateContext.Provider value={() => ({ status: 'rendering', progress: 0.42 })}>
				<MotionGraphicLayer {...make()} />
			</MgRenderStateContext.Provider>,
		);
		expect(withState.container.querySelector('[data-mg-badge]')?.textContent).toBe('F · Rendering 42%');
	});

	it('draws a labeled placeholder for unknown templates', () => {
		const props = mgLayer(5)();
		const clip = {
			...props.clip,
			source: {
				mg: { template: { id: 'gone', version: 3 }, params: {}, canvas: { width: 1920, height: 1080 } },
			},
		};
		const { container } = render(<MotionGraphicLayer {...props} clip={clip} />);
		expect(container.textContent).toContain('Template gone@3 is not installed');
		expect(container.querySelector('svg')).toBeNull();
	});
});

const HD = { width: 1920, height: 1080 };
