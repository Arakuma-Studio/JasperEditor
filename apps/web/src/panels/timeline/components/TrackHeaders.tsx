import type { Command } from '@jasper/project';
// Track headers (S02 §6: TL-250…268; S05:TLC-005/006). Document toggles (lock, sync lock, eye, mute,
// solo, name) go through `track.update` transactions (undoable); targeting and heights are view state.
import { type Sequence, type Track, trackList } from '@jasper/project';
import type { EditorSession, SequenceViewState } from '@jasper/session';
import { useStoreSelector } from '@jasper/session/react';
import { IconButton, openDialog } from '@jasper/ui';
import { memo, useRef, useState } from 'react';
import {
	ADD_TRACKS_DIALOG,
	DELETE_TRACKS_DIALOG,
	registerTrackDialogs,
} from '../../../gaps/TrackDialogs.tsx';
import { trackHeightSubmenu } from '../../../gaps/track-height-menu.ts';
import { useShellRuntimeOrNull } from '../../../shell/context.tsx';
import { patchedLabelOn, setPatch, sourceLabel, sourceTracksOf } from '../../source/patching.ts';
import { sourceMonitorState } from '../../source/source-state.ts';
import {
	DEFAULT_AUDIO_PX,
	DEFAULT_VIDEO_PX,
	type TrackAreaLayout,
	type TrackRow,
	visibleRows,
} from '../model/layout.ts';
import { wheelZoomFactor } from '../model/viewport.ts';
import type { TimelineController } from '../state/controller.ts';
import type { ContextMenuItem, TimelineUiStore } from '../state/ui-store.ts';

type TrackHeadersProps = {
	seq: Sequence;
	layout: TrackAreaLayout;
	view: SequenceViewState;
	session: EditorSession;
	controller: TimelineController;
	ui: TimelineUiStore;
	openMenu(x: number, y: number, items: ContextMenuItem[]): void;
	toast(kind: 'info' | 'warning' | 'error', msg: string): void;
};

type Kind = 'video' | 'audio';
const labelOf = (kind: Kind, index: number) => `${kind === 'video' ? 'V' : 'A'}${index + 1}`;
const defaultName = (kind: Kind, index: number) => `${kind === 'video' ? 'Video' : 'Audio'} ${index + 1}`;

function apply(p: TrackHeadersProps, label: string, commands: Command[]) {
	if (commands.length === 0) return;
	const r = p.session.apply({ label, origin: 'user', sequenceId: p.seq.id, commands });
	if (!r.ok) p.toast('warning', r.errors[0]?.message ?? `${label} failed`);
	return r;
}

type Flag = 'locked' | 'syncLock' | 'output' | 'mute' | 'solo';
const LABELS: Record<Flag, [string, string]> = {
	locked: ['Lock Track', 'Unlock Track'],
	syncLock: ['Sync Lock On', 'Sync Lock Off'],
	output: ['Toggle Track Output', 'Toggle Track Output'],
	mute: ['Mute Track', 'Unmute Track'],
	solo: ['Solo Track', 'Unsolo Track'],
};

function flagValue(t: Track, f: Flag): boolean {
	if (f === 'output') return t.output !== false;
	if (f === 'mute') return !!t.mute;
	if (f === 'solo') return !!t.solo;
	return t[f];
}

/** Toggle with TL-257 modifier conventions. */
function toggleFlag(
	p: TrackHeadersProps,
	kind: Kind,
	track: Track,
	f: Flag,
	e: { shiftKey: boolean; altKey: boolean },
) {
	const list = trackList(p.seq, kind);
	const next = !flagValue(track, f);
	const cmd = (t: Track, v: boolean): Command => ({ type: 'track.update', trackId: t.id, patch: { [f]: v } });
	let commands: Command[];
	if (e.shiftKey) commands = list.map((t) => cmd(t, next));
	else if (e.altKey && f === 'solo') commands = list.map((t) => cmd(t, t.id === track.id));
	else if (e.altKey && f === 'output') {
		const mem = p.ui.getState().soloEyeMemory;
		if (mem && mem.trackId === track.id) {
			commands = list.map((t) => cmd(t, mem.previous[t.id] ?? true));
			p.ui.setState({ soloEyeMemory: null });
		} else {
			p.ui.setState({
				soloEyeMemory: {
					trackId: track.id,
					previous: Object.fromEntries(list.map((t) => [t.id, t.output !== false])),
				},
			});
			commands = list.map((t) => cmd(t, t.id === track.id));
		}
	} else commands = [cmd(track, next)];
	const r = apply(p, LABELS[f][next ? 0 : 1], commands);
	if (r?.ok && f === 'locked' && next) {
		// TL-250: locking clears selections on the track and removes its targeting.
		const ids = new Set(e.shiftKey ? list.map((t) => t.id) : [track.id]);
		const sel = p.session.getState().selection.timeline.clips.filter((id) => {
			const c = p.session.getCommitted().sequences[p.seq.id]?.clips[id];
			return c && ids.has(c.trackId);
		});
		if (sel.length) p.session.select('timeline', sel, 'remove', { linked: false });
		const tg = p.view.targeting;
		p.session.setView(p.seq.id, {
			targeting: {
				video: tg.video.filter((id) => !ids.has(id)),
				audio: tg.audio.filter((id) => !ids.has(id)),
			},
		});
	}
}

