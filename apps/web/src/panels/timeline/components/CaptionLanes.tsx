import type { Command, CommandOf } from '@jasper/project';
// caption tracks in the Timeline — their own area above the video tracks (as in Premiere), one lane per
// caption track (C1 at the bottom, next to the video tracks). Headers: label, name, language, eye (shown / burned
// in), lock, sync lock, active track. Caption blocks show their text; click selects (Shift adds), drag moves, an
// edge drag trims (live through a session gesture, one undo step), double-click opens Text ▸ Captions. Document
// edits are the ordinary clip commands (clip.move / clip.trim), so sync lock and invariants apply.
import {
	activeCaptionTrack,
	type CaptionsClip,
	captionClipsOf,
	captionClipText,
	type Sequence,
	type Track,
} from '@jasper/project';
import type { EditorSession, Gesture } from '@jasper/session';
import { IconButton, labelColor } from '@jasper/ui';
import { type PointerEvent as ReactPointerEvent, useRef, useState } from 'react';
import { deltaFramesFromPx, frameToX, type Viewport } from '../model/viewport.ts';
import type { ContextMenuItem } from '../state/ui-store.ts';

const CAPTION_LANE_PX = 26;
/** At most this many lanes are visible; more scroll. */
const MAX_VISIBLE = 4;
const EDGE_PX = 6;

type Props = {
	seq: Sequence;
	session: EditorSession;
	viewport: Viewport;
	headerWidth: number;
	selected: ReadonlySet<string>;
	openMenu(x: number, y: number, items: ContextMenuItem[]): void;
	toast(kind: 'info' | 'warning' | 'error', msg: string): void;
	/** Opens Text ▸ Captions on a caption (double-click). */
	openCaption(clipId: string): void;
	run(command: string, args?: unknown): void;
};

type Drag = {
	clipId: string;
	mode: 'move' | 'in' | 'out';
	x0: number;
	gesture: Gesture | null;
	delta: number;
	moved: boolean;
};

