import type { ColumnRequest } from '../model/waveform.ts';

export type PeaksWorkerRequest =
	| { type: 'load'; key: string; peaks: Float32Array }
	| { type: 'reduce'; id: number; key: string; req: ColumnRequest };

export type PeaksWorkerResponse = { id: number; columns: Float32Array };
