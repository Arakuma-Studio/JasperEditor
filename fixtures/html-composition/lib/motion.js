// SPDX-License-Identifier: LicenseRef-JasperEditor — HTML composition test fixture.
// The box's left edge is at round(t / __duration × (innerWidth − 80)) px, vertically centred: a pure function of t.
const color = new URLSearchParams(location.search).get('color');
const box = document.getElementById('box');
if (color) box.style.background = color;
window.__duration = 2;
window.__seek = (t) => {
	const p = Math.min(1, Math.max(0, t / window.__duration));
	const x = Math.round(p * (innerWidth - 80));
	const y = Math.round(innerHeight / 2 - 40);
	box.style.transform = `translate(${x}px, ${y}px)`;
};
window.__ready = document.fonts.ready.then(() => window.__seek(0));
