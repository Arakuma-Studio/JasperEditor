// Runtime and platform detection (ARCHITECTURE §7.5, S05:SH-002). The desktop preload exposes
// `window.jasperDesktop` (apps/desktop/src/preload.cts); runtime differences go through this module,
// never through `if (electron)` checks inside panels.
import type { Platform, Runtime } from '../commands/keymap-defaults.ts';

/** Shape of the Electron preload bridge (mirrors apps/desktop/src/preload.cts). */
export interface JasperDesktopBridge {
	runtime: 'desktop';
	pickMedia(): Promise<string[]>;
	revealInFolder(path: string): void;
	windowControls: { minimize(): void; toggleMaximize(): void; close(): void };
	onMenuCommand(cb: (commandId: string) => void): () => void;
	/** Brings the window to the front (an agent asked to show a project). */
	focusWindow?(): void;
	/** Where the bundled `jasper-mcp` server lives and how to launch it (Help ▸ Connect an AI Agent…). */
	mcpInfo?(): Promise<DesktopMcpInfo>;
}

/** How an MCP client starts the `jasper-mcp` stdio server that ships with the desktop app. */
export type DesktopMcpInfo = {
	/** Absolute path of jasper-mcp.mjs, or null when it was not built/bundled. */
	entry: string | null;
	/** Executable that runs it: `node`, or the app binary itself in packaged builds. */
	command: string;
	/** Extra environment for `command` (packaged builds: ELECTRON_RUN_AS_NODE=1). */
	env: Record<string, string>;
};

declare global {
	interface Window {
		jasperDesktop?: JasperDesktopBridge;
	}
}

export function getDesktopBridge(): JasperDesktopBridge | null {
	return typeof window !== 'undefined' && window.jasperDesktop ? window.jasperDesktop : null;
}

/** `desktop` (Electron), `pwa` (installed, standalone display) or `web`. */
export function detectRuntime(): Runtime {
	if (typeof window === 'undefined') return 'web';
	if (window.jasperDesktop) return 'desktop';
	try {
		if (window.matchMedia?.('(display-mode: standalone)').matches) return 'pwa';
		if (window.matchMedia?.('(display-mode: window-controls-overlay)').matches) return 'pwa';
	} catch {
		/* matchMedia unavailable */
	}
	return 'web';
}

export function detectPlatform(): Platform {
	if (typeof navigator === 'undefined') return 'linux';
	const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
	const p = (nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent ?? '').toLowerCase();
	if (p.includes('mac') || p.includes('iphone') || p.includes('ipad')) return 'mac';
	if (p.includes('win')) return 'win';
	return 'linux';
}

/** Coarse primary pointer (touch devices), used by the layout-mode switch. */
export function hasCoarsePointer(): boolean {
	try {
		return typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
	} catch {
		return false;
	}
}
