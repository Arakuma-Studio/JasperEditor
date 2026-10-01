// Engine bootstrap (ARCHITECTURE §4.1/§7.5): the SPA uses relative URLs; on startup the EngineProvider
// pings GET /health. When it fails, this gate shows "Engine not reachable" with the dev hint, a retry,
// and a way to continue with the in-memory demo project (the browser-only profile W arrives in M2).
import { Button, Icon } from '@jasper/ui';
import { type ReactNode, useState } from 'react';
import { useEngine } from '../state/engine.tsx';

function EngineUnreachable({ onRetry, onContinue }: { onRetry(): void; onContinue(): void }) {
	return (
		<div
			className="flex h-full items-center justify-center bg-pr-app p-6 font-pr text-pr-text"
			data-testid="engine-unreachable"
		>
			<div className="flex max-w-[440px] flex-col items-center gap-3 rounded-pr-frame bg-pr-panel p-6 text-center">
				<span className="text-pr-warning">
					<Icon id="engine.offline" size={28} />
				</span>
				<h1 className="text-[length:var(--pr-font-size-dialog-title)] font-semibold text-pr-strong">
					Engine not reachable
				</h1>
				<p className="text-pr-muted">
					JasperEditor needs its local engine for projects, media and exports. Start it with{' '}
					<code className="rounded-pr-control bg-pr-field px-1 font-pr-mono text-pr-text">
						pnpm dev:engine
					</code>{' '}
					(or <code className="rounded-pr-control bg-pr-field px-1 font-pr-mono text-pr-text">pnpm dev</code>)
					and retry.
				</p>
				<div className="flex gap-2">
					<Button variant="primary" pill onClick={onRetry}>
						Retry
					</Button>
					<Button pill onClick={onContinue}>
						Continue without engine
					</Button>
				</div>
			</div>
		</div>
	);
}

/** Renders children once the engine answered (or while connecting); shows the unreachable screen otherwise. */
export function EngineGate({ children }: { children?: ReactNode }) {
	const engine = useEngine();
	const [bypass, setBypass] = useState(false);
	if (engine.status === 'disconnected' && !bypass)
		return <EngineUnreachable onRetry={() => engine.refresh()} onContinue={() => setBypass(true)} />;
	return <>{children}</>;
}
