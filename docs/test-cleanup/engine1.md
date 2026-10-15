# Engine test cleanup audit and disposition

Status: cleanup implemented; pre-edit dispositions are recorded below. The focused retry suite passes; other focused execution and package typecheck are pending root-scheduled integrated validation. Scope: the 36 files assigned to engine1. Case names below come from the original TypeScript AST; parameterized families share one entry only when they assert the same contract.

Every retained case is evaluated against all six requested bars below: **B1** independent requirement, **B2** recognizable failure, **B3** independent oracle, **B4** stable seam, **B5** refactor tolerance, **B6** lowest owner/remaining coverage. “No stronger owner” means the named scenario is not asserted elsewhere at a lower stable seam after the listed duplicate removals; rendered-artifact checks own cross-component integration, while pure numerical/validation cases own separate input contracts.

The source owner and its non-test callers were inspected before disposition. Production seam changes approved by root: remove export from `WINDOWS_OPEN_COMMAND`, `medianFilter`, `dtw`, `withSinglePageRetry`, `focalOf`, `saliency`, `buildWarpAnalysis`; all have only same-module production callers. No production behavior change is intended. No fixtures, committed goldens or shared render helper is removed while another consumer remains.

## apps/engine/test/agent.test.ts

Owner/caller evidence: routes/agent.ts, agent/index.ts and MCP clients. Independent sources: README.md HTTP/MCP protocol; docs/ARCHITECTURE.md session leases; AGENTS.md revision and approval rules.

Validation planned: `pnpm exec vitest run apps/engine/test/agent.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### KEEP: describes commands, queries, addressing, approvals and error codes

- **B1:** README.md HTTP/MCP protocol; docs/ARCHITECTURE.md session leases; AGENTS.md revision and approval rules independently specifies this case: “describes commands, queries, addressing, approvals and error codes”.
- **B2:** A caller-visible violation of “describes commands, queries, addressing, approvals and error codes” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: literal response/status/event/error contracts and independently arranged leases/revisions. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP and authenticated WebSocket API. Non-test consumers: routes/agent.ts, agent/index.ts and MCP clients.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “describes commands, queries, addressing, approvals and error codes” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: publishes editor.openProject globally and reports listening editors; 404 for unknown projects

- **B1:** README.md HTTP/MCP protocol; docs/ARCHITECTURE.md session leases; AGENTS.md revision and approval rules independently specifies this case: “publishes editor.openProject globally and reports listening editors; 404 for unknown projects”.
- **B2:** A caller-visible violation of “publishes editor.openProject globally and reports listening editors; 404 for unknown projects” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: literal response/status/event/error contracts and independently arranged leases/revisions. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP and authenticated WebSocket API. Non-test consumers: routes/agent.ts, agent/index.ts and MCP clients.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “publishes editor.openProject globally and reports listening editors; 404 for unknown projects” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: reports the HTTP endpoint and the stdio bundle path, never the token

- **B1:** README.md HTTP/MCP protocol; docs/ARCHITECTURE.md session leases; AGENTS.md revision and approval rules independently specifies this case: “reports the HTTP endpoint and the stdio bundle path, never the token”.
- **B2:** A caller-visible violation of “reports the HTTP endpoint and the stdio bundle path, never the token” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: literal response/status/event/error contracts and independently arranged leases/revisions. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP and authenticated WebSocket API. Non-test consumers: routes/agent.ts, agent/index.ts and MCP clients.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “reports the HTTP endpoint and the stdio bundle path, never the token” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: finds the bundle in a checkout and in packaged resources; JASPER_MCP_ENTRY overrides

- **B1:** README.md HTTP/MCP protocol; docs/ARCHITECTURE.md session leases; AGENTS.md revision and approval rules independently specifies this case: “finds the bundle in a checkout and in packaged resources; JASPER_MCP_ENTRY overrides”.
- **B2:** A caller-visible violation of “finds the bundle in a checkout and in packaged resources; JASPER_MCP_ENTRY overrides” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: literal response/status/event/error contracts and independently arranged leases/revisions. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP and authenticated WebSocket API. Non-test consumers: routes/agent.ts, agent/index.ts and MCP clients.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “finds the bundle in a checkout and in packaged resources; JASPER_MCP_ENTRY overrides” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: applies, saves a new revision and publishes doc.changed

- **B1:** README.md HTTP/MCP protocol; docs/ARCHITECTURE.md session leases; AGENTS.md revision and approval rules independently specifies this case: “applies, saves a new revision and publishes doc.changed”.
- **B2:** A caller-visible violation of “applies, saves a new revision and publishes doc.changed” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: literal response/status/event/error contracts and independently arranged leases/revisions. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP and authenticated WebSocket API. Non-test consumers: routes/agent.ts, agent/index.ts and MCP clients.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “applies, saves a new revision and publishes doc.changed” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: rejects destructive transactions with E_APPROVAL_DENIED and unknown projects with 404

- **B1:** README.md HTTP/MCP protocol; docs/ARCHITECTURE.md session leases; AGENTS.md revision and approval rules independently specifies this case: “rejects destructive transactions with E_APPROVAL_DENIED and unknown projects with 404”.
- **B2:** A caller-visible violation of “rejects destructive transactions with E_APPROVAL_DENIED and unknown projects with 404” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: literal response/status/event/error contracts and independently arranged leases/revisions. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP and authenticated WebSocket API. Non-test consumers: routes/agent.ts, agent/index.ts and MCP clients.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “rejects destructive transactions with E_APPROVAL_DENIED and unknown projects with 404” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: rejects a stale expectedRevision touching a changed entity and fast-forwards otherwise (S01 AC-11)

- **B1:** README.md HTTP/MCP protocol; docs/ARCHITECTURE.md session leases; AGENTS.md revision and approval rules independently specifies this case: “rejects a stale expectedRevision touching a changed entity and fast-forwards otherwise (S01 AC-11)”.
- **B2:** A caller-visible violation of “rejects a stale expectedRevision touching a changed entity and fast-forwards otherwise (S01 AC-11)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: literal response/status/event/error contracts and independently arranged leases/revisions. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP and authenticated WebSocket API. Non-test consumers: routes/agent.ts, agent/index.ts and MCP clients.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “rejects a stale expectedRevision touching a changed entity and fast-forwards otherwise (S01 AC-11)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: relays transactions and queries to the session that holds the lease and forwards its events

- **B1:** README.md HTTP/MCP protocol; docs/ARCHITECTURE.md session leases; AGENTS.md revision and approval rules independently specifies this case: “relays transactions and queries to the session that holds the lease and forwards its events”.
- **B2:** A caller-visible violation of “relays transactions and queries to the session that holds the lease and forwards its events” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: literal response/status/event/error contracts and independently arranged leases/revisions. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP and authenticated WebSocket API. Non-test consumers: routes/agent.ts, agent/index.ts and MCP clients.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “relays transactions and queries to the session that holds the lease and forwards its events” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: asks the session for approval; approve relays with approved:true, deny returns E_APPROVAL_DENIED

- **B1:** README.md HTTP/MCP protocol; docs/ARCHITECTURE.md session leases; AGENTS.md revision and approval rules independently specifies this case: “asks the session for approval; approve relays with approved:true, deny returns E_APPROVAL_DENIED”.
- **B2:** A caller-visible violation of “asks the session for approval; approve relays with approved:true, deny returns E_APPROVAL_DENIED” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: literal response/status/event/error contracts and independently arranged leases/revisions. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP and authenticated WebSocket API. Non-test consumers: routes/agent.ts, agent/index.ts and MCP clients.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “asks the session for approval; approve relays with approved:true, deny returns E_APPROVAL_DENIED” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: falls back to headless when the session disconnects before a request

- **B1:** README.md HTTP/MCP protocol; docs/ARCHITECTURE.md session leases; AGENTS.md revision and approval rules independently specifies this case: “falls back to headless when the session disconnects before a request”.
- **B2:** A caller-visible violation of “falls back to headless when the session disconnects before a request” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: literal response/status/event/error contracts and independently arranged leases/revisions. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP and authenticated WebSocket API. Non-test consumers: routes/agent.ts, agent/index.ts and MCP clients.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “falls back to headless when the session disconnects before a request” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: returns E_APPROVAL_TIMEOUT when nobody answers the approval

- **B1:** README.md HTTP/MCP protocol; docs/ARCHITECTURE.md session leases; AGENTS.md revision and approval rules independently specifies this case: “returns E_APPROVAL_TIMEOUT when nobody answers the approval”.
- **B2:** A caller-visible violation of “returns E_APPROVAL_TIMEOUT when nobody answers the approval” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: literal response/status/event/error contracts and independently arranged leases/revisions. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP and authenticated WebSocket API. Non-test consumers: routes/agent.ts, agent/index.ts and MCP clients.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “returns E_APPROVAL_TIMEOUT when nobody answers the approval” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: ignores approval answers from connections that never said hello

- **B1:** README.md HTTP/MCP protocol; docs/ARCHITECTURE.md session leases; AGENTS.md revision and approval rules independently specifies this case: “ignores approval answers from connections that never said hello”.
- **B2:** A caller-visible violation of “ignores approval answers from connections that never said hello” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: literal response/status/event/error contracts and independently arranged leases/revisions. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP and authenticated WebSocket API. Non-test consumers: routes/agent.ts, agent/index.ts and MCP clients.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “ignores approval answers from connections that never said hello” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: returns E_NO_SESSION on a relay timeout while the lease is live, headless once it expired

- **B1:** README.md HTTP/MCP protocol; docs/ARCHITECTURE.md session leases; AGENTS.md revision and approval rules independently specifies this case: “returns E_NO_SESSION on a relay timeout while the lease is live, headless once it expired”.
- **B2:** A caller-visible violation of “returns E_NO_SESSION on a relay timeout while the lease is live, headless once it expired” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: literal response/status/event/error contracts and independently arranged leases/revisions. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP and authenticated WebSocket API. Non-test consumers: routes/agent.ts, agent/index.ts and MCP clients.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “returns E_NO_SESSION on a relay timeout while the lease is live, headless once it expired” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: rejects oversized transactions (limits)

- **B1:** README.md HTTP/MCP protocol; docs/ARCHITECTURE.md session leases; AGENTS.md revision and approval rules independently specifies this case: “rejects oversized transactions (limits)”.
- **B2:** A caller-visible violation of “rejects oversized transactions (limits)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: literal response/status/event/error contracts and independently arranged leases/revisions. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP and authenticated WebSocket API. Non-test consumers: routes/agent.ts, agent/index.ts and MCP clients.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “rejects oversized transactions (limits)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: 409 without an editor window; relays to the window and answers with which window replied

- **B1:** README.md HTTP/MCP protocol; docs/ARCHITECTURE.md session leases; AGENTS.md revision and approval rules independently specifies this case: “409 without an editor window; relays to the window and answers with which window replied”.
- **B2:** A caller-visible violation of “409 without an editor window; relays to the window and answers with which window replied” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: literal response/status/event/error contracts and independently arranged leases/revisions. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP and authenticated WebSocket API. Non-test consumers: routes/agent.ts, agent/index.ts and MCP clients.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “409 without an editor window; relays to the window and answers with which window replied” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.


## apps/engine/test/anime.test.ts

Owner/caller evidence: routes/system.ts and RemotionService bundleId/buildServeUrl. Independent sources: MIT redistribution terms; docs/wp-notes/wp-m2-layer-bake.md FIX-009 cache invalidation.

Validation planned: `pnpm exec vitest run apps/engine/test/anime.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### DELETE: the pinned version matches packages/motion and the installed package

Detectable failure before removal: the expectation named “the pinned version matches packages/motion and the installed package”. Disposition: Declaration/version inventory compares package metadata to itself; HTTP licence/fallback and actual source invalidation cases protect observable behavior. Non-test seam consumers: routes/system.ts and RemotionService bundleId/buildServeUrl; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.

### KEEP: lists anime.js (MIT, with its text) in /api/licenses and fills features.anime

- **B1:** MIT redistribution terms; docs/wp-notes/wp-m2-layer-bake.md FIX-009 cache invalidation independently specifies this case: “lists anime.js (MIT, with its text) in /api/licenses and fills features.anime”.
- **B2:** A caller-visible violation of “lists anime.js (MIT, with its text) in /api/licenses and fills features.anime” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: licence copyright text and externally changed package/workspace bytes. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP licences/capabilities, packaged licence resolver, public Remotion sourceHash. Non-test consumers: routes/system.ts and RemotionService bundleId/buildServeUrl.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “lists anime.js (MIT, with its text) in /api/licenses and fills features.anime” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: packaged-like: without the installed package, the committed licence text and the pinned version

- **B1:** MIT redistribution terms; docs/wp-notes/wp-m2-layer-bake.md FIX-009 cache invalidation independently specifies this case: “packaged-like: without the installed package, the committed licence text and the pinned version”.
- **B2:** A caller-visible violation of “packaged-like: without the installed package, the committed licence text and the pinned version” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: licence copyright text and externally changed package/workspace bytes. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP licences/capabilities, packaged licence resolver, public Remotion sourceHash. Non-test consumers: routes/system.ts and RemotionService bundleId/buildServeUrl.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “packaged-like: without the installed package, the committed licence text and the pinned version” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: changes with the lockfile and with the sources of every bundled workspace package

- **B1:** MIT redistribution terms; docs/wp-notes/wp-m2-layer-bake.md FIX-009 cache invalidation independently specifies this case: “changes with the lockfile and with the sources of every bundled workspace package”.
- **B2:** A caller-visible violation of “changes with the lockfile and with the sources of every bundled workspace package” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: licence copyright text and externally changed package/workspace bytes. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP licences/capabilities, packaged licence resolver, public Remotion sourceHash. Non-test consumers: routes/system.ts and RemotionService bundleId/buildServeUrl.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “changes with the lockfile and with the sources of every bundled workspace package” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.


## apps/engine/test/audio-fx.test.ts

Owner/caller evidence: audio/service.ts, export/service.ts and HTTP audio routes. Independent sources: docs/wp-notes/audio-fx.md and docs/wp-notes/audio-mix.md DSP/export fidelity.

Validation planned: `pnpm exec vitest run apps/engine/test/audio-fx.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### KEEP: exports clip effects natively with exact DSP gains (Amplify, Invert, Channel Volume)

- **B1:** docs/wp-notes/audio-fx.md and docs/wp-notes/audio-mix.md DSP/export fidelity independently specifies this case: “exports clip effects natively with exact DSP gains (Amplify, Invert, Channel Volume)”.
- **B2:** A caller-visible violation of “exports clip effects natively with exact DSP gains (Amplify, Invert, Channel Volume)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: prescribed dB gains, sign/peak bounds, target duration and independent FFmpeg EBU R128 measurement. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP audio jobs and decoded exported audio. Non-test consumers: audio/service.ts, export/service.ts and HTTP audio routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “exports clip effects natively with exact DSP gains (Amplify, Invert, Channel Volume)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: a hard limiter caps the exported peak; a reversed clip with pan and a reverb exports natively

- **B1:** docs/wp-notes/audio-fx.md and docs/wp-notes/audio-mix.md DSP/export fidelity independently specifies this case: “a hard limiter caps the exported peak; a reversed clip with pan and a reverb exports natively”.
- **B2:** A caller-visible violation of “a hard limiter caps the exported peak; a reversed clip with pan and a reverb exports natively” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: prescribed dB gains, sign/peak bounds, target duration and independent FFmpeg EBU R128 measurement. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP audio jobs and decoded exported audio. Non-test consumers: audio/service.ts, export/service.ts and HTTP audio routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “a hard limiter caps the exported peak; a reversed clip with pan and a reverb exports natively” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### DELETE: the Remotion path carries the same mixer audio (effects too)

Detectable failure before removal: the expectation named “the Remotion path carries the same mixer audio (effects too)”. Disposition: Only plans a Remotion render and never measures the claimed audio; actual DSP output and separate audio parity suites own this contract. Non-test seam consumers: audio/service.ts, export/service.ts and HTTP audio routes; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.

### KEEP: plans a 48 s generated song to 30 s and commits it; the export is 30 s long

- **B1:** docs/wp-notes/audio-fx.md and docs/wp-notes/audio-mix.md DSP/export fidelity independently specifies this case: “plans a 48 s generated song to 30 s and commits it; the export is 30 s long”.
- **B2:** A caller-visible violation of “plans a 48 s generated song to 30 s and commits it; the export is 30 s long” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: prescribed dB gains, sign/peak bounds, target duration and independent FFmpeg EBU R128 measurement. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP audio jobs and decoded exported audio. Non-test consumers: audio/service.ts, export/service.ts and HTTP audio routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “plans a 48 s generated song to 30 s and commits it; the export is 30 s long” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### REWRITE: measures the clip (source levels, with its effects) and matches −23 LUFS in the export

Change: Measure exported file with independent FFmpeg ebur128 instead of the production loudness function.

- **B1:** docs/wp-notes/audio-fx.md and docs/wp-notes/audio-mix.md DSP/export fidelity independently specifies this case: “measures the clip (source levels, with its effects) and matches −23 LUFS in the export”.
- **B2:** A caller-visible violation of “measures the clip (source levels, with its effects) and matches −23 LUFS in the export” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: prescribed dB gains, sign/peak bounds, target duration and independent FFmpeg EBU R128 measurement. Measure exported file with independent FFmpeg ebur128 instead of the production loudness function.
- **B4:** Observes HTTP audio jobs and decoded exported audio. Non-test consumers: audio/service.ts, export/service.ts and HTTP audio routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “measures the clip (source levels, with its effects) and matches −23 LUFS in the export” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.


## apps/engine/test/audio-publish.test.ts

Owner/caller evidence: audio/service.ts: publishNormalizedAudio. Independent sources: AGENTS.md atomic writes and no data loss; cross-filesystem publish protocol.

Validation planned: `pnpm exec vitest run apps/engine/test/audio-publish.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### KEEP: preserves existing audio if a cross-device copy runs out of disk space

- **B1:** AGENTS.md atomic writes and no data loss; cross-filesystem publish protocol independently specifies this case: “preserves existing audio if a cross-device copy runs out of disk space”.
- **B2:** A caller-visible violation of “preserves existing audio if a cross-device copy runs out of disk space” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: existing and replacement file bytes plus simulated OS error codes; mocks only raise transport errors. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes publishNormalizedAudio filesystem operation. Non-test consumers: audio/service.ts: publishNormalizedAudio.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “preserves existing audio if a cross-device copy runs out of disk space” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### REWRITE: reports a rename permission failure without attempting a copy

Change recorded before edit: Keep EACCES propagation and unchanged destination/source bytes; drop the private copyFile call-count assertion.

- **B1:** AGENTS.md atomic writes and no data loss; cross-filesystem publish protocol independently specifies this case: “reports a rename permission failure without attempting a copy”.
- **B2:** A caller-visible violation of “reports a rename permission failure without attempting a copy” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: existing and replacement file bytes plus simulated OS error codes; mocks only raise transport errors. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes publishNormalizedAudio filesystem operation. Non-test consumers: audio/service.ts: publishNormalizedAudio.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “reports a rename permission failure without attempting a copy” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: publishes the complete audio across filesystems and removes its scratch file

- **B1:** AGENTS.md atomic writes and no data loss; cross-filesystem publish protocol independently specifies this case: “publishes the complete audio across filesystems and removes its scratch file”.
- **B2:** A caller-visible violation of “publishes the complete audio across filesystems and removes its scratch file” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: existing and replacement file bytes plus simulated OS error codes; mocks only raise transport errors. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes publishNormalizedAudio filesystem operation. Non-test consumers: audio/service.ts: publishNormalizedAudio.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “publishes the complete audio across filesystems and removes its scratch file” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.


## apps/engine/test/blend-remotion.e2e.test.ts

Owner/caller evidence: export/service.ts. Independent sources: docs/wp-notes/keyframes-blend.md blend specification.

Validation planned: `pnpm exec vitest run packages/compositions/test/blend-gl.test.ts apps/engine/test/blend-static-layer.e2e.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### DELETE: %s at 60 % opacity = blendPixel (as the native export)

Detectable failure before removal: the expectation named “%s at 60 % opacity = blendPixel (as the native export)”. Disposition: Duplicate whole blend-mode matrix above composition blend-gl, compositor.e2e and golden scenes; expected blendPixel is shared production code. Keep unique engine static multi-frame timeout and export-routing parity regressions. Non-test seam consumers: export/service.ts; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.


## apps/engine/test/blend-static-layer.e2e.test.ts

Owner/caller evidence: export/service.ts and shared composition compositor. Independent sources: docs/wp-notes/compositor.md static-layer delayRender starvation regression.

Validation planned: `pnpm exec vitest run apps/engine/test/blend-static-layer.e2e.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### REWRITE: a shape in Color Dodge renders every frame (no delayRender timeout) with the blended colour

Change: Use literal RGB expectations from the Color Dodge equation rather than production blendPixel.

- **B1:** docs/wp-notes/compositor.md static-layer delayRender starvation regression independently specifies this case: “a shape in Color Dodge renders every frame (no delayRender timeout) with the blended colour”.
- **B2:** A caller-visible violation of “a shape in Color Dodge renders every frame (no delayRender timeout) with the blended colour” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: fixed Color Dodge arithmetic and unblended background RGB across 36 decoded frames. Use literal RGB expectations from the Color Dodge equation rather than production blendPixel.
- **B4:** Observes real multi-frame Remotion export. Non-test consumers: export/service.ts and shared composition compositor.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “a shape in Color Dodge renders every frame (no delayRender timeout) with the blended colour” at the above seam. Other compositor suites own isolated blend modes; this case owns complete engine-produced artifacts.
Risk: medium; external rendering/tooling must be available to validate the artifact. Validation: the focused command above, then engine typecheck and root repository gates.


## apps/engine/test/cache-location.test.ts

Owner/caller evidence: cache/location.ts and startup recovery. Independent sources: docs/wp-notes/wp-m3-cachegc.md disk relocation and recovery; AGENTS.md persistence rules.

