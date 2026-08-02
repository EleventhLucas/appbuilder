# Contributing to AppBuilder

Use common sense, be nice, and keep changes easy to understand.

## The Basics

- Be friendly.
- One clear change is easier to review than five tangled ones.
- Do not submit code, assets, or text you do not have the right to share.
- Do not add telemetry, surprise network calls, secrets, generated bundles, diagnostics, local config, or prepared Codex binaries to the repo.
- Match the style of nearby code. If something looks inconsistent, ask or keep it boring.

## License

AppBuilder is released under [The Unlicense](LICENSE). By contributing, you agree your contribution is provided under those same terms.

There is no CLA, copyright assignment, or DCO sign-off.

AI-assisted work is fine, but YOU are responsible for what YOU submit.

## Maybe do this Before Opening A Pull Request

Run the checks that make sense for what you touched. For normal code changes, run:

```text
npm run typecheck
npm test
```

Run `npm run test:e2e` for startup, Electron, preload, runtime, packaging, or end-to-end workflow changes.