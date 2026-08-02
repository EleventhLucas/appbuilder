# Third-Party Notices

AppBuilder packages third-party software. Copyright remains with each project's contributors.

## OpenAI Codex

Packaged Windows and Linux builds include an unmodified official OpenAI Codex release obtained through the platform package declared by `@openai/codex`. The prepared package records its version, upstream release URL, npm package URL, executable path, and SHA-256 in `resources/codex/manifest.json`.

- Project: https://github.com/openai/codex
- License: Apache License 2.0
- Copyright notice: Copyright 2025 OpenAI
- License text: https://github.com/openai/codex/blob/main/LICENSE

AppBuilder uses Codex's app-server as its integration surface. AppBuilder is an independent project and is not endorsed by OpenAI.

## Packaged JavaScript dependencies

Production dependencies and their transitive dependencies are declared and versioned in `package-lock.json`; their package metadata and license files are retained in the packaged application archive. Electron and Chromium license resources are included by Electron's distribution.

Release maintainers must review the dependency-license inventory before each stable release. The stable release is blocked until software-licensing review confirms that all required notices and source offers, if any, are present.
