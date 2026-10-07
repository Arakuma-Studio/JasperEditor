// The Program monitor's display transform (workstream color-mgmt): the composite holds the working space's signal;
// a monitor shows it through `outputTransformFn(working, displaySpaceFor(working))` — Rec. 2020 / P3 working spaces
// mapped into Rec. 709 primaries (keeping their curve, Premiere's default display handling) and HDR working spaces
// tone mapped to Rec. 709 (BT.2390, 203 cd/m² = SDR white). Rec. 709 and sRGB working spaces are shown as they are,
// so nothing is mounted for them. The whole composite is captured through HTML-in-Canvas (as adjustment layers and
// the blend scope are) and drawn through the baked display LUT (tetrahedral, the same `colorLut` pass as grades).
// Preview only: renders keep the working signal (exports convert to their output space on the engine; stills get
// this same display LUT there). Without HTML-in-Canvas or WebGL2 the monitor shows the working signal with a chip.
import {
	bakeLut,
	colorSpace,
	displaySpaceFor,
	isHdrSpace,
	outputTransformFn,
	type SequenceColorInfo,
} from '@jasper/project';
import { type ReactNode, useMemo } from 'react';
import { AbsoluteFill, HtmlInCanvas } from 'remotion';
import { canUseHtmlInCanvas } from '../fx/FxPicture.tsx';
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
	children,
}: {
	working: SequenceColorInfo | undefined;
	/** The Program monitor (preview); renders pass false. */
	enabled: boolean;
	width: number;
	height: number;
	children: ReactNode;
}) {
	const status = useColorStageStatus();
	const display = enabled ? displayLutOf(working) : null;
	const effects = useMemo(() => {
		if (!display) return [];
		return [colorStageBackend() === 'cpu' ? colorLutCpu(display) : colorLut(display)];
	}, [display]);
	if (!display) return <>{children}</>;
	if (!canUseHtmlInCanvas() || status !== 'ok')
		return (
			<>
				{children}
				<DisplayChip
					text={
						status !== 'ok'
							? `${colorSpace(working!.space)?.label} shown without display conversion (no WebGL2)`
							: `${colorSpace(working!.space)?.label} shown without display conversion (needs HTML-in-Canvas)`
					}
				/>
			</>
		);
	return (
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
