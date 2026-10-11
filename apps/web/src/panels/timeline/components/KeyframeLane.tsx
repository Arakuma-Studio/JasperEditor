// a clip's keyframe lane and rubber band on the timeline (Premiere): the chosen property's value drawn as a
// line across the clip with its keyframes. Selection tool: drag the line up/down (static value, or the two keys of
// the segment), Ctrl/Cmd-click it to add a keyframe, drag a keyframe (time and value), click/Shift-click to select
// keyframes (Delete removes them). Pen tool: click the line to add a keyframe, drag on the lane to marquee-select
// keyframes. Fade handles at the top corners of Opacity / Level lanes drag a fade in or out. Every drag is one
// History entry (a session gesture), Esc-free: releasing commits, a drag that ends where it started records
// nothing. Roving keys keep their derived times (only their value moves); an expression is flagged with "=".
import type { Clip, Command, Sequence } from '@jasper/project';
import type { ActiveTool, EditorSession, Gesture } from '@jasper/session';
import { type PointerEvent as ReactPointerEvent, useMemo, useRef, useState } from 'react';
import {
	fadeCommands,
	fadeLengths,
	formatLaneValue,
	keyAt,
	type LaneModel,
	laneModel,
	laneSpec,
	onBand,
	segmentAt,
	yToValue,
} from '../model/keyframe-lane.ts';

const DRAG_PX = 2;
const FADE_HANDLE = 7;

type Props = {
	session: EditorSession;
	seq: Sequence;
	clip: Clip;
	laneKey: string;
	/** Clip-area x of the clip start and lane geometry. */
	x: number;
	top: number;
	height: number;
	pxPerFrame: number;
	viewportWidth: number;
	tool: ActiveTool;
	locked: boolean;
	selectedKeys: ReadonlySet<string>;
	mac: boolean;
};

type Drag = {
	kind: 'band' | 'key' | 'fade' | 'marquee';
	g: Gesture | null;
	x0: number;
	y0: number;
	moved: boolean;
	model: LaneModel;
	keyIndex?: number;
	segment?: [number, number];
	side?: 'in' | 'out';
	fade0?: number;
	shift: boolean;
	base?: string[];
} | null;