function toggleTarget(p: TrackHeadersProps, kind: Kind, track: Track, shift: boolean) {
	if (track.locked) return;
	const tg = p.view.targeting;
	const cur = kind === 'video' ? tg.video : tg.audio;
	const on = !cur.includes(track.id);
	const unlocked = trackList(p.seq, kind)
		.filter((t) => !t.locked)
		.map((t) => t.id);
	const next = shift ? (on ? unlocked : []) : on ? [...cur, track.id] : cur.filter((id) => id !== track.id);
	p.session.setView(p.seq.id, { targeting: { ...tg, [kind]: next } });
}

function headerMenu(
	p: TrackHeadersProps,
	kind: Kind,
	track: Track,
	index: number,
	startRename: () => void,
): ContextMenuItem[] {
	// header rows do not re-render for clip-only changes (HeaderRow), so the clips come from the session.
	const clips = Object.values((p.session.getDrawn().sequences[p.seq.id] ?? p.seq).clips);
	const clipCount = clips.filter((c) => c.trackId === track.id).length;
	const list = trackList(p.seq, kind);
	const empty = list.filter((t) => !clips.some((c) => c.trackId === t.id));
	return [
		{
			kind: 'item',
			label: 'Add Track',
			run: () => apply(p, 'Add Track', [{ type: 'track.add', kind, index: index + 1 }]),
		},
		{
			kind: 'item',
			label: clipCount ? `Delete Track (${clipCount} clips)…` : 'Delete Track',
			disabled: list.length <= 1 || track.locked,
			run: () => {
				if (
					clipCount &&
					typeof window !== 'undefined' &&
					!window.confirm(`Delete track and its ${clipCount} clips?`)
				)
					return;
				apply(p, 'Delete Track', [{ type: 'track.remove', trackIds: [track.id], force: clipCount > 0 }]);
			},
		},
		{
			kind: 'item',
			label: 'Delete Empty Tracks',
			disabled: empty.length === 0 || empty.length === list.length,
			run: () =>
				apply(p, 'Delete Empty Tracks', [
					{ type: 'track.remove', trackIds: empty.slice(0, list.length - 1).map((t) => t.id) },
				]),
		},
		{ kind: 'separator' },
		// edit-ux (Premiere track "Show Keyframes"): clip keyframe lanes on this track, drawn when it is expanded.
		{
			kind: 'item',
			label: 'Show Clip Keyframes',
			checked: p.view.keyframeDisplay[track.id] !== 'none',
			run: () => {
				const d = { ...p.view.keyframeDisplay };
				if (d[track.id] === 'none') delete d[track.id];
				else d[track.id] = 'none';
				p.session.setView(p.seq.id, { keyframeDisplay: d });
			},
		},
		// gaps (TL-10): one track's height, and Premiere's Add Tracks… / Delete Tracks… dialogs.
		trackHeightSubmenu(p.session, p.seq, track.id, kind),
		{ kind: 'separator' },
		{ kind: 'item', label: 'Rename', run: startRename },
		{ kind: 'separator' },
		{
			kind: 'item',
			label: 'Add Tracks…',
			run: () => {
				registerTrackDialogs();
				void openDialog(ADD_TRACKS_DIALOG, { session: p.session, sequenceId: p.seq.id });
			},
		},
		{
			kind: 'item',
			label: 'Delete Tracks…',
			run: () => {
				registerTrackDialogs();
				void openDialog(DELETE_TRACKS_DIALOG, { session: p.session, sequenceId: p.seq.id });
			},
		},
	];
}

type HeaderProps = TrackHeadersProps & { row: TrackRow; track: Track };

/**
 * a header row draws its track, its layout row and the view's targeting, source patching and keyframe
 * display; the clips of the sequence never reach it (the context menu reads them from the session). So a clip drag,
 * a trim, a scroll or a zoom does not re-render the headers and their tooltip buttons.
 */
