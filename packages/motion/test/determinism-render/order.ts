// Shared frame orders keep the browser composition and Node reference on the same permutation.
import { hash32, seededRandom } from '../../src/runtime/random.ts';

export function reversedOrder(n: number): number[] {
	return Array.from({ length: n }, (_, i) => n - 1 - i);
}

export function shuffledOrder(n: number): number[] {
	const order = Array.from({ length: n }, (_, i) => i);
	const rand = seededRandom(hash32('anm-014', 'shuffle', n));
	for (let i = n - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[order[i], order[j]] = [order[j]!, order[i]!];
	}
	return order;
}
