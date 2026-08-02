# Agent Instructions

- Keep `README.md` and `CONTRIBUTING.md` intentionally slim. Do not expand them with process-heavy guidance unless the user explicitly asks.
- Finalize edited text files with CRLF line endings.
- Do not add telemetry, automatic diagnostic upload, secret logging, prompt/transcript logging, raw path logging, command-output logging, or surprise network calls.
- Do not introduce in-app AppBuilder update checking or installation. AppBuilder updates are handled outside the app by publishers or package managers.
- Managed Codex runtime updates remain disabled until a signed-manifest update design is implemented deliberately.
- Do not commit PII, personal identity details, corporate identity details, local machine paths, private email addresses, tokens, keys, certificates, credentials, private config, copied chat transcripts, or anything that only makes sense on one maintainer's machine.
- Treat privacy cleanup as a release blocker: if sensitive or personal material appears, remove it from the current tree and coordinate a history rewrite before publishing.
- Default to quick, targeted validation. Do not run history rewrites, reflog expiration, garbage collection, packaging, end-to-end suites, or full test suites unless the user explicitly asks or approves them for the current task. State the command's purpose and expected duration before starting a potentially long operation, use a bounded timeout where practical, and report progress at least once per 5 minutes.