export function KeyframeLane(p: Props) {
	const { session, seq, clip } = p;
	const registries = session.ctx.registries;
	const spec = useMemo(() => laneSpec(clip, p.laneKey, registries), [clip, p.laneKey, registries]);
	const w = clip.duration * p.pxPerFrame;
	const h = Math.max(4, p.height);
	const doc = session.getDrawn();
	const model = useMemo(
		() =>
			spec
				? laneModel(doc, seq, clip, spec, h, p.pxPerFrame, { x0: -p.x - 32, x1: p.viewportWidth - p.x + 32 })
				: null,
		[doc, seq, clip, spec, h, p.pxPerFrame, p.x, p.viewportWidth],
	);
	const drag = useRef<Drag>(null);
	const [readout, setReadout] = useState<{ x: number; y: number; text: string } | null>(null);
	const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
	if (!spec || !model) return null;
	const pen = p.tool === 'pen';
	const active = p.tool === 'selection' || pen;
	const local = (e: { clientX: number; clientY: number; currentTarget: Element }) => {
		const r = (e.currentTarget as Element).closest('[data-keyframe-lane]')!.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	};
	const frameAt = (x: number) =>
		clip.start + Math.max(0, Math.min(clip.duration - 1, Math.round(x / p.pxPerFrame)));
	const valueAtX = (x: number): number | undefined => {
		for (let i = 1; i < model.band.length; i++) {
			const [x0, y0] = model.band[i - 1]!;
			const [x1, y1] = model.band[i]!;
			if (x >= x0 && x <= x1)
				return yToValue(spec, y0 + ((y1 - y0) * (x - x0)) / (x1 - x0 || 1), h, model.range);
		}
		return typeof model.value === 'number' ? model.value : undefined;
	};
	const selectKeys = (ids: string[]) =>
		session.selectKeyframes(ids.length ? { clipOrTrackId: clip.id, keyframeIds: ids } : null);
	const addKey = (x: number) => {
		const value = valueAtX(x);
		if (value === undefined) return;
		const r = session.apply({
			label: 'Add Keyframe',
			origin: 'user',
			sequenceId: seq.id,
			commands: [{ type: 'keyframe.add', target: model.path, at: { sequenceFrame: frameAt(x) }, value }],
		});
		if (r.ok) {
			const id = (r.results[0] as { keyframeId?: string } | undefined)?.keyframeId;
			if (id) selectKeys([id]);
		}
	};

	const onDown = (e: ReactPointerEvent<Element>) => {
		if (e.button !== 0 || p.locked || !active) return;
		const pt = local(e);
		const ctrl = p.mac ? e.metaKey : e.ctrlKey;
		const ki = keyAt(model, pt.x, pt.y, h);
		const fades = spec.key === 'opacity' || spec.key === 'volumeDb' ? fadeLengths(model, clip) : null;
		const fadeSide =
			fades && pt.y <= FADE_HANDLE + 2
				? Math.abs(pt.x - fades.in * p.pxPerFrame) <= FADE_HANDLE
					? 'in'
					: Math.abs(pt.x - (w - fades.out * p.pxPerFrame)) <= FADE_HANDLE
						? 'out'
						: null
				: null;
		const band = onBand(model, pt.x, pt.y);
		let kind: NonNullable<Drag>['kind'] | null = null;
		if (fadeSide) kind = 'fade';
		else if (ki >= 0) kind = 'key';
		else if (band && (ctrl || pen)) {
			e.stopPropagation();
			e.preventDefault();
			addKey(pt.x);
			return;
		} else if (band) kind = 'band';
		else if (pen) kind = 'marquee';
		if (!kind) return;
		e.stopPropagation();
		e.preventDefault();
		e.currentTarget.setPointerCapture?.(e.pointerId);
		if (kind === 'key') {
			const k = model.keys[ki]!;
			const cur = session.getState().selection.keyframes;
			const ids = cur?.clipOrTrackId === clip.id ? cur.keyframeIds : [];
			if (e.shiftKey) selectKeys(ids.includes(k.id) ? ids.filter((x) => x !== k.id) : [...ids, k.id]);
			else if (!ids.includes(k.id)) selectKeys([k.id]);
		}
		drag.current = {
			kind,
			g: null,
			x0: pt.x,
			y0: pt.y,
			moved: false,
			model,
			keyIndex: ki,
			segment: kind === 'band' ? segmentAt(model, pt.x) : undefined,
			side: fadeSide ?? undefined,
			fade0: fadeSide && fades ? fades[fadeSide] : undefined,
			shift: e.shiftKey,
			base:
				kind === 'marquee' && e.shiftKey ? (session.getState().selection.keyframes?.keyframeIds ?? []) : [],
		};
	};

	const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		const d = drag.current;
		if (!d) return;
		const pt = local(e);
		const dx = pt.x - d.x0;
		const dy = pt.y - d.y0;
		if (!d.moved && Math.hypot(dx, dy) < DRAG_PX) return;
		d.moved = true;
		const m = d.model;
		if (d.kind === 'marquee') {
			const r = {
				x0: Math.min(d.x0, pt.x),
				y0: Math.min(d.y0, pt.y),
				x1: Math.max(d.x0, pt.x),
				y1: Math.max(d.y0, pt.y),
			};
			setMarquee(r);
			const hits = m.keys.filter(
				(k) => k.x >= r.x0 && k.x <= r.x1 && (k.y ?? h / 2) >= r.y0 && (k.y ?? h / 2) <= r.y1,
			);
			selectKeys([...new Set([...(d.base ?? []), ...hits.map((k) => k.id)])]);
			return;
		}
		if (!d.g)
			d.g = session.beginGesture(
				d.kind === 'fade'
					? d.side === 'in'
						? 'Fade In'
						: 'Fade Out'
					: d.kind === 'key'
						? 'Move Keyframes'
						: 'Adjust Keyframes',
			);
		const cmds: Command[] = [];
		let text = '';
		if (d.kind === 'band') {
			const [a, b] = d.segment!;
			const targets = [a, b].filter((i) => i >= 0).map((i) => m.keys[i]!);
			if (targets.length === 0) {
				const y0 = m.band[0]?.[1] ?? 0;
				const v = yToValue(spec, y0 + dy, h, m.range);
				cmds.push({ type: 'param.set', target: m.path, value: v });
				text = formatLaneValue(spec, v);
			} else
				for (const k of targets) {
					if (k.y === null) continue;
					const v = yToValue(spec, k.y + dy, h, m.range);
					cmds.push({ type: 'keyframe.update', keyframeId: k.id, value: v });
					text = formatLaneValue(spec, v);
				}
		} else if (d.kind === 'key') {
			const k = m.keys[d.keyIndex!]!;
			const lockY = d.shift && Math.abs(dx) > Math.abs(dy);
			const lockX = d.shift && !lockY;
			const df = lockX || k.roving ? 0 : Math.round(dx / p.pxPerFrame);
			const maxF = clip.start + clip.duration - 1;
			const nf = Math.max(clip.start, Math.min(maxF, k.frame + df));
			if (nf !== k.frame)
				cmds.push({ type: 'keyframe.move', keyframeIds: [k.id], delta: { frames: nf - k.frame } });
			if (k.y !== null && !lockY) {
				const v = yToValue(spec, k.y + dy, h, m.range);
				cmds.push({ type: 'keyframe.update', keyframeId: k.id, value: v });
				text = formatLaneValue(spec, v);
			}
			if (nf !== k.frame) text = `${text}${text ? ' · ' : ''}${nf - k.frame > 0 ? '+' : ''}${nf - k.frame} f`;
		} else if (d.kind === 'fade') {
			const frames = d.fade0! + (d.side === 'in' ? dx : -dx) / p.pxPerFrame;
			cmds.push(...fadeCommands(m, clip, d.side!, frames));
			text = `${d.side === 'in' ? 'Fade In' : 'Fade Out'}: ${Math.max(0, Math.round(frames))} f`;
		}
		const r = d.g.update(cmds);
		setReadout(
			r.ok ? { x: pt.x, y: pt.y, text } : { x: pt.x, y: pt.y, text: r.errors[0]?.message ?? 'Not allowed' },
		);
	};

	const onUp = () => {
		const d = drag.current;
		drag.current = null;
		setReadout(null);
		setMarquee(null);
		if (!d) return;
		if (d.g) {
			if (d.moved) d.g.commit();
			else d.g.cancel();
		} else if (!d.moved && d.kind === 'marquee' && !d.shift) selectKeys([]);
	};

	const fades = spec.key === 'opacity' || spec.key === 'volumeDb' ? fadeLengths(model, clip) : null;
	const bandPath = model.band
		.map(([bx, by], i) => `${i ? 'L' : 'M'}${bx.toFixed(1)},${by.toFixed(1)}`)
		.join('');
	return (
		<div
			className="absolute"
			style={{
				left: p.x,
				top: p.top,
				width: w,
				height: h,
				pointerEvents: pen && !p.locked ? 'auto' : 'none',
				cursor: pen ? 'crosshair' : undefined,
			}}
			data-keyframe-lane={clip.id}
			data-testid={`lane-${clip.id}`}
			data-lane-property={spec.key}
			onPointerDown={onDown}
			onPointerMove={onMove}
			onPointerUp={onUp}
			onPointerCancel={onUp}
		>
			<svg className="absolute inset-0 overflow-visible" width={w} height={h} aria-hidden>
				{bandPath ? (
					<>
						<path
							d={bandPath}
							fill="none"
							stroke="var(--pr-rubber-band, var(--pr-text-strong))"
							strokeWidth={1.25}
						/>
						<path
							d={bandPath}
							fill="none"
							stroke="transparent"
							strokeWidth={9}
							style={{ pointerEvents: active && !p.locked ? 'stroke' : 'none', cursor: 'ns-resize' }}
							onPointerDown={onDown}
							data-testid={`lane-band-${clip.id}`}
						/>
					</>
				) : null}
				{model.keys.map((k) => {
					const cy = k.y ?? h / 2;
					const sel = p.selectedKeys.has(k.id);
					const fill = sel ? 'var(--pr-accent)' : 'var(--pr-text-strong)';
					const common = {
						style: { pointerEvents: active && !p.locked ? 'all' : 'none', cursor: 'move' } as const,
						onPointerDown: onDown,
						'data-keyframe-id': k.id,
						'data-kf-id': k.id,
					};
					return k.roving ? (
						<circle key={k.id} cx={k.x} cy={cy} r={2.5} fill={fill} {...common} />
					) : k.hold ? (
						<rect key={k.id} x={k.x - 3} y={cy - 3} width={6} height={6} fill={fill} {...common} />
					) : (
						<polygon
							key={k.id}
							points={`${k.x},${cy - 4} ${k.x + 4},${cy} ${k.x},${cy + 4} ${k.x - 4},${cy}`}
							fill={fill}
							{...common}
						/>
					);
				})}
				{fades
					? (['in', 'out'] as const).map((side) => {
							const fx = side === 'in' ? fades.in * p.pxPerFrame : w - fades.out * p.pxPerFrame;
							return (
								<rect
									key={side}
									x={fx - FADE_HANDLE / 2}
									y={0}
									width={FADE_HANDLE}
									height={FADE_HANDLE}
									rx={1}
									fill="var(--pr-text-strong)"
									stroke="var(--pr-bg-app)"
									style={{ pointerEvents: active && !p.locked ? 'all' : 'none', cursor: 'ew-resize' }}
									onPointerDown={onDown}
									data-testid={`lane-fade-${side}-${clip.id}`}
								>
									<title>{side === 'in' ? 'Fade In' : 'Fade Out'}</title>
								</rect>
							);
						})
					: null}
				{model.expression ? (
					<text
						x={3}
						y={h - 3}
						fontSize={10}
						fill={model.expression.enabled ? 'var(--pr-expr-value, var(--pr-accent))' : 'var(--pr-text-dim)'}
					>
						{model.expression.enabled ? '= expression' : '= expression (off)'}
					</text>
				) : null}
				{marquee ? (
					<rect
						x={marquee.x0}
						y={marquee.y0}
						width={marquee.x1 - marquee.x0}
						height={marquee.y1 - marquee.y0}
						fill="none"
						stroke="var(--pr-accent)"
						strokeDasharray="3 2"
					/>
				) : null}
				{readout ? (
					<text x={readout.x + 8} y={Math.max(10, readout.y - 6)} fontSize={10} fill="var(--pr-text-strong)">
						{readout.text}
					</text>
				) : null}
			</svg>
		</div>
	);
}
