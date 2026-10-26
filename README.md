# Electron ArcShift

Electron ArcShift is a macOS command-line tool that audits packaged Electron apps and,
when their application code is portable, rebuilds them with an Intel (`x86_64`)
Electron runtime.

It is deliberately conservative. ARM-only native Node modules are blockers,
and suspicious embedded helpers are reported for review. The input app is never
modified.

## Requirements

- macOS
- Node.js 22.12 or newer
- Internet access when the matching Electron x64 runtime is not cached

## Install

```bash
npm install
npm link
```

## Read-only preflight

```bash
electron-arcshift check "/Applications/Example.app"
```

For machine-readable output:

```bash
electron-arcshift check "/Applications/Example.app" --json
```

## Convert

```bash
electron-arcshift convert "/Applications/Example.app" --out "$HOME/Desktop/electron-arcshift-builds"
```

Add `--smoke-test` to launch the result for eight seconds after verification:

```bash
electron-arcshift convert "/Applications/Example.app" --smoke-test
```

Each conversion gets a timestamped job directory containing:

- `original/app.asar` and `original/Info.plist` backups
- the extracted `source/`
- the rebuilt app under `package/`
- `preflight.json` and `result.json` reports

The package output is always outside the extracted source directory, avoiding
collisions with frontend folders such as `dist/`.

## What Electron ArcShift checks

- Recognizable Electron bundle structure and exact Electron version
- Valid `package.json` and existing main-process entry
- Native `.node`, `.dylib`, `.so`, and `.a` files inside the ASAR
- Architectures of Mach-O executables and frameworks in the input bundle
- `x86_64` architecture throughout the rebuilt bundle
- Presence of the main entry in the rebuilt ASAR
- Valid ad-hoc code signature

## Important limitations

Electron ArcShift cannot translate ARM machine code. Apps with ARM-only native modules,
embedded engines, DRM, integrity enforcement, custom launchers, or unavailable
Intel Electron releases may require source changes or may not be convertible.

The result is ad-hoc signed for local use; it is not Developer ID notarized.
Only convert software you are authorized to modify.

## Releasing

Releases use Conventional Commit messages and `standard-version` to update the
version, generate `CHANGELOG.md`, create the release commit, and create a `v*`
Git tag. Choose one command:

```bash
npm run release:patch
npm run release:minor
npm run release:major
```

Review the generated commit and tag, then push both:

```bash
git push --follow-tags origin main
```

Pushing the tag starts `.github/workflows/publish.yml`. The workflow verifies
the tag against `package.json`, installs from the lockfile, runs the tests,
checks the package contents, and publishes to npm through trusted publishing.
No npm access token is stored in GitHub.

### First publication

npm requires the package to exist before a trusted publisher can be attached.
Bootstrap version `0.1.0` once from an npm account protected by 2FA:

```bash
npm login
npm publish --access public
```

Then configure the package's npm trusted publisher with:

- Provider: GitHub Actions
- Organization or user: `Dihgg`
- Repository: `electron-archshift`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`

Within two days of configuring the trusted publisher, create and push the first
automated patch release. This publishes `0.1.1` and validates the OIDC trust
relationship:

```bash
npm run release:patch
git push --follow-tags origin main
```
