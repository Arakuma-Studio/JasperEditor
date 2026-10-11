import type { AgentTxInput, TransactionResult } from '@jasper/project';

export type AgentBridgeEvent =
	| 'doc.changed'
	| 'selection.changed'
	| 'playhead.changed'
	| 'approval.requested'
	| 'approval.resolved'
	| 'activity';

/** window.jasper (ARCHITECTURE §11): the in-page agent API. */
export interface JasperAgentApi {
	readonly version: 1;
	readonly projectId: string;
	schema(): Record<string, unknown>;
	query(name: string, args?: Record<string, unknown>): Promise<unknown>;
	transact(tx: AgentTxInput): Promise<TransactionResult>;
	on(event: AgentBridgeEvent, cb: (payload: unknown) => void): () => void;
}
