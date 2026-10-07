// Polygon triangulation with holes: ear clipping on a doubly linked vertex ring, holes bridged into the outer ring,
// self-intersection cures and splits as a fallback. Port of mapbox/earcut 2.2 (ISC, Copyright (c) 2016, Mapbox;
// licenses/ported/three-d.md), without the z-order hashing (the outlines here have at most a few thousand points).

type Node = {
	i: number;
	x: number;
	y: number;
	prev: Node;
	next: Node;
	steiner: boolean;
};

/**
 * Triangulates a polygon: `data` = flat [x, y, …] of the outer ring followed by the holes, `holes` = start vertex
 * index of each hole. Returns vertex indices, three per triangle.
 */
export function earcut(data: ArrayLike<number>, holes: readonly number[] = []): number[] {
	const hasHoles = holes.length > 0;
	const outerLen = hasHoles ? holes[0]! * 2 : data.length;
	let outer = linkedList(data, 0, outerLen, true);
	const triangles: number[] = [];
	if (!outer || outer.next === outer.prev) return triangles;
	if (hasHoles) outer = eliminateHoles(data, holes, outer);
	earcutLinked(outer, triangles, 0);
	return triangles;
}

function linkedList(data: ArrayLike<number>, start: number, end: number, clockwise: boolean): Node | null {
	let last: Node | null = null;
	if (clockwise === signedArea(data, start, end) > 0) {
		for (let i = start; i < end; i += 2) last = insertNode(i / 2, data[i]!, data[i + 1]!, last);
	} else {
		for (let i = end - 2; i >= start; i -= 2) last = insertNode(i / 2, data[i]!, data[i + 1]!, last);
	}
	if (last && equals(last, last.next)) {
		removeNode(last);
		last = last.next;
	}
	return last;
}

function filterPoints(start: Node, end?: Node): Node {
	let e = end ?? start;
	let p = start;
	let again: boolean;
	do {
		again = false;
		if (!p.steiner && (equals(p, p.next) || area(p.prev, p, p.next) === 0)) {
			removeNode(p);
			p = e = p.prev;
			if (p === p.next) break;
			again = true;
		} else p = p.next;
	} while (again || p !== e);
	return e;
}

function earcutLinked(earIn: Node | null, triangles: number[], pass: number): void {
	let ear = earIn;
	if (!ear) return;
	let stop = ear;
	while (ear.prev !== ear.next) {
		const prev: Node = ear.prev;
		const next: Node = ear.next;
		if (isEar(ear)) {
			triangles.push(prev.i, ear.i, next.i);
			removeNode(ear);
			ear = next.next;
			stop = next.next;
			continue;
		}
		ear = next;
		if (ear === stop) {
			if (!pass) earcutLinked(filterPoints(ear), triangles, 1);
			else if (pass === 1) {
				ear = cureLocalIntersections(filterPoints(ear), triangles);
				earcutLinked(ear, triangles, 2);
			} else if (pass === 2) splitEarcut(ear, triangles);
			break;
		}
	}
}

function isEar(ear: Node): boolean {
	const a = ear.prev;
	const b = ear;
	const c = ear.next;
	if (area(a, b, c) >= 0) return false;
	let p = ear.next.next;
	while (p !== ear.prev) {
		if (
			pointInTriangle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y) &&
			area(p.prev, p, p.next) >= 0
		)
			return false;
		p = p.next;
	}
	return true;
}

function cureLocalIntersections(startIn: Node, triangles: number[]): Node {
	let start = startIn;
	let p = start;
	do {
		const a = p.prev;
		const b = p.next.next;
		if (!equals(a, b) && intersects(a, p, p.next, b) && locallyInside(a, b) && locallyInside(b, a)) {
			triangles.push(a.i, p.i, b.i);
			removeNode(p);
			removeNode(p.next);
			p = start = b;
		}
		p = p.next;
	} while (p !== start);
	return filterPoints(p);
}

function splitEarcut(start: Node, triangles: number[]): void {
	let a = start;
	do {
		let b = a.next.next;
		while (b !== a.prev) {
			if (a.i !== b.i && isValidDiagonal(a, b)) {
				let c = splitPolygon(a, b);
				a = filterPoints(a, a.next);
				c = filterPoints(c, c.next);
				earcutLinked(a, triangles, 0);
				earcutLinked(c, triangles, 0);
				return;
			}
			b = b.next;
		}
		a = a.next;
	} while (a !== start);
}

function eliminateHoles(data: ArrayLike<number>, holes: readonly number[], outerIn: Node): Node {
	let outer = outerIn;
	const queue: Node[] = [];
	for (let i = 0; i < holes.length; i++) {
		const start = holes[i]! * 2;
		const end = i < holes.length - 1 ? holes[i + 1]! * 2 : data.length;
		const list = linkedList(data, start, end, false);
		if (!list) continue;
		if (list === list.next) list.steiner = true;
		queue.push(getLeftmost(list));
	}
	queue.sort((a, b) => a.x - b.x);
	for (const h of queue) outer = eliminateHole(h, outer);
	return outer;
}

function eliminateHole(hole: Node, outerNode: Node): Node {
	const bridge = findHoleBridge(hole, outerNode);
	if (!bridge) return outerNode;
	const bridgeReverse = splitPolygon(bridge, hole);
	filterPoints(bridgeReverse, bridgeReverse.next);
	return filterPoints(bridge, bridge.next);
}