Validation planned: `pnpm exec vitest run apps/engine/test/cache-location.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### KEEP: validates folders: absolute, writable, outside the data and cache folders, empty, free space

- **B1:** docs/wp-notes/wp-m3-cachegc.md disk relocation and recovery; AGENTS.md persistence rules independently specifies this case: “validates folders: absolute, writable, outside the data and cache folders, empty, free space”.
- **B2:** A caller-visible violation of “validates folders: absolute, writable, outside the data and cache folders, empty, free space” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: arranged files and journal states, persisted preferences, byte preservation and live export. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes cache-location HTTP API and on-disk restart state. Non-test consumers: cache/location.ts and startup recovery.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “validates folders: absolute, writable, outside the data and cache folders, empty, free space” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: moves on the same disk (rename), keeps working through the links, survives a restart, moves back

- **B1:** docs/wp-notes/wp-m3-cachegc.md disk relocation and recovery; AGENTS.md persistence rules independently specifies this case: “moves on the same disk (rename), keeps working through the links, survives a restart, moves back”.
- **B2:** A caller-visible violation of “moves on the same disk (rename), keeps working through the links, survives a restart, moves back” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: arranged files and journal states, persisted preferences, byte preservation and live export. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes cache-location HTTP API and on-disk restart state. Non-test consumers: cache/location.ts and startup recovery.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “moves on the same disk (rename), keeps working through the links, survives a restart, moves back” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: moves to another disk by copying; the old files go

- **B1:** docs/wp-notes/wp-m3-cachegc.md disk relocation and recovery; AGENTS.md persistence rules independently specifies this case: “moves to another disk by copying; the old files go”.
- **B2:** A caller-visible violation of “moves to another disk by copying; the old files go” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: arranged files and journal states, persisted preferences, byte preservation and live export. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes cache-location HTTP API and on-disk restart state. Non-test consumers: cache/location.ts and startup recovery.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “moves to another disk by copying; the old files go” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: a fresh start keeps the old files on request (and removes them otherwise)

- **B1:** docs/wp-notes/wp-m3-cachegc.md disk relocation and recovery; AGENTS.md persistence rules independently specifies this case: “a fresh start keeps the old files on request (and removes them otherwise)”.
- **B2:** A caller-visible violation of “a fresh start keeps the old files on request (and removes them otherwise)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: arranged files and journal states, persisted preferences, byte preservation and live export. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes cache-location HTTP API and on-disk restart state. Non-test consumers: cache/location.ts and startup recovery.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “a fresh start keeps the old files on request (and removes them otherwise)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: the start-up repair completes an interrupted switch and falls back when the location is gone

- **B1:** docs/wp-notes/wp-m3-cachegc.md disk relocation and recovery; AGENTS.md persistence rules independently specifies this case: “the start-up repair completes an interrupted switch and falls back when the location is gone”.
- **B2:** A caller-visible violation of “the start-up repair completes an interrupted switch and falls back when the location is gone” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: arranged files and journal states, persisted preferences, byte preservation and live export. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes cache-location HTTP API and on-disk restart state. Non-test consumers: cache/location.ts and startup recovery.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “the start-up repair completes an interrupted switch and falls back when the location is gone” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.


## apps/engine/test/cache-reference-index.test.ts

Owner/caller evidence: cache/service.ts scan builds the reference index. Independent sources: docs/wp-notes/wp-m3-cachegc.md references prevent unsafe GC.

Validation planned: `pnpm exec vitest run apps/engine/test/cache-reference-index.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### DELETE: matches the scan across cache kinds, shared references, and recorded-only references

Detectable failure before removal: the expectation named “matches the scan across cache kinds, shared references, and recorded-only references”. Disposition: Expected scan recopies production reference branching; cache.test HTTP saved/live/recorded-reference coverage is stronger. Non-test seam consumers: cache/service.ts scan builds the reference index; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.

### REWRITE: does not mix key namespaces or expose mutable index sets

Change recorded before edit: Keep cross-kind reference isolation (wrong namespace pins unrelated cache data); drop mutable returned-set assertions because no production consumer mutates that result.

- **B1:** docs/wp-notes/wp-m3-cachegc.md references prevent unsafe GC independently specifies this case: “does not mix key namespaces or expose mutable index sets”.
- **B2:** A caller-visible violation of “does not mix key namespaces or expose mutable index sets” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: deliberate same-string keys belonging to distinct cache kinds. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes indexProjectCacheRefs namespace lookup. Non-test consumers: cache/service.ts scan builds the reference index.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “does not mix key namespaces or expose mutable index sets” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### DELETE: rebuilding reflects saved or live project changes and removed projects

Detectable failure before removal: the expectation named “rebuilding reflects saved or live project changes and removed projects”. Disposition: Rebuilding a pure function after mutating inputs repeats the copied mapping; real cache saved/live changes own lifecycle. Non-test seam consumers: cache/service.ts scan builds the reference index; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.


## apps/engine/test/camtrack-solve.test.ts

Owner/caller evidence: camtrack worker and solver.ts; geometry/bundle called by solver. Independent sources: docs/wp-notes/three-d.md synthetic-solve accuracy requirements; licenses/ported/three-d.md camera geometry provenance.

Validation planned: `pnpm exec vitest run apps/engine/test/camtrack-solve.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### REWRITE: recovers the relative pose from the essential matrix

Change: remove the shared implementation oracle as detailed in the final independent-oracle rescan below.

- **B1:** docs/wp-notes/three-d.md synthetic-solve accuracy requirements; licenses/ported/three-d.md camera geometry provenance independently specifies this case: “recovers the relative pose from the essential matrix”.
- **B2:** A caller-visible violation of “recovers the relative pose from the essential matrix” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: synthetic known camera/point coordinates, outliers and focal values, numerical residuals independent of solver internals. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes camera solver / numerical geometry operators. Non-test consumers: camtrack worker and solver.ts; geometry/bundle called by solver.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “recovers the relative pose from the essential matrix” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: fits a homography with RANSAC despite outliers

- **B1:** docs/wp-notes/three-d.md synthetic-solve accuracy requirements; licenses/ported/three-d.md camera geometry provenance independently specifies this case: “fits a homography with RANSAC despite outliers”.
- **B2:** A caller-visible violation of “fits a homography with RANSAC despite outliers” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: synthetic known camera/point coordinates, outliers and focal values, numerical residuals independent of solver internals. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes camera solver / numerical geometry operators. Non-test consumers: camtrack worker and solver.ts; geometry/bundle called by solver.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “fits a homography with RANSAC despite outliers” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### REWRITE: bundle adjustment converges from a perturbed start

Change: remove the shared implementation oracle as detailed in the final independent-oracle rescan below.

- **B1:** docs/wp-notes/three-d.md synthetic-solve accuracy requirements; licenses/ported/three-d.md camera geometry provenance independently specifies this case: “bundle adjustment converges from a perturbed start”.
- **B2:** A caller-visible violation of “bundle adjustment converges from a perturbed start” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: synthetic known camera/point coordinates, outliers and focal values, numerical residuals independent of solver internals. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes camera solver / numerical geometry operators. Non-test consumers: camtrack worker and solver.ts; geometry/bundle called by solver.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “bundle adjustment converges from a perturbed start” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### DELETE: undistort inverts distort

Detectable failure before removal: the expectation named “undistort inverts distort”. Disposition: Roundtrip of production distort and undistort can share the same wrong radial convention; synthetic known-distortion solver test independently covers the visible result. Non-test seam consumers: camtrack worker and solver.ts; geometry/bundle called by solver; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.

### REWRITE: Fixed Angle of View: finds the focal length and the path of a dolly

Change: prescribe focal lengths from the independent pinhole FOV equation; generate distorted tracks from the documented radial model rather than production focalOf/distort helpers. B3 oracle can now disagree with both helpers. Non-test focalOf callers are same-module only, so remove its unused export.

- **B1:** docs/wp-notes/three-d.md synthetic-solve accuracy requirements; licenses/ported/three-d.md camera geometry provenance independently specifies this case: “Fixed Angle of View: finds the focal length and the path of a dolly”.
- **B2:** A caller-visible violation of “Fixed Angle of View: finds the focal length and the path of a dolly” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: synthetic known camera/point coordinates, outliers and focal values, numerical residuals independent of solver internals. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes camera solver / numerical geometry operators. Non-test consumers: camtrack worker and solver.ts; geometry/bundle called by solver.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “Fixed Angle of View: finds the focal length and the path of a dolly” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### REWRITE: Specify Angle of View: uses the given focal length

Change: prescribe focal lengths from the independent pinhole FOV equation; generate distorted tracks from the documented radial model rather than production focalOf/distort helpers. B3 oracle can now disagree with both helpers. Non-test focalOf callers are same-module only, so remove its unused export.

- **B1:** docs/wp-notes/three-d.md synthetic-solve accuracy requirements; licenses/ported/three-d.md camera geometry provenance independently specifies this case: “Specify Angle of View: uses the given focal length”.
- **B2:** A caller-visible violation of “Specify Angle of View: uses the given focal length” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: synthetic known camera/point coordinates, outliers and focal values, numerical residuals independent of solver internals. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes camera solver / numerical geometry operators. Non-test consumers: camtrack worker and solver.ts; geometry/bundle called by solver.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “Specify Angle of View: uses the given focal length” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### REWRITE: Variable Zoom: follows a zoom during the move

Change: prescribe focal lengths from the independent pinhole FOV equation; generate distorted tracks from the documented radial model rather than production focalOf/distort helpers. B3 oracle can now disagree with both helpers. Non-test focalOf callers are same-module only, so remove its unused export.

- **B1:** docs/wp-notes/three-d.md synthetic-solve accuracy requirements; licenses/ported/three-d.md camera geometry provenance independently specifies this case: “Variable Zoom: follows a zoom during the move”.
- **B2:** A caller-visible violation of “Variable Zoom: follows a zoom during the move” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: synthetic known camera/point coordinates, outliers and focal values, numerical residuals independent of solver internals. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes camera solver / numerical geometry operators. Non-test consumers: camtrack worker and solver.ts; geometry/bundle called by solver.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “Variable Zoom: follows a zoom during the move” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### REWRITE: Auto Detect: a pan from a tripod is solved as a pure rotation

Change: prescribe focal lengths from the independent pinhole FOV equation; generate distorted tracks from the documented radial model rather than production focalOf/distort helpers. B3 oracle can now disagree with both helpers. Non-test focalOf callers are same-module only, so remove its unused export.

- **B1:** docs/wp-notes/three-d.md synthetic-solve accuracy requirements; licenses/ported/three-d.md camera geometry provenance independently specifies this case: “Auto Detect: a pan from a tripod is solved as a pure rotation”.
- **B2:** A caller-visible violation of “Auto Detect: a pan from a tripod is solved as a pure rotation” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: synthetic known camera/point coordinates, outliers and focal values, numerical residuals independent of solver internals. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes camera solver / numerical geometry operators. Non-test consumers: camtrack worker and solver.ts; geometry/bundle called by solver.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “Auto Detect: a pan from a tripod is solved as a pure rotation” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### REWRITE: Auto Detect: a scene of one plane is solved (Flat)

Change: prescribe focal lengths from the independent pinhole FOV equation; generate distorted tracks from the documented radial model rather than production focalOf/distort helpers. B3 oracle can now disagree with both helpers. Non-test focalOf callers are same-module only, so remove its unused export.

- **B1:** docs/wp-notes/three-d.md synthetic-solve accuracy requirements; licenses/ported/three-d.md camera geometry provenance independently specifies this case: “Auto Detect: a scene of one plane is solved (Flat)”.
- **B2:** A caller-visible violation of “Auto Detect: a scene of one plane is solved (Flat)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: synthetic known camera/point coordinates, outliers and focal values, numerical residuals independent of solver internals. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes camera solver / numerical geometry operators. Non-test consumers: camtrack worker and solver.ts; geometry/bundle called by solver.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “Auto Detect: a scene of one plane is solved (Flat)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### REWRITE: solves radial lens distortion

Change: prescribe focal lengths from the independent pinhole FOV equation; generate distorted tracks from the documented radial model rather than production focalOf/distort helpers. B3 oracle can now disagree with both helpers. Non-test focalOf callers are same-module only, so remove its unused export.

- **B1:** docs/wp-notes/three-d.md synthetic-solve accuracy requirements; licenses/ported/three-d.md camera geometry provenance independently specifies this case: “solves radial lens distortion”.
- **B2:** A caller-visible violation of “solves radial lens distortion” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: synthetic known camera/point coordinates, outliers and focal values, numerical residuals independent of solver internals. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes camera solver / numerical geometry operators. Non-test consumers: camtrack worker and solver.ts; geometry/bundle called by solver.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “solves radial lens distortion” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: can be cancelled

- **B1:** docs/wp-notes/three-d.md synthetic-solve accuracy requirements; licenses/ported/three-d.md camera geometry provenance independently specifies this case: “can be cancelled”.
- **B2:** A caller-visible violation of “can be cancelled” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: synthetic known camera/point coordinates, outliers and focal values, numerical residuals independent of solver internals. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes camera solver / numerical geometry operators. Non-test consumers: camtrack worker and solver.ts; geometry/bundle called by solver.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “can be cancelled” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: refuses clips without features

- **B1:** docs/wp-notes/three-d.md synthetic-solve accuracy requirements; licenses/ported/three-d.md camera geometry provenance independently specifies this case: “refuses clips without features”.
- **B2:** A caller-visible violation of “refuses clips without features” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: synthetic known camera/point coordinates, outliers and focal values, numerical residuals independent of solver internals. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes camera solver / numerical geometry operators. Non-test consumers: camtrack worker and solver.ts; geometry/bundle called by solver.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “refuses clips without features” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.


## apps/engine/test/cancel-partials.test.ts

Owner/caller evidence: export/service.ts and jobs/queue.ts. Independent sources: AGENTS.md preserve existing work; export EX-007 no-overwrite/cancellation contract.

Validation planned: `pnpm exec vitest run apps/engine/test/cancel-partials.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### KEEP: never overwrites: picks "name (2)", "name (3)" and claims the name exclusively

- **B1:** AGENTS.md preserve existing work; export EX-007 no-overwrite/cancellation contract independently specifies this case: “never overwrites: picks "name (2)", "name (3)" and claims the name exclusively”.
- **B2:** A caller-visible violation of “never overwrites: picks "name (2)", "name (3)" and claims the name exclusively” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: pre-existing file bytes, AbortSignal and actual destination existence after cancellation. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes copyNoOverwrite and JobQueue file ownership. Non-test consumers: export/service.ts and jobs/queue.ts.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “never overwrites: picks "name (2)", "name (3)" and claims the name exclusively” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: reports the claimed path before writing and removes it when the copy is aborted

- **B1:** AGENTS.md preserve existing work; export EX-007 no-overwrite/cancellation contract independently specifies this case: “reports the claimed path before writing and removes it when the copy is aborted”.
- **B2:** A caller-visible violation of “reports the claimed path before writing and removes it when the copy is aborted” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: pre-existing file bytes, AbortSignal and actual destination existence after cancellation. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes copyNoOverwrite and JobQueue file ownership. Non-test consumers: export/service.ts and jobs/queue.ts.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “reports the claimed path before writing and removes it when the copy is aborted” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### DELETE: a cancel during the copy to the destination deletes the destination file

Detectable failure before removal: the expectation named “a cancel during the copy to the destination deletes the destination file”. Disposition: Repeats AbortSignal copy cleanup plus a mocked runner reimplementing addPartial wiring; lower copy test and post-copy JobQueue race remain. Non-test seam consumers: export/service.ts and jobs/queue.ts; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.

### KEEP: a cancel after the copy finished (before the job ends) removes the copied file too

- **B1:** AGENTS.md preserve existing work; export EX-007 no-overwrite/cancellation contract independently specifies this case: “a cancel after the copy finished (before the job ends) removes the copied file too”.
- **B2:** A caller-visible violation of “a cancel after the copy finished (before the job ends) removes the copied file too” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: pre-existing file bytes, AbortSignal and actual destination existence after cancellation. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes copyNoOverwrite and JobQueue file ownership. Non-test consumers: export/service.ts and jobs/queue.ts.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “a cancel after the copy finished (before the job ends) removes the copied file too” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### DELETE: a successful job keeps its destination file

Detectable failure before removal: the expectation named “a successful job keeps its destination file”. Disposition: Routine successful copy already exercised by real exports and copyNoOverwrite; does not add a unique queue failure. Non-test seam consumers: export/service.ts and jobs/queue.ts; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.


## apps/engine/test/color-mgmt-remotion.test.ts

Owner/caller evidence: export/service.ts and shared composition compositor. Independent sources: docs/wp-notes/color-mgmt.md PQ/linear compositor contract.

Validation planned: `pnpm exec vitest run packages/compositions/test/compositor.e2e.test.ts packages/compositions/test/compositor-player.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### DELETE: PQ + Blend Using 1.0 Gamma: linear blend, graphics white, DOM text, display still

Detectable failure before removal: the expectation named “PQ + Blend Using 1.0 Gamma: linear blend, graphics white, DOM text, display still”. Disposition: Expected PQ/gamma transform calls production helpers; stronger compositor-player PQ graphics-white and compositor.e2e independent BT1886/ordering oracles remain. Non-test seam consumers: export/service.ts and shared composition compositor; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.

### DELETE: an adjustment layer between linear-light tracks renders (compositor: the flat compositor)

Detectable failure before removal: the expectation named “an adjustment layer between linear-light tracks renders (compositor: the flat compositor)”. Disposition: Duplicate adjustment/linear track scenario already owned by compositor.e2e and compositor-player; no distinct engine-routing assertion. Non-test seam consumers: export/service.ts and shared composition compositor; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.


## apps/engine/test/encoders.test.ts

Owner/caller evidence: tools/encoders.ts used by proxy/export/native/Remotion services. Independent sources: AGENTS.md LGPL rules; FFmpeg codec/container/CLI protocols.

Validation planned: `pnpm exec vitest run apps/engine/test/encoders.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### KEEP: LGPL-only list without usable hardware: exports AV1 (SVT-AV1, MP4), proxies VP9, with a message

- **B1:** AGENTS.md LGPL rules; FFmpeg codec/container/CLI protocols independently specifies this case: “LGPL-only list without usable hardware: exports AV1 (SVT-AV1, MP4), proxies VP9, with a message”.
- **B2:** A caller-visible violation of “LGPL-only list without usable hardware: exports AV1 (SVT-AV1, MP4), proxies VP9, with a message” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: external encoder capability lists, command-line option rules and shim process exit status. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes encoder negotiation and FFmpeg argument generation. Non-test consumers: tools/encoders.ts used by proxy/export/native/Remotion services.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “LGPL-only list without usable hardware: exports AV1 (SVT-AV1, MP4), proxies VP9, with a message” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: VP9 exports go to WebM + Opus when libopus exists, else MP4 + AAC

- **B1:** AGENTS.md LGPL rules; FFmpeg codec/container/CLI protocols independently specifies this case: “VP9 exports go to WebM + Opus when libopus exists, else MP4 + AAC”.
- **B2:** A caller-visible violation of “VP9 exports go to WebM + Opus when libopus exists, else MP4 + AAC” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: external encoder capability lists, command-line option rules and shim process exit status. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes encoder negotiation and FFmpeg argument generation. Non-test consumers: tools/encoders.ts used by proxy/export/native/Remotion services.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “VP9 exports go to WebM + Opus when libopus exists, else MP4 + AAC” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: OpenH264-only: H.264 via libopenh264 with bitrate rate control (no CRF)

- **B1:** AGENTS.md LGPL rules; FFmpeg codec/container/CLI protocols independently specifies this case: “OpenH264-only: H.264 via libopenh264 with bitrate rate control (no CRF)”.
- **B2:** A caller-visible violation of “OpenH264-only: H.264 via libopenh264 with bitrate rate control (no CRF)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: external encoder capability lists, command-line option rules and shim process exit status. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes encoder negotiation and FFmpeg argument generation. Non-test consumers: tools/encoders.ts used by proxy/export/native/Remotion services.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “OpenH264-only: H.264 via libopenh264 with bitrate rate control (no CRF)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: smart-rendering pieces: no B-frames for every H.264 encoder (they are joined as one raw stream)

- **B1:** AGENTS.md LGPL rules; FFmpeg codec/container/CLI protocols independently specifies this case: “smart-rendering pieces: no B-frames for every H.264 encoder (they are joined as one raw stream)”.
- **B2:** A caller-visible violation of “smart-rendering pieces: no B-frames for every H.264 encoder (they are joined as one raw stream)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: external encoder capability lists, command-line option rules and shim process exit status. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes encoder negotiation and FFmpeg argument generation. Non-test consumers: tools/encoders.ts used by proxy/export/native/Remotion services.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “smart-rendering pieces: no B-frames for every H.264 encoder (they are joined as one raw stream)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: hardware-only: the first usable encoder in preference order wins (test encodes decide)

- **B1:** AGENTS.md LGPL rules; FFmpeg codec/container/CLI protocols independently specifies this case: “hardware-only: the first usable encoder in preference order wins (test encodes decide)”.
- **B2:** A caller-visible violation of “hardware-only: the first usable encoder in preference order wins (test encodes decide)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: external encoder capability lists, command-line option rules and shim process exit status. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes encoder negotiation and FFmpeg argument generation. Non-test consumers: tools/encoders.ts used by proxy/export/native/Remotion services.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “hardware-only: the first usable encoder in preference order wins (test encodes decide)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: full GPL build: OpenH264 before libx264; libx264 only as dev convenience; LGPL-only ignores GPL

- **B1:** AGENTS.md LGPL rules; FFmpeg codec/container/CLI protocols independently specifies this case: “full GPL build: OpenH264 before libx264; libx264 only as dev convenience; LGPL-only ignores GPL”.
- **B2:** A caller-visible violation of “full GPL build: OpenH264 before libx264; libx264 only as dev convenience; LGPL-only ignores GPL” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: external encoder capability lists, command-line option rules and shim process exit status. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes encoder negotiation and FFmpeg argument generation. Non-test consumers: tools/encoders.ts used by proxy/export/native/Remotion services.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “full GPL build: OpenH264 before libx264; libx264 only as dev convenience; LGPL-only ignores GPL” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: honours an explicit encoder only when it is usable

- **B1:** AGENTS.md LGPL rules; FFmpeg codec/container/CLI protocols independently specifies this case: “honours an explicit encoder only when it is usable”.
- **B2:** A caller-visible violation of “honours an explicit encoder only when it is usable” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: external encoder capability lists, command-line option rules and shim process exit status. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes encoder negotiation and FFmpeg argument generation. Non-test consumers: tools/encoders.ts used by proxy/export/native/Remotion services.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “honours an explicit encoder only when it is usable” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: nothing usable → null and a capability message

