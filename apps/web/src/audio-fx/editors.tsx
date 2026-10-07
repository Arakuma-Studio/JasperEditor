// Effect Controls editors of the audio effects (audio-fx): the EQ curve with draggable band handles (parametric
// EQs, notch/FFT filters, simple filters), the graphic-EQ slider bank, the compressor / expander / limiter transfer
// curves with live gain-reduction meters, the multiband curves and meters, and the loudness meter readouts. Every
// curve comes from the effect's own DSP (`responseDb` / `transferDb` of an analysis processor), so what is drawn is
// what is heard. Edits are ordinary `param.set` commands (one undo step per drag; a keyframe at the playhead when the
// parameter is animated). Registered for every audio effect with an editor or meters (register.ts).
import { audioFxMeters } from '@jasper/compositions';
import type { Command, EffectInstance, ParamValue, Rational, Sequence } from '@jasper/project';
import { useSessionState } from '@jasper/session/react';
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { EffectEditorProps } from '../extensions/index.ts';
import { useInspectorOps } from '../panels/properties/lib/ops.ts';
import {
	analysisProcessor,
	type BandHandle,
	bandHandles,
	dbToY,
	dynamicsBands,
	F_MAX,
	F_MIN,
	FREQ_GRID,
	freqLabel,
	freqToX,
	graphicBands,
	responseCurve,
	valuesAt,
	xToFreq,
	yToDb,
} from './model.ts';

const W = 320;
const H = 140;

/** Live meter values of an effect instance in the preview (empty while not playing). */
export function useEffectMeters(instanceId: string): readonly number[] {
	const [v, setV] = useState<readonly number[]>([]);
	useEffect(() => audioFxMeters.subscribe(instanceId, setV), [instanceId]);
	return v;
}

function useEditorState(props: EffectEditorProps) {
	const doc = useSessionState((s) => s.transient ?? s.document);
	const seq = doc.sequences[props.sequenceId] as Sequence | undefined;
	const clip = seq?.clips[props.clip.id];
	const fx =
		((clip as { effects?: EffectInstance[] } | undefined)?.effects ?? []).find((e) => e.id === props.fx.id) ??
		props.fx;
	const rate = (seq?.settings.frameRate ?? { num: 30, den: 1 }) as Rational;
	const values = useMemo(
		() => (clip ? valuesAt(clip, fx, props.effect, props.frame, rate) : {}),
		[clip, fx, props.effect, props.frame, rate],
	);
	const key = JSON.stringify(values);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the values
	const proc = useMemo(() => analysisProcessor(props.effect.id, values), [props.effect.id, key]);
	const ops = useInspectorOps(props.session);
	const set = (pairs: [string, ParamValue][]): Command[] =>
		pairs.map(
			([name, value]) =>
				({
					type: 'param.set',
					target: ['effect', fx.id, name],
					value,
					at: { sequenceFrame: props.frame },
				}) as Command,
		);
	return { fx, values, proc, ops, set };
}

