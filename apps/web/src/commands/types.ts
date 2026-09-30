// UI command contract (ARCHITECTURE §7.3, S05:KB-001). Frozen after wave 1 except additive changes.
import type { EngineClient } from '@jasper/engine-client';
import type { EditorSession, TransportStore } from '@jasper/session';
import type { IconId } from '@jasper/ui';
import type { ZodType } from 'zod';
import type { PanelKind } from '../panels/types.ts';
import type { PanelServices } from '../state/panel-services.ts';

/** Engine/runtime capabilities that gate commands (S05:SH-030/031). */
export type Capability =
	| 'engine'
	| 'nativeFfmpeg'
	| 'fframes'
	| 'remotionServerRender'
	| 'transcription'
	| 'proxies'
	| 'desktop';

export type CommandScope = 'global' | 'editing' | PanelKind;

export type FocusInfo = { panel: PanelKind | null; instanceId: string | null };

export type ToastRequest = {
	kind: 'info' | 'success' | 'warning' | 'error';
	message: string;
	detail?: string;
	action?: { label: string; command: string; args?: unknown };
	durationMs?: number;
};

export type DialogKind = string;

export interface CommandCtx {
	session: EditorSession | null;
	transport: TransportStore;
	focus: FocusInfo;
	services: PanelServices;
	engine: EngineClient;
	capabilities: ReadonlySet<Capability>;
	ui: { toast(r: ToastRequest): void; openDialog(kind: DialogKind, props?: Record<string, unknown>): void };
}

export interface UiCommand {
	id: string;
	label: string;
	description?: string;
	icon?: IconId;
	scope: CommandScope;
	when?(ctx: CommandCtx): boolean;
	checked?(ctx: CommandCtx): boolean;
	run(ctx: CommandCtx, args?: unknown): void | Promise<void>;
	argsSchema?: ZodType;
	/** Exposed to agents in Stage 2 (S05:AG-050). */
	agentExposed?: boolean;
	capability?: Capability;
	/** Honor key auto-repeat (steps, nudges; S05:KB-006). */
	repeat?: boolean;
	/** Hold-to-act commands receive keyup (JKL, spring-loaded tools; S05:KB-007). */
	onKeyUp?(ctx: CommandCtx): void;
}