- **B1:** AGENTS.md LGPL rules; FFmpeg codec/container/CLI protocols independently specifies this case: “nothing usable → null and a capability message”.
- **B2:** A caller-visible violation of “nothing usable → null and a capability message” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: external encoder capability lists, command-line option rules and shim process exit status. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes encoder negotiation and FFmpeg argument generation. Non-test consumers: tools/encoders.ts used by proxy/export/native/Remotion services.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “nothing usable → null and a capability message” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: capabilities report codecs, audio and ProRes (schema-valid)

- **B1:** AGENTS.md LGPL rules; FFmpeg codec/container/CLI protocols independently specifies this case: “capabilities report codecs, audio and ProRes (schema-valid)”.
- **B2:** A caller-visible violation of “capabilities report codecs, audio and ProRes (schema-valid)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: external encoder capability lists, command-line option rules and shim process exit status. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes encoder negotiation and FFmpeg argument generation. Non-test consumers: tools/encoders.ts used by proxy/export/native/Remotion services.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “capabilities report codecs, audio and ProRes (schema-valid)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: selects prores_ks for ProRes masters: MOV with PCM, never a substitute codec

- **B1:** AGENTS.md LGPL rules; FFmpeg codec/container/CLI protocols independently specifies this case: “selects prores_ks for ProRes masters: MOV with PCM, never a substitute codec”.
- **B2:** A caller-visible violation of “selects prores_ks for ProRes masters: MOV with PCM, never a substitute codec” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: external encoder capability lists, command-line option rules and shim process exit status. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes encoder negotiation and FFmpeg argument generation. Non-test consumers: tools/encoders.ts used by proxy/export/native/Remotion services.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “selects prores_ks for ProRes masters: MOV with PCM, never a substitute codec” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: parses the build license and hwaccels

- **B1:** AGENTS.md LGPL rules; FFmpeg codec/container/CLI protocols independently specifies this case: “parses the build license and hwaccels”.
- **B2:** A caller-visible violation of “parses the build license and hwaccels” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: external encoder capability lists, command-line option rules and shim process exit status. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes encoder negotiation and FFmpeg argument generation. Non-test consumers: tools/encoders.ts used by proxy/export/native/Remotion services.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “parses the build license and hwaccels” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: excludes hardware whose external test encode fails and honors LGPL-only/disabled configuration

- **B1:** AGENTS.md LGPL rules; FFmpeg codec/container/CLI protocols independently specifies this case: “excludes hardware whose external test encode fails and honors LGPL-only/disabled configuration”.
- **B2:** A caller-visible violation of “excludes hardware whose external test encode fails and honors LGPL-only/disabled configuration” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: external encoder capability lists, command-line option rules and shim process exit status. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes encoder negotiation and FFmpeg argument generation. Non-test consumers: tools/encoders.ts used by proxy/export/native/Remotion services.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “excludes hardware whose external test encode fails and honors LGPL-only/disabled configuration” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.


## apps/engine/test/fuzz.test.ts

Owner/caller evidence: imports services, media/probe.ts, mg-bundles service and upload routes. Independent sources: AGENTS.md parsers accept untrusted input without crashes and bound allocations.

Validation planned: `pnpm exec vitest run apps/engine/test/fuzz.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### KEEP: ZIP (imports): list + read every entry

- **B1:** AGENTS.md parsers accept untrusted input without crashes and bound allocations independently specifies this case: “ZIP (imports): list + read every entry”.
- **B2:** A caller-visible violation of “ZIP (imports): list + read every entry” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: hostile generated bytes/JSON; typed errors, schema validity and extraction containment. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes real archive, imported media, metadata and filename parsers. Non-test consumers: imports services, media/probe.ts, mg-bundles service and upload routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “ZIP (imports): list + read every entry” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: ZIP (motion-graphics bundles): extract, never outside the destination

- **B1:** AGENTS.md parsers accept untrusted input without crashes and bound allocations independently specifies this case: “ZIP (motion-graphics bundles): extract, never outside the destination”.
- **B2:** A caller-visible violation of “ZIP (motion-graphics bundles): extract, never outside the destination” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: hostile generated bytes/JSON; typed errors, schema validity and extraction containment. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes real archive, imported media, metadata and filename parsers. Non-test consumers: imports services, media/probe.ts, mg-bundles service and upload routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “ZIP (motion-graphics bundles): extract, never outside the destination” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: dotLottie archive

- **B1:** AGENTS.md parsers accept untrusted input without crashes and bound allocations independently specifies this case: “dotLottie archive”.
- **B2:** A caller-visible violation of “dotLottie archive” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: hostile generated bytes/JSON; typed errors, schema validity and extraction containment. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes real archive, imported media, metadata and filename parsers. Non-test consumers: imports services, media/probe.ts, mg-bundles service and upload routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “dotLottie archive” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: Lottie .json file

- **B1:** AGENTS.md parsers accept untrusted input without crashes and bound allocations independently specifies this case: “Lottie .json file”.
- **B2:** A caller-visible violation of “Lottie .json file” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: hostile generated bytes/JSON; typed errors, schema validity and extraction containment. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes real archive, imported media, metadata and filename parsers. Non-test consumers: imports services, media/probe.ts, mg-bundles service and upload routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “Lottie .json file” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: Photoshop document

- **B1:** AGENTS.md parsers accept untrusted input without crashes and bound allocations independently specifies this case: “Photoshop document”.
- **B2:** A caller-visible violation of “Photoshop document” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: hostile generated bytes/JSON; typed errors, schema validity and extraction containment. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes real archive, imported media, metadata and filename parsers. Non-test consumers: imports services, media/probe.ts, mg-bundles service and upload routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “Photoshop document” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: ffprobe JSON → probe (schema-valid)

- **B1:** AGENTS.md parsers accept untrusted input without crashes and bound allocations independently specifies this case: “ffprobe JSON → probe (schema-valid)”.
- **B2:** A caller-visible violation of “ffprobe JSON → probe (schema-valid)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: hostile generated bytes/JSON; typed errors, schema validity and extraction containment. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes real archive, imported media, metadata and filename parsers. Non-test consumers: imports services, media/probe.ts, mg-bundles service and upload routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “ffprobe JSON → probe (schema-valid)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: bundle manifest (jasper.mg.json)

- **B1:** AGENTS.md parsers accept untrusted input without crashes and bound allocations independently specifies this case: “bundle manifest (jasper.mg.json)”.
- **B2:** A caller-visible violation of “bundle manifest (jasper.mg.json)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: hostile generated bytes/JSON; typed errors, schema validity and extraction containment. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes real archive, imported media, metadata and filename parsers. Non-test consumers: imports services, media/probe.ts, mg-bundles service and upload routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “bundle manifest (jasper.mg.json)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: bundle package.json

- **B1:** AGENTS.md parsers accept untrusted input without crashes and bound allocations independently specifies this case: “bundle package.json”.
- **B2:** A caller-visible violation of “bundle package.json” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: hostile generated bytes/JSON; typed errors, schema validity and extraction containment. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes real archive, imported media, metadata and filename parsers. Non-test consumers: imports services, media/probe.ts, mg-bundles service and upload routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “bundle package.json” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: upload file names

- **B1:** AGENTS.md parsers accept untrusted input without crashes and bound allocations independently specifies this case: “upload file names”.
- **B2:** A caller-visible violation of “upload file names” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: hostile generated bytes/JSON; typed errors, schema validity and extraction containment. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes real archive, imported media, metadata and filename parsers. Non-test consumers: imports services, media/probe.ts, mg-bundles service and upload routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “upload file names” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### DELETE: engine runtime file

Detectable failure before removal: the expectation named “engine runtime file”. Disposition: Config parser robustness already tested at packages/config owner, confirmed by shared agent. Non-test seam consumers: imports services, media/probe.ts, mg-bundles service and upload routes; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.

### DELETE: engine events

Detectable failure before removal: the expectation named “engine events”. Disposition: Event parser robustness already tested at packages/api owner, confirmed by shared agent. Non-test seam consumers: imports services, media/probe.ts, mg-bundles service and upload routes; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.


## apps/engine/test/fx-routing.test.ts

Owner/caller evidence: export/planner.ts and layer-bake/service.ts. Independent sources: AGENTS.md exact feature routing; docs/wp-notes/wp-m2-layer-bake.md seeded identity/static semantics.

Validation planned: `pnpm exec vitest run apps/engine/test/fx-routing.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### KEEP: a shader effect blocks the native path (the clip renders through Remotion)

- **B1:** AGENTS.md exact feature routing; docs/wp-notes/wp-m2-layer-bake.md seeded identity/static semantics independently specifies this case: “a shader effect blocks the native path (the clip renders through Remotion)”.
- **B2:** A caller-visible violation of “a shader effect blocks the native path (the clip renders through Remotion)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: externally declared shader metadata and identical clips with different IDs. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes nativeBlockers/isStaticLayer and bake cache normalisation. Non-test consumers: export/planner.ts and layer-bake/service.ts.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “a shader effect blocks the native path (the clip renders through Remotion)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: time-dependent shader effects make a DOM layer non-static (rendered per frame, not a still)

- **B1:** AGENTS.md exact feature routing; docs/wp-notes/wp-m2-layer-bake.md seeded identity/static semantics independently specifies this case: “time-dependent shader effects make a DOM layer non-static (rendered per frame, not a still)”.
- **B2:** A caller-visible violation of “time-dependent shader effects make a DOM layer non-static (rendered per frame, not a still)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: externally declared shader metadata and identical clips with different IDs. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes nativeBlockers/isStaticLayer and bake cache normalisation. Non-test consumers: export/planner.ts and layer-bake/service.ts.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “time-dependent shader effects make a DOM layer non-static (rendered per frame, not a still)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### REWRITE: bake keys keep the clip id of layers with shader effects (u_seed hashes it)

Change: Compare seeded/unseeded cache-normalisation identity relationships; remove incidental literal replacement clip ID.

- **B1:** AGENTS.md exact feature routing; docs/wp-notes/wp-m2-layer-bake.md seeded identity/static semantics independently specifies this case: “bake keys keep the clip id of layers with shader effects (u_seed hashes it)”.
- **B2:** A caller-visible violation of “bake keys keep the clip id of layers with shader effects (u_seed hashes it)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: externally declared shader metadata and identical clips with different IDs. Compare seeded/unseeded cache-normalisation identity relationships; remove incidental literal replacement clip ID.
- **B4:** Observes nativeBlockers/isStaticLayer and bake cache normalisation. Non-test consumers: export/planner.ts and layer-bake/service.ts.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “bake keys keep the clip id of layers with shader effects (u_seed hashes it)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.


## apps/engine/test/gaps-project-manager.test.ts

Owner/caller evidence: routes/gaps.ts and project-manager service. Independent sources: project-manager public HTTP contract; AGENTS.md no data loss.

Validation planned: `pnpm exec vitest run apps/engine/test/gaps-project-manager.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### KEEP: estimates the disk space without writing

- **B1:** project-manager public HTTP contract; AGENTS.md no data loss independently specifies this case: “estimates the disk space without writing”.
- **B2:** A caller-visible violation of “estimates the disk space without writing” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: known numbered source frames, immutable originals, literal destination bytes and error status. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes project-manager plan and jobs, published project/media files. Non-test consumers: routes/gaps.ts and project-manager service.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “estimates the disk space without writing” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: consolidates the used part with handles; the copy shows the same frames from its own file

- **B1:** project-manager public HTTP contract; AGENTS.md no data loss independently specifies this case: “consolidates the used part with handles; the copy shows the same frames from its own file”.
- **B2:** A caller-visible violation of “consolidates the used part with handles; the copy shows the same frames from its own file” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: known numbered source frames, immutable originals, literal destination bytes and error status. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes project-manager plan and jobs, published project/media files. Non-test consumers: routes/gaps.ts and project-manager service.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “consolidates the used part with handles; the copy shows the same frames from its own file” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### REWRITE: collects whole files (same bytes) and refuses to overwrite an existing copy

Change: Compare actual collected bytes rather than only file lengths.

- **B1:** project-manager public HTTP contract; AGENTS.md no data loss independently specifies this case: “collects whole files (same bytes) and refuses to overwrite an existing copy”.
- **B2:** A caller-visible violation of “collects whole files (same bytes) and refuses to overwrite an existing copy” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: known numbered source frames, immutable originals, literal destination bytes and error status. Compare actual collected bytes rather than only file lengths.
- **B4:** Observes project-manager plan and jobs, published project/media files. Non-test consumers: routes/gaps.ts and project-manager service.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “collects whole files (same bytes) and refuses to overwrite an existing copy” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.


## apps/engine/test/gaps-reframe.test.ts

Owner/caller evidence: reframe service and project commands. Independent sources: docs/specs/09-tracking.md automatic reframing.

Validation planned: `pnpm exec vitest run apps/engine/test/gaps-reframe.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### KEEP: follows the moving subject (saliency)

- **B1:** docs/specs/09-tracking.md automatic reframing independently specifies this case: “follows the moving subject (saliency)”.
- **B2:** A caller-visible violation of “follows the moving subject (saliency)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: independently generated moving subject centres and target aspect ratio. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes analysis HTTP job and resulting public document commands. Non-test consumers: reframe service and project commands.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “follows the moving subject (saliency)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: makes a 9:16 copy whose Position keeps the subject in frame

- **B1:** docs/specs/09-tracking.md automatic reframing independently specifies this case: “makes a 9:16 copy whose Position keeps the subject in frame”.
- **B2:** A caller-visible violation of “makes a 9:16 copy whose Position keeps the subject in frame” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: independently generated moving subject centres and target aspect ratio. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes analysis HTTP job and resulting public document commands. Non-test consumers: reframe service and project commands.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “makes a 9:16 copy whose Position keeps the subject in frame” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.


## apps/engine/test/gaps-routes.test.ts

Owner/caller evidence: routes/gaps.ts handlers and preferences consumers. Independent sources: README.md HTTP configuration; platform opener protocols; AGENTS.md error safety.

Validation planned: `pnpm exec vitest run apps/engine/test/gaps-routes.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### REWRITE: builds the host opener per platform

Change recorded before edit: Keep Darwin/Linux and configured-opener protocols; remove the Windows examples duplicated by stronger arbitrary-path and real PowerShell tests.

- **B1:** README.md HTTP configuration; platform opener protocols; AGENTS.md error safety independently specifies this case: “builds the host opener per platform”.
- **B2:** A caller-visible violation of “builds the host opener per platform” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: documented platform command arguments, OS exit status and persisted configuration values. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes openerFor OS command and HTTP locate/preferences routes. Non-test consumers: routes/gaps.ts handlers and preferences consumers.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “builds the host opener per platform” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: locates a registered file and opens it with the host opener

- **B1:** README.md HTTP configuration; platform opener protocols; AGENTS.md error safety independently specifies this case: “locates a registered file and opens it with the host opener”.
- **B2:** A caller-visible violation of “locates a registered file and opens it with the host opener” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: documented platform command arguments, OS exit status and persisted configuration values. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes openerFor OS command and HTTP locate/preferences routes. Non-test consumers: routes/gaps.ts handlers and preferences consumers.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “locates a registered file and opens it with the host opener” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: reads, validates, persists and applies the version policy and render optimisation

- **B1:** README.md HTTP configuration; platform opener protocols; AGENTS.md error safety independently specifies this case: “reads, validates, persists and applies the version policy and render optimisation”.
- **B2:** A caller-visible violation of “reads, validates, persists and applies the version policy and render optimisation” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: documented platform command arguments, OS exit status and persisted configuration values. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes openerFor OS command and HTTP locate/preferences routes. Non-test consumers: routes/gaps.ts handlers and preferences consumers.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “reads, validates, persists and applies the version policy and render optimisation” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.


## apps/engine/test/gaps-warp-analysis.test.ts

Owner/caller evidence: warp service, project resolver, export planner. Independent sources: docs/specs/09-tracking.md stabilizer; docs/wp-notes/sim-warp.md.

Validation planned: `pnpm exec vitest run apps/engine/test/gaps-warp-analysis.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### KEEP: measures the known camera walk frame by frame

- **B1:** docs/specs/09-tracking.md stabilizer; docs/wp-notes/sim-warp.md independently specifies this case: “measures the known camera walk frame by frame”.
- **B2:** A caller-visible violation of “measures the known camera walk frame by frame” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: generated known camera walk, identity after corrective transform and named WARP_NOT_ANALYZED refusal. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes warp analysis HTTP jobs, project resolution and export planner. Non-test consumers: warp service, project resolver, export planner.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “measures the known camera walk frame by frame” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### REWRITE: the stored analysis stabilises the walk (No Motion holds the scene still)

Change: Remove unrelated hApply/decode coverage probes; keep known-walk residual oracle.

- **B1:** docs/specs/09-tracking.md stabilizer; docs/wp-notes/sim-warp.md independently specifies this case: “the stored analysis stabilises the walk (No Motion holds the scene still)”.
- **B2:** A caller-visible violation of “the stored analysis stabilises the walk (No Motion holds the scene still)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: generated known camera walk, identity after corrective transform and named WARP_NOT_ANALYZED refusal. Remove unrelated hApply/decode coverage probes; keep known-walk residual oracle.
- **B4:** Observes warp analysis HTTP jobs, project resolution and export planner. Non-test consumers: warp service, project resolver, export planner.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “the stored analysis stabilises the walk (No Motion holds the scene still)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### REWRITE: the export planner refuses an un-analysed Warp Stabilizer and exports an analysed one

Change: Rename to the behavior actually observed: planner accepts analyzed input; no claim of a completed render.

- **B1:** docs/specs/09-tracking.md stabilizer; docs/wp-notes/sim-warp.md independently specifies this case: “the export planner refuses an un-analysed Warp Stabilizer and exports an analysed one”.
- **B2:** A caller-visible violation of “the export planner refuses an un-analysed Warp Stabilizer and exports an analysed one” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: generated known camera walk, identity after corrective transform and named WARP_NOT_ANALYZED refusal. Rename to the behavior actually observed: planner accepts analyzed input; no claim of a completed render.
- **B4:** Observes warp analysis HTTP jobs, project resolution and export planner. Non-test consumers: warp service, project resolver, export planner.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “the export planner refuses an un-analysed Warp Stabilizer and exports an analysed one” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.


## apps/engine/test/golden-parity.e2e.test.ts

Owner/caller evidence: export/service.ts and compositions renderer. Independent sources: AGENTS.md preview/export fidelity; docs/testing.md approved visual regressions.

Validation planned: `pnpm exec vitest run apps/engine/test/golden-parity.e2e.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### REWRITE: ${scene.name}: native = Remotion, native = golden

Named cases: `transform-opacity`, `crop`, `blend-screen`, `blend-linear-burn`, `colour-run`. Each compares independently rendered pixels and its own committed approved golden, so removing one would leave that transform/effect combination unprotected.

Change: Construct reference input through public buildRenderSnapshot and signed media handles instead of accessing private remotionProps.

- **B1:** AGENTS.md preview/export fidelity; docs/testing.md approved visual regressions independently specifies this case: “${scene.name}: native = Remotion, native = golden”.
- **B2:** A caller-visible violation of “${scene.name}: native = Remotion, native = golden” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: independent renderers and reviewed committed images for transform/crop/blend/colour scenes. Construct reference input through public buildRenderSnapshot and signed media handles instead of accessing private remotionProps.
- **B4:** Observes native still HTTP export and public Remotion render snapshot. Non-test consumers: export/service.ts and compositions renderer.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “${scene.name}: native = Remotion, native = golden” at the above seam. Other compositor suites own isolated blend modes; this case owns complete engine-produced artifacts.
Risk: medium; external rendering/tooling must be available to validate the artifact. Validation: the focused command above, then engine typecheck and root repository gates.

### DELETE: no scene is blank or a duplicate of another

Detectable failure before removal: the expectation named “no scene is blank or a duplicate of another”. Disposition: Fixture self-test only; each individual reviewed golden and renderer comparison already catches blank or changed scene output. Non-test seam consumers: export/service.ts and compositions renderer; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.


## apps/engine/test/imports.test.ts

Owner/caller evidence: imports services, media probe and export routes. Independent sources: docs/wp-notes/imports.md supported formats; ZIP/PSD/EXR/Lottie protocols.

Validation planned: `pnpm exec vitest run apps/engine/test/imports.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### KEEP: round-trips stored archives and reads deflated entries

- **B1:** docs/wp-notes/imports.md supported formats; ZIP/PSD/EXR/Lottie protocols independently specifies this case: “round-trips stored archives and reads deflated entries”.
- **B2:** A caller-visible violation of “round-trips stored archives and reads deflated entries” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: format constants, independently generated media, external decoders, fixed pixel and frame expectations. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes archive/format parser and public import/export HTTP services. Non-test consumers: imports services, media probe and export routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “round-trips stored archives and reads deflated entries” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### DELETE: never crashes on hostile bytes (fuzz)

Detectable failure before removal: the expectation named “never crashes on hostile bytes (fuzz)”. Disposition: Duplicate hostile ZIP fuzz; broader engine/fuzz ZIP mutation/structure target remains. Non-test seam consumers: imports services, media probe and export routes; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.

### REWRITE: maps every Photoshop blend mode to an editor blend mode exactly

Change: Keep externally specified Photoshop aliases/fallback, delete enum self-mapping inventory.

- **B1:** docs/wp-notes/imports.md supported formats; ZIP/PSD/EXR/Lottie protocols independently specifies this case: “maps every Photoshop blend mode to an editor blend mode exactly”.
- **B2:** A caller-visible violation of “maps every Photoshop blend mode to an editor blend mode exactly” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: format constants, independently generated media, external decoders, fixed pixel and frame expectations. Keep externally specified Photoshop aliases/fallback, delete enum self-mapping inventory.
- **B4:** Observes archive/format parser and public import/export HTTP services. Non-test consumers: imports services, media probe and export routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “maps every Photoshop blend mode to an editor blend mode exactly” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: decodes EXR with the sRGB transfer and Radiance HDR through zscale

