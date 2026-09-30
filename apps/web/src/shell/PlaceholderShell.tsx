// Placeholder editor shell (WP-00): a CSS grid with Program, Timeline, Project and Properties so the app
// runs end to end. WP-2A replaces it with the dockview-based EditorShell.
import { useSession, useSessionState } from '@jasper/session/react';
import { IconButton, PanelFrame } from '@jasper/ui';
import { useNavigate } from 'react-router';
import { getPanelDefinition } from '../panels/registry.ts';
import type { PanelKind } from '../panels/types.ts';
import { useEngine } from '../state/engine.tsx';

function Slot({ kind, area }: { kind: PanelKind; area: string }) {
	const def = getPanelDefinition(kind);
	const Component = def.component;
	return (
		<PanelFrame title={def.title({})} style={{ gridArea: area }} data-slot={kind}>
			<Component instanceId={`${kind}-1`} visible />
		</PanelFrame>
	);
}

export function PlaceholderShell() {
	const session = useSession();
	const name = useSessionState((s) => s.document.name);
	const dirty = useSessionState((s) => s.dirty);
	const readOnly = useSessionState((s) => s.readOnly);
	const engine = useEngine();
	const navigate = useNavigate();
	return (
		<div className="flex h-full flex-col bg-pr-app text-pr-text" data-testid="editor-shell">
			<header className="flex h-[var(--pr-header-h)] shrink-0 items-center gap-3 bg-pr-header px-3">
				<IconButton icon="app.home" label="Home" onClick={() => navigate('/')} />
				<span className="text-pr-strong">JasperEditor</span>
				<span className="text-pr-muted">
					{name}
					{dirty ? ' •' : ''}
					{readOnly ? ' (read-only)' : ''}
				</span>
				<span className="ml-auto text-pr-small text-pr-muted" data-testid="engine-chip">
					Engine: {engine.status}
					{engine.version ? ` ${engine.version}` : ''}
				</span>
				<span className="text-pr-small text-pr-dim">session {session.sessionId}</span>
			</header>
			<main
				className="grid min-h-0 flex-1 gap-[var(--pr-gutter)] p-[var(--pr-gutter)]"
				style={{
					gridTemplateColumns: 'minmax(220px, 1fr) minmax(320px, 2fr) minmax(240px, 1fr)',
					gridTemplateRows: 'minmax(200px, 1.2fr) minmax(160px, 1fr)',
					gridTemplateAreas: '"project program properties" "timeline timeline properties"',
				}}
			>
				<Slot kind="project" area="project" />
				<Slot kind="program" area="program" />
				<Slot kind="properties" area="properties" />
				<Slot kind="timeline" area="timeline" />
			</main>
		</div>
	);
}