function headerPropsEqual(a: HeaderProps, b: HeaderProps): boolean {
	for (const k of Object.keys(a) as (keyof HeaderProps)[]) {
		if (k === 'seq' || k === 'view') continue;
		if (a[k] !== b[k]) return false;
	}
	// The view parts a header uses (a scroll or zoom replaces the view record but not these).
	return (
		a.seq.id === b.seq.id &&
		a.seq.videoTracks === b.seq.videoTracks &&
		a.seq.audioTracks === b.seq.audioTracks &&
		a.view.targeting === b.view.targeting &&
		a.view.sourcePatching === b.view.sourcePatching &&
		a.view.keyframeDisplay === b.view.keyframeDisplay
	);
}

const HeaderRow = memo(Header, headerPropsEqual);

function Header(props: HeaderProps) {
	const { row, track } = props;
	const kind: Kind = row.kind;
	const [editing, setEditing] = useState<string | null>(null);
	const lastExpanded = useRef(72);
	const targeted = (kind === 'video' ? props.view.targeting.video : props.view.targeting.audio).includes(
		track.id,
	);
	const runtime = useShellRuntimeOrNull();
	const anySolo = props.seq.audioTracks.some((t) => t.solo);
	const silencedBySolo = kind === 'audio' && anySolo && !track.solo;
	const label = labelOf(kind, row.index);
	const name = track.name ?? defaultName(kind, row.index);
	const expanded = row.height >= 48;
	const startRename = () => setEditing(track.name ?? '');
	const commitRename = () => {
		if (editing === null) return;
		const v = editing.trim();
		apply(props, 'Rename Track', [
			{ type: 'track.update', trackId: track.id, patch: { name: v === '' ? null : v } },
		]);
		setEditing(null);
	};
	const resize = (e: React.PointerEvent, dir: 1 | -1) => {
		e.stopPropagation();
		const y0 = e.clientY;
		const h0 = row.height;
		const el = e.currentTarget as HTMLElement;
		el.setPointerCapture?.(e.pointerId);
		const move = (ev: PointerEvent) =>
			props.controller.setTrackHeight(track.id, h0 + dir * (ev.clientY - y0));
		const up = () => {
			el.removeEventListener('pointermove', move);
			el.removeEventListener('pointerup', up);
		};
		el.addEventListener('pointermove', move);
		el.addEventListener('pointerup', up);
	};
	const pill = (on: boolean) =>
		on
			? 'bg-pr-target text-pr-on-accent'
			: 'text-pr-muted outline outline-1 -outline-offset-1 outline-[var(--pr-border-strong)]';
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: pointer editing surface; keyboard access goes through keymap commands
		<div
			className="absolute right-0 left-0 flex items-start gap-[2px] px-1 pt-[3px] text-pr-small"
			style={{
				top: row.y,
				height: row.height,
				background: targeted ? 'var(--pr-bg-panel-raised)' : 'var(--pr-bg-panel)',
				borderBottom: '1px solid var(--pr-border-subtle)',
			}}
			data-track-header={track.id}
			onContextMenu={(e) => {
				e.preventDefault();
				props.openMenu(e.clientX, e.clientY, headerMenu(props, kind, track, row.index, startRename));
			}}
			onDoubleClick={(e) => {
				if ((e.target as HTMLElement).closest('button,input')) return;
				const def = kind === 'video' ? DEFAULT_VIDEO_PX : DEFAULT_AUDIO_PX;
				if (row.height >= 48) {
					lastExpanded.current = row.height;
					props.controller.setTrackHeight(track.id, def);
				} else props.controller.setTrackHeight(track.id, lastExpanded.current);
			}}
			onWheel={(e) => {
				if (!e.altKey) return;
				props.controller.setTrackHeight(track.id, row.height * wheelZoomFactor(e.deltaY));
			}}
		>
			<SourcePatchCell {...props} kind={kind} track={track} label={label} />
			<IconButton
				icon={track.locked ? 'track.lock' : 'track.unlock'}
				label={track.locked ? 'Unlock track' : 'Lock track'}
				toggled={track.locked ? 'on' : 'off'}
				onClick={(e) => toggleFlag(props, kind, track, 'locked', e)}
				data-control="lock"
			/>
			<button
				type="button"
				className={`h-[20px] min-w-[26px] rounded-pr-pill px-1 text-[11px] leading-[20px] ${pill(targeted)}`}
				title={`Target ${label}`}
				aria-pressed={targeted}
				disabled={track.locked}
				onClick={(e) => toggleTarget(props, kind, track, e.shiftKey)}
				data-control="target"
			>
				{label}
			</button>
			<IconButton
				icon={track.syncLock ? 'track.syncLock' : 'track.syncLockOff'}
				label={track.syncLock ? 'Sync lock on' : 'Sync lock off'}
				// Premiere draws sync lock as a plain glyph (on) or an empty box (off), not an accent toggle.
				aria-pressed={!!track.syncLock}
				onClick={(e) => toggleFlag(props, kind, track, 'syncLock', e)}
				data-control="sync"
			/>
			{kind === 'video' ? (
				<IconButton
					icon={track.output === false ? 'track.outputOff' : 'track.output'}
					label="Toggle track output"
					onClick={(e) => toggleFlag(props, kind, track, 'output', e)}
					data-control="eye"
				/>
			) : (
				<>
					<button
						type="button"
						className={`h-[20px] w-[20px] rounded-pr-control text-[11px] font-semibold ${track.mute ? 'text-pr-on-accent' : silencedBySolo ? 'text-pr-dim' : 'text-pr-muted hover:bg-pr-hover'}`}
						style={track.mute ? { background: 'var(--pr-track-mute)' } : undefined}
						title="Mute track"
						aria-pressed={!!track.mute}
						onClick={(e) => toggleFlag(props, kind, track, 'mute', e)}
						data-control="mute"
					>
						M
					</button>
					<button
						type="button"
						className={`h-[20px] w-[20px] rounded-pr-control text-[11px] font-semibold ${track.solo ? '' : 'text-pr-muted hover:bg-pr-hover'}`}
						style={
							track.solo
								? { background: 'var(--pr-track-solo)', color: 'var(--pr-track-solo-text)' }
								: undefined
						}
						title="Solo track (Alt: exclusive)"
						aria-pressed={!!track.solo}
						onClick={(e) => toggleFlag(props, kind, track, 'solo', e)}
						data-control="solo"
					>
						S
					</button>
					{/* audio-mix: Voice-over Record (records into this track at the playhead; again to stop) */}
					<IconButton
						icon="track.voiceOver"
						label="Voice-over record"
						onClick={() => void runtime?.run('audio.voiceoverRecord', { trackId: track.id })}
						data-control="voiceover"
					/>
				</>
			)}
			{editing !== null ? (
				<input
					// biome-ignore lint/a11y/noAutofocus: inline rename (TL-258)
					autoFocus
					className="h-[20px] min-w-0 flex-1 rounded-pr-control bg-pr-field px-1 text-pr-text outline-none"
					value={editing}
					aria-label="Track name"
					onChange={(e) => setEditing(e.target.value)}
					onBlur={commitRename}
					onKeyDown={(e) => {
						e.stopPropagation();
						if (e.key === 'Enter') commitRename();
						if (e.key === 'Escape') setEditing(null);
					}}
				/>
			) : (
				// biome-ignore lint/a11y/noStaticElementInteractions: pointer editing surface; keyboard access goes through keymap commands
				<span
					className={`min-w-0 flex-1 truncate leading-[20px] ${expanded ? 'text-pr-text' : 'text-pr-muted'}`}
					onDoubleClick={(e) => {
						e.stopPropagation();
						startRename();
					}}
					title={name}
					data-testid="track-name"
				>
					{name}
				</span>
			)}
			<div
				className="absolute right-0 left-0 h-[4px] cursor-row-resize"
				style={kind === 'video' ? { top: -2 } : { bottom: -2 }}
				onPointerDown={(e) => resize(e, kind === 'video' ? -1 : 1)}
				data-resize-handle
				data-testid="track-height-handle"
			/>
		</div>
	);
}

