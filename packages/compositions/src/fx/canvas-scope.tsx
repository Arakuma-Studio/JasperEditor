// color-mgmt: Chrome's HTML-in-Canvas never fires `paint` on a `layoutsubtree` canvas that lies inside another one
// (measured on Chrome 150: no paint event for the inner canvas, not even after `requestPaint()`), so a Remotion
// `<HtmlInCanvas>` inside another one never draws, and a render waits on it until the delayRender timeout ("waiting
// for first paint after canvas resize"). Every `<HtmlInCanvas>` of the compositions therefore goes through
// `ScopedHtmlInCanvas`, which knows the one around it:
// - the Program monitor's display stage (outermost, preview only, color/DisplayStage.tsx) steps aside as soon as a
//   scope registers inside it: the composite is then shown without display conversion (with a chip), and the inner
//   scope runs;
// - inside another scope, the owner of the enclosing scope is asked to draw without it: a
//   `VideoTracks` switches to its flat compositor (fx/flat.tsx), a nest layer takes its nested sequence's picture as
//   a canvas source. `VideoTracks` and `NestLayer` decide that statically (fx/flat-plan.ts) for every stack they can
//   recognise, so this is a safety net; renders hold the frame until the owner redrew.
// - only where no owner can flatten (a scope inside a canvas that is not one of ours) a render fails at once with
//   CANVAS_NESTED naming both (never a timeout or a different picture), and the Player shows the content without the
//   inner scope's chain, with a chip. No composition of a render snapshot reaches that case.
import {
	type ComponentProps,
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useLayoutEffect,
} from 'react';
import {
	AbsoluteFill,
	cancelRender,
	continueRender,
	delayRender,
	getRemotionEnvironment,
	HtmlInCanvas,
} from 'remotion';

type Enclosing =
	| { kind: 'display'; register: () => void }
	| {
			kind: 'scope';
			/** What the enclosing canvas draws (error messages and chips). */
			name: string;
			/** Asks the owner of the enclosing canvas to draw without it (null: it cannot). */
			flatten?: (() => void) | null;
	  };

/** The `<HtmlInCanvas>` (or display stage) around the current element, null at the top. */
export const CanvasScopeContext = createContext<Enclosing | null>(null);

/**
 * Set by the owner of the canvases created below it (a `VideoTracks`, a nest layer): asks it to draw without them
 * (flat compositor, canvas source) when a canvas would be nested inside one of them.
 */
export const CanvasOwnerContext = createContext<(() => void) | null>(null);

export type ScopedHtmlInCanvasProps = ComponentProps<typeof HtmlInCanvas> & {
	/** What this canvas draws, e.g. "Blend modes of track V2" (error messages and chips). */
	scope: string;
	children?: ReactNode;
};

/** Error code of a render that would nest HTML-in-Canvas scopes (the engine maps it to a job error). */
export const CANVAS_NESTED = 'CANVAS_NESTED';

function nestedScopeMessage(inner: string, outer: string): string {
	return `${CANVAS_NESTED}: ${inner} cannot be drawn inside ${outer} (the browser cannot nest HTML-in-Canvas scopes)`;
}

export function ScopedHtmlInCanvas({ scope, children, ...props }: ScopedHtmlInCanvasProps) {
	const enclosing = useContext(CanvasScopeContext);
	const owner = useContext(CanvasOwnerContext);
	const nested = enclosing?.kind === 'scope' ? enclosing.name : null;
	const flatten = enclosing?.kind === 'scope' ? (enclosing.flatten ?? null) : null;
	useEffect(() => {
		if (enclosing?.kind === 'display') enclosing.register();
	}, [enclosing]);
	if (nested !== null && flatten) return <Flattening flatten={flatten}>{children}</Flattening>;
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
		<CanvasScopeContext.Provider value={{ kind: 'scope', name: scope, flatten: owner }}>
			<HtmlInCanvas {...props}>{children}</HtmlInCanvas>
		</CanvasScopeContext.Provider>
	);
}

/** The content of a nested scope while the owner of the enclosing one switches to drawing without it. */
function Flattening({ flatten, children }: { flatten: () => void; children?: ReactNode }) {
	useLayoutEffect(() => {
		const handle = getRemotionEnvironment().isRendering
			? delayRender('Flattening nested canvas scopes')
			: null;
		flatten();
		return () => {
			if (handle !== null) continueRender(handle);
		};
	}, [flatten]);
	return <div data-canvas-scope-flattening="">{children}</div>;
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
