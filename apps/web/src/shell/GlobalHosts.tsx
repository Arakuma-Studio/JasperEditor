// Window-level hosts mounted once above everything (S05:SH-004): tooltip provider, toast host, dialog
// host and the forced-cursor layer. UI prefs are applied to <html> here (DT-003).
import { DialogHost, ForcedCursorLayer, ToastHost, TooltipHost } from '@jasper/ui';
import { type ReactNode, useEffect } from 'react';
import { applyPrefs, useUiPrefs } from './prefs.ts';

export function GlobalHosts({
	children,
	runCommand,
}: {
	children?: ReactNode;
	runCommand?(id: string): void;
}) {
	const prefs = useUiPrefs();
	useEffect(() => applyPrefs(prefs), [prefs]);
	return (
		<TooltipHost enabled={prefs.tooltips}>
			{children}
			<DialogHost />
			<ToastHost runCommand={runCommand} />
			<ForcedCursorLayer />
		</TooltipHost>
	);
}