export function TrackHeaders(props: TrackHeadersProps) {
	const { layout, seq } = props;
	const regions = [layout.video, layout.audio];
	return (
		<div
			className="absolute inset-0"
			onWheel={(e) => {
				if (!e.shiftKey || e.altKey) return;
				// Shift+wheel over the header column scales all tracks of the region (TL-263).
				const region =
					e.clientY - e.currentTarget.getBoundingClientRect().top < layout.dividerTop
						? layout.video
						: layout.audio;
				const f = wheelZoomFactor(e.deltaY);
				for (const r of region.rows) props.controller.setTrackHeight(r.trackId, r.height * f);
			}}
			data-testid="timeline-track-headers"
		>
			{regions.map((region) => (
				<div
					key={region.kind}
					className="absolute right-0 left-0 overflow-hidden"
					style={{ top: region.top, height: region.height }}
				>
					<div className="absolute right-0 left-0" style={{ top: -region.top, height: layout.height }}>
						{visibleRows(region).map((row) => {
							const track = trackList(seq, row.kind)[row.index];
							return track ? <HeaderRow key={track.id} {...props} row={row} track={track} /> : null;
						})}
						{region.kind === 'audio' && layout.masterY !== null ? (
							<div
								className="absolute right-0 left-0 flex items-center gap-2 px-2 text-pr-small text-pr-muted"
								style={{ top: layout.masterY, height: 28, background: 'var(--pr-bg-panel)' }}
								data-master-row
							>
								<span className="text-pr-text">Master</span>
								<span className="ml-auto text-pr-value tabular-nums">
									{seq.master.volumeDb.value.toFixed(1)}
								</span>
							</div>
						) : null}
					</div>
				</div>
			))}
			<div
				className="absolute right-0 left-0"
				style={{ top: layout.dividerTop, height: 4, background: 'var(--pr-bg-app)', cursor: 'row-resize' }}
				data-testid="timeline-region-divider"
				onPointerDown={(e) => {
					const el = e.currentTarget;
					el.setPointerCapture?.(e.pointerId);
					const top = el.parentElement!.getBoundingClientRect().top;
					const move = (ev: PointerEvent) =>
						props.session.setView(seq.id, {
							dividerRatio: Math.min(0.9, Math.max(0.1, (ev.clientY - top) / Math.max(1, layout.height))),
						});
					const up = () => {
						el.removeEventListener('pointermove', move);
						el.removeEventListener('pointerup', up);
					};
					el.addEventListener('pointermove', move);
					el.addEventListener('pointerup', up);
				}}
				data-divider-handle
			/>
		</div>
	);
}

