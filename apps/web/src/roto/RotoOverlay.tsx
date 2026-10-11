import type { Vec2 } from '@jasper/project';
import {
	applyMat3,
	type Clip,
	findRoto,
	invertMat3,
	layerMapOf,
	type Mat3,
	type ResolvedLayer,
	resolveSceneAt,
	rotoFrameState,
	rotoFrameUrl,
	rotoStorePath,
} from '@jasper/project';
import { useStoreSelector } from '@jasper/session/react';
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { ProgramOverlayHostProps } from '../extensions/index.ts';
import { useOverlayFrame } from '../panels/program/TransformOverlay.tsx';
import { toScreen, toSequence, type View } from '../panels/program/viewport.ts';
import { useEngineOrNull } from '../state/engine.tsx';
import {
	addStroke,
	handleRotoEvent,
	mediaFrameOfClip,
	rotosOf,
	runRoto,
	setBox,
	setRotoEngine,
} from './actions.ts';
import { ROTO_COLORS } from './roto.tokens.ts';
import { rotoUi, useRoto } from './store.ts';

const pts = (q: readonly Vec2[]) => q.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');

function layerOf(scene: readonly ResolvedLayer[], clipId: string): ResolvedLayer | null {
	return scene.find((l) => l.clip.clipId === clipId) ?? null;
}

/** Media (layer) px → screen px. */
function toScreenPx(map: Mat3, view: View, p: Vec2): Vec2 {
	return toScreen(view, applyMat3(map, p));
}

/** The affine screen transform of the layer box (from three mapped corners). */
function affineOf(map: Mat3, view: View, w: number, h: number): string {
	const o = toScreenPx(map, view, [0, 0]);
	const x = toScreenPx(map, view, [w, 0]);
	const y = toScreenPx(map, view, [0, h]);
	return `matrix(${(x[0] - o[0]) / w} ${(x[1] - o[1]) / w} ${(y[0] - o[0]) / h} ${(y[1] - o[1]) / h} ${o[0]} ${o[1]})`;
}

