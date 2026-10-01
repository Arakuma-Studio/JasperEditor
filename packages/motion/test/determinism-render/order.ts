// Frame orders of the render-parity compositions (S11:ANM-014): the "reversed" and "shuffled" compositions show,
// at output frame i, the scene frame order[i] (through <Freeze>), so one renderer page visits the scene frames in
// that order. Shared by the Remotion entry (browser) and the test (node).
import { hash32, seededRandom } from '../../src/runtime/random.ts';

export function reversedOrder(n: number): number[] {
	return Array.from({ length: n }, (_, i) => n - 1 - i);
}

/** A fixed permutation of 0…n-1 (seeded Fisher–Yates). */
export function shuffledOrder(n: number): number[] {
	const order = Array.from({ length: n }, (_, i) => i);
	const rand = seededRandom(hash32('anm-014', 'shuffle', n));
	for (let i = n - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[order[i], order[j]] = [order[j]!, order[i]!];
	}
	return order;
}