export function CaptionLanes(p: Props) {
	const { seq, session } = p;
	const drag = useRef<Drag | null>(null);
	const [, force] = useState(0);
	const lanes = [...seq.captionTracks].reverse(); // top → bottom: Cn … C1
	if (!lanes.length) return null;
	const active = activeCaptionTrack(seq);
	const rate = seq.settings.frameRate;
	const doc = session.getState().transient ?? session.getState().document;

	const apply = (label: string, commands: Command[]) => {
		const r = session.apply({ label, origin: 'user', sequenceId: seq.id, commands });
		if (!r.ok) p.toast('warning', r.errors[0]?.message ?? `${label} failed`);
		return r;
	};
	const flag = (t: Track, patch: CommandOf<'track.update'>['patch'], label: string) =>
		apply(label, [{ type: 'track.update', trackId: t.id, patch }]);

	const onBlockDown = (e: ReactPointerEvent<HTMLDivElement>, c: CaptionsClip, track: Track) => {
		if (e.button !== 0) return;
		e.stopPropagation();
		if (track.locked) return;
		const rect = e.currentTarget.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const mode = x < EDGE_PX ? 'in' : rect.width - x < EDGE_PX ? 'out' : 'move';
		if (e.shiftKey) session.select('timeline', [c.id], 'toggle', { primary: c.id });
		else if (!p.selected.has(c.id)) session.select('timeline', [c.id], 'replace', { primary: c.id });
		e.currentTarget.setPointerCapture?.(e.pointerId);
		drag.current = { clipId: c.id, mode, x0: e.clientX, gesture: null, delta: 0, moved: false };
	};
	const onBlockMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		const d = drag.current;
		if (!d) return;
		const delta = deltaFramesFromPx(e.clientX - d.x0, p.viewport.pxPerFrame);
		if (delta === d.delta && d.moved) return;
		if (!d.moved && Math.abs(e.clientX - d.x0) < 3) return;
		d.moved = true;
		d.delta = delta;
		if (!d.gesture) {
			try {
				d.gesture = session.beginGesture(d.mode === 'move' ? 'Move Caption' : 'Trim Caption');
			} catch {
				drag.current = null;
				return;
			}
		}
		const ids =
			d.mode === 'move'
				? [...new Set([...p.selected, d.clipId])].filter((id) => seq.clips[id]?.kind === 'captions')
				: [d.clipId];
		d.gesture.update(
			d.mode === 'move'
				? [{ type: 'clip.move', clipIds: ids, deltaFrames: delta, mode: 'overwrite' }]
				: [{ type: 'clip.trim', clipId: d.clipId, edge: d.mode, deltaFrames: delta, mode: 'regular' }],
		);
		force((n) => n + 1);
	};
	const onBlockUp = () => {
		const d = drag.current;
		drag.current = null;
		if (!d?.gesture) return;
		if (d.delta === 0) d.gesture.cancel();
		else {
			const r = d.gesture.commit();
			if (r && !r.ok) p.toast('warning', r.errors[0]?.message ?? 'Edit failed');
		}
	};

	const blockMenu = (e: React.MouseEvent, c: CaptionsClip) => {
		e.preventDefault();
		e.stopPropagation();
		if (!p.selected.has(c.id)) session.select('timeline', [c.id], 'replace', { primary: c.id });
		const playhead = session.transport.getState().frame;
		const sel = [...new Set([...p.selected, c.id])].filter((id) => seq.clips[id]?.kind === 'captions');
		const items: ContextMenuItem[] = [
			{ kind: 'item', label: 'Edit Text…', run: () => p.openCaption(c.id) },
			{
				kind: 'item',
				label: 'Split Caption at Playhead',
				disabled: !(c.start < playhead && playhead < c.start + c.duration),
				run: () => apply('Split Caption', [{ type: 'caption.split', at: playhead, clipIds: [c.id] }]),
			},
			{
				kind: 'item',
				label: 'Merge Captions',
				disabled: sel.length < 2,
				run: () => apply('Merge Captions', [{ type: 'caption.merge', clipIds: sel }]),
			},
			{ kind: 'separator' },
			{
				kind: 'item',
				label: 'Clear',
				run: () => apply('Delete Captions', [{ type: 'caption.delete', clipIds: sel }]),
			},
			{
				kind: 'item',
				label: 'Ripple Delete',
				run: () => apply('Delete Captions', [{ type: 'caption.delete', clipIds: sel, ripple: true }]),
			},
		];
		p.openMenu(e.clientX, e.clientY, items);
	};

	const headerMenu = (e: React.MouseEvent, t: Track) => {
		e.preventDefault();
		p.openMenu(e.clientX, e.clientY, [
			{
				kind: 'item',
				label: 'Set as Active Caption Track',
				run: () => apply('Active Caption Track', [{ type: 'caption.setActiveTrack', trackId: t.id }]),
			},
			{
				kind: 'item',
				label: 'Rename…',
				run: () => {
					const name =
						typeof window !== 'undefined' ? window.prompt('Caption track name', t.name ?? '') : null;
					if (name !== null) flag(t, { name: name || null }, 'Rename Track');
				},
			},
			{
				kind: 'item',
				label: 'Language…',
				run: () => {
					const lang =
						typeof window !== 'undefined'
							? window.prompt('Language (BCP-47, e.g. en, fr-CA)', t.language ?? '')
							: null;
					if (lang !== null) flag(t, { language: lang.trim() }, 'Caption Language');
				},
			},
			{ kind: 'separator' },
			{ kind: 'item', label: 'Add Caption Track', run: () => p.run('timeline.addCaptionTrack') },
			{
				kind: 'item',
				label: 'Delete Track',
				run: () => apply('Delete Tracks', [{ type: 'track.remove', trackIds: [t.id], force: true }]),
			},
		]);
	};

	const visible = Math.min(lanes.length, MAX_VISIBLE);
	return (
		<div
			className="flex shrink-0 border-b border-pr-border"
			style={{ height: visible * CAPTION_LANE_PX + 2 }}
			data-testid="timeline-caption-area"
		>
			<div className="min-h-0 w-full overflow-y-auto overflow-x-hidden">
				{lanes.map((t) => {
					const index = seq.captionTracks.indexOf(t);
					const label = `C${index + 1}`;
					const isActive = active?.id === t.id;
					const clips = captionClipsOf(seq, t.id);
					return (
						<div
							key={t.id}
							className="flex"
							style={{ height: CAPTION_LANE_PX }}
							data-testid={`timeline.captionTrack.${label}`}
						>
							{/* biome-ignore lint/a11y/noStaticElementInteractions: header context menu (track commands are also in the Sequence menu) */}
							<div
								className={`flex shrink-0 items-center gap-[2px] border-r border-b border-pr-border px-1 ${isActive ? 'bg-pr-selected' : 'bg-pr-panel'}`}
								style={{ width: p.headerWidth }}
								onContextMenu={(e) => headerMenu(e, t)}
							>
								<IconButton
									icon={t.locked ? 'track.lock' : 'track.unlock'}
									label={t.locked ? 'Unlock track' : 'Lock track'}
									toggled={t.locked ? 'on' : 'off'}
									onClick={() => flag(t, { locked: !t.locked }, t.locked ? 'Unlock Track' : 'Lock Track')}
									data-control="lock"
								/>
								<button
									type="button"
									className={`h-[20px] min-w-[26px] rounded-pr-pill px-1 text-[11px] leading-[20px] ${isActive ? 'bg-pr-accent text-pr-on-accent' : 'text-pr-muted hover:bg-pr-hover'}`}
									title={
										isActive
											? `${label} is the active caption track`
											: `Make ${label} the active caption track`
									}
									aria-pressed={isActive}
									onClick={() =>
										apply('Active Caption Track', [{ type: 'caption.setActiveTrack', trackId: t.id }])
									}
									data-control="active"
								>
									{label}
								</button>
								<IconButton
									icon={t.syncLock ? 'track.syncLock' : 'track.syncLockOff'}
									label={t.syncLock ? 'Sync lock on' : 'Sync lock off'}
									aria-pressed={!!t.syncLock}
									onClick={() =>
										flag(t, { syncLock: !t.syncLock }, t.syncLock ? 'Sync Lock Off' : 'Sync Lock On')
									}
									data-control="sync"
								/>
								<IconButton
									icon={t.visible === false ? 'track.outputOff' : 'track.output'}
									label={t.visible === false ? 'Show captions' : 'Hide captions'}
									onClick={() => flag(t, { visible: t.visible === false }, 'Toggle Caption Track Output')}
									data-control="eye"
								/>
								<span
									className="min-w-0 flex-1 truncate text-pr-small text-pr-muted"
									title={t.name ?? `Subtitles ${label}`}
								>
									{t.name ?? `Subtitles ${label}`}
									{t.language ? ` · ${t.language}` : ''}
								</span>
							</div>
							<div className="relative min-w-0 flex-1 overflow-hidden border-b border-pr-border bg-pr-panel-alt">
								{clips.map((c) => {
									const x0 = frameToX(p.viewport, c.start);
									const x1 = frameToX(p.viewport, c.start + c.duration);
									if (x1 < -10 || x0 > p.viewport.width + 10) return null;
									const sel = p.selected.has(c.id);
									const text = captionClipText(doc, c, rate)
										.replace(/<[^>]*>/g, '')
										.replace(/\n+/g, ' ⏎ ');
									return (
										// biome-ignore lint/a11y/noStaticElementInteractions: pointer editing surface; keyboard editing is in Text ▸ Captions
										<div
											key={c.id}
											className={`absolute top-[2px] bottom-[2px] cursor-grab overflow-hidden rounded-[2px] px-1 text-[11px] leading-[20px] text-pr-on-accent ${sel ? 'outline outline-2 outline-pr-focus' : ''} ${c.enabled ? '' : 'opacity-50'}`}
											style={{
												left: x0,
												width: Math.max(2, x1 - x0),
												background: labelColor(c.label),
											}}
											title={`${text}`}
											onPointerDown={(e) => onBlockDown(e, c, t)}
											onPointerMove={onBlockMove}
											onPointerUp={onBlockUp}
											onPointerCancel={() => {
												drag.current?.gesture?.cancel();
												drag.current = null;
											}}
											onDoubleClick={(e) => {
												e.stopPropagation();
												p.openCaption(c.id);
											}}
											onContextMenu={(e) => blockMenu(e, c)}
											data-testid={`timeline.caption.${c.id}`}
										>
											<span className="pointer-events-none whitespace-nowrap">{text || '(empty)'}</span>
										</div>
									);
								})}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}
