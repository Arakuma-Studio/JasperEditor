import { type LottieDoc, parseLottie } from '@jasper/project';
import type { LottiePlayer } from 'lottie-web';

let player: Promise<LottiePlayer> | null = null;

// lottie-web touches the DOM at import time, so engine-side imports must stay lazy.
export function lottiePlayer(): Promise<LottiePlayer> {
	player ??= import('lottie-web/build/player/lottie_svg').then((module) => module.default);
	return player;
}

const documents = new Map<string, Promise<LottieDoc>>();

/** Cached source data; callers must clone it because lottie-web mutates animationData. */
export function lottieDocument(url: string): Promise<LottieDoc> {
	let pending = documents.get(url);
	if (!pending) {
		pending = fetch(url).then(async (response) => {
			if (!response.ok) throw new Error(`Lottie document ${url}: HTTP ${response.status}`);
			return parseLottie(await response.text());
		});
		documents.set(url, pending);
		pending.catch(() => documents.delete(url));
		if (documents.size > 64) documents.delete(documents.keys().next().value!);
	}
	return pending;
}
