# Remote upload symlink regression and owner fix

Completed owner fix; the pre-edit evidence and disposition follow. Initial status: confirmed retained-contract failure; this is a product fix, not deletion or weakening of the failing test. Work starts from integrated commit `2664ee01` in isolated branch `cleanup/tests-engine1-ssh`.

## Evidence and contract

The integrated `processing-remote.test.ts` setup job `job_7a19cf25abada7b3` failed with `REMOTE_COMMAND_FAILED`: `mv` could not find `ffmpeg/libavcodec.so.part`. Evidence is preserved in `/var/lib/orquester/tmp/jasper-engine-C0Kj7Q/engine/jobs.jsonl` and its corresponding job log. The bundled `vendor/ffmpeg-lgpl/linux-x64/libavcodec.so` is a symbolic link to `libavcodec.so.61`.

`docs/specs/07-clip-processing.md` PRM-004 requires setup to upload the LGPL FFmpeg directory when absent remotely. PRM-005 requires file transfer to produce the source bytes before the final atomic rename; PRM-008 requires actual transfers through local SSH protocol shims. `processing/service.ts` selects uploads with `stat(path).isFile()`, which follows symbolic links, and also reads source sizes/content hashes by following those links. `SshRemote.upload` invokes rsync with `--partial --inplace`, which does not request source-link dereferencing. A skipped source link can leave no `.part` although rsync exits successfully. SCP's file-copy behavior already follows the selected source file.

Non-test callers: `ProcessingService.runRemote` uploads registered source media and installed models; `runSetup` uploads the runtime bundle, installed models and FFmpeg files. These callers require file bytes rather than copying a host-local link target pathname to the other machine. Remote path validation, user approval, SSH argument arrays and quoting remain unchanged. Dereferencing a caller-selected source file does not add recursive traversal: the upload remains one source argument and one engine-generated destination.

## Before-edit disposition

**KEEP — new regression `apps/engine/test/processing-remote-upload.test.ts` / `uploads a symlink source as file bytes without leaving a partial file`**

1. Independent requirement: PRM-004/005's usable FFmpeg installation and atomic file transfer, demonstrated by the saved missing-library artifact above.
2. Recognizable failure: installing a shared-library alias fails, or the remote file cannot supply its intended library/media bytes.
3. Independent oracle: create an actual local file with fixed bytes and a relative symbolic link; read the final destination bytes through Node's filesystem and check the partial file is gone. Expected bytes are authored input, not produced by upload code.
4. Stable seam: public `SshRemote.upload`, actual rsync client/server transfer and the existing SSH shim executing commands in a temporary remote directory. The shim only substitutes the transport endpoint; it does not implement source-link resolution.
5. Refactor tolerance: no assertions about rsync flags, subprocess count, private methods or command shape. Any implementation preserving byte transfer and atomic publication passes.
6. Lowest owner: source-link handling belongs to the transport upload operation. Existing full setup covers ordinary runtime files and only reaches library aliases when FFmpeg is absent; the resume test covers an ordinary file. Neither reliably forces this distinct alias path.

Ways this unit can fail: reject a valid source alias; leave a broken remote symlink rather than bytes; transfer wrong/truncated bytes; leave a `.part` after success. This single regression covers that actual failure mode without replaying inference or starting an engine. System rsync availability is an explicit prerequisite so SCP fallback cannot make the regression pass without exercising the failing transfer implementation.

Risk: limited change to rsync's interpretation of one source argument, matching the existing source-size/hash/SCP semantics. Dangling links still fail rather than publishing an artifact. No test-only production seam is added. The existing SSH shim is moved verbatim into shared test support to avoid a second fixture implementation; current setup/auto/cancel cases and their deadlines are unchanged.

Validation plan: run the isolated regression with `pnpm exec vitest run apps/engine/test/processing-remote-upload.test.ts --maxWorkers=1` before the owner fix and require the specific missing-part failure, then apply the minimal source-link dereference option and rerun the same test. Focused lint/static checks follow; no full remote-processing, rendering, browser or repository gate is started by this agent while the parent gate runs. Package typecheck/integrated gates remain root-scheduled.

## Baseline regression evidence

The focused command failed before the owner edit: **1/1 failed**, with `REMOTE_COMMAND_FAILED: rename upload failed (1): mv: cannot stat .../remote/ffmpeg/libavcodec.so.part: No such file or directory`. The stack reaches public `SshRemote.upload` and reproduces the saved setup artifact exactly. Duration: 52.77 s total (50.22 s module import on the shared host, 899 ms test bodies). This is not a timeout-based red result.

Applied the minimal owner change: rsync upload includes `--copy-links`, leaving resumable `.part`, final rename, SSH quoting and SCP fallback intact. The installed `rsync --help` confirms that this option transfers the referent of a symbolic link. Cross-review found no security or stable-seam issue in the regression/selected-file semantics. Green execution and static review follow.

## Completed validation and limits

After the owner fix, the same isolated command passed **1/1 tests**: 35.43 s total, 33.87 s import, 276 ms test bodies. The source alias exists as a real symlink; real rsync creates the destination file with the exact prescribed bytes and leaves no `.part`. No engine, renderer or network SSH host was started.

`pnpm exec biome check` passed the four changed TypeScript files; TypeScript syntax/transpile checks passed all four (not a semantic typecheck); `git diff --check` passed. A direct string comparison confirmed the shared SSH fixture was moved byte-for-byte unchanged. Cross-review cleared the minimal source diff and confirmed existing setup/auto/cancel scenario bodies and deadlines are untouched. Dependencies were installed with `pnpm install --frozen-lockfile --offline`; the expected unbuilt MCP-bin and ignored ONNX-install-script notices did not affect this transport-only regression.

Disposition delta: **one new KEEP regression**, justified above by a confirmed product failure, with no deleted original case and no test-only production seam added. This source fix resolves the demonstrated missing-library upload path; it does not claim that the separate probe, cancellation or projects setup failures pass. Full processing-remote setup, package semantic typecheck and repository gates remain parent-scheduled. No timeout was increased.