const num = (v: ParamValue | undefined, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function Grid({ range }: { range: number }) {
	const dbs = range > 18 ? [-24, -12, 0, 12, 24] : [-12, -6, 0, 6, 12];
	return (
		<g>
			{FREQ_GRID.map((f) => (
				<g key={f}>
					<line x1={freqToX(f, W)} x2={freqToX(f, W)} y1={0} y2={H} stroke="var(--pr-graph-grid)" />
					<text x={freqToX(f, W) + 2} y={H - 3} fontSize={8} fill="var(--pr-text-secondary)">
						{freqLabel(f)}
					</text>
				</g>
			))}
			{dbs.map((d) => (
				<g key={d}>
					<line
						x1={0}
						x2={W}
						y1={dbToY(d, H, range)}
						y2={dbToY(d, H, range)}
						stroke={d === 0 ? 'var(--pr-graph-zero)' : 'var(--pr-graph-grid)'}
					/>
					<text x={2} y={dbToY(d, H, range) - 2} fontSize={8} fill="var(--pr-text-secondary)">
						{d > 0 ? `+${d}` : d}
					</text>
				</g>
			))}
		</g>
	);
}

// ---------------------------------------------------------------- EQ / filter response with band handles

export function EqCurveEditor(props: EffectEditorProps) {
	const { values, proc, ops, set } = useEditorState(props);
	const bands = useMemo(() => bandHandles(props.effect), [props.effect]);
	const range = props.effect.audio?.editor === 'graphic-eq' ? 24 : 24;
	const curve = useMemo(() => responseCurve(proc), [proc]);
	const svgRef = useRef<SVGSVGElement | null>(null);
	const drag = useRef<BandHandle | null>(null);
	const path = curve
		.map(
			(p, i) =>
				`${i ? 'L' : 'M'}${freqToX(p.f, W).toFixed(1)},${dbToY(Math.max(-range, Math.min(range, p.db)), H, range).toFixed(1)}`,
		)
		.join('');
	const point = (e: ReactPointerEvent) => {
		const r = svgRef.current!.getBoundingClientRect();
		return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
	};
	const paramRange = (name: string) => props.effect.params.find((p) => p.name === name)?.range;
	const clampTo = (name: string, v: number) => {
		const r = paramRange(name);
		return Math.min(Math.max(v, r?.min ?? v), r?.max ?? v);
	};
	const onMove = (e: ReactPointerEvent) => {
		const b = drag.current;
		if (!b) return;
		const { x, y } = point(e);
		const pairs: [string, ParamValue][] = [[b.freq, Math.round(clampTo(b.freq, xToFreq(x, W)))]];
		if (b.gain) pairs.push([b.gain, Math.round(clampTo(b.gain, yToDb(y, H, range)) * 10) / 10]);
		ops.scrub.update(set(pairs));
	};
	return (
		<div className="py-1" data-testid={`audio-eq-${props.fx.id}`}>
			<svg
				ref={svgRef}
				viewBox={`0 0 ${W} ${H}`}
				className="block w-full max-w-[420px] cursor-crosshair rounded-pr-control"
				style={{ background: 'var(--pr-graph-bg)', touchAction: 'none' }}
				onPointerMove={onMove}
				onPointerUp={(e) => {
					if (!drag.current) return;
					drag.current = null;
					(e.target as Element).releasePointerCapture?.(e.pointerId);
					ops.scrub.end(false);
				}}
				aria-label={`${props.effect.label} frequency response`}
			>
				<Grid range={range} />
				<path
					d={path}
					fill="none"
					stroke="var(--pr-graph-curve)"
					strokeWidth={1.5}
					data-testid="audio-eq-curve"
				/>
				{bands.map((b) => {
					const on = b.on ? values[b.on] !== false : true;
					const f = num(values[b.freq], 1000);
					const g = b.gain ? num(values[b.gain]) : 0;
					return (
						<g key={b.freq} opacity={on ? 1 : 0.35}>
							<circle
								cx={freqToX(Math.min(F_MAX, Math.max(F_MIN, f)), W)}
								cy={dbToY(Math.max(-range, Math.min(range, g)), H, range)}
								r={5}
								fill="var(--pr-graph-bg)"
								stroke="var(--pr-graph-handle)"
								strokeWidth={1.5}
								style={{ cursor: 'grab' }}
								data-testid={`audio-eq-band-${b.freq}`}
								onPointerDown={(e) => {
									e.stopPropagation();
									if (!ops.scrub.start(`Adjust ${props.effect.label}`)) return;
									drag.current = b;
									(e.target as Element).setPointerCapture?.(e.pointerId);
								}}
								onWheel={(e) => {
									if (!b.q) return;
									const q = num(values[b.q], 1) * (e.deltaY < 0 ? 1.1 : 1 / 1.1);
									ops.apply(
										`Adjust ${props.effect.label}`,
										set([[b.q, Math.round(clampTo(b.q, q) * 100) / 100]]),
									);
								}}
							>
								<title>{`${b.label}: ${Math.round(f)} Hz${b.gain ? `, ${g.toFixed(1)} dB` : ''}`}</title>
							</circle>
						</g>
					);
				})}
			</svg>
			<p className="mt-0.5 text-pr-small text-pr-muted">
				Drag a band to set its frequency and gain; scroll on it for Q.
			</p>
		</div>
	);
}

// ---------------------------------------------------------------- graphic EQ slider bank

export function GraphicEqEditor(props: EffectEditorProps) {
	const { values, proc, ops, set } = useEditorState(props);
	const bands = useMemo(() => graphicBands(props.effect), [props.effect]);
	const curve = useMemo(() => responseCurve(proc, 120), [proc]);
	const range = 24;
	const sh = 90;
	const path = curve
		.map(
			(p, i) =>
				`${i ? 'L' : 'M'}${freqToX(p.f, W).toFixed(1)},${dbToY(Math.max(-range, Math.min(range, p.db)), 60, range).toFixed(1)}`,
		)
		.join('');
	return (
		<div className="py-1" data-testid={`audio-geq-${props.fx.id}`}>
			<svg
				aria-label={`${props.effect.label} response`}
				role="img"
				viewBox={`0 0 ${W} 60`}
				className="block w-full max-w-[420px] rounded-pr-control"
				style={{ background: 'var(--pr-graph-bg)' }}
			>
				<line x1={0} x2={W} y1={30} y2={30} stroke="var(--pr-graph-zero)" />
				<path d={path} fill="none" stroke="var(--pr-graph-curve)" strokeWidth={1.25} />
			</svg>
			<div className="mt-1 flex max-w-[420px] gap-px" style={{ height: sh + 18 }}>
				{bands.map((b) => {
					const v = num(values[b.name]);
					return (
						<label
							key={b.name}
							className="flex min-w-0 flex-1 flex-col items-center text-[8px] text-pr-muted"
							title={`${b.label}: ${v.toFixed(1)} dB`}
						>
							<input
								type="range"
								min={-range}
								max={range}
								step={0.1}
								value={v}
								aria-label={b.label}
								data-testid={`audio-geq-${b.name}`}
								className="accent-pr-accent"
								style={{ writingMode: 'vertical-lr', direction: 'rtl', height: sh, width: 12 }}
								onPointerDown={() => ops.scrub.start(`Adjust ${props.effect.label}`)}
								onChange={(e) => {
									const cmds = set([[b.name, Number(e.target.value)]]);
									if (!ops.scrub.update(cmds)) ops.apply(`Adjust ${props.effect.label}`, cmds);
								}}
								onPointerUp={() => ops.scrub.end(false)}
							/>
							<span className="truncate">{b.label.replace(' Hz', '').replace(' kHz', 'k')}</span>
						</label>
					);
				})}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------- dynamics: transfer curves + gain reduction

function GrMeter({ db, label }: { db: number; label: string }) {
	const v = Math.min(Math.max(-db, 0), 30);
	return (
		<div
			className="flex items-center gap-1 text-pr-small text-pr-muted"
			title={`${label}: ${db.toFixed(1)} dB`}
		>
			<span className="w-14 truncate">{label}</span>
			<div className="relative h-2 w-28 rounded-[1px] bg-pr-field-deep">
				<div
					className="absolute top-0 right-0 h-full"
					style={{ width: `${(v / 30) * 100}%`, background: 'var(--pr-meter-yellow)' }}
				/>
			</div>
			<span className="w-10 text-right pr-tabular">{db < -0.05 ? db.toFixed(1) : '0.0'}</span>
		</div>
	);
}

const DYN_S = 140;
const DYN_LO = -60;
/** Transfer-curve coordinates: input −60…0 dB → x, output → y. */
function dynToXY(inDb: number, outDb: number): readonly [number, number] {
	return [
		((inDb - DYN_LO) / -DYN_LO) * DYN_S,
		DYN_S - ((Math.max(DYN_LO, Math.min(0, outDb)) - DYN_LO) / -DYN_LO) * DYN_S,
	] as const;
}

const SECTION_NAMES: Record<string, string[]> = {
	'jasper.audio.dynamics': ['AutoGate', 'Expander', 'Compressor', 'Limiter'],
	'jasper.audio.multiband-compressor': ['Low', 'Low-Mid', 'High-Mid', 'High'],
};

export function DynamicsEditor(props: EffectEditorProps) {
	const { proc } = useEditorState(props);
	const meters = useEffectMeters(props.fx.id);
	const bands = dynamicsBands(props.effect);
	const S = DYN_S;
	const lo = DYN_LO;
	const toXY = dynToXY;
	const curves = useMemo(() => {
		const out: { band: number; d: string }[] = [];
		for (let b = 0; b < bands; b++) {
			const pts: string[] = [];
			for (let i = 0; i <= 60; i++) {
				const x = lo + i;
				const y = proc?.transferDb?.(b, x);
				if (y === null || y === undefined) continue;
				const [px, py] = toXY(x, y);
				pts.push(`${pts.length ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`);
			}
			out.push({ band: b, d: pts.join('') });
		}
		return out;
	}, [proc, bands]);
	const names = SECTION_NAMES[props.effect.id] ?? ['Gain reduction'];
	return (
		<div className="flex flex-wrap items-start gap-3 py-1" data-testid={`audio-dyn-${props.fx.id}`}>
			{curves.some((c) => c.d) ? (
				<svg
					viewBox={`0 0 ${S} ${S}`}
					width={S}
					height={S}
					className="rounded-pr-control"
					style={{ background: 'var(--pr-graph-bg)' }}
					aria-label="Transfer curve"
				>
					{[-48, -36, -24, -12].map((d) => {
						const [x] = toXY(d, d);
						return (
							<g key={d}>
								<line x1={x} x2={x} y1={0} y2={S} stroke="var(--pr-graph-grid)" />
								<line x1={0} x2={S} y1={S - x} y2={S - x} stroke="var(--pr-graph-grid)" />
							</g>
						);
					})}
					<line x1={0} y1={S} x2={S} y2={0} stroke="var(--pr-graph-zero)" strokeDasharray="3 3" />
					{curves.map(({ band: i, d }) => (
						<path
							key={i}
							d={d}
							fill="none"
							stroke={i === 0 ? 'var(--pr-graph-curve)' : 'var(--pr-graph-handle)'}
							strokeWidth={1.5}
							opacity={bands > 1 ? 0.6 + 0.1 * i : 1}
							data-testid="audio-dyn-curve"
						/>
					))}
					<text x={3} y={10} fontSize={8} fill="var(--pr-text-secondary)">
						out
					</text>
					<text x={S - 14} y={S - 3} fontSize={8} fill="var(--pr-text-secondary)">
						in
					</text>
				</svg>
			) : null}
			<div className="flex flex-col gap-1 pt-1" data-testid={`audio-gr-${props.fx.id}`}>
				{(props.effect.audio?.meters ?? []).includes('gain-reduction')
					? names.map((n, i) => <GrMeter key={n} label={n} db={meters[i] ?? 0} />)
					: null}
				{meters.length === 0 ? (
					<span className="text-pr-small text-pr-muted">Play to see the gain reduction.</span>
				) : null}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------- loudness readouts

const fmtLufs = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(1));

export function LoudnessEditor(props: EffectEditorProps) {
	const meters = useEffectMeters(props.fx.id);
	const isAutoGain = props.effect.id === 'jasper.audio.auto-gain';
	const rows: [string, string][] = isAutoGain
		? [['Applied gain', `${fmtLufs(meters[0])} dB`]]
		: [
				['Momentary', `${fmtLufs(meters[0])} LUFS`],
				['Short-term', `${fmtLufs(meters[1])} LUFS`],
				['Integrated', `${fmtLufs(meters[2])} LUFS`],
				['Loudness Range', `${fmtLufs(meters[3])} LU`],
				['True Peak', `${fmtLufs(meters[4])} dBTP`],
			];
	return (
		<div
			className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 py-1 text-pr-small"
			data-testid={`audio-loudness-${props.fx.id}`}
		>
			{rows.map(([k, v]) => (
				<div key={k} className="contents">
					<span className="text-pr-muted">{k}</span>
					<span className="pr-tabular">{v}</span>
				</div>
			))}
			{meters.length === 0 ? <span className="col-span-2 text-pr-muted">Play to measure.</span> : null}
		</div>
	);
}

/** The editor for one audio effect spec (null = generic rows only). */
export function editorComponentFor(spec: { audio?: { editor?: string; meters?: readonly string[] } }) {
	const e = spec.audio?.editor;
	if (e === 'graphic-eq') return GraphicEqEditor;
	if (e === 'parametric-eq' || e === 'filter-response') return EqCurveEditor;
	if (e === 'compressor' || e === 'multiband-compressor' || e === 'dynamics' || e === 'limiter')
		return DynamicsEditor;
	if (spec.audio?.meters?.includes('loudness') || spec.audio?.meters?.includes('level'))
		return LoudnessEditor;
	if (spec.audio?.meters?.includes('gain-reduction')) return DynamicsEditor;
	return null;
}