- **B1:** docs/wp-notes/imports.md supported formats; ZIP/PSD/EXR/Lottie protocols independently specifies this case: “decodes EXR with the sRGB transfer and Radiance HDR through zscale”.
- **B2:** A caller-visible violation of “decodes EXR with the sRGB transfer and Radiance HDR through zscale” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: format constants, independently generated media, external decoders, fixed pixel and frame expectations. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes archive/format parser and public import/export HTTP services. Non-test consumers: imports services, media probe and export routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “decodes EXR with the sRGB transfer and Radiance HDR through zscale” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: probes every imported format

- **B1:** docs/wp-notes/imports.md supported formats; ZIP/PSD/EXR/Lottie protocols independently specifies this case: “probes every imported format”.
- **B2:** A caller-visible violation of “probes every imported format” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: format constants, independently generated media, external decoders, fixed pixel and frame expectations. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes archive/format parser and public import/export HTTP services. Non-test consumers: imports services, media probe and export routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “probes every imported format” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: serves Lottie documents, SVG text and PDF pages

- **B1:** docs/wp-notes/imports.md supported formats; ZIP/PSD/EXR/Lottie protocols independently specifies this case: “serves Lottie documents, SVG text and PDF pages”.
- **B2:** A caller-visible violation of “serves Lottie documents, SVG text and PDF pages” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: format constants, independently generated media, external decoders, fixed pixel and frame expectations. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes archive/format parser and public import/export HTTP services. Non-test consumers: imports services, media probe and export routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “serves Lottie documents, SVG text and PDF pages” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: conforms an image sequence with a gap holding the previous frame

- **B1:** docs/wp-notes/imports.md supported formats; ZIP/PSD/EXR/Lottie protocols independently specifies this case: “conforms an image sequence with a gap holding the previous frame”.
- **B2:** A caller-visible violation of “conforms an image sequence with a gap holding the previous frame” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: format constants, independently generated media, external decoders, fixed pixel and frame expectations. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes archive/format parser and public import/export HTTP services. Non-test consumers: imports services, media probe and export routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “conforms an image sequence with a gap holding the previous frame” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: extracts PSD layers with blend modes, opacity, visibility and groups

- **B1:** docs/wp-notes/imports.md supported formats; ZIP/PSD/EXR/Lottie protocols independently specifies this case: “extracts PSD layers with blend modes, opacity, visibility and groups”.
- **B2:** A caller-visible violation of “extracts PSD layers with blend modes, opacity, visibility and groups” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: format constants, independently generated media, external decoders, fixed pixel and frame expectations. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes archive/format parser and public import/export HTTP services. Non-test consumers: imports services, media probe and export routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “extracts PSD layers with blend modes, opacity, visibility and groups” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: makes display pictures of stills a browser cannot decode

- **B1:** docs/wp-notes/imports.md supported formats; ZIP/PSD/EXR/Lottie protocols independently specifies this case: “makes display pictures of stills a browser cannot decode”.
- **B2:** A caller-visible violation of “makes display pictures of stills a browser cannot decode” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: format constants, independently generated media, external decoders, fixed pixel and frame expectations. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes archive/format parser and public import/export HTTP services. Non-test consumers: imports services, media probe and export routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “makes display pictures of stills a browser cannot decode” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: exports a sequence with a still and a Lottie clip as Lottie

- **B1:** docs/wp-notes/imports.md supported formats; ZIP/PSD/EXR/Lottie protocols independently specifies this case: “exports a sequence with a still and a Lottie clip as Lottie”.
- **B2:** A caller-visible violation of “exports a sequence with a still and a Lottie clip as Lottie” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: format constants, independently generated media, external decoders, fixed pixel and frame expectations. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes archive/format parser and public import/export HTTP services. Non-test consumers: imports services, media probe and export routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “exports a sequence with a still and a Lottie clip as Lottie” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: Interpret Footage ▸ Alpha Channel changes the native export (measured pixels)

- **B1:** docs/wp-notes/imports.md supported formats; ZIP/PSD/EXR/Lottie protocols independently specifies this case: “Interpret Footage ▸ Alpha Channel changes the native export (measured pixels)”.
- **B2:** A caller-visible violation of “Interpret Footage ▸ Alpha Channel changes the native export (measured pixels)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: format constants, independently generated media, external decoders, fixed pixel and frame expectations. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes archive/format parser and public import/export HTTP services. Non-test consumers: imports services, media probe and export routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “Interpret Footage ▸ Alpha Channel changes the native export (measured pixels)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.


## apps/engine/test/interchange.test.ts

Owner/caller evidence: interchange service and HTTP routes. Independent sources: docs/wp-notes/interchange.md FCP7/AAF/OMF/EDL contracts; AGENTS.md no overwrite.

Validation planned: `pnpm exec vitest run apps/engine/test/interchange.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### KEEP: exports FCP7 XML as a job and imports it back by path with the media registered

- **B1:** docs/wp-notes/interchange.md FCP7/AAF/OMF/EDL contracts; AGENTS.md no overwrite independently specifies this case: “exports FCP7 XML as a job and imports it back by path with the media registered”.
- **B2:** A caller-visible violation of “exports FCP7 XML as a job and imports it back by path with the media registered” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: interchange fixtures, decoded media streams and existing file bytes. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes public interchange import/export jobs and media relinking. Non-test consumers: interchange service and HTTP routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “exports FCP7 XML as a job and imports it back by path with the media registered” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: never overwrites an existing file at the destination (security review DATA-3)

- **B1:** docs/wp-notes/interchange.md FCP7/AAF/OMF/EDL contracts; AGENTS.md no overwrite independently specifies this case: “never overwrites an existing file at the destination (security review DATA-3)”.
- **B2:** A caller-visible violation of “never overwrites an existing file at the destination (security review DATA-3)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: interchange fixtures, decoded media streams and existing file bytes. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes public interchange import/export jobs and media relinking. Non-test consumers: interchange service and HTTP routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “never overwrites an existing file at the destination (security review DATA-3)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: AAF with embedded audio: the essence is decoded by ffmpeg and comes back as WAV files

- **B1:** docs/wp-notes/interchange.md FCP7/AAF/OMF/EDL contracts; AGENTS.md no overwrite independently specifies this case: “AAF with embedded audio: the essence is decoded by ffmpeg and comes back as WAV files”.
- **B2:** A caller-visible violation of “AAF with embedded audio: the essence is decoded by ffmpeg and comes back as WAV files” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: interchange fixtures, decoded media streams and existing file bytes. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes public interchange import/export jobs and media relinking. Non-test consumers: interchange service and HTTP routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “AAF with embedded audio: the essence is decoded by ffmpeg and comes back as WAV files” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: OMF with separate AIFF files broken out to mono, written next to the document

- **B1:** docs/wp-notes/interchange.md FCP7/AAF/OMF/EDL contracts; AGENTS.md no overwrite independently specifies this case: “OMF with separate AIFF files broken out to mono, written next to the document”.
- **B2:** A caller-visible violation of “OMF with separate AIFF files broken out to mono, written next to the document” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: interchange fixtures, decoded media streams and existing file bytes. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes public interchange import/export jobs and media relinking. Non-test consumers: interchange service and HTTP routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “OMF with separate AIFF files broken out to mono, written next to the document” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: per-track EDLs and the pre-render plan

- **B1:** docs/wp-notes/interchange.md FCP7/AAF/OMF/EDL contracts; AGENTS.md no overwrite independently specifies this case: “per-track EDLs and the pre-render plan”.
- **B2:** A caller-visible violation of “per-track EDLs and the pre-render plan” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: interchange fixtures, decoded media streams and existing file bytes. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes public interchange import/export jobs and media relinking. Non-test consumers: interchange service and HTTP routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “per-track EDLs and the pre-render plan” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: imports a document whose media is elsewhere as offline placeholders, then links them (one and by folder)

- **B1:** docs/wp-notes/interchange.md FCP7/AAF/OMF/EDL contracts; AGENTS.md no overwrite independently specifies this case: “imports a document whose media is elsewhere as offline placeholders, then links them (one and by folder)”.
- **B2:** A caller-visible violation of “imports a document whose media is elsewhere as offline placeholders, then links them (one and by folder)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: interchange fixtures, decoded media streams and existing file bytes. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes public interchange import/export jobs and media relinking. Non-test consumers: interchange service and HTTP routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “imports a document whose media is elsewhere as offline placeholders, then links them (one and by folder)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: refuses garbage with a named error

- **B1:** docs/wp-notes/interchange.md FCP7/AAF/OMF/EDL contracts; AGENTS.md no overwrite independently specifies this case: “refuses garbage with a named error”.
- **B2:** A caller-visible violation of “refuses garbage with a named error” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: interchange fixtures, decoded media streams and existing file bytes. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes public interchange import/export jobs and media relinking. Non-test consumers: interchange service and HTTP routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “refuses garbage with a named error” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.


## apps/engine/test/layer-bake.e2e.test.ts

Owner/caller evidence: export/service.ts and layer-bake/service.ts. Independent sources: docs/wp-notes/wp-m2-layer-bake.md LBK-003/004/023/025/026 and FIX-002.

Validation planned: `pnpm exec vitest run apps/engine/test/layer-bake.e2e.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### KEEP: plans hybrid; bakes one PNG per static layer; the output matches a full Remotion render (≤ 3/255 on 99 %)

- **B1:** docs/wp-notes/wp-m2-layer-bake.md LBK-003/004/023/025/026 and FIX-002 independently specifies this case: “plans hybrid; bakes one PNG per static layer; the output matches a full Remotion render (≤ 3/255 on 99 %)”.
- **B2:** A caller-visible violation of “plans hybrid; bakes one PNG per static layer; the output matches a full Remotion render (≤ 3/255 on 99 %)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: independent full browser render and fixed alpha/grade/fade arithmetic; injected bake failure only raises an OS-style service error. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes real export/preview jobs and published PNG/ProRes artifacts. Non-test consumers: export/service.ts and layer-bake/service.ts.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “plans hybrid; bakes one PNG per static layer; the output matches a full Remotion render (≤ 3/255 on 99 %)” at the above seam. Other compositor suites own isolated blend modes; this case owns complete engine-produced artifacts.
Risk: medium; external rendering/tooling must be available to validate the artifact. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: masters keep straight alpha: over R/G/B/W within 2/255 of the browser still

- **B1:** docs/wp-notes/wp-m2-layer-bake.md LBK-003/004/023/025/026 and FIX-002 independently specifies this case: “masters keep straight alpha: over R/G/B/W within 2/255 of the browser still”.
- **B2:** A caller-visible violation of “masters keep straight alpha: over R/G/B/W within 2/255 of the browser still” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: independent full browser render and fixed alpha/grade/fade arithmetic; injected bake failure only raises an OS-style service error. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes real export/preview jobs and published PNG/ProRes artifacts. Non-test consumers: export/service.ts and layer-bake/service.ts.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “masters keep straight alpha: over R/G/B/W within 2/255 of the browser still” at the above seam. Other compositor suites own isolated blend modes; this case owns complete engine-produced artifacts.
Risk: medium; external rendering/tooling must be available to validate the artifact. Validation: the focused command above, then engine typecheck and root repository gates.

### DELETE: re-exports hit the cache; moving a title in time hits it too; a text change bakes again

Detectable failure before removal: the expectation named “re-exports hit the cache; moving a title in time hits it too; a text change bakes again”. Disposition: Asserts child job count to infer cache hits, repeating lower bake-key/cache lookup contracts; artifact parity cases still protect real baked exports. Non-test seam consumers: export/service.ts and layer-bake/service.ts; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.

### KEEP: stills take the same path: cached masters are reused, else one frame per layer is baked (LBK-025)

- **B1:** docs/wp-notes/wp-m2-layer-bake.md LBK-003/004/023/025/026 and FIX-002 independently specifies this case: “stills take the same path: cached masters are reused, else one frame per layer is baked (LBK-025)”.
- **B2:** A caller-visible violation of “stills take the same path: cached masters are reused, else one frame per layer is baked (LBK-025)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: independent full browser render and fixed alpha/grade/fade arithmetic; injected bake failure only raises an OS-style service error. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes real export/preview jobs and published PNG/ProRes artifacts. Non-test consumers: export/service.ts and layer-bake/service.ts.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “stills take the same path: cached masters are reused, else one frame per layer is baked (LBK-025)” at the above seam. Other compositor suites own isolated blend modes; this case owns complete engine-produced artifacts.
Risk: medium; external rendering/tooling must be available to validate the artifact. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: a Lumetri grade on a title shows in the native export, the Remotion export and the graded preview (FIX-002)

- **B1:** docs/wp-notes/wp-m2-layer-bake.md LBK-003/004/023/025/026 and FIX-002 independently specifies this case: “a Lumetri grade on a title shows in the native export, the Remotion export and the graded preview (FIX-002)”.
- **B2:** A caller-visible violation of “a Lumetri grade on a title shows in the native export, the Remotion export and the graded preview (FIX-002)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: independent full browser render and fixed alpha/grade/fade arithmetic; injected bake failure only raises an OS-style service error. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes real export/preview jobs and published PNG/ProRes artifacts. Non-test consumers: export/service.ts and layer-bake/service.ts.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “a Lumetri grade on a title shows in the native export, the Remotion export and the graded preview (FIX-002)” at the above seam. Other compositor suites own isolated blend modes; this case owns complete engine-produced artifacts.
Risk: medium; external rendering/tooling must be available to validate the artifact. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: a graded static title fades through its transition once on every path: native, Remotion, preview (review fix 1)

- **B1:** docs/wp-notes/wp-m2-layer-bake.md LBK-003/004/023/025/026 and FIX-002 independently specifies this case: “a graded static title fades through its transition once on every path: native, Remotion, preview (review fix 1)”.
- **B2:** A caller-visible violation of “a graded static title fades through its transition once on every path: native, Remotion, preview (review fix 1)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: independent full browser render and fixed alpha/grade/fade arithmetic; injected bake failure only raises an OS-style service error. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes real export/preview jobs and published PNG/ProRes artifacts. Non-test consumers: export/service.ts and layer-bake/service.ts.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “a graded static title fades through its transition once on every path: native, Remotion, preview (review fix 1)” at the above seam. Other compositor suites own isolated blend modes; this case owns complete engine-produced artifacts.
Risk: medium; external rendering/tooling must be available to validate the artifact. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: a failing bake: `auto` falls back to Remotion with a warning, forced native fails (LBK-023)

- **B1:** docs/wp-notes/wp-m2-layer-bake.md LBK-003/004/023/025/026 and FIX-002 independently specifies this case: “a failing bake: `auto` falls back to Remotion with a warning, forced native fails (LBK-023)”.
- **B2:** A caller-visible violation of “a failing bake: `auto` falls back to Remotion with a warning, forced native fails (LBK-023)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: independent full browser render and fixed alpha/grade/fade arithmetic; injected bake failure only raises an OS-style service error. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes real export/preview jobs and published PNG/ProRes artifacts. Non-test consumers: export/service.ts and layer-bake/service.ts.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “a failing bake: `auto` falls back to Remotion with a warning, forced native fails (LBK-023)” at the above seam. Other compositor suites own isolated blend modes; this case owns complete engine-produced artifacts.
Risk: medium; external rendering/tooling must be available to validate the artifact. Validation: the focused command above, then engine typecheck and root repository gates.


## apps/engine/test/layer-bake.test.ts

Owner/caller evidence: layer-bake/service.ts, export/planner.ts, cache/GC and preview routes. Independent sources: docs/wp-notes/wp-m2-layer-bake.md static/cache/routing/GC/security contracts.

Validation planned: `pnpm exec vitest run apps/engine/test/layer-bake.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### KEEP: static = no animator, no keyframes anywhere, no anime template, no unknown effect

- **B1:** docs/wp-notes/wp-m2-layer-bake.md static/cache/routing/GC/security contracts independently specifies this case: “static = no animator, no keyframes anywhere, no anime template, no unknown effect”.
- **B2:** A caller-visible violation of “static = no animator, no keyframes anywhere, no anime template, no unknown effect” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: explicit equal/different input relationships, declared capabilities, signed URL authorization and timestamps. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes bake planning/key identity, HTTP API and real cache filesystem. Non-test consumers: layer-bake/service.ts, export/planner.ts, cache/GC and preview routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “static = no animator, no keyframes anywhere, no anime template, no unknown effect” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: a keyframed grade does not make a DOM layer a master: colour runs are applied by ffmpeg (LBK-010)

- **B1:** docs/wp-notes/wp-m2-layer-bake.md static/cache/routing/GC/security contracts independently specifies this case: “a keyframed grade does not make a DOM layer a master: colour runs are applied by ffmpeg (LBK-010)”.
- **B2:** A caller-visible violation of “a keyframed grade does not make a DOM layer a master: colour runs are applied by ffmpeg (LBK-010)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: explicit equal/different input relationships, declared capabilities, signed URL authorization and timestamps. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes bake planning/key identity, HTTP API and real cache filesystem. Non-test consumers: layer-bake/service.ts, export/planner.ts, cache/GC and preview routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “a keyframed grade does not make a DOM layer a master: colour runs are applied by ffmpeg (LBK-010)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: changes with text, font, bundle, anime.js, Remotion, browser and GL; not with time or duration

- **B1:** docs/wp-notes/wp-m2-layer-bake.md static/cache/routing/GC/security contracts independently specifies this case: “changes with text, font, bundle, anime.js, Remotion, browser and GL; not with time or duration”.
- **B2:** A caller-visible violation of “changes with text, font, bundle, anime.js, Remotion, browser and GL; not with time or duration” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: explicit equal/different input relationships, declared capabilities, signed URL authorization and timestamps. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes bake planning/key identity, HTTP API and real cache filesystem. Non-test consumers: layer-bake/service.ts, export/planner.ts, cache/GC and preview routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “changes with text, font, bundle, anime.js, Remotion, browser and GL; not with time or duration” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: identical titles share a bake unless they are seeded by their clip id (text animators, anime templates)

- **B1:** docs/wp-notes/wp-m2-layer-bake.md static/cache/routing/GC/security contracts independently specifies this case: “identical titles share a bake unless they are seeded by their clip id (text animators, anime templates)”.
- **B2:** A caller-visible violation of “identical titles share a bake unless they are seeded by their clip id (text animators, anime templates)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: explicit equal/different input relationships, declared capabilities, signed URL authorization and timestamps. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes bake planning/key identity, HTTP API and real cache filesystem. Non-test consumers: layer-bake/service.ts, export/planner.ts, cache/GC and preview routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “identical titles share a bake unless they are seeded by their clip id (text animators, anime templates)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: another title using a different font weight does not invalidate this title’s bake

- **B1:** docs/wp-notes/wp-m2-layer-bake.md static/cache/routing/GC/security contracts independently specifies this case: “another title using a different font weight does not invalidate this title’s bake”.
- **B2:** A caller-visible violation of “another title using a different font weight does not invalidate this title’s bake” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: explicit equal/different input relationships, declared capabilities, signed URL authorization and timestamps. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes bake planning/key identity, HTTP API and real cache filesystem. Non-test consumers: layer-bake/service.ts, export/planner.ts, cache/GC and preview routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “another title using a different font weight does not invalidate this title’s bake” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: footage with text, shape and anime layers has a hybrid export plan

- **B1:** docs/wp-notes/wp-m2-layer-bake.md static/cache/routing/GC/security contracts independently specifies this case: “footage with text, shape and anime layers has a hybrid export plan”.
- **B2:** A caller-visible violation of “footage with text, shape and anime layers has a hybrid export plan” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: explicit equal/different input relationships, declared capabilities, signed URL authorization and timestamps. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes bake planning/key identity, HTTP API and real cache filesystem. Non-test consumers: layer-bake/service.ts, export/planner.ts, cache/GC and preview routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “footage with text, shape and anime layers has a hybrid export plan” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: a forced native plan rejects a graphics layer when Remotion is unavailable

- **B1:** docs/wp-notes/wp-m2-layer-bake.md static/cache/routing/GC/security contracts independently specifies this case: “a forced native plan rejects a graphics layer when Remotion is unavailable”.
- **B2:** A caller-visible violation of “a forced native plan rejects a graphics layer when Remotion is unavailable” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: explicit equal/different input relationships, declared capabilities, signed URL authorization and timestamps. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes bake planning/key identity, HTTP API and real cache filesystem. Non-test consumers: layer-bake/service.ts, export/planner.ts, cache/GC and preview routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “a forced native plan rejects a graphics layer when Remotion is unavailable” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: `needs-browser-download` is not a blocker (warning BROWSER_DOWNLOAD)

- **B1:** docs/wp-notes/wp-m2-layer-bake.md static/cache/routing/GC/security contracts independently specifies this case: “`needs-browser-download` is not a blocker (warning BROWSER_DOWNLOAD)”.
- **B2:** A caller-visible violation of “`needs-browser-download` is not a blocker (warning BROWSER_DOWNLOAD)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: explicit equal/different input relationships, declared capabilities, signed URL authorization and timestamps. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes bake planning/key identity, HTTP API and real cache filesystem. Non-test consumers: layer-bake/service.ts, export/planner.ts, cache/GC and preview routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “`needs-browser-download` is not a blocker (warning BROWSER_DOWNLOAD)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: warns when a colour effect precedes a pixel-mixing effect on a DOM layer

- **B1:** docs/wp-notes/wp-m2-layer-bake.md static/cache/routing/GC/security contracts independently specifies this case: “warns when a colour effect precedes a pixel-mixing effect on a DOM layer”.
- **B2:** A caller-visible violation of “warns when a colour effect precedes a pixel-mixing effect on a DOM layer” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: explicit equal/different input relationships, declared capabilities, signed URL authorization and timestamps. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes bake planning/key identity, HTTP API and real cache filesystem. Non-test consumers: layer-bake/service.ts, export/planner.ts, cache/GC and preview routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “warns when a colour effect precedes a pixel-mixing effect on a DOM layer” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: GC removes entries unused for 14 days and keeps the others

- **B1:** docs/wp-notes/wp-m2-layer-bake.md static/cache/routing/GC/security contracts independently specifies this case: “GC removes entries unused for 14 days and keeps the others”.
- **B2:** A caller-visible violation of “GC removes entries unused for 14 days and keeps the others” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: explicit equal/different input relationships, declared capabilities, signed URL authorization and timestamps. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes bake planning/key identity, HTTP API and real cache filesystem. Non-test consumers: layer-bake/service.ts, export/planner.ts, cache/GC and preview routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “GC removes entries unused for 14 days and keeps the others” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: GC keeps leased entries and entries a lookup marks used meanwhile

- **B1:** docs/wp-notes/wp-m2-layer-bake.md static/cache/routing/GC/security contracts independently specifies this case: “GC keeps leased entries and entries a lookup marks used meanwhile”.
- **B2:** A caller-visible violation of “GC keeps leased entries and entries a lookup marks used meanwhile” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: explicit equal/different input relationships, declared capabilities, signed URL authorization and timestamps. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes bake planning/key identity, HTTP API and real cache filesystem. Non-test consumers: layer-bake/service.ts, export/planner.ts, cache/GC and preview routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “GC keeps leased entries and entries a lookup marks used meanwhile” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: graded masters are PNG frame sequences served per frame under one signed URL

- **B1:** docs/wp-notes/wp-m2-layer-bake.md static/cache/routing/GC/security contracts independently specifies this case: “graded masters are PNG frame sequences served per frame under one signed URL”.
- **B2:** A caller-visible violation of “graded masters are PNG frame sequences served per frame under one signed URL” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: explicit equal/different input relationships, declared capabilities, signed URL authorization and timestamps. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes bake planning/key identity, HTTP API and real cache filesystem. Non-test consumers: layer-bake/service.ts, export/planner.ts, cache/GC and preview routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “graded masters are PNG frame sequences served per frame under one signed URL” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### DELETE: features.layerBake reports readiness and the cache size

Detectable failure before removal: the expectation named “features.layerBake reports readiness and the cache size”. Disposition: Accepts either readiness state and any numeric bytes: schema/shape inventory without a recognizable failure beyond stronger capabilities/preview route cases. Non-test seam consumers: layer-bake/service.ts, export/planner.ts, cache/GC and preview routes; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.

### KEEP: POST /api/layer-bake/preview validates the request and the clip

- **B1:** docs/wp-notes/wp-m2-layer-bake.md static/cache/routing/GC/security contracts independently specifies this case: “POST /api/layer-bake/preview validates the request and the clip”.
- **B2:** A caller-visible violation of “POST /api/layer-bake/preview validates the request and the clip” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: explicit equal/different input relationships, declared capabilities, signed URL authorization and timestamps. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes bake planning/key identity, HTTP API and real cache filesystem. Non-test consumers: layer-bake/service.ts, export/planner.ts, cache/GC and preview routes.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “POST /api/layer-bake/preview validates the request and the clip” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.


## apps/engine/test/mg-bundle-hash.test.ts

Owner/caller evidence: mg-bundles/service.ts bundle hashing. Independent sources: AGENTS.md filesystem failures must be reported, no incomplete bundle cache identity.

Validation planned: `pnpm exec vitest run apps/engine/test/mg-bundle-hash.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### KEEP: reports a filesystem failure instead of hashing an incomplete bundle