/**
 * the source patching column (Premiere "Source patching and track targeting"): while a clip is open in the
 * Source monitor, each source track (V1, A1…) shows on the sequence track it is patched to. Click it to switch that
 * source track off/on (off = left out of Insert/Overwrite); click an empty cell to patch the first source track of
 * that kind there; drag a source indicator onto another track to repatch it.
 */
function SourcePatchCell(props: TrackHeadersProps & { kind: Kind; track: Track; label: string }) {
	const { seq, view, session, kind, track } = props;
	const itemId = useStoreSelector(sourceMonitorState, (s) => s.itemId);
	const doc = session.getCommitted();
	const item = itemId ? (doc.items[itemId] ?? null) : null;
	const counts = sourceTracksOf(doc, item, session.getState().toggles.insertSequencesAsNests !== false);
	const n = kind === 'video' ? counts.video : counts.audio;
	if (!item || n === 0) return <span className="w-[22px] shrink-0" aria-hidden />;
	const here = patchedLabelOn(seq, view, counts, track.id);
	const first = sourceLabel(kind, 0);
	const onClick = () => {
		if (track.locked) return;
		if (here) setPatch(session, seq.id, here.label, here.on ? null : track.id);
		else setPatch(session, seq.id, first, track.id);
	};
	return (
		<button
			type="button"
			className={`h-[20px] w-[22px] shrink-0 rounded-pr-pill text-[10px] leading-[20px] ${
				here?.on
					? 'bg-pr-accent-fill text-pr-on-accent'
					: here
						? 'text-pr-dim outline outline-1 -outline-offset-1 outline-[var(--pr-border-strong)]'
						: 'text-pr-dim hover:bg-pr-hover'
			}`}
			title={
				here
					? `Source ${here.label} ${here.on ? 'patched here (click to switch off)' : 'off (click to switch on)'}`
					: `Patch source ${first} to ${props.label}`
			}
			aria-label={here ? `Source ${here.label} patch` : `Patch source ${first} to ${props.label}`}
			aria-pressed={here ? here.on : undefined}
			disabled={track.locked}
			draggable={!!here}
			onDragStart={(e) => {
				if (here) e.dataTransfer.setData('application/x-jasper-source-patch', here.label);
			}}
			onDragOver={(e) => {
				if (e.dataTransfer.types.includes('application/x-jasper-source-patch')) e.preventDefault();
			}}
			onDrop={(e) => {
				const l = e.dataTransfer.getData('application/x-jasper-source-patch');
				if (!l || track.locked || (l[0] === 'V') !== (kind === 'video')) return;
				e.preventDefault();
				setPatch(session, seq.id, l, track.id);
			}}
			onClick={onClick}
			data-testid={`source-patch-${props.label}`}
			data-control="source-patch"
		>
			{here?.label ?? ''}
		</button>
	);
}
