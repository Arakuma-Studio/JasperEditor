// color-mgmt: Chrome's HTML-in-Canvas never fires `paint` on a `layoutsubtree` canvas that lies inside another one
// (measured on Chrome 150: no paint event for the inner canvas, not even after `requestPaint()`), so a Remotion
// `<HtmlInCanvas>` inside another one never draws, and a render waits on it until the delayRender timeout ("waiting
// for first paint after canvas resize"). Every `<HtmlInCanvas>` of the compositions therefore goes through
// `ScopedHtmlInCanvas`, which knows the one around it:
// - the Program monitor's display stage (outermost, preview only, color/DisplayStage.tsx) steps aside as soon as a
//   scope registers inside it: the composite is then shown without display conversion (with a chip), and the inner
//   scope runs;
// - inside another scope, a render fails at once with CANVAS_NESTED naming both (never a timeout or a different
//   picture), and the Player shows the content without the inner scope's chain, with a chip.
import { type ComponentProps, createContext, type ReactNode, useContext, useEffect } from 'react';
import { AbsoluteFill, cancelRender, getRemotionEnvironment, HtmlInCanvas } from 'remotion';

type Enclosing =
	| { kind: 'display'; register: () => void }
	| {
			kind: 'scope';
			/** What the enclosing canvas draws (error messages and chips). */
			name: string;
	  };

/** The `<HtmlInCanvas>` (or display stage) around the current element, null at the top. */
export const CanvasScopeContext = createContext<Enclosing | null>(null);

export type ScopedHtmlInCanvasProps = ComponentProps<typeof HtmlInCanvas> & {
	/** What this canvas draws, e.g. "Blend modes of track V2" (error messages and chips). */
	scope: string;
	children?: ReactNode;
};

/** Error code of a render that would nest HTML-in-Canvas scopes (the engine maps it to a job error). */
export const CANVAS_NESTED = 'CANVAS_NESTED';

export function nestedScopeMessage(inner: string, outer: string): string {
	return `${CANVAS_NESTED}: ${inner} cannot be drawn inside ${outer} (the browser cannot nest HTML-in-Canvas scopes)`;
}

export function ScopedHtmlInCanvas({ scope, children, ...props }: ScopedHtmlInCanvasProps) {
	const enclosing = useContext(CanvasScopeContext);
	const nested = enclosing?.kind === 'scope' ? enclosing.name : null;
	useEffect(() => {
		if (enclosing?.kind === 'display') enclosing.register();
	}, [enclosing]);
	if (nested !== null) {
		if (getRemotionEnvironment().isRendering) cancelRender(new Error(nestedScopeMessage(scope, nested)));
		const width = typeof props.width === 'number' ? props.width : undefined;
		const height = typeof props.height === 'number' ? props.height : undefined;
		return (
			<div data-canvas-scope-nested={scope} style={{ width, height, ...(props.style ?? {}) }}>
				{children}
				<ScopeChip text={`${scope}: not drawn inside ${nested}`} />
			</div>
		);
	}
	return (
		<CanvasScopeContext.Provider value={{ kind: 'scope', name: scope }}>
			<HtmlInCanvas {...props}>{children}</HtmlInCanvas>
		</CanvasScopeContext.Provider>
	);
}

/** A small preview-only note in the corner of the area. */
export function ScopeChip({ text }: { text: string }) {
	return (
		<AbsoluteFill style={{ pointerEvents: 'none' }}>
			<div
				data-canvas-scope-chip=""
				style={{
					position: 'absolute',
					right: '2%',
					bottom: '3%',
					padding: '0.3% 0.8%',
					borderRadius: 4,
					background: 'rgba(120, 60, 0, 0.8)',
					color: 'rgba(255, 255, 255, 0.95)',
					fontFamily: '"Source Sans 3", "Source Sans Pro", Arial, sans-serif',
					fontSize: '2.2vmin',
				}}
			>
				{text}
			</div>
		</AbsoluteFill>
	);
}