- **B1:** AGENTS.md filesystem failures must be reported, no incomplete bundle cache identity independently specifies this case: “reports a filesystem failure instead of hashing an incomplete bundle”.
- **B2:** A caller-visible violation of “reports a filesystem failure instead of hashing an incomplete bundle” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: OS EACCES error and independently arranged readable/dangling files. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes hashBundleDir filesystem reader. Non-test consumers: mg-bundles/service.ts bundle hashing.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “reports a filesystem failure instead of hashing an incomplete bundle” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: ignores dangling links without omitting readable bundle files

- **B1:** AGENTS.md filesystem failures must be reported, no incomplete bundle cache identity independently specifies this case: “ignores dangling links without omitting readable bundle files”.
- **B2:** A caller-visible violation of “ignores dangling links without omitting readable bundle files” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: OS EACCES error and independently arranged readable/dangling files. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes hashBundleDir filesystem reader. Non-test consumers: mg-bundles/service.ts bundle hashing.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “ignores dangling links without omitting readable bundle files” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.


## apps/engine/test/mg-text-measure.test.ts

Owner/caller evidence: mg-bundles text measure during bundle build. Independent sources: AGENTS.md secure HTTP boundaries and visible errors.

Validation planned: `pnpm exec vitest run apps/engine/test/mg-text-measure.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### KEEP: serves bundle files under its loopback prefix and refuses existing files outside it

- **B1:** AGENTS.md secure HTTP boundaries and visible errors independently specifies this case: “serves bundle files under its loopback prefix and refuses existing files outside it”.
- **B2:** A caller-visible violation of “serves bundle files under its loopback prefix and refuses existing files outside it” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: outside-root canary files and malformed URI bytes; explicit denial and subsequent successful request. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes real loopback HTTP measurement server. Non-test consumers: mg-bundles text measure during bundle build.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “serves bundle files under its loopback prefix and refuses existing files outside it” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: rejects malformed URL encodings and continues serving requests

- **B1:** AGENTS.md secure HTTP boundaries and visible errors independently specifies this case: “rejects malformed URL encodings and continues serving requests”.
- **B2:** A caller-visible violation of “rejects malformed URL encodings and continues serving requests” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: outside-root canary files and malformed URI bytes; explicit denial and subsequent successful request. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes real loopback HTTP measurement server. Non-test consumers: mg-bundles text measure during bundle build.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “rejects malformed URL encodings and continues serving requests” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.


## apps/engine/test/mg.test.ts

Owner/caller evidence: mg service and jobs/routes used by editor and MCP. Independent sources: native motion graphics public render/jobs protocol; AGENTS.md graceful failures.

Validation planned: `pnpm exec vitest run apps/engine/test/mg.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### KEEP: degrades gracefully: TS catalog flagged native:false, render → 503 MG_UNAVAILABLE

- **B1:** native motion graphics public render/jobs protocol; AGENTS.md graceful failures independently specifies this case: “degrades gracefully: TS catalog flagged native:false, render → 503 MG_UNAVAILABLE”.
- **B2:** A caller-visible violation of “degrades gracefully: TS catalog flagged native:false, render → 503 MG_UNAVAILABLE” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: native ProRes metadata, alpha frame artifacts, input validation codes and cache equality under parameter permutation. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP capabilities/render/jobs and MgService validation/key. Non-test consumers: mg service and jobs/routes used by editor and MCP.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “degrades gracefully: TS catalog flagged native:false, render → 503 MG_UNAVAILABLE” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: validates requests and file names

- **B1:** native motion graphics public render/jobs protocol; AGENTS.md graceful failures independently specifies this case: “validates requests and file names”.
- **B2:** A caller-visible violation of “validates requests and file names” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: native ProRes metadata, alpha frame artifacts, input validation codes and cache equality under parameter permutation. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP capabilities/render/jobs and MgService validation/key. Non-test consumers: mg service and jobs/routes used by editor and MCP.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “validates requests and file names” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: renders lower-third 1920x1080 @30 for 150 frames into a verified ProRes 4444 master

- **B1:** native motion graphics public render/jobs protocol; AGENTS.md graceful failures independently specifies this case: “renders lower-third 1920x1080 @30 for 150 frames into a verified ProRes 4444 master”.
- **B2:** A caller-visible violation of “renders lower-third 1920x1080 @30 for 150 frames into a verified ProRes 4444 master” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: native ProRes metadata, alpha frame artifacts, input validation codes and cache equality under parameter permutation. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP capabilities/render/jobs and MgService validation/key. Non-test consumers: mg service and jobs/routes used by editor and MCP.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “renders lower-third 1920x1080 @30 for 150 frames into a verified ProRes 4444 master” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: mg-render jobs are listed, cancelled and retried through /api/jobs (WP-3I)

- **B1:** native motion graphics public render/jobs protocol; AGENTS.md graceful failures independently specifies this case: “mg-render jobs are listed, cancelled and retried through /api/jobs (WP-3I)”.
- **B2:** A caller-visible violation of “mg-render jobs are listed, cancelled and retried through /api/jobs (WP-3I)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: native ProRes metadata, alpha frame artifacts, input validation codes and cache equality under parameter permutation. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP capabilities/render/jobs and MgService validation/key. Non-test consumers: mg service and jobs/routes used by editor and MCP.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “mg-render jobs are listed, cancelled and retried through /api/jobs (WP-3I)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: rejects invalid params with 400 and cancels running renders without leftovers

- **B1:** native motion graphics public render/jobs protocol; AGENTS.md graceful failures independently specifies this case: “rejects invalid params with 400 and cancels running renders without leftovers”.
- **B2:** A caller-visible violation of “rejects invalid params with 400 and cancels running renders without leftovers” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: native ProRes metadata, alpha frame artifacts, input validation codes and cache equality under parameter permutation. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP capabilities/render/jobs and MgService validation/key. Non-test consumers: mg service and jobs/routes used by editor and MCP.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “rejects invalid params with 400 and cancels running renders without leftovers” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: uses the TS registry to validate and keys renders deterministically

- **B1:** native motion graphics public render/jobs protocol; AGENTS.md graceful failures independently specifies this case: “uses the TS registry to validate and keys renders deterministically”.
- **B2:** A caller-visible violation of “uses the TS registry to validate and keys renders deterministically” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: native ProRes metadata, alpha frame artifacts, input validation codes and cache equality under parameter permutation. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP capabilities/render/jobs and MgService validation/key. Non-test consumers: mg service and jobs/routes used by editor and MCP.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “uses the TS registry to validate and keys renders deterministically” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.


## apps/engine/test/native-animated.test.ts

Owner/caller evidence: export/keyframed.ts/native.ts/service.ts. Independent sources: docs/wp-notes/native-animated-export.md S03 ENG-032/FX-040 tolerances and subpixel regressions.

Validation planned: `pnpm exec vitest run apps/engine/test/native-animated.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### REWRITE: stays within tolerance, keeps holds exact and grows with the curve, not the clip length

Change: Keep approximation tolerance/hold and bounded complexity; drop incidental expression-prefix assertions.

- **B1:** docs/wp-notes/native-animated-export.md S03 ENG-032/FX-040 tolerances and subpixel regressions independently specifies this case: “stays within tolerance, keeps holds exact and grows with the curve, not the clip length”.
- **B2:** A caller-visible violation of “stays within tolerance, keeps holds exact and grows with the curve, not the clip length” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: independent tolerance math/known motion/linear gain curves and browser-vs-native frame oracles. Keep approximation tolerance/hold and bounded complexity; drop incidental expression-prefix assertions.
- **B4:** Observes fitPieces numerical approximation, export HTTP plan and rendered video/audio. Non-test consumers: export/keyframed.ts/native.ts/service.ts.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “stays within tolerance, keeps holds exact and grows with the curve, not the clip length” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### REWRITE: keyframed Motion, Opacity and crop edges plan native without the warp stage; blur, pan stay blocked

Change: Keep HTTP plan contract and drop private graph/warp collaborator shape.

- **B1:** docs/wp-notes/native-animated-export.md S03 ENG-032/FX-040 tolerances and subpixel regressions independently specifies this case: “keyframed Motion, Opacity and crop edges plan native without the warp stage; blur, pan stay blocked”.
- **B2:** A caller-visible violation of “keyframed Motion, Opacity and crop edges plan native without the warp stage; blur, pan stay blocked” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: independent tolerance math/known motion/linear gain curves and browser-vs-native frame oracles. Keep HTTP plan contract and drop private graph/warp collaborator shape.
- **B4:** Observes fitPieces numerical approximation, export HTTP plan and rendered video/audio. Non-test consumers: export/keyframed.ts/native.ts/service.ts.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “keyframed Motion, Opacity and crop edges plan native without the warp stage; blur, pan stay blocked” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### REWRITE: every sampled frame matches the evaluated layer: corners ≤ 0.1 px (sub-pixel), colour ≤ 8/255; LGPL filters only

Change: Keep decoded corner/colour fidelity and the external FFmpeg LGPL filter prohibition; drop private pipe/stream-count inventories.

- **B1:** docs/wp-notes/native-animated-export.md S03 ENG-032/FX-040 tolerances and subpixel regressions independently specifies this case: “every sampled frame matches the evaluated layer: corners ≤ 0.1 px (sub-pixel), colour ≤ 8/255; LGPL filters only”.
- **B2:** A caller-visible violation of “every sampled frame matches the evaluated layer: corners ≤ 0.1 px (sub-pixel), colour ≤ 8/255; LGPL filters only” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: independent tolerance math/known motion/linear gain curves and browser-vs-native frame oracles. Keep decoded corner/colour fidelity and the external FFmpeg LGPL filter prohibition; drop private pipe/stream-count inventories.
- **B4:** Observes fitPieces numerical approximation, export HTTP plan and rendered video/audio. Non-test consumers: export/keyframed.ts/native.ts/service.ts.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “every sampled frame matches the evaluated layer: corners ≤ 0.1 px (sub-pixel), colour ≤ 8/255; LGPL filters only” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### REWRITE: keyframed crop edges with keyframed non-uniform scale: the visible rect follows the evaluated quad (≤ 0.1 px)

Change: remove the shared implementation oracle as detailed in the final independent-oracle rescan below.

- **B1:** docs/wp-notes/native-animated-export.md S03 ENG-032/FX-040 tolerances and subpixel regressions independently specifies this case: “keyframed crop edges with keyframed non-uniform scale: the visible rect follows the evaluated quad (≤ 0.1 px)”.
- **B2:** A caller-visible violation of “keyframed crop edges with keyframed non-uniform scale: the visible rect follows the evaluated quad (≤ 0.1 px)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: independent tolerance math/known motion/linear gain curves and browser-vs-native frame oracles. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes fitPieces numerical approximation, export HTTP plan and rendered video/audio. Non-test consumers: export/keyframed.ts/native.ts/service.ts.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “keyframed crop edges with keyframed non-uniform scale: the visible rect follows the evaluated quad (≤ 0.1 px)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### DELETE: the layer kernel moves edges continuously at any scale (drawn frames, no ffmpeg): ≤ 0.01 px RMS

Detectable failure before removal: the expectation named “the layer kernel moves edges continuously at any scale (drawn frames, no ffmpeg): ≤ 0.01 px RMS”. Disposition: Direct kernel/private stream graph scenario duplicates real sampled video/crop and 300-frame fractional-pan regressions. Non-test seam consumers: export/keyframed.ts/native.ts/service.ts; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.

### REWRITE: a 0.05 px/frame pan over 300 frames moves smoothly: per-frame centroid ≤ 0.05 px RMS from the evaluated motion, monotonic, no jumps

Change: Use prescribed fractional-pan equation instead of resolving expected position through production.

- **B1:** docs/wp-notes/native-animated-export.md S03 ENG-032/FX-040 tolerances and subpixel regressions independently specifies this case: “a 0.05 px/frame pan over 300 frames moves smoothly: per-frame centroid ≤ 0.05 px RMS from the evaluated motion, monotonic, no jumps”.
- **B2:** A caller-visible violation of “a 0.05 px/frame pan over 300 frames moves smoothly: per-frame centroid ≤ 0.05 px RMS from the evaluated motion, monotonic, no jumps” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: independent tolerance math/known motion/linear gain curves and browser-vs-native frame oracles. Use prescribed fractional-pan equation instead of resolving expected position through production.
- **B4:** Observes fitPieces numerical approximation, export HTTP plan and rendered video/audio. Non-test consumers: export/keyframed.ts/native.ts/service.ts.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “a 0.05 px/frame pan over 300 frames moves smoothly: per-frame centroid ≤ 0.05 px RMS from the evaluated motion, monotonic, no jumps” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### REWRITE: clip, track and master volume keyframes are applied per sample (≤ 0.05 dB)

Change: Use independent linear gain arithmetic and decoded PCM rather than production evaluate for the expected gain.

- **B1:** docs/wp-notes/native-animated-export.md S03 ENG-032/FX-040 tolerances and subpixel regressions independently specifies this case: “clip, track and master volume keyframes are applied per sample (≤ 0.05 dB)”.
- **B2:** A caller-visible violation of “clip, track and master volume keyframes are applied per sample (≤ 0.05 dB)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: independent tolerance math/known motion/linear gain curves and browser-vs-native frame oracles. Use independent linear gain arithmetic and decoded PCM rather than production evaluate for the expected gain.
- **B4:** Observes fitPieces numerical approximation, export HTTP plan and rendered video/audio. Non-test consumers: export/keyframed.ts/native.ts/service.ts.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “clip, track and master volume keyframes are applied per sample (≤ 0.05 dB)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### DELETE: lossless stills of the keyframed card (native PNG vs Remotion renderStill PNG): SSIM, corners

Detectable failure before removal: the expectation named “lossless stills of the keyframed card (native PNG vs Remotion renderStill PNG): SSIM, corners”. Disposition: Private-casts ExportService.remotionProps to repeat stronger whole-video native/Remotion parity. Non-test seam consumers: export/keyframed.ts/native.ts/service.ts; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.

### REWRITE: every frame of the keyframed card: SSIM ≥ 0.98 (FX-040), like a static layer of the M1 native path

Change: Keep every-frame animated renderer parity; drop the extra static scenario already owned by golden parity.

- **B1:** docs/wp-notes/native-animated-export.md S03 ENG-032/FX-040 tolerances and subpixel regressions independently specifies this case: “every frame of the keyframed card: SSIM ≥ 0.98 (FX-040), like a static layer of the M1 native path”.
- **B2:** A caller-visible violation of “every frame of the keyframed card: SSIM ≥ 0.98 (FX-040), like a static layer of the M1 native path” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: independent tolerance math/known motion/linear gain curves and browser-vs-native frame oracles. Keep every-frame animated renderer parity; drop the extra static scenario already owned by golden parity.
- **B4:** Observes fitPieces numerical approximation, export HTTP plan and rendered video/audio. Non-test consumers: export/keyframed.ts/native.ts/service.ts.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “every frame of the keyframed card: SSIM ≥ 0.98 (FX-040), like a static layer of the M1 native path” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### DELETE: times the auto (native) path and, with NATIVE_ANIM_BENCH_REMOTION=1, the Remotion path

Detectable failure before removal: the expectation named “times the auto (native) path and, with NATIVE_ANIM_BENCH_REMOTION=1, the Remotion path”. Disposition: Benchmark reports times without a regression threshold; assertion-free performance probe, not a correctness contract. Non-test seam consumers: export/keyframed.ts/native.ts/service.ts; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.


## apps/engine/test/processing-range.test.ts

Owner/caller evidence: processing service and media registry. Independent sources: docs/specs/07-clip-processing.md source ranges and managed versions; AGENTS.md no data loss.

Validation planned: `pnpm exec vitest run apps/engine/test/processing-range.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### KEEP: processes exactly the source frames [12, 48): result range, registry record, frame-exact content

- **B1:** docs/specs/07-clip-processing.md source ranges and managed versions; AGENTS.md no data loss independently specifies this case: “processes exactly the source frames [12, 48): result range, registry record, frame-exact content”.
- **B2:** A caller-visible violation of “processes exactly the source frames [12, 48): result range, registry record, frame-exact content” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: numbered source frames, recorded ranges and original/user file bytes. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes processing jobs, registry and exported media. Non-test consumers: processing service and media registry.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “processes exactly the source frames [12, 48): result range, registry record, frame-exact content” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: a clip swapped onto the ranged version exports the same source frames on the native path, and back

- **B1:** docs/specs/07-clip-processing.md source ranges and managed versions; AGENTS.md no data loss independently specifies this case: “a clip swapped onto the ranged version exports the same source frames on the native path, and back”.
- **B2:** A caller-visible violation of “a clip swapped onto the ranged version exports the same source frames on the native path, and back” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: numbered source frames, recorded ranges and original/user file bytes. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes processing jobs, registry and exported media. Non-test consumers: processing service and media registry.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “a clip swapped onto the ranged version exports the same source frames on the native path, and back” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: reports the sidecar next to a file registered by path (trailer grade format)

- **B1:** docs/specs/07-clip-processing.md source ranges and managed versions; AGENTS.md no data loss independently specifies this case: “reports the sidecar next to a file registered by path (trailer grade format)”.
- **B2:** A caller-visible violation of “reports the sidecar next to a file registered by path (trailer grade format)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: numbered source frames, recorded ranges and original/user file bytes. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes processing jobs, registry and exported media. Non-test consumers: processing service and media registry.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “reports the sidecar next to a file registered by path (trailer grade format)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: deletes only the managed copy and registry record when no project uses it

- **B1:** docs/specs/07-clip-processing.md source ranges and managed versions; AGENTS.md no data loss independently specifies this case: “deletes only the managed copy and registry record when no project uses it”.
- **B2:** A caller-visible violation of “deletes only the managed copy and registry record when no project uses it” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: numbered source frames, recorded ranges and original/user file bytes. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes processing jobs, registry and exported media. Non-test consumers: processing service and media registry.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “deletes only the managed copy and registry record when no project uses it” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: never deletes the user's own files, processed versions or media a stored project uses

- **B1:** docs/specs/07-clip-processing.md source ranges and managed versions; AGENTS.md no data loss independently specifies this case: “never deletes the user's own files, processed versions or media a stored project uses”.
- **B2:** A caller-visible violation of “never deletes the user's own files, processed versions or media a stored project uses” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: numbered source frames, recorded ranges and original/user file bytes. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes processing jobs, registry and exported media. Non-test consumers: processing service and media registry.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “never deletes the user's own files, processed versions or media a stored project uses” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.


## apps/engine/test/processing-remote.test.ts

Owner/caller evidence: processing/remote.ts and processing job service. Independent sources: docs/specs/07-clip-processing.md remote executor; AGENTS.md cancellation and failure propagation.

