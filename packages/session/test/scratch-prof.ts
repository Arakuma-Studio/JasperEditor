import { createSeededIdSource, previewProposalSteps, revalidate, invariantStats } from '@jasper/project';
import { bigProposal, bigSession } from './big-proposal.ts';
const N = Number(process.env.N ?? 500);
const { session, engine } = bigSession(N);
const p = bigProposal(session, engine, N);
const doc = session.getCommitted();
const ctx = { registries: session.ctx.registries, revision: 1, now: () => 'x', invariants: 'incremental' as const, checkInvariants: process.env.CHECK === '1' };
const idsFor = (it: any) => createSeededIdSource(`${p.id}:${it.id}:0`);
invariantStats(true);
const c0 = process.cpuUsage(); const t0 = performance.now();
const rv = revalidate(doc, p, ctx, { dryRuns: false });
const t1 = performance.now();
const run = previewProposalSteps(doc, rv.proposal, p.items.map((i) => i.id), ctx, { idsFor });
let r; for (;;) { r = run.next(); if (r.done) break; }
const t2 = performance.now(); const c1 = process.cpuUsage(c0);
console.log(JSON.stringify({ items: p.items.length, revalidateMs: Math.round(t1 - t0), previewMs: Math.round(t2 - t1), cpuMs: Math.round((c1.user + c1.system) / 1000), applied: r.value.applied.length, failed: Object.keys(r.value.failed).length, stats: invariantStats() }));
