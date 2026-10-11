export type DesktopWindowAction = 'minimize' | 'toggleMaximize' | 'close' | 'focus';

export type DesktopClipboardWrite = { json: string; html: string; text: string };

export type DesktopClipboard = {
	write(data: DesktopClipboardWrite): Promise<boolean>;
	read(): Promise<string | null>;
	readFiles(): Promise<string[]>;
};

export type DesktopCaptureRect = { x: number; y: number; width: number; height: number };

export type DesktopCaptureResult = {
	/** Base64 PNG of the requested CSS-pixel rectangle. */
	png: string;
	width: number;
	height: number;
};

export type DesktopMcpInfo = {
	/** Absolute path of jasper-mcp.mjs; null when it is not bundled. */
	entry: string | null;
	command: string;
	/** Packaged builds run the app executable with ELECTRON_RUN_AS_NODE=1. */
	env: Record<string, string>;
};

export type DesktopBridge = {
	runtime: 'desktop';
	pickMedia(): Promise<string[]>;
	revealInFolder(path: string): void;
	windowControls: { minimize(): void; toggleMaximize(): void; close(): void };
	focusWindow(): void;
	mcpInfo(): Promise<DesktopMcpInfo | null>;
	clipboard: DesktopClipboard;
	/** Empty when the File is not backed by a file on disk. */
	filePath(file: File): string;
	/** Null when the caller or rectangle is invalid; output is at most maxWidth pixels wide. */
	capturePage(rect: DesktopCaptureRect, maxWidth: number): Promise<DesktopCaptureResult | null>;
	/** Empty on success, otherwise the host application's error message. */
	openPath(path: string): Promise<string>;
	quit(): void;
};
