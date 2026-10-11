export type WorkerEvent =
	| { type: 'progress'; fraction: number; stage: string }
	| { type: 'done' }
	| { type: 'error'; message: string };

export type RotoWorkerEvent =
	| WorkerEvent
	| {
			type: 'frame';
			frame: number;
			area: number;
			done: number;
			total: number;
	  };