Validation planned: `pnpm exec vitest run apps/engine/test/processing-remote.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### KEEP: probe before setup reports the runtime is not installed

- **B1:** docs/specs/07-clip-processing.md remote executor; AGENTS.md cancellation and failure propagation independently specifies this case: “probe before setup reports the runtime is not installed”.
- **B2:** A caller-visible violation of “probe before setup reports the runtime is not installed” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: real shell scripts, input/output bytes and process/job directory lifetime; transport shim does not implement transformation. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes SSH setup/probe/process transport and jobs. Non-test consumers: processing/remote.ts and processing job service.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “probe before setup reports the runtime is not installed” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: setup installs an executable runtime that the probe reports ready

- **B1:** docs/specs/07-clip-processing.md remote executor; AGENTS.md cancellation and failure propagation independently specifies this case: “setup installs an executable runtime that the probe reports ready”.
- **B2:** A caller-visible violation of “setup installs an executable runtime that the probe reports ready” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: real shell scripts, input/output bytes and process/job directory lifetime; transport shim does not implement transformation. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes SSH setup/probe/process transport and jobs. Non-test consumers: processing/remote.ts and processing job service.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “setup installs an executable runtime that the probe reports ready” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: auto executor runs remotely; the input is cached by fingerprint; the job dir is removed

- **B1:** docs/specs/07-clip-processing.md remote executor; AGENTS.md cancellation and failure propagation independently specifies this case: “auto executor runs remotely; the input is cached by fingerprint; the job dir is removed”.
- **B2:** A caller-visible violation of “auto executor runs remotely; the input is cached by fingerprint; the job dir is removed” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: real shell scripts, input/output bytes and process/job directory lifetime; transport shim does not implement transformation. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes SSH setup/probe/process transport and jobs. Non-test consumers: processing/remote.ts and processing job service.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “auto executor runs remotely; the input is cached by fingerprint; the job dir is removed” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: an interrupted upload retries to the exact source bytes without leaving a partial file

- **B1:** docs/specs/07-clip-processing.md remote executor; AGENTS.md cancellation and failure propagation independently specifies this case: “an interrupted upload retries to the exact source bytes without leaving a partial file”.
- **B2:** A caller-visible violation of “an interrupted upload retries to the exact source bytes without leaving a partial file” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: real shell scripts, input/output bytes and process/job directory lifetime; transport shim does not implement transformation. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes SSH setup/probe/process transport and jobs. Non-test consumers: processing/remote.ts and processing job service.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “an interrupted upload retries to the exact source bytes without leaving a partial file” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: cancel kills the remote process group and leaves no job directory

- **B1:** docs/specs/07-clip-processing.md remote executor; AGENTS.md cancellation and failure propagation independently specifies this case: “cancel kills the remote process group and leaves no job directory”.
- **B2:** A caller-visible violation of “cancel kills the remote process group and leaves no job directory” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: real shell scripts, input/output bytes and process/job directory lifetime; transport shim does not implement transformation. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes SSH setup/probe/process transport and jobs. Non-test consumers: processing/remote.ts and processing job service.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “cancel kills the remote process group and leaves no job directory” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: a broken connection fails with REMOTE_CONNECTION_LOST (retryable), never falls back to local

- **B1:** docs/specs/07-clip-processing.md remote executor; AGENTS.md cancellation and failure propagation independently specifies this case: “a broken connection fails with REMOTE_CONNECTION_LOST (retryable), never falls back to local”.
- **B2:** A caller-visible violation of “a broken connection fails with REMOTE_CONNECTION_LOST (retryable), never falls back to local” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: real shell scripts, input/output bytes and process/job directory lifetime; transport shim does not implement transformation. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes SSH setup/probe/process transport and jobs. Non-test consumers: processing/remote.ts and processing job service.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “a broken connection fails with REMOTE_CONNECTION_LOST (retryable), never falls back to local” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: probe, setup, process, cleanup

- **B1:** docs/specs/07-clip-processing.md remote executor; AGENTS.md cancellation and failure propagation independently specifies this case: “probe, setup, process, cleanup”.
- **B2:** A caller-visible violation of “probe, setup, process, cleanup” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: real shell scripts, input/output bytes and process/job directory lifetime; transport shim does not implement transformation. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes SSH setup/probe/process transport and jobs. Non-test consumers: processing/remote.ts and processing job service.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “probe, setup, process, cleanup” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.


## apps/engine/test/remotion-lgpl.e2e.test.ts

Owner/caller evidence: RemotionService and export/service.ts. Independent sources: AGENTS.md LGPL FFmpeg rule and Remotion public export contract.

Validation planned: `pnpm exec vitest run apps/engine/test/remotion-lgpl.e2e.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### KEEP: reports the LGPL directory in /api/capabilities (strict mode accepts it)

- **B1:** AGENTS.md LGPL FFmpeg rule and Remotion public export contract independently specifies this case: “reports the LGPL directory in /api/capabilities (strict mode accepts it)”.
- **B2:** A caller-visible violation of “reports the LGPL directory in /api/capabilities (strict mode accepts it)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: FFprobe codec/container/audio metadata from independent executable. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP capabilities and real Remotion encoded artifacts. Non-test consumers: RemotionService and export/service.ts.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “reports the LGPL directory in /api/capabilities (strict mode accepts it)” at the above seam. Other compositor suites own isolated blend modes; this case owns complete engine-produced artifacts.
Risk: medium; external rendering/tooling must be available to validate the artifact. Validation: the focused command above, then engine typecheck and root repository gates.

### DELETE: its ffmpeg is an LGPL build (no --enable-gpl / --enable-nonfree / x264)

Detectable failure before removal: the expectation named “its ffmpeg is an LGPL build (no --enable-gpl / --enable-nonfree / x264)”. Disposition: Rechecks vendor binary configuration outside production owner; pnpm ffmpeg:check owns manifest/license/build compliance. Non-test seam consumers: RemotionService and export/service.ts; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.

### KEEP: exports H.264 via a Remotion ProRes intermediate encoded with OpenH264

- **B1:** AGENTS.md LGPL FFmpeg rule and Remotion public export contract independently specifies this case: “exports H.264 via a Remotion ProRes intermediate encoded with OpenH264”.
- **B2:** A caller-visible violation of “exports H.264 via a Remotion ProRes intermediate encoded with OpenH264” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: FFprobe codec/container/audio metadata from independent executable. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP capabilities and real Remotion encoded artifacts. Non-test consumers: RemotionService and export/service.ts.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “exports H.264 via a Remotion ProRes intermediate encoded with OpenH264” at the above seam. Other compositor suites own isolated blend modes; this case owns complete engine-produced artifacts.
Risk: medium; external rendering/tooling must be available to validate the artifact. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: exports VP9/Opus WebM directly through Remotion

- **B1:** AGENTS.md LGPL FFmpeg rule and Remotion public export contract independently specifies this case: “exports VP9/Opus WebM directly through Remotion”.
- **B2:** A caller-visible violation of “exports VP9/Opus WebM directly through Remotion” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: FFprobe codec/container/audio metadata from independent executable. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes HTTP capabilities and real Remotion encoded artifacts. Non-test consumers: RemotionService and export/service.ts.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “exports VP9/Opus WebM directly through Remotion” at the above seam. Other compositor suites own isolated blend modes; this case owns complete engine-produced artifacts.
Risk: medium; external rendering/tooling must be available to validate the artifact. Validation: the focused command above, then engine typecheck and root repository gates.

### DELETE: renders a still through the LGPL compositor

Detectable failure before removal: the expectation named “renders a still through the LGPL compositor”. Disposition: Only MIME and PNG magic, no visual oracle; actual still image/alpha/grade/golden regressions are stronger. Non-test seam consumers: RemotionService and export/service.ts; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.


## apps/engine/test/remotion-retry.test.ts

Cross-review correction, recorded before follow-up editing: `docs/verification.md` §8 #5 and its remaining-limit note specify recovery after concurrent software-GL render timeout. A successful first render does not cover this failure, so the original DELETE disposition was incorrect. Rewrite through `RemotionService.renderMedia`, which `export/service.ts` calls in production. The external `@remotion/renderer` SDK supplies controlled failures; the real service owns retry decisions and error mapping. `withSinglePageRetry` stays private.

Isolated failure modes: no retry after an overloaded concurrent render; retry still using overloaded concurrency; unbounded retries after repeated timeout; retrying an unrelated rendering failure; retrying a render already limited to one page; ignoring cancellation arriving during the failed render. No actual browser or encoder is needed to induce these SDK-boundary failures.

Validation planned: `pnpm exec vitest run apps/engine/test/remotion-retry.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck` when root schedules the slot.

### REWRITE: a timeout on several pages is retried once on one page, and logged

New name: `recovers a concurrent renderer timeout through the public render operation`.

- **B1:** `docs/verification.md` §8 #5 explicitly requires one-page recovery for heavy concurrent compositions on software GL.
- **B2:** A caller whose renderer times out with parallel pages must receive a completed render result; removing recovery or keeping excessive concurrency makes this call reject.
- **B3:** The external renderer refuses concurrent work and accepts one-page work. It does not implement retries. The service must recover; a fixed 30-frame composition supplies independently arranged result metadata.
- **B4:** Calls public `RemotionService.renderMedia` with real prebuilt-bundle configuration; mocks only the third-party renderer SDK boundary.
- **B5:** The retry helper can be renamed, inlined or replaced. No log wording, private members or call count is asserted.
- **B6:** This is the lowest service boundary that owns recovery from SDK failure. The static-layer video test owns successful composition output and cannot force this failure mode.

Risk: low; only test orchestration changes. Validation: focused retry suite and engine typecheck.

### REWRITE: a second timeout fails with the typed error

New name: `reports RENDER_TIMEOUT after the recovery attempt also times out`.

- **B1:** The same documented recovery is bounded to one additional attempt; AGENTS.md requires typed engine errors rather than a hanging job.
- **B2:** A repeated timeout must reject with retryable `RENDER_TIMEOUT`. Unlimited retry or loss of error mapping changes the caller-visible result.
- **B3:** The renderer dependency fails twice, then would succeed. Expecting rejection is independent of the service implementation and catches an unauthorized third attempt without asserting counts.
- **B4:** Uses public `renderMedia`; no access to the private retry function.
- **B5:** Any implementation preserving the bounded outcome and typed error passes, regardless of logging/helper structure.
- **B6:** No successful-render or first-timeout recovery case proves terminal repeated-timeout behavior; this service owns the mapping.

Risk: low. Validation: focused retry suite and engine typecheck.

### REWRITE: no retry for other errors, a single page or a cancelled render

Named public-boundary cases: unrelated failure → `RENDER_FAILED`; one-page timeout → `RENDER_TIMEOUT`; cancellation during render failure → `JOB_CANCELLED`.

- **B1:** Recovery is specified only for concurrency-induced timeout, and AGENTS.md requires cancellation/failure propagation into the job.
- **B2:** Each call must reject with its exact engine error code. Returning success after an inappropriate retry or reporting timeout instead of cancellation fails.
- **B3:** Each SDK fault is followed by a hypothetical success, so retrying incorrectly cannot pass the negative test. Cancellation is triggered inside the renderer call, ensuring it is not rejected earlier during setup for the wrong reason.
- **B4:** Calls public `renderMedia`, supplies an AbortSignal and faults only the external renderer dependency.
- **B5:** No private callback shape, log text or retry call count is observed; stable result/error behavior survives refactors.
- **B6:** These are three distinct negative preconditions of the service recovery policy; ordinary render success and the two timeout cases above do not cover them.

Risk: low. Validation: focused retry suite and engine typecheck.

## apps/engine/test/smoothpath.test.ts

Owner/caller evidence: processing/proc/runner.ts and smoothpath step. Independent sources: docs/specs/07-clip-processing.md and docs/wp-notes/sim-warp.md stabilization.

Validation planned: `pnpm exec vitest run apps/engine/test/smoothpath.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### KEEP: tracks the background (not the subject), evens out the reframe within the zoom cap

- **B1:** docs/specs/07-clip-processing.md and docs/wp-notes/sim-warp.md stabilization independently specifies this case: “tracks the background (not the subject), evens out the reframe within the zoom cap”.
- **B2:** A caller-visible violation of “tracks the background (not the subject), evens out the reframe within the zoom cap” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: known background/subject paths, zoom cap and independent WASM/OpenCV kernel comparison. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes real processing runner and decoded output/report. Non-test consumers: processing/proc/runner.ts and smoothpath step.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “tracks the background (not the subject), evens out the reframe within the zoom cap” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: reports fallback and releases locks when the cap is too small

- **B1:** docs/specs/07-clip-processing.md and docs/wp-notes/sim-warp.md stabilization independently specifies this case: “reports fallback and releases locks when the cap is too small”.
- **B2:** A caller-visible violation of “reports fallback and releases locks when the cap is too small” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: known background/subject paths, zoom cap and independent WASM/OpenCV kernel comparison. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes real processing runner and decoded output/report. Non-test consumers: processing/proc/runner.ts and smoothpath step.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “reports fallback and releases locks when the cap is too small” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: warps the same with the vid.stab WASM kernel and the OpenCV.js fallback

- **B1:** docs/specs/07-clip-processing.md and docs/wp-notes/sim-warp.md stabilization independently specifies this case: “warps the same with the vid.stab WASM kernel and the OpenCV.js fallback”.
- **B2:** A caller-visible violation of “warps the same with the vid.stab WASM kernel and the OpenCV.js fallback” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: known background/subject paths, zoom cap and independent WASM/OpenCV kernel comparison. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes real processing runner and decoded output/report. Non-test consumers: processing/proc/runner.ts and smoothpath step.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “warps the same with the vid.stab WASM kernel and the OpenCV.js fallback” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: a shot with a cut is stabilised per segment (own path and zoom), the cut found by the de-judder guard

- **B1:** docs/specs/07-clip-processing.md and docs/wp-notes/sim-warp.md stabilization independently specifies this case: “a shot with a cut is stabilised per segment (own path and zoom), the cut found by the de-judder guard”.
- **B2:** A caller-visible violation of “a shot with a cut is stabilised per segment (own path and zoom), the cut found by the de-judder guard” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: known background/subject paths, zoom cap and independent WASM/OpenCV kernel comparison. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes real processing runner and decoded output/report. Non-test consumers: processing/proc/runner.ts and smoothpath step.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “a shot with a cut is stabilised per segment (own path and zoom), the cut found by the de-judder guard” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.


## apps/engine/test/speech-core.test.ts

Owner/caller evidence: speech worker imports mel/VAD/diarize/align/decode/tokenizer. Independent sources: docs/wp-notes/speech.md front end, VAD, diarization and Whisper protocol; licenses/ported/speech.md.

Validation planned: `pnpm exec vitest run apps/engine/test/speech-core.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### REWRITE: filterbank shape and coverage; Slaney scale

Change recorded before edit: use Whisper protocol dimensions (80 × 201) and independent Slaney endpoints 15 mel = 1 kHz and 42 mel = 6.4 kHz; remove the production conversion/inverse roundtrip.

- **B1:** docs/wp-notes/speech.md front end, VAD, diarization and Whisper protocol; licenses/ported/speech.md independently specifies this case: “filterbank shape and coverage; Slaney scale”.
- **B2:** A caller-visible violation of “filterbank shape and coverage; Slaney scale” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: fixed signal/token/attention fixtures and direct DFT, prescribed threshold/timestamp/edit-distance arithmetic. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes speech worker numerical/model-input and transcript timing APIs. Non-test consumers: speech worker imports mel/VAD/diarize/align/decode/tokenizer.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “filterbank shape and coverage; Slaney scale” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### REWRITE: a tone lands in its band

Change: Use independently derived 1 kHz Slaney band index 26; do not derive expected band with production melFilters.

- **B1:** docs/wp-notes/speech.md front end, VAD, diarization and Whisper protocol; licenses/ported/speech.md independently specifies this case: “a tone lands in its band”.
- **B2:** A caller-visible violation of “a tone lands in its band” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: fixed signal/token/attention fixtures and direct DFT, prescribed threshold/timestamp/edit-distance arithmetic. Use independently derived 1 kHz Slaney band index 26; do not derive expected band with production melFilters.
- **B4:** Observes speech worker numerical/model-input and transcript timing APIs. Non-test consumers: speech worker imports mel/VAD/diarize/align/decode/tokenizer.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “a tone lands in its band” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### REWRITE: the mixed-radix FFT equals a direct DFT

Change: remove the shared implementation oracle as detailed in the final independent-oracle rescan below.

- **B1:** docs/wp-notes/speech.md front end, VAD, diarization and Whisper protocol; licenses/ported/speech.md independently specifies this case: “the mixed-radix FFT equals a direct DFT”.
- **B2:** A caller-visible violation of “the mixed-radix FFT equals a direct DFT” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: fixed signal/token/attention fixtures and direct DFT, prescribed threshold/timestamp/edit-distance arithmetic. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes speech worker numerical/model-input and transcript timing APIs. Non-test consumers: speech worker imports mel/VAD/diarize/align/decode/tokenizer.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “the mixed-radix FFT equals a direct DFT” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: silence is trimmed from words

- **B1:** docs/wp-notes/speech.md front end, VAD, diarization and Whisper protocol; licenses/ported/speech.md independently specifies this case: “silence is trimmed from words”.
- **B2:** A caller-visible violation of “silence is trimmed from words” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: fixed signal/token/attention fixtures and direct DFT, prescribed threshold/timestamp/edit-distance arithmetic. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes speech worker numerical/model-input and transcript timing APIs. Non-test consumers: speech worker imports mel/VAD/diarize/align/decode/tokenizer.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “silence is trimmed from words” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: threshold: 30 % from floor to speech, at least 6 dB above the floor; digital silence ignored

- **B1:** docs/wp-notes/speech.md front end, VAD, diarization and Whisper protocol; licenses/ported/speech.md independently specifies this case: “threshold: 30 % from floor to speech, at least 6 dB above the floor; digital silence ignored”.
- **B2:** A caller-visible violation of “threshold: 30 % from floor to speech, at least 6 dB above the floor; digital silence ignored” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: fixed signal/token/attention fixtures and direct DFT, prescribed threshold/timestamp/edit-distance arithmetic. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes speech worker numerical/model-input and transcript timing APIs. Non-test consumers: speech worker imports mel/VAD/diarize/align/decode/tokenizer.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “threshold: 30 % from floor to speech, at least 6 dB above the floor; digital silence ignored” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: a word keeps at least 60 ms and unvoiced words are left alone

- **B1:** docs/wp-notes/speech.md front end, VAD, diarization and Whisper protocol; licenses/ported/speech.md independently specifies this case: “a word keeps at least 60 ms and unvoiced words are left alone”.
- **B2:** A caller-visible violation of “a word keeps at least 60 ms and unvoiced words are left alone” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: fixed signal/token/attention fixtures and direct DFT, prescribed threshold/timestamp/edit-distance arithmetic. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes speech worker numerical/model-input and transcript timing APIs. Non-test consumers: speech worker imports mel/VAD/diarize/align/decode/tokenizer.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “a word keeps at least 60 ms and unvoiced words are left alone” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: extends early-ending / late-starting words into the voice beside a pause, never into a neighbour

- **B1:** docs/wp-notes/speech.md front end, VAD, diarization and Whisper protocol; licenses/ported/speech.md independently specifies this case: “extends early-ending / late-starting words into the voice beside a pause, never into a neighbour”.
- **B2:** A caller-visible violation of “extends early-ending / late-starting words into the voice beside a pause, never into a neighbour” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: fixed signal/token/attention fixtures and direct DFT, prescribed threshold/timestamp/edit-distance arithmetic. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes speech worker numerical/model-input and transcript timing APIs. Non-test consumers: speech worker imports mel/VAD/diarize/align/decode/tokenizer.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “extends early-ending / late-starting words into the voice beside a pause, never into a neighbour” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: repairs a word straddling a pause and moves a word found in silence onto unassigned voice

- **B1:** docs/wp-notes/speech.md front end, VAD, diarization and Whisper protocol; licenses/ported/speech.md independently specifies this case: “repairs a word straddling a pause and moves a word found in silence onto unassigned voice”.
- **B2:** A caller-visible violation of “repairs a word straddling a pause and moves a word found in silence onto unassigned voice” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: fixed signal/token/attention fixtures and direct DFT, prescribed threshold/timestamp/edit-distance arithmetic. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes speech worker numerical/model-input and transcript timing APIs. Non-test consumers: speech worker imports mel/VAD/diarize/align/decode/tokenizer.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “repairs a word straddling a pause and moves a word found in silence onto unassigned voice” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: endOfVoice stops at the first silent frame or the limit

- **B1:** docs/wp-notes/speech.md front end, VAD, diarization and Whisper protocol; licenses/ported/speech.md independently specifies this case: “endOfVoice stops at the first silent frame or the limit”.
- **B2:** A caller-visible violation of “endOfVoice stops at the first silent frame or the limit” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: fixed signal/token/attention fixtures and direct DFT, prescribed threshold/timestamp/edit-distance arithmetic. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes speech worker numerical/model-input and transcript timing APIs. Non-test consumers: speech worker imports mel/VAD/diarize/align/decode/tokenizer.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “endOfVoice stops at the first silent frame or the limit” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: two synthetic voices are told apart

- **B1:** docs/wp-notes/speech.md front end, VAD, diarization and Whisper protocol; licenses/ported/speech.md independently specifies this case: “two synthetic voices are told apart”.
- **B2:** A caller-visible violation of “two synthetic voices are told apart” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: fixed signal/token/attention fixtures and direct DFT, prescribed threshold/timestamp/edit-distance arithmetic. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes speech worker numerical/model-input and transcript timing APIs. Non-test consumers: speech worker imports mel/VAD/diarize/align/decode/tokenizer.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “two synthetic voices are told apart” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: one voice is one speaker

- **B1:** docs/wp-notes/speech.md front end, VAD, diarization and Whisper protocol; licenses/ported/speech.md independently specifies this case: “one voice is one speaker”.
- **B2:** A caller-visible violation of “one voice is one speaker” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: fixed signal/token/attention fixtures and direct DFT, prescribed threshold/timestamp/edit-distance arithmetic. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes speech worker numerical/model-input and transcript timing APIs. Non-test consumers: speech worker imports mel/VAD/diarize/align/decode/tokenizer.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “one voice is one speaker” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: chunks split at pauses and join short ones

- **B1:** docs/wp-notes/speech.md front end, VAD, diarization and Whisper protocol; licenses/ported/speech.md independently specifies this case: “chunks split at pauses and join short ones”.
- **B2:** A caller-visible violation of “chunks split at pauses and join short ones” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: fixed signal/token/attention fixtures and direct DFT, prescribed threshold/timestamp/edit-distance arithmetic. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes speech worker numerical/model-input and transcript timing APIs. Non-test consumers: speech worker imports mel/VAD/diarize/align/decode/tokenizer.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “chunks split at pauses and join short ones” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: a speaker-count hint forces exactly that many speakers

