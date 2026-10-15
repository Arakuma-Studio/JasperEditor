# Project 4 test cleanup disposition

Pre-edit audit recorded against `6c2baa39` before changing tests. Scope: all 34 assigned files; 378 test declarations (parameterized families counted once here). Each row is a decision for that named test, not a file-level exemption.

The six numbered cells are the retention bar: (1) independent contract/source, (2) caller failure, (3) independent expected result, (4) stable seam, (5) behavior-preserving refactors, (6) lowest unique owner. Section sources/callers apply to each row explicitly. No mocked implementation supplies the retained expected result. Geometry here is rendered path/signal mathematics required by the editor, not DOM layout. KEEP does not claim every incidental assertion is an independent test.

Validation for each surviving section: `pnpm exec vitest run <section-path> --maxWorkers=1` then `pnpm --filter @jasper/project typecheck`; integration owner runs full lint/typecheck/test/build. Deletions additionally require import/caller scan and adjacent surviving owner tests. Risk: removal loses implementation-change detection; retained contracts below keep behavior protection.

## packages/project/test/agent.test.ts

Independent sources: docs/ARCHITECTURE.md agent protocol; docs/ARCHITECTURE.md agent boundary; commands/types.ts public E_* protocol. Production seam: agent queries/address resolver/approval and limit API. Non-test callers: apps/mcp and engine transaction/query handlers. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in agent protocol result/error differs for the named query or security case.

