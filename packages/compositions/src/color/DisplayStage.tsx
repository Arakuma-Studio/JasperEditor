// The Program monitor's display transform (workstream color-mgmt): the composite holds the working space's signal;
// a monitor shows it through `outputTransformFn(working, displaySpaceFor(working))` — Rec. 2020 / P3 working spaces
// mapped into Rec. 709 primaries (keeping their curve, Premiere's default display handling) and HDR working spaces
// tone mapped to Rec. 709 (BT.2390, 203 cd/m² = SDR white). Rec. 709 and sRGB working spaces are shown as they are,
// so nothing is mounted for them. The whole composite is captured through HTML-in-Canvas (as adjustment layers and
// the blend scope are) and drawn through the baked display LUT (tetrahedral, the same `colorLut` pass as grades).
// Preview only: renders keep the working signal (exports convert to their output space on the engine; stills get
// this same display LUT there). Without HTML-in-Canvas or WebGL2 the monitor shows the working signal with a chip.
// compositor: when a layer inside draws through HTML-in-Canvas itself (the browser cannot nest them), the stage does
// not capture: the sequence's stack is drawn by the flat compositor (fx/flat.tsx), which applies the same display LUT
// as its last step (`FlatDisplayContext`; preview files get it as a `<Video>` effect). `flat` is the static guess
// (fx/flat-plan.ts `docUsesCanvas`); a scope that registers inside the capture switches the stage over.
import {
	bakeLut,
	colorSpace,
	displaySpaceFor,
	isHdrSpace,
	outputTransformFn,
	type SequenceColorInfo,
} from '@jasper/project';
import { type ReactNode, useMemo, useState } from 'react';
import { AbsoluteFill, HtmlInCanvas } from 'remotion';
import { CanvasScopeContext } from '../fx/canvas-scope.tsx';
import { canUseHtmlInCanvas } from '../fx/FxPicture.tsx';
import { FlatDisplayContext } from '../fx/flat.tsx';
import { useFxStatus } from '../fx/status.ts';
import { colorLut, colorLutCpu } from './effects.ts';
import { colorStageBackend } from './gl.ts';
import { useColorStageStatus } from './status.ts';

/** The display LUT of a working space (null = shown as it is). Cached per settings. */
const cache = new Map<string, ReturnType<typeof bakeLut> | null>();
export function displayLutOf(
	working: SequenceColorInfo | undefined,
): { key: string; lut: ReturnType<typeof bakeLut> } | null {
	if (!working) return null;
	const key = `display:${working.space}|${working.hdrPeakNits}|${working.sdrWhiteNits}`;
	if (!cache.has(key)) {
		const fn = outputTransformFn(working, displaySpaceFor(working.space));
		const hdr = isHdrSpace(colorSpace(working.space)!);
		cache.set(key, fn ? bakeLut(hdr ? 65 : 33, fn, `display ${working.space}`) : null);
		if (cache.size > 16) cache.delete(cache.keys().next().value!);
	}
	const lut = cache.get(key) ?? null;
	return lut ? { key, lut } : null;
}

const FILL = { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' } as const;

export function DisplayStage({
	working,
	enabled,
	width,
	height,
	flat = false,
	children,
}: {
	working: SequenceColorInfo | undefined;
	/** The Program monitor (preview); renders pass false. */
	enabled: boolean;
	width: number;
	height: number;
	/** compositor: something in the stack draws through HTML-in-Canvas (the stack is then drawn flat). */
	flat?: boolean;
	children: ReactNode;
}) {
	const status = useColorStageStatus();
	const fxGpu = useFxStatus();
	const display = enabled ? displayLutOf(working) : null;
	// A scope drawn through HTML-in-Canvas inside the stage (adjustment layer, blend modes, a DOM layer's effects)
	// cannot paint inside another canvas (fx/canvas-scope.tsx): the stage then steps aside for the rest of this
	// working space, and the monitor shows the working signal with a chip.
	const [yielded, setYielded] = useState<string | null>(null);
	const key = display?.key ?? '';
	const enclosing = useMemo(
		() => ({ kind: 'display' as const, register: () => setYielded((y) => (y === key ? y : key)) }),
		[key],
	);
	const effects = useMemo(() => {
		if (!display) return [];
		return [colorStageBackend() === 'cpu' ? colorLutCpu(display) : colorLut(display)];
	}, [display]);
	if (!display) return <>{children}</>;
	const label = colorSpace(working!.space)?.label;
	// compositor: the stack draws through HTML-in-Canvas itself: the flat compositor applies the display transform.
	if (canUseHtmlInCanvas() && status === 'ok' && fxGpu === 'ok' && (flat || yielded === key))
		return <FlatDisplayContext.Provider value={effects}>{children}</FlatDisplayContext.Provider>;
	if (!canUseHtmlInCanvas() || status !== 'ok' || yielded === key)
		return (
			<CanvasScopeContext.Provider value={enclosing}>
				{children}
				<DisplayChip
					text={
						status !== 'ok'
							? `${label} shown without display conversion (no WebGL2)`
							: !canUseHtmlInCanvas()
								? `${label} shown without display conversion (needs HTML-in-Canvas)`
								: `${label} shown without display conversion (a layer here draws through HTML-in-Canvas)`
					}
				/>
			</CanvasScopeContext.Provider>
		);
	return (
		<CanvasScopeContext.Provider value={enclosing}>
			<HtmlInCanvas
				width={width}
				height={height}
				effects={effects}
				style={{ ...FILL, display: 'block' }}
				showInTimeline={false}
			>
				<div
					data-display-stage={working!.space}
					style={{ position: 'absolute', left: 0, top: 0, width, height }}
				>
					{children}
				</div>
			</HtmlInCanvas>
		</CanvasScopeContext.Provider>
	);
}

function DisplayChip({ text }: { text: string }) {
	return (
		<AbsoluteFill style={{ pointerEvents: 'none' }}>
			<div
				data-display-chip=""
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
