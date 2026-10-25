// Effect Controls (S03 §13, S05:ECP-001…007): one clip (the primary selection, plus its linked partner
// of the other medium), two panes with a splitter (property list | mini-timeline), header chips, Video
// and Audio groups with intrinsic and applied effects (fx bypass, reset, reorder by drag, delete),
// property rows with stopwatch / navigator / reset, and a mini-timeline with keyframe selection,
// marquee, drag-to-move with snapping, and a right-click interpolation menu. Values are resolved at
// the playhead (EC-006). Twirling a numeric / vec2 property open shows its Value and Velocity graphs
// (S03:KF-022, GraphEditor.tsx).
// M3 (wp-m3-presets, S03:EC-004/FX-030): effect headers (intrinsic ones too) select with click / Ctrl/Shift-click
// and have a context menu with Save Preset… (presets.ts), Reset and Remove; presets dropped here apply to the shown
// clips.
import type { Command, Keyframe } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import {
	useSessionOrNull,
	useSessionState,
	useStoreSelector,
	useTransportFrame,
} from '@jasper/session/react';
import { cx, PointMenu, TimecodeText } from '@jasper/ui';
import {
	type DragEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { effectEditorFor } from '../../extensions/index.ts';
import { formatTimecode } from '../../gaps/time-display.ts';
import { MaskList } from '../../masks/MaskList.tsx';
import { useShellRuntimeOrNull } from '../../shell/context.tsx';
import { LiquifyToolsRow, PuppetList } from '../../simwarp/PuppetList.tsx';
import { useEngineOrNull } from '../../state/engine.tsx';
import {
	applyMessage,
	applyTextAnimation,
	dropSide,
	isTextAnimationDrag,
	readTextAnimationDrag,
} from '../../text-animation/actions.ts';
import { TextAnimationBars } from '../../text-animation/TextAnimationBars.tsx';
import { TextAnimationSection } from '../../text-animation/TextAnimationSection.tsx';
import { TextAnimatorList } from '../../text-animators/AnimatorList.tsx';
import { TimeRemapSection } from '../../time/TimeRemapSection.tsx';
import { openSimplify } from '../../tracking/simplify-actions.ts';
import { EaseKeyMenuItems } from '../easing/KeyMenu.tsx';
import {
	applyEffectToClips,
	isEffectDrag,
	JASPER_EFFECT_INSTANCE_MIME,
	readEffectDragPayload,
} from '../effects/drag.ts';
import { openSavePreset } from '../effects/presets/actions.ts';
import { isPresetRef } from '../effects/presets/apply.ts';
import { usePresetLibrary } from '../effects/presets/hooks.ts';
import { MiniButton, SelectField } from '../properties/controls/fields.tsx';
import { CaretGlyph, FxGlyph, GripGlyph, ResetGlyph, TrashGlyph } from '../properties/controls/glyphs.tsx';
import { useNotices } from '../properties/controls/Notices.tsx';
import { PropertyRow, type RowContext } from '../properties/controls/PropertyRow.tsx';
import { inspectorFocus } from '../properties/lib/focus.ts';
import { useInspectorData } from '../properties/lib/hooks.ts';
import { exactFrameOf, isAudioClip, isVisualClip, planReset, type Row } from '../properties/lib/model.ts';
import { useInspectorOps } from '../properties/lib/ops.ts';
import { ContextMenu } from '../timeline/components/Chrome.tsx';
import type { ContextMenuItem } from '../timeline/state/ui-store.ts';
import type { PanelProps } from '../types.ts';
import { GRAPH_HEIGHT, type GraphView, PropertyGraphs } from './GraphEditor.tsx';
import { graphKindOf } from './graph.ts';
import { MultiClipEffects } from './MultiClipEffects.tsx';
import { buildGroups, type FxSection, type RowFilter, rowVisible, shownClips } from './items.ts';
import {
	clipRange,
	commonPreset,
	INTERPOLATION_MENU,
	type InterpolationPreset,
	interpolationCommand,
	type Range,
	snapDelta,
} from './lib.ts';
import { KeyLane, Ruler, SummaryLane, usePlayheadLine } from './MiniTimeline.tsx';
import { presetSelection } from './presets.ts';
import { RoveAcrossTimeItem } from './RovingMenu.tsx';
import { SpatialInterpolationSubmenu } from './SpatialMenu.tsx';
import { TransitionSection } from './TransitionSection.tsx';

function usePersisted<T>(key: string, initial: T): [T, (v: T) => void] {
	const [v, setV] = useState<T>(() => {
		try {
			const raw = globalThis.localStorage?.getItem(key);
			return raw === null || raw === undefined ? initial : (JSON.parse(raw) as T);
		} catch {
			return initial;
		}
	});
	const set = useCallback(
		(next: T) => {
			setV(next);
			try {
				globalThis.localStorage?.setItem(key, JSON.stringify(next));
			} catch {
				// ignore
			}
		},
		[key],
	);
	return [v, set];
}

export function EffectControlsPanel(props: PanelProps) {
	const session = useSessionOrNull();
	return (
		<div
			className="flex h-full min-h-0 flex-col bg-pr-panel font-pr text-pr-ui text-pr-text outline-none"
			data-panel-kind="effectControls"
			data-instance-id={props.instanceId}
			data-testid="effect-controls-panel"
		>
			{session ? (
				<EffectControlsBody session={session} instanceId={props.instanceId} />
			) : (
				<Empty text="No project open." />
			)}
		</div>
	);
}

/** The pinned Crop section backed by a crop at the top of the stack (crop-order). */
const isPinnedCrop = (s: FxSection) => s.intrinsic && !!s.fx && s.id.endsWith(':crop');

function Empty({ text }: { text: string }) {
	return (
		<p className="p-3 text-pr-small text-pr-muted" data-testid="ec-empty">
			{text}
		</p>
	);
}

type KeyDrag = {
	x0: number;
	laneWidth: number;
	grabbedFrame: number;
	delta: number;
	active: boolean;
};

type KeyPointerDown = (
	e: ReactPointerEvent<HTMLElement>,
	info: { clipId: string; keyframeId: string; frame: number },
) => void;

function EffectControlsBody({ session, instanceId }: { session: EditorSession; instanceId: string }) {
	const data = useInspectorData();
	const frame = useTransportFrame(50).frame;
	const ops = useInspectorOps(session);
	const notices = useNotices();
	const registries = session.ctx.registries;
	const [showTimeline, setShowTimeline] = usePersisted(`jasper.ec.${instanceId}.timeline`, true);
	const [leftPct, setLeftPct] = usePersisted(`jasper.ec.${instanceId}.split`, 55);
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
	/** Twirled-open graph rows (`clipId:rowId` → graph height in px, S03:KF-022). */
	const [graphs, setGraphs] = usePersisted<Record<string, number>>(`jasper.ec.${instanceId}.graphs`, {});
	// manual vertical ranges of open graphs (absent = auto-fit).
	const [graphViews, setGraphViews] = usePersisted<Record<string, GraphView>>(
		`jasper.ec.${instanceId}.graphViews`,
		{},
	);
	const [filter, setFilter] = useState<RowFilter>('all');
	const [selectedFx, setSelectedFx] = useState<string | null>(null);
	const [menu, setMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null);
	// Selected effect headers (section ids) for Save Preset… and the header menu.
	const [headerSel, setHeaderSel] = useState<string[]>([]);
	const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(
		null,
	);
	const presetLib = usePresetLibrary();
	const [dropSlot, setDropSlot] = useState<number | 'end' | null>(null);
	const [dragTip, setDragTip] = useState<string | null>(null);
	const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
	const keySel = useSessionState((s) => s.selection.keyframes);
	// mask tracking / auto-trace need the engine; read-only sessions edit nothing.
	const engine = useEngineOrNull()?.client ?? null;
	const readOnly = useSessionState((s) => s.readOnly);
	const shell = useShellRuntimeOrNull();
	const selectedTransitions = useSessionState((s) => s.selection.timeline.transitions.length);
	const transportStore = useMemo(
		() => ({
			getState: () => session.transport.getState(),
			subscribe: (l: Parameters<typeof session.transport.subscribe>[0]) => session.transport.subscribe(l),
		}),
		[session],
	);
	const loop = useStoreSelector(transportStore, (s) => s.loop);
	const contentRef = useRef<HTMLDivElement>(null);
	const lineRef = useRef<HTMLDivElement>(null);
	const splitStart = useRef(0);

	const sel = data.selection;
	const primary = sel?.primary ?? null;
	const seq = sel?.seq ?? null;
	const range: Range = primary ? clipRange(primary) : { start: 0, end: 100 };
	usePlayheadLine(lineRef, session.transport, range);

	const clips = useMemo(() => (seq && primary ? shownClips(seq, primary) : []), [seq, primary]);
	const primaryId = primary?.id ?? null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: another clip starts with no selected headers
	useEffect(() => setHeaderSel([]), [primaryId]);
	const groups = useMemo(
		() => (seq ? buildGroups(data.doc, seq, clips, frame, registries) : []),
		[data.doc, seq, clips, frame, registries],
	);
	const selectedKeys = useMemo(
		() => new Set(keySel && clips.some((c) => c.id === keySel.clipOrTrackId) ? keySel.keyframeIds : []),
		[keySel, clips],
	);

	useEffect(() => {
		if (!menu) return;
		const close = () => setMenu(null);
		const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
		window.addEventListener('pointerdown', close);
		window.addEventListener('keydown', onKey);
		return () => {
			window.removeEventListener('pointerdown', close);
			window.removeEventListener('keydown', onKey);
		};
	}, [menu]);

	// stable handlers for the memoised key lanes (they call the latest closures, set further down).
	const laneHandlersRef = useRef<{
		onKeyPointerDown: KeyPointerDown;
		openKeyMenu: (e: ReactMouseEvent, clipId: string, id: string) => void;
		onLanePointerDown: (e: ReactPointerEvent<Element>) => void;
	} | null>(null);
	const laneHandlers = useMemo(
		() => ({
			onKeyPointerDown: (...a: Parameters<KeyPointerDown>) => laneHandlersRef.current?.onKeyPointerDown(...a),
			openKeyMenu: (e: ReactMouseEvent, clipId: string, id: string) =>
				laneHandlersRef.current?.openKeyMenu(e, clipId, id),
			onLanePointerDown: (e: ReactPointerEvent<Element>) => laneHandlersRef.current?.onLanePointerDown(e),
			seek: (f: number) => session.transport.seek(f),
		}),
		[session],
	);
	if (!sel || !seq) return <Empty text="Open a sequence to edit effects." />;
	// S10:TUI-040: a selected transition (no clip) shows its Transition section.
	if (!primary && selectedTransitions > 0)
		return (
			<div className="min-h-0 flex-1 overflow-y-auto" data-testid="ec-transition">
				<TransitionSection session={session} host="effectControls" />
			</div>
		);
	if (!primary) return <Empty text="Select a clip in the Timeline to see its effects." />;

	const ctx: RowContext = {
		doc: data.doc,
		seq,
		frame,
		ops,
		transport: session.transport,
		mode: 'effectControls',
		hint: notices.hint,
		confirmStopwatchOff: notices.confirmStopwatchOff,
	};
	// spec 13 AS-031: several clips of the primary's medium selected → "N clips" mode (shared effects, keys relative
	// to each clip's In, no mini-timeline). A clip and its linked partner of the other medium stay single-clip.
	const sameMedium = sel.clips.filter((c) => isAudioClip(c) === isAudioClip(primary) && (isAudioClip(c) || isVisualClip(c)));
	if (sameMedium.length > 1)
		return (
			<>
				<MultiClipEffects
					session={session}
					doc={data.doc}
					seq={seq}
					clips={sameMedium}
					anchor={primary}
					frame={frame}
					ctx={ctx}
				/>
				{notices.element}
			</>
		);
	const seqName =
		Object.values(data.doc.items).find(
			(i) =>
				(i as { kind: string }).kind === 'sequence' && (i as { sequenceId?: string }).sequenceId === seq.id,
		)?.name ?? 'Sequence';
	const mediaName = (() => {
		const id = (primary as { mediaId?: string }).mediaId;
		return id ? (data.doc.media[id]?.originalName ?? primary.name) : null;
	})();

	const selectKeys = (clipId: string, ids: string[]) =>
		session.selectKeyframes(ids.length ? { clipOrTrackId: clipId, keyframeIds: ids } : null);
	const deleteSelection = () => {
		if (selectedKeys.size) {
			ops.apply(`Delete ${selectedKeys.size} Keyframe${selectedKeys.size > 1 ? 's' : ''}`, [
				{ type: 'keyframe.remove', keyframeIds: [...selectedKeys] } as Command,
			]);
			session.selectKeyframes(null);
			return true;
		}
		if (selectedFx) {
			ops.apply('Remove Effect', [{ type: 'effect.remove', effectInstanceId: selectedFx } as Command]);
			setSelectedFx(null);
			inspectorFocus.set({ effectInstanceId: null });
			return true;
		}
		return false;
	};
	const applyPreset = (ids: string[], preset: InterpolationPreset) => {
		const label = INTERPOLATION_MENU.find((m) => m.preset === preset)?.label ?? preset;
		ops.apply(`Keyframe Interpolation: ${label}`, [interpolationCommand(ids, preset)]);
	};

	/** ParamPaths of the parameters holding the given keys (Simplify Keyframes… on fewer than 3 keys). */
	const keyParamPaths = (ids: readonly string[]): string[][] => {
		const want = new Set(ids);
		const out = new Map<string, string[]>();
		for (const g of groups)
			for (const s of g.sections)
				for (const r of s.rows)
					for (const b of r.bindings)
						if (b.path && (b.resolved.anim?.keyframes ?? []).some((k) => want.has(k.id)))
							out.set(b.path.join('/'), [...b.path]);
		return [...out.values()];
	};

	/** keyframe-sides: the keys with the given ids (the key context menu checks their common interpolation). */
	const keysWithIds = (ids: readonly string[]): Keyframe<unknown>[] => {
		const want = new Set(ids);
		const out = new Map<string, Keyframe<unknown>>();
		for (const g of groups)
			for (const s of g.sections)
				for (const r of s.rows)
					for (const b of r.bindings)
						for (const k of b.resolved.anim?.keyframes ?? []) if (want.has(k.id)) out.set(k.id, k);
		return [...out.values()];
	};

	const keyFramesOfClip = (clipId: string, exclude: ReadonlySet<string>) => {
		const out: number[] = [];
		for (const g of groups)
			for (const s of g.sections)
				for (const r of s.rows) {
					const b = r.bindings[0]!;
					if (b.clip.id !== clipId) continue;
					for (const k of b.resolved.anim?.keyframes ?? [])
						if (!exclude.has(k.id)) out.push(exactFrameOf(b.clip, k.time, seq));
				}
		return out;
	};

	/** Snap targets for key drags (S03:EC-023): playhead, clip edges and the clip's other keys. */
	const snapCandidates = (clipId: string, exclude: ReadonlySet<string>): number[] => {
		const clip = clips.find((c) => c.id === clipId);
		if (!clip) return [];
		return [
			session.transport.getState().frame,
			clip.start,
			clip.start + clip.duration - 1,
			...keyFramesOfClip(clipId, exclude),
		];
	};
	const openKeyMenu = (e: ReactMouseEvent, clipId: string, id: string) => {
		e.preventDefault();
		const ids = selectedKeys.has(id) ? [...selectedKeys] : [id];
		if (!selectedKeys.has(id)) selectKeys(clipId, ids);
		setMenu({ x: e.clientX, y: e.clientY, ids });
	};

	const onKeyPointerDown = (
		e: ReactPointerEvent<HTMLElement>,
		info: { clipId: string; keyframeId: string; frame: number },
	) => {
		if (e.button !== 0) return;
		const additive = e.shiftKey || e.ctrlKey || e.metaKey;
		let ids: string[];
		const sameClip = keySel?.clipOrTrackId === info.clipId;
		if (additive) {
			const cur = new Set(sameClip ? keySel!.keyframeIds : []);
			if (cur.has(info.keyframeId)) cur.delete(info.keyframeId);
			else cur.add(info.keyframeId);
			ids = [...cur];
			selectKeys(info.clipId, ids);
			return; // toggling never starts a drag
		}
		ids = sameClip && keySel!.keyframeIds.includes(info.keyframeId) ? keySel!.keyframeIds : [info.keyframeId];
		selectKeys(info.clipId, ids);
		const lane = (e.currentTarget as HTMLElement).closest('[data-lane]') as HTMLElement | null;
		const drag: KeyDrag = {
			x0: e.clientX,
			laneWidth: lane?.getBoundingClientRect().width || 300,
			grabbedFrame: info.frame,
			delta: 0,
			active: false,
		};
		const candidates = snapCandidates(info.clipId, new Set(ids));
		const framesPerPx = (range.end - range.start) / drag.laneWidth;
		const move = (ev: PointerEvent) => {
			const dx = ev.clientX - drag.x0;
			if (!drag.active) {
				if (Math.abs(dx) < 3) return;
				if (!ops.scrub.start(ids.length > 1 ? `Move ${ids.length} Keyframes` : 'Move Keyframe')) return;
				drag.active = true;
			}
			let delta = Math.round(dx * framesPerPx);
			if (!ev.shiftKey) delta = snapDelta(Math.round(drag.grabbedFrame), delta, candidates, 5 * framesPerPx);
			if (delta === drag.delta) return;
			drag.delta = delta;
			setDragTip(`${delta > 0 ? '+' : ''}${delta} f → ${Math.round(drag.grabbedFrame + delta)}`);
			ops.scrub.update([{ type: 'keyframe.move', keyframeIds: ids, delta: { frames: delta } } as Command]);
		};
		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('keydown', key, true);
			if (drag.active) ops.scrub.end(drag.delta === 0);
			setDragTip(null);
		};
		const key = (ev: KeyboardEvent) => {
			if (ev.key !== 'Escape') return;
			drag.delta = 0;
			up();
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('keydown', key, true);
	};

	const onLanePointerDown = (e: ReactPointerEvent<Element>) => {
		if (e.button !== 0 || !contentRef.current) return;
		const box = contentRef.current.getBoundingClientRect();
		const origin = { x: e.clientX, y: e.clientY };
		let moved = false;
		const move = (ev: PointerEvent) => {
			if (!moved && Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < 3) return;
			moved = true;
			setMarquee({
				x0: origin.x - box.left,
				y0: origin.y - box.top + (contentRef.current?.scrollTop ?? 0),
				x1: ev.clientX - box.left,
				y1: ev.clientY - box.top + (contentRef.current?.scrollTop ?? 0),
			});
		};
		const up = (ev: PointerEvent) => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			setMarquee(null);
			if (!moved) {
				session.selectKeyframes(null);
				return;
			}
			const [l, r] = [Math.min(origin.x, ev.clientX), Math.max(origin.x, ev.clientX)];
			const [t, b] = [Math.min(origin.y, ev.clientY), Math.max(origin.y, ev.clientY)];
			const hits = [...(contentRef.current?.querySelectorAll<HTMLElement>('[data-kf-id]') ?? [])].filter(
				(el) => {
					const rc = el.getBoundingClientRect();
					const cx0 = rc.left + rc.width / 2;
					const cy0 = rc.top + rc.height / 2;
					return cx0 >= l && cx0 <= r && cy0 >= t && cy0 <= b && el.dataset.kfClip === primary.id;
				},
			);
			// Graph keys carry the same ids as their lane glyphs: de-duplicate.
			selectKeys(primary.id, [...new Set(hits.map((el) => el.dataset.kfId!))]);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	};

	const onHeaderDragStart = (e: DragEvent, s: FxSection) => {
		if (!s.fx || (s.intrinsic && !isPinnedCrop(s))) return;
		e.dataTransfer.setData(JASPER_EFFECT_INSTANCE_MIME, s.fx.id);
		e.dataTransfer.effectAllowed = 'move';
	};
	const slotOf = (e: DragEvent): number | 'end' => {
		const header = (e.target as HTMLElement).closest('[data-fx-index]') as HTMLElement | null;
		return header ? Number(header.dataset.fxIndex) : 'end';
	};
	const onDragOver = (e: DragEvent) => {
		const types = Array.from(e.dataTransfer.types ?? []);
		// M2 (wp-m2-text-anim, S11:TXA-020): text animation presets apply to the shown text clip.
		if (isTextAnimationDrag(e.dataTransfer) && primary.kind === 'text') {
			e.preventDefault();
			e.dataTransfer.dropEffect = 'copy';
			return;
		}
		if (!isEffectDrag(e.dataTransfer) && !types.includes(JASPER_EFFECT_INSTANCE_MIME)) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = types.includes(JASPER_EFFECT_INSTANCE_MIME) ? 'move' : 'copy';
		setDropSlot(slotOf(e));
	};
	const onDrop = (e: DragEvent) => {
		const slot = slotOf(e);
		setDropSlot(null);
		// M2 (wp-m2-text-anim): over the mini-timeline the drop position picks the side, elsewhere In.
		const textAnim = readTextAnimationDrag(e.dataTransfer);
		if (textAnim) {
			e.preventDefault();
			const lane = (e.target as HTMLElement).closest('[data-lane], [data-testid="ec-ruler"]');
			const r = lane?.getBoundingClientRect();
			const f = r
				? range.start + ((e.clientX - r.left) / Math.max(1, r.width)) * (range.end - range.start)
				: null;
			const side = f === null ? 'in' : dropSide(primary, f);
			const m = applyMessage(applyTextAnimation(session, [primary.id], { side, ...textAnim }));
			if (m) notices.hint(m.text);
			return;
		}
		const instance = e.dataTransfer.getData(JASPER_EFFECT_INSTANCE_MIME);
		const effects = (primary as { effects?: { id: string }[] }).effects ?? [];
		if (instance) {
			e.preventDefault();
			const from = effects.findIndex((f) => f.id === instance);
			if (from < 0) return;
			const to = slot === 'end' ? effects.length - 1 : from < slot ? slot - 1 : slot;
			if (to !== from)
				ops.apply('Reorder Effects', [
					{ type: 'effect.reorder', effectInstanceId: instance, index: to } as Command,
				]);
			return;
		}
		const payload = readEffectDragPayload(e.dataTransfer);
		if (!payload) return;
		e.preventDefault();
		// M3 (wp-m3-presets, S03:FX-030): a preset applies to the shown clips it has something for.
		if (isPresetRef(payload.effectId)) {
			const r = applyEffectToClips(
				session,
				payload.effectId,
				clips.map((c) => c.id),
				slot === 'end' ? undefined : slot,
			);
			if (!r?.ok)
				notices.hint(
					r?.ok === false
						? (r.errors[0]?.message ?? '')
						: 'This preset cannot be applied to the selected clip.',
				);
			return;
		}
		const target = clips.find((c) => {
			const spec = registries.effects.get(payload.effectId);
			return (
				spec &&
				(spec.appliesTo === 'audio') ===
					(c.kind === 'audio' || c.kind === 'nest-audio' || c.kind === 'synthetic-audio')
			);
		});
		const r = target
			? applyEffectToClips(session, payload.effectId, [target.id], slot === 'end' ? undefined : slot)
			: null;
		if (!r?.ok) notices.hint('This effect cannot be applied to the selected clip.');
	};
	const resetSection = (s: FxSection) => {
		const cmds = s.rows.flatMap((r: Row) => planReset(r, data.doc, seq, frame).commands);
		ops.apply(`Reset ${s.title}`, cmds);
	};
	// S03:EC-004 header menu: Save Preset… (the selected headers of one clip), Reset, Remove.
	const openHeaderMenu = (e: ReactMouseEvent, s: FxSection) => {
		e.preventDefault();
		const ids = headerSel.includes(s.id) ? headerSel : [s.id];
		if (!headerSel.includes(s.id)) setHeaderSel([s.id]);
		const chosen = groups.flatMap((g) => g.sections).filter((x) => ids.includes(x.id));
		const pick = presetSelection(chosen);
		const online = presetLib.status === 'ready';
		const items: ContextMenuItem[] = [
			{
				kind: 'item',
				label: pick.ok && !online ? 'Save Preset… (needs the engine)' : 'Save Preset…',
				disabled: !pick.ok || !online,
				run: () => {
					if (!pick.ok) return;
					void openSavePreset(session, pick.clipId, pick.sections, pick.subject, pick.defaultName).then(
						(p) => {
							if (p) notices.hint(`Saved preset “${p.name}” to Effects ▸ Presets.`);
						},
					);
				},
			},
			{ kind: 'separator' },
			// Wave expressions: rename the instance (AE renames effects so expressions read effect("Speed")).
			...(s.fx && !s.intrinsic && !s.missing
				? [
						{
							kind: 'item' as const,
							label: 'Rename…',
							run: () => {
								const name = typeof window !== 'undefined' ? window.prompt('Effect name', s.title) : null;
								if (name === null) return;
								ops.apply('Rename Effect', [
									{ type: 'effect.rename', effectInstanceId: s.fx!.id, name: name.trim() || null } as Command,
								]);
							},
						},
					]
				: []),
			{
				kind: 'item',
				label: `Reset ${s.title}`,
				disabled: !!s.missing || !s.rows.some((r) => r.bindings.some((b) => b.path)),
				run: () => resetSection(s),
			},
			...(s.fx && (!s.intrinsic || isPinnedCrop(s))
				? [
						{
							kind: 'item' as const,
							label: `Remove ${s.title}`,
							run: () =>
								ops.apply('Remove Effect', [
									{ type: 'effect.remove', effectInstanceId: s.fx!.id } as Command,
								]),
						},
					]
				: []),
		];
		setHeaderMenu({ x: e.clientX, y: e.clientY, items });
	};

	const onPanelKeyDown = (e: ReactKeyboardEvent) => {
		if (e.defaultPrevented) return;
		const t = e.target as HTMLElement;
		if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
		if ((e.key === 'Delete' || e.key === 'Backspace') && deleteSelection()) e.preventDefault();
	};

	laneHandlersRef.current = { onKeyPointerDown, openKeyMenu, onLanePointerDown };
	const lane = (children: ReactNode) =>
		showTimeline ? (
			<div className="flex min-w-0 flex-1 self-stretch border-l border-pr-border-subtle">{children}</div>
		) : null;
	const left = { width: showTimeline ? `${leftPct}%` : '100%' };

	/** One property row with its key lane (and Value/Velocity graphs when twirled open). */
	const renderRow = (r: Row, editor?: ReactNode) => {
		const graphKey = `${r.bindings[0]!.clip.id}:${r.id}`;
		const hasGraph = graphKindOf(r.spec) !== null;
		const graphHeight = hasGraph ? graphs[graphKey] : undefined;
		return (
			<div key={r.id}>
				<div className="flex items-stretch">
					<div style={left} className="min-w-0 shrink-0">
						<PropertyRow
							row={r}
							ctx={ctx}
							editor={editor}
							indent
							twirl={
								hasGraph
									? {
											open: graphHeight !== undefined,
											onToggle: () => {
												const next = { ...graphs };
												if (graphHeight !== undefined) delete next[graphKey];
												else next[graphKey] = GRAPH_HEIGHT.initial;
												setGraphs(next);
											},
										}
									: undefined
							}
						/>
					</div>
					{lane(
						<KeyLane
							row={r}
							seq={seq}
							range={range}
							selected={selectedKeys}
							onKeyPointerDown={laneHandlers.onKeyPointerDown}
							onKeyDoubleClick={laneHandlers.seek}
							onKeyContextMenu={laneHandlers.openKeyMenu}
							onLanePointerDown={laneHandlers.onLanePointerDown}
						/>,
					)}
				</div>
				{graphHeight !== undefined ? (
					<PropertyGraphs
						row={r}
						seq={seq}
						doc={data.doc}
						range={range}
						height={graphHeight}
						onResize={(h) => setGraphs({ ...graphs, [graphKey]: h })}
						view={graphViews[graphKey]}
						onView={(v) => {
							const next = { ...graphViews };
							if (v.value || v.velocity) next[graphKey] = v;
							else delete next[graphKey];
							setGraphViews(next);
						}}
						leftStyle={left}
						showTimeline={showTimeline}
						ops={ops}
						selected={selectedKeys}
						keySel={keySel}
						selectKeys={selectKeys}
						onKeyContextMenu={openKeyMenu}
						onBackgroundPointerDown={onLanePointerDown}
						snapCandidates={snapCandidates}
						setTip={setDragTip}
					/>
				) : null}
			</div>
		);
	};
	// keyframe-sides: the Temporal Interpolation item the right-clicked keys share (checked in the key menu).
	const menuPreset = menu ? commonPreset(keysWithIds(menu.ids)) : null;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: panel-level keyboard shortcuts (Delete) and drops
		<div
			className="flex min-h-0 flex-1 flex-col outline-none"
			tabIndex={-1}
			onKeyDown={onPanelKeyDown}
			onDragOver={onDragOver}
			onDragLeave={() => setDropSlot(null)}
			onDrop={onDrop}
		>
			<header className="flex h-[28px] shrink-0 items-center gap-1 border-b border-pr-border-subtle px-2">
				<span
					className="truncate rounded-pr-control px-2 py-[2px] text-pr-small text-pr-dim"
					title="Source (master clip) effects arrive in a later milestone"
				>
					Source · {mediaName ?? '—'}
				</span>
				<span
					className="truncate rounded-pr-control bg-pr-selected px-2 py-[2px] text-pr-small text-pr-strong"
					data-testid="ec-chip"
				>
					{seqName} · {primary.name || primary.kind}
				</span>
				{sel.clips.length > 1 ? (
					<span className="truncate text-pr-small text-pr-muted">
						+{sel.clips.length - 1} more (edit in Properties)
					</span>
				) : null}
				<span className="ml-auto" />
				<MiniButton
					label={showTimeline ? 'Hide Timeline View' : 'Show Timeline View'}
					active={showTimeline}
					onClick={() => setShowTimeline(!showTimeline)}
				>
					<CaretGlyph open={!showTimeline} size={12} />
				</MiniButton>
			</header>
			{notices.element}
			<div
				ref={contentRef}
				className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
				data-testid="ec-content"
			>
				<div className="relative min-h-full">
					<div className="sticky top-0 z-[1] flex bg-pr-panel">
						<div style={left} className="shrink-0" />
						{lane(
							<Ruler
								seq={seq}
								range={range}
								clip={{
									start: primary.start,
									duration: primary.duration,
									name: primary.name || primary.kind,
								}}
								transport={session.transport}
								overlay={<TextAnimationBars clip={primary} range={range} ops={ops} />}
							/>,
						)}
					</div>
					{groups.map((g) => (
						<section key={`${g.id}`} data-ec-group={g.id}>
							<div className="flex h-[var(--pr-row-h)] items-center border-b border-pr-border-subtle bg-pr-panel-alt">
								<div style={left} className="shrink-0 px-2 font-semibold text-pr-strong">
									{g.title}
								</div>
								{lane(null)}
							</div>
							{g.sections.map((s) => {
								const open = !collapsed[s.id];
								const editor = s.fx ? effectEditorFor(s.fx.effectId) : undefined;
								const hidden = new Set(editor?.hideParams ?? []);
								const rows = s.rows.filter(
									(r) =>
										rowVisible(data.doc, seq, r, filter) &&
										!(s.fx && hidden.has(r.spec.key.slice(`effects.${s.fx.id}.`.length))),
								);
								if (filter !== 'all' && rows.length === 0) return null;
								// crop-order: the pinned Crop (stack index 0) is an effect header too: drag it down the stack,
								// or drop an effect on it to place that effect before the crop.
								const fxIndex =
									(!s.intrinsic || isPinnedCrop(s)) && s.stackIndex !== undefined ? s.stackIndex : undefined;
								return (
									<div key={s.id} data-ec-section={s.id}>
										{/* biome-ignore lint/a11y/noStaticElementInteractions: effect headers are drag handles for reordering (S03:EC-030) */}
										<div
											className={cx(
												'flex h-[var(--pr-row-h)] items-center',
												((selectedFx && s.fx?.id === selectedFx) || headerSel.includes(s.id)) &&
													'bg-pr-selected',
												fxIndex !== undefined && dropSlot === fxIndex && 'border-t-2 border-pr-accent',
											)}
											data-fx-index={fxIndex}
											data-ec-header={s.id}
											draggable={fxIndex !== undefined}
											onDragStart={(e) => onHeaderDragStart(e, s)}
											onContextMenu={(e) => openHeaderMenu(e, s)}
										>
											{/* biome-ignore lint/a11y/noStaticElementInteractions: row selection mirrors the timeline; keyboard via Delete */}
											{/* biome-ignore lint/a11y/useKeyWithClickEvents: see above */}
											<div
												style={left}
												data-testid="fx-header-select"
												className="flex min-w-0 shrink-0 items-center gap-1 pr-1 pl-1"
												onClick={(ev) => {
													const add = ev.ctrlKey || ev.metaKey || ev.shiftKey;
													setHeaderSel((cur) =>
														add
															? cur.includes(s.id)
																? cur.filter((x) => x !== s.id)
																: [...cur, s.id]
															: [s.id],
													);
													if (!s.fx) {
														if (!add) setSelectedFx(null);
														return;
													}
													setSelectedFx(s.fx.id);
													inspectorFocus.set({
														source: 'effectControls',
														effectInstanceId: s.fx.id,
														clipIds: [s.clip.id],
													});
												}}
											>
												<MiniButton
													label={open ? `Collapse ${s.title}` : `Expand ${s.title}`}
													onClick={() => setCollapsed({ ...collapsed, [s.id]: open })}
												>
													<CaretGlyph open={open} size={11} />
												</MiniButton>
												{s.intrinsic && !s.fx ? (
													<span className="w-[18px] text-center text-pr-small text-pr-muted">fx</span>
												) : (
													<MiniButton
														label={s.fx?.enabled ? `Bypass ${s.title}` : `Enable ${s.title}`}
														active={!!s.fx?.enabled}
														onClick={() =>
															s.fx &&
															ops.apply('Toggle Effect', [
																{
																	type: 'effect.setEnabled',
																	effectInstanceId: s.fx.id,
																	enabled: !s.fx.enabled,
																} as Command,
															])
														}
														data-testid={`fx-toggle-${s.fx?.id}`}
													>
														<FxGlyph size={13} off={!s.fx?.enabled} />
													</MiniButton>
												)}
												{fxIndex !== undefined ? (
													<span className="cursor-grab text-pr-dim" title="Drag to reorder">
														<GripGlyph size={11} />
													</span>
												) : null}
												<span
													className={cx(
														'min-w-0 flex-1 truncate',
														s.missing
															? 'text-pr-warning'
															: s.fx && !s.fx.enabled
																? 'text-pr-dim'
																: 'text-pr-text',
													)}
												>
													{s.title}
												</span>
												{s.threeDSwitch ? (
													<label
														className="flex cursor-pointer items-center gap-1 text-pr-small text-pr-muted"
														title="3D Layer (After Effects' 3D switch): Z position, orientation, X/Y rotation, materials, cameras and lights"
													>
														<input
															type="checkbox"
															checked={s.threeDSwitch.enabled}
															disabled={readOnly}
															data-testid={`ec-3d-switch-${s.threeDSwitch.clipId}`}
															onClick={(ev) => ev.stopPropagation()}
															onChange={(ev) =>
																ops.apply('3D Layer', [
																	{
																		type: 'clip.set3d',
																		clipIds: [s.threeDSwitch!.clipId],
																		enabled: ev.currentTarget.checked,
																	} as Command,
																])
															}
														/>
														3D Layer
													</label>
												) : null}
												{s.effect?.expensive ? (
													<span className="text-pr-small text-pr-muted" title="Expensive in preview">
														●
													</span>
												) : null}
												{!s.missing && s.rows.some((r) => r.bindings.some((b) => b.path)) ? (
													<MiniButton label={`Reset ${s.title}`} onClick={() => resetSection(s)}>
														<ResetGlyph size={12} />
													</MiniButton>
												) : null}
												{s.fx && (!s.intrinsic || isPinnedCrop(s)) ? (
													<MiniButton
														label={`Remove ${s.title}`}
														onClick={() =>
															ops.apply('Remove Effect', [
																{ type: 'effect.remove', effectInstanceId: s.fx!.id } as Command,
															])
														}
														data-testid={`fx-remove-${s.fx.id}`}
													>
														<TrashGlyph size={12} />
													</MiniButton>
												) : null}
											</div>
											{lane(<SummaryLane rows={s.rows} seq={seq} range={range} />)}
										</div>
										{open && s.id.endsWith(':timeRemap') ? (
											<div style={left} data-testid="ec-time-remap">
												<TimeRemapSection session={session} clipId={s.clip.id} frame={frame} />
											</div>
										) : null}
										{open && s.id.endsWith(':textAnimation') ? (
											<div style={left} data-testid="ec-text-animation">
												<TextAnimationSection session={session} clipIds={[s.clip.id]} host="effectControls" />
											</div>
										) : null}
										{open && editor && s.fx && s.effect ? (
											<div data-testid={`fx-editor-${s.fx.id}`} style={left}>
												<editor.component
													session={session}
													clip={s.clip}
													fx={s.fx}
													effect={s.effect}
													frame={frame}
													sequenceId={seq.id}
													host="effectControls"
												/>
											</div>
										) : null}
										{open ? rows.map((r) => renderRow(r)) : null}
										{open && s.textAnimators ? (
											<TextAnimatorList
												session={session}
												model={s.textAnimators}
												readOnly={readOnly}
												layout={{ left, lane }}
												collapsed={collapsed}
												setCollapsed={setCollapsed}
												renderRow={renderRow}
												filter={(r) => rowVisible(data.doc, seq, r, filter)}
												frame={frame}
											/>
										) : null}
										{open && s.fx?.effectId === 'jasper.liquify' ? (
											<LiquifyToolsRow readOnly={readOnly} layout={{ left, lane }} />
										) : null}
										{open && s.puppet ? (
											<PuppetList
												session={session}
												model={s.puppet}
												readOnly={readOnly}
												layout={{ left, lane }}
												collapsed={collapsed}
												setCollapsed={setCollapsed}
												renderRow={renderRow}
												filter={(r) => rowVisible(data.doc, seq, r, filter)}
											/>
										) : null}
										{open && s.masks ? (
											<MaskList
												session={session}
												engine={engine}
												list={s.masks}
												clip={s.clip}
												readOnly={readOnly}
												layout={{ left, lane }}
												collapsed={collapsed}
												setCollapsed={setCollapsed}
												renderRow={renderRow}
												filter={(r) => rowVisible(data.doc, seq, r, filter)}
											/>
										) : null}
									</div>
								);
							})}
						</section>
					))}
					<div
						className={cx('h-[24px]', dropSlot === 'end' && 'border-t-2 border-pr-accent')}
						data-testid="ec-drop-end"
					/>
					{showTimeline ? (
						<div className="pointer-events-none absolute inset-y-0 right-0" style={{ left: `${leftPct}%` }}>
							<div
								ref={lineRef}
								className="absolute inset-y-0 w-px bg-pr-playhead"
								// its own compositor layer, so a moving playhead does not repaint the key lanes below it.
								style={{ willChange: 'transform' }}
								data-testid="ec-playhead"
							/>
							<Splitter
								onStart={() => {
									splitStart.current = leftPct;
								}}
								onDrag={(dxPct) => setLeftPct(Math.min(80, Math.max(25, splitStart.current + dxPct)))}
								container={contentRef}
							/>
						</div>
					) : null}
					{marquee ? (
						<div
							className="pointer-events-none absolute border border-pr-accent"
							style={{
								left: Math.min(marquee.x0, marquee.x1),
								top: Math.min(marquee.y0, marquee.y1),
								width: Math.abs(marquee.x1 - marquee.x0),
								height: Math.abs(marquee.y1 - marquee.y0),
								background: 'color-mix(in srgb, var(--pr-accent) 15%, transparent)',
							}}
						/>
					) : null}
				</div>
			</div>
			<footer className="flex h-[26px] shrink-0 items-center gap-2 border-t border-pr-border-subtle px-2">
				<TimecodeText
					value={formatTimecode(frame, seq.settings.frameRate, { dropFrame: seq.settings.dropFrame })}
					data-testid="ec-time"
				/>
				{dragTip ? <span className="text-pr-small text-pr-accent">{dragTip}</span> : null}
				<span className="ml-auto" />
				<SelectField<RowFilter>
					value={filter}
					options={['all', 'animated', 'modified']}
					labels={['Show All Properties', 'Show Only Animated', 'Show Only Modified']}
					label="Filter properties"
					onChange={setFilter}
				/>
				<MiniButton label="Loop" active={loop} onClick={() => session.transport.setLoop(!loop)}>
					<ResetGlyph size={12} />
				</MiniButton>
			</footer>
			{headerMenu ? (
				<ContextMenu
					x={headerMenu.x}
					y={headerMenu.y}
					items={headerMenu.items}
					onClose={() => setHeaderMenu(null)}
					testId="ec-header-menu"
				/>
			) : null}
			{menu ? (
				<PointMenu
					x={menu.x}
					y={menu.y}
					className="min-w-[160px] rounded-pr-menu border border-pr-menu-border bg-pr-menu py-1 shadow-pr-overlay"
					onPointerDown={(e) => e.stopPropagation()}
					data-testid="ec-kf-menu"
				>
					{/* keyframe-sides: Premiere's Temporal Interpolation items; Ease In / Ease Out set one side. */}
					<div className="px-3 pt-[2px] pb-[3px] text-pr-small text-pr-muted" role="presentation">
						Temporal Interpolation
					</div>
					{INTERPOLATION_MENU.map((m, i) => {
						const on = menuPreset === m.preset;
						return (
							<button
								key={m.preset}
								type="button"
								role="menuitemradio"
								aria-checked={on}
								data-preset={m.preset}
								className={cx(
									'flex w-full items-center gap-2 px-3 py-[3px] text-left text-pr-ui text-pr-text hover:bg-pr-accent-fill hover:text-pr-on-accent',
									i === 5 && 'mt-1 border-t border-pr-border-subtle pt-1',
								)}
								onClick={() => {
									applyPreset(menu.ids, m.preset);
									setMenu(null);
								}}
							>
								<span className="inline-block w-3" aria-hidden>
									{on ? '✓' : ''}
								</span>
								{m.label}
							</button>
						);
					})}
					{/* S03:KF-021 (spatial-motion-path): Spatial Interpolation ▸ for keys of point properties. */}
					<SpatialInterpolationSubmenu
						groups={groups}
						ids={menu.ids}
						onApply={(label, commands) => {
							ops.apply(label, commands);
							setMenu(null);
						}}
					/>
					{/* keyframes-blend: Rove Across Time (After Effects). */}
					<RoveAcrossTimeItem
						groups={groups}
						ids={menu.ids}
						onApply={(label, commands) => {
							ops.apply(label, commands);
							setMenu(null);
						}}
					/>
					{/* Keyframe easing: Apply Ease ▸ (recent, favourites), Copy / Paste Ease, Open Easing Panel. */}
					<EaseKeyMenuItems onDone={() => setMenu(null)} />
					{shell ? (
						// S03:EC-024 / wp-clipboard: Copy keys (pasted at the playhead with Ctrl/Cmd+V).
						<button
							type="button"
							role="menuitem"
							className="mt-1 block w-full border-t border-pr-border-subtle px-3 pt-1 pb-[3px] text-left text-pr-ui text-pr-text hover:bg-pr-accent-fill hover:text-pr-on-accent"
							data-testid="ec-kf-copy"
							onClick={() => {
								void shell.run('edit.copy');
								setMenu(null);
							}}
						>
							Copy
						</button>
					) : null}
					{/* wp-m3-trackui (S09:TRK-023): Simplify Keyframes… — the selected keys (3+), else their parameters. */}
					<button
						type="button"
						role="menuitem"
						className="mt-1 block w-full border-t border-pr-border-subtle px-3 pt-1 pb-[3px] text-left text-pr-ui text-pr-text hover:bg-pr-accent-fill hover:text-pr-on-accent"
						data-testid="ec-kf-simplify"
						onClick={() => {
							const ids = menu.ids;
							setMenu(null);
							if (ids.length >= 3) {
								void openSimplify(session, { keyframeIds: ids }, `${ids.length} selected keyframes`);
								return;
							}
							const paths = keyParamPaths(ids);
							if (paths.length) void openSimplify(session, { targets: paths });
						}}
					>
						Simplify Keyframes…
					</button>
					<button
						type="button"
						role="menuitem"
						className="mt-1 block w-full border-t border-pr-border-subtle px-3 pt-1 pb-[3px] text-left text-pr-ui text-pr-text hover:bg-pr-accent-fill hover:text-pr-on-accent"
						onClick={() => {
							ops.apply('Delete Keyframes', [{ type: 'keyframe.remove', keyframeIds: menu.ids } as Command]);
							session.selectKeyframes(null);
							setMenu(null);
						}}
					>
						Delete
					</button>
				</PointMenu>
			) : null}
		</div>
	);
}

/** Pane splitter: reports the total drag distance since pointer-down (percent of the container). */
function Splitter(props: {
	onStart(): void;
	onDrag(totalDxPct: number): void;
	container: RefObject<HTMLDivElement | null>;
}) {
	const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		e.preventDefault();
		const x0 = e.clientX;
		const width = props.container.current?.getBoundingClientRect().width || 1;
		props.onStart();
		const move = (ev: PointerEvent) => props.onDrag(((ev.clientX - x0) / width) * 100);
		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	};
	return (
		<div
			className="pointer-events-auto absolute inset-y-0 left-[-3px] w-[5px] cursor-col-resize"
			onPointerDown={onPointerDown}
			title="Drag to resize"
			data-testid="ec-splitter"
		/>
	);
}
