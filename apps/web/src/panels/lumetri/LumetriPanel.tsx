// Lumetri Color panel (S06:CGU-001, CGU-005): edits the first `jasper.lumetri` instance of the selected clip
// (the primary timeline selection of the active sequence); the first edit adds the instance in the same undo
// step. Header: clip chip, instance bypass (fx), before/after (preview-only bypass of every colour effect of the
// clip) and "Add Lumetri" for stacked grades.
import type { Command } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useSessionOrNull, useTransportFrame } from '@jasper/session/react';
import { Icon } from '@jasper/ui';
import { colorBypass, useColorBypass } from '../../color/actions.ts';
import { LumetriEditor } from '../../color/LumetriEditor.tsx';
import { firstLumetri, gradeEligible } from '../../color/model.ts';
import { MiniButton } from '../properties/controls/fields.tsx';
import { FxGlyph } from '../properties/controls/glyphs.tsx';
import { useNotices } from '../properties/controls/Notices.tsx';
import { useInspectorData } from '../properties/lib/hooks.ts';
import { useInspectorOps } from '../properties/lib/ops.ts';
import type { PanelProps } from '../types.ts';

export function LumetriPanel(props: PanelProps) {
	const session = useSessionOrNull();
	return (
		<div
			className="flex h-full min-h-0 flex-col bg-pr-panel font-pr text-pr-ui text-pr-text"
			data-panel-kind="lumetri"
			data-instance-id={props.instanceId}
			data-testid="lumetri-panel"
		>
			{session ? <LumetriBody session={session} /> : <Empty text="No project open." />}
		</div>
	);
}

function Empty({ text }: { text: string }) {
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
			<span className="text-pr-icon">
				<Icon id="panel.lumetri" size={24} />
			</span>
			<p className="text-pr-small text-pr-muted" data-testid="lumetri-empty">
				{text}
			</p>
		</div>
	);
}

function LumetriBody({ session }: { session: EditorSession }) {
	const data = useInspectorData();
	const frame = useTransportFrame(50).frame;
	const ops = useInspectorOps(session);
	const notices = useNotices();
	const bypassed = useColorBypass();
	const sel = data.selection;
	if (!sel) return <Empty text="Open a sequence to grade its clips." />;
	const clip = sel.primary;
	if (!clip) return <Empty text="Select a clip in the Timeline to grade it." />;
	if (!gradeEligible(clip)) return <Empty text="Lumetri Color applies to video, still and graphic clips." />;
	const fx = firstLumetri(clip);
	const effect = fx ? session.ctx.registries.effects.get(fx.effectId, fx.effectVersion) : undefined;
	const isBypassed = bypassed.includes(clip.id);
	const count = ((clip as { effects?: { effectId: string }[] }).effects ?? []).filter(
		(e) => e.effectId === 'jasper.lumetri',
	).length;

	return (
		<>
			<header className="flex h-[28px] shrink-0 items-center gap-1 border-b border-pr-border-subtle px-2">
				<span
					className="min-w-0 truncate rounded-pr-control bg-pr-selected px-2 py-[2px] text-pr-small text-pr-strong"
					data-testid="lumetri-chip"
					title={clip.name}
				>
					{clip.name || clip.kind}
				</span>
				{count > 1 ? (
					<span className="shrink-0 text-pr-small text-pr-muted" title="The panel edits the first instance">
						1 of {count}
					</span>
				) : null}
				<span className="flex-1" />
				{fx ? (
					<MiniButton
						label={fx.enabled ? 'Bypass Lumetri Color' : 'Enable Lumetri Color'}
						active={fx.enabled}
						onClick={() =>
							ops.apply(fx.enabled ? 'Bypass Lumetri Color' : 'Enable Lumetri Color', [
								{ type: 'effect.setEnabled', effectInstanceId: fx.id, enabled: !fx.enabled } as Command,
							])
						}
						data-testid="lumetri-fx-toggle"
					>
						<FxGlyph size={13} off={!fx.enabled} />
					</MiniButton>
				) : null}
				<MiniButton
					label={isBypassed ? 'Show Grade (After)' : 'Show Ungraded (Before)'}
					active={isBypassed}
					onClick={() => colorBypass.toggle(clip.id)}
					data-testid="lumetri-before-after"
				>
					<Icon id="color.compare" size={14} />
				</MiniButton>
			</header>
			{notices.element}
			{isBypassed ? (
				<p
					className="shrink-0 border-b border-pr-border-subtle px-2 py-1 text-pr-small text-pr-warning"
					data-testid="lumetri-bypass-note"
				>
					Before: the Program monitor shows this clip without its colour effects.
				</p>
			) : null}
			<div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden" data-testid="lumetri-content">
				<LumetriEditor
					session={session}
					doc={data.doc}
					seq={sel.seq}
					clip={clip}
					fx={fx}
					effect={effect}
					frame={frame}
					ops={ops}
					host="panel"
					hint={notices.hint}
					confirmStopwatchOff={notices.confirmStopwatchOff}
				/>
			</div>
		</>
	);
}