- **B1:** docs/wp-notes/speech.md front end, VAD, diarization and Whisper protocol; licenses/ported/speech.md independently specifies this case: “a speaker-count hint forces exactly that many speakers”.
- **B2:** A caller-visible violation of “a speaker-count hint forces exactly that many speakers” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: fixed signal/token/attention fixtures and direct DFT, prescribed threshold/timestamp/edit-distance arithmetic. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes speech worker numerical/model-input and transcript timing APIs. Non-test consumers: speech worker imports mel/VAD/diarize/align/decode/tokenizer.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “a speaker-count hint forces exactly that many speakers” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### DELETE: median filter removes spikes

Detectable failure before removal: the expectation named “median filter removes spikes”. Disposition: Intermediate median helper output only; known-attention alignTokens owns caller-visible token timing. Non-test seam consumers: speech worker imports mel/VAD/diarize/align/decode/tokenizer; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.

### DELETE: DTW follows the cheap diagonal band

Detectable failure before removal: the expectation named “DTW follows the cheap diagonal band”. Disposition: Intermediate DTW path shape only; known-attention alignment owns timing and survives an alignment algorithm refactor. Non-test seam consumers: speech worker imports mel/VAD/diarize/align/decode/tokenizer; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.

### KEEP: alignTokens finds where each token attends

- **B1:** docs/wp-notes/speech.md front end, VAD, diarization and Whisper protocol; licenses/ported/speech.md independently specifies this case: “alignTokens finds where each token attends”.
- **B2:** A caller-visible violation of “alignTokens finds where each token attends” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: fixed signal/token/attention fixtures and direct DFT, prescribed threshold/timestamp/edit-distance arithmetic. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes speech worker numerical/model-input and transcript timing APIs. Non-test consumers: speech worker imports mel/VAD/diarize/align/decode/tokenizer.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “alignTokens finds where each token attends” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: word timings, punctuation merging and segment distribution

- **B1:** docs/wp-notes/speech.md front end, VAD, diarization and Whisper protocol; licenses/ported/speech.md independently specifies this case: “word timings, punctuation merging and segment distribution”.
- **B2:** A caller-visible violation of “word timings, punctuation merging and segment distribution” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: fixed signal/token/attention fixtures and direct DFT, prescribed threshold/timestamp/edit-distance arithmetic. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes speech worker numerical/model-input and transcript timing APIs. Non-test consumers: speech worker imports mel/VAD/diarize/align/decode/tokenizer.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “word timings, punctuation merging and segment distribution” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: reads specials, languages and bytes

- **B1:** docs/wp-notes/speech.md front end, VAD, diarization and Whisper protocol; licenses/ported/speech.md independently specifies this case: “reads specials, languages and bytes”.
- **B2:** A caller-visible violation of “reads specials, languages and bytes” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: fixed signal/token/attention fixtures and direct DFT, prescribed threshold/timestamp/edit-distance arithmetic. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes speech worker numerical/model-input and transcript timing APIs. Non-test consumers: speech worker imports mel/VAD/diarize/align/decode/tokenizer.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “reads specials, languages and bytes” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: timestamp rules: first token a timestamp ≤ max initial, monotonic, pairs

- **B1:** docs/wp-notes/speech.md front end, VAD, diarization and Whisper protocol; licenses/ported/speech.md independently specifies this case: “timestamp rules: first token a timestamp ≤ max initial, monotonic, pairs”.
- **B2:** A caller-visible violation of “timestamp rules: first token a timestamp ≤ max initial, monotonic, pairs” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: fixed signal/token/attention fixtures and direct DFT, prescribed threshold/timestamp/edit-distance arithmetic. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes speech worker numerical/model-input and transcript timing APIs. Non-test consumers: speech worker imports mel/VAD/diarize/align/decode/tokenizer.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “timestamp rules: first token a timestamp ≤ max initial, monotonic, pairs” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: segments and seek

- **B1:** docs/wp-notes/speech.md front end, VAD, diarization and Whisper protocol; licenses/ported/speech.md independently specifies this case: “segments and seek”.
- **B2:** A caller-visible violation of “segments and seek” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: fixed signal/token/attention fixtures and direct DFT, prescribed threshold/timestamp/edit-distance arithmetic. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes speech worker numerical/model-input and transcript timing APIs. Non-test consumers: speech worker imports mel/VAD/diarize/align/decode/tokenizer.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “segments and seek” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: repetition guard, compression ratio, seeded sampling

- **B1:** docs/wp-notes/speech.md front end, VAD, diarization and Whisper protocol; licenses/ported/speech.md independently specifies this case: “repetition guard, compression ratio, seeded sampling”.
- **B2:** A caller-visible violation of “repetition guard, compression ratio, seeded sampling” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: fixed signal/token/attention fixtures and direct DFT, prescribed threshold/timestamp/edit-distance arithmetic. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes speech worker numerical/model-input and transcript timing APIs. Non-test consumers: speech worker imports mel/VAD/diarize/align/decode/tokenizer.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “repetition guard, compression ratio, seeded sampling” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### DELETE: counts edits

Detectable failure before removal: changes to the WER scoring helper's punctuation normalization and edit-distance arithmetic. This helper has no production callers or public API; the test therefore fails bars B2 (caller-visible production failure), B4 (public/stable production seam) and B6 (keeps a test-only source seam alive). The real-model `speech-model.e2e.test.ts` cases retain recognition/timing acceptance against independently authored transcripts and measured boundaries.

Caller census: `wordErrorRate` was used only here and by the real-model test; `normalizeWord` had no external caller. Coordinated implementation in engine3 commit `0e8fee98` deleted this test/import, moved WER to `apps/engine/test/speech-wer.ts`, made normalization private and updated port attribution/notices. See [engine3 follow-up evidence](engine3-followup.md). This row is the authoritative disposition of the original engine1-assigned case; the supplement supplies implementation evidence and must not be counted as another deleted test.

Risk: no production behavior changes; only helper self-coverage is removed. Validation: source caller census, Biome, notices checks and diff review passed in engine3's follow-up; integrated speech execution/typecheck remain the root agent's responsibility. This report-only correction runs no runtime/build checks.


## apps/engine/test/unit.test.ts

Owner/caller evidence: media/probe/fingerprint, auth routes, SSE broadcaster, derivative service and startup. Independent sources: docs/specs/04-media-render-and-backend.md q1 identity, peaks and media metadata; AGENTS.md safe HTTP/config errors.

Validation planned: `pnpm exec vitest run apps/engine/test/unit.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### KEEP: ${name}: file agrees with the vector

Named cases: `empty`, `abc`, `8 MiB (whole file)`, `9 MiB (first+last 4 MiB)`. Python hashlib vectors independently distinguish the boundary and both fingerprint strategies.

- **B1:** docs/specs/04-media-render-and-backend.md q1 identity, peaks and media metadata; AGENTS.md safe HTTP/config errors independently specifies this case: “${name}: file agrees with the vector”.
- **B2:** A caller-visible violation of “${name}: file agrees with the vector” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: Python hashlib vectors, fixed byte/audio inputs, tampered signatures, ffprobe-style external metadata and literal codes. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes fingerprint/signing/broadcast/peaks/probe and HTTP configuration seams. Non-test consumers: media/probe/fingerprint, auth routes, SSE broadcaster, derivative service and startup.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “${name}: file agrees with the vector” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: media keys are mk_ + 24 hex of the fingerprint

- **B1:** docs/specs/04-media-render-and-backend.md q1 identity, peaks and media metadata; AGENTS.md safe HTTP/config errors independently specifies this case: “media keys are mk_ + 24 hex of the fingerprint”.
- **B2:** A caller-visible violation of “media keys are mk_ + 24 hex of the fingerprint” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: Python hashlib vectors, fixed byte/audio inputs, tampered signatures, ffprobe-style external metadata and literal codes. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes fingerprint/signing/broadcast/peaks/probe and HTTP configuration seams. Non-test consumers: media/probe/fingerprint, auth routes, SSE broadcaster, derivative service and startup.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “media keys are mk_ + 24 hex of the fingerprint” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: verifies path + expiry and rejects tampering

- **B1:** docs/specs/04-media-render-and-backend.md q1 identity, peaks and media metadata; AGENTS.md safe HTTP/config errors independently specifies this case: “verifies path + expiry and rejects tampering”.
- **B2:** A caller-visible violation of “verifies path + expiry and rejects tampering” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: Python hashlib vectors, fixed byte/audio inputs, tampered signatures, ffprobe-style external metadata and literal codes. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes fingerprint/signing/broadcast/peaks/probe and HTTP configuration seams. Non-test consumers: media/probe/fingerprint, auth routes, SSE broadcaster, derivative service and startup.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “verifies path + expiry and rejects tampering” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: reports incomplete replay when the bounded event buffer overflows

- **B1:** docs/specs/04-media-render-and-backend.md q1 identity, peaks and media metadata; AGENTS.md safe HTTP/config errors independently specifies this case: “reports incomplete replay when the bounded event buffer overflows”.
- **B2:** A caller-visible violation of “reports incomplete replay when the bounded event buffer overflows” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: Python hashlib vectors, fixed byte/audio inputs, tampered signatures, ffprobe-style external metadata and literal codes. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes fingerprint/signing/broadcast/peaks/probe and HTTP configuration seams. Non-test consumers: media/probe/fingerprint, auth routes, SSE broadcaster, derivative service and startup.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “reports incomplete replay when the bounded event buffer overflows” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: computes max-abs per channel and per window across chunk boundaries

- **B1:** docs/specs/04-media-render-and-backend.md q1 identity, peaks and media metadata; AGENTS.md safe HTTP/config errors independently specifies this case: “computes max-abs per channel and per window across chunk boundaries”.
- **B2:** A caller-visible violation of “computes max-abs per channel and per window across chunk boundaries” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: Python hashlib vectors, fixed byte/audio inputs, tampered signatures, ffprobe-style external metadata and literal codes. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes fingerprint/signing/broadcast/peaks/probe and HTTP configuration seams. Non-test consumers: media/probe/fingerprint, auth routes, SSE broadcaster, derivative service and startup.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “computes max-abs per channel and per window across chunk boundaries” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: reads legacy rotation tags when the display matrix is absent

- **B1:** docs/specs/04-media-render-and-backend.md q1 identity, peaks and media metadata; AGENTS.md safe HTTP/config errors independently specifies this case: “reads legacy rotation tags when the display matrix is absent”.
- **B2:** A caller-visible violation of “reads legacy rotation tags when the display matrix is absent” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: Python hashlib vectors, fixed byte/audio inputs, tampered signatures, ffprobe-style external metadata and literal codes. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes fingerprint/signing/broadcast/peaks/probe and HTTP configuration seams. Non-test consumers: media/probe/fingerprint, auth routes, SSE broadcaster, derivative service and startup.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “reads legacy rotation tags when the display matrix is absent” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: detects VFR and VP9 alpha metadata

- **B1:** docs/specs/04-media-render-and-backend.md q1 identity, peaks and media metadata; AGENTS.md safe HTTP/config errors independently specifies this case: “detects VFR and VP9 alpha metadata”.
- **B2:** A caller-visible violation of “detects VFR and VP9 alpha metadata” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: Python hashlib vectors, fixed byte/audio inputs, tampered signatures, ffprobe-style external metadata and literal codes. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes fingerprint/signing/broadcast/peaks/probe and HTTP configuration seams. Non-test consumers: media/probe/fingerprint, auth routes, SSE broadcaster, derivative service and startup.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “detects VFR and VP9 alpha metadata” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: maps ENOSPC to DISK_FULL, ENOENT to NOT_FOUND and other fs errors to INTERNAL without paths

- **B1:** docs/specs/04-media-render-and-backend.md q1 identity, peaks and media metadata; AGENTS.md safe HTTP/config errors independently specifies this case: “maps ENOSPC to DISK_FULL, ENOENT to NOT_FOUND and other fs errors to INTERNAL without paths”.
- **B2:** A caller-visible violation of “maps ENOSPC to DISK_FULL, ENOENT to NOT_FOUND and other fs errors to INTERNAL without paths” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: Python hashlib vectors, fixed byte/audio inputs, tampered signatures, ffprobe-style external metadata and literal codes. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes fingerprint/signing/broadcast/peaks/probe and HTTP configuration seams. Non-test consumers: media/probe/fingerprint, auth routes, SSE broadcaster, derivative service and startup.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “maps ENOSPC to DISK_FULL, ENOENT to NOT_FOUND and other fs errors to INTERNAL without paths” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: the dev engine accepts the Vite host given by JASPER_DEV_WEB_PORT (default 5173)

- **B1:** docs/specs/04-media-render-and-backend.md q1 identity, peaks and media metadata; AGENTS.md safe HTTP/config errors independently specifies this case: “the dev engine accepts the Vite host given by JASPER_DEV_WEB_PORT (default 5173)”.
- **B2:** A caller-visible violation of “the dev engine accepts the Vite host given by JASPER_DEV_WEB_PORT (default 5173)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: Python hashlib vectors, fixed byte/audio inputs, tampered signatures, ffprobe-style external metadata and literal codes. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes fingerprint/signing/broadcast/peaks/probe and HTTP configuration seams. Non-test consumers: media/probe/fingerprint, auth routes, SSE broadcaster, derivative service and startup.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “the dev engine accepts the Vite host given by JASPER_DEV_WEB_PORT (default 5173)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: resolves a relative JASPER_WEB_DIR against the working directory (@fastify/static needs an absolute root)

- **B1:** docs/specs/04-media-render-and-backend.md q1 identity, peaks and media metadata; AGENTS.md safe HTTP/config errors independently specifies this case: “resolves a relative JASPER_WEB_DIR against the working directory (@fastify/static needs an absolute root)”.
- **B2:** A caller-visible violation of “resolves a relative JASPER_WEB_DIR against the working directory (@fastify/static needs an absolute root)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: Python hashlib vectors, fixed byte/audio inputs, tampered signatures, ffprobe-style external metadata and literal codes. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes fingerprint/signing/broadcast/peaks/probe and HTTP configuration seams. Non-test consumers: media/probe/fingerprint, auth routes, SSE broadcaster, derivative service and startup.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “resolves a relative JASPER_WEB_DIR against the working directory (@fastify/static needs an absolute root)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.


## apps/engine/test/windows-opener.test.ts

Owner/caller evidence: routes/gaps.ts launch handler. Independent sources: security review ENG-5 and Microsoft PowerShell/Explorer argument protocols.

Validation planned: `pnpm exec vitest run apps/engine/test/windows-opener.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### DELETE: the command is a constant that names the path only through the environment

Detectable failure before removal: the expectation named “the command is a constant that names the path only through the environment”. Disposition: Asserts exported declaration equals literal; real opener property and PowerShell artifact own the security rule. Non-test seam consumers: routes/gaps.ts launch handler; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.

### DELETE: %s (Windows open hostile-path corpus)

Detectable failure before removal: the expectation named “%s”. Disposition: Hostile example exact object inventory duplicates arbitrary-path open property and actual PowerShell corpus. Non-test seam consumers: routes/gaps.ts launch handler; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.

### KEEP: never cmd.exe, never a shell, whatever the path (property)

- **B1:** security review ENG-5 and Microsoft PowerShell/Explorer argument protocols independently specifies this case: “never cmd.exe, never a shell, whatever the path (property)”.
- **B2:** A caller-visible violation of “never cmd.exe, never a shell, whatever the path (property)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: independent documented quoting/parser model, hostile arbitrary paths and real argv artifact/canary file. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes openerFor plus actual PowerShell invocation. Non-test consumers: routes/gaps.ts launch handler.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “never cmd.exe, never a shell, whatever the path (property)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### DELETE: %s (Windows reveal hostile-path corpus)

Detectable failure before removal: the expectation named “%s”. Disposition: Hostile reveal object inventory duplicates arbitrary-path reveal roundtrip protocol property. Non-test seam consumers: routes/gaps.ts launch handler; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.

### DELETE: the quoting Node would apply by itself mis-parses commas and spaces: that is why the line is verbatim

Detectable failure before removal: the expectation named “the quoting Node would apply by itself mis-parses commas and spaces: that is why the line is verbatim”. Disposition: Tests only the test-owned quoting/parser model, not production behavior. Non-test seam consumers: routes/gaps.ts launch handler; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.

### REWRITE: any path without a double quote parses back to itself (property)

Change: Feed actual returned verbatim flag into the independent serialization/parser oracle so a missing flag fails.

- **B1:** security review ENG-5 and Microsoft PowerShell/Explorer argument protocols independently specifies this case: “any path without a double quote parses back to itself (property)”.
- **B2:** A caller-visible violation of “any path without a double quote parses back to itself (property)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: independent documented quoting/parser model, hostile arbitrary paths and real argv artifact/canary file. Feed actual returned verbatim flag into the independent serialization/parser oracle so a missing flag fails.
- **B4:** Observes openerFor plus actual PowerShell invocation. Non-test consumers: routes/gaps.ts launch handler.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “any path without a double quote parses back to itself (property)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: %s (Windows invalid name family: double quote, quote breakout, NUL, LF, CR)

- **B1:** security review ENG-5 and Microsoft PowerShell/Explorer argument protocols independently specifies this case: “%s”.
- **B2:** A caller-visible violation of “%s” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: independent documented quoting/parser model, hostile arbitrary paths and real argv artifact/canary file. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes openerFor plus actual PowerShell invocation. Non-test consumers: routes/gaps.ts launch handler.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “%s” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### DELETE: libuv quoting and the C runtime parser are inverse for any argument list (property)

Detectable failure before removal: the expectation named “libuv quoting and the C runtime parser are inverse for any argument list (property)”. Disposition: Roundtrip tests only test-owned parser/quoting helper. Non-test seam consumers: routes/gaps.ts launch handler; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.

### DELETE: known values (Microsoft’s documented examples)

Detectable failure before removal: the expectation named “known values (Microsoft’s documented examples)”. Disposition: Known examples validate only test helper, not production behavior. Non-test seam consumers: routes/gaps.ts launch handler; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.

### KEEP: %j (real PowerShell hostile filename corpus; argument log and injection canary)

- **B1:** security review ENG-5 and Microsoft PowerShell/Explorer argument protocols independently specifies this case: “%j”.
- **B2:** A caller-visible violation of “%j” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: independent documented quoting/parser model, hostile arbitrary paths and real argv artifact/canary file. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes openerFor plus actual PowerShell invocation. Non-test consumers: routes/gaps.ts launch handler.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “%j” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: a missing file is an error from PowerShell, not an open of something else

- **B1:** security review ENG-5 and Microsoft PowerShell/Explorer argument protocols independently specifies this case: “a missing file is an error from PowerShell, not an open of something else”.
- **B2:** A caller-visible violation of “a missing file is an error from PowerShell, not an open of something else” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: independent documented quoting/parser model, hostile arbitrary paths and real argv artifact/canary file. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes openerFor plus actual PowerShell invocation. Non-test consumers: routes/gaps.ts launch handler.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “a missing file is an error from PowerShell, not an open of something else” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.


## apps/engine/test/worker-pools.test.ts

Owner/caller evidence: BlendPool/LayerPool/WarpPool/FlowPool use ExportWorkerPool; engine dev launcher uses tsx. Independent sources: AGENTS.md worker failures propagate and allocations are bounded; tsx keepNames regression.

Validation planned: `pnpm exec vitest run apps/engine/test/worker-pools.test.ts --maxWorkers=1`; `pnpm --filter @jasper/engine typecheck`. Rendering/native/SSH cases retain their declared tooling prerequisites; root schedules resource-heavy checks.

### DELETE: blend: blends a frame, then fails (does not hang) once its worker died

Detectable failure before removal: the expectation named “blend: blends a frame, then fails (does not hang) once its worker died”. Disposition: Private pool.pool.workers fault injection duplicates core real-worker exit coverage. Non-test seam consumers: BlendPool/LayerPool/WarpPool/FlowPool use ExportWorkerPool; engine dev launcher uses tsx; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.

### DELETE: layer streams: fail once the worker died

Detectable failure before removal: the expectation named “layer streams: fail once the worker died”. Disposition: Same wrapper/private-state crash replay; core lifecycle test is lowest stable owner. Non-test seam consumers: BlendPool/LayerPool/WarpPool/FlowPool use ExportWorkerPool; engine dev launcher uses tsx; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.

### DELETE: warp: fails once the worker died

Detectable failure before removal: the expectation named “warp: fails once the worker died”. Disposition: Same wrapper/private-state crash replay; core lifecycle test is lowest stable owner. Non-test seam consumers: BlendPool/LayerPool/WarpPool/FlowPool use ExportWorkerPool; engine dev launcher uses tsx; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.

### DELETE: optical flow: fails once the worker died

Detectable failure before removal: the expectation named “optical flow: fails once the worker died”. Disposition: Same wrapper/private-state crash replay; core lifecycle test is lowest stable owner. Non-test seam consumers: BlendPool/LayerPool/WarpPool/FlowPool use ExportWorkerPool; engine dev launcher uses tsx; shared production behavior remains. Risk: loss of incidental shape/duplicate assertions only; stronger coverage is named in the disposition. Validation: focused surviving owner suite plus engine typecheck.

### REWRITE: optical flow: closing settles both running and queued requests

Change: Move running/queued close refusal to core ExportWorkerPool with a real idle Worker; remove wrapper-only call shape.

- **B1:** AGENTS.md worker failures propagate and allocations are bounded; tsx keepNames regression independently specifies this case: “optical flow: closing settles both running and queued requests”.
- **B2:** A caller-visible violation of “optical flow: closing settles both running and queued requests” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: real worker exit/close/clone errors, bounded allocation requests and successful child execution. Move running/queued close refusal to core ExportWorkerPool with a real idle Worker; remove wrapper-only call shape.
- **B4:** Observes ExportWorkerPool lifecycle and actual tsx BlendPool subprocess. Non-test consumers: BlendPool/LayerPool/WarpPool/FlowPool use ExportWorkerPool; engine dev launcher uses tsx.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “optical flow: closing settles both running and queued requests” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: the blend pool works in the dev engine (tsx, esbuild keepNames)