function findHoleBridge(hole: Node, outerNode: Node): Node | null {
	let p = outerNode;
	const hx = hole.x;
	const hy = hole.y;
	let qx = Number.NEGATIVE_INFINITY;
	let m: Node | null = null;
	do {
		if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
			const x = p.x + ((hy - p.y) * (p.next.x - p.x)) / (p.next.y - p.y);
			if (x <= hx && x > qx) {
				qx = x;
				m = p.x < p.next.x ? p : p.next;
				if (x === hx) return m;
			}
		}
		p = p.next;
	} while (p !== outerNode);
	if (!m) return null;
	const stop = m;
	const mx = m.x;
	const my = m.y;
	let tanMin = Number.POSITIVE_INFINITY;
	p = m;
	do {
		if (
			hx >= p.x &&
			p.x >= mx &&
			hx !== p.x &&
			pointInTriangle(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)
		) {
			const tan = Math.abs(hy - p.y) / (hx - p.x);
			if (
				locallyInside(p, hole) &&
				(tan < tanMin || (tan === tanMin && (p.x > m!.x || (p.x === m!.x && sectorContainsSector(m!, p)))))
			) {
				m = p;
				tanMin = tan;
			}
		}
		p = p.next;
	} while (p !== stop);
	return m;
}

function sectorContainsSector(m: Node, p: Node): boolean {
	return area(m.prev, m, p.prev) < 0 && area(p.next, m, m.next) < 0;
}

function getLeftmost(start: Node): Node {
	let p = start;
	let leftmost = start;
	do {
		if (p.x < leftmost.x || (p.x === leftmost.x && p.y < leftmost.y)) leftmost = p;
		p = p.next;
	} while (p !== start);
	return leftmost;
}

function pointInTriangle(
	ax: number,
	ay: number,
	bx: number,
	by: number,
	cx: number,
	cy: number,
	px: number,
	py: number,
): boolean {
	return (
		(cx - px) * (ay - py) >= (ax - px) * (cy - py) &&
		(ax - px) * (by - py) >= (bx - px) * (ay - py) &&
		(bx - px) * (cy - py) >= (cx - px) * (by - py)
	);
}

function isValidDiagonal(a: Node, b: Node): boolean {
	return (
		a.next.i !== b.i &&
		a.prev.i !== b.i &&
		!intersectsPolygon(a, b) &&
		((locallyInside(a, b) &&
			locallyInside(b, a) &&
			middleInside(a, b) &&
			(area(a.prev, a, b.prev) !== 0 || area(a, b.prev, b) !== 0)) ||
			(equals(a, b) && area(a.prev, a, a.next) > 0 && area(b.prev, b, b.next) > 0))
	);
}

function area(p: Node, q: Node, r: Node): number {
	return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
}

function equals(p1: Node, p2: Node): boolean {
	return p1.x === p2.x && p1.y === p2.y;
}

function intersects(p1: Node, q1: Node, p2: Node, q2: Node): boolean {
	const o1 = sign(area(p1, q1, p2));
	const o2 = sign(area(p1, q1, q2));
	const o3 = sign(area(p2, q2, p1));
	const o4 = sign(area(p2, q2, q1));
	if (o1 !== o2 && o3 !== o4) return true;
	if (o1 === 0 && onSegment(p1, p2, q1)) return true;
	if (o2 === 0 && onSegment(p1, q2, q1)) return true;
	if (o3 === 0 && onSegment(p2, p1, q2)) return true;
	if (o4 === 0 && onSegment(p2, q1, q2)) return true;
	return false;
}

function onSegment(p: Node, q: Node, r: Node): boolean {
	return (
		q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y)
	);
}

const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);

function intersectsPolygon(a: Node, b: Node): boolean {
	let p = a;
	do {
		if (p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i && intersects(p, p.next, a, b)) return true;
		p = p.next;
	} while (p !== a);
	return false;
}

function locallyInside(a: Node, b: Node): boolean {
	return area(a.prev, a, a.next) < 0
		? area(a, b, a.next) >= 0 && area(a, a.prev, b) >= 0
		: area(a, b, a.prev) < 0 || area(a, a.next, b) < 0;
}

function middleInside(a: Node, b: Node): boolean {
	let p = a;
	let inside = false;
	const px = (a.x + b.x) / 2;
	const py = (a.y + b.y) / 2;
	do {
		if (p.y > py !== p.next.y > py && p.next.y !== p.y && px < ((p.next.x - p.x) * (py - p.y)) / (p.next.y - p.y) + p.x)
			inside = !inside;
		p = p.next;
	} while (p !== a);
	return inside;
}

function splitPolygon(a: Node, b: Node): Node {
	const a2 = makeNode(a.i, a.x, a.y);
	const b2 = makeNode(b.i, b.x, b.y);
	const an = a.next;
	const bp = b.prev;
	a.next = b;
	b.prev = a;
	a2.next = an;
	an.prev = a2;
	b2.next = a2;
	a2.prev = b2;
	bp.next = b2;
	b2.prev = bp;
	return b2;
}

function insertNode(i: number, x: number, y: number, last: Node | null): Node {
	const p = makeNode(i, x, y);
	if (!last) {
		p.prev = p;
		p.next = p;
	} else {
		p.next = last.next;
		p.prev = last;
		last.next.prev = p;
		last.next = p;
	}
	return p;
}

function removeNode(p: Node): void {
	p.next.prev = p.prev;
	p.prev.next = p.next;
}

function makeNode(i: number, x: number, y: number): Node {
	const n = { i, x, y, steiner: false } as Node;
	n.prev = n;
	n.next = n;
	return n;
}

function signedArea(data: ArrayLike<number>, start: number, end: number): number {
	let sum = 0;
	for (let i = start, j = end - 2; i < end; i += 2) {
		sum += (data[j]! - data[i]!) * (data[i + 1]! + data[j + 1]!);
		j = i;
	}
	return sum;
}
