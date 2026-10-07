// color-mgmt: the linear-light run planning (one blend scope for every track of a run) and the nested HTML-in-Canvas
// guard (fx/canvas-scope.tsx). The Remotion renders are covered by apps/engine/test/color-mgmt-remotion.test.ts.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CanvasScopeContext, nestedScopeMessage, ScopedHtmlInCanvas } from '../src/fx/canvas-scope.tsx';
import { type CompositeTrackInput, linearGroupItemsAt } from '../src/fx/composite-plan.ts';

const track = (id: string, clips: [string, number, number][]): CompositeTrackInput => ({
	trackId: id,
	clips: clips.map(([clipId, start, duration]) => ({ clipId, start, duration, blendMode: 'normal' })),
	stages: [],
});

describe('linear-light runs share one scope', () => {
	const members = [
		{
			input: track('V1', [['a', 0, 10]]),
			mattes: [{ id: 'm1', start: 0, duration: 5, color: [0, 0, 0, 1] as const }],
		},
		{
			input: track('V2', [['b', 5, 10]]),
			mattes: [{ id: 'm2', start: 4, duration: 4, color: [1, 1, 1, 1] as const }],
		},
		{ input: track('V3', [['c', 0, 20]]), mattes: [] },
	];
	const none = () => false;

	it('lists every drawn layer of the run bottom to top, with the upper tracks’ mattes under their clips', () => {
		const at = (f: number) => linearGroupItemsAt(members, f, none)?.map((it) => it.key) ?? null;
		// The lowest track's mattes lie in the captured backdrop, not in the items.
		expect(at(0)).toEqual(['a', 'c']);
		expect(at(4)).toEqual(['a', 'matte:m2', 'c']);
		expect(at(6)).toEqual(['a', 'matte:m2', 'b', 'c']);
		expect(at(12)).toEqual(['b', 'c']);
		expect(at(25)).toBeNull();
	});

	it('every item of a run blends (Normal included) and GPU transition sides are left to their stage', () => {
		const items = linearGroupItemsAt(members, 6, (id) => id === 'b')!;
		expect(items.map((it) => it.key)).toEqual(['a', 'matte:m2', 'c']);
		expect(items.filter((it) => it.kind === 'clip').every((it) => 'mode' in it && it.mode === 'normal')).toBe(
			true,
		);
	});
});

describe('nested HTML-in-Canvas guard', () => {
	const nested = () =>
		renderToStaticMarkup(
			<CanvasScopeContext.Provider value={{ kind: 'scope', name: 'Linear-light blending' }}>
				<ScopedHtmlInCanvas scope="An adjustment layer" width={64} height={36}>
					<span>content</span>
				</ScopedHtmlInCanvas>
			</CanvasScopeContext.Provider>,
		);

	it('a render fails at once with CANVAS_NESTED', () => {
		// Remotion reads NODE_ENV=test as a render.
		expect(nested).toThrow(/CANVAS_NESTED: An adjustment layer cannot be drawn inside Linear-light blending/);
	});

	it('the Player shows the content without the inner chain, with a chip', () => {
		const env = process.env.NODE_ENV;
		process.env.NODE_ENV = 'development';
		try {
			const html = nested();
			expect(html).toContain('data-canvas-scope-nested="An adjustment layer"');
			expect(html).toContain('<span>content</span>');
			expect(html).toContain('An adjustment layer: not drawn inside Linear-light blending');
			expect(html).not.toContain('<canvas');
		} finally {
			process.env.NODE_ENV = env;
		}
	});

	it('names both scopes in the render error', () => {
		expect(nestedScopeMessage('A layer’s effects', 'Blend modes')).toMatch(
			/^CANVAS_NESTED: A layer’s effects cannot be drawn inside Blend modes/,
		);
	});
});