### KEEP: sequence.summary reports tracks, markers and timecodes
Original location: `packages/project/test/agent.test.ts:24`.
1. Contract from the section source: sequence.summary reports tracks, markers and timecodes.
2. Detectable caller failure: Agent protocol result/error differs for the named query or security case; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.duration.frames).toBe(300);; expect(r.duration.timecode).toBe('00:00:10:00');; expect(r.tracks.find((t) => t.label === 'V1')?.clipCount).toBe(1);; expect(r.tracks.find((t) => t.label === 'V2')?.clipCount).toBe(1);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes agent queries/address resolver/approval and limit API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “sequence.summary reports tracks, markers and timecodes” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: sequence.clipsInRange filters by range and track labels, with source seconds
Original location: `packages/project/test/agent.test.ts:40`.
1. Contract from the section source: sequence.clipsInRange filters by range and track labels, with source seconds.
2. Detectable caller failure: Agent protocol result/error differs for the named query or security case; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.clips.map((c) => c.track).sort()).toEqual(['A1', 'V1']);; expect(r.clips[0]!.source.outSeconds).toBe(10);; expect(r.clips[0]!.linked).toHaveLength(1);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes agent queries/address resolver/approval and limit API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “sequence.clipsInRange filters by range and track labels, with source seconds” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: sequence.at evaluates the stack at a frame (bottom → top)
Original location: `packages/project/test/agent.test.ts:54`.
1. Contract from the section source: sequence.at evaluates the stack at a frame (bottom → top).
2. Detectable caller failure: Agent protocol result/error differs for the named query or security case; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.video.map((v) => v.track)).toEqual(['V1', 'V2']);; expect(r.video[1]!.opacity).toBe(100);; expect(r.audio.map((a) => a.track)).toEqual(['A1']);; expect(r.timecode).toBe('00:00:01:10');. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes agent queries/address resolver/approval and limit API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “sequence.at evaluates the stack at a frame (bottom → top)” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: doc.get supports paths and field projection; session-only queries need a session
Original location: `packages/project/test/agent.test.ts:67`.
1. Contract from the section source: doc.get supports paths and field projection; session-only queries need a session.
2. Detectable caller failure: Agent protocol result/error differs for the named query or security case; specifically the named case would return or store the wrong result.
3. Oracle: expect(runAgentQuery(env, 'doc.get', { path: ['sequences', h.seqId], fields: ['id'] })).toEqual({; expect(() => runAgentQuery(env, 'doc.get', { path: ['nope'] })).toThrow(AgentQueryError);; expect(() => runAgentQuery(env, 'doc.get', { path: ['constructor'] })).toThrow(AgentQueryError);; expect(runAgentQuery(env, 'doc.get', { path: ['sequences', h.seqId], fields: ['toString'] })).toEqual({});. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes agent queries/address resolver/approval and limit API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “doc.get supports paths and field projection; session-only queries need a session” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: resolves mediaByName, clipAt and markerByName
Original location: `packages/project/test/agent.test.ts:85`.
1. Contract from the section source: resolves mediaByName, clipAt and markerByName.
2. Detectable caller failure: Agent protocol result/error differs for the named query or security case; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.ok).toBe(true);; expect((r.commands[0] as { source: unknown }).source).toEqual({ mediaId });; expect((r.commands[1] as { clipId: string }).clipId).toBe(h.clips('V2')[0]!.id);; expect((r.commands[2] as { markerId: string }).markerId).toBe(h.seq.markers[0]!.id);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes agent queries/address resolver/approval and limit API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “resolves mediaByName, clipAt and markerByName” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: fails with E_AMBIGUOUS / E_NOT_FOUND and the command index
Original location: `packages/project/test/agent.test.ts:101`.
1. Contract from the section source: fails with E_AMBIGUOUS / E_NOT_FOUND and the command index.
2. Detectable caller failure: Agent protocol result/error differs for the named query or security case; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.ok).toBe(false);; expect(r.errors[0]).toMatchObject({ commandIndex: 1, code: 'E_AMBIGUOUS' });; expect(miss.ok ? null : miss.errors[0]!.code).toBe('E_NOT_FOUND');. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes agent queries/address resolver/approval and limit API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “fails with E_AMBIGUOUS / E_NOT_FOUND and the command index” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: flags destructive commands and force
Original location: `packages/project/test/agent.test.ts:120`.
1. Contract from the section source: flags destructive commands and force.
2. Detectable caller failure: Agent protocol result/error differs for the named query or security case; specifically the named case would return or store the wrong result.
3. Oracle: expect(approvalReasons({ commands: [{ type: 'marker.add' }] })).toEqual([]);; expect(approvalReasons({ commands: [{ type: 'track.remove', trackIds: ['V3'] }] })).toHaveLength(1);; expect(approvalReasons({ commands: [{ type: 'clip.lift', clipIds: ['x'], force: true }] })).toHaveLength(; expect(approvalReasons({ commands: [{ type: 'track.remove' }], dryRun: true })).toEqual([]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes agent queries/address resolver/approval and limit API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “flags destructive commands and force” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: enforces limits and normalizes origins
Original location: `packages/project/test/agent.test.ts:129`.
1. Contract from the section source: enforces limits and normalizes origins.
2. Detectable caller failure: Agent protocol result/error differs for the named query or security case; specifically the named case would return or store the wrong result.
3. Oracle: expect(checkAgentTxLimits(many)?.code).toBe('E_LIMIT');; expect(checkAgentTxLimits({ commands: [] }, 21 * 1024 * 1024)?.code).toBe('E_LIMIT');; expect(checkAgentTxLimits({ commands: [{ type: 'marker.add' }] })).toBeNull();; expect(n.origin).toEqual({ agent: 'curl' });. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes agent queries/address resolver/approval and limit API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “enforces limits and normalizes origins” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

## packages/project/test/color-mgmt-luts.test.ts

Independent sources: docs/wp-notes/color-grade.md; licenses/ported/color-mgmt-filmcraft.md LUT format and tetrahedral contracts. Production seam: parse/apply/write/flatten LUT API. Non-test callers: engine LUT ingestion and preview/export colour pipeline. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in wrong displayed/exported colour or accepted/rejected lut format.

### KEEP: matches the brute-force simplex reference for sizes 2–33
Original location: `packages/project/test/color-mgmt-luts.test.ts:75`.
1. Contract from the section source: matches the brute-force simplex reference for sizes 2–33.
2. Detectable caller failure: Wrong displayed/exported colour or accepted/rejected LUT format; specifically the named case would return or store the wrong result.
3. Oracle: expect(Math.abs(a[k]! - b[k]!)).toBeLessThan(2e-6);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes parse/apply/write/flatten LUT API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “matches the brute-force simplex reference for sizes 2–33” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: is exact on affine LUTs and at lattice nodes
Original location: `packages/project/test/color-mgmt-luts.test.ts:91`.
1. Contract from the section source: is exact on affine LUTs and at lattice nodes.
2. Detectable caller failure: Wrong displayed/exported colour or accepted/rejected LUT format; specifically the named case would return or store the wrong result.
3. Oracle: expect(Math.abs(got[k]! - want[k]!)).toBeLessThan(1e-6);; expect(at(w, [3 / 6, 5 / 6, 1 / 6])).toEqual(node(w, 3, 5, 1));. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes parse/apply/write/flatten LUT API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “is exact on affine LUTs and at lattice nodes” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: 1D shaper + 3D (Resolve layout): parse, apply, write, read back
Original location: `packages/project/test/color-mgmt-luts.test.ts:114`.
1. Contract from the section source: 1D shaper + 3D (Resolve layout): parse, apply, write, read back.
2. Detectable caller failure: Wrong displayed/exported colour or accepted/rejected LUT format; specifically the named case would return or store the wrong result.
3. Oracle: expect(l.dimensions).toBe(3);; expect(l.shaper?.size).toBe(3);; expect(l.shaper?.domainMax).toEqual([4, 4, 4]);; expect(l.domainMax).toEqual([1, 1, 1]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes parse/apply/write/flatten LUT API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “1D shaper + 3D (Resolve layout): parse, apply, write, read back” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: 1D only, with LUT_1D_INPUT_RANGE
Original location: `packages/project/test/color-mgmt-luts.test.ts:130`.
1. Contract from the section source: 1D only, with LUT_1D_INPUT_RANGE.
2. Detectable caller failure: Wrong displayed/exported colour or accepted/rejected LUT format; specifically the named case would return or store the wrong result.
3. Oracle: expect(l.dimensions).toBe(1);; expect(at(l, [1, 1, 1])).toEqual([0.5, 0.25, 0.125]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes parse/apply/write/flatten LUT API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “1D only, with LUT_1D_INPUT_RANGE” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: a 3D LUT with LUT_3D_INPUT_RANGE alone takes that domain
Original location: `packages/project/test/color-mgmt-luts.test.ts:135`.
1. Contract from the section source: a 3D LUT with LUT_3D_INPUT_RANGE alone takes that domain.
2. Detectable caller failure: Wrong displayed/exported colour or accepted/rejected LUT format; specifically the named case would return or store the wrong result.
3. Oracle: expect(l.domainMin).toEqual([-0.5, -0.5, -0.5]);; expect(at(l, [0.5, 0.5, 0.5])).toEqual([0.5, 0.5, 0.5]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes parse/apply/write/flatten LUT API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “a 3D LUT with LUT_3D_INPUT_RANGE alone takes that domain” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: refuses duplicate sizes and data before sizes
Original location: `packages/project/test/color-mgmt-luts.test.ts:142`.
1. Contract from the section source: refuses duplicate sizes and data before sizes.
2. Detectable caller failure: Wrong displayed/exported colour or accepted/rejected LUT format; specifically the named case would return or store the wrong result.
3. Oracle: expect(() => parseCube('LUT_3D_SIZE 2\nLUT_3D_SIZE 2\n')).toThrow(CubeParseError);; expect(() => parseCube('0 0 0\nLUT_3D_SIZE 2\n')).toThrow(CubeParseError);; expect(() => parseCube('LUT_3D_SIZE 2\nLUT_1D_SIZE 2\n0 0 0\n')).toThrow(/Expected 10 table entries/);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes parse/apply/write/flatten LUT API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “refuses duplicate sizes and data before sizes” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: round-trips with blue-fastest orientation (a red↔blue swap shows any mistake)
Original location: `packages/project/test/color-mgmt-luts.test.ts:150`.
1. Contract from the section source: round-trips with blue-fastest orientation (a red↔blue swap shows any mistake).
2. Detectable caller failure: Wrong displayed/exported colour or accepted/rejected LUT format; specifically the named case would return or store the wrong result.
3. Oracle: expect(text.split('\n')[1]).toMatch(/^0 64 128 /);; expect(Math.abs(a[k]! - b[k]!)).toBeLessThan(1 / 4095 + 1e-4);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes parse/apply/write/flatten LUT API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “round-trips with blue-fastest orientation (a red↔blue swap shows any mistake)” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: reads a hand-written Lustre file (Mesh header, 12-bit output)
Original location: `packages/project/test/color-mgmt-luts.test.ts:169`.
1. Contract from the section source: reads a hand-written Lustre file (Mesh header, 12-bit output).
2. Detectable caller failure: Wrong displayed/exported colour or accepted/rejected LUT format; specifically the named case would return or store the wrong result.
3. Oracle: expect(v[k]).toBeCloseTo([0.2, 0.4, 0.6][k]!, 4);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes parse/apply/write/flatten LUT API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “reads a hand-written Lustre file (Mesh header, 12-bit output)” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: a non-uniform input mesh becomes a 1D shaper
Original location: `packages/project/test/color-mgmt-luts.test.ts:176`.
1. Contract from the section source: a non-uniform input mesh becomes a 1D shaper.
2. Detectable caller failure: Wrong displayed/exported colour or accepted/rejected LUT format; specifically the named case would return or store the wrong result.
3. Oracle: expect(l.shaper).toBeTruthy();; expect(at(l, [100 / 1023, 0, 1])[0]).toBeCloseTo(2047 / 4095, 3);; expect(() => parse3dl('0 512 1023\n1 2 3\n')).toThrow(CubeParseError);; expect(() => parse3dl('0 1023 512\n')).toThrow(CubeParseError);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes parse/apply/write/flatten LUT API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “a non-uniform input mesh becomes a 1D shaper” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: spi1d with From and one component
Original location: `packages/project/test/color-mgmt-luts.test.ts:189`.
1. Contract from the section source: spi1d with From and one component.
2. Detectable caller failure: Wrong displayed/exported colour or accepted/rejected LUT format; specifically the named case would return or store the wrong result.
3. Oracle: expect(l.dimensions).toBe(1);; expect(at(l, [1, 1.5, 2])).toEqual([0.25, 0.625, 1]);; expect(() => parseSpi1d('Version 1\nLength 3\n{\n0\n1\n}\n')).toThrow(CubeParseError);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes parse/apply/write/flatten LUT API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “spi1d with From and one component” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: spi3d rows with explicit indices
Original location: `packages/project/test/color-mgmt-luts.test.ts:195`.
1. Contract from the section source: spi3d rows with explicit indices.
2. Detectable caller failure: Wrong displayed/exported colour or accepted/rejected LUT format; specifically the named case would return or store the wrong result.
3. Oracle: expect(at(l, [0.25, 0.5, 0.75])).toEqual([0.75, 0.5, 0.25]);; expect(() => parseSpi3d('SPILUT 1.0\n3 3\n2 2 2\n0 0 0 1 1 1\n')).toThrow(/Expected 8 rows/);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes parse/apply/write/flatten LUT API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “spi3d rows with explicit indices” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: csp 3D with non-uniform pre-LUTs
Original location: `packages/project/test/color-mgmt-luts.test.ts:203`.
1. Contract from the section source: csp 3D with non-uniform pre-LUTs.
2. Detectable caller failure: Wrong displayed/exported colour or accepted/rejected LUT format; specifically the named case would return or store the wrong result.
3. Oracle: expect(l.shaper?.domainMax).toEqual([2, 2, 2]);; expect(v[0]).toBeCloseTo(0.75, 3);; expect(v[1]).toBeCloseTo(0.875, 3);; expect(v[2]).toBeCloseTo(1, 6);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes parse/apply/write/flatten LUT API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “csp 3D with non-uniform pre-LUTs” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: dispatches by extension and sniffs unknown files
Original location: `packages/project/test/color-mgmt-luts.test.ts:215`.
1. Contract from the section source: dispatches by extension and sniffs unknown files.
2. Detectable caller failure: Wrong displayed/exported colour or accepted/rejected LUT format; specifically the named case would return or store the wrong result.
3. Oracle: expect(lutFormatOf('a/Look.CUBE')).toBe('cube');; expect(lutFormatOf('x.3dl')).toBe('3dl');; expect(lutFormatOf('x.png')).toBeNull();; expect(parseLutFile(cube, null).size).toBe(3);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes parse/apply/write/flatten LUT API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “dispatches by extension and sniffs unknown files” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### REWRITE: flattens shapers and 1D tables into a plain unit cube
Original location: `packages/project/test/color-mgmt-luts.test.ts:224`.
Change: Replace cache identity assertions with fixed colour output [0.125, 0.125, 0.09375] after flattening the domain-0..2 1D LUT.
1. Contract from the section source: flattens shapers and 1D tables into a plain unit cube.
2. Detectable caller failure: Wrong displayed/exported colour or accepted/rejected LUT format; specifically the named case would return or store the wrong result.
3. Oracle: Replace cache identity assertions with fixed colour output [0.125, 0.125, 0.09375] after flattening the domain-0..2 1D LUT.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes parse/apply/write/flatten LUT API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “flattens shapers and 1D tables into a plain unit cube” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### DELETE: random text throws only CubeParseError
Original location: `packages/project/test/color-mgmt-luts.test.ts:236`.
Duplicate hostile text parser coverage at the same API; centralized fuzz-parsers.test.ts owns all six LUT formats with seeded mutations and arbitrary text. Fails 6.
Failure previously detected: random text throws only CubeParseError. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: mutated valid files throw only CubeParseError
Original location: `packages/project/test/color-mgmt-luts.test.ts:249`.
Duplicate hostile text parser coverage at the same API; centralized fuzz-parsers.test.ts owns all six LUT formats with seeded mutations and arbitrary text. Fails 6.
Failure previously detected: mutated valid files throw only CubeParseError. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

## packages/project/test/fuzz.test.ts

Independent sources: AGENTS.md §0/§6 invariants, atomic refusal and undoable commands. Production seam: applyTransaction/checkInvariants. Non-test callers: session command dispatch, MCP transactions. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in an allowed editing chain corrupts a project or refuses internally.

### KEEP: holds for ${RUNS} random runs
Original location: `packages/project/test/fuzz.test.ts:185`.
1. Contract from the section source: holds for ${RUNS} random runs.
2. Detectable caller failure: An allowed editing chain corrupts a project or refuses internally; specifically the named case would return or store the wrong result.
3. Oracle: expect(accepted).toBeGreaterThan(0);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes applyTransaction/checkInvariants through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “holds for ${RUNS} random runs” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

## packages/project/test/fx-catalogue.test.ts

### DELETE: has the family files, in Effects-panel order
Original location: `packages/project/test/fx-catalogue.test.ts:33`.
Catalogue/file order and values are copied from the registry itself; no independently expected protocol response. Fails 1/3/5. Real FX rendering is covered by compositions fx-gl and public command/agent-schema tests.
Failure previously detected: has the family files, in Effects-panel order. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: registers every catalogue effect by default, without shadowing an existing id
Original location: `packages/project/test/fx-catalogue.test.ts:38`.
Catalogue/file order and values are copied from the registry itself; no independently expected protocol response. Fails 1/3/5. Real FX rendering is covered by compositions fx-gl and public command/agent-schema tests.
Failure previously detected: registers every catalogue effect by default, without shadowing an existing id. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: every entry follows the family id prefix, bins and framework rules
Original location: `packages/project/test/fx-catalogue.test.ts:44`.
Catalogue/file order and values are copied from the registry itself; no independently expected protocol response. Fails 1/3/5. Real FX rendering is covered by compositions fx-gl and public command/agent-schema tests.
Failure previously detected: every entry follows the family id prefix, bins and framework rules. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: the agent schema export carries bin, description and the GPU flag
Original location: `packages/project/test/fx-catalogue.test.ts:66`.
Catalogue/file order and values are copied from the registry itself; no independently expected protocol response. Fails 1/3/5. Real FX rendering is covered by compositions fx-gl and public command/agent-schema tests.
Failure previously detected: the agent schema export carries bin, description and the GPU flag. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

## packages/project/test/fx-psdg.test.ts

Independent sources: docs/wp-notes/fx-shader-framework.md temporal hooks; SMPTE drop-frame and film feet conventions. Production seam: echo/posterize/strobe/timecode functions. Non-test callers: registered video FX and preview/export frame sampling. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in wrong echoed/held/strobed media frame or burned-in timecode.

### DELETE: has every Premiere effect of the brief, in its bin, registered and valid
Original location: `packages/project/test/fx-psdg.test.ts:102`.
Parameter catalogue/default inventory, private shader packing or padding formulas. Fails 3/4/5/6; actual GPU pixels and text rendering belong to compositions fx-gl; retained pure time hooks protect temporal semantics.
Failure previously detected: has every Premiere effect of the brief, in its bin, registered and valid. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: does not duplicate the existing Premiere effects
Original location: `packages/project/test/fx-psdg.test.ts:119`.
Parameter catalogue/default inventory, private shader packing or padding formulas. Fails 3/4/5/6; actual GPU pixels and text rendering belong to compositions fx-gl; retained pure time hooks protect temporal semantics.
Failure previously detected: does not duplicate the existing Premiere effects. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: uses Premiere parameter names and order
Original location: `packages/project/test/fx-psdg.test.ts:131`.
Parameter catalogue/default inventory, private shader packing or padding formulas. Fails 3/4/5/6; actual GPU pixels and text rendering belong to compositions fx-gl; retained pure time hooks protect temporal semantics.
Failure previously detected: uses Premiere parameter names and order. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: defaults are neutral where Premiere’s are (filters that start as identity)
Original location: `packages/project/test/fx-psdg.test.ts:191`.
Parameter catalogue/default inventory, private shader packing or padding formulas. Fails 3/4/5/6; actual GPU pixels and text rendering belong to compositions fx-gl; retained pure time hooks protect temporal semantics.
Failure previously detected: defaults are neutral where Premiere’s are (filters that start as identity). No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: centres and positions are point params; randomness via a \`seed\` param
Original location: `packages/project/test/fx-psdg.test.ts:201`.
Parameter catalogue/default inventory, private shader packing or padding formulas. Fails 3/4/5/6; actual GPU pixels and text rendering belong to compositions fx-gl; retained pure time hooks protect temporal semantics.
Failure previously detected: centres and positions are point params; randomness via a `seed` param. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: generator blending modes follow the AE list
Original location: `packages/project/test/fx-psdg.test.ts:210`.
Parameter catalogue/default inventory, private shader packing or padding formulas. Fails 3/4/5/6; actual GPU pixels and text rendering belong to compositions fx-gl; retained pure time hooks protect temporal semantics.
Failure previously detected: generator blending modes follow the AE list. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### REWRITE: Echo: offsets of k × Echo Time, intensities decay
Original location: `packages/project/test/fx-psdg.test.ts:219`.
Change: Remove self-equality of sample callback; retain fixed echo frame offsets and intensity decay.
1. Contract from the section source: Echo: offsets of k × Echo Time, intensities decay.
2. Detectable caller failure: Wrong echoed/held/strobed media frame or burned-in timecode; specifically the named case would return or store the wrong result.
3. Oracle: Remove self-equality of sample callback; retain fixed echo frame offsets and intensity decay.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes echo/posterize/strobe/timecode functions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “Echo: offsets of k × Echo Time, intensities decay” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: Posterize Time holds frames at the posterized rate
Original location: `packages/project/test/fx-psdg.test.ts:232`.
1. Contract from the section source: Posterize Time holds frames at the posterized rate.
2. Detectable caller failure: Wrong echoed/held/strobed media frame or burned-in timecode; specifically the named case would return or store the wrong result.
3. Oracle: expect(frames).toEqual([0, 0, 0, 3, 3, 3, 6, 6, 6]);; expect(posterizeTimeFrame({ frameRate: 60 }, { frame: 7, fps: 30 })).toBe(7);; expect(posterizeTimeFrame({ frameRate: 12 }, { frame: 25, fps: 24 })).toBe(24);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes echo/posterize/strobe/timecode functions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “Posterize Time holds frames at the posterized rate” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: Strobe Light fires for Strobe Duration at every Strobe Period (and randomly with probability)
Original location: `packages/project/test/fx-psdg.test.ts:240`.
1. Contract from the section source: Strobe Light fires for Strobe Duration at every Strobe Period (and randomly with probability).
2. Detectable caller failure: Wrong echoed/held/strobed media frame or burned-in timecode; specifically the named case would return or store the wrong result.
3. Oracle: expect([0, 1, 2, 3, 29, 30, 31, 33].map((f) => on(f))).toEqual([; expect(on(15, { probability: 100 })).toBe(true);; expect(n).toBeGreaterThan(30);; expect(n).toBeLessThan(90);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes echo/posterize/strobe/timecode functions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “Strobe Light fires for Strobe Duration at every Strobe Period (and randomly with probability)” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### DELETE: packs strings into floats (3 × 7 bits, exact in float32)
Original location: `packages/project/test/fx-psdg.test.ts:265`.
Parameter catalogue/default inventory, private shader packing or padding formulas. Fails 3/4/5/6; actual GPU pixels and text rendering belong to compositions fx-gl; retained pure time hooks protect temporal semantics.
Failure previously detected: packs strings into floats (3 × 7 bits, exact in float32). No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### KEEP: formats SMPTE (incl. drop-frame), frames and feet+frames
Original location: `packages/project/test/fx-psdg.test.ts:275`.
1. Contract from the section source: formats SMPTE (incl. drop-frame), frames and feet+frames.
2. Detectable caller failure: Wrong echoed/held/strobed media frame or burned-in timecode; specifically the named case would return or store the wrong result.
3. Oracle: expect(formatTimecode(0, '30', 'smpte')).toBe('00:00:00:00');; expect(formatTimecode(30 * 61 + 5, '30', 'smpte')).toBe('00:01:01:05');; expect(formatTimecode(25 * 3600, '25', 'smpte')).toBe('01:00:00:00');; expect(formatTimecode(1800, '30df', 'smpte')).toBe('00:01:00;02');. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes echo/posterize/strobe/timecode functions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “formats SMPTE (incl. drop-frame), frames and feet+frames” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### REWRITE: Timecode text per frame: source, offset, starting timecode, label
Original location: `packages/project/test/fx-psdg.test.ts:289`.
Change: Remove private uniform determinism/self-equality; retain exact SMPTE/user-label outputs.
1. Contract from the section source: Timecode text per frame: source, offset, starting timecode, label.
2. Detectable caller failure: Wrong echoed/held/strobed media frame or burned-in timecode; specifically the named case would return or store the wrong result.
3. Oracle: Remove private uniform determinism/self-equality; retain exact SMPTE/user-label outputs.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes echo/posterize/strobe/timecode functions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “Timecode text per frame: source, offset, starting timecode, label” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### DELETE: draw-outside effects pad, others do not
Original location: `packages/project/test/fx-psdg.test.ts:318`.
Parameter catalogue/default inventory, private shader packing or padding formulas. Fails 3/4/5/6; actual GPU pixels and text rendering belong to compositions fx-gl; retained pure time hooks protect temporal semantics.
Failure previously detected: draw-outside effects pad, others do not. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

## packages/project/test/fx-sapphire-glows-lighting.test.ts

### DELETE: ships the 25 Sapphire effects with their Sapphire names, registered, in Sapphire Lighting
Original location: `packages/project/test/fx-sapphire-glows-lighting.test.ts:55`.
Catalogue/default enumeration or internal pass/uniform/helper arrangement. A harmless shader implementation change fails it without changing output; fails 3/4/5/6. Real compiled/rendered effect pixels are owned by compositions fx-gl tests.
Failure previously detected: ships the 25 Sapphire effects with their Sapphire names, registered, in Sapphire Lighting. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: plans every effect with default and with extreme params (≤ 12 textures, finite padding)
Original location: `packages/project/test/fx-sapphire-glows-lighting.test.ts:65`.
Catalogue/default enumeration or internal pass/uniform/helper arrangement. A harmless shader implementation change fails it without changing output; fails 3/4/5/6. Real compiled/rendered effect pixels are owned by compositions fx-gl tests.
Failure previously detected: plans every effect with default and with extreme params (≤ 12 textures, finite padding). No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: keeps Sapphire defaults of the key controls
Original location: `packages/project/test/fx-sapphire-glows-lighting.test.ts:80`.
Catalogue/default enumeration or internal pass/uniform/helper arrangement. A harmless shader implementation change fails it without changing output; fails 3/4/5/6. Real compiled/rendered effect pixels are owned by compositions fx-gl tests.
Failure previously detected: keeps Sapphire defaults of the key controls. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: doubles the sigma per level, downscales wide levels, never coarsens back
Original location: `packages/project/test/fx-sapphire-glows-lighting.test.ts:124`.
Catalogue/default enumeration or internal pass/uniform/helper arrangement. A harmless shader implementation change fails it without changing output; fails 3/4/5/6. Real compiled/rendered effect pixels are owned by compositions fx-gl tests.
Failure previously detected: doubles the sigma per level, downscales wide levels, never coarsens back. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: keeps the short axis resolved for strongly stretched kernels
Original location: `packages/project/test/fx-sapphire-glows-lighting.test.ts:134`.
Catalogue/default enumeration or internal pass/uniform/helper arrangement. A harmless shader implementation change fails it without changing output; fails 3/4/5/6. Real compiled/rendered effect pixels are owned by compositions fx-gl tests.
Failure previously detected: keeps the short axis resolved for strongly stretched kernels. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: level weights are normalised; narrower channels shift their profile down
Original location: `packages/project/test/fx-sapphire-glows-lighting.test.ts:142`.
Catalogue/default enumeration or internal pass/uniform/helper arrangement. A harmless shader implementation change fails it without changing output; fails 3/4/5/6. Real compiled/rendered effect pixels are owned by compositions fx-gl tests.
Failure previously detected: level weights are normalised; narrower channels shift their profile down. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: Sapphire units and points
Original location: `packages/project/test/fx-sapphire-glows-lighting.test.ts:155`.
Catalogue/default enumeration or internal pass/uniform/helper arrangement. A harmless shader implementation change fails it without changing output; fails 3/4/5/6. Real compiled/rendered effect pixels are owned by compositions fx-gl tests.
Failure previously detected: Sapphire units and points. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: ray passes compose three radial combs; Rays Length maps to log scale ranges
Original location: `packages/project/test/fx-sapphire-glows-lighting.test.ts:166`.
Catalogue/default enumeration or internal pass/uniform/helper arrangement. A harmless shader implementation change fails it without changing output; fails 3/4/5/6. Real compiled/rendered effect pixels are owned by compositions fx-gl tests.
Failure previously detected: ray passes compose three radial combs; Rays Length maps to log scale ranges. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: jump flooding covers the reach with halving steps
Original location: `packages/project/test/fx-sapphire-glows-lighting.test.ts:177`.
Catalogue/default enumeration or internal pass/uniform/helper arrangement. A harmless shader implementation change fails it without changing output; fails 3/4/5/6. Real compiled/rendered effect pixels are owned by compositions fx-gl tests.
Failure previously detected: jump flooding covers the reach with halving steps. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: lenses pack into GLSL constants; the tracker plans 1–3 hotspots
Original location: `packages/project/test/fx-sapphire-glows-lighting.test.ts:184`.
Catalogue/default enumeration or internal pass/uniform/helper arrangement. A harmless shader implementation change fails it without changing output; fails 3/4/5/6. Real compiled/rendered effect pixels are owned by compositions fx-gl tests.
Failure previously detected: lenses pack into GLSL constants; the tracker plans 1–3 hotspots. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: time hooks: only the animated effects redraw per frame; the light leak passes its Center at mid-clip
Original location: `packages/project/test/fx-sapphire-glows-lighting.test.ts:206`.
Catalogue/default enumeration or internal pass/uniform/helper arrangement. A harmless shader implementation change fails it without changing output; fails 3/4/5/6. Real compiled/rendered effect pixels are owned by compositions fx-gl tests.
Failure previously detected: time hooks: only the animated effects redraw per frame; the light leak passes its Center at mid-clip. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: S_DropShadow pads towards the shift; S_Rays pads for its reach
Original location: `packages/project/test/fx-sapphire-glows-lighting.test.ts:217`.
Catalogue/default enumeration or internal pass/uniform/helper arrangement. A harmless shader implementation change fails it without changing output; fails 3/4/5/6. Real compiled/rendered effect pixels are owned by compositions fx-gl tests.
Failure previously detected: S_DropShadow pads towards the shift; S_Rays pads for its reach. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

## packages/project/test/gaps-audio-channels.test.ts

Independent sources: docs/wp-notes/gaps.md AU-7 channel routing. Production seam: routing API and document commands. Non-test callers: audio mixer, web Audio Channels and clip placement. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in wrong source channel, lost silence or invalid stored route.

### KEEP: matrix ⇄ routing round trip, with silent clip channels
Original location: `packages/project/test/gaps-audio-channels.test.ts:20`.
1. Contract from the section source: matrix ⇄ routing round trip, with silent clip channels.
2. Detectable caller failure: Wrong source channel, lost silence or invalid stored route; specifically the named case would return or store the wrong result.
3. Oracle: expect(sourceChannels(a).map((r) => r.label)).toEqual([; expect(r).toEqual({; expect(matrixOfRouting(a, (r as { clips: never[] }).clips)).toEqual([[0, 0], [1, 0], [2, 0], null]);; expect('error' in routingFromMatrix(a, 'stereo', 1, [[0, 0], [0, 0], null, null])).toBe(true);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes routing API and document commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “matrix ⇄ routing round trip, with silent clip channels” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: clip.setAudioChannels routes linked clips (undoable) and refuses what the media lacks
Original location: `packages/project/test/gaps-audio-channels.test.ts:41`.
1. Contract from the section source: clip.setAudioChannels routes linked clips (undoable) and refuses what the media lacks.
2. Detectable caller failure: Wrong source channel, lost silence or invalid stored route; specifically the named case would return or store the wrong result.
3. Oracle: expect((h.clips('A1')[0] as { channels: unknown }).channels).toEqual({ streamIndex: 1, map: [2, 3] });; expect(; expect(; expect(. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes routing API and document commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “clip.setAudioChannels routes linked clips (undoable) and refuses what the media lacks” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: a routed Project item places one clip per routed clip
Original location: `packages/project/test/gaps-audio-channels.test.ts:63`.
1. Contract from the section source: a routed Project item places one clip per routed clip.
2. Detectable caller failure: Wrong source channel, lost silence or invalid stored route; specifically the named case would return or store the wrong result.
3. Oracle: expect(audio.map((c) => c.channels.map).sort()).toEqual([[0], [1], [2, 3]]);; expect(Object.values(h.seq.clips).filter((c) => c.kind === 'audio')).toHaveLength(6);; expect(checkInvariants(h.doc)).toEqual([]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes routing API and document commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “a routed Project item places one clip per routed clip” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: repairs routings outside the media
Original location: `packages/project/test/gaps-audio-channels.test.ts:88`.
1. Contract from the section source: repairs routings outside the media.
2. Detectable caller failure: Wrong source channel, lost silence or invalid stored route; specifically the named case would return or store the wrong result.
3. Oracle: expect(checkInvariants(broken).some((i) => i.invariant === 'INV-CHANNELS')).toBe(true);; expect(report.some((r) => r.action === 'reset-channels')).toBe(true);; expect(checkInvariants(document).filter((i) => i.invariant === 'INV-CHANNELS')).toEqual([]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes routing API and document commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “repairs routings outside the media” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

## packages/project/test/gaps-find.test.ts

Independent sources: docs/wp-notes/gaps.md UI-5 Find contract. Production seam: findProjectItems/findTimelineHits/nextFindHit/matchesOperator. Non-test callers: web Find dialog and MCP find. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in missing/wrong result or wrong find next position.

### KEEP: operators
Original location: `packages/project/test/gaps-find.test.ts:29`.
1. Contract from the section source: operators.
2. Detectable caller failure: Missing/wrong result or wrong Find Next position; specifically the named case would return or store the wrong result.
3. Oracle: expect(matchesOperator('Interview Wide', 'contains', 'view')).toBe(true);; expect(matchesOperator('Interview Wide', 'contains', 'VIEW', true)).toBe(false);; expect(matchesOperator('Interview Wide', 'begins', 'inter')).toBe(true);; expect(matchesOperator('Interview Wide', 'ends', 'wide')).toBe(true);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes findProjectItems/findTimelineHits/nextFindHit/matchesOperator through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “operators” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: finds project items by name, label, type and frame size with all/any
Original location: `packages/project/test/gaps-find.test.ts:38`.
1. Contract from the section source: finds project items by name, label, type and frame size with all/any.
2. Detectable caller failure: Missing/wrong result or wrong Find Next position; specifically the named case would return or store the wrong result.
3. Oracle: expect(byName).toEqual([items[0]!.id]);; expect(byLabel).toEqual([items[1]!.id]);; expect(bySize).toEqual([items[1]!.id]);; expect(all).toEqual([items[1]!.id]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes findProjectItems/findTimelineHits/nextFindHit/matchesOperator through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “finds project items by name, label, type and frame size with all/any” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: finds timeline clips and markers in frame order and steps with Find Next
Original location: `packages/project/test/gaps-find.test.ts:79`.
1. Contract from the section source: finds timeline clips and markers in frame order and steps with Find Next.
2. Detectable caller failure: Missing/wrong result or wrong Find Next position; specifically the named case would return or store the wrong result.
3. Oracle: expect(hits.map((x) => x.kind)).toContain('marker');; expect(hits.map((x) => x.frame)).toEqual([...hits.map((x) => x.frame)].sort((a, b) => a - b));; expect(clipHits.length).toBeGreaterThanOrEqual(1);; expect(clipHits.every((c) => c.frame === 120)).toBe(true);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes findProjectItems/findTimelineHits/nextFindHit/matchesOperator through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “finds timeline clips and markers in frame order and steps with Find Next” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: never throws on arbitrary queries (property)
Original location: `packages/project/test/gaps-find.test.ts:104`.
1. Contract from the section source: never throws on arbitrary queries (property).
2. Detectable caller failure: Missing/wrong result or wrong Find Next position; specifically the named case would return or store the wrong result.
3. Oracle: Property assertions over fixed scenario or independently generated inputs in the named test.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes findProjectItems/findTimelineHits/nextFindHit/matchesOperator through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “never throws on arbitrary queries (property)” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

## packages/project/test/gaps-graphics.test.ts

Independent sources: docs/wp-notes/gaps.md GR-4/GR-5 graphics and .jgt protocol. Production seam: graphics math, transaction and template import API. Non-test callers: web graphics commands and render snapshot pipeline. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in wrong layer alignment/timing or lost imported graphic data.

### KEEP: rejects a malformed template payload before importing project items
Original location: `packages/project/test/gaps-graphics.test.ts:40`.
1. Contract from the section source: rejects a malformed template payload before importing project items.
2. Detectable caller failure: Wrong layer alignment/timing or lost imported graphic data; specifically the named case would return or store the wrong result.
3. Oracle: expect(result).toMatchObject({ ok: false, errors: [{ code: 'E_SCHEMA', path: ['payload'] }] });; expect(h.doc).toBe(before);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes graphics math, transaction and template import API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “rejects a malformed template payload before importing project items” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: refuses layer pins on caption clips without changing the project
Original location: `packages/project/test/gaps-graphics.test.ts:60`.
1. Contract from the section source: refuses layer pins on caption clips without changing the project.
2. Detectable caller failure: Wrong layer alignment/timing or lost imported graphic data; specifically the named case would return or store the wrong result.
3. Oracle: expect(result).toMatchObject({ ok: false, errors: [{ code: 'E_INVALID_PARAM' }] });; expect(h.doc).toBe(before);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes graphics math, transaction and template import API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “refuses layer pins on caption clips without changing the project” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: align / distribute offsets
Original location: `packages/project/test/gaps-graphics.test.ts:81`.
1. Contract from the section source: align / distribute offsets.
2. Detectable caller failure: Wrong layer alignment/timing or lost imported graphic data; specifically the named case would return or store the wrong result.
3. Oracle: expect(alignOffsets(rects, 'left', frame).map((o) => o[0])).toEqual([-10, -300, -150]);; expect(alignOffsets(rects, 'center', frame)[0]).toEqual([960 - 60, 0]);; expect(xs[1]!.l - xs[0]!.r).toBeCloseTo(xs[2]!.l - xs[1]!.r, 6);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes graphics math, transaction and template import API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “align / distribute offsets” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: responsive time keeps the intro and the outro
Original location: `packages/project/test/gaps-graphics.test.ts:97`.
1. Contract from the section source: responsive time keeps the intro and the outro.
2. Detectable caller failure: Wrong layer alignment/timing or lost imported graphic data; specifically the named case would return or store the wrong result.
3. Oracle: expect(responsiveGraphicTime(10, 300, 150, 15, 15)).toBe(10);; expect(responsiveGraphicTime(290, 300, 150, 15, 15)).toBe(140);; expect(responsiveGraphicTime(150, 300, 150, 15, 15)).toBeCloseTo(75, 6);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes graphics math, transaction and template import API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “responsive time keeps the intro and the outro” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: roll from below to above the frame with pre-roll and post-roll
Original location: `packages/project/test/gaps-graphics.test.ts:103`.
1. Contract from the section source: roll from below to above the frame with pre-roll and post-roll.
2. Detectable caller failure: Wrong layer alignment/timing or lost imported graphic data; specifically the named case would return or store the wrong result.
3. Oracle: expect(at(0)[1]).toBeCloseTo(1080 + 1500, 6);; expect(at(10)[1]).toBeCloseTo(1080 + 1500, 6);; expect(at(100)[1]).toBeCloseTo(-1500, 6);; expect(at(55)[1]).toBeCloseTo((1080 + 1500 - 1500) / 2, 6);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes graphics math, transaction and template import API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “roll from below to above the frame with pre-roll and post-roll” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: commands: make a graphic, add layers, align, pin, undo, refusals
Original location: `packages/project/test/gaps-graphics.test.ts:141`.
1. Contract from the section source: commands: make a graphic, add layers, align, pin, undo, refusals.
2. Detectable caller failure: Wrong layer alignment/timing or lost imported graphic data; specifically the named case would return or store the wrong result.
3. Oracle: expect((g() as { graphic?: unknown }).graphic).toEqual({ intro: 15, outro: 15, roll: null });; expect(g().videoTracks.length).toBeGreaterThanOrEqual(2);; expect(g().clips[rect]!.duration).toBe(150);; expect(fxList(g().clips[rect]).transform.position.value[0]).toBeCloseTo(box.width / 2, 3);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes graphics math, transaction and template import API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “commands: make a graphic, add layers, align, pin, undo, refusals” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: roll keys on the nest; dangling pins are reported and repaired
Original location: `packages/project/test/gaps-graphics.test.ts:180`.
1. Contract from the section source: roll keys on the nest; dangling pins are reported and repaired.
2. Detectable caller failure: Wrong layer alignment/timing or lost imported graphic data; specifically the named case would return or store the wrong result.
3. Oracle: expect((evaluate(pos, 0) as [number, number])[1]).toBeCloseTo(1080 + 540, 3);; expect(checkInvariants(broken).some((i) => i.invariant === 'INV-GRAPHIC')).toBe(true);; expect(checkInvariants(repairDocument(broken, h.ids).document)).toEqual([]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes graphics math, transaction and template import API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “roll keys on the nest; dangling pins are reported and repaired” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### REWRITE: .jgt templates round-trip a graphic
Original location: `packages/project/test/gaps-graphics.test.ts:211`.
Change: Verify imported graphic timing and Title text survive JSON serialization/import; remove declaration equality and mere output-count checks.
1. Contract from the section source: .jgt templates round-trip a graphic.
2. Detectable caller failure: Wrong layer alignment/timing or lost imported graphic data; specifically the named case would return or store the wrong result.
3. Oracle: Verify imported graphic timing and Title text survive JSON serialization/import; remove declaration equality and mere output-count checks.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes graphics math, transaction and template import API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “.jgt templates round-trip a graphic” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

## packages/project/test/gaps-sequence-format.test.ts

Independent sources: docs/wp-notes/gaps.md sequence formats; persisted Sequence settings. Production seam: sequence format API, commands and repair. Non-test callers: new-sequence dialog, clip-derived sequences and render snapshots. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in distorted anamorphic sequence or invalid settings.

### KEEP: display width of storage widths
Original location: `packages/project/test/gaps-sequence-format.test.ts:6`.
1. Contract from the section source: display width of storage widths.
2. Detectable caller failure: Distorted anamorphic sequence or invalid settings; specifically the named case would return or store the wrong result.
3. Oracle: expect(displayWidthOf(720, { num: 10, den: 11 })).toBe(654);; expect(displayWidthOf(1440, { num: 4, den: 3 })).toBe(1920);; expect(displayWidthOf(1280, { num: 3, den: 2 })).toBe(1920);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes sequence format API, commands and repair through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “display width of storage widths” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: a pixel aspect ratio makes width the display width; square restores the storage width; undoable
Original location: `packages/project/test/gaps-sequence-format.test.ts:12`.
1. Contract from the section source: a pixel aspect ratio makes width the display width; square restores the storage width; undoable.
2. Detectable caller failure: Distorted anamorphic sequence or invalid settings; specifically the named case would return or store the wrong result.
3. Oracle: expect(h.seq.settings.width).toBe(1920);; expect(sequenceFormatOf(h.seq.settings)).toMatchObject({ storageWidth: 1440, par: { num: 4, den: 3 } });; expect(sequenceFormatOf(h.seq.settings).fieldOrder).toBe('upper');; expect(. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes sequence format API, commands and repair through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “a pixel aspect ratio makes width the display width; square restores the storage width; undoable” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: New Sequence From Clip matches an anamorphic interlaced clip
Original location: `packages/project/test/gaps-sequence-format.test.ts:38`.
1. Contract from the section source: New Sequence From Clip matches an anamorphic interlaced clip.
2. Detectable caller failure: Distorted anamorphic sequence or invalid settings; specifically the named case would return or store the wrong result.
3. Oracle: expect(seq.settings.width).toBe(1920);; expect(sequenceFormatOf(seq.settings)).toMatchObject({ storageWidth: 1440, fieldOrder: 'upper' });; expect(Object.values(seq.clips).length).toBeGreaterThan(0);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes sequence format API, commands and repair through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “New Sequence From Clip matches an anamorphic interlaced clip” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: repairs an inconsistent format to square pixels
Original location: `packages/project/test/gaps-sequence-format.test.ts:53`.
1. Contract from the section source: repairs an inconsistent format to square pixels.
2. Detectable caller failure: Distorted anamorphic sequence or invalid settings; specifically the named case would return or store the wrong result.
3. Oracle: expect(checkInvariants(broken).some((i) => i.invariant === 'INV-SEQUENCE-FORMAT')).toBe(true);; expect(report.some((x) => x.action === 'reset-sequence-format')).toBe(true);; expect(checkInvariants(document).filter((i) => i.invariant === 'INV-SEQUENCE-FORMAT')).toEqual([]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes sequence format API, commands and repair through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “repairs an inconsistent format to square pixels” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

## packages/project/test/gaps-warp-stabilizer.test.ts

Independent sources: docs/wp-notes/gaps.md FX-6; licenses/ported/gaps.md stabilization equations. Production seam: stabilization mathematics/output mapping and analysis commands. Non-test callers: engine warp analysis and preview/export stabilizer. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in wrong corrected image trajectory, scale/crop or stored analysis.

### KEEP: least squares recovers a homography and a similarity
Original location: `packages/project/test/gaps-warp-stabilizer.test.ts:57`.
1. Contract from the section source: least squares recovers a homography and a similarity.
2. Detectable caller failure: Wrong corrected image trajectory, scale/crop or stored analysis; specifically the named case would return or store the wrong result.
3. Oracle: expect(hMaxDiff(leastSquares('homography', src, dst)!, h)).toBeLessThan(1e-6);; expect(. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes stabilization mathematics/output mapping and analysis commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “least squares recovers a homography and a similarity” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: Smooth Motion removes jitter for every method; No Motion locks the scene
Original location: `packages/project/test/gaps-warp-stabilizer.test.ts:76`.
1. Contract from the section source: Smooth Motion removes jitter for every method; No Motion locks the scene.
2. Detectable caller failure: Wrong corrected image trajectory, scale/crop or stored analysis; specifically the named case would return or store the wrong result.
3. Oracle: expect(jitter(after)).toBeLessThan(0.2 * jitter(before));; expect(Math.abs(q[0] - fixed[45]![0])).toBeLessThan(1e-6);; expect(Math.abs(q[1] - fixed[45]![1])).toBeLessThan(1e-6);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes stabilization mathematics/output mapping and analysis commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “Smooth Motion removes jitter for every method; No Motion locks the scene” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: framing crops, auto-scales and respects Maximum Scale
Original location: `packages/project/test/gaps-warp-stabilizer.test.ts:96`.
1. Contract from the section source: framing crops, auto-scales and respects Maximum Scale.
2. Detectable caller failure: Wrong corrected image trajectory, scale/crop or stored analysis; specifically the named case would return or store the wrong result.
3. Oracle: expect(crop.autoScale).toBe(1);; expect(r[0]).toBeGreaterThan(0);; expect(r[2]).toBeLessThan(640);; expect(s[0]).toBeGreaterThanOrEqual(-1e-6);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes stabilization mathematics/output mapping and analysis commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “framing crops, auto-scales and respects Maximum Scale” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: Preserve Scale removes the zoom of the correction
Original location: `packages/project/test/gaps-warp-stabilizer.test.ts:140`.
1. Contract from the section source: Preserve Scale removes the zoom of the correction.
2. Detectable caller failure: Wrong corrected image trajectory, scale/crop or stored analysis; specifically the named case would return or store the wrong result.
3. Oracle: expect(Math.max(...zoomy.map((h) => Math.abs(scaleOf(h) - 1)))).toBeGreaterThan(0.005);; expect(Math.abs(scaleOf(h) - 1)).toBeLessThan(1e-6);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes stabilization mathematics/output mapping and analysis commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “Preserve Scale removes the zoom of the correction” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: meshes: identity, homography meshes are exact for affine maps, forward inverts sample
Original location: `packages/project/test/gaps-warp-stabilizer.test.ts:159`.
1. Contract from the section source: meshes: identity, homography meshes are exact for affine maps, forward inverts sample.
2. Detectable caller failure: Wrong corrected image trajectory, scale/crop or stored analysis; specifically the named case would return or store the wrong result.
3. Oracle: expect(m.sample([37, 21])).toEqual([37, 21]);; expect(m.validFraction()).toBe(1);; expect(Math.abs(p[0] - e[0])).toBeLessThan(1e-6);; expect(hMaxDiff(mh.homography(), h)).toBeLessThan(1e-6);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes stabilization mathematics/output mapping and analysis commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “meshes: identity, homography meshes are exact for affine maps, forward inverts sample” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: solveMesh bends for local motion (banded solve)
Original location: `packages/project/test/gaps-warp-stabilizer.test.ts:172`.
1. Contract from the section source: solveMesh bends for local motion (banded solve).
2. Detectable caller failure: Wrong corrected image trajectory, scale/crop or stored analysis; specifically the named case would return or store the wrong result.
3. Oracle: expect(errMesh).toBeLessThan(0.35 * errH);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes stabilization mathematics/output mapping and analysis commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “solveMesh bends for local motion (banded solve)” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### REWRITE: Subspace Warp beats Perspective on parallax trajectories
Original location: `packages/project/test/gaps-warp-stabilizer.test.ts:194`.
Change: Remove internal mesh/trajectory counts, retain measured residual improvement and inverse output mapping.
1. Contract from the section source: Subspace Warp beats Perspective on parallax trajectories.
2. Detectable caller failure: Wrong corrected image trajectory, scale/crop or stored analysis; specifically the named case would return or store the wrong result.
3. Oracle: Remove internal mesh/trajectory counts, retain measured residual improvement and inverse output mapping.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes stabilization mathematics/output mapping and analysis commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “Subspace Warp beats Perspective on parallax trajectories” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### REWRITE: maps clip frames to analysed frames through the clip in-point and speed
Original location: `packages/project/test/gaps-warp-stabilizer.test.ts:283`.
Change: Remove private settings mapping, sampling offsets and cache identity. Retain independently calculated time 0.6 s, frame 18 and clamped frame 29.
1. Contract from the section source: maps clip frames to analysed frames through the clip in-point and speed.
2. Detectable caller failure: Wrong corrected image trajectory, scale/crop or stored analysis; specifically the named case would return or store the wrong result.
3. Oracle: Remove private settings mapping, sampling offsets and cache identity. Retain independently calculated time 0.6 s, frame 18 and clamped frame 29.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes stabilization mathematics/output mapping and analysis commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “maps clip frames to analysed frames through the clip in-point and speed” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: effect.setWarpAnalysis stores, clears, undoes and refuses
Original location: `packages/project/test/gaps-warp-stabilizer.test.ts:300`.
1. Contract from the section source: effect.setWarpAnalysis stores, clears, undoes and refuses.
2. Detectable caller failure: Wrong corrected image trajectory, scale/crop or stored analysis; specifically the named case would return or store the wrong result.
3. Oracle: expect(defaultEffectRegistry.get('jasper.warp-stabilizer')?.gpu).toBeTruthy();; expect(fxOf().warpAnalysis?.key).toBe('test-10');; expect(checkInvariants(h.doc)).toEqual([]);; expect(. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes stabilization mathematics/output mapping and analysis commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “effect.setWarpAnalysis stores, clears, undoes and refuses” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

## packages/project/test/invariants-incremental.test.ts

Independent sources: AGENTS.md §0 invariants; docs/wp-notes/perf-core.md full/incremental equivalence. Production seam: checkTransactionInvariants/applyTransaction. Non-test callers: session, engine and UI document editing. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in corruption accepted or valid edit rejected after prior edits.

### DELETE: tests run in verify mode (the full check decides, the incremental one must agree)
Original location: `packages/project/test/invariants-incremental.test.ts:347`.
Asserts test environment selection or exact private branch counters/fallback object; no document behavior. Fails 2/4/5; retained corruption and long edit-chain tests protect validity.
Failure previously detected: tests run in verify mode (the full check decides, the incremental one must agree). No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### KEEP: equals the full check on ${RUNS} random chains of edits and corruptions
Original location: `packages/project/test/invariants-incremental.test.ts:351`.
1. Contract from the section source: equals the full check on ${RUNS} random chains of edits and corruptions.
2. Detectable caller failure: Corruption accepted or valid edit rejected after prior edits; specifically the named case would return or store the wrong result.
3. Oracle: expect(checkInvariants(start, opts)).toEqual([]);; expect(r.result.errors.some((e) => e.code === 'E_INTERNAL')).toBe(false);; expect(checkTransactionInvariants(doc, next, opts, 'incremental')).toEqual(full);; expect(checkTransactionInvariants(doc, next, opts, 'verify')).toEqual(full);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes checkTransactionInvariants/applyTransaction through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “equals the full check on ${RUNS} random chains of edits and corruptions” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### REWRITE: keeps the id index exact over long chains (past the flattening depth)
Original location: `packages/project/test/invariants-incremental.test.ts:397`.
Change: Remove cache-membership assertion. Verify all 150 named added markers are stored and the final document satisfies full invariants; transactions already must succeed.
1. Contract from the section source: keeps the id index exact over long chains (past the flattening depth).
2. Detectable caller failure: Corruption accepted or valid edit rejected after prior edits; specifically the named case would return or store the wrong result.
3. Oracle: Remove cache-membership assertion. Verify all 150 named added markers are stored and the final document satisfies full invariants; transactions already must succeed.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes checkTransactionInvariants/applyTransaction through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “keeps the id index exact over long chains (past the flattening depth)” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### DELETE: takes the incremental path for common edits
Original location: `packages/project/test/invariants-incremental.test.ts:420`.
Asserts test environment selection or exact private branch counters/fallback object; no document behavior. Fails 2/4/5; retained corruption and long edit-chain tests protect validity.
Failure previously detected: takes the incremental path for common edits. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

## packages/project/test/json-cache.test.ts

Independent sources: ECMAScript JSON.stringify serialization contract; docs/wp-notes/ui-perf.md byte equivalence. Production seam: stringifyJson. Non-test callers: session atomic autosave and project persistence. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in saved json bytes differ from standard serialization or become stale.

### KEEP: equals JSON.stringify on arbitrary JSON values, frozen or not, cold and cached
Original location: `packages/project/test/json-cache.test.ts:23`.
1. Contract from the section source: equals JSON.stringify on arbitrary JSON values, frozen or not, cold and cached.
2. Detectable caller failure: Saved JSON bytes differ from standard serialization or become stale; specifically the named case would return or store the wrong result.
3. Oracle: expect(stringifyJson(v)).toBe(JSON.stringify(v));; expect(stringifyJson(v)).toBe(JSON.stringify(v));. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes stringifyJson through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “equals JSON.stringify on arbitrary JSON values, frozen or not, cold and cached” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: equals JSON.stringify on large containers (composed) with every special value
Original location: `packages/project/test/json-cache.test.ts:34`.
1. Contract from the section source: equals JSON.stringify on large containers (composed) with every special value.
2. Detectable caller failure: Saved JSON bytes differ from standard serialization or become stale; specifically the named case would return or store the wrong result.
3. Oracle: expect(stringifyJson(big)).toBe(JSON.stringify(big));; expect(stringifyJson(frozen)).toBe(JSON.stringify(frozen));; expect(stringifyJson(frozen)).toBe(JSON.stringify(frozen));; expect(stringifyJson(undefined)).toBe(JSON.stringify(undefined));. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes stringifyJson through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “equals JSON.stringify on large containers (composed) with every special value” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: throws like JSON.stringify on cycles and BigInt
Original location: `packages/project/test/json-cache.test.ts:63`.
1. Contract from the section source: throws like JSON.stringify on cycles and BigInt.
2. Detectable caller failure: Saved JSON bytes differ from standard serialization or become stale; specifically the named case would return or store the wrong result.
3. Oracle: expect(() => stringifyJson(cyc)).toThrow(TypeError);; expect(() => stringifyJson({ big: 1n })).toThrow(TypeError);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes stringifyJson through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “throws like JSON.stringify on cycles and BigInt” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: never caches objects that can still change
Original location: `packages/project/test/json-cache.test.ts:72`.
1. Contract from the section source: never caches objects that can still change.
2. Detectable caller failure: Saved JSON bytes differ from standard serialization or become stale; specifically the named case would return or store the wrong result.
3. Oracle: expect(stringifyJson(doc)).toBe(JSON.stringify(doc));; expect(stringifyJson(doc)).not.toBe(a);; expect(stringifyJson(shallow)).toBe(JSON.stringify(shallow));. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes stringifyJson through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “never caches objects that can still change” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: follows Immer edits of a frozen tree
Original location: `packages/project/test/json-cache.test.ts:86`.
1. Contract from the section source: follows Immer edits of a frozen tree.
2. Detectable caller failure: Saved JSON bytes differ from standard serialization or become stale; specifically the named case would return or store the wrong result.
3. Oracle: expect(stringifyJson(state)).toBe(JSON.stringify(state));. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes stringifyJson through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “follows Immer edits of a frozen tree” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### DELETE: matches the project envelope after every edit of a real document
Original location: `packages/project/test/json-cache.test.ts:103`.
Real-envelope case duplicates JSON/Immer equivalence already at the lowest serializer seam; warm-up case couples to cache task granularity and identity. Fails 5/6; five retained JSON.stringify comparisons own serialized bytes.
Failure previously detected: matches the project envelope after every edit of a real document. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: warm-up units fill the cache with the same text, and a warmed document has none left
Original location: `packages/project/test/json-cache.test.ts:135`.
Real-envelope case duplicates JSON/Immer equivalence already at the lowest serializer seam; warm-up case couples to cache task granularity and identity. Fails 5/6; five retained JSON.stringify comparisons own serialized bytes.
Failure previously detected: warm-up units fill the cache with the same text, and a warmed document has none left. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

## packages/project/test/keyframe-effect.test.ts

Independent sources: docs/specs/01-project-model-and-state.md KF-006/KF-007; docs/wp-notes/keyframes-blend.md; commands API; native FFmpeg protocol. Production seam: transaction/parameter/keyframe API and renderer adapter. Non-test callers: UI effect controls, MCP and preview/export. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in incorrect parameter/effect/animation, refusal, or native rendering filter.

### KEEP: AC-10 (blur half): an agent transaction creates a text clip and blurs it through a temp ref
Original location: `packages/project/test/keyframe-effect.test.ts:61`.
1. Contract from the section source: AC-10 (blur half): an agent transaction creates a text clip and blurs it through a temp ref.
2. Detectable caller failure: Incorrect parameter/effect/animation, refusal, or native rendering filter; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.refs.$blur).toMatch(/^fx_/);; expect(clip.effects).toHaveLength(1);; expect(clip.effects[0]).toMatchObject({; expect(clip.effects[0]!.params.radius).toEqual({ value: 6, keyframes: [] });. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transaction/parameter/keyframe API and renderer adapter through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “AC-10 (blur half): an agent transaction creates a text clip and blurs it through a temp ref” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: inserts at an index, validates and clamps params, refuses unknown ids and wrong targets
Original location: `packages/project/test/keyframe-effect.test.ts:97`.
1. Contract from the section source: inserts at an index, validates and clamps params, refuses unknown ids and wrong targets.
2. Detectable caller failure: Incorrect parameter/effect/animation, refusal, or native rendering filter; specifically the named case would return or store the wrong result.
3. Oracle: expect(clipOf(h, id).effects.map((e) => e.effectId)).toEqual([; expect(clamped.warnings.map((w) => w.code)).toContain('W_VALUE_CLAMPED');; expect(clipOf(h, id).effects[3]!.params.radius!.value).toBe(500);; expect(res.ok, JSON.stringify(cmd)).toBe(false);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transaction/parameter/keyframe API and renderer adapter through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “inserts at an index, validates and clamps params, refuses unknown ids and wrong targets” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: validates animated param overrides (pasted/agent keyframes) field by field
Original location: `packages/project/test/keyframe-effect.test.ts:151`.
1. Contract from the section source: validates animated param overrides (pasted/agent keyframes) field by field.
2. Detectable caller failure: Incorrect parameter/effect/animation, refusal, or native rendering filter; specifically the named case would return or store the wrong result.
3. Oracle: expect(res.ok, JSON.stringify(bad)).toBe(false);; expect(res.errors[0]!.code).toBe('E_INVALID_PARAM');; expect(h.doc).toBe(before);; expect(radius.keyframes.map((x) => x.time)).toEqual([0, 10 * F]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transaction/parameter/keyframe API and renderer adapter through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “validates animated param overrides (pasted/agent keyframes) field by field” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: refuses video effects on audio clips and edits on locked tracks
Original location: `packages/project/test/keyframe-effect.test.ts:186`.
1. Contract from the section source: refuses video effects on audio clips and edits on locked tracks.
2. Detectable caller failure: Incorrect parameter/effect/animation, refusal, or native rendering filter; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.ok).toBe(false);; expect(r.errors[0]!.code).toBe('E_INVALID_PARAM');; expect(res.ok).toBe(false);; expect(res.errors[0]!.code).toBe('E_TRACK_LOCKED');. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transaction/parameter/keyframe API and renderer adapter through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “refuses video effects on audio clips and edits on locked tracks” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: removes, reorders and bypasses; reorder clamps the index
Original location: `packages/project/test/keyframe-effect.test.ts:211`.
1. Contract from the section source: removes, reorders and bypasses; reorder clamps the index.
2. Detectable caller failure: Incorrect parameter/effect/animation, refusal, or native rendering filter; specifically the named case would return or store the wrong result.
3. Oracle: expect(clipOf(h, id).effects.map((e) => e.id)).toEqual([b, c, a]);; expect(clipOf(h, id).effects.map((e) => e.id)).toEqual([a, b, c]);; expect(clipOf(h, id).effects[1]!.enabled).toBe(false);; expect(clipOf(h, id).effects.map((e) => e.id)).toEqual([a, b]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transaction/parameter/keyframe API and renderer adapter through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “removes, reorders and bypasses; reorder clamps the index” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: supports track and master targets with an audio effect registry
Original location: `packages/project/test/keyframe-effect.test.ts:232`.
1. Contract from the section source: supports track and master targets with an audio effect registry.
2. Detectable caller failure: Incorrect parameter/effect/animation, refusal, or native rendering filter; specifically the named case would return or store the wrong result.
3. Oracle: expect(h.seq.audioTracks[0]!.effects![0]!.params.db!.value).toBe(-6);; expect(master.id).toBe(r.refs.$m);; expect(master.params.db!.keyframes.map((k) => [k.time, k.value])).toEqual([; expect(vid.ok).toBe(false);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transaction/parameter/keyframe API and renderer adapter through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “supports track and master targets with an audio effect registry” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: FX-022: unknown effects are preserved, reorderable, removable and not editable
Original location: `packages/project/test/keyframe-effect.test.ts:279`.
1. Contract from the section source: FX-022: unknown effects are preserved, reorderable, removable and not editable.
2. Detectable caller failure: Incorrect parameter/effect/animation, refusal, or native rendering filter; specifically the named case would return or store the wrong result.
3. Oracle: expect(kept).toEqual({ ...future, enabled: false });; expect(!edit.ok && edit.errors[0]!.code).toBe('E_UNKNOWN_EFFECT');; expect(clipOf(h, id).effects.map((e) => e.effectId)).toEqual(['jasper.crop']);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transaction/parameter/keyframe API and renderer adapter through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “FX-022: unknown effects are preserved, reorderable, removable and not editable” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: AC-EC-1: stopwatch at frame 10 + value at frame 40 gives a linear ramp everywhere
Original location: `packages/project/test/keyframe-effect.test.ts:305`.
1. Contract from the section source: AC-EC-1: stopwatch at frame 10 + value at frame 40 gives a linear ramp everywhere.
2. Detectable caller failure: Incorrect parameter/effect/animation, refusal, or native rendering filter; specifically the named case would return or store the wrong result.
3. Oracle: expect(clipOf(h, id).opacity.keyframes.map((k) => k.value)).toEqual([20]);; expect(resolvePropertyAt(ctx, getPropertySpec('opacity')!, frame).value).toBeCloseTo(want, 9);; expect(resolveSceneAt(snapshot, frame)[0]!.props.opacity).toBeCloseTo(want, 9);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transaction/parameter/keyframe API and renderer adapter through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “AC-EC-1: stopwatch at frame 10 + value at frame 40 gives a linear ramp everywhere” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: AC-EC-2 / AC-08: Ease Out, Ease In and Easy Ease match the Bézier table
Original location: `packages/project/test/keyframe-effect.test.ts:336`.
1. Contract from the section source: AC-EC-2 / AC-08: Ease Out, Ease In and Easy Ease match the Bézier table.
2. Detectable caller failure: Incorrect parameter/effect/animation, refusal, or native rendering filter; specifically the named case would return or store the wrong result.
3. Oracle: expect(opacityAt(h, id, 50)).toBeCloseTo(50, 9);; expect(opacityAt(h, id, 50)).toBeCloseTo(37.5, 6);; expect(opacityAt(h, id, 50)).toBeCloseTo(62.5, 6);; expect(opacityAt(h, id, 50)).toBeCloseTo(50, 6);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transaction/parameter/keyframe API and renderer adapter through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “AC-EC-2 / AC-08: Ease Out, Ease In and Easy Ease match the Bézier table” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: keyframe.add replaces at the same time, keyframe.update edits, keyframe.remove of the last key keeps its value
Original location: `packages/project/test/keyframe-effect.test.ts:366`.
1. Contract from the section source: keyframe.add replaces at the same time, keyframe.update edits, keyframe.remove of the last key keeps its value.
2. Detectable caller failure: Incorrect parameter/effect/animation, refusal, or native rendering filter; specifically the named case would return or store the wrong result.
3. Oracle: expect(scale().keyframes).toEqual([; expect((again.results[0] as { keyframeId: string }).keyframeId).toBe(k);; expect(scale().keyframes).toHaveLength(1);; expect(scale().keyframes[0]).toMatchObject({ value: 175, interpolation: 'hold' });. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transaction/parameter/keyframe API and renderer adapter through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “keyframe.add replaces at the same time, keyframe.update edits, keyframe.remove of the last key keeps its value” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: keyframe.move shifts by whole frames, replaces a key it lands on and refuses negative times
Original location: `packages/project/test/keyframe-effect.test.ts:391`.
1. Contract from the section source: keyframe.move shifts by whole frames, replaces a key it lands on and refuses negative times.
2. Detectable caller failure: Incorrect parameter/effect/animation, refusal, or native rendering filter; specifically the named case would return or store the wrong result.
3. Oracle: expect(clipOf(h, id).opacity.keyframes.map((k) => k.time / F)).toEqual([0, 15, 20]);; expect(keys.map((k) => [k.id, k.time / F, k.value])).toEqual([; expect(clipOf(h, id).opacity.keyframes[0]!.time).toBe(2 * F);; expect(!neg.ok && neg.errors[0]!.code).toBe('E_INVALID_PARAM');. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transaction/parameter/keyframe API and renderer adapter through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “keyframe.move shifts by whole frames, replaces a key it lands on and refuses negative times” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: auto-bezier updates after a neighbour moves and preserves its curve when changed to bezier
Original location: `packages/project/test/keyframe-effect.test.ts:415`.
1. Contract from the section source: auto-bezier updates after a neighbour moves and preserves its curve when changed to bezier.
2. Detectable caller failure: Incorrect parameter/effect/animation, refusal, or native rendering filter; specifically the named case would return or store the wrong result.
3. Oracle: expect(opacityAt(h, id, 20)).toBeCloseTo(250 / 3, 6);; expect(opacityAt(h, id, 25)).toBeCloseTo(84.375, 6);; expect(opacityAt(h, id, frame)).toBeCloseTo(autoCurve[i]!, 6);; expect(opacityAt(h, id, f)).toBeLessThanOrEqual(50 + 1e-9);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transaction/parameter/keyframe API and renderer adapter through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “auto-bezier updates after a neighbour moves and preserves its curve when changed to bezier” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: continuous bezier keeps equal velocity on both sides of a key
Original location: `packages/project/test/keyframe-effect.test.ts:441`.
1. Contract from the section source: continuous bezier keeps equal velocity on both sides of a key.
2. Detectable caller failure: Incorrect parameter/effect/animation, refusal, or native rendering filter; specifically the named case would return or store the wrong result.
3. Oracle: expect(incoming).toBeCloseTo(outgoing, 2);; expect(incoming).toBeCloseTo(5, 2);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transaction/parameter/keyframe API and renderer adapter through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “continuous bezier keeps equal velocity on both sides of a key” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: AC-EC-3 / AC-06: splitting eased position animation keeps motion identical (≤ 0.001 px)
Original location: `packages/project/test/keyframe-effect.test.ts:461`.
1. Contract from the section source: AC-EC-3 / AC-06: splitting eased position animation keeps motion identical (≤ 0.001 px).
2. Detectable caller failure: Incorrect parameter/effect/animation, refusal, or native rendering filter; specifically the named case would return or store the wrong result.
3. Oracle: expect(right!.transform.position.keyframes).toHaveLength(3);; expect(right!.transform.position.keyframes[0]!.id).not.toBe(left!.transform.position.keyframes[0]!.id);; expect(err(f)).toBeLessThanOrEqual(0.001);; expect(err(f)).toBeLessThanOrEqual(0.001);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transaction/parameter/keyframe API and renderer adapter through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “AC-EC-3 / AC-06: splitting eased position animation keeps motion identical (≤ 0.001 px)” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: keyframes.prune removes keys that cannot affect the visible range (S01:KF-006)
Original location: `packages/project/test/keyframe-effect.test.ts:517`.
1. Contract from the section source: keyframes.prune removes keys that cannot affect the visible range (S01:KF-006).
2. Detectable caller failure: Incorrect parameter/effect/animation, refusal, or native rendering filter; specifically the named case would return or store the wrong result.
3. Oracle: expect(clip().opacity.keyframes.map((k) => k.time / F)).toEqual([20, 50, 80, 150, 250]);; expect(clip().effects[0]!.params.radius!.keyframes).toHaveLength(2);; expect((res.results[0] as { removed: number }).removed).toBe(2);; expect(v[0]).toBeCloseTo(before[i]![0]!, 9);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transaction/parameter/keyframe API and renderer adapter through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “keyframes.prune removes keys that cannot affect the visible range (S01:KF-006)” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: keyframe commands on track and master parameters use sequence time
Original location: `packages/project/test/keyframe-effect.test.ts:568`.
1. Contract from the section source: keyframe commands on track and master parameters use sequence time.
2. Detectable caller failure: Incorrect parameter/effect/animation, refusal, or native rendering filter; specifically the named case would return or store the wrong result.
3. Oracle: expect(h.seq.audioTracks[0]!.volumeDb!.keyframes[0]!.time).toBe(12 * F);; expect(h.seq.audioTracks[0]!.volumeDb!.keyframes[0]!.time).toBe(14 * F);; expect(h.seq.master.volumeDb.keyframes[0]!.time).toBe(5 * F);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transaction/parameter/keyframe API and renderer adapter through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “keyframe commands on track and master parameters use sequence time” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: keyframe edits on a locked track are refused atomically
Original location: `packages/project/test/keyframe-effect.test.ts:593`.
1. Contract from the section source: keyframe edits on a locked track are refused atomically.
2. Detectable caller failure: Incorrect parameter/effect/animation, refusal, or native rendering filter; specifically the named case would return or store the wrong result.
3. Oracle: expect(!res.ok && res.errors[0]!.code, cmd.type).toBe('E_TRACK_LOCKED');; expect(h.doc).toBe(before);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transaction/parameter/keyframe API and renderer adapter through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “keyframe edits on a locked track are refused atomically” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: maps crop, directional blur and flips to the native FFmpeg protocol
Original location: `packages/project/test/keyframe-effect.test.ts:615`.
1. Contract from the section source: maps crop, directional blur and flips to the native FFmpeg protocol.
2. Detectable caller failure: Incorrect parameter/effect/animation, refusal, or native rendering filter; specifically the named case would return or store the wrong result.
3. Oracle: expect(native('jasper.crop', { left: 10, top: 5, right: 0, bottom: 12.5 })).toBe(; expect(native('jasper.gaussian-blur', { radius: 7.5 })).toBe('gblur=sigma=7.5:sigmaV=7.5');; expect(native('jasper.gaussian-blur', { radius: 4, dimensions: 'vertical' })).toBe(; expect(native('jasper.gaussian-blur', { radius: 0 })).toBe('null');. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transaction/parameter/keyframe API and renderer adapter through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “maps crop, directional blur and flips to the native FFmpeg protocol” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: brightness/contrast preview transfer equals the canonical formula
Original location: `packages/project/test/keyframe-effect.test.ts:630`.
1. Contract from the section source: brightness/contrast preview transfer equals the canonical formula.
2. Detectable caller failure: Incorrect parameter/effect/animation, refusal, or native rendering filter; specifically the named case would return or store the wrong result.
3. Oracle: expect(Number(m[1]) * x + Number(m[2])).toBeCloseTo(want, 3);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transaction/parameter/keyframe API and renderer adapter through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “brightness/contrast preview transfer equals the canonical formula” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: exports a JSON Schema per clip including applied effect params
Original location: `packages/project/test/keyframe-effect.test.ts:648`.
1. Contract from the section source: exports a JSON Schema per clip including applied effect params.
2. Detectable caller failure: Incorrect parameter/effect/animation, refusal, or native rendering filter; specifically the named case would return or store the wrong result.
3. Oracle: expect(schema.properties.opacity).toMatchObject({ type: 'number', minimum: 0, maximum: 100 });; expect(schema.properties['transform.position']).toMatchObject({ type: 'array', minItems: 2 });; expect(schema.properties['solid.color']).toMatchObject({ type: 'array', minItems: 4 });; expect(schema.properties[\`effects.${clip.effects[0]!.id}.left\`]).toMatchObject({. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transaction/parameter/keyframe API and renderer adapter through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “exports a JSON Schema per clip including applied effect params” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: generates motion-graphic params.* specs from the template schema with defaults
Original location: `packages/project/test/keyframe-effect.test.ts:666`.
1. Contract from the section source: generates motion-graphic params.* specs from the template schema with defaults.
2. Detectable caller failure: Incorrect parameter/effect/animation, refusal, or native rendering filter; specifically the named case would return or store the wrong result.
3. Oracle: expect(by['params.title']).toMatchObject({ kind: 'string', label: 'Title', description: 'Main line' });; expect(by['params.size']).toMatchObject({ kind: 'number', range: { min: 10, max: 200, step: 1 } });; expect(by['params.accent']!.kind).toBe('color');; expect(by['params.align']).toMatchObject({ kind: 'enum', options: ['left', 'right'] });. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transaction/parameter/keyframe API and renderer adapter through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “generates motion-graphic params.* specs from the template schema with defaults” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: resolves values at the playhead, computes reset values and picks the write command
Original location: `packages/project/test/keyframe-effect.test.ts:710`.
1. Contract from the section source: resolves values at the playhead, computes reset values and picks the write command.
2. Detectable caller failure: Incorrect parameter/effect/animation, refusal, or native rendering filter; specifically the named case would return or store the wrong result.
3. Oracle: expect(resolvePropertyAt(ctx, op, 15)).toMatchObject({ value: 50, animated: true, outside: false });; expect(resolvePropertyAt(ctx, op, 0)).toMatchObject({ value: 0, outside: true });; expect(propertyDefault(ctx, getPropertySpec('transform.anchor')!)).toEqual([640, 360]);; expect(propertyDefault(ctx, getPropertySpec('transform.position')!)).toEqual([960, 540]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transaction/parameter/keyframe API and renderer adapter through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “resolves values at the playhead, computes reset values and picks the write command” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: effect param specs map to ParamPaths the handlers accept
Original location: `packages/project/test/keyframe-effect.test.ts:741`.
1. Contract from the section source: effect param specs map to ParamPaths the handlers accept.
2. Detectable caller failure: Incorrect parameter/effect/animation, refusal, or native rendering filter; specifically the named case would return or store the wrong result.
3. Oracle: expect(clipOf(h, id).effects[0]!.params.left!.value).toBe(25);; expect(resolvePropertyAt(ctx, specs[0]!, 0).value).toBe(25);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transaction/parameter/keyframe API and renderer adapter through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “effect param specs map to ParamPaths the handlers accept” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

## packages/project/test/keyframes.test.ts

Independent sources: docs/specs/01-project-model-and-state.md KF-007; docs/wp-notes/keyframes-blend.md interpolation tables. Production seam: evaluate/ease mathematics. Non-test callers: all animated preview/export/document parameters. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in wrong value or discontinuity at a stated animation time.

### KEEP: returns the static value without keyframes and clamps outside the range
Original location: `packages/project/test/keyframes.test.ts:21`.
1. Contract from the section source: returns the static value without keyframes and clamps outside the range.
2. Detectable caller failure: Wrong value or discontinuity at a stated animation time; specifically the named case would return or store the wrong result.
3. Oracle: expect(evaluate(anim(42), 10)).toBe(42);; expect(evaluate(a, 0)).toBe(10);; expect(evaluate(a, 300)).toBe(20);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes evaluate/ease mathematics through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “returns the static value without keyframes and clamps outside the range” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: linear at u = 0.5 gives the midpoint (numbers, vectors, colors)
Original location: `packages/project/test/keyframes.test.ts:27`.
1. Contract from the section source: linear at u = 0.5 gives the midpoint (numbers, vectors, colors).
2. Detectable caller failure: Wrong value or discontinuity at a stated animation time; specifically the named case would return or store the wrong result.
3. Oracle: expect(evaluate(anim(0, [kf('kf_1', 0, 0), kf('kf_2', 100, 100)]), 50)).toBe(50);; expect(; expect(c).toEqual([0.5, 0, 0.5, 1]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes evaluate/ease mathematics through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “linear at u = 0.5 gives the midpoint (numbers, vectors, colors)” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: linear preset equals p = u
Original location: `packages/project/test/keyframes.test.ts:42`.
1. Contract from the section source: linear preset equals p = u.
2. Detectable caller failure: Wrong value or discontinuity at a stated animation time; specifically the named case would return or store the wrong result.
3. Oracle: expect(bezierProgress(u, EASE_PRESETS.linear, EASE_PRESETS.linear)).toBeCloseTo(u, 6);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes evaluate/ease mathematics through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “linear preset equals p = u” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: hold gives a step
Original location: `packages/project/test/keyframes.test.ts:46`.
1. Contract from the section source: hold gives a step.
2. Detectable caller failure: Wrong value or discontinuity at a stated animation time; specifically the named case would return or store the wrong result.
3. Oracle: expect(evaluate(a, 0)).toBe(0);; expect(evaluate(a, 99)).toBe(0);; expect(evaluate(a, 100)).toBe(100);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes evaluate/ease mathematics through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “hold gives a step” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: hold-only value types step regardless of interpolation (S01:KF-007)
Original location: `packages/project/test/keyframes.test.ts:52`.
1. Contract from the section source: hold-only value types step regardless of interpolation (S01:KF-007).
2. Detectable caller failure: Wrong value or discontinuity at a stated animation time; specifically the named case would return or store the wrong result.
3. Oracle: expect(evaluate(a, 60)).toBe('a');; expect(evaluate(anim(false, [kf('kf_1', 0, false), kf('kf_2', 100, true)]), 99)).toBe(false);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes evaluate/ease mathematics through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “hold-only value types step regardless of interpolation (S01:KF-007)” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: auto-bezier on a local maximum does not overshoot
Original location: `packages/project/test/keyframes.test.ts:57`.
1. Contract from the section source: auto-bezier on a local maximum does not overshoot.
2. Detectable caller failure: Wrong value or discontinuity at a stated animation time; specifically the named case would return or store the wrong result.
3. Oracle: expect(max).toBeLessThanOrEqual(100 + 1e-9);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes evaluate/ease mathematics through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “auto-bezier on a local maximum does not overshoot” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: auto-bezier keeps a monotonic ramp smooth and bounded
Original location: `packages/project/test/keyframes.test.ts:67`.
1. Contract from the section source: auto-bezier keeps a monotonic ramp smooth and bounded.
2. Detectable caller failure: Wrong value or discontinuity at a stated animation time; specifically the named case would return or store the wrong result.
3. Oracle: expect(v).toBeGreaterThanOrEqual(prev);; expect(v).toBeLessThanOrEqual(100);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes evaluate/ease mathematics through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “auto-bezier keeps a monotonic ramp smooth and bounded” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: overshooting eases are clamped to the parameter range when asked
Original location: `packages/project/test/keyframes.test.ts:81`.
1. Contract from the section source: overshooting eases are clamped to the parameter range when asked.
2. Detectable caller failure: Wrong value or discontinuity at a stated animation time; specifically the named case would return or store the wrong result.
3. Oracle: expect(raw).toBeGreaterThan(100);; expect(. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes evaluate/ease mathematics through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “overshooting eases are clamped to the parameter range when asked” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: matches a table of reference values
Original location: `packages/project/test/keyframes.test.ts:91`.
1. Contract from the section source: matches a table of reference values.
2. Detectable caller failure: Wrong value or discontinuity at a stated animation time; specifically the named case would return or store the wrong result.
3. Oracle: expect(bezierProgress(u, e, e)).toBeCloseTo(p, 3);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes evaluate/ease mathematics through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “matches a table of reference values” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

## packages/project/test/lumetri-grade.test.ts

Independent sources: docs/wp-notes/color-grade.md independent colour equations and 30ms bake budget. Production seam: lumetri colour functions, secondary key operations and spatial activation. Non-test callers: preview/export LUT and GPU planner; GL tests use CPU as oracle. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in wrong colour/key/spatial activation or over-budget interactive lut bake.

### DELETE: appends the color-grade params after the S06 contract, with identity defaults
Original location: `packages/project/test/lumetri-grade.test.ts:57`.
Registry declarations/private synthetic stage identifiers or malformed internal animatable shape. Fails 3/4/5/6; retained Lumetri spatial GL tests own executed pixel math, while loader parser fuzz owns untrusted document data; internal expansion list shape itself has no independent contract.
Failure previously detected: appends the color-grade params after the S06 contract, with identity defaults. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: the internal spatial stage is registered but never listed
Original location: `packages/project/test/lumetri-grade.test.ts:77`.
Registry declarations/private synthetic stage identifiers or malformed internal animatable shape. Fails 3/4/5/6; retained Lumetri spatial GL tests own executed pixel math, while loader parser fuzz owns untrusted document data; internal expansion list shape itself has no independent contract.
Failure previously detected: the internal spatial stage is registered but never listed. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### KEEP: Faded Film lifts black and compresses white
Original location: `packages/project/test/lumetri-grade.test.ts:87`.
1. Contract from the section source: Faded Film lifts black and compresses white.
2. Detectable caller failure: Wrong colour/key/spatial activation or over-budget interactive LUT bake; specifically the named case would return or store the wrong result.
3. Oracle: expect(b[0]).toBeCloseTo(0.12, 6);; expect(w[0]).toBeCloseTo(0.87, 6);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes lumetri colour functions, secondary key operations and spatial activation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “Faded Film lifts black and compresses white” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: Creative Saturation 0 gives grey at the same luma; 200 doubles the chroma
Original location: `packages/project/test/lumetri-grade.test.ts:93`.
1. Contract from the section source: Creative Saturation 0 gives grey at the same luma; 200 doubles the chroma.
2. Detectable caller failure: Wrong colour/key/spatial activation or over-budget interactive LUT bake; specifically the named case would return or store the wrong result.
3. Oracle: expect(chroma(g)).toBeLessThan(1e-9);; expect(Y(g)).toBeCloseTo(Y(c), 9);; expect(chroma(s)).toBeCloseTo(chroma(c) * 1.5, 6);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes lumetri colour functions, secondary key operations and spatial activation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “Creative Saturation 0 gives grey at the same luma; 200 doubles the chroma” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: Shadow Tint colours the shadows, Highlight Tint the highlights; Tint Balance moves the pivot
Original location: `packages/project/test/lumetri-grade.test.ts:101`.
1. Contract from the section source: Shadow Tint colours the shadows, Highlight Tint the highlights; Tint Balance moves the pivot.
2. Detectable caller failure: Wrong colour/key/spatial activation or over-budget interactive LUT bake; specifically the named case would return or store the wrong result.
3. Oracle: expect(dark[0] - dark[1]).toBeGreaterThan(0.1);; expect(bright[0] - bright[1]).toBeLessThan(0.01);; expect(hi[0] - hi[1]).toBeGreaterThan(0.1);; expect(high[0] - high[1]).toBeGreaterThan(low[0] - low[1]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes lumetri colour functions, secondary key operations and spatial activation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “Shadow Tint colours the shadows, Highlight Tint the highlights; Tint Balance moves the pivot” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### REWRITE: built-in looks are distinct, bounded after the clamp and mixed by intensity
Original location: `packages/project/test/lumetri-grade.test.ts:115`.
Change: Drop catalogue-wide uniqueness and null-function shape; retain bounded pixel output and the independent 50% intensity blend law.
1. Contract from the section source: built-in looks are distinct, bounded after the clamp and mixed by intensity.
2. Detectable caller failure: Wrong colour/key/spatial activation or over-budget interactive LUT bake; specifically the named case would return or store the wrong result.
3. Oracle: Drop catalogue-wide uniqueness and null-function shape; retain bounded pixel output and the independent 50% intensity blend law.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes lumetri colour functions, secondary key operations and spatial activation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “built-in looks are distinct, bounded after the clamp and mixed by intensity” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: a look LUT takes precedence over the built-in look
Original location: `packages/project/test/lumetri-grade.test.ts:137`.
1. Contract from the section source: a look LUT takes precedence over the built-in look.
2. Detectable caller failure: Wrong colour/key/spatial activation or over-budget interactive LUT bake; specifically the named case would return or store the wrong result.
3. Oracle: expect(out).toEqual([0, 0, 0]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes lumetri colour functions, secondary key operations and spatial activation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “a look LUT takes precedence over the built-in look” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: neutral curves are the identity; periodic curves are continuous across red
Original location: `packages/project/test/lumetri-grade.test.ts:153`.
1. Contract from the section source: neutral curves are the identity; periodic curves are continuous across red.
2. Detectable caller failure: Wrong colour/key/spatial activation or over-budget interactive LUT bake; specifically the named case would return or store the wrong result.
3. Oracle: expect(; expect(; expect(f(0)).toBeCloseTo(0.3, 6);; expect(Math.abs(f(0.9999) - f(0))).toBeLessThan(0.01);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes lumetri colour functions, secondary key operations and spatial activation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “neutral curves are the identity; periodic curves are continuous across red” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: Hue vs Sat desaturates only the chosen hue; greys are untouched
Original location: `packages/project/test/lumetri-grade.test.ts:191`.
1. Contract from the section source: Hue vs Sat desaturates only the chosen hue; greys are untouched.
2. Detectable caller failure: Wrong colour/key/spatial activation or over-budget interactive LUT bake; specifically the named case would return or store the wrong result.
3. Oracle: expect(chroma(red)).toBeLessThan(0.02);; expect(blue).toEqual([0.2, 0.2, 0.8].map((v) => expect.closeTo(v, 6)));; expect(grey).toEqual([0.4, 0.4, 0.4].map((v) => expect.closeTo(v, 9)));. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes lumetri colour functions, secondary key operations and spatial activation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “Hue vs Sat desaturates only the chosen hue; greys are untouched” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: Hue vs Hue rotates a hue; Hue vs Luma brightens it; Luma vs Sat and Sat vs Sat scale saturation
Original location: `packages/project/test/lumetri-grade.test.ts:208`.
1. Contract from the section source: Hue vs Hue rotates a hue; Hue vs Luma brightens it; Luma vs Sat and Sat vs Sat scale saturation.
2. Detectable caller failure: Wrong colour/key/spatial activation or over-budget interactive LUT bake; specifically the named case would return or store the wrong result.
3. Oracle: expect(hsl[0]).toBeGreaterThan(0.38);; expect(Y(hvl)).toBeGreaterThan(Y(green) + 0.1);; expect(chroma(lvs)).toBeLessThan(chroma([0.9, 0.7, 0.6]));; expect(chroma(svs)).toBeGreaterThan(0.4);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes lumetri colour functions, secondary key operations and spatial activation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “Hue vs Hue rotates a hue; Hue vs Luma brightens it; Luma vs Sat and Sat vs Sat scale saturation” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: eyedroppers add a centre point and two anchors at the picked value
Original location: `packages/project/test/lumetri-grade.test.ts:263`.
1. Contract from the section source: eyedroppers add a centre point and two anchors at the picked value.
2. Detectable caller failure: Wrong colour/key/spatial activation or over-budget interactive LUT bake; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.points.map((p) => p[0])).toEqual([0, 0.4167, 0.5, 0.5833]);; expect(r.points[r.index]).toEqual([0.5, 0.5]);; expect(w.points.some((p) => p[0] > 0.9)).toBe(true);; expect(l.points.map((p) => p[0])).toEqual([0, 0.85, 0.95, 1]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes lumetri colour functions, secondary key operations and spatial activation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “eyedroppers add a centre point and two anchors at the picked value” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: a section switched off acts as its defaults
Original location: `packages/project/test/lumetri-grade.test.ts:288`.
1. Contract from the section source: a section switched off acts as its defaults.
2. Detectable caller failure: Wrong colour/key/spatial activation or over-budget interactive LUT bake; specifically the named case would return or store the wrong result.
3. Oracle: expect(lumetriFn({ exposure: 2, basicOn: false }, NO_LUTS)).toBeNull();; expect(lumetriFn({ fadedFilm: 50, creativeOn: false }, NO_LUTS)).toBeNull();; expect(; expect(lumetriFn({ shadowsLevel: 50, wheelsOn: false }, NO_LUTS)).toBeNull();. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes lumetri colour functions, secondary key operations and spatial activation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “a section switched off acts as its defaults” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: HSL round trips and the wheel direction inverts
Original location: `packages/project/test/lumetri-grade.test.ts:312`.
1. Contract from the section source: HSL round trips and the wheel direction inverts.
2. Detectable caller failure: Wrong colour/key/spatial activation or over-budget interactive LUT bake; specifically the named case would return or store the wrong result.
3. Oracle: Property assertions over fixed scenario or independently generated inputs in the named test.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes lumetri colour functions, secondary key operations and spatial activation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “HSL round trips and the wheel direction inverts” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: outputs stay finite and in 0..1 for any input and any section switches
Original location: `packages/project/test/lumetri-grade.test.ts:392`.
1. Contract from the section source: outputs stay finite and in 0..1 for any input and any section switches.
2. Detectable caller failure: Wrong colour/key/spatial activation or over-budget interactive LUT bake; specifically the named case would return or store the wrong result.
3. Oracle: Property assertions over fixed scenario or independently generated inputs in the named test.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes lumetri colour functions, secondary key operations and spatial activation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “outputs stay finite and in 0..1 for any input and any section switches” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: a 33³ bake of a full grade with every new step takes < 30 ms (best of several runs)
Original location: `packages/project/test/lumetri-grade.test.ts:400`.
1. Contract from the section source: a 33³ bake of a full grade with every new step takes < 30 ms (best of several runs).
2. Detectable caller failure: Wrong colour/key/spatial activation or over-budget interactive LUT bake; specifically the named case would return or store the wrong result.
3. Oracle: expect(best).toBeLessThan(budgetMs(30));. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes lumetri colour functions, secondary key operations and spatial activation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “a 33³ bake of a full grade with every new step takes < 30 ms (best of several runs)” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### REWRITE: keys on hue, saturation and lightness with soft edges; greys leave a hue key
Original location: `packages/project/test/lumetri-grade.test.ts:420`.

REWRITE across packages. The CPU-only declaration is removed; its real contract moves to `packages/compositions/test/lumetri-spatial-gl.test.ts`. See the [full six-item shader justification and exact transfer map](compositions2.md#final-oracle-independence-rescan-pre-edit-record).
Destination: `HSL key softness covers half of the hue and lightness transition bands`: red selected, blue/gray rejected, hue 22.5° and approximately 55% lightness give half masks.

1. Independent contract: HSL Secondary hue, saturation and lightness ranges, soft edges and gray attenuation in `docs/wp-notes/color-grade.md` §2.
2. Detectable user-visible failure: A wrong selector or softness makes selected, rejected or half-selected pixels display the wrong mask.
3. Independent oracle: Literal white/black/half-mask bytes are independent of the shader and its settings normalizer.
4. Observes actual rendered pixels from the registered Lumetri shader, including live eyedropper-generated input parameters where applicable.
5. Shader helpers, uniform names and render-pass organization may change without changing the required pixels.
6. Actual GPU output is the lowest stable owner of this spatial contract; the uncalled CPU mirror and its duplicate unit case are removed. No stronger remaining test owns this exact case.

Non-test callers: the live shader runs in Program preview/export; eyedropper functions and `lumetriSpatialSettings` retain UI/registry callers. The removed CPU mirror has none. Risk: omitted transfer or byte quantization; the linked map names the destination and preserves appropriate tolerances. Validation: static checks passed; required-oracle GL validation remains scheduled by the integration owner.

### REWRITE: the correction applies inside the key only; Show Mask and Invert
Original location: `packages/project/test/lumetri-grade.test.ts:434`.

REWRITE across packages. The CPU-only declaration is removed; its real contract moves to `packages/compositions/test/lumetri-spatial-gl.test.ts`. See the [full six-item shader justification and exact transfer map](compositions2.md#final-oracle-independence-rescan-pre-edit-record).
Destination: `HSL Secondary corrects only the selected colors and supports Invert` and `Show Mask preserves selected color or white and marks excluded pixels gray or black`: fixed desaturated RGB, unchanged excluded RGB, inverse selection and the three mask styles.

1. Independent contract: HSL Secondary correction, Invert and mask styles in `docs/wp-notes/color-grade.md` §2.
2. Detectable user-visible failure: Incorrect selection, inversion or mask style changes the displayed RGB.
3. Independent oracle: Hand-painted red/blue inputs have fixed expected RGB or independently specified neutral-gray relationships; no production reference supplies expected values.
4. Observes actual rendered pixels from the registered Lumetri shader, including live eyedropper-generated input parameters where applicable.
5. Shader helpers, uniform names and render-pass organization may change without changing the required pixels.
6. Actual GPU output is the lowest stable owner of this spatial contract; the uncalled CPU mirror and its duplicate unit case are removed. No stronger remaining test owns this exact case.

Non-test callers: the live shader runs in Program preview/export; eyedropper functions and `lumetriSpatialSettings` retain UI/registry callers. The removed CPU mirror has none. Risk: omitted transfer or byte quantization; the linked map names the destination and preserves appropriate tolerances. Validation: static checks passed; required-oracle GL validation remains scheduled by the integration owner.

### REWRITE: 3-way correction wheels use the Lumetri wheel maths
Original location: `packages/project/test/lumetri-grade.test.ts:449`.

REWRITE across packages. The CPU-only declaration is removed; its real contract moves to `packages/compositions/test/lumetri-spatial-gl.test.ts`. See the [full six-item shader justification and exact transfer map](compositions2.md#final-oracle-independence-rescan-pre-edit-record).
Destination: `three-way highlight level brightens neutral midgray by the documented gain`: literal gray 160 becomes 200.

1. Independent contract: The documented Lumetri lift/gamma/gain law: Highlights level 50 gives gain 1.25.
2. Detectable user-visible failure: A missing or incorrect three-way highlight gain displays the wrong gray.
3. Independent oracle: Expected byte 200 follows the independently specified gain, without calling the production wheel or CPU spatial renderer.
4. Observes actual rendered pixels from the registered Lumetri shader, including live eyedropper-generated input parameters where applicable.
5. Shader helpers, uniform names and render-pass organization may change without changing the required pixels.
6. Actual GPU output is the lowest stable owner of this spatial contract; the uncalled CPU mirror and its duplicate unit case are removed. No stronger remaining test owns this exact case.

Non-test callers: the live shader runs in Program preview/export; eyedropper functions and `lumetriSpatialSettings` retain UI/registry callers. The removed CPU mirror has none. Risk: omitted transfer or byte quantization; the linked map names the destination and preserves appropriate tolerances. Validation: static checks passed; required-oracle GL validation remains scheduled by the integration owner.

### REWRITE: the vignette darkens the corners, not the centre; roundness and feather shape it
Original location: `packages/project/test/lumetri-grade.test.ts:454`.

REWRITE across packages. The CPU-only declaration is removed; its real contract moves to `packages/compositions/test/lumetri-spatial-gl.test.ts`. See the [full six-item shader justification and exact transfer map](compositions2.md#final-oracle-independence-rescan-pre-edit-record).
Destination: `vignette darkens or lightens corners, keeps the center and follows roundness`: center unchanged, extreme amount/zero feather reaches black or white corners, circle darkens the wide-frame side earlier than the aspect-following ellipse.

1. Independent contract: Vignette Amount, midpoint, feather and roundness controls in `docs/wp-notes/color-grade.md` §2.
2. Detectable user-visible failure: Wrong brightening/darkening, changed center or ignored roundness changes visible vignette pixels.
3. Independent oracle: Fixed endpoint colors, unchanged center and the documented shape relationship do not call a copied vignette formula.
4. Observes actual rendered pixels from the registered Lumetri shader, including live eyedropper-generated input parameters where applicable.
5. Shader helpers, uniform names and render-pass organization may change without changing the required pixels.
6. Actual GPU output is the lowest stable owner of this spatial contract; the uncalled CPU mirror and its duplicate unit case are removed. No stronger remaining test owns this exact case.

Non-test callers: the live shader runs in Program preview/export; eyedropper functions and `lumetriSpatialSettings` retain UI/registry callers. The removed CPU mirror has none. Risk: omitted transfer or byte quantization; the linked map names the destination and preserves appropriate tolerances. Validation: static checks passed; required-oracle GL validation remains scheduled by the integration owner.

### DELETE: adds the spatial companion after a Lumetri instance that uses vignette, sharpen or the secondary
Original location: `packages/project/test/lumetri-grade.test.ts:496`.
Registry declarations/private synthetic stage identifiers or malformed internal animatable shape. Fails 3/4/5/6; retained Lumetri spatial GL tests own executed pixel math, while loader parser fuzz owns untrusted document data; internal expansion list shape itself has no independent contract.
Failure previously detected: adds the spatial companion after a Lumetri instance that uses vignette, sharpen or the secondary. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: nothing is added for pointwise grades, disabled instances or switched-off sections
Original location: `packages/project/test/lumetri-grade.test.ts:504`.
Registry declarations/private synthetic stage identifiers or malformed internal animatable shape. Fails 3/4/5/6; retained Lumetri spatial GL tests own executed pixel math, while loader parser fuzz owns untrusted document data; internal expansion list shape itself has no independent contract.
Failure previously detected: nothing is added for pointwise grades, disabled instances or switched-off sections. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### KEEP: a keyframed amount that leaves the default at some key needs the stage
Original location: `packages/project/test/lumetri-grade.test.ts:523`.
1. Contract from the section source: a keyframed amount that leaves the default at some key needs the stage.
2. Detectable caller failure: Wrong colour/key/spatial activation or over-budget interactive LUT bake; specifically the named case would return or store the wrong result.
3. Oracle: expect(lumetriUsesSpatial(fx)).toBe(true);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes lumetri colour functions, secondary key operations and spatial activation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “a keyframed amount that leaves the default at some key needs the stage” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### REWRITE: Set Color keys the picked colour, not others; greys key on lightness only
Original location: `packages/project/test/lumetri-grade.test.ts:543`.

REWRITE across packages. The CPU-only declaration is removed; its real contract moves to `packages/compositions/test/lumetri-spatial-gl.test.ts`. See the [full six-item shader justification and exact transfer map](compositions2.md#final-oracle-independence-rescan-pre-edit-record).
Destination: `HSL eyedroppers select the picked colors through the rendered mask`: orange selected, blue excluded; near-gray selected by a gray pick and bright gray excluded.

1. Independent contract: HSL Secondary Set Color semantics in `docs/wp-notes/color-grade.md` §2, including gray selection by lightness.
2. Detectable user-visible failure: Wrong generated ranges reject the picked color or select unrelated colors in the rendered mask.
3. Independent oracle: Literal white/black expectations are independent; `keyFromColor` supplies action inputs only.
4. Observes actual rendered pixels from the registered Lumetri shader, including live eyedropper-generated input parameters where applicable.
5. Shader helpers, uniform names and render-pass organization may change without changing the required pixels.
6. Actual GPU output is the lowest stable owner of this spatial contract; the uncalled CPU mirror and its duplicate unit case are removed. No stronger remaining test owns this exact case.

Non-test callers: the live shader runs in Program preview/export; eyedropper functions and `lumetriSpatialSettings` retain UI/registry callers. The removed CPU mirror has none. Risk: omitted transfer or byte quantization; the linked map names the destination and preserves appropriate tolerances. Validation: static checks passed; required-oracle GL validation remains scheduled by the integration owner.

### REWRITE: Add Color extends the key to the new colour and keeps the old one
Original location: `packages/project/test/lumetri-grade.test.ts:552`.

REWRITE across packages. The CPU-only declaration is removed; its real contract moves to `packages/compositions/test/lumetri-spatial-gl.test.ts`. See the [full six-item shader justification and exact transfer map](compositions2.md#final-oracle-independence-rescan-pre-edit-record).
Destination: `HSL eyedroppers select the picked colors through the rendered mask`: after Add, both orange and red are white and blue remains black.

1. Independent contract: HSL Secondary Add Color semantics in `docs/wp-notes/color-grade.md` §2.
2. Detectable user-visible failure: Wrong range expansion drops the original color, rejects the added color or includes blue.
3. Independent oracle: Literal white/black expectations are independent; `addColorToKey` supplies action inputs only.
4. Observes actual rendered pixels from the registered Lumetri shader, including live eyedropper-generated input parameters where applicable.
5. Shader helpers, uniform names and render-pass organization may change without changing the required pixels.
6. Actual GPU output is the lowest stable owner of this spatial contract; the uncalled CPU mirror and its duplicate unit case are removed. No stronger remaining test owns this exact case.

Non-test callers: the live shader runs in Program preview/export; eyedropper functions and `lumetriSpatialSettings` retain UI/registry callers. The removed CPU mirror has none. Risk: omitted transfer or byte quantization; the linked map names the destination and preserves appropriate tolerances. Validation: static checks passed; required-oracle GL validation remains scheduled by the integration owner.

### REWRITE: Remove Color drops the picked colour and keeps the rest of the key
Original location: `packages/project/test/lumetri-grade.test.ts:558`.

REWRITE across packages. The CPU-only declaration is removed; its real contract moves to `packages/compositions/test/lumetri-spatial-gl.test.ts`. See the [full six-item shader justification and exact transfer map](compositions2.md#final-oracle-independence-rescan-pre-edit-record).
Destination: `HSL eyedroppers select the picked colors through the rendered mask`: after Remove, red is black and orange remains white. The incidental parameter-object-change assertion is discarded.

1. Independent contract: HSL Secondary Remove Color semantics in `docs/wp-notes/color-grade.md` §2.
2. Detectable user-visible failure: Wrong range contraction retains the removed color or drops the remaining color.
3. Independent oracle: Literal white/black expectations are independent; `removeColorFromKey` supplies action inputs only.
4. Observes actual rendered pixels from the registered Lumetri shader, including live eyedropper-generated input parameters where applicable.
5. Shader helpers, uniform names and render-pass organization may change without changing the required pixels.
6. Actual GPU output is the lowest stable owner of this spatial contract; the uncalled CPU mirror and its duplicate unit case are removed. No stronger remaining test owns this exact case.

Non-test callers: the live shader runs in Program preview/export; eyedropper functions and `lumetriSpatialSettings` retain UI/registry callers. The removed CPU mirror has none. Risk: omitted transfer or byte quantization; the linked map names the destination and preserves appropriate tolerances. Validation: static checks passed; required-oracle GL validation remains scheduled by the integration owner.

### REWRITE: any values of any params: the colour fn and the spatial settings never throw and stay finite
Original location: `packages/project/test/lumetri-grade.test.ts:583`.
1. Contract from the section source: any values of any params: the colour fn and the spatial settings never throw and stay finite.
2. Detectable caller failure: Wrong colour/key/spatial activation or over-budget interactive LUT bake; specifically the named case would return or store the wrong result.
3. Oracle: live lumetriFn outputs remain finite/in0..1; every numeric field of live lumetriSpatialSettings remains finite for hostile inputs, per AGENTS.md entry-point nonfinite guard. Remove the test-only CPU pixel renderer from this property.
4. Observes lumetri colour functions, secondary key operations and spatial activation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “any values of any params: the colour fn and the spatial settings never throw and stay finite” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### DELETE: snapshot expansion tolerates malformed animatables
Original location: `packages/project/test/lumetri-grade.test.ts:603`.
Registry declarations/private synthetic stage identifiers or malformed internal animatable shape. Fails 3/4/5/6; retained Lumetri spatial GL tests own executed pixel math, while loader parser fuzz owns untrusted document data; internal expansion list shape itself has no independent contract.
Failure previously detected: snapshot expansion tolerates malformed animatables. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

## packages/project/test/nest-shorten.test.ts

Independent sources: AGENTS.md §0 preserve work; nested sequence command API regression. Production seam: clip/media editing transactions. Non-test callers: timeline and MCP edit dispatch. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in legal child deletion fails or unexpectedly shortens parent nest.

### KEEP: lifting the last clip inside the nest is allowed; the nest clip keeps its length
Original location: `packages/project/test/nest-shorten.test.ts:20`.
1. Contract from the section source: lifting the last clip inside the nest is allowed; the nest clip keeps its length.
2. Detectable caller failure: Legal child deletion fails or unexpectedly shortens parent nest; specifically the named case would return or store the wrong result.
3. Oracle: expect(result.ok).toBe(true);; expect(checkInvariants(document)).toEqual([]);; expect(after.duration).toBe(outer.duration);; expect(snap).toBeTruthy();. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes clip/media editing transactions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “lifting the last clip inside the nest is allowed; the nest clip keeps its length” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: deleting media used only inside the nest is allowed
Original location: `packages/project/test/nest-shorten.test.ts:56`.
1. Contract from the section source: deleting media used only inside the nest is allowed.
2. Detectable caller failure: Legal child deletion fails or unexpectedly shortens parent nest; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.ok).toBe(true);; expect(checkInvariants(h.doc)).toEqual([]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes clip/media editing transactions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “deleting media used only inside the nest is allowed” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

## packages/project/test/peek.test.ts

### DELETE: reads current draft values without drafting untouched children
Original location: `packages/project/test/peek.test.ts:7`.
Private draft read identities and duplicate same-transaction examples. Fails 4/5/6; keyframe-effect prune and shape centre regressions observe actual document/render outcomes. peek/peekKeys have many command-handler callers and remain.
Failure previously detected: reads current draft values without drafting untouched children. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: an effect added and keyframed in one transaction, a shape resized and kept centred
Original location: `packages/project/test/peek.test.ts:22`.
Private draft read identities and duplicate same-transaction examples. Fails 4/5/6; keyframe-effect prune and shape centre regressions observe actual document/render outcomes. peek/peekKeys have many command-handler callers and remain.
Failure previously detected: an effect added and keyframed in one transaction, a shape resized and kept centred. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

## packages/project/test/previews.test.ts

Independent sources: docs/wp-notes/previews.md cache invalidation/bar/settings contract. Production seam: previewSegments/audioPreviewSegments and settings commands. Non-test callers: web preview bar and engine cached preview renders. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in stale cached picture/audio, wrong invalidation or lost preview settings.

### DELETE: is 32 hex digits, deterministic and sensitive to every character
Original location: `packages/project/test/previews.test.ts:49`.
Ad-hoc hash collision/format probe, weak cost assertion accepting both states, or single-offset duplicate of retained arbitrary-offset property. Fails 1/2/6; retained preview segment contracts observe invalidation and bar categories.
Failure previously detected: is 32 hex digits, deterministic and sensitive to every character. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### KEEP: cut at every clip edge; gaps give no segment
Original location: `packages/project/test/previews.test.ts:61`.
1. Contract from the section source: cut at every clip edge; gaps give no segment.
2. Detectable caller failure: Stale cached picture/audio, wrong invalidation or lost preview settings; specifically the named case would return or store the wrong result.
3. Oracle: expect(s.map((x) => [x.startFrame, x.frames])).toEqual([; expect(isPreviewHash(x.hash)).toBe(true);; expect(new Set(hashes(s)).size).toBe(3);; expect(byStart(s, 75).clipIds.sort()).toEqual([h.clips('V1')[0]!.id, h.clips('V2')[0]!.id].sort());. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes previewSegments/audioPreviewSegments and settings commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “cut at every clip edge; gaps give no segment” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: an untouched clip at the sequence size and rate has no bar; Motion, effects and stacks do
Original location: `packages/project/test/previews.test.ts:77`.
1. Contract from the section source: an untouched clip at the sequence size and rate has no bar; Motion, effects and stacks do.
2. Detectable caller failure: Stale cached picture/audio, wrong invalidation or lost preview settings; specifically the named case would return or store the wrong result.
3. Oracle: expect(byStart(s, 0).need).toBe('none');; expect(byStart(s, 0).reasons).toEqual([]);; expect(byStart(s, 60).need).not.toBe('none');; expect(byStart(s, 0).need).toBe('realtime');. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes previewSegments/audioPreviewSegments and settings commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “an untouched clip at the sequence size and rate has no bar; Motion, effects and stacks do” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### DELETE: expensive effect stacks are red, with the reasons named
Original location: `packages/project/test/previews.test.ts:91`.
Ad-hoc hash collision/format probe, weak cost assertion accepting both states, or single-offset duplicate of retained arbitrary-offset property. Fails 1/2/6; retained preview segment contracts observe invalidation and bar categories.
Failure previously detected: expensive effect stacks are red, with the reasons named. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: a ripple keeps every hash (positions are relative to the segment start)
Original location: `packages/project/test/previews.test.ts:104`.
Ad-hoc hash collision/format probe, weak cost assertion accepting both states, or single-offset duplicate of retained arbitrary-offset property. Fails 1/2/6; retained preview segment contracts observe invalidation and bar categories.
Failure previously detected: a ripple keeps every hash (positions are relative to the segment start). No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### KEEP: an edit changes only the segments that show the edited clip; undo restores them
Original location: `packages/project/test/previews.test.ts:113`.
1. Contract from the section source: an edit changes only the segments that show the edited clip; undo restores them.
2. Detectable caller failure: Stale cached picture/audio, wrong invalidation or lost preview settings; specifically the named case would return or store the wrong result.
3. Oracle: expect(after.slice(0, 2).map((x) => x.hash)).toEqual(before.slice(0, 2).map((x) => x.hash));; expect(after[2]!.hash).not.toBe(before[2]!.hash);; expect(hashes(segs(structuredClone(d0), h.seqId))).toEqual(hashes(before));. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes previewSegments/audioPreviewSegments and settings commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “an edit changes only the segments that show the edited clip; undo restores them” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: names, labels and markers do not change pixels; renaming a clip with effects does (Clip Name burn-ins)
Original location: `packages/project/test/previews.test.ts:124`.
1. Contract from the section source: names, labels and markers do not change pixels; renaming a clip with effects does (Clip Name burn-ins).
2. Detectable caller failure: Stale cached picture/audio, wrong invalidation or lost preview settings; specifically the named case would return or store the wrong result.
3. Oracle: expect(hashes(segs(h.doc, h.seqId))).toEqual(before);; expect(renamed[2]!.hash).not.toBe(withFx[2]!.hash);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes previewSegments/audioPreviewSegments and settings commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “names, labels and markers do not change pixels; renaming a clip with effects does (Clip Name burn-ins)” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: identical plain clips share a hash anywhere; seeded clips (effects) keep their identity
Original location: `packages/project/test/previews.test.ts:138`.
1. Contract from the section source: identical plain clips share a hash anywhere; seeded clips (effects) keep their identity.
2. Detectable caller failure: Stale cached picture/audio, wrong invalidation or lost preview settings; specifically the named case would return or store the wrong result.
3. Oracle: expect(s).toHaveLength(2);; expect(s[0]!.hash).toBe(s[1]!.hash);; expect(s[0]!.hash).not.toBe(s[1]!.hash);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes previewSegments/audioPreviewSegments and settings commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “identical plain clips share a hash anywhere; seeded clips (effects) keep their identity” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: a muted or hidden track, a new empty track and the audio mix leave the picture hashes alone
Original location: `packages/project/test/previews.test.ts:154`.
1. Contract from the section source: a muted or hidden track, a new empty track and the audio mix leave the picture hashes alone.
2. Detectable caller failure: Stale cached picture/audio, wrong invalidation or lost preview settings; specifically the named case would return or store the wrong result.
3. Oracle: expect(hashes(segs(h.doc, h.seqId))).toEqual(before);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes previewSegments/audioPreviewSegments and settings commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “a muted or hidden track, a new empty track and the audio mix leave the picture hashes alone” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: media content counts, not URLs: another fingerprint invalidates
Original location: `packages/project/test/previews.test.ts:164`.
1. Contract from the section source: media content counts, not URLs: another fingerprint invalidates.
2. Detectable caller failure: Stale cached picture/audio, wrong invalidation or lost preview settings; specifically the named case would return or store the wrong result.
3. Oracle: expect(after[i]).not.toBe(before[i]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes previewSegments/audioPreviewSegments and settings commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “media content counts, not URLs: another fingerprint invalidates” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: sequence settings count
Original location: `packages/project/test/previews.test.ts:173`.
1. Contract from the section source: sequence settings count.
2. Detectable caller failure: Stale cached picture/audio, wrong invalidation or lost preview settings; specifically the named case would return or store the wrong result.
3. Oracle: expect(hashes(segs(doc, h.seqId))[0]).not.toBe(before[0]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes previewSegments/audioPreviewSegments and settings commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “sequence settings count” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: adjustment layers: an edit below the adjustment invalidates the segments it covers
Original location: `packages/project/test/previews.test.ts:181`.
1. Contract from the section source: adjustment layers: an edit below the adjustment invalidates the segments it covers.
2. Detectable caller failure: Stale cached picture/audio, wrong invalidation or lost preview settings; specifically the named case would return or store the wrong result.
3. Oracle: expect(before).toHaveLength(1);; expect(segs(h.doc, h.seqId)[0]!.hash).not.toBe(before[0]!.hash);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes previewSegments/audioPreviewSegments and settings commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “adjustment layers: an edit below the adjustment invalidates the segments it covers” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: nested sequences: edits inside the frames shown invalidate, edits outside them do not
Original location: `packages/project/test/previews.test.ts:194`.
1. Contract from the section source: nested sequences: edits inside the frames shown invalidate, edits outside them do not.
2. Detectable caller failure: Stale cached picture/audio, wrong invalidation or lost preview settings; specifically the named case would return or store the wrong result.
3. Oracle: expect(before).toHaveLength(1);; expect(segs(h.doc, h.seqId)[0]!.hash).toBe(before[0]!.hash);; expect(segs(h.doc, h.seqId)[0]!.hash).not.toBe(before[0]!.hash);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes previewSegments/audioPreviewSegments and settings commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “nested sequences: edits inside the frames shown invalidate, edits outside them do not” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: expressions: a segment whose layers read time is absolute; other segments ignore expressions
Original location: `packages/project/test/previews.test.ts:214`.
1. Contract from the section source: expressions: a segment whose layers read time is absolute; other segments ignore expressions.
2. Detectable caller failure: Stale cached picture/audio, wrong invalidation or lost preview settings; specifically the named case would return or store the wrong result.
3. Oracle: expect(byStart(s0, 130).absolute).toBe(true);; expect(byStart(s0, 0).absolute).toBe(false);; expect(byStart(s1, 140).hash).not.toBe(byStart(s0, 130).hash);; expect(byStart(s1, 0).hash).toBe(byStart(s0, 0).hash);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes previewSegments/audioPreviewSegments and settings commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “expressions: a segment whose layers read time is absolute; other segments ignore expressions” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: Track Matte Keys read a hidden track: editing the matte invalidates; moving everything keeps
Original location: `packages/project/test/previews.test.ts:230`.
1. Contract from the section source: Track Matte Keys read a hidden track: editing the matte invalidates; moving everything keeps.
2. Detectable caller failure: Stale cached picture/audio, wrong invalidation or lost preview settings; specifically the named case would return or store the wrong result.
3. Oracle: expect(before).toHaveLength(1);; expect(after[0]!.hash).not.toBe(before[0]!.hash);; expect(segs(h.doc, h.seqId)[0]!.hash).toBe(after[0]!.hash);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes previewSegments/audioPreviewSegments and settings commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “Track Matte Keys read a hidden track: editing the matte invalidates; moving everything keeps” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: captions are part of the picture: text edits invalidate, moving keeps
Original location: `packages/project/test/previews.test.ts:255`.
1. Contract from the section source: captions are part of the picture: text edits invalidate, moving keeps.
2. Detectable caller failure: Stale cached picture/audio, wrong invalidation or lost preview settings; specifically the named case would return or store the wrong result.
3. Oracle: expect(s0.map((x) => x.startFrame)).toEqual([0, 30, 60]);; expect(s1[1]!.hash).not.toBe(s0[1]!.hash);; expect(s1[0]!.hash).toBe(s0[0]!.hash);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes previewSegments/audioPreviewSegments and settings commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “captions are part of the picture: text edits invalidate, moving keeps” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: 3D: a camera edit invalidates the segments it is on
Original location: `packages/project/test/previews.test.ts:270`.
1. Contract from the section source: 3D: a camera edit invalidates the segments it is on.
2. Detectable caller failure: Stale cached picture/audio, wrong invalidation or lost preview settings; specifically the named case would return or store the wrong result.
3. Oracle: expect(after[0]!.hash).not.toBe(before[0]!.hash);; expect(after[0]!.costMs).toBeGreaterThan(0);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes previewSegments/audioPreviewSegments and settings commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “3D: a camera edit invalidates the segments it is on” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: time remapping changes the picture
Original location: `packages/project/test/previews.test.ts:283`.
1. Contract from the section source: time remapping changes the picture.
2. Detectable caller failure: Stale cached picture/audio, wrong invalidation or lost preview settings; specifically the named case would return or store the wrong result.
3. Oracle: expect(after[0]!.hash).not.toBe(before[0]!.hash);; expect(after[0]!.need).not.toBe('none');. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes previewSegments/audioPreviewSegments and settings commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “time remapping changes the picture” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: property: moving the whole timeline by any offset keeps the hashes; any param edit on one clip changes only its segments
Original location: `packages/project/test/previews.test.ts:295`.
1. Contract from the section source: property: moving the whole timeline by any offset keeps the hashes; any param edit on one clip changes only its segments.
2. Detectable caller failure: Stale cached picture/audio, wrong invalidation or lost preview settings; specifically the named case would return or store the wrong result.
3. Oracle: expect(hashes(moved)).toEqual(hashes(before));; expect(edited[i]!.hash).not.toBe(moved[i]!.hash);; expect(edited[i]!.hash).toBe(moved[i]!.hash);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes previewSegments/audioPreviewSegments and settings commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “property: moving the whole timeline by any offset keeps the hashes; any param edit on one clip changes only its segments” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: cut at audio clip edges; ripple keeps hashes; a level change invalidates only that clip
Original location: `packages/project/test/previews.test.ts:324`.
1. Contract from the section source: cut at audio clip edges; ripple keeps hashes; a level change invalidates only that clip.
2. Detectable caller failure: Stale cached picture/audio, wrong invalidation or lost preview settings; specifically the named case would return or store the wrong result.
3. Oracle: expect(before.length).toBeGreaterThanOrEqual(2);; expect(isPreviewHash(s.hash)).toBe(true);; expect(moved.map((s) => s.hash)).toEqual(before.map((s) => s.hash));; expect(after[0]!.hash).not.toBe(moved[0]!.hash);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes previewSegments/audioPreviewSegments and settings commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “cut at audio clip edges; ripple keeps hashes; a level change invalidates only that clip” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: sets format, size and quality in one undoable step; defaults apply at read time; bad values refuse
Original location: `packages/project/test/previews.test.ts:344`.
1. Contract from the section source: sets format, size and quality in one undoable step; defaults apply at read time; bad values refuse.
2. Detectable caller failure: Stale cached picture/audio, wrong invalidation or lost preview settings; specifically the named case would return or store the wrong result.
3. Oracle: expect(previewSettingsOf(h.seq)).toEqual({ format: 'h264-iframe', size: 'full', quality: 'standard' });; expect(previewSettingsOf(h.seq)).toEqual({ format: 'vp9', size: 'half', quality: 'standard' });; expect(h.seq.previews).toEqual({ format: 'vp9', size: 'half', quality: 'high' });; expect(previewSettingsOf(Object.values(d0.sequences)[0]!).format).toBe('h264-iframe');. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes previewSegments/audioPreviewSegments and settings commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “sets format, size and quality in one undoable step; defaults apply at read time; bad values refuse” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: repair resets unreadable preview settings
Original location: `packages/project/test/previews.test.ts:357`.
1. Contract from the section source: repair resets unreadable preview settings.
2. Detectable caller failure: Stale cached picture/audio, wrong invalidation or lost preview settings; specifically the named case would return or store the wrong result.
3. Oracle: expect(checkInvariants(doc).some((i) => i.invariant === 'INV-PREVIEWS')).toBe(true);; expect(report.some((r) => r.action === 'reset-preview-settings')).toBe(true);; expect((document.sequences[h.seqId] as { previews?: unknown }).previews).toBeUndefined();; expect(checkInvariants(document).filter((i) => i.invariant === 'INV-PREVIEWS')).toEqual([]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes previewSegments/audioPreviewSegments and settings commands through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “repair resets unreadable preview settings” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

## packages/project/test/roto.test.ts

Independent sources: docs/wp-notes/roto.md persisted roto commands/render readiness; FNV-1a UTF-8 byte contract. Production seam: roto commands, snapshot/model and export readiness. Non-test callers: UI roto, engine segmentation, exporter. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in wrong matte binding/freshness/source frames or damaged persisted roto.

### KEEP: roto.add with a stroke sets the base and the default span (the source frames the clip shows)
Original location: `packages/project/test/roto.test.ts:53`.
1. Contract from the section source: roto.add with a stroke sets the base and the default span (the source frames the clip shows).
2. Detectable caller failure: Wrong matte binding/freshness/source frames or damaged persisted roto; specifically the named case would return or store the wrong result.
3. Oracle: expect(out.frame).toBe(40); // 1 s in + 10 frames at 30 fps; expect(out.span).toEqual([30, 89]);; expect(out.base).toBe(40);; expect(roto).toMatchObject({ kind: 'brush', mediaId: m, name: 'Roto 1', base: 40, result: null });. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes roto commands, snapshot/model and export readiness through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “roto.add with a stroke sets the base and the default span (the source frames the clip shows)” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: points become one-point strokes; a box selects; background strokes do not set the base
Original location: `packages/project/test/roto.test.ts:85`.
1. Contract from the section source: points become one-point strokes; a box selects; background strokes do not set the base.
2. Detectable caller failure: Wrong matte binding/freshness/source frames or damaged persisted roto; specifically the named case would return or store the wrong result.
3. Oracle: expect(roto.base).toBeNull();; expect(roto.strokes[0]).toMatchObject({ kind: 'bg', radius: 11, points: [[10, 10]] });; expect(roto.base).toBe(35);; expect(roto.boxes).toEqual([{ frame: 35, rect: [100, 100, 600, 500] }]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes roto commands, snapshot/model and export readiness through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “points become one-point strokes; a box selects; background strokes do not set the base” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: refuses bad input: kinds, empty boxes, spans, frozen edits, unknown rotos
Original location: `packages/project/test/roto.test.ts:100`.
1. Contract from the section source: refuses bad input: kinds, empty boxes, spans, frozen edits, unknown rotos.
2. Detectable caller failure: Wrong matte binding/freshness/source frames or damaged persisted roto; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.ok).toBe(false);; expect(r.errors[0]!.code).toBe(code);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes roto commands, snapshot/model and export readiness through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “refuses bad input: kinds, empty boxes, spans, frozen edits, unknown rotos” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: results go stale when inputs change and fresh again on undo-equivalent inputs
Original location: `packages/project/test/roto.test.ts:134`.
1. Contract from the section source: results go stale when inputs change and fresh again on undo-equivalent inputs.
2. Detectable caller failure: Wrong matte binding/freshness/source frames or damaged persisted roto; specifically the named case would return or store the wrong result.
3. Oracle: expect(rotoIsStale(clip().rotos![0]!)).toBe(false);; expect(rotoIsStale(clip().rotos![0]!)).toBe(true);; expect(rotoIsStale(clip().rotos![0]!)).toBe(false);; expect(rotoIsStale(clip().rotos![0]!)).toBe(false); // 15 is the default. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes roto commands, snapshot/model and export readiness through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “results go stale when inputs change and fresh again on undo-equivalent inputs” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: roto.apply adds a bound Object Matte / Object Blur once; roto.remove removes them
Original location: `packages/project/test/roto.test.ts:158`.
1. Contract from the section source: roto.apply adds a bound Object Matte / Object Blur once; roto.remove removes them.
2. Detectable caller failure: Wrong matte binding/freshness/source frames or damaged persisted roto; specifically the named case would return or store the wrong result.
3. Oracle: expect(a.created).toBe(true);; expect(fx.effectId).toBe(OBJECT_MATTE_EFFECT_ID);; expect(fx.params.object!.value).toBe(id);; expect(fx.params.view!.value).toBe('overlay');. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes roto commands, snapshot/model and export readiness through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “roto.apply adds a bound Object Matte / Object Blur once; roto.remove removes them” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: the snapshot carries every roto with its span; frame states
Original location: `packages/project/test/roto.test.ts:185`.
1. Contract from the section source: the snapshot carries every roto with its span; frame states.
2. Detectable caller failure: Wrong matte binding/freshness/source frames or damaged persisted roto; specifically the named case would return or store the wrong result.
3. Oracle: expect(m0).toMatchObject({ key: null, url: null, span: [30, 89] });; expect(rotoFrameState(m0, 40)).toBe('missing');; expect(rotoFrameState(m0, 10)).toBe('outside');; expect(rotoExportIssues(snap0)[0]).toMatchObject({ kind: 'not-computed', frames: [30, 89] });. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes roto commands, snapshot/model and export readiness through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “the snapshot carries every roto with its span; frame states” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: split / duplicate copy rotos with new ids and rebind the copies’ effects
Original location: `packages/project/test/roto.test.ts:219`.
1. Contract from the section source: split / duplicate copy rotos with new ids and rebind the copies’ effects.
2. Detectable caller failure: Wrong matte binding/freshness/source frames or damaged persisted roto; specifically the named case would return or store the wrong result.
3. Oracle: expect(left!.rotos![0]!.id).toBe(id);; expect(rid).not.toBe(id);; expect(right!.effects![0]!.params.object!.value).toBe(rid);; expect(checkInvariants(h.doc, { effects: defaultEffectRegistry })).toEqual([]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes roto commands, snapshot/model and export readiness through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “split / duplicate copy rotos with new ids and rebind the copies’ effects” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: pasted effects naming a roto the target lacks are reset to none
Original location: `packages/project/test/roto.test.ts:233`.
1. Contract from the section source: pasted effects naming a roto the target lacks are reset to none.
2. Detectable caller failure: Wrong matte binding/freshness/source frames or damaged persisted roto; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);; expect(fx?.params.object?.value).toBe('');; expect(checkInvariants(h.doc, { effects: defaultEffectRegistry })).toEqual([]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes roto commands, snapshot/model and export readiness through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “pasted effects naming a roto the target lacks are reset to none” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: invariants catch dangling references; repairs fix them
Original location: `packages/project/test/roto.test.ts:256`.
1. Contract from the section source: invariants catch dangling references; repairs fix them.
2. Detectable caller failure: Wrong matte binding/freshness/source frames or damaged persisted roto; specifically the named case would return or store the wrong result.
3. Oracle: expect(issues).toContain('INV-006');; expect(issues).toContain('INV-012');; expect(report.map((r) => r.action)).toEqual(expect.arrayContaining(['fix-roto', 'drop-reference']));; expect(checkInvariants(document, { effects: defaultEffectRegistry })).toEqual([]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes roto commands, snapshot/model and export readiness through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “invariants catch dangling references; repairs fix them” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: roto.faceTracker turns a tracked face into a planar tracker and applies it as transform keys
Original location: `packages/project/test/roto.test.ts:272`.
1. Contract from the section source: roto.faceTracker turns a tracked face into a planar tracker and applies it as transform keys.
2. Detectable caller failure: Wrong matte binding/freshness/source frames or damaged persisted roto; specifically the named case would return or store the wrong result.
3. Oracle: expect(roto).toMatchObject({ kind: 'faces', name: 'Faces 1', base: 30 });; expect(r.frames).toBe(60);; expect(tr.kind).toBe('planar');; expect(tr.samples!.confidence[10]).toBe(0);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes roto commands, snapshot/model and export readiness through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “roto.faceTracker turns a tracked face into a planar tracker and applies it as transform keys” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: fnv64 is stable
Original location: `packages/project/test/roto.test.ts:312`.
1. Contract from the section source: fnv64 is stable.
2. Detectable caller failure: Wrong matte binding/freshness/source frames or damaged persisted roto; specifically the named case would return or store the wrong result.
3. Oracle: expect(fnv64('')).toBe('cbf29ce484222325');; expect(fnv64('a')).toBe('af63dc4c8601ec8c');. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes roto commands, snapshot/model and export readiness through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “fnv64 is stable” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: export checks the media frames the remapped picture shows, not the linear content frames
Original location: `packages/project/test/roto.test.ts:319`.
1. Contract from the section source: export checks the media frames the remapped picture shows, not the linear content frames.
2. Detectable caller failure: Wrong matte binding/freshness/source frames or damaged persisted roto; specifically the named case would return or store the wrong result.
3. Oracle: expect(rotoExportIssues(snap())[0]).toMatchObject({ kind: 'not-computed', frames: [61, 89] });; expect(clip().duration).toBe(120);; expect(rotoExportIssues(snap())).toEqual([]);; expect(rotoExportIssues(snap())[0]).toMatchObject({ kind: 'not-computed', frames: [61, 89] });. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes roto commands, snapshot/model and export readiness through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “export checks the media frames the remapped picture shows, not the linear content frames” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

## packages/project/test/roving.test.ts

Independent sources: docs/wp-notes/keyframes-blend.md roving speed; EffectCraft reference cases. Production seam: roving evaluator/commands and repair. Non-test callers: UI keyframe editing and all render paths. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in uneven speed or a misplaced/damaged roving key.

### KEEP: linear ends: constant speed through the run and times proportional to the distance (EffectCraft case)
Original location: `packages/project/test/roving.test.ts:43`.
1. Contract from the section source: linear ends: constant speed through the run and times proportional to the distance (EffectCraft case).
2. Detectable caller failure: Uneven speed or a misplaced/damaged roving key; specifically the named case would return or store the wrong result.
3. Oracle: expect(retimeRoving(kfs)).toBe(true);; expect(kfs[1]!.time / SEC).toBeCloseTo(1.5, 6);; expect(speedAt(a, t)).toBeCloseTo(200, 3);; expect(evaluate(a, kfs[1]!.time)[0]).toBeCloseTo(300, 6);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes roving evaluator/commands and repair through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “linear ends: constant speed through the run and times proportional to the distance (EffectCraft case)” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: ignores the stored time of a roving key: the value depends on the run only
Original location: `packages/project/test/roving.test.ts:57`.
1. Contract from the section source: ignores the stored time of a roving key: the value depends on the run only.
2. Detectable caller failure: Uneven speed or a misplaced/damaged roving key; specifically the named case would return or store the wrong result.
3. Oracle: expect(evaluate(a, t * SEC)).toBeCloseTo(100 * t, 9);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes roving evaluator/commands and repair through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “ignores the stored time of a roving key: the value depends on the run only” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: eased fixed keys shape the whole run (one ease across the roving keys, smooth speed)
Original location: `packages/project/test/roving.test.ts:67`.
1. Contract from the section source: eased fixed keys shape the whole run (one ease across the roving keys, smooth speed).
2. Detectable caller failure: Uneven speed or a misplaced/damaged roving key; specifically the named case would return or store the wrong result.
3. Oracle: expect(evaluate(a, t * SEC)).toBeCloseTo(evaluate(single, t * SEC), 6);; expect(evaluate(a, kfs[1]!.time)).toBeCloseTo(40, 4);; expect(evaluate(a, kfs[2]!.time)).toBeCloseTo(60, 4);; expect(evaluate(a, SEC)).toBeCloseTo(50, 6);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes roving evaluator/commands and repair through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “eased fixed keys shape the whole run (one ease across the roving keys, smooth speed)” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: first / last / hold keys never rove; runs are split by fixed keys
Original location: `packages/project/test/roving.test.ts:84`.
1. Contract from the section source: first / last / hold keys never rove; runs are split by fixed keys.
2. Detectable caller failure: Uneven speed or a misplaced/damaged roving key; specifically the named case would return or store the wrong result.
3. Oracle: expect(rovingRuns(kfs).map((r) => [r.a, r.b])).toEqual([[0, 2]]);; expect(kfs.map((x) => !!x.roving)).toEqual([false, true, false, false, false]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes roving evaluator/commands and repair through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “first / last / hold keys never rove; runs are split by fixed keys” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: property: key values are passed at the stored times, runs are continuous
Original location: `packages/project/test/roving.test.ts:97`.
1. Contract from the section source: property: key values are passed at the stored times, runs are continuous.
2. Detectable caller failure: Uneven speed or a misplaced/damaged roving key; specifically the named case would return or store the wrong result.
3. Oracle: expect(kfs[i]!.time).toBeGreaterThan(kfs[i - 1]!.time);; expect(Math.abs(evaluate(a, key.time) - key.value)).toBeLessThan(tol);; expect(Math.abs(v - prev)).toBeLessThan((1000 / 50) * 6);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes roving evaluator/commands and repair through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “property: key values are passed at the stored times, runs are continuous” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: keyframe.setRoving re-times the key; first / last are refused with a warning
Original location: `packages/project/test/roving.test.ts:149`.
1. Contract from the section source: keyframe.setRoving re-times the key; first / last are refused with a warning.
2. Detectable caller failure: Uneven speed or a misplaced/damaged roving key; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.warnings.length).toBe(2);; expect(keys().map((x) => !!x.roving)).toEqual([false, true, false]);; expect(keys()[1]!.time / F).toBeCloseTo(45, 3);; expect(checkInvariants(h.doc)).toEqual([]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes roving evaluator/commands and repair through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “keyframe.setRoving re-times the key; first / last are refused with a warning” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: dragging a roving key in time turns roving off and keeps the speed through it
Original location: `packages/project/test/roving.test.ts:166`.
1. Contract from the section source: dragging a roving key in time turns roving off and keeps the speed through it.
2. Detectable caller failure: Uneven speed or a misplaced/damaged roving key; specifically the named case would return or store the wrong result.
3. Oracle: expect(kb.roving).toBeUndefined();; expect(kb.interpolation).toBe('continuous-bezier');; expect(at[0] - before[0]).toBeCloseTo(after[0] - at[0], 3);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes roving evaluator/commands and repair through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “dragging a roving key in time turns roving off and keeps the speed through it” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: repairDocument drops roving flags on keys that cannot rove
Original location: `packages/project/test/roving.test.ts:186`.
1. Contract from the section source: repairDocument drops roving flags on keys that cannot rove.
2. Detectable caller failure: Uneven speed or a misplaced/damaged roving key; specifically the named case would return or store the wrong result.
3. Oracle: expect(checkInvariants(doc).some((i) => i.message.includes('rove'))).toBe(true);; expect(report.some((r) => r.action === 'drop-roving')).toBe(true);; expect(checkInvariants(document)).toEqual([]);; expect(keys().length).toBe(3);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes roving evaluator/commands and repair through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “repairDocument drops roving flags on keys that cannot rove” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

## packages/project/test/scopes.test.ts

Independent sources: docs/wp-notes/color-grade.md scopes; BT.601/709/2020 signal equations. Production seam: scope signal/summary/paint and naming API. Non-test callers: web Lumetri Scopes and MCP scopes endpoint. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in incorrect signal histogram/waveform/vector measurement or protocol name.

### REWRITE: a single colour lands in exact histogram bins
Original location: `packages/project/test/scopes.test.ts:88`.
1. Contract from the section source: a single colour lands in exact histogram bins.
2. Detectable caller failure: Incorrect signal histogram/waveform/vector measurement or protocol name; specifically the named case would return or store the wrong result.
3. Oracle after final review: BT.709 gives Y = 0.2126×200 + 0.7152×100 + 0.0722×50 = 117.65, hence bin 118. Remove expected-bin calculation through rgbToYcbcr.
4. Observes scope signal/summary/paint and naming API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “a single colour lands in exact histogram bins” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: a ramp fills every bin and the waveform row equals the code value
Original location: `packages/project/test/scopes.test.ts:102`.
1. Contract from the section source: a ramp fills every bin and the waveform row equals the code value.
2. Detectable caller failure: Incorrect signal histogram/waveform/vector measurement or protocol name; specifically the named case would return or store the wrong result.
3. Oracle: expect([h.r[k], h.g[k], h.b[k], h.y[k]]).toEqual([10, 10, 10, 10]);; expect(rowsIn(y, x)).toEqual([x]);; expect(at(y, x, x)).toBe(10);; expect(w.traces.length).toBe(3);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes scope signal/summary/paint and naming API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “a ramp fills every bin and the waveform row equals the code value” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### REWRITE: colour bars: parade levels and vectorscope targets for every matrix
Original location: `packages/project/test/scopes.test.ts:122`.
Change: Keep RGB parade counts for known input bars; remove vectorscope oracle computed with production RGB conversion and target helpers.
1. Contract from the section source: colour bars: parade levels and vectorscope targets for every matrix.
2. Detectable caller failure: Incorrect signal histogram/waveform/vector measurement or protocol name; specifically the named case would return or store the wrong result.
3. Oracle: Keep RGB parade counts for known input bars; remove vectorscope oracle computed with production RGB conversion and target helpers.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes scope signal/summary/paint and naming API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “colour bars: parade levels and vectorscope targets for every matrix” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### REWRITE: vectorscope positions of primaries are known
Original location: `packages/project/test/scopes.test.ts:154`.
1. Contract from the section source: vectorscope positions of primaries are known.
2. Detectable caller failure: Incorrect signal histogram/waveform/vector measurement or protocol name; specifically the named case would return or store the wrong result.
3. Oracle after final review: The independent BT.709 red chroma vector is (−0.114572106, 0.5). Replace expected mean produced by rgbToYcbcr; keep primary positions and existing 1e−6 tolerance.
4. Observes scope signal/summary/paint and naming API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “vectorscope positions of primaries are known” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### REWRITE: the HLS vectorscope puts hue on the angle and saturation on the radius
Original location: `packages/project/test/scopes.test.ts:172`.
1. Contract from the section source: the HLS vectorscope puts hue on the angle and saturation on the radius.
2. Detectable caller failure: Incorrect signal histogram/waveform/vector measurement or protocol name; specifically the named case would return or store the wrong result.
3. Oracle after final review: BT.709 red direction is 102.906186°, HLS primaries add 0/60/120/180/240/300° and full saturation has radius 0.5. Replace private grid-coordinate helper expectations with fixed plotted peak angles for all six primaries, using the existing 0.5° direction tolerance for grid quantization. Retain peak saturation tolerances. The plotted data remains the observable so an incorrect rasterization cannot hide behind a correct mean.
4. Observes scope signal/summary/paint and naming API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “the HLS vectorscope puts hue on the angle and saturation on the radius” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### REWRITE: the YC waveform draws chroma around luma; the YUV parade offsets chroma to mid scale
Original location: `packages/project/test/scopes.test.ts:197`.
1. Contract from the section source: the YC waveform draws chroma around luma; the YUV parade offsets chroma to mid scale.
2. Detectable caller failure: Incorrect signal histogram/waveform/vector measurement or protocol name; specifically the named case would return or store the wrong result.
3. Oracle after final review: BT.709 red is Y=0.2126, Cb=−0.114572106, Cr=0.5: eight-bit luma row 54; clamped YC chroma envelope rows 0 and 185. Replace expected values from rgbToYcbcr and duplicate row transform with these fixed analytical values.
4. Observes scope signal/summary/paint and naming API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “the YC waveform draws chroma around luma; the YUV parade offsets chroma to mid scale” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: decimation keeps whole samples
Original location: `packages/project/test/scopes.test.ts:210`.
1. Contract from the section source: decimation keeps whole samples.
2. Detectable caller failure: Incorrect signal histogram/waveform/vector measurement or protocol name; specifically the named case would return or store the wrong result.
3. Oracle: expect([s.w, s.h]).toEqual([480, 270]);; expect([...s.rgb.slice(3, 6)]).toEqual([4 / 255, 0, 7 / 255].map((v) => Math.fround(v)));; expect([...s.rgb.slice(480 * 3, 480 * 3 + 3)]).toEqual([0, 4 / 255, 7 / 255].map((v) => Math.fround(v)));; expect([s2.w, s2.h]).toEqual([385, 9]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes scope signal/summary/paint and naming API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “decimation keeps whole samples” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### REWRITE: Clamp Signal controls out-of-range values
Original location: `packages/project/test/scopes.test.ts:228`.
1. Contract from the section source: Clamp Signal controls out-of-range values.
2. Detectable caller failure: Incorrect signal histogram/waveform/vector measurement or protocol name; specifically the named case would return or store the wrong result.
3. Oracle after final review: The independently documented unclamped −10%..110% range maps −5% blue to eight-bit row round(255×0.05/1.2)=11. Replace expected production rowOf call with 11.
4. Observes scope signal/summary/paint and naming API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “Clamp Signal controls out-of-range values” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: NaN (transparent) samples and empty signals do not throw
Original location: `packages/project/test/scopes.test.ts:243`.
1. Contract from the section source: NaN (transparent) samples and empty signals do not throw.
2. Detectable caller failure: Incorrect signal histogram/waveform/vector measurement or protocol name; specifically the named case would return or store the wrong result.
3. Oracle: expect(histogram(s).samples).toBe(6);; expect(channelStats(empty)).toBeNull();. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes scope signal/summary/paint and naming API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “NaN (transparent) samples and empty signals do not throw” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: summaries report levels in percent
Original location: `packages/project/test/scopes.test.ts:261`.
1. Contract from the section source: summaries report levels in percent.
2. Detectable caller failure: Incorrect signal histogram/waveform/vector measurement or protocol name; specifically the named case would return or store the wrong result.
3. Oracle: expect([st.r.mean, st.g.mean, st.b.mean]).toEqual([78.43, 39.22, 19.61]);; expect([st.r.min, st.r.max]).toEqual([78.43, 78.43]);; expect(cols.length).toBe(4);; expect(cols[0]).toEqual({ min: 0, max: 0, mean: 0 });. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes scope signal/summary/paint and naming API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “summaries report levels in percent” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### REWRITE: paint adds traces and leaves empty cells transparent
Original location: `packages/project/test/scopes.test.ts:282`.
Change: Keep occupied white pixel, transparent empty pixel and brightness monotonicity; remove image dimensions and private 3x3 footprint count.
1. Contract from the section source: paint adds traces and leaves empty cells transparent.
2. Detectable caller failure: Incorrect signal histogram/waveform/vector measurement or protocol name; specifically the named case would return or store the wrong result.
3. Oracle: Keep occupied white pixel, transparent empty pixel and brightness monotonicity; remove image dimensions and private 3x3 footprint count.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes scope signal/summary/paint and naming API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “paint adds traces and leaves empty cells transparent” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### REWRITE: names round trip
Original location: `packages/project/test/scopes.test.ts:306`.
Change: Keep literal public aliases; remove enum/label declaration self-roundtrip.
1. Contract from the section source: names round trip.
2. Detectable caller failure: Incorrect signal histogram/waveform/vector measurement or protocol name; specifically the named case would return or store the wrong result.
3. Oracle: Keep literal public aliases; remove enum/label declaration self-roundtrip.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes scope signal/summary/paint and naming API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “names round trip” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: Y′CbCr round-trips for every matrix
Original location: `packages/project/test/scopes.test.ts:321`.
1. Contract from the section source: Y′CbCr round-trips for every matrix.
2. Detectable caller failure: Incorrect signal histogram/waveform/vector measurement or protocol name; specifically the named case would return or store the wrong result.
3. Oracle: Property assertions over fixed scenario or independently generated inputs in the named test.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes scope signal/summary/paint and naming API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “Y′CbCr round-trips for every matrix” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: 100 % targets of BT.2020 sit further out than 75 %; scale labels follow the bit depth
Original location: `packages/project/test/scopes.test.ts:331`.
1. Contract from the section source: 100 % targets of BT.2020 sit further out than 75 %; scale labels follow the bit depth.
2. Detectable caller failure: Incorrect signal histogram/waveform/vector measurement or protocol name; specifically the named case would return or store the wrong result.
3. Oracle: expect(Math.hypot(t100[i]!.cb, t100[i]!.cr)).toBeGreaterThan(Math.hypot(t.cb, t.cr));; expect(scaleLabels('8bit').at(-1)).toEqual([1, '255']);; expect(scaleLabels('10bit').at(-1)).toEqual([1, '1023']);; expect(scaleLabels('float')[5]).toEqual([0.5, '0.5']);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes scope signal/summary/paint and naming API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “100 % targets of BT.2020 sit further out than 75 %; scale labels follow the bit depth” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: readScopes reports every scope as numbers
Original location: `packages/project/test/scopes.test.ts:341`.
1. Contract from the section source: readScopes reports every scope as numbers.
2. Detectable caller failure: Incorrect signal histogram/waveform/vector measurement or protocol name; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.samples).toEqual([256, 16]);; expect(r.waveform!.traces.R!.length).toBe(8);; expect(r.parade!.type).toBe('yuv');; expect(r.histogram!.r!.length).toBe(256);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes scope signal/summary/paint and naming API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “readScopes reports every scope as numbers” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: stays real time: every scope of a 1080p frame in well under a frame budget
Original location: `packages/project/test/scopes.test.ts:354`.
1. Contract from the section source: stays real time: every scope of a 1080p frame in well under a frame budget.
2. Detectable caller failure: Incorrect signal histogram/waveform/vector measurement or protocol name; specifically the named case would return or store the wrong result.
3. Oracle: expect(t, name).toBeLessThan(limit);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes scope signal/summary/paint and naming API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “stays real time: every scope of a 1080p frame in well under a frame budget” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

## packages/project/test/sequence-transcript.test.ts

Independent sources: docs/wp-notes/captions.md; sequence transcript/caption API. Production seam: transcript mapping/range/caption functions. Non-test callers: web transcript editing and MCP transcript/caption commands. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in wrong words/time cuts, overlapping/missing captions or bad search.

### KEEP: maps words through the clip
Original location: `packages/project/test/sequence-transcript.test.ts:100`.
1. Contract from the section source: maps words through the clip.
2. Detectable caller failure: Wrong words/time cuts, overlapping/missing captions or bad search; specifically the named case would return or store the wrong result.
3. Oracle: expect(texts(w)).toEqual(['Um,', 'today', 'we', 'talk', 'about', 'rivers.']);; expect(w[0]!.start).toBe(s(2.2));; expect(w[0]!.end).toBe(s(2.5));; expect(w[5]!.end).toBe(s(4.4));. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transcript mapping/range/caption functions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “maps words through the clip” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: keeps a cut word by its midpoint and clamps it
Original location: `packages/project/test/sequence-transcript.test.ts:111`.
1. Contract from the section source: keeps a cut word by its midpoint and clamps it.
2. Detectable caller failure: Wrong words/time cuts, overlapping/missing captions or bad search; specifically the named case would return or store the wrong result.
3. Oracle: expect(texts(w)).toEqual(['show.']);; expect(w[0]!.start).toBe(0);; expect(w[0]!.end).toBe(s(0.3));. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transcript mapping/range/caption functions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “keeps a cut word by its midpoint and clamps it” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: scales word times by speed
Original location: `packages/project/test/sequence-transcript.test.ts:118`.
1. Contract from the section source: scales word times by speed.
2. Detectable caller failure: Wrong words/time cuts, overlapping/missing captions or bad search; specifically the named case would return or store the wrong result.
3. Oracle: expect(w).toHaveLength(20);; expect([w[3]!.start, w[3]!.end]).toEqual([s(0.6), s(0.85)]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transcript mapping/range/caption functions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “scales word times by speed” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: reads duplicated tracks once; disabled or reversed clips are silent
Original location: `packages/project/test/sequence-transcript.test.ts:123`.
1. Contract from the section source: reads duplicated tracks once; disabled or reversed clips are silent.
2. Detectable caller failure: Wrong words/time cuts, overlapping/missing captions or bad search; specifically the named case would return or store the wrong result.
3. Oracle: expect(w).toHaveLength(20);; expect(w.every((x) => x.track === 0)).toBe(true);; expect(w).toHaveLength(20);; expect(w.every((x) => x.track === 1)).toBe(true);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transcript mapping/range/caption functions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “reads duplicated tracks once; disabled or reversed clips are silent” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: repeats words of two clips of the same media in edit order
Original location: `packages/project/test/sequence-transcript.test.ts:135`.
1. Contract from the section source: repeats words of two clips of the same media in edit order.
2. Detectable caller failure: Wrong words/time cuts, overlapping/missing captions or bad search; specifically the named case would return or store the wrong result.
3. Oracle: expect(texts(w)).toEqual(['rivers.', 'rivers.']);; expect(w[1]!.start).toBe(s(1.1));; expect(w[1]!.clipId).toBe('c101');. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transcript mapping/range/caption functions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “repeats words of two clips of the same media in edit order” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: search, word at and paragraphs
Original location: `packages/project/test/sequence-transcript.test.ts:142`.
1. Contract from the section source: search, word at and paragraphs.
2. Detectable caller failure: Wrong words/time cuts, overlapping/missing captions or bad search; specifically the named case would return or store the wrong result.
3. Oracle: expect(searchWords(w, 'rivers')).toEqual([; expect(searchWords(w, 'YOU kn')).toEqual([[18, 20]]);; expect(searchWords(w, 'talk about')).toEqual([[7, 9]]);; expect(searchWords(w, '  ')).toEqual([]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transcript mapping/range/caption functions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “search, word at and paragraphs” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: word ranges snap outward
Original location: `packages/project/test/sequence-transcript.test.ts:161`.
1. Contract from the section source: word ranges snap outward.
2. Detectable caller failure: Wrong words/time cuts, overlapping/missing captions or bad search; specifically the named case would return or store the wrong result.
3. Oracle: expect(wordRangeFrames(w, 3, 0, R)).toEqual([12, 43]);; expect(m).toEqual([s(3.68), s(5.92)]);; expect(wordRangeFrames(w, 0, 99, R)).toBeNull();. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transcript mapping/range/caption functions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “word ranges snap outward” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: finds pauses with kept air, snapped inward
Original location: `packages/project/test/sequence-transcript.test.ts:169`.
1. Contract from the section source: finds pauses with kept air, snapped inward.
2. Detectable caller failure: Wrong words/time cuts, overlapping/missing captions or bad search; specifically the named case would return or store the wrong result.
3. Oracle: expect(p).toEqual([[fr(1.8), fr(3.6)]]);; expect(findPauses(w, s(0.4), s(0.1), R)).toHaveLength(3);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transcript mapping/range/caption functions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “finds pauses with kept air, snapped inward” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: finds fillers, longest phrase first, without cutting into neighbours
Original location: `packages/project/test/sequence-transcript.test.ts:177`.
1. Contract from the section source: finds fillers, longest phrase first, without cutting into neighbours.
2. Detectable caller failure: Wrong words/time cuts, overlapping/missing captions or bad search; specifically the named case would return or store the wrong result.
3. Oracle: expect(hits).toEqual([; expect(findFillers(w, [...DEFAULT_FILLERS, 'You know', 'you'])).toEqual([; expect(fillerRanges(w, hits, R)).toEqual([. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transcript mapping/range/caption functions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “finds fillers, longest phrase first, without cutting into neighbours” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: filler ranges never reach into the neighbouring words
Original location: `packages/project/test/sequence-transcript.test.ts:195`.
1. Contract from the section source: filler ranges never reach into the neighbouring words.
2. Detectable caller failure: Wrong words/time cuts, overlapping/missing captions or bad search; specifically the named case would return or store the wrong result.
3. Oracle: expect(a * F).toBeGreaterThanOrEqual(words[0]!.end);; expect(b * F).toBeLessThanOrEqual(words[2]!.start);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transcript mapping/range/caption functions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “filler ranges never reach into the neighbouring words” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: merges ranges
Original location: `packages/project/test/sequence-transcript.test.ts:206`.
1. Contract from the section source: merges ranges.
2. Detectable caller failure: Wrong words/time cuts, overlapping/missing captions or bad search; specifically the named case would return or store the wrong result.
3. Oracle: expect(. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transcript mapping/range/caption functions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “merges ranges” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: follow line length, speaker and pause rules
Original location: `packages/project/test/sequence-transcript.test.ts:234`.
1. Contract from the section source: follow line length, speaker and pause rules.
2. Detectable caller failure: Wrong words/time cuts, overlapping/missing captions or bad search; specifically the named case would return or store the wrong result.
3. Oracle: expect(b.map((x) => x.text)).toEqual([; expect([b[0]!.start, b[0]!.end]).toEqual([s(0.48), s(1.72)]);; expect(b[2]!.speaker).toBe('Speaker 2');; expect(b[2]!.words).toEqual([10, 20]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transcript mapping/range/caption functions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “follow line length, speaker and pause rules” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### REWRITE: never overlap with dense words
Original location: `packages/project/test/sequence-transcript.test.ts:258`.
Change: Require nonempty output before checking caption duration, overlap and gap constraints so dropping all words cannot pass.
1. Contract from the section source: never overlap with dense words.
2. Detectable caller failure: Wrong words/time cuts, overlapping/missing captions or bad search; specifically the named case would return or store the wrong result.
3. Oracle: Require nonempty output before checking caption duration, overlap and gap constraints so dropping all words cannot pass.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transcript mapping/range/caption functions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “never overlap with dense words” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: a short caption extends into the silence but never over the next caption
Original location: `packages/project/test/sequence-transcript.test.ts:268`.
1. Contract from the section source: a short caption extends into the silence but never over the next caption.
2. Detectable caller failure: Wrong words/time cuts, overlapping/missing captions or bad search; specifically the named case would return or store the wrong result.
3. Oracle: expect(b).toHaveLength(2);; expect(b[0]!.end).toBe(b[1]!.start);; expect(b[1]!.end - b[1]!.start).toBe(s(1));. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transcript mapping/range/caption functions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “a short caption extends into the silence but never over the next caption” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: breaks at maximum duration
Original location: `packages/project/test/sequence-transcript.test.ts:278`.
1. Contract from the section source: breaks at maximum duration.
2. Detectable caller failure: Wrong words/time cuts, overlapping/missing captions or bad search; specifically the named case would return or store the wrong result.
3. Oracle: expect(b.length).toBeGreaterThan(1);; expect(words[x.words[1] - 1]!.end - words[x.words[0]]!.start).toBeLessThanOrEqual(s(7));. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes transcript mapping/range/caption functions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “breaks at maximum duration” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

## packages/project/test/shapes.test.ts

Independent sources: docs/wp-notes/shapes.md; persisted shape command API and documented centre regressions. Production seam: shape transactions, snapshot/evaluation/hit-test API. Non-test callers: web shape drawing/controls and preview/export. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in wrong visible geometry, centre jump, selection or stored animation.

### KEEP: defaults: 400×400 at the sequence centre, white fill, no stroke, radius 0, 5 s, graphics label
Original location: `packages/project/test/shapes.test.ts:44`.
1. Contract from the section source: defaults: 400×400 at the sequence centre, white fill, no stroke, radius 0, 5 s, graphics label.
2. Detectable caller failure: Wrong visible geometry, centre jump, selection or stored animation; specifically the named case would return or store the wrong result.
3. Oracle: expect(c).toMatchObject({ kind: 'shape', name: 'Rectangle', label: 'magenta', start: 0, duration: 150 });; expect(c.shape).toEqual({; expect(c.transform.position.value).toEqual([960, 540]);; expect(c.transform.anchor.value).toEqual([200, 200]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes shape transactions, snapshot/evaluation/hit-test API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “defaults: 400×400 at the sequence centre, white fill, no stroke, radius 0, 5 s, graphics label” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: takes size, fill, stroke, radius, transform, duration and name
Original location: `packages/project/test/shapes.test.ts:62`.
1. Contract from the section source: takes size, fill, stroke, radius, transform, duration and name.
2. Detectable caller failure: Wrong visible geometry, centre jump, selection or stored animation; specifically the named case would return or store the wrong result.
3. Oracle: expect(c.duration).toBe(60);; expect(c.name).toBe('Box');; expect(c.shape.fill).toBeNull();; expect(c.shape.stroke).toEqual({. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes shape transactions, snapshot/evaluation/hit-test API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “takes size, fill, stroke, radius, transform, duration and name” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: validates colours, sizes and the rectangle-only corner radius
Original location: `packages/project/test/shapes.test.ts:92`.
1. Contract from the section source: validates colours, sizes and the rectangle-only corner radius.
2. Detectable caller failure: Wrong visible geometry, centre jump, selection or stored animation; specifically the named case would return or store the wrong result.
3. Oracle: expect(fail({ type: 'rect', fill: [2, 0, 0, 1] })?.code).toBe('E_INVALID_PARAM');; expect(fail({ type: 'rect', size: [40000, 10] })?.code).toBe('E_INVALID_PARAM');; expect(fail({ type: 'rect', stroke: { color: [0, 0, 0, 1], width: 5000 } })?.code).toBe(; expect(fail({ type: 'ellipse', cornerRadius: 4 })?.code).toBe('E_INVALID_PARAM');. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes shape transactions, snapshot/evaluation/hit-test API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “validates colours, sizes and the rectangle-only corner radius” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: places like text: overwrite on the target track, creates missing tracks, refuses locked tracks
Original location: `packages/project/test/shapes.test.ts:109`.
1. Contract from the section source: places like text: overwrite on the target track, creates missing tracks, refuses locked tracks.
2. Detectable caller failure: Wrong visible geometry, centre jump, selection or stored animation; specifically the named case would return or store the wrong result.
3. Oracle: expect(h.seq.videoTracks.length).toBeGreaterThanOrEqual(5);; expect(r.ok ? null : r.errors[0]!.code).toBe('E_TRACK_LOCKED');. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes shape transactions, snapshot/evaluation/hit-test API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “places like text: overwrite on the target track, creates missing tracks, refuses locked tracks” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: merges fill, stroke and radius; null removes fill / stroke
Original location: `packages/project/test/shapes.test.ts:121`.
1. Contract from the section source: merges fill, stroke and radius; null removes fill / stroke.
2. Detectable caller failure: Wrong visible geometry, centre jump, selection or stored animation; specifically the named case would return or store the wrong result.
3. Oracle: expect(upd({ fill: null }).ok).toBe(true);; expect(shapeOf(h, id).shape.fill).toBeNull();; expect(upd({ stroke: { width: 3 } }).ok).toBe(true);; expect(shapeOf(h, id).shape.stroke).toEqual({. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes shape transactions, snapshot/evaluation/hit-test API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “merges fill, stroke and radius; null removes fill / stroke” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: accepts Animatables; a static value replaces keys; validates every key
Original location: `packages/project/test/shapes.test.ts:146`.
1. Contract from the section source: accepts Animatables; a static value replaces keys; validates every key.
2. Detectable caller failure: Wrong visible geometry, centre jump, selection or stored animation; specifically the named case would return or store the wrong result.
3. Oracle: expect(h.tx([{ type: 'clip.update', clipId: id, patch: { shape: { size } } }]).ok).toBe(true);; expect(shapeOf(h, id).shape.size.keyframes).toHaveLength(2);; expect(r.ok ? null : r.errors[0]!.code).toBe('E_INVALID_PARAM');; expect(h.tx([{ type: 'clip.update', clipId: id, patch: { shape: { size: [50, 60] } } }]).ok).toBe(true);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes shape transactions, snapshot/evaluation/hit-test API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “accepts Animatables; a static value replaces keys; validates every key” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: refuses cornerRadius on ellipses and shape patches on other kinds
Original location: `packages/project/test/shapes.test.ts:170`.
1. Contract from the section source: refuses cornerRadius on ellipses and shape patches on other kinds.
2. Detectable caller failure: Wrong visible geometry, centre jump, selection or stored animation; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.ok ? null : r.errors[0]!.code).toBe('E_INVALID_PARAM');; expect(r2.ok ? null : r2.errors[0]!.code).toBe('E_INVALID_PARAM');. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes shape transactions, snapshot/evaluation/hit-test API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “refuses cornerRadius on ellipses and shape patches on other kinds” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: param.set writes size, fill, stroke and radius; clamps negative sizes
Original location: `packages/project/test/shapes.test.ts:184`.
1. Contract from the section source: param.set writes size, fill, stroke and radius; clamps negative sizes.
2. Detectable caller failure: Wrong visible geometry, centre jump, selection or stored animation; specifically the named case would return or store the wrong result.
3. Oracle: expect(set(['shape', 'size'], [640, 360]).ok).toBe(true);; expect(shapeOf(h, id).shape.size.value).toEqual([640, 360]);; expect(clamped.ok && clamped.warnings.map((w) => w.code)).toEqual(['W_VALUE_CLAMPED']);; expect(shapeOf(h, id).shape.size.value).toEqual([0, 20]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes shape transactions, snapshot/evaluation/hit-test API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “param.set writes size, fill, stroke and radius; clamps negative sizes” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: keyframes on size, fill, stroke and radius go through the shared keyframe commands and evaluator
Original location: `packages/project/test/shapes.test.ts:200`.
1. Contract from the section source: keyframes on size, fill, stroke and radius go through the shared keyframe commands and evaluator.
2. Detectable caller failure: Wrong visible geometry, centre jump, selection or stored animation; specifically the named case would return or store the wrong result.
3. Oracle: expect(evaluate(s.size, 15 * F)).toEqual([600, 300]);; expect(evaluate(s.fill!, 15 * F)).toEqual([0.5, 0.5, 0.5, 1]);; expect(evaluate(s.cornerRadius, 15 * F)).toBe(25);; expect(evaluate(s.stroke!.width, 15 * F)).toBe(6);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes shape transactions, snapshot/evaluation/hit-test API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “keyframes on size, fill, stroke and radius go through the shared keyframe commands and evaluator” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: static size and stroke edits keep the geometry centre on screen
Original location: `packages/project/test/shapes.test.ts:256`.
1. Contract from the section source: static size and stroke edits keep the geometry centre on screen.
2. Detectable caller failure: Wrong visible geometry, centre jump, selection or stored animation; specifically the named case would return or store the wrong result.
3. Oracle: expect(shapeOf(h, id).transform.anchor.value).toEqual([450, 60]);; expect(centreOnScreen(h, id)).toEqual(at0);; expect(shapeOf(h, id).transform.anchor.value).toEqual([460, 70]);; expect(c[0]).toBeCloseTo(at0[0], 9);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes shape transactions, snapshot/evaluation/hit-test API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “static size and stroke edits keep the geometry centre on screen” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: keyframes that grow or shrink the largest size move the anchor (value and keys) by half
Original location: `packages/project/test/shapes.test.ts:280`.
1. Contract from the section source: keyframes that grow or shrink the largest size move the anchor (value and keys) by half.
2. Detectable caller failure: Wrong visible geometry, centre jump, selection or stored animation; specifically the named case would return or store the wrong result.
3. Oracle: expect(a.keyframes.map((k) => k.value)).toEqual([[500, 200]]);; expect(centreOnScreen(h, id, 0)).toEqual([960, 540]);; expect(centreOnScreen(h, id, 60)).toEqual([960, 540]);; expect(shapeOf(h, id).transform.anchor.keyframes[0]!.value).toEqual([200, 200]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes shape transactions, snapshot/evaluation/hit-test API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “keyframes that grow or shrink the largest size move the anchor (value and keys) by half” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: flags colours outside 0..1
Original location: `packages/project/test/shapes.test.ts:317`.
1. Contract from the section source: flags colours outside 0..1.
2. Detectable caller failure: Wrong visible geometry, centre jump, selection or stored animation; specifically the named case would return or store the wrong result.
3. Oracle: expect(checkInvariants(doc).map((i) => i.message)).toContainEqual(expect.stringMatching(/colours/));. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes shape transactions, snapshot/evaluation/hit-test API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “flags colours outside 0..1” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: snapshot carries the unevaluated shape, its box and the Remotion engine
Original location: `packages/project/test/shapes.test.ts:325`.
1. Contract from the section source: snapshot carries the unevaluated shape, its box and the Remotion engine.
2. Detectable caller failure: Wrong visible geometry, centre jump, selection or stored animation; specifically the named case would return or store the wrong result.
3. Oracle: expect(clip.source).toEqual({ shape: shapeOf(h, id).shape });; expect(clip.intrinsicBox).toEqual({ width: 408, height: 408 });; expect(clip.engine).toBe('remotion');. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes shape transactions, snapshot/evaluation/hit-test API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “snapshot carries the unevaluated shape, its box and the Remotion engine” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: properties: corner radius for rectangles only; all shape keys are listed for agents
Original location: `packages/project/test/shapes.test.ts:339`.
1. Contract from the section source: properties: corner radius for rectangles only; all shape keys are listed for agents.
2. Detectable caller failure: Wrong visible geometry, centre jump, selection or stored animation; specifically the named case would return or store the wrong result.
3. Oracle: expect(keys(rect)).toEqual([; expect(keys(ell)).not.toContain('shape.cornerRadius');; expect(size?.kinds).toEqual(['shape']);; expect(schema.properties.find((p) => p.key === 'shape.cornerRadius')?.kinds).toEqual(['shape']);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes shape transactions, snapshot/evaluation/hit-test API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “properties: corner radius for rectangles only; all shape keys are listed for agents” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: evaluates and clamps, centres the geometry in the box, drops zero-width strokes
Original location: `packages/project/test/shapes.test.ts:364`.
1. Contract from the section source: evaluates and clamps, centres the geometry in the box, drops zero-width strokes.
2. Detectable caller failure: Wrong visible geometry, centre jump, selection or stored animation; specifically the named case would return or store the wrong result.
3. Oracle: expect(g).toMatchObject({ size: [100, 40], origin: [10, 10], cornerRadius: 20, stroke: null });; expect(evaluateShape(ell, 0, { width: 400, height: 400 }).cornerRadius).toBe(0);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes shape transactions, snapshot/evaluation/hit-test API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “evaluates and clamps, centres the geometry in the box, drops zero-width strokes” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: hit-tests the drawn geometry: ellipse interior, rounded corners and the outer stroke band
Original location: `packages/project/test/shapes.test.ts:376`.
1. Contract from the section source: hit-tests the drawn geometry: ellipse interior, rounded corners and the outer stroke band.
2. Detectable caller failure: Wrong visible geometry, centre jump, selection or stored animation; specifically the named case would return or store the wrong result.
3. Oracle: expect(shapeContainsPoint(ell, [100, 50])).toBe(true);; expect(shapeContainsPoint(ell, [5, 5])).toBe(false); // inside the box, outside the ellipse; expect(shapeContainsPoint(ell, [199, 50])).toBe(true);; expect(shapeContainsPoint(g, [5, 5])).toBe(false); // corner cut by the radius. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes shape transactions, snapshot/evaluation/hit-test API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “hit-tests the drawn geometry: ellipse interior, rounded corners and the outer stroke band” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: keyframe.move onto the largest key keeps the shape in place (finding 1)
Original location: `packages/project/test/shapes.test.ts:403`.
1. Contract from the section source: keyframe.move onto the largest key keeps the shape in place (finding 1).
2. Detectable caller failure: Wrong visible geometry, centre jump, selection or stored animation; specifically the named case would return or store the wrong result.
3. Oracle: expect(centreOnScreen(h, id, 0)).toEqual([960, 540]);; expect(centreOnScreen(h, id, 30)).toEqual([960, 540]);; expect(shapeOf(h, id).shape.size.keyframes.map((k) => k.value)).toEqual([[100, 100]]);; expect(shapeIntrinsicBox(shapeOf(h, id).shape)).toEqual({ width: 100, height: 100 });. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes shape transactions, snapshot/evaluation/hit-test API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “keyframe.move onto the largest key keeps the shape in place (finding 1)” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: keyframe.move deleting the widest outside-stroke key keeps the shape in place
Original location: `packages/project/test/shapes.test.ts:417`.
1. Contract from the section source: keyframe.move deleting the widest outside-stroke key keeps the shape in place.
2. Detectable caller failure: Wrong visible geometry, centre jump, selection or stored animation; specifically the named case would return or store the wrong result.
3. Oracle: expect(shapeIntrinsicBox(shapeOf(h, id).shape)).toEqual({ width: 280, height: 280 });; expect(shapeIntrinsicBox(shapeOf(h, id).shape)).toEqual({ width: 208, height: 208 });; expect(centreOnScreen(h, id, 0)).toEqual([960, 540]);; expect(centreOnScreen(h, id, 10)).toEqual([960, 540]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes shape transactions, snapshot/evaluation/hit-test API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “keyframe.move deleting the widest outside-stroke key keeps the shape in place” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: once keyed, the box ignores a stale static value (size and stroke width, finding 2)
Original location: `packages/project/test/shapes.test.ts:435`.
1. Contract from the section source: once keyed, the box ignores a stale static value (size and stroke width, finding 2).
2. Detectable caller failure: Wrong visible geometry, centre jump, selection or stored animation; specifically the named case would return or store the wrong result.
3. Oracle: expect(shapeIntrinsicBox(stale)).toEqual({ width: 280, height: 230 });; expect(shapeIntrinsicBox(stale)).toEqual({ width: 208, height: 158 });. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes shape transactions, snapshot/evaluation/hit-test API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “once keyed, the box ignores a stale static value (size and stroke width, finding 2)” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: re-centring stays correct across static → animated → static with a stale value
Original location: `packages/project/test/shapes.test.ts:454`.
1. Contract from the section source: re-centring stays correct across static → animated → static with a stale value.
2. Detectable caller failure: Wrong visible geometry, centre jump, selection or stored animation; specifically the named case would return or store the wrong result.
3. Oracle: expect(c[0]).toBeCloseTo(at0[0], 9);; expect(c[1]).toBeCloseTo(at0[1], 9);; expect(s.size.value).toEqual([400, 400]);; expect(shapeIntrinsicBox(s)).toEqual({ width: 200, height: 200 });. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes shape transactions, snapshot/evaluation/hit-test API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “re-centring stays correct across static → animated → static with a stale value” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: only an explicit value creates a "None" fill or stroke; the stopwatch on None is refused (finding 3)
Original location: `packages/project/test/shapes.test.ts:485`.
1. Contract from the section source: only an explicit value creates a "None" fill or stroke; the stopwatch on None is refused (finding 3).
2. Detectable caller failure: Wrong visible geometry, centre jump, selection or stored animation; specifically the named case would return or store the wrong result.
3. Oracle: expect(; expect(code({ type: 'keyframe.add', target: ['clip', id, 'shape', 'stroke', 'width'], at: at(0) })).toBe(; expect(shapeOf(h, id).shape.fill).toBeNull();; expect(shapeOf(h, id).shape.stroke).toBeNull();. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes shape transactions, snapshot/evaluation/hit-test API through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “only an explicit value creates a "None" fill or stroke; the stopwatch on None is refused (finding 3)” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

## packages/project/test/simplify-doc.test.ts

Independent sources: docs/wp-notes/wp-m2-track.md keyframe simplification tolerance; AGENTS.md undo/atomic commands. Production seam: simplify/tracker document commands and scene output. Non-test callers: UI Simplify Keyframes, tracker apply and MCP. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in simplification moves the drawn image beyond requested tolerance or damages selections.

### KEEP: property: random dense corner-pin and Motion tracks stay within the tolerance at every frame
Original location: `packages/project/test/simplify-doc.test.ts:144`.
1. Contract from the section source: property: random dense corner-pin and Motion tracks stay within the tolerance at every frame.
2. Detectable caller failure: Simplification moves the drawn image beyond requested tolerance or damages selections; specifically the named case would return or store the wrong result.
3. Oracle: expect(maxShift(after[f]!.quad, before[f]!.quad)).toBeLessThanOrEqual(tol + 1e-9);; expect(maxShift(after[f]!.grid, before[f]!.grid)).toBeLessThanOrEqual(tol + 1e-9);; expect(report.maxError).toBeLessThanOrEqual(tol);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes simplify/tracker document commands and scene output through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “property: random dense corner-pin and Motion tracks stay within the tolerance at every frame” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: simplifies only the selected keys, as one undoable transaction, and previews with a dry run
Original location: `packages/project/test/simplify-doc.test.ts:207`.
1. Contract from the section source: simplifies only the selected keys, as one undoable transaction, and previews with a dry run.
2. Detectable caller failure: Simplification moves the drawn image beyond requested tolerance or damages selections; specifically the named case would return or store the wrong result.
3. Oracle: expect(dry.ok).toBe(true);; expect(rep.after).toBeLessThan(rep.before);; expect(rep.groups[0]!.errors!.length).toBe(rep.groups[0]!.samples);; expect(rep.groups[0]!.unit).toBe('px');. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes simplify/tracker document commands and scene output through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “simplifies only the selected keys, as one undoable transaction, and previews with a dry run” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: simplifies opacity within the requested tolerance in percentage units
Original location: `packages/project/test/simplify-doc.test.ts:246`.
1. Contract from the section source: simplifies opacity within the requested tolerance in percentage units.
2. Detectable caller failure: Simplification moves the drawn image beyond requested tolerance or damages selections; specifically the named case would return or store the wrong result.
3. Oracle: expect(report.groups[0]!.kind).toBe('value');; expect(report.groups[0]!.unit).toBe('%');; expect(report.after).toBeLessThan(report.before);; expect(Math.abs(opacity - (50 + 40 * Math.sin(frame / 8)))).toBeLessThanOrEqual(0.5);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes simplify/tracker document commands and scene output through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “simplifies opacity within the requested tolerance in percentage units” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: tracker.apply {simplify} bakes and simplifies in one transaction; trackedOnly targets the tracked params
Original location: `packages/project/test/simplify-doc.test.ts:272`.
1. Contract from the section source: tracker.apply {simplify} bakes and simplifies in one transaction; trackedOnly targets the tracked params.
2. Detectable caller failure: Simplification moves the drawn image beyond requested tolerance or damages selections; specifically the named case would return or store the wrong result.
3. Oracle: expect(res.simplified.after).toBeLessThan(res.simplified.before);; expect(res.simplified.maxError).toBeLessThanOrEqual(0.25);; expect(maxShift(now[f]!.quad, ref[f]!.quad)).toBeLessThanOrEqual(0.25);; expect(rep.properties.every((p) => p.path[0] === 'effect')).toBe(true);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes simplify/tracker document commands and scene output through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “tracker.apply {simplify} bakes and simplifies in one transaction; trackedOnly targets the tracked params” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: refuses ambiguous selections and locked tracks
Original location: `packages/project/test/simplify-doc.test.ts:311`.
1. Contract from the section source: refuses ambiguous selections and locked tracks.
2. Detectable caller failure: Simplification moves the drawn image beyond requested tolerance or damages selections; specifically the named case would return or store the wrong result.
3. Oracle: expect(bad.ok ? null : bad.errors[0]!.code).toBe('E_INVALID_PARAM');; expect(h.doc).toBe(before);; expect(locked.ok ? null : locked.errors[0]!.code).toBe('E_TRACK_LOCKED');; expect(h.doc).toBe(lockedBefore);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes simplify/tracker document commands and scene output through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “refuses ambiguous selections and locked tracks” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

## packages/project/test/simplify.test.ts

Independent sources: keyframe simplification API tolerance/locked-key contract; EffectCraft reference. Production seam: simplifyKeyframes with independent original-track evaluator. Non-test callers: simplify document command and tracker baking. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in simplified track deviates beyond tolerance or loses locked keys.

### KEEP: keeps every frame within the tolerance on random dense tracks (scalar and vec2)
Original location: `packages/project/test/simplify.test.ts:80`.
1. Contract from the section source: keeps every frame within the tolerance on random dense tracks (scalar and vec2).
2. Detectable caller failure: Simplified track deviates beyond tolerance or loses locked keys; specifically the named case would return or store the wrong result.
3. Oracle: expect(out.length).toBeLessThanOrEqual(n);; expect(r.maxError).toBeLessThanOrEqual(tol);; expect(o).toBeDefined();; expect(k.time).toBe(o.time);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes simplifyKeyframes with independent original-track evaluator through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “keeps every frame within the tolerance on random dense tracks (scalar and vec2)” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: honours mixed interpolations (bezier, auto-bezier, hold) at sub-frame samples, inside and outside a span
Original location: `packages/project/test/simplify.test.ts:122`.
1. Contract from the section source: honours mixed interpolations (bezier, auto-bezier, hold) at sub-frame samples, inside and outside a span.
2. Detectable caller failure: Simplified track deviates beyond tolerance or loses locked keys; specifically the named case would return or store the wrong result.
3. Oracle: expect(dist(evaluate(anim(out), t), orig[s]!)).toBeLessThan(1e-6);; expect(out.slice(0, a)).toEqual(keys.slice(0, a));; expect(out.slice(out.length - (keys.length - 1 - b))).toEqual(keys.slice(b + 1));. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes simplifyKeyframes with independent original-track evaluator through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “honours mixed interpolations (bezier, auto-bezier, hold) at sub-frame samples, inside and outside a span” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: keeps locked (unselected) keys inside the span
Original location: `packages/project/test/simplify.test.ts:164`.
1. Contract from the section source: keeps locked (unselected) keys inside the span.
2. Detectable caller failure: Simplified track deviates beyond tolerance or loses locked keys; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.keys[0]!.map((k) => k.id)).toEqual(['kf_0', 'kf_10', 'kf_20', 'kf_29']);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes simplifyKeyframes with independent original-track evaluator through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “keeps locked (unselected) keys inside the span” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: reduces a smooth per-frame curve to few keys and fits eases
Original location: `packages/project/test/simplify.test.ts:175`.
1. Contract from the section source: reduces a smooth per-frame curve to few keys and fits eases.
2. Detectable caller failure: Simplified track deviates beyond tolerance or loses locked keys; specifically the named case would return or store the wrong result.
3. Oracle: expect(out.length).toBeLessThan(keys.length);; expect(r2.out.length).toBeLessThan(dense.length);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes simplifyKeyframes with independent original-track evaluator through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “reduces a smooth per-frame curve to few keys and fits eases” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: solves channels with shared key times jointly and others with a share of the tolerance
Original location: `packages/project/test/simplify.test.ts:188`.
1. Contract from the section source: solves channels with shared key times jointly and others with a share of the tolerance.
2. Detectable caller failure: Simplified track deviates beyond tolerance or loses locked keys; specifically the named case would return or store the wrong result.
3. Oracle: expect(e).toBeLessThanOrEqual(tol);; expect(r.after[0]!).toBeLessThan(50);; expect(r.after[2]!).toBeLessThan(25);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes simplifyKeyframes with independent original-track evaluator through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “solves channels with shared key times jointly and others with a share of the tolerance” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

## packages/project/test/source-range.test.ts

Independent sources: docs/specs/07-clip-processing.md PRC-015–019; docs/project-files.md versioned storage. Production seam: derive/swap/relink command API, sidecar parser and load/migration. Non-test callers: engine processing/import, web source switching and persistence. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in wrong source frame, clip timing, handle, relation or migration data.

### KEEP: records the processed range as the version's sourceRange and names the item after it
Original location: `packages/project/test/source-range.test.ts:158`.
1. Contract from the section source: records the processed range as the version's sourceRange and names the item after it.
2. Detectable caller failure: Wrong source frame, clip timing, handle, relation or migration data; specifically the named case would return or store the wrong result.
3. Oracle: expect(m.sourceRange).toEqual({; expect(item.name).toContain('1090–1219');; expect(rootFrameSpan(h.doc, v.id)).toEqual({ rootId: mediaId, start: 1090, end: 1220, rate: R30 });; expect(originalMediaId(h.doc, v.id)).toBe(mediaId);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes derive/swap/relink command API, sidecar parser and load/migration through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “records the processed range as the version's sourceRange and names the item after it” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: records the whole source for unranged versions, and refuses ranges that do not match the file
Original location: `packages/project/test/source-range.test.ts:177`.
1. Contract from the section source: records the whole source for unranged versions, and refuses ranges that do not match the file.
2. Detectable caller failure: Wrong source frame, clip timing, handle, relation or migration data; specifically the named case would return or store the wrong result.
3. Oracle: expect(h.doc.media[v.id]!.sourceRange).toMatchObject({ firstFrame: 0, frames: 1800 });; expect(bad.ok).toBe(false);; expect(!bad.ok && bad.errors[0]!.code).toBe('E_INVALID_PARAM');; expect(!outside.ok && outside.errors[0]!.code).toBe('E_OUT_OF_MEDIA');. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes derive/swap/relink command API, sidecar parser and load/migration through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “records the whole source for unranged versions, and refuses ranges that do not match the file” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: swaps a clip onto a range with handles: same source frames, same timeline place, handles from the range
Original location: `packages/project/test/source-range.test.ts:204`.
1. Contract from the section source: swaps a clip onto a range with handles: same source frames, same timeline place, handles from the range.
2. Detectable caller failure: Wrong source frame, clip timing, handle, relation or migration data; specifically the named case would return or store the wrong result.
3. Oracle: expect(before.slice(0, 2)).toEqual([1100, 1101]);; expect(v.result.clipIds).toEqual([videoId]);; expect(c.mediaId).toBe(v.id);; expect(c.sourceIn).toBe(12 * F30);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes derive/swap/relink command API, sidecar parser and load/migration through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “swaps a clip onto a range with handles: same source frames, same timeline place, handles from the range” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: switches directly between two ranged versions of one original (and versions of versions)
Original location: `packages/project/test/source-range.test.ts:229`.
1. Contract from the section source: switches directly between two ranged versions of one original (and versions of versions).
2. Detectable caller failure: Wrong source frame, clip timing, handle, relation or migration data; specifically the named case would return or store the wrong result.
3. Oracle: expect(rootFrameSpan(h.doc, c)).toMatchObject({ rootId: mediaId, start: 490, end: 600 });; expect(r.results[0]).toMatchObject({ changed: true });; expect(vclip(h, videoId).sourceIn).toBe(inFrame * F30);; expect(shownRootFrames(h, videoId)).toEqual(want);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes derive/swap/relink command API, sidecar parser and load/migration through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “switches directly between two ranged versions of one original (and versions of versions)” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: the clip shows the same source frames at the same timeline frames, and swapping back restores it exactly
Original location: `packages/project/test/source-range.test.ts:261`.
1. Contract from the section source: the clip shows the same source frames at the same timeline frames, and swapping back restores it exactly.
2. Detectable caller failure: Wrong source frame, clip timing, handle, relation or migration data; specifically the named case would return or store the wrong result.
3. Oracle: expect(c.start).toBe(p.start);; expect(c.duration).toBe(p.duration);; expect(c.sourceIn).toBe(original.sourceIn - startFrame * F);; expect(shownRootFrames(h, videoId)).toEqual(want);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes derive/swap/relink command API, sidecar parser and load/migration through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “the clip shows the same source frames at the same timeline frames, and swapping back restores it exactly” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: keeps exactly the timeline frames whose content lies in the file
Original location: `packages/project/test/source-range.test.ts:329`.
1. Contract from the section source: keeps exactly the timeline frames whose content lies in the file.
2. Detectable caller failure: Wrong source frame, clip timing, handle, relation or migration data; specifically the named case would return or store the wrong result.
3. Oracle: expect(expected).toEqual([]);; expect(expected[0]).toBe(cov.from);; expect(expected.at(-1)).toBe(cov.to - 1);; expect(expected.length).toBe(cov.to - cov.from);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes derive/swap/relink command API, sidecar parser and load/migration through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “keeps exactly the timeline frames whose content lies in the file” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: shifts nested keyframes and tracker times, dropping samples and markers before the file
Original location: `packages/project/test/source-range.test.ts:368`.
1. Contract from the section source: shifts nested keyframes and tracker times, dropping samples and markers before the file.
2. Detectable caller failure: Wrong source frame, clip timing, handle, relation or migration data; specifically the named case would return or store the wrong result.
3. Oracle: expect(shiftClipContentTime(clip, -4 * F30)).toEqual({; expect(clip.markers[0]!.flicks).toBe(8 * F30);; expect(clip.transform.scale.keyframes[0]!.time).toBe(7 * F30);; expect(clip.effects[0]!.params.amount.keyframes.map((k) => k.time)).toEqual([-4 * F30, -1 * F30]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes derive/swap/relink command API, sidecar parser and load/migration through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “shifts nested keyframes and tracker times, dropping samples and markers before the file” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: refuses with source ranges in the diagnostic and leaves the document unchanged
Original location: `packages/project/test/source-range.test.ts:419`.
1. Contract from the section source: refuses with source ranges in the diagnostic and leaves the document unchanged.
2. Detectable caller failure: Wrong source frame, clip timing, handle, relation or migration data; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.ok).toBe(false);; expect(!r.ok && r.errors[0]!.code).toBe('E_OUT_OF_MEDIA');; expect(message).toContain('1100–1139');; expect(message).toContain('1090–1149');. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes derive/swap/relink command API, sidecar parser and load/migration through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “refuses with source ranges in the diagnostic and leaves the document unchanged” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: fit: "trim" trims the clip and its linked audio to the covered frames, still on the same source frames
Original location: `packages/project/test/source-range.test.ts:432`.
1. Contract from the section source: fit: "trim" trims the clip and its linked audio to the covered frames, still on the same source frames.
2. Detectable caller failure: Wrong source frame, clip timing, handle, relation or migration data; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.results[0]).toMatchObject({ changed: true, trimmed: { head: 10, tail: 10 } });; expect([c.start, c.duration, c.sourceIn]).toEqual([40, 40, 0]);; expect(shownRootFrames(h, videoId)).toEqual(before.slice(10, 50));; expect([a.start, a.duration, a.sourceIn]).toEqual([40, 40, 1100 * F30]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes derive/swap/relink command API, sidecar parser and load/migration through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “fit: "trim" trims the clip and its linked audio to the covered frames, still on the same source frames” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: fit: "trim" on a reverse clip trims the right ends
Original location: `packages/project/test/source-range.test.ts:445`.
1. Contract from the section source: fit: "trim" on a reverse clip trims the right ends.
2. Detectable caller failure: Wrong source frame, clip timing, handle, relation or migration data; specifically the named case would return or store the wrong result.
3. Oracle: expect([c.start, c.duration, c.sourceIn]).toEqual([50, 30, 0]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes derive/swap/relink command API, sidecar parser and load/migration through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “fit: "trim" on a reverse clip trims the right ends” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: fit: "skip" leaves the clip with a warning; media.derive replaceInClips uses it per clip
Original location: `packages/project/test/source-range.test.ts:455`.
1. Contract from the section source: fit: "skip" leaves the clip with a warning; media.derive replaceInClips uses it per clip.
2. Detectable caller failure: Wrong source frame, clip timing, handle, relation or migration data; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.results[0]).toMatchObject({ clipIds: [], skippedClipIds: [videoId] });; expect(r.warnings.map((w) => w.code)).toContain('W_CLIP_SKIPPED');; expect(vclip(h, videoId).mediaId).toBe(mediaId);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes derive/swap/relink command API, sidecar parser and load/migration through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “fit: "skip" leaves the clip with a warning; media.derive replaceInClips uses it per clip” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: warns when a source swap shortens transition handles
Original location: `packages/project/test/source-range.test.ts:473`.
1. Contract from the section source: warns when a source swap shortens transition handles.
2. Detectable caller failure: Wrong source frame, clip timing, handle, relation or migration data; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.warnings.map((w) => w.code)).toContain('W_TRANSITION_SHORTENED');. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes derive/swap/relink command API, sidecar parser and load/migration through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “warns when a source swap shortens transition handles” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: reads the trailer grade sidecar, jasper-proc sidecars and the generic shape
Original location: `packages/project/test/source-range.test.ts:515`.
1. Contract from the section source: reads the trailer grade sidecar, jasper-proc sidecars and the generic shape.
2. Detectable caller failure: Wrong source frame, clip timing, handle, relation or migration data; specifically the named case would return or store the wrong result.
3. Oracle: expect(parseSourceSidecar(T02_SIDECAR, '/x/T02.json')).toEqual({; expect(; expect(; expect(parseSourceSidecar({ name: 'jasper-proc', input: { path: 'a' } })).toBeNull();. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes derive/swap/relink command API, sidecar parser and load/migration through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “reads the trailer grade sidecar, jasper-proc sidecars and the generic shape” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: binds an imported render sidecar to the source media by filename
Original location: `packages/project/test/source-range.test.ts:551`.
1. Contract from the section source: binds an imported render sidecar to the source media by filename.
2. Detectable caller failure: Wrong source frame, clip timing, handle, relation or migration data; specifically the named case would return or store the wrong result.
3. Oracle: expect(range).toEqual({; expect(mediaVersionsOf(h.doc, mediaId)).toEqual([mediaId, t]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes derive/swap/relink command API, sidecar parser and load/migration through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “binds an imported render sidecar to the source media by filename” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: media.setSourceRange links, re-links and clears; refuses cycles and rate mismatches
Original location: `packages/project/test/source-range.test.ts:570`.
1. Contract from the section source: media.setSourceRange links, re-links and clears; refuses cycles and rate mismatches.
2. Detectable caller failure: Wrong source frame, clip timing, handle, relation or migration data; specifically the named case would return or store the wrong result.
3. Oracle: expect(originalMediaId(h.doc, o)).toBe(mediaId);; expect(!cyc.ok && cyc.errors[0]!.code).toBe('E_INVALID_PARAM');; expect(!self.ok && self.errors[0]!.code).toBe('E_INVALID_PARAM');; expect(!bad.ok && bad.errors[0]!.code).toBe('E_INVALID_PARAM');. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes derive/swap/relink command API, sidecar parser and load/migration through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “media.setSourceRange links, re-links and clears; refuses cycles and rate mismatches” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: resolves two source ranges and refuses incompatible sources or frame rates
Original location: `packages/project/test/source-range.test.ts:612`.
1. Contract from the section source: resolves two source ranges and refuses incompatible sources or frame rates.
2. Detectable caller failure: Wrong source frame, clip timing, handle, relation or migration data; specifically the named case would return or store the wrong result.
3. Oracle: expect(; expect(sourceTimingShift(raw, { ...replacement(130), sourceRange: r(174, 'other.mp4') })).toMatchObject({; expect(; expect(sourceTimingShift(raw, { ...at25, sourceRange: r(1) })).toMatchObject({. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes derive/swap/relink command API, sidecar parser and load/migration through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “resolves two source ranges and refuses incompatible sources or frame rates” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: moves every clip, mark and marker of the media so the same source frames stay at the same place
Original location: `packages/project/test/source-range.test.ts:673`.
1. Contract from the section source: moves every clip, mark and marker of the media so the same source frames stay at the same place.
2. Detectable caller failure: Wrong source frame, clip timing, handle, relation or migration data; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.results[0]).toMatchObject({ mediaId, shiftFrames: -174, basis: 'range-of-current' });; expect(m.fingerprint).toBe(t02.fingerprint);; expect(m.locators).toEqual(t02.locators);; expect(m.sourceRange).toEqual(sr);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes derive/swap/relink command API, sidecar parser and load/migration through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “moves every clip, mark and marker of the media so the same source frames stay at the same place” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: refuses (or trims) clips the new file does not hold, and without keep-timing keeps content time
Original location: `packages/project/test/source-range.test.ts:710`.
1. Contract from the section source: refuses (or trims) clips the new file does not hold, and without keep-timing keeps content time.
2. Detectable caller failure: Wrong source frame, clip timing, handle, relation or migration data; specifically the named case would return or store the wrong result.
3. Oracle: expect(!refused.ok && refused.errors[0]!.code).toBe('E_OUT_OF_MEDIA');; expect(trimmed.results[0]).toMatchObject({ trimmedClipIds: expect.arrayContaining([videoId]) });; expect([vclip(h, videoId).start, vclip(h, videoId).duration]).toEqual([0, 54]);; expect(checkInvariants(h.doc)).toEqual([]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes derive/swap/relink command API, sidecar parser and load/migration through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “refuses (or trims) clips the new file does not hold, and without keep-timing keeps content time” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: refuses keep-source-timing without a source relation or timecodes
Original location: `packages/project/test/source-range.test.ts:738`.
1. Contract from the section source: refuses keep-source-timing without a source relation or timecodes.
2. Detectable caller failure: Wrong source frame, clip timing, handle, relation or migration data; specifically the named case would return or store the wrong result.
3. Oracle: expect(!none.ok && none.errors[0]!.code).toBe('E_INVALID_PARAM');; expect(h.doc).toBe(before);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes derive/swap/relink command API, sidecar parser and load/migration through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “refuses keep-source-timing without a source relation or timecodes” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: re-anchors versions of the media on the new file (or detaches those it no longer holds)
Original location: `packages/project/test/source-range.test.ts:746`.
1. Contract from the section source: re-anchors versions of the media on the new file (or detaches those it no longer holds).
2. Detectable caller failure: Wrong source frame, clip timing, handle, relation or migration data; specifically the named case would return or store the wrong result.
3. Oracle: expect(h.doc.media[kept]!.sourceRange).toMatchObject({ mediaId, firstFrame: 50, frames: 200 });; expect(h.doc.media[lost]!.sourceRange).toMatchObject({; expect(r.warnings.map((w) => w.code)).toContain('W_VERSION_DETACHED');; expect(shownRootFrames(h, videoId).map((f) => f + 50)).toEqual(want);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes derive/swap/relink command API, sidecar parser and load/migration through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “re-anchors versions of the media on the new file (or detaches those it no longer holds)” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: keeps source timing by timecode
Original location: `packages/project/test/source-range.test.ts:779`.
1. Contract from the section source: keeps source timing by timecode.
2. Detectable caller failure: Wrong source frame, clip timing, handle, relation or migration data; specifically the named case would return or store the wrong result.
3. Oracle: expect(vclip(h, videoId).sourceIn).toBe(30 * F30);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes derive/swap/relink command API, sidecar parser and load/migration through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “keeps source timing by timecode” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: the v5 fixture (a ranged processed version in use, a sidecar-linked render) loads without repairs
Original location: `packages/project/test/source-range.test.ts:790`.
1. Contract from the section source: the v5 fixture (a ranged processed version in use, a sidecar-linked render) loads without repairs.
2. Detectable caller failure: Wrong source frame, clip timing, handle, relation or migration data; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.readOnly).toBe(false);; expect(r.migration.steps).toEqual(['v5→v6']);; expect(r.repairs).toEqual([]);; expect(r.issues).toEqual([]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes derive/swap/relink command API, sidecar parser and load/migration through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “the v5 fixture (a ranged processed version in use, a sidecar-linked render) loads without repairs” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: records the whole-source range on M2 processed versions
Original location: `packages/project/test/source-range.test.ts:809`.
1. Contract from the section source: records the whole-source range on M2 processed versions.
2. Detectable caller failure: Wrong source frame, clip timing, handle, relation or migration data; specifically the named case would return or store the wrong result.
3. Oracle: expect(m.report.steps).toEqual(['v4→v5', 'v5→v6']);; expect(m.document.media[v]!.sourceRange).toEqual({; expect(m.document.media[mediaId]!.sourceRange).toBeUndefined();. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes derive/swap/relink command API, sidecar parser and load/migration through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “records the whole-source range on M2 processed versions” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

## packages/project/test/three-d-commands.test.ts

Independent sources: docs/wp-notes/three-d.md camera/layer/light command contract. Production seam: 3D transactions and public scene snapshot queries. Non-test callers: web 3D controls, MCP and renderer. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in wrong camera/light/layer state, prohibited transition or hidden light.

### KEEP: turns the 3D Layer switch on with After Effects defaults, off keeps the values
Original location: `packages/project/test/three-d-commands.test.ts:42`.
1. Contract from the section source: turns the 3D Layer switch on with After Effects defaults, off keeps the values.
2. Detectable caller failure: Wrong camera/light/layer state, prohibited transition or hidden light; specifically the named case would return or store the wrong result.
3. Oracle: expect(c.threeD?.enabled).toBe(true);; expect(off.threeD?.enabled).toBe(false);; expect(off.threeD?.positionZ.value).toBe(250);; expect(snap(h).videoTracks[0]!.clips[0]!.threeD).toBeUndefined();. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes 3D transactions and public scene snapshot queries through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “turns the 3D Layer switch on with After Effects defaults, off keeps the values” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: refuses kinds without Motion and clips with transitions; transitions are refused on 3D layers
Original location: `packages/project/test/three-d-commands.test.ts:60`.
1. Contract from the section source: refuses kinds without Motion and clips with transitions; transitions are refused on 3D layers.
2. Detectable caller failure: Wrong camera/light/layer state, prohibited transition or hidden light; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.ok).toBe(false);; expect(refused.ok).toBe(false);; expect(!refused.ok && refused.errors[0]!.message).toMatch(/transitions/);; expect(t.ok).toBe(false);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes 3D transactions and public scene snapshot queries through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “refuses kinds without Motion and clips with transitions; transitions are refused on 3D layers” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: locked tracks refuse
Original location: `packages/project/test/three-d-commands.test.ts:95`.
1. Contract from the section source: locked tracks refuse.
2. Detectable caller failure: Wrong camera/light/layer state, prohibited transition or hidden light; specifically the named case would return or store the wrong result.
3. Oracle: expect(h.tx([{ type: 'clip.set3d', clipIds: [id], enabled: true }]).ok).toBe(false);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes 3D transactions and public scene snapshot queries through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “locked tracks refuse” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: 3D properties are keyframable through param.set; registry rows appear only on 3D layers
Original location: `packages/project/test/three-d-commands.test.ts:102`.
1. Contract from the section source: 3D properties are keyframable through param.set; registry rows appear only on 3D layers.
2. Detectable caller failure: Wrong camera/light/layer state, prohibited transition or hidden light; specifically the named case would return or store the wrong result.
3. Oracle: expect(propertiesForClip(h.seq.clips[id]!).some((s) => s.key === 'threeD.positionZ')).toBe(false);; expect(keys).toEqual(; expect(c.threeD.rotationY.keyframes).toHaveLength(2);; expect(c.threeD.material.castsShadows).toBe('on');. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes 3D transactions and public scene snapshot queries through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “3D properties are keyframable through param.set; registry rows appear only on 3D layers” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### REWRITE: clip.addCamera: a two-node 50 mm camera on top that frames the sequence like the default camera
Original location: `packages/project/test/three-d-commands.test.ts:150`.
1. Contract from the section source: clip.addCamera: a two-node 50 mm camera on top that frames the sequence like the default camera.
2. Detectable caller failure: Wrong camera/light/layer state, prohibited transition or hidden light; specifically the named case would return or store the wrong result.
3. Oracle after final review: docs/wp-notes/three-d.md §2 specifies 50mm, 36mm film and eye (w/2,h/2,−w×50/36). For 1920×1080 assert evaluated eye (960,540,−8000/3), zoom 8000/3 and centre point-of-interest instead of comparing with defaultCamera, which shares the same zoom helper. Preserve 9-digit tolerance.
4. Observes 3D transactions and public scene snapshot queries through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “clip.addCamera: a two-node 50 mm camera on top that frames the sequence like the default camera” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### REWRITE: Camera Settings: preset, focal length, angle of view, f-stop, lock to zoom, one-node
Original location: `packages/project/test/three-d-commands.test.ts:169`.
1. Contract from the section source: Camera Settings: preset, focal length, angle of view, f-stop, lock to zoom, one-node.
2. Detectable caller failure: Wrong camera/light/layer state, prohibited transition or hidden light; specifically the named case would return or store the wrong result.
3. Oracle after final review: The documented 36mm horizontal sensor gives zoom 5600/3 for 35mm and 12800/3 for 80mm at width1920. Assert these known outputs directly, rather than passing actual zoom through production focalLengthForZoom (the inverse of the command helper). Preserve 6-digit tolerance.
4. Observes 3D transactions and public scene snapshot queries through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “Camera Settings: preset, focal length, angle of view, f-stop, lock to zoom, one-node” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: camera tools: orbit keeps the distance to the point of interest; pan moves both; dolly approaches
Original location: `packages/project/test/three-d-commands.test.ts:203`.
1. Contract from the section source: camera tools: orbit keeps the distance to the point of interest; pan moves both; dolly approaches.
2. Detectable caller failure: Wrong camera/light/layer state, prohibited transition or hidden light; specifically the named case would return or store the wrong result.
3. Oracle: expect(dist()).toBeCloseTo(d0, 6);; expect(tr().pointOfInterest.value).not.toEqual(poi0);; expect(dist()).toBeCloseTo(d0, 6);; expect(dist()).toBeCloseTo(d0 - 500, 6);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes 3D transactions and public scene snapshot queries through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “camera tools: orbit keeps the distance to the point of interest; pan moves both; dolly approaches” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: clip.addLight: types, settings, environment media validation
Original location: `packages/project/test/three-d-commands.test.ts:244`.
1. Contract from the section source: clip.addLight: types, settings, environment media validation.
2. Detectable caller failure: Wrong camera/light/layer state, prohibited transition or hidden light; specifically the named case would return or store the wrong result.
3. Oracle: expect(spot.light.type).toBe('spot');; expect(spot.light.coneAngle.value).toBe(60);; expect(spot.light.castsShadows).toBe(true);; expect(spot.light.transform.autoOrient).toBe('poi');. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes 3D transactions and public scene snapshot queries through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “clip.addLight: types, settings, environment media validation” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: disabled and hidden-track lights are off
Original location: `packages/project/test/three-d-commands.test.ts:277`.
1. Contract from the section source: disabled and hidden-track lights are off.
2. Detectable caller failure: Wrong camera/light/layer state, prohibited transition or hidden light; specifically the named case would return or store the wrong result.
3. Oracle: expect(snap(h).scene3d).toBeUndefined();. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes 3D transactions and public scene snapshot queries through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “disabled and hidden-track lights are off” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: 3D runs across tracks; a 2D layer between them splits them; sequence.set3dRenderer
Original location: `packages/project/test/three-d-commands.test.ts:287`.
1. Contract from the section source: 3D runs across tracks; a 2D layer between them splits them; sequence.set3dRenderer.
2. Detectable caller failure: Wrong camera/light/layer state, prohibited transition or hidden light; specifically the named case would return or store the wrong result.
3. Oracle: expect(runs3d(stackAt(s.videoTracks, 10))).toEqual([; expect(c).toBeTruthy();; expect(snap(h).scene3d?.renderer).toBe('advanced');; expect(snap(h).scene3d?.draft).toBe(true);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes 3D transactions and public scene snapshot queries through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “3D runs across tracks; a 2D layer between them splits them; sequence.set3dRenderer” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: a transition kept in an old document on a 3D layer is skipped with a warning
Original location: `packages/project/test/three-d-commands.test.ts:305`.
1. Contract from the section source: a transition kept in an old document on a 3D layer is skipped with a warning.
2. Detectable caller failure: Wrong camera/light/layer state, prohibited transition or hidden light; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.skipped.some((x) => /3D layers/.test(x.reason))).toBe(true);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes 3D transactions and public scene snapshot queries through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “a transition kept in an old document on a 3D layer is skipped with a warning” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

## packages/project/test/time-commands.test.ts

Independent sources: docs/wp-notes/time.md speed/freeze/reverse command contract. Production seam: time-remap transactions and source-time evaluation. Non-test callers: web speed controls, MCP and preview/export. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in wrong media frame/timing, linked audio behavior or edit refusal.

### KEEP: enables with an identity curve and warns that the linked audio stays at 100 %
Original location: `packages/project/test/time-commands.test.ts:40`.
1. Contract from the section source: enables with an identity curve and warns that the linked audio stays at 100 %.
2. Detectable caller failure: Wrong media frame/timing, linked audio behavior or edit refusal; specifically the named case would return or store the wrong result.
3. Oracle: expect(vid(h, v).timeRemap).toMatchObject({ enabled: true, keyframes: [] });; expect(r.warnings.map((w) => w.code)).toContain('W_AUDIO_NOT_REMAPPED');; expect(clipMediaTimeAt(vid(h, v), 30, R)).toBe(30 * F);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes time-remap transactions and source-time evaluation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “enables with an identity curve and warns that the linked audio stays at 100 %” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: mutes or unlinks the linked audio on request
Original location: `packages/project/test/time-commands.test.ts:50`.
1. Contract from the section source: mutes or unlinks the linked audio on request.
2. Detectable caller failure: Wrong media frame/timing, linked audio behavior or edit refusal; specifically the named case would return or store the wrong result.
3. Oracle: expect(h.seq.clips[a]!.enabled).toBe(false);; expect(h2.seq.clips[p.v]!.linkId).toBeNull();; expect(h2.seq.clips[p.a]!.linkId).toBeNull();. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes time-remap transactions and source-time evaluation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “mutes or unlinks the linked audio on request” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: refuses reversed clips and non-video clips
Original location: `packages/project/test/time-commands.test.ts:63`.
1. Contract from the section source: refuses reversed clips and non-video clips.
2. Detectable caller failure: Wrong media frame/timing, linked audio behavior or edit refusal; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.ok).toBe(false);; expect(r2.tx([{ type: 'timeRemap.enable', clipIds: [p.a], enabled: true }]).ok).toBe(false);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes time-remap transactions and source-time evaluation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “refuses reversed clips and non-video clips” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: turning it off deletes the keyframes and trims a slowed clip to its media
Original location: `packages/project/test/time-commands.test.ts:75`.
1. Contract from the section source: turning it off deletes the keyframes and trims a slowed clip to its media.
2. Detectable caller failure: Wrong media frame/timing, linked audio behavior or edit refusal; specifically the named case would return or store the wrong result.
3. Oracle: expect(vid(h, v).duration).toBe(240);; expect(vid(h, v).timeRemap).toBeUndefined();; expect(vid(h, v).duration).toBe(120);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes time-remap transactions and source-time evaluation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “turning it off deletes the keyframes and trims a slowed clip to its media” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: slowing the clip lengthens it until the next clip; ripple pushes instead
Original location: `packages/project/test/time-commands.test.ts:88`.
1. Contract from the section source: slowing the clip lengthens it until the next clip; ripple pushes instead.
2. Detectable caller failure: Wrong media frame/timing, linked audio behavior or edit refusal; specifically the named case would return or store the wrong result.
3. Oracle: expect(vid(h, v).duration).toBe(90);; expect(r.warnings.map((w) => w.code)).toContain('W_DURATION_CLAMPED');; expect(clipMediaTimeAt(vid(h, v), 89, R)).toBeCloseTo(44.5 * F, 3);; expect(vid(h2, p.v).duration).toBe(120);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes time-remap transactions and source-time evaluation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “slowing the clip lengthens it until the next clip; ripple pushes instead” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: a ramp of keyframes: 100 % → 25 % → 400 % with a transition
Original location: `packages/project/test/time-commands.test.ts:107`.
1. Contract from the section source: a ramp of keyframes: 100 % → 25 % → 400 % with a transition.
2. Detectable caller failure: Wrong media frame/timing, linked audio behavior or edit refusal; specifically the named case would return or store the wrong result.
3. Oracle: expect(k2frame).toBeCloseTo(150, 3);; expect(clipSpeedAt(after, 10, R)).toBeCloseTo(1);; expect(clipSpeedAt(after, 30, R)).toBeCloseTo(0.625, 2);; expect(clipSpeedAt(after, 100, R)).toBeCloseTo(0.25);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes time-remap transactions and source-time evaluation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “a ramp of keyframes: 100 % → 25 % → 400 % with a transition” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: motion keyframes stay at their timeline frames when the speed changes
Original location: `packages/project/test/time-commands.test.ts:134`.
1. Contract from the section source: motion keyframes stay at their timeline frames when the speed changes.
2. Detectable caller failure: Wrong media frame/timing, linked audio behavior or edit refusal; specifically the named case would return or store the wrong result.
3. Oracle: expect((vid(h, v).opacity.keyframes as { time: number }[]).map((k) => k.time)).toEqual(before);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes time-remap transactions and source-time evaluation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “motion keyframes stay at their timeline frames when the speed changes” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: freeze frame: holds and moves the rest later
Original location: `packages/project/test/time-commands.test.ts:152`.
1. Contract from the section source: freeze frame: holds and moves the rest later.
2. Detectable caller failure: Wrong media frame/timing, linked audio behavior or edit refusal; specifically the named case would return or store the wrong result.
3. Oracle: expect((r.results[0] as { keyframeIds: string[] }).keyframeIds).toHaveLength(2);; expect(c.duration).toBe(75);; expect(clipMediaTimeAt(c, f, R)).toBeCloseTo(20 * F, 3);; expect(clipMediaTimeAt(c, 36, R)).toBeCloseTo(21 * F, 3);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes time-remap transactions and source-time evaluation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “freeze frame: holds and moves the rest later” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: palindrome reverse plays back and forward again
Original location: `packages/project/test/time-commands.test.ts:166`.
1. Contract from the section source: palindrome reverse plays back and forward again.
2. Detectable caller failure: Wrong media frame/timing, linked audio behavior or edit refusal; specifically the named case would return or store the wrong result.
3. Oracle: expect(c.duration).toBe(80);; expect(frames).toEqual([28, 30, 25, 20, 25, 30, 31]);; expect(remapSegmentViews(c, R).map((s) => [s.kind, Math.round(s.speed * 100)])).toEqual([. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes time-remap transactions and source-time evaluation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “palindrome reverse plays back and forward again” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: moving a hold keyframe slips the held frame
Original location: `packages/project/test/time-commands.test.ts:183`.
1. Contract from the section source: moving a hold keyframe slips the held frame.
2. Detectable caller failure: Wrong media frame/timing, linked audio behavior or edit refusal; specifically the named case would return or store the wrong result.
3. Oracle: expect(clipMediaTimeAt(c, 30, R)).toBeCloseTo(26 * F, 3);; expect(clipMediaTimeAt(c, 36, R)).toBeCloseTo(26 * F, 3);; expect(clipMediaTimeAt(c, 37, R)).toBeCloseTo(27 * F, 3);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes time-remap transactions and source-time evaluation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “moving a hold keyframe slips the held frame” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: split, trim and undo keep the curve consistent; handles come from the remap
Original location: `packages/project/test/time-commands.test.ts:201`.
1. Contract from the section source: split, trim and undo keep the curve consistent; handles come from the remap.
2. Detectable caller failure: Wrong media frame/timing, linked audio behavior or edit refusal; specifically the named case would return or store the wrong result.
3. Oracle: expect(vid(h, v).duration).toBe(120);; expect(rc.timeRemap!.keyframes[0]!.id).not.toBe(vid(h, v).timeRemap!.keyframes[0]!.id);; expect(clipMediaTimeAt(rc, 60, R)).toBeCloseTo(30 * F, 3);; expect(t.ok).toBe(true);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes time-remap transactions and source-time evaluation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “split, trim and undo keep the curve consistent; handles come from the remap” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: Reverse Speed is refused on a remapped clip
Original location: `packages/project/test/time-commands.test.ts:218`.
1. Contract from the section source: Reverse Speed is refused on a remapped clip.
2. Detectable caller failure: Wrong media frame/timing, linked audio behavior or edit refusal; specifically the named case would return or store the wrong result.
3. Oracle: expect(h.tx([{ type: 'clip.setSpeed', clipIds: [v], reverse: true, ripple: false }]).ok).toBe(false);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes time-remap transactions and source-time evaluation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “Reverse Speed is refused on a remapped clip” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: repair fixes malformed remaps
Original location: `packages/project/test/time-commands.test.ts:225`.
1. Contract from the section source: repair fixes malformed remaps.
2. Detectable caller failure: Wrong media frame/timing, linked audio behavior or edit refusal; specifically the named case would return or store the wrong result.
3. Oracle: expect(checkInvariants(doc).length).toBeGreaterThan(0);; expect(checkInvariants(fixed.document)).toEqual([]);; expect(fixed.report.some((e) => e.action === 'repair-time-remap')).toBe(true);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes time-remap transactions and source-time evaluation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “repair fixes malformed remaps” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: sets the interpolation mode on video clips only
Original location: `packages/project/test/time-commands.test.ts:246`.
1. Contract from the section source: sets the interpolation mode on video clips only.
2. Detectable caller failure: Wrong media frame/timing, linked audio behavior or edit refusal; specifically the named case would return or store the wrong result.
3. Oracle: expect(vid(h, v).timeInterpolation).toBe('optical-flow');; expect(r.warnings).toHaveLength(1);; expect(vid(h, v).timeInterpolation).toBeUndefined();. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes time-remap transactions and source-time evaluation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “sets the interpolation mode on video clips only” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: cuts the clip and its audio, adds markers and a bin of scene items in one step
Original location: `packages/project/test/time-commands.test.ts:258`.
1. Contract from the section source: cuts the clip and its audio, adds markers and a bin of scene items in one step.
2. Detectable caller failure: Wrong media frame/timing, linked audio behavior or edit refusal; specifically the named case would return or store the wrong result.
3. Oracle: expect(res.cuts).toEqual([40, 85]);; expect(res.markers).toBe(2);; expect(h.spans('V1')).toEqual([; expect(h.spans('A1')).toEqual([. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes time-remap transactions and source-time evaluation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “cuts the clip and its audio, adds markers and a bin of scene items in one step” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: refuses trackers on remapped clips and remapping tracked clips
Original location: `packages/project/test/time-commands.test.ts:294`.
1. Contract from the section source: refuses trackers on remapped clips and remapping tracked clips.
2. Detectable caller failure: Wrong media frame/timing, linked audio behavior or edit refusal; specifically the named case would return or store the wrong result.
3. Oracle: expect(; expect(h2.tx([{ type: 'timeRemap.enable', clipIds: [p.v], enabled: true }]).ok).toBe(false);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes time-remap transactions and source-time evaluation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “refuses trackers on remapped clips and remapping tracked clips” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: a content shift moves speed keyframes in content and media time
Original location: `packages/project/test/time-commands.test.ts:307`.
1. Contract from the section source: a content shift moves speed keyframes in content and media time.
2. Detectable caller failure: Wrong media frame/timing, linked audio behavior or edit refusal; specifically the named case would return or store the wrong result.
3. Oracle: expect(c.timeRemap!.keyframes.map((k) => [k.time, k.source])).toEqual(. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes time-remap transactions and source-time evaluation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “a content shift moves speed keyframes in content and media time” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: pastes the speed profile onto another clip from its own first frame, and removes it
Original location: `packages/project/test/time-commands.test.ts:322`.
1. Contract from the section source: pastes the speed profile onto another clip from its own first frame, and removes it.
2. Detectable caller failure: Wrong media frame/timing, linked audio behavior or edit refusal; specifically the named case would return or store the wrong result.
3. Oracle: expect((r.results[0] as { applied: Record<string, string[]> }).applied[b.v]).toEqual(['timeRemapping']);; expect(B.duration).toBe(A.duration);; expect(mb).toBeCloseTo(ma, -1);; expect(clipMediaTimeAt(B, B.start, R)).toBeCloseTo(5 * FLICKS_PER_SECOND, -1);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes time-remap transactions and source-time evaluation through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “pastes the speed profile onto another clip from its own first frame, and removes it” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

## packages/project/test/transition-audio.test.ts

Independent sources: docs/wp-notes/keyframes-blend.md audio crossfades; transition API gain laws. Production seam: audio transition commands/snapshot/audioFadeGain. Non-test callers: web transitions, audio preview and export mixer. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in wrong edit-point handles, audible fade interval or gain curve.

### KEEP: creates a two-sided ${c.alignment} crossfade with handles and ramps over [${c.span}]
Original location: `packages/project/test/transition-audio.test.ts:71`.
1. Contract from the section source: creates a two-sided ${c.alignment} crossfade with handles and ramps over [${c.span}].
2. Detectable caller failure: Wrong edit-point handles, audible fade interval or gain curve; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.results[0]).toMatchObject({; expect(r.warnings).toEqual([]);; expect(checkInvariants(h.doc)).toEqual([]);; expect(sa).toMatchObject({ clipId: a, fades: [fade('out')] });. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes audio transition commands/snapshot/audioFadeGain through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “creates a two-sided ${c.alignment} crossfade with handles and ramps over [${c.span}]” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: shortens a crossfade to the media handles (W_TRANSITION_SHORTENED) and refuses one without room
Original location: `packages/project/test/transition-audio.test.ts:110`.
1. Contract from the section source: shortens a crossfade to the media handles (W_TRANSITION_SHORTENED) and refuses one without room.
2. Detectable caller failure: Wrong edit-point handles, audible fade interval or gain curve; specifically the named case would return or store the wrong result.
3. Oracle: expect(centred.ok).toBe(true);; expect(centred.results[0]).toMatchObject({ duration: 8 }); // 4 before the cut, 4 after; expect(centred.warnings.map((w) => w.code)).toEqual(['W_TRANSITION_SHORTENED']);; expect(add('end-at-cut').ok).toBe(true); // only needs B's head. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes audio transition commands/snapshot/audioFadeGain through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “shortens a crossfade to the media handles (W_TRANSITION_SHORTENED) and refuses one without room” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: keeps clipId + edge on an audio clip a one-sided fade, also where another clip touches it
Original location: `packages/project/test/transition-audio.test.ts:146`.
1. Contract from the section source: keeps clipId + edge on an audio clip a one-sided fade, also where another clip touches it.
2. Detectable caller failure: Wrong edit-point handles, audible fade interval or gain curve; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.results[0]).toMatchObject({; expect(outgoing!.clipId).toBe(a);; expect(outgoing!.fades).toBeUndefined();; expect(incoming!.clipId).toBe(b);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes audio transition commands/snapshot/audioFadeGain through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “keeps clipId + edge on an audio clip a one-sided fade, also where another clip touches it” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: degrades at render time when the clips are trimmed after the crossfade was added
Original location: `packages/project/test/transition-audio.test.ts:165`.
1. Contract from the section source: degrades at render time when the clips are trimmed after the crossfade was added.
2. Detectable caller failure: Wrong edit-point handles, audible fade interval or gain curve; specifically the named case would return or store the wrong result.
3. Oracle: expect(outgoing!.clipId).toBe(a);; expect(outgoing!.tailHandle).toBe(1);; expect(incoming!.headHandle).toBeUndefined();; expect(audioFadeGain(outgoing!.fades, 100)).toBe(1);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes audio transition commands/snapshot/audioFadeGain through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “degrades at render time when the clips are trimmed after the crossfade was added” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: creates a centred crossfade where two audio clips meet and fades at the free edges
Original location: `packages/project/test/transition-audio.test.ts:189`.
1. Contract from the section source: creates a centred crossfade where two audio clips meet and fades at the free edges.
2. Detectable caller failure: Wrong edit-point handles, audible fade interval or gain curve; specifically the named case would return or store the wrong result.
3. Oracle: expect((r.results[0] as { transitionIds: string[] }).transitionIds).toHaveLength(3);; expect(two).toEqual([; expect(checkInvariants(h.doc)).toEqual([]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes audio transition commands/snapshot/audioFadeGain through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “creates a centred crossfade where two audio clips meet and fades at the free edges” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: skips an audio edit point without handles (no fall back to fades there)
Original location: `packages/project/test/transition-audio.test.ts:206`.
1. Contract from the section source: skips an audio edit point without handles (no fall back to fades there).
2. Detectable caller failure: Wrong edit-point handles, audible fade interval or gain curve; specifically the named case would return or store the wrong result.
3. Oracle: expect((r.results[0] as { transitionIds: string[] }).transitionIds).toHaveLength(2);; expect(transitions(h).map((t) => [t.outgoingClipId, t.incomingClipId])).toEqual([. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes audio transition commands/snapshot/audioFadeGain through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “skips an audio edit point without handles (no fall back to fades there)” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: includes a clip whose handle reaches into the range, and warns about crossfades without room
Original location: `packages/project/test/transition-audio.test.ts:218`.
1. Contract from the section source: includes a clip whose handle reaches into the range, and warns about crossfades without room.
2. Detectable caller failure: Wrong edit-point handles, audible fade interval or gain curve; specifically the named case would return or store the wrong result.
3. Oracle: expect(snapshotOf(h, { start: 105, end: 150 }).audioClips.map((c) => c.clipId)).toEqual([a, b]);; expect(snapshotOf(h, { start: 110, end: 150 }).audioClips.map((c) => c.clipId)).toEqual([b]);; expect(snapshotOf(h, { start: 50, end: 92 }).audioClips.map((c) => c.clipId)).toEqual([a, b]);; expect(snapshotOf(h, { start: 50, end: 90 }).audioClips.map((c) => c.clipId)).toEqual([a]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes audio transition commands/snapshot/audioFadeGain through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “includes a clip whose handle reaches into the range, and warns about crossfades without room” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: constant power: outgoing² + incoming² = 1 across the span
Original location: `packages/project/test/transition-audio.test.ts:267`.
1. Contract from the section source: constant power: outgoing² + incoming² = 1 across the span.
2. Detectable caller failure: Wrong edit-point handles, audible fade interval or gain curve; specifically the named case would return or store the wrong result.
3. Oracle: expect(p).toBeCloseTo(1, 12);; expect(audioFadeGain(out('equal-power'), 100)).toBeCloseTo(Math.SQRT1_2, 12);; expect(audioFadeGain(inc('equal-power'), 100)).toBeCloseTo(Math.SQRT1_2, 12);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes audio transition commands/snapshot/audioFadeGain through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “constant power: outgoing² + incoming² = 1 across the span” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: constant gain: outgoing + incoming = 1 across the span
Original location: `packages/project/test/transition-audio.test.ts:276`.
1. Contract from the section source: constant gain: outgoing + incoming = 1 across the span.
2. Detectable caller failure: Wrong edit-point handles, audible fade interval or gain curve; specifically the named case would return or store the wrong result.
3. Oracle: expect(s).toBeCloseTo(1, 12);; expect(audioFadeGain(out('linear'), 95)).toBeCloseTo(0.75, 12);; expect(audioFadeGain(inc('linear'), 95)).toBeCloseTo(0.25, 12);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes audio transition commands/snapshot/audioFadeGain through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “constant gain: outgoing + incoming = 1 across the span” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: is an audio transition whose fades are dB-linear over 60 dB, exact at the ends
Original location: `packages/project/test/transition-audio.test.ts:287`.
1. Contract from the section source: is an audio transition whose fades are dB-linear over 60 dB, exact at the ends.
2. Detectable caller failure: Wrong edit-point handles, audible fade interval or gain curve; specifically the named case would return or store the wrong result.
3. Oracle: expect(checkInvariants(h.doc)).toEqual([]);; expect(fades.map((f) => f.curve)).toEqual(['exponential', 'exponential']);; expect(audioFadeGain(out, 90)).toBe(1);; expect(audioFadeGain(out, 110)).toBe(0);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes audio transition commands/snapshot/audioFadeGain through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “is an audio transition whose fades are dB-linear over 60 dB, exact at the ends” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

## packages/project/test/transition-edge-wipe.test.ts

### DELETE: emits the distance body and border expression with border=%s
Original location: `packages/project/test/transition-edge-wipe.test.ts:9`.
Greps generated GLSL expressions and private variable spelling. Fails 4/5/6; compositions transition-premiere-gl and transition-gl compile/render wipes, including progress endpoints and borders.
Failure previously detected: emits the distance body and border expression with border=%s. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

## packages/project/test/transition-framework.test.ts

Independent sources: docs/wp-notes/fx-transition-framework.md shader authoring/progress/command protocol. Production seam: validator, progress and side transforms, transition transactions. Non-test callers: effect authoring, web/MCP and compositing pipeline. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in invalid shader accepted, wrong progress/placement or transition command data.

### DELETE: has the three family files and registers every entry after the built-ins
Original location: `packages/project/test/transition-framework.test.ts:65`.
Catalogue inventory/default mirrors or exact private pass/uniform arrangement. Fails 3/4/5/6; compiled GL side-placement/progress tests and retained transaction/refusal contracts own behavior.
Failure previously detected: has the three family files and registers every entry after the built-ins. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: every entry follows the family id prefix, bins and framework rules
Original location: `packages/project/test/transition-framework.test.ts:78`.
Catalogue inventory/default mirrors or exact private pass/uniform arrangement. Fails 3/4/5/6; compiled GL side-placement/progress tests and retained transaction/refusal contracts own behavior.
Failure previously detected: every entry follows the family id prefix, bins and framework rules. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: keeps the built-ins as they were (native, no params) and lists everything in the agent schema
Original location: `packages/project/test/transition-framework.test.ts:105`.
Catalogue inventory/default mirrors or exact private pass/uniform arrangement. Fails 3/4/5/6; compiled GL side-placement/progress tests and retained transaction/refusal contracts own behavior.
Failure previously detected: keeps the built-ins as they were (native, no params) and lists everything in the agent schema. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### KEEP: flags structural mistakes
Original location: `packages/project/test/transition-framework.test.ts:128`.
1. Contract from the section source: flags structural mistakes.
2. Detectable caller failure: Invalid shader accepted, wrong progress/placement or transition command data; specifically the named case would return or store the wrong result.
3. Oracle: expect(problems.join('\n')).toMatch(/gl_FragColor/);; expect(problems.join('\n')).toMatch(/output "from" is reserved/);; expect(problems.join('\n')).toMatch(/pass 1: no void main/);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes validator, progress and side transforms, transition transactions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “flags structural mistakes” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: matches the cross dissolve ramp two-sided and reaches 0 / 1 at a fade edge
Original location: `packages/project/test/transition-framework.test.ts:142`.
1. Contract from the section source: matches the cross dissolve ramp two-sided and reaches 0 / 1 at a fade edge.
2. Detectable caller failure: Invalid shader accepted, wrong progress/placement or transition command data; specifically the named case would return or store the wrong result.
3. Oracle: expect(transitionLinearProgress(0, 3, 'both')).toBeCloseTo(0.25);; expect(transitionLinearProgress(2, 3, 'both')).toBeCloseTo(0.75);; expect(transitionLinearProgress(0, 4, 'in')).toBe(0);; expect(transitionLinearProgress(3, 4, 'out')).toBe(1);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes validator, progress and side transforms, transition transactions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “matches the cross dissolve ramp two-sided and reaches 0 / 1 at a fade edge” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: applies Start / End and Reverse (sides swapped, 1 − p)
Original location: `packages/project/test/transition-framework.test.ts:149`.
1. Contract from the section source: applies Start / End and Reverse (sides swapped, 1 − p).
2. Detectable caller failure: Invalid shader accepted, wrong progress/placement or transition command data; specifically the named case would return or store the wrong result.
3. Oracle: expect(transitionProgress(gpu, { startPercent: 20, endPercent: 60 }, 0.5).progress).toBeCloseTo(0.4);; expect(r).toEqual({ progress: 0.75, swapped: true, reversed: true });; expect(transitionProgress({ reverse: 'custom' }, { reverse: true }, 0.25)).toEqual({. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes validator, progress and side transforms, transition transactions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “applies Start / End and Reverse (sides swapped, 1 − p)” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: maps sequence px to the side picture through the layer map and the padded canvas
Original location: `packages/project/test/transition-framework.test.ts:163`.
1. Contract from the section source: maps sequence px to the side picture through the layer map and the padded canvas.
2. Detectable caller failure: Invalid shader accepted, wrong progress/placement or transition command data; specifically the named case would return or store the wrong result.
3. Oracle: expect(at(100, 50)).toEqual([20, 20]); // the layer origin = canvas px (10 + 0) × 2; expect(at(150, 75)).toEqual([220, 120]); // layer px (100, 50); expect(. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes validator, progress and side transforms, transition transactions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “maps sequence px to the side picture through the layer map and the padded canvas” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### DELETE: plans placement passes + the transition passes with u_from / u_to declared
Original location: `packages/project/test/transition-framework.test.ts:177`.
Catalogue inventory/default mirrors or exact private pass/uniform arrangement. Fails 3/4/5/6; compiled GL side-placement/progress tests and retained transaction/refusal contracts own behavior.
Failure previously detected: plans placement passes + the transition passes with u_from / u_to declared. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### KEEP: two-sided: both clips get the handles of the span, no ramps; a stage on the track
Original location: `packages/project/test/transition-framework.test.ts:208`.
1. Contract from the section source: two-sided: both clips get the handles of the span, no ramps; a stage on the track.
2. Detectable caller failure: Invalid shader accepted, wrong progress/placement or transition command data; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.clips.get(a)).toEqual({ headHandle: 0, tailHandle: 10, fades: [] });; expect(r.clips.get(b)).toEqual({ headHandle: 10, tailHandle: 0, fades: [] });; expect(r.stages.get(trackId)).toMatchObject([; expect(r.stages.get(trackId)![0]!.params.direction).toEqual({ value: 'westToEast', keyframes: [] });. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes validator, progress and side transforms, transition transactions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “two-sided: both clips get the handles of the span, no ramps; a stage on the track” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: one-sided: a stage inside the clip, no handles
Original location: `packages/project/test/transition-framework.test.ts:231`.
1. Contract from the section source: one-sided: a stage inside the clip, no handles.
2. Detectable caller failure: Invalid shader accepted, wrong progress/placement or transition command data; specifically the named case would return or store the wrong result.
3. Oracle: expect(r.clips.get(b)).toBeUndefined();; expect([...r.stages.values()][0]).toMatchObject([. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes validator, progress and side transforms, transition transactions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “one-sided: a stage inside the clip, no handles” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: transition.add / update take validated params; unknown names fail with the list
Original location: `packages/project/test/transition-framework.test.ts:241`.
1. Contract from the section source: transition.add / update take validated params; unknown names fail with the list.
2. Detectable caller failure: Invalid shader accepted, wrong progress/placement or transition command data; specifically the named case would return or store the wrong result.
3. Oracle: expect(w.warnings).toEqual([]);; expect(t.params.borderWidth).toEqual({ value: 6, keyframes: [] });; expect(only(h).params.antiAliasing!.value).toBe('high');; expect(only(h).params.startPercent!.value).toBe(100);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes validator, progress and side transforms, transition transactions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “transition.add / update take validated params; unknown names fail with the list” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: param.set / keyframe.add on ["transition", id, name]: keys in flicks from the span start
Original location: `packages/project/test/transition-framework.test.ts:269`.
1. Contract from the section source: param.set / keyframe.add on ["transition", id, name]: keys in flicks from the span start.
2. Detectable caller failure: Invalid shader accepted, wrong progress/placement or transition command data; specifically the named case would return or store the wrong result.
3. Oracle: expect(only(h).params.borderWidth!.value).toBe(4);; expect(k.map((x) => x.time)).toEqual([0, 9 * F]);; expect(only(h).params.borderWidth!.keyframes).toHaveLength(1);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes validator, progress and side transforms, transition transactions through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “param.set / keyframe.add on ["transition", id, name]: keys in flicks from the span start” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

## packages/project/test/transition-sapphire-wipes.test.ts

### DELETE: has every Sapphire wipe once, alphabetically, as jasper.s.wipe-* in Sapphire Transitions ▸ Wipes
Original location: `packages/project/test/transition-sapphire-wipes.test.ts:67`.
Copies catalogue/control declarations or tests private margin/uniform wiring against the same helper. Fails 3/4/5/6; compositions transition-sapphire-wipes-gl renders all variants and border/glow/progress/Reverse behavior.
Failure previously detected: has every Sapphire wipe once, alphabetically, as jasper.s.wipe-* in Sapphire Transitions ▸ Wipes. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: carries Sapphire's border + glow block (in Sapphire's order and defaults) on the bordered wipes
Original location: `packages/project/test/transition-sapphire-wipes.test.ts:82`.
Copies catalogue/control declarations or tests private margin/uniform wiring against the same helper. Fails 3/4/5/6; compositions transition-sapphire-wipes-gl renders all variants and border/glow/progress/Reverse behavior.
Failure previously detected: carries Sapphire's border + glow block (in Sapphire's order and defaults) on the bordered wipes. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: exposes each wipe's shape controls with Sapphire's defaults
Original location: `packages/project/test/transition-sapphire-wipes.test.ts:100`.
Copies catalogue/control declarations or tests private margin/uniform wiring against the same helper. Fails 3/4/5/6; compositions transition-sapphire-wipes-gl renders all variants and border/glow/progress/Reverse behavior.
Failure previously detected: exposes each wipe's shape controls with Sapphire's defaults. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: keeps the numeric controls keyframable and the popups hold-only
Original location: `packages/project/test/transition-sapphire-wipes.test.ts:153`.
Copies catalogue/control declarations or tests private margin/uniform wiring against the same helper. Fails 3/4/5/6; compositions transition-sapphire-wipes-gl renders all variants and border/glow/progress/Reverse behavior.
Failure previously detected: keeps the numeric controls keyframable and the popups hold-only. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: covers the soft edge, the border band and the glow reach
Original location: `packages/project/test/transition-sapphire-wipes.test.ts:171`.
Copies catalogue/control declarations or tests private margin/uniform wiring against the same helper. Fails 3/4/5/6; compositions transition-sapphire-wipes-gl renders all variants and border/glow/progress/Reverse behavior.
Failure previously detected: covers the soft edge, the border band and the glow reach. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### DELETE: is passed to the shader per frame (keyframed params evaluated by the stage)
Original location: `packages/project/test/transition-sapphire-wipes.test.ts:181`.
Copies catalogue/control declarations or tests private margin/uniform wiring against the same helper. Fails 3/4/5/6; compositions transition-sapphire-wipes-gl renders all variants and border/glow/progress/Reverse behavior.
Failure previously detected: is passed to the shader per frame (keyframed params evaluated by the stage). No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

## packages/project/test/vector/ops.test.ts

Independent sources: docs/wp-notes/shapes.md vector operators; licenses/ported/shapes.md EffectCraft equations. Production seam: pure vector operator output geometry. Non-test callers: shape rendering/path evaluation in preview/export. Remaining stronger coverage: integration/GL/UI tests exercise wiring; these cases own the distinct stated document, numeric or protocol rule at its lowest stable boundary. No test-only seam is needed for KEEP. Risk: behavior regression in incorrect path length/area/orientation/position or boolean filled region.

### KEEP: trims half a square, with and without offset
Original location: `packages/project/test/vector/ops.test.ts:59`.
1. Contract from the section source: trims half a square, with and without offset.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: close(len(trim([sq(0, 0, 100)], 0, 50, 0)), 200, 0.5);; close(len(trim([sq(0, 0, 100)], 0, 50, 270)), 200, 0.5);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “trims half a square, with and without offset” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: keeps an empty slot
Original location: `packages/project/test/vector/ops.test.ts:63`.
1. Contract from the section source: keeps an empty slot.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: expect(t).toHaveLength(1);; expect(t[0]).toHaveLength(0);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “keeps an empty slot” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: is one piece across the start of a closed path
Original location: `packages/project/test/vector/ops.test.ts:68`.
1. Contract from the section source: is one piece across the start of a closed path.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: expect(trim([sq(0, 0, 100)], 0, 50, 270)[0]).toHaveLength(1);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “is one piece across the start of a closed path” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: simultaneously trims each path by its own length
Original location: `packages/project/test/vector/ops.test.ts:71`.
1. Contract from the section source: simultaneously trims each path by its own length.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: close(pathLength(t[0]!), 200, 0.5);; close(pathLength(t[1]!), 100, 0.5);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “simultaneously trims each path by its own length” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: individually trims sequentially
Original location: `packages/project/test/vector/ops.test.ts:76`.
1. Contract from the section source: individually trims sequentially.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: close(pathLength(t[0]!), 400, 0.5);; expect(pathLength(t[1]!)).toBeLessThan(1e-6);; close(pathLength(t[0]!), 200, 0.5);; close(pathLength(t[1]!), 200, 0.5);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “individually trims sequentially” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### REWRITE: reverse flips orientation
Original location: `packages/project/test/vector/ops.test.ts:87`.
Change: Remove vertex count; retain signed area inversion.
1. Contract from the section source: reverse flips orientation.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: Remove vertex count; retain signed area inversion.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “reverse flips orientation” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### REWRITE: rounds a square like the rectangle roundness
Original location: `packages/project/test/vector/ops.test.ts:96`.
Change: Keep analytic rounded-square area; remove vertex count and comparison against another production primitive.
1. Contract from the section source: rounds a square like the rectangle roundness.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: Keep analytic rounded-square area; remove vertex count and comparison against another production primitive.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “rounds a square like the rectangle roundness” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: clamps to half a segment
Original location: `packages/project/test/vector/ops.test.ts:102`.
1. Contract from the section source: clamps to half a segment.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: close(Math.abs(signedArea(roundCorners([sq(0, 0, 20)], 100)[0]!)), Math.PI * 100, 2);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “clamps to half a segment” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### REWRITE: keeps smooth vertices and open ends
Original location: `packages/project/test/vector/ops.test.ts:105`.
Change: Keep exact open endpoints after rounding; remove vertex representation counts.
1. Contract from the section source: keeps smooth vertices and open ends.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: Keep exact open endpoints after rounding; remove vertex representation counts.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “keeps smooth vertices and open ends” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### DELETE: triangle arcs are tangent and shrink the area moderately
Original location: `packages/project/test/vector/ops.test.ts:125`.
Weak area/count/identity proxy does not prove title, or duplicates stronger randomized geometric inclusion-exclusion. Fails 2/4/5/6; retained analytic shapes and tangent/random boolean laws own actual geometry.
Failure previously detected: triangle arcs are tangent and shrink the area moderately. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### KEEP: grows a square with a miter
Original location: `packages/project/test/vector/ops.test.ts:144`.
1. Contract from the section source: grows a square with a miter.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: close(area(o), 120 * 120, 1);; close(b.x0, -10, 1e-3);; close(b.x1, 110, 1e-3);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “grows a square with a miter” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: round and bevel joins
Original location: `packages/project/test/vector/ops.test.ts:151`.
1. Contract from the section source: round and bevel joins.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: close(area(offset([sq(0, 0, 100)], 10, 'round', 4, 1, 0)), 10000 + 4000 + Math.PI * 100, 2);; close(area(offset([sq(0, 0, 100)], 10, 'bevel', 4, 1, 0)), 10000 + 4000 + 200, 2);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “round and bevel joins” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: negative shrinks
Original location: `packages/project/test/vector/ops.test.ts:155`.
1. Contract from the section source: negative shrinks.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: close(area(offset([sq(0, 0, 100)], -10, 'miter', 4, 1, 0)), 6400, 1);; expect(area(offset([sq(0, 0, 100)], -60, 'miter', 4, 1, 0))).toBeLessThan(1e-6);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “negative shrinks” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### REWRITE: a circle stays a circle with few vertices
Original location: `packages/project/test/vector/ops.test.ts:159`.
Change: Keep analytic area for grown/shrunk circles; remove arbitrary vertex-count ceiling.
1. Contract from the section source: a circle stays a circle with few vertices.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: Keep analytic area for grown/shrunk circles; remove arbitrary vertex-count ceiling.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “a circle stays a circle with few vertices” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: is independent of orientation
Original location: `packages/project/test/vector/ops.test.ts:165`.
1. Contract from the section source: is independent of orientation.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: close(area(offset([s], 5, 'miter', 4, 1, 0)), area(offset(reverse([s]), 5, 'miter', 4, 1, 0)), 1e-3);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “is independent of orientation” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: copies
Original location: `packages/project/test/vector/ops.test.ts:169`.
1. Contract from the section source: copies.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: expect(o[0]).toHaveLength(3);; close(b.x1 - b.x0, 160, 1e-3);; close(b2.x1 - b2.x0, 140, 1e-3);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “copies” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: outlines an open path
Original location: `packages/project/test/vector/ops.test.ts:178`.
1. Contract from the section source: outlines an open path.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: close(area(offset([line(0, 0, 100, 0)], 5, 'miter', 4, 1, 0)), 1000, 1);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “outlines an open path” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### DELETE: shrinks a star without leftover islands
Original location: `packages/project/test/vector/ops.test.ts:181`.
Weak area/count/identity proxy does not prove title, or duplicates stronger randomized geometric inclusion-exclusion. Fails 2/4/5/6; retained analytic shapes and tangent/random boolean laws own actual geometry.
Failure previously detected: shrinks a star without leftover islands. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### KEEP: bloat moves vertices inwards and bulges
Original location: `packages/project/test/vector/ops.test.ts:200`.
1. Contract from the section source: bloat moves vertices inwards and bulges.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: close(Math.abs(p[0]), 25, 1e-9);; close(Math.abs(p[1]), 25, 1e-9);; expect(bb.x1 - bb.x0).toBeGreaterThan(51);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “bloat moves vertices inwards and bulges” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### REWRITE: pucker moves vertices outwards
Original location: `packages/project/test/vector/ops.test.ts:209`.
Change: Remove zero-amount object identity; retain independent vertex positions and area bound.
1. Contract from the section source: pucker moves vertices outwards.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: Remove zero-amount object identity; retain independent vertex positions and area bound.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “pucker moves vertices outwards” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### REWRITE: rotates by distance
Original location: `packages/project/test/vector/ops.test.ts:222`.
Change: Remove subdivision count; retain radius/angle law and fixed endpoints.
1. Contract from the section source: rotates by distance.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: Remove subdivision count; retain radius/angle law and fixed endpoints.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “rotates by distance” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### REWRITE: keeps a centred circle round
Original location: `packages/project/test/vector/ops.test.ts:235`.
Change: Remove zero-angle object identity; retain circular area preservation.
1. Contract from the section source: keeps a centred circle round.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: Remove zero-angle object identity; retain circular area preservation.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “keeps a centred circle round” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### REWRITE: vertex counts
Original location: `packages/project/test/vector/ops.test.ts:244`.
Change: Keep independent zigzag coordinates/amplitude and alternating side sign; remove internal vertex counts.
1. Contract from the section source: vertex counts.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: Keep independent zigzag coordinates/amplitude and alternating side sign; remove internal vertex counts.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “vertex counts” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### DELETE: smooth uses curves
Original location: `packages/project/test/vector/ops.test.ts:255`.
Weak area/count/identity proxy does not prove title, or duplicates stronger randomized geometric inclusion-exclusion. Fails 2/4/5/6; retained analytic shapes and tangent/random boolean laws own actual geometry.
Failure previously detected: smooth uses curves. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### REWRITE: is deterministic and time varying
Original location: `packages/project/test/vector/ops.test.ts:263`.
Change: Remove subdivision count; retain repeatability, seed/time changes and temporal phase equivalence.
1. Contract from the section source: is deterministic and time varying.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: Remove subdivision count; retain repeatability, seed/time changes and temporal phase equivalence.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “is deterministic and time varying” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: spatial phase shifts the pattern continuously
Original location: `packages/project/test/vector/ops.test.ts:278`.
1. Contract from the section source: spatial phase shifts the pattern continuously.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: close(b[i]![1], a[i + 1]![1], 1e-9);; expect(Math.abs(c[3]![1] - a[3]![1])).toBeLessThan(w.size);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “spatial phase shifts the pattern continuously” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: displacement is bounded
Original location: `packages/project/test/vector/ops.test.ts:288`.
1. Contract from the section source: displacement is bounded.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: expect(pts).toHaveLength(52);; expect(pts.every((p) => Math.abs(p[1]) <= 7 * 1.0001)).toBe(true);; expect(pts.some((p) => Math.abs(p[1]) > 0.1)).toBe(true);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “displacement is bounded” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: full correlation translates
Original location: `packages/project/test/vector/ops.test.ts:297`.
1. Contract from the section source: full correlation translates.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: close(area(wiggle(s, w, 0.4)), 10000, 1e-6);; expect(wiggle(s, { ...w, size: 0 }, 1)[0]).toBe(s[0]);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “full correlation translates” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: rect inclusion-exclusion
Original location: `packages/project/test/vector/ops.test.ts:319`.
1. Contract from the section source: rect inclusion-exclusion.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: close(area([merge([sq(0, 0, 100), sq(50, 30, 100)], 'intersect')]), 3500, 1e-6);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “rect inclusion-exclusion” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### DELETE: circle inclusion-exclusion, curves preserved
Original location: `packages/project/test/vector/ops.test.ts:323`.
Weak area/count/identity proxy does not prove title, or duplicates stronger randomized geometric inclusion-exclusion. Fails 2/4/5/6; retained analytic shapes and tangent/random boolean laws own actual geometry.
Failure previously detected: circle inclusion-exclusion, curves preserved. No unique behavior loses its owner for the reasons above. Validation: caller/import scan plus retained owner suite. Risk: low; incidental implementation changes cease to fail tests.

### KEEP: edge cases
Original location: `packages/project/test/vector/ops.test.ts:327`.
1. Contract from the section source: edge cases.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: expect(area([merge([a, b], 'intersect')])).toBeLessThan(1e-9);; close(area([merge([a, b], 'add')]), 200, 1e-6);; expect(merge([a, b], 'merge')).toHaveLength(2);; close(area([merge([sq(0, 0, 100), sq(0, 0, 50), sq(50, 50, 50)], 'subtract')]), 5000, 1e-6);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “edge cases” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: fill rules
Original location: `packages/project/test/vector/ops.test.ts:336`.
1. Contract from the section source: fill rules.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: close(filledArea(p, 'nonzero'), 15000, 1e-6);; close(filledArea(p, 'evenodd'), 10000, 1e-6);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “fill rules” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: a circle resting on a square edge
Original location: `packages/project/test/vector/ops.test.ts:361`.
1. Contract from the section source: a circle resting on a square edge.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: close(add, area([c]) + 100, 1e-6);; expect(area([merge([c, s], 'intersect')])).toBeLessThan(1e-6);; close(area([merge([c, s], 'subtract')]), area([c]), 1e-6);; close(area([merge([s, c], 'subtract')]), 100, 1e-6);. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “a circle resting on a square edge” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: circles tangent to squares on every side and to circles inside and out
Original location: `packages/project/test/vector/ops.test.ts:372`.
1. Contract from the section source: circles tangent to squares on every side and to circles inside and out.
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: Property assertions over fixed scenario or independently generated inputs in the named test.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “circles tangent to squares on every side and to circles inside and out” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: inclusion–exclusion holds for random rectangles and circles (curve booleans are robust)
Original location: `packages/project/test/vector/ops.test.ts:393`.
1. Contract from the section source: inclusion–exclusion holds for random rectangles and circles (curve booleans are robust).
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: Property assertions over fixed scenario or independently generated inputs in the named test.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “inclusion–exclusion holds for random rectangles and circles (curve booleans are robust)” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

### KEEP: inclusion–exclusion holds for circles touching squares (tangencies are the hard case)
Original location: `packages/project/test/vector/ops.test.ts:416`.
1. Contract from the section source: inclusion–exclusion holds for circles touching squares (tangencies are the hard case).
2. Detectable caller failure: Incorrect path length/area/orientation/position or boolean filled region; specifically the named case would return or store the wrong result.
3. Oracle: Property assertions over fixed scenario or independently generated inputs in the named test.. These fixed values, input-preservation laws or external reference results can disagree with the production result.
4. Observes pure vector operator output geometry through result data/errors, not collaborator calls.
5. The stated input/output rule remains valid if algorithms, helper names, storage indexes or render-pass implementation change.
6. Owns the distinct case “inclusion–exclusion holds for circles touching squares (tangencies are the hard case)” at that boundary. Remaining broader tests do not independently assert this exact condition; pure numeric or protocol tests are the owner, with integration covering wiring.

## Final analytic-oracle review (recorded before follow-up edits)

Reviewed retained cases against integration cf890a29. Seven cases above changed from KEEP to REWRITE after finding expected values supplied by the production conversion/default helpers. Sources are docs/wp-notes/color-grade.md §Lumetri Scopes and §scopes_read (BT.709 matrix, HLS hue/radius and −10%..110% unclamped range), licenses/ported/color-grade-filmcraft.md (256-bin scope protocol and independent port provenance), and docs/wp-notes/three-d.md §2 (50mm camera, 36mm sensor, eye and zoom formula). Calculations are analytical from those specifications, not captured production output.

Distinct failures: wrong luma/chroma coefficients, hue orientation, chroma envelope, unclamped negative sample placement, default lens/eye and specified focal-length conversion. Remaining stronger tests do not provide these independent numerical oracles; engine/UI tests consume these results. Stable seams remain histogram/vectorscope/waveform results and camera transaction/evaluated camera data. Refactoring helper names, conversion implementation or vector rasterization cannot change the required numerical result. Risks are incorrect analytical transcription; retain existing inputs/precision and check the integrated focused suites.

Integrated caller census: color/scopes.ts rowOf and vectorCell have no internal or non-test consumers, only the rewritten scopes test. Similarly named rowOf functions in timeline layout and Whisper are unrelated modules and remain. Remove these dead test-only production helpers. VECTOR_EXTENT, redAngle, rgbToYcbcr, defaultCamera and focalLengthForZoom have real production callers and remain. No public config, migration, persisted effect ID or security constant is removed. Caption rules are caller input and protocol bounds; they are not a test oracle inferred from implementation declarations.

Validation: changed-file Biome check passed; TypeScript syntax parse passed; git diff --check passed. Focused scopes/three-d-command tests remain under root scheduling; no heavy runtime ran in this follow-up worktree.

## Lumetri CPU-mirror removal (recorded before edits)

Integrated caller census found lumetriSpatialPixel used only by lumetri-grade.test.ts and the Lumetri GL harness. Its secondaryKey, secondaryCorrect, vignetteWeight, applyVignette and private band/hsl scratch state likewise have no production consumer; lumetriSpatialActive is entirely unused. The real shader consumes lumetriSpatialSettings, which remains. CPU spatial tests cannot catch an actual shader bug and kept this duplicate production-path-sized reference alive.

Compositions2 confirmed the complete seven-case contract mapping above before removing the CPU declarations. These seven original contracts are REWRITE across packages, including soft hue/luma masks, gray rejection, Invert/mask display modes, three-way highlights, positive/negative/roundness vignette and Set/Add/Remove eyedroppers. Their GPU tests use analytical/literal expected pixels; no expected result calls the deleted CPU mirror. Eyedropper functions become inputs to the real shader in that one owning scenario family, so both parameter generation and rendered membership are exercised once. Hostile values retain finite-value coverage of the two live owners, lumetriFn and lumetriSpatialSettings.

Production cleanup: delete the CPU-only renderer and its dead helpers; update source comments so the live module describes spatial uniform normalization. No live shader or settings algorithm changes. Risk is an omitted transferred scenario, bounded by the explicit sibling commitment and integrated GL verification. Changed-file Biome, TypeScript syntax parsing and git diff --check passed. Required runtime verification remains the Lumetri project suite and JASPER_REQUIRE_ORACLES=1 GPU suite; runtime is reserved for the integration owner.

## Completion and validation

Completed pruning: 55 DELETE, 36 REWRITE, 287 KEEP test declarations across all 34 assigned files. The parameterized border family counts once in the ledger. Five files deleted. Test code changes are net negative (final exact line totals are in the commit diff).

Removed support: catalogue/order/default arrays and their lookup helpers, private shader packing/padding fixture assertions, duplicate LUT fuzz seeds, cached-envelope scale fixture setup, unused imports and empty describe blocks. No snapshot/media fixture became uniquely orphaned.

Production cleanup (runtime algorithms unchanged): made levelDownscale, packFlare, wipeMargin, waveWarpPadding, lensFlarePadding, lightningPadding, encodeText, PSDG_TEXT_MAX and writeOnStroke private after checking all non-test callers. levelWeights remains exported because the production glows family imports it. Made isVerifiedDocument private and removed its barrel export; removed the invariantStats reset flag, retaining runtime diagnostic counters. The session owner confirmed removal of its only remaining private-cache/reset assertions; project1 confirmed removal of the writeOnStroke unit import. These dependent commits must be integrated before typechecking.

Actual validation: changed-file Biome check/format passed; TypeScript parse diagnostics reported no syntax errors; git diff --check passed. Focused Vitest, package typecheck, GL and full repository gates were not run in this worktree: the integration owner explicitly suspended new validation processes because the shared host was overloaded and is running the integrated checks. No claim of passing tests or typecheck is made here. No retained baseline failure was observed locally because tests were not run. Review covered all changed test assertions and production export-only/counter edits.

Integration documentation references sent to root: fx-shader-framework.md and sim-warp.md reference fx-catalogue.test.ts; code-audit-compositions.md and code-audit-project-registry.md reference transition-edge-wipe.test.ts; perf-core.md and ui-perf.md describe deleted cache/counter checks. Only this report was changed under docs by this owner.

Final report/provenance correction: the seven transferred original Lumetri contracts count as REWRITE across packages, with each row linking the destination shader justification. The EffectCraft HslKey port record names the surviving settings normalizer and GLSL key evaluator; the deleted CPU `secondaryKey` is no longer an attribution target. This correction changes no test or runtime code. `git diff --check` and the 55/36/287 disposition tally passed. Local `pnpm notices` failed because this isolated worktree has no installed web dependencies (`@codemirror/autocomplete` could not resolve); no generated output changed. The integration owner has been asked to run `pnpm notices` and `pnpm notices --check` after applying this port-record correction. No runtime tests or builds ran for this documentation-only follow-up.
