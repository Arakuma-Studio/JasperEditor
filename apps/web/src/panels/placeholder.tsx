// Placeholder panel bodies until each owner (wave 2) ships the real panel.

import type { EditorSession } from '@jasper/session';
import { useSessionOrNull, useStoreSelector } from '@jasper/session/react';
import type { IconId } from '@jasper/ui';
import { Icon } from '@jasper/ui';
import type { ComponentType } from 'react';
import type { PanelDefinition, PanelKind, PanelProps } from './types.ts';

function SessionSummary({ session }: { session: EditorSession }) {
	const summary = useStoreSelector(session.store, (s) => {
		const seq = s.activeSequenceId ? s.document.sequences[s.activeSequenceId] : undefined;
		return `${s.document.name} · rev ${s.revision} · ${seq ? `${seq.videoTracks.length}V/${seq.audioTracks.length}A, ${Object.keys(seq.clips).length} clips` : 'no sequence'}`;
	});
	return <p className="text-pr-small text-pr-dim">{summary}</p>;
}

export function makePlaceholder(
	kind: PanelKind,
	title: string,
	icon: IconId,
	owner: string,
): ComponentType<PanelProps> {
	function Placeholder(props: PanelProps) {
		const session = useSessionOrNull();
		return (
			<div
				className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center"
				data-panel-kind={kind}
				data-instance-id={props.instanceId}
			>
				<span className="text-pr-icon">
					<Icon id={icon} size={24} />
				</span>
				<p className="text-pr-ui text-pr-text">{title}</p>
				<p className="text-pr-small text-pr-muted">Placeholder — implemented by {owner}</p>
				{session ? <SessionSummary session={session} /> : null}
			</div>
		);
	}
	Placeholder.displayName = `${kind}Placeholder`;
	return Placeholder;
}

type Meta = Omit<PanelDefinition, 'component' | 'title' | 'kind'> & { title: string; owner: string };

/** Builds a placeholder PanelDefinition (one per panel folder). */
export function placeholderPanel(kind: PanelKind, meta: Meta): PanelDefinition {
	const { title, owner, ...rest } = meta;
	return { kind, title: () => title, ...rest, component: makePlaceholder(kind, title, meta.icon, owner) };
}
