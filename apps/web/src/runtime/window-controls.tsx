import { IconButton } from '@jasper/ui';
import { getDesktopBridge } from './platform.ts';

export function WindowControls() {
	const bridge = getDesktopBridge();
	if (!bridge) return null;
	const wc = bridge.windowControls;
	return (
		<div className="pr-no-drag flex h-full items-center" data-testid="window-controls">
			<IconButton icon="app.windowMinimize" label="Minimize" size="small" onClick={() => wc.minimize()} />
			<IconButton
				icon="app.windowMaximize"
				label="Maximize"
				size="small"
				onClick={() => wc.toggleMaximize()}
			/>
			<IconButton
				icon="app.close"
				label="Close"
				size="small"
				onClick={() => wc.close()}
				className="hover:bg-pr-danger hover:text-pr-on-accent"
			/>
		</div>
	);
}