- **B1:** AGENTS.md worker failures propagate and allocations are bounded; tsx keepNames regression independently specifies this case: “the blend pool works in the dev engine (tsx, esbuild keepNames)”.
- **B2:** A caller-visible violation of “the blend pool works in the dev engine (tsx, esbuild keepNames)” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: real worker exit/close/clone errors, bounded allocation requests and successful child execution. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes ExportWorkerPool lifecycle and actual tsx BlendPool subprocess. Non-test consumers: BlendPool/LayerPool/WarpPool/FlowPool use ExportWorkerPool; engine dev launcher uses tsx.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “the blend pool works in the dev engine (tsx, esbuild keepNames)” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: refuses invalid worker counts before allocating workers: %s

- **B1:** AGENTS.md worker failures propagate and allocations are bounded; tsx keepNames regression independently specifies this case: “refuses invalid worker counts before allocating workers: %s”.
- **B2:** A caller-visible violation of “refuses invalid worker counts before allocating workers: %s” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: real worker exit/close/clone errors, bounded allocation requests and successful child execution. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes ExportWorkerPool lifecycle and actual tsx BlendPool subprocess. Non-test consumers: BlendPool/LayerPool/WarpPool/FlowPool use ExportWorkerPool; engine dev launcher uses tsx.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “refuses invalid worker counts before allocating workers: %s” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: bounds worker and frame-slot allocation

- **B1:** AGENTS.md worker failures propagate and allocations are bounded; tsx keepNames regression independently specifies this case: “bounds worker and frame-slot allocation”.
- **B2:** A caller-visible violation of “bounds worker and frame-slot allocation” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: real worker exit/close/clone errors, bounded allocation requests and successful child execution. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes ExportWorkerPool lifecycle and actual tsx BlendPool subprocess. Non-test consumers: BlendPool/LayerPool/WarpPool/FlowPool use ExportWorkerPool; engine dev launcher uses tsx.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “bounds worker and frame-slot allocation” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: terminates already-created workers if startup fails

- **B1:** AGENTS.md worker failures propagate and allocations are bounded; tsx keepNames regression independently specifies this case: “terminates already-created workers if startup fails”.
- **B2:** A caller-visible violation of “terminates already-created workers if startup fails” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: real worker exit/close/clone errors, bounded allocation requests and successful child execution. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes ExportWorkerPool lifecycle and actual tsx BlendPool subprocess. Non-test consumers: BlendPool/LayerPool/WarpPool/FlowPool use ExportWorkerPool; engine dev launcher uses tsx.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “terminates already-created workers if startup fails” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: rejects running and queued tasks when a worker exits

- **B1:** AGENTS.md worker failures propagate and allocations are bounded; tsx keepNames regression independently specifies this case: “rejects running and queued tasks when a worker exits”.
- **B2:** A caller-visible violation of “rejects running and queued tasks when a worker exits” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: real worker exit/close/clone errors, bounded allocation requests and successful child execution. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes ExportWorkerPool lifecycle and actual tsx BlendPool subprocess. Non-test consumers: BlendPool/LayerPool/WarpPool/FlowPool use ExportWorkerPool; engine dev launcher uses tsx.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “rejects running and queued tasks when a worker exits” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.

### KEEP: rejects unclonable messages without leaving a request pending

- **B1:** AGENTS.md worker failures propagate and allocations are bounded; tsx keepNames regression independently specifies this case: “rejects unclonable messages without leaving a request pending”.
- **B2:** A caller-visible violation of “rejects unclonable messages without leaving a request pending” fails its result/error/artifact assertion; this is not an assertion-free exercise.
- **B3:** Oracle: real worker exit/close/clone errors, bounded allocation requests and successful child execution. Expected outcomes are fixed by the input fixture/protocol, not copied from the implementation branch.
- **B4:** Observes ExportWorkerPool lifecycle and actual tsx BlendPool subprocess. Non-test consumers: BlendPool/LayerPool/WarpPool/FlowPool use ExportWorkerPool; engine dev launcher uses tsx.
- **B5:** Implementation can be reorganized, renamed or replaced while preserving this seam and the stated behavior; assertions do not require private collaborator call shape after cleanup.
- **B6:** Owns the distinct scenario “rejects unclonable messages without leaving a request pending” at the above seam. Other retained cases cover different inputs, failure modes or integration boundaries; no stronger remaining test asserts this complete contract.
Risk: low; fixture and caller-visible expectation are preserved. Validation: the focused command above, then engine typecheck and root repository gates.


## Cleanup totals

{'DELETE': 34, 'REWRITE': 34, 'KEEP': 164}; parameterized family rows are counted once. Executed-test counts will be reported separately.

## Completed changes and verification

Implemented the dispositions above: 34 DELETE, 34 REWRITE, 164 KEEP families across 36 assigned files. Cumulative test LOC is recorded after the final rescan below. Two files are removed in full: `blend-remotion.e2e.test.ts`, `color-mgmt-remotion.test.ts`. The retry file is rewritten at the public service boundary after cross-review found an independently documented failure contract.

Dead support removed: private `killIdleWorker` access and its lint suppression; cache fixture `refs` and copied expected-scan code; Windows `crtParse`, `dirs`/`hostilePaths` duplicate corpus and `FIXED` declaration; native animation benchmark `timed`/`pipDoc`/`cardsDoc` and its flags, plus the unused static-card option; golden `nativeFrames` collector; unused imports and anime checkout path helpers. Shared `assertDistinctScenes` removal is coordinated with the shared agent after both golden callers are removed. No golden image, media recipe or shared fixture was deleted here because surviving consumers need them.

Production exports removed without changing execution: `WINDOWS_OPEN_COMMAND` in `routes/gaps.ts`, `medianFilter`/`dtw` in `speech/core/align.ts`, `withSinglePageRetry` in `remotion/service.ts`, `focalOf` in `camtrack/core/solver.ts`. Repository caller search found only same-module production consumers and removed test imports. Root approved these exclusive edits.

Independent-oracle derivations: camera focal length follows pinhole geometry `f = width / (2 tan(horizontalFov / 2))`; committed fixture constants use width 1280 and 40°, 45°, 50°, 55°, 60°. The radial fixture uses the k1/k2 model documented in the three-d port record, `p_d = p (1 + k1 rho² + k2 rho⁴)`. These expectations no longer call production `focalOf`/`distort`. Slaney front-end endpoints come from the recipe in `docs/wp-notes/speech.md`: 1 kHz = 15 mel and 6.4 kHz = 42 mel; the 80-band 0–8 kHz bank places 1 kHz nearest zero-based band 26. Native pan and audio tests use their explicitly prescribed linear endpoints. Color Dodge expected RGB is `[204,191,170]` from the independently specified `backdrop / (1-source)` equation. Project collection compares file bytes, and Auto-Match uses external FFmpeg ebur128.

Verification actually run: `pnpm install --frozen-lockfile --offline` passed; TypeScript syntax parser reported zero errors for changed source/test files; focused `pnpm exec biome check` passed for all 25 modified TypeScript files; `git diff --check` passed. Staged diff reviewed before commit. Before the follow-up, no focused Vitest, package typecheck, browser/GL/native rendering or remote SSH suite was run in this worktree: root requested that new test/typecheck/render processes be deferred because the shared 16-core host was overloaded and root's unchanged baseline/gates were already running. This is an explicit pending-validation handoff, not a passing test claim.

Required integrated execution: root's `pnpm --filter @jasper/engine typecheck`, changed engine suites with one worker, then repository lint/typecheck/test/build. Run retained opt-in rendering with `REMOTION_E2E=1`, working Chrome/software GL and `JASPER_REQUIRE_ORACLES=1`; inspect output artifacts. Engine render tests leave generated video/PNG artifacts in their temporary appdirs, golden parity writes `test-results/golden/parity.txt`, and native/layer-bake numerical suites retain measurement reports. PowerShell and real SSH checks retain their declared environment gates. Baseline failures in retained contracts must be fixed at the owner, never pruned to pass.

Known pending checks deserve attention after the oracle rewrites: external LUFS agreement in `audio-fx.test.ts`; independent Slaney peak and camera fixture numerics; the public snapshot/media handles in `golden-parity.e2e.test.ts`; prescribed audio gain/frame equations in `native-animated.test.ts`. No product failure is asserted from unrun tests.

Stale references were sent to root for its documentation integration: color/compositor/keyframes-blend work notes and gaps.md mode-matrix count; native animation benchmark commands in testing/verification/native-animated-export notes; speech test count. Historical measured benchmark results should remain clearly historical, while active removed commands should go.

## Follow-up dead-seam audit (before edit)

`gaps/reframe.ts` exports `saliency` only because of an obsolete “Exported for tests” comment; its only remaining caller is the same-module automatic reframe implementation. `gaps/warp-analysis.ts` has the same obsolete export/comment on `buildWarpAnalysis`, called only by the same-module analysis pipeline. Repository-wide caller searches found no test or external production imports. Remove the two exports and comments without changing function behavior; retained `gaps-reframe.test.ts` and `gaps-warp-analysis.test.ts` exercise the public job contracts. Risk: low internal visibility cleanup; validate with engine typecheck and those focused suites under root scheduling.

Follow-up implementation complete: `remotion-retry.test.ts` now exercises public render results after external SDK faults, while `withSinglePageRetry` remains private. The dependency fixture has no retry logic and creates no browser/FFmpeg process. `saliency` and `buildWarpAnalysis` now have module-private visibility and accurate comments; production calls are untouched. Focused Biome and TypeScript syntax checks cover these three changed TypeScript files; root subsequently scheduled only the lightweight retry file with one worker; its result is recorded below. Other focused suites/typecheck remain pending integrated execution.

Focused follow-up execution: `pnpm exec vitest run apps/engine/test/remotion-retry.test.ts --maxWorkers=1` passed **5/5 tests** (102.38 s wall time, 524 ms test bodies; 99.55 s module import on the loaded host). The first run exposed a fixture error: returning the reset mock from `beforeEach` registered it as a Vitest cleanup callback. The hook now returns void; rerun passed without weakening any contract assertions. `pnpm exec biome check` passed all three follow-up TypeScript files and final diff whitespace checks passed. No product behavior was changed.

## Final independent-oracle rescan — before editing

Reviewed the retained assigned tests against integration branch `cleanup/tests-integration` (`cf890a29`); the three test files below match this worktree, including the restored public-service retry regression. No additional broad test inventory or runtime suite is part of this follow-up.

### REWRITE candidates: `apps/engine/test/native-animated.test.ts`

- **`every sampled frame matches the evaluated layer: corners ≤ 0.1 px (sub-pixel), colour ≤ 8/255; LGPL filters only`**: the decoder measures real exported pixels, but the expected quad and color sampling map come from `resolveSceneAt`/`layerMapOf`, also used by the export owner. A wrong shared anchor/scale/rotation convention could pass. Retain independent absolute geometry/color at the two authored endpoint poses (frame 0 and frame 47), using numeric fixture parameters and the normative affine transform; remove the shared evaluator/matrix oracle. The existing every-frame native/Remotion comparison still covers all intermediate Bezier/hold frames, and the independent 300-frame pan owns fractional timing. B1: S03 DM-010/011 and `docs/wp-notes/native-animated-export.md` specify transform, 0.1 px geometry and lossy-codec color tolerances. B2: a displaced, wrongly scaled/rotated or incorrectly composited card fails decoded pixels. B3: endpoint positions, anchors, scales, angles and opacity are literal authored values, with `P + R S (q−A)` and its analytic inverse. B4: public export job output and external FFmpeg license rule. B5: no dependency on scene resolution or matrix representation. B6: the strict absolute 0.1 px/8-code-value endpoint check catches errors that aggregate SSIM and a translation-only pan can miss. Risk: the old per-frame resolver agreement is deliberately reduced to independent endpoint accuracy; full rendered parity remains. Planned validation: focused native animation suite and engine typecheck under root scheduling.
- **`keyframed crop edges with keyframed non-uniform scale: the visible rect follows the evaluated quad (≤ 0.1 px)`**: replace the same shared resolver oracle with the fixture's prescribed linear scale/left crop, held right crop, fixed 12° rotation and explicit center anchor/position. B1: S03 DM-010/011 explicitly says crop hides content without moving the anchor and defines the cropped rectangle. B2: rounding, changing the pivot with crop, wrong hold timing or swapping horizontal/vertical scale fails extracted edge positions. B3: corner positions come only from literal 1920×1080 fixture dimensions and independently evaluated linear/hold equations. B4: exported ProRes frames. B5: no private evaluator/graph assertions. B6: this owns crop+nonuniform-scale integration, absent from the card and translation fixtures. Risk: independent equations may expose an existing geometry bug; do not change tolerances to pass. Validation: same focused native suite and engine typecheck.
- **`every frame of the keyframed card: native vs Remotion SSIM ≥ 0.98 (FX-040)`**: retain its already valid independent-renderer parity contract; remove unasserted corner/share diagnostics and the shared resolver calls they require. B1: AGENTS preview/export fidelity and FX-040 prescribe rendered parity. B2: frame-specific dropped animation/color diverges between real render outputs. B3: SSIM compares two actual renderer artifacts, not a production-generated expected value; this is the explicitly required parity exception. B4: export HTTP jobs and decoded videos. B5: no dependence on private scene shape. B6: sole whole-video native/Remotion animated-card comparison; endpoint numeric tests cover a different absolute contract. Risk: diagnostic-only output removed; assertions unchanged. Validation: opt-in `REMOTION_E2E=1` native parity suite, preserving `NATIVE_ANIM_KEEP` artifacts.

Formula source: `docs/specs/03-monitors-effect-controls-rendering-items.md` §3.2 is normative: `M(q)=P+R·S·(q−A)`, clockwise in y-down space, crop bounds `[l·w,(1−r)·w]×[t·h,(1−b)·h]`; `docs/wp-notes/native-animated-export.md` §Motion→Opacity cites that same contract. The test will use those equations, not copy the production matrix helpers. `resolveSceneAt`, `layerMapOf`, `applyMat3` and `invertMat3` retain many non-test callers in project/compositions/export; only the test imports are removed. `colourError` remains useful with an independently supplied inverse coordinate map; the unused `within` support is removed.

### REWRITE candidates: `apps/engine/test/camtrack-solve.test.ts`

The old error metric called the solver's own `logRot`, `norm`, `mm` and `frameR` decoder. A faulty logarithm or vector norm could underreport a wrong solve. Replace measured Euclidean distances with `Math.hypot`; compare rotations with an independent quaternion decoding of serialized axis-angle and the chordal matrix distance. For rotations A/B, `||A−B||F = 2√2 sin(θ/2)`, derived by expanding `tr((A−B)ᵀ(A−B))=6−2tr(AᵀB)` and `tr(AᵀB)=1+2cosθ`. This is an analytic measurement identity, not a second camera solver. Output `solveFocal` is an observation of public solved-frame focal lengths, not the expected result; fixed independent expected focal values already remain.

- **`recovers the relative pose from the essential matrix`**: B1: known synthetic pinhole observations and documented camera convention determine rotation and translation direction. B2: wrong recovered pose or front/back selection fails. B3: compare the returned matrix directly with the authored second camera (first camera is identity), and translation with literal `[1,.2,.3]/√1.13`; eliminate shared log/norm. B4: geometry operator consumed by `solveCamera`. B5: no SVD/internal call assertions. B6: lowest noiseless essential-pose owner, distinct from noisy end-to-end solving. Risk: numerical equivalence of independent angle metric; keep the existing 1e-6° limit. Validation: focused camera suite and engine typecheck.
- **`bundle adjustment converges from a perturbed start`**: B1: the supplied observations/fixed first cameras determine the known recovered centers. B2: failure to converge or wrong camera locations fails coordinate distances. B3: use direct Euclidean distances to independent fixture truth and remove the redundant comparison between two owner-reported costs. B4: `adjust` numerical operator used by solver. B5: optimizer/diagnostic structure may change. B6: lowest isolated convergence contract; noisy solve has different inputs. Risk: only self-reported residual comparison removed. Same validation.
- **`Fixed Angle of View: finds the focal length and the path of a dolly`**: B1: three-d work note requires focal within 3%, path within 2%, rotation within 0.3°. B2: wrong focal/path/pan fails those numerical outputs. B3: literal focal and synthetic authored cameras; independent distance/angle measurement. B4: `solveCamera` public worker seam. B5: solver internals unconstrained. B6: sole free-focal moving-camera accuracy owner. Risk: shared-helper errors may now become visible. Same validation.
- **`Specify Angle of View: uses the given focal length`**: B1: specified 40° field of view must set the known focal and recover a path. B2: ignoring supplied FOV or warping camera trajectory fails. B3: literal focal and known authored centers measured by direct Euclidean distance after monocular gauge alignment. B4: `solveCamera`. B5: no algorithm/call shape. B6: distinct prescribed-FOV route. Risk: metric only. Same validation.
- **`Variable Zoom: follows a zoom during the move`**: B1: three-d note requires per-frame focal within 6%. B2: constant/incorrect zoom or path fails. B3: authored linear focal curve and independent path distances. B4: `solveCamera`. B5: no estimator implementation assertions. B6: sole changing-focal solve fixture. Risk: metric only. Same validation.
- **`Auto Detect: a pan from a tripod is solved as a pure rotation`**: B1: three-d note requires Tripod Pan classification, fixed centers and 0.3° rotation. B2: false translation or wrong pan fails. B3: zero center literal and authored camera directions with independent quaternion/chordal angle. B4: `solveCamera`. B5: no classifier/internal pose shape beyond serialized contract. B6: sole tripod degeneracy fixture. Risk: metric only. Same validation.
- **`Auto Detect: a scene of one plane is solved (Flat)`**: B1: three-d note requires flat-scene classification and a recovered path. B2: wrong branch or nonmatching trajectory fails. B3: authored coplanar points and centers, independent Euclidean path error. B4: `solveCamera`. B5: no homography branch calls asserted. B6: distinct planar degeneracy. Risk: metric only. Same validation.

Caller census before editing: `logRot` and vector/matrix operators have real solver consumers and remain. `frameR` is used only by this test; the `types.ts` re-export of `logRot` has no consumers (real callers import `linalg.ts`). Remove that wrapper and unused re-export/import after the test switches to independent decoding. `umeyama` is currently used only by the camera solve/job test metrics; engine3 owns deleting this unused production utility after both tests switch to their authored straight, constant-speed trajectory. Endpoint normalization removes arbitrary monocular translation/orientation/scale; expected intermediate progress is the independently prescribed frame fraction. A zero-length or undersolved path fails explicitly. This is a deliberate change from best-fit similarity to endpoint gauge alignment, with the original accuracy tolerances unchanged; runtime confirmation is pending. Production workers consume `SolveResult` and `solveCamera` unchanged.

### REWRITE candidate: `apps/engine/test/speech-core.test.ts` — `the mixed-radix FFT equals a direct DFT`

B1: Whisper's published 16 kHz frontend uses 400 samples and 201 real-spectrum bins, recorded in `docs/wp-notes/speech.md` and `mel.ts`'s protocol provenance. B2: a wrong FFT size/frequency grid/power normalization changes the speech model input and fails numeric bins. B3: direct DFT now uses literal protocol dimensions 400/201 instead of importing the implementation constants; the pseudo-random input generator is fixture setup, not the expected spectrum. B4: the production spectrum operator used by `powerSpectra`/`logMel`. B5: radix, scratch buffers and transform implementation may change. B6: lowest numerical spectrum owner; tone-band and model WER checks are coarser and cannot isolate every numeric bin. Risk: none beyond exposing a protocol mismatch. Validation: focused speech-core suite and engine typecheck. Caller census across apps/packages shows `N_FFT` and `N_BINS` are otherwise used only inside `mel.ts`; make them private without changing their values.

The `fitPieces` test remains valid: its expected sequence is an authored smooth-step plus step discontinuity, and `pieceValue` observes the fitted output through the production numerical interface rather than deriving the expected sequence. `fitPieces` does not call `pieceValue`; native stream planning is a real non-test consumer of both. Likewise generated reframe position evaluations and warp-plan output decoding observe public results; their expected subject bounds/known camera path remain independent. No duplicate oracle was inferred merely from an imported production function.

Final rescan implementation: the three targeted test files now contain the independent oracles described above. Removed the `frameR` wrapper and unused `types.ts` `logRot` re-export, made `N_FFT`/`N_BINS` private, and removed unused renderer-parity diagnostics/`within`. No production algorithm or output changed. Engine3 commit `0e8fee98` completed deletion of the test-only WER unit case, moved its scoring helper into test support and deleted production `umeyama` after both test consumers were removed. The WER case is counted once in this original inventory; [engine3-followup.md](engine3-followup.md) supplies the coordinated implementation evidence.

Validation for this follow-up is intentionally static only, per root scheduling: focused Biome and TypeScript syntax/transpile checks, final whitespace and caller searches. Semantic package typecheck, camera solving, speech execution and native/Remotion rendering remain pending integrated validation; no runtime pass is claimed for the new oracles. Retained retry restoration is unchanged. The native authored-card check now names endpoint poses, and crop names authored affine corners; historical work-note measurements against all-frame evaluated quads remain historical measurements, not claims about the rewritten assertions.

Engine1 implementation commit `a062eb81` changed test code by **+309 / −1432 lines, net −1123 test LOC** from the assigned baseline. The coordinated WER deletion in `0e8fee98` removes another 10 lines from the assigned `speech-core.test.ts`; its support-file move is accounted for in engine3’s change. Authoritative case-family totals after that coordinated deletion are **34 DELETE / 34 REWRITE / 164 KEEP** (232 original families), counting the WER case once here.

Final rescan checks actually completed: `pnpm exec biome check` passed all five changed TypeScript files; TypeScript `transpileModule` reported no syntax diagnostics in those five files; `git diff --check` passed; caller search found no remaining `frameR` use or external FFT-constant imports. Cross-review independently checked the quaternion/chordal rotation math, canonical first-camera frame, literal endpoint transform values and crop equations. Endpoint path alignment is gauge invariant for these straight constant-speed fixtures, but it can produce different noisy residual magnitudes than best-fit similarity; focused runtime validation must confirm the unchanged thresholds rather than assuming metric equivalence.

Integrated typecheck correction, recorded before editing: the rewritten
`golden-parity.e2e.test.ts` snapshot setup omits the required `resolveFont` option.
Its five authored scenes contain only the generated image cards and effects, so
provide a resolver returning `null`. This completes fixture setup without altering
pixels, assertions or production behavior. Validation: engine typecheck and the
existing opt-in native/Remotion golden parity suite.