/** The Roto Brush overlay (registered in roto/register.ts). */
export function RotoOverlay(props: ProgramOverlayHostProps) {
	const session = props.session;
	const doc = props.doc;
	const view = props.view;
	const transport = props.transport;
	const engine = useEngineOrNull();
	const { frame, playing } = useOverlayFrame(transport);
	const tool = useRoto((s) => s.tool);
	const radius = useRoto((s) => s.radius);
	const activeId = useRoto((s) => s.activeRotoId);
	const shown = useRoto((s) => s.view);
	const running = useRoto((s) => s.running);
	const errors = useRoto((s) => s.errors);
	const selected = useStoreSelector(session.store, (s) => s.selection.timeline.clips);
	const drawn = useStoreSelector(session.store, (s) => s.transient ?? s.document);
	const readOnly = useStoreSelector(session.store, (s) => s.readOnly);
	const scene = useMemo(() => resolveSceneAt(doc, frame), [doc, frame]);
	const svgRef = useRef<SVGSVGElement>(null);
	const [cursor, setCursor] = useState<Vec2 | null>(null);
	const [stroke, setStroke] = useState<{
		kind: 'fg' | 'bg' | 'refine' | 'refineErase' | 'box';
		pts: Vec2[];
	} | null>(null);

	useEffect(() => {
		if (!engine) return;
		setRotoEngine(engine.client);
		return engine.subscribe((_e, raw) => handleRotoEvent(raw));
	}, [engine]);

	// The clip the brush paints on: the active roto's clip when selected, else the single selected picture clip.
	const seq = Object.values(drawn.sequences).find((s) => selected.some((id) => s.clips[id]));
	const active = activeId ? findRoto(drawn, activeId) : null;
	let clip: Clip | null = null;
	if (active && selected.includes(active.clipId))
		clip = drawn.sequences[active.sequenceId]!.clips[active.clipId] ?? null;
	else if (selected.length === 1 && seq) {
		const c = seq.clips[selected[0]!];
		if (c && (c.kind === 'video' || c.kind === 'still')) clip = c;
	}
	const layer = clip ? layerOf(scene, clip.id) : null;
	// The roto shown: the active one if it is on this clip, else the clip's first.
	const roto =
		clip && active && active.clipId === clip.id ? active.roto : clip ? (rotosOf(clip)[0] ?? null) : null;
	if ((!tool && !roto) || !clip || !layer || (playing && !stroke)) return null;
	const map: Mat3 = layerMapOf(layer.props);
	const box = layer.clip.intrinsicBox;
	const inv = invertMat3(map);
	const toMedia = (p: Vec2): Vec2 | null => (inv ? (applyMat3(inv, toSequence(view, p)) as Vec2) : null);
	const scale = (() => {
		const a = toScreenPx(map, view, [0, 0]);
		const b = toScreenPx(map, view, [100, 0]);
		return Math.max(1e-6, Math.hypot(b[0] - a[0], b[1] - a[1]) / 100);
	})();
	const mediaFrame = mediaFrameOfClip(drawn, clip, frame, roto?.rate ?? { num: 30, den: 1 });

	// The matte image at the playhead.
	let matteUrl: string | null = null;
	if (roto?.result && shown !== 'off') {
		const ref = {
			span: roto.span as [number, number],
			key: roto.result.key,
			url: rotoStorePath(roto.result.key),
			start: roto.result.start,
			end: roto.result.end,
		};
		if (
			rotoFrameState({ ...ref, rate: roto.rate, width: 0, height: 0, stale: false, name: '' }, mediaFrame) ===
			'matte'
		)
			matteUrl = rotoFrameUrl(ref, mediaFrame);
	}
	const job = roto ? running[roto.id] : undefined;
	const error = roto ? errors[roto.id] : undefined;

	const local = (e: { clientX: number; clientY: number }): Vec2 => {
		const r = svgRef.current!.getBoundingClientRect();
		return [e.clientX - r.left, e.clientY - r.top];
	};
	const onDown = (e: ReactPointerEvent) => {
		if (e.button !== 0 || readOnly || !tool) return;
		e.preventDefault();
		e.stopPropagation();
		if (transport.getState().playing) transport.pause();
		const p0 = local(e);
		if (e.ctrlKey || e.metaKey) {
			// Ctrl/Cmd-drag: brush size (After Effects).
			const r0 = rotoUi.get().radius;
			const move = (ev: PointerEvent) =>
				rotoUi.set({ radius: Math.max(2, Math.min(400, r0 + (local(ev)[0] - p0[0]))) });
			const up = () => {
				window.removeEventListener('pointermove', move, true);
				window.removeEventListener('pointerup', up, true);
			};
			window.addEventListener('pointermove', move, true);
			window.addEventListener('pointerup', up, true);
			return;
		}
		const refine = rotoUi.get().brush === 'refine';
		const kind = e.shiftKey ? 'box' : e.altKey ? (refine ? 'refineErase' : 'bg') : refine ? 'refine' : 'fg';
		const s = { kind, pts: [p0] } as { kind: typeof kind; pts: Vec2[] };
		setStroke(s);
		const move = (ev: PointerEvent) => {
			const p = local(ev);
			setCursor(p);
			if (kind === 'box') s.pts = [p0, p];
			else {
				const last = s.pts[s.pts.length - 1]!;
				if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 2) s.pts = [...s.pts, p];
			}
			setStroke({ ...s });
		};
		const up = () => {
			window.removeEventListener('pointermove', move, true);
			window.removeEventListener('pointerup', up, true);
			window.removeEventListener('pointercancel', cancel, true);
			setStroke(null);
			commit(s);
		};
		const cancel = () => {
			window.removeEventListener('pointermove', move, true);
			window.removeEventListener('pointerup', up, true);
			window.removeEventListener('pointercancel', cancel, true);
			setStroke(null);
		};
		window.addEventListener('pointermove', move, true);
		window.addEventListener('pointerup', up, true);
		window.addEventListener('pointercancel', cancel, true);
	};
	const commit = (s: { kind: 'fg' | 'bg' | 'refine' | 'refineErase' | 'box'; pts: Vec2[] }) => {
		const media = s.pts.map(toMedia).filter((p): p is Vec2 => !!p);
		if (!media.length || !clip) return;
		let rotoId: string | null;
		if (s.kind === 'box') {
			if (media.length < 2) return;
			const [a, b] = [media[0]!, media[media.length - 1]!];
			const rect: [number, number, number, number] = [
				Math.min(a[0], b[0]),
				Math.min(a[1], b[1]),
				Math.max(a[0], b[0]),
				Math.max(a[1], b[1]),
			];
			if (rect[2] - rect[0] < 4 || rect[3] - rect[1] < 4) return;
			rotoId = setBox(session, clip.id, frame, rect);
		} else
			rotoId = addStroke(session, clip.id, frame, {
				kind: s.kind,
				radius: Math.max(0.5, rotoUi.get().radius / scale),
				points: media.map((p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]),
			});
		if (!rotoId || !engine) return;
		const auto = rotoUi.get().autoPropagate;
		const loc = findRoto(session.getState().document, rotoId);
		const f = loc ? mediaFrameOfClip(session.getState().document, clip, frame, loc.roto.rate) : undefined;
		void runRoto(session, engine.client, rotoId, auto ? 'both' : 'frame', auto ? undefined : f);
	};

	const strokeColor = (k: string) =>
		k === 'bg' || k === 'refineErase'
			? ROTO_COLORS.subtract
			: k === 'refine'
				? ROTO_COLORS.refine
				: ROTO_COLORS.add;
	const [tr, tg, tb] = ROTO_COLORS.tint;
	const filterId = `roto-filter-${clip.id}`;
	return (
		<svg
			ref={svgRef}
			className="pointer-events-none absolute inset-0 h-full w-full touch-none select-none"
			data-testid="roto-overlay"
			data-roto-id={roto?.id ?? ''}
			data-media-frame={mediaFrame}
			role="presentation"
		>
			<defs>
				<filter id={`${filterId}-overlay`} colorInterpolationFilters="sRGB">
					<feColorMatrix type="matrix" values={`0 0 0 0 ${tr} 0 0 0 0 ${tg} 0 0 0 0 ${tb} 0.45 0 0 0 0`} />
				</filter>
				<filter id={`${filterId}-boundary`} colorInterpolationFilters="sRGB">
					<feColorMatrix
						in="SourceGraphic"
						type="matrix"
						values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 1 0 0 0 0"
						result="m"
					/>
					<feComponentTransfer in="m" result="bin">
						<feFuncA type="discrete" tableValues="0 1" />
					</feComponentTransfer>
					<feMorphology in="bin" operator="dilate" radius="1.5" result="grown" />
					<feComposite in="grown" in2="bin" operator="out" result="edge" />
					<feColorMatrix
						in="edge"
						type="matrix"
						values={`0 0 0 0 ${tr} 0 0 0 0 ${tg} 0 0 0 0 ${tb} 0 0 0 1 0`}
					/>
				</filter>
			</defs>
			{matteUrl ? (
				<g
					transform={affineOf(map, view, box.width, box.height)}
					data-testid="roto-matte"
					data-url={matteUrl}
				>
					<image
						href={matteUrl}
						x={0}
						y={0}
						width={box.width}
						height={box.height}
						preserveAspectRatio="none"
						filter={shown === 'alpha' ? undefined : `url(#${filterId}-${shown})`}
					/>
				</g>
			) : null}
			{tool ? (
				<rect
					x={0}
					y={0}
					width="100%"
					height="100%"
					fill="transparent"
					pointerEvents={readOnly ? 'none' : 'all'}
					style={{ cursor: 'none' }}
					onPointerDown={onDown}
					onPointerMove={(e) => setCursor(local(e))}
					onPointerLeave={() => setCursor(null)}
					data-testid="roto-brush-surface"
				/>
			) : null}
			{stroke && stroke.kind === 'box' && stroke.pts.length > 1 ? (
				<rect
					x={Math.min(stroke.pts[0]![0], stroke.pts[1]![0])}
					y={Math.min(stroke.pts[0]![1], stroke.pts[1]![1])}
					width={Math.abs(stroke.pts[1]![0] - stroke.pts[0]![0])}
					height={Math.abs(stroke.pts[1]![1] - stroke.pts[0]![1])}
					fill="none"
					stroke={ROTO_COLORS.add}
					strokeDasharray="4 3"
					strokeWidth={1.5}
				/>
			) : stroke ? (
				<polyline
					points={pts(stroke.pts)}
					fill="none"
					stroke={strokeColor(stroke.kind)}
					strokeOpacity={0.55}
					strokeWidth={radius * 2}
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			) : null}
			{tool && cursor ? (
				<g pointerEvents="none">
					<circle
						cx={cursor[0]}
						cy={cursor[1]}
						r={radius}
						fill="none"
						stroke={ROTO_COLORS.casing}
						strokeWidth={3}
					/>
					<circle
						cx={cursor[0]}
						cy={cursor[1]}
						r={radius}
						fill="none"
						stroke={ROTO_COLORS.cursor}
						strokeWidth={1}
					/>
				</g>
			) : null}
			{job || error ? (
				<text
					x={12}
					y={22}
					className="fill-pr-text-strong text-pr-small"
					style={{ paintOrder: 'stroke', stroke: ROTO_COLORS.casing, strokeWidth: 3 }}
					data-testid="roto-status"
				>
					{job
						? `${roto?.name ?? 'Roto'}: ${job.direction === 'frame' ? 'segmenting' : 'propagating'}${job.total ? ` ${job.done}/${job.total}` : '…'}`
						: `${roto?.name ?? 'Roto'}: ${error}`}
				</text>
			) : null}
		</svg>
	);
}
