import type { Sequence } from '@jasper/project';
import {
	ADD_GUIDE_DIALOG,
	GUIDE_TEMPLATES_DIALOG,
	registerGuideDialogs,
} from '../panels/program/guide-dialogs.tsx';
import { monitorStores } from '../panels/program/monitor-store.ts';
import { clearGuides, guidesOf, monitorExtras, setComparison } from '../panels/program/monitor-view.ts';
import type { CommandCtx, UiCommand } from './types.ts';

function activeSeq(ctx: CommandCtx): Sequence | null {
	const s = ctx.session?.getState();
	const id = s?.activeSequenceId;
	return id ? ((s?.document.sequences[id] as Sequence | undefined) ?? null) : null;
}

const toggle = (
	id: string,
	label: string,
	key: 'showRulers' | 'showGuides' | 'lockGuides' | 'showDroppedFrames',
): UiCommand => ({
	id,
	label,
	scope: 'program',
	agentExposed: true,
	checked: () => monitorExtras.getState()[key],
	run: () => monitorExtras.setState((s) => ({ [key]: !s[key] })),
});

const fullscreenTargets = new Map<'program' | 'source', () => HTMLElement | null>();

/** Monitors register the element that goes full screen (their picture area). */
export function registerFullscreenTarget(
	kind: 'program' | 'source',
	get: () => HTMLElement | null,
): () => void {
	fullscreenTargets.set(kind, get);
	return () => {
		if (fullscreenTargets.get(kind) === get) fullscreenTargets.delete(kind);
	};
}

export function toggleFullScreenVideo(kind: 'program' | 'source'): boolean {
	if (typeof document === 'undefined') return false;
	if (document.fullscreenElement) {
		void document.exitFullscreen?.();
		return true;
	}
	const el = fullscreenTargets.get(kind)?.() ?? fullscreenTargets.get('program')?.();
	if (!el?.requestFullscreen) return false;
	void el.requestFullscreen().catch(() => undefined);
	return true;
}

export const monitorViewCommands: UiCommand[] = [
	toggle('program.showRulers', 'Show Rulers', 'showRulers'),
	toggle('program.showGuides', 'Show Guides', 'showGuides'),
	toggle('program.lockGuides', 'Lock Guides', 'lockGuides'),
	toggle('program.toggleDroppedFrames', 'Show Dropped Frame Indicator', 'showDroppedFrames'),
	{
		id: 'program.addGuide',
		label: 'Add Guide…',
		scope: 'global',
		agentExposed: true,
		when: (ctx) => activeSeq(ctx) !== null,
		run: (ctx) => {
			const seq = activeSeq(ctx);
			if (!seq) return;
			registerGuideDialogs();
			ctx.ui.openDialog(ADD_GUIDE_DIALOG, {
				sequenceId: seq.id,
				width: seq.settings.width,
				height: seq.settings.height,
			});
		},
	},
	{
		id: 'program.clearGuides',
		label: 'Clear Guides',
		scope: 'global',
		agentExposed: true,
		when: (ctx) => guidesOf(activeSeq(ctx)?.id ?? null).length > 0,
		run: (ctx) => {
			const seq = activeSeq(ctx);
			if (seq) clearGuides(seq.id);
		},
	},
	...(['manage', 'save'] as const).map(
		(mode): UiCommand => ({
			id: mode === 'save' ? 'program.saveGuidesAsTemplate' : 'program.manageGuides',
			label: mode === 'save' ? 'Save Guides as Template…' : 'Manage Guides…',
			scope: 'global',
			agentExposed: true,
			when: (ctx) => activeSeq(ctx) !== null,
			run: (ctx) => {
				const seq = activeSeq(ctx);
				if (!seq) return;
				registerGuideDialogs();
				ctx.ui.openDialog(GUIDE_TEMPLATES_DIALOG, {
					sequenceId: seq.id,
					width: seq.settings.width,
					height: seq.settings.height,
					save: mode === 'save',
				});
			},
		}),
	),
	{
		id: 'program.toggleComparisonView',
		label: 'Comparison View',
		scope: 'global',
		agentExposed: true,
		when: (ctx) => activeSeq(ctx) !== null,
		checked: () => monitorExtras.getState().comparison.enabled,
		run: (ctx) => {
			const c = monitorExtras.getState().comparison;
			const seq = activeSeq(ctx);
			// The reference starts at the playhead (Premiere), unless one was chosen before.
			if (!c.enabled && !c.reference && seq)
				setComparison({
					reference: { kind: 'sequence-frame', sequenceId: seq.id, frame: ctx.transport.getState().frame },
				});
			setComparison({ enabled: !c.enabled });
		},
	},
	{
		id: 'program.toggleSafeMargins',
		label: 'Safe Margins',
		scope: 'global',
		agentExposed: true,
		checked: () => monitorStores.program.getState().safeMargins,
		run: () => monitorStores.program.setState((s) => ({ safeMargins: !s.safeMargins })),
	},
	{
		id: 'monitor.fullScreenVideo',
		label: 'Toggle Full Screen',
		description: 'Show the focused monitor video full screen (Esc or Ctrl+` exits)',
		scope: 'global',
		agentExposed: true,
		run: (ctx) => {
			toggleFullScreenVideo(ctx.focus.panel === 'source' ? 'source' : 'program');
		},
	},
];
