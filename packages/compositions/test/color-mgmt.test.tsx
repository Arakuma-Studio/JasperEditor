import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { CanvasScopeContext, ScopedHtmlInCanvas } from '../src/fx/canvas-scope.tsx';

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
