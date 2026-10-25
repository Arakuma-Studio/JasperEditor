export type WorkerEvent =
	| { type: 'progress'; fraction: number; stage: string }
	| { type: 'done' }
	| { type: 'error'; message: string };

/** jasper-speech: the execution providers really used by an attempt (spec 16 SG-003). */
export type SpeechWorkerEvent =
	| WorkerEvent
	| { type: 'device'; encoder: string; decoder: string; attempt: number };

export type RotoWorkerEvent =
	| WorkerEvent
	| {
			type: 'frame';
			frame: number;
			area: number;
			done: number;
			total: number;
	  };
