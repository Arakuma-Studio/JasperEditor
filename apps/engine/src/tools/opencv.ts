import { createRequire } from 'node:module';
import type * as Cv from '@techstark/opencv-js';

export type OpenCvApi = typeof Cv;

export type OpenCv = OpenCvApi & {
	then?: (ready: () => void) => void;
	onRuntimeInitialized?: () => void;
	exceptionFromPtr(pointer: number): { msg: string };
};

let ready: Promise<{ cv: OpenCv }> | undefined;

export function loadOpenCv(): Promise<{ cv: OpenCv }> {
	if (!ready) {
		ready = new Promise((resolve) => {
			const cv = createRequire(import.meta.url)('@techstark/opencv-js') as OpenCv;
			// Emscripten returns a self-resolving thenable; only a wrapper can settle a native promise.
			const done = () => resolve({ cv });
			if (typeof cv.then === 'function') cv.then(done);
			else if (cv.Mat) done();
			else cv.onRuntimeInitialized = done;
		});
	}
	return ready;
}
