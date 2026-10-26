# Electron ArcShift

Electron ArcShift is a macOS command-line tool that checks whether a packaged
Apple Silicon Electron app can be rebuilt for Intel Macs and, when eligible,
repackages it with an `x86_64` Electron runtime.

It never modifies the input `.app` bundle. Every conversion preserves the
original ASAR and performs its work in separate source and output directories.

## Quick start with npx

Run a read-only compatibility check:

```bash
npx --yes electron-arcshift check "/Applications/Example.app"
```

If the app is eligible, convert it:

```bash
npx --yes electron-arcshift convert "/Applications/Example.app" \
  --out "$HOME/Desktop/electron-arcshift-builds"
```

The first run may download Electron's matching Intel runtime. Later runs can
reuse the cached runtime.

## Requirements

- macOS
- Node.js 22.12 or newer
- Internet access when the matching Electron Intel runtime is not cached
- An Electron app that you are authorized to inspect and modify

## Commands

### Check an app

`check` extracts the app into a temporary directory, audits its package layout
and native components, prints a report, and removes the temporary extraction.
It does not create a converted app.

```bash
npx --yes electron-arcshift check "/Applications/Example.app"
```

Use JSON output for scripts or automation:

```bash
npx --yes electron-arcshift check "/Applications/Example.app" --json
```

The command exits with status `3` when the app has compatibility blockers.

### Convert an app

```bash
npx --yes electron-arcshift convert "/Applications/Example.app" \
  --out "$HOME/Desktop/electron-arcshift-builds"
```

Conversion performs the preflight checks and then:

1. Preserves the original `app.asar` and `Info.plist`.
2. Extracts the ASAR into a separate source directory.
3. Downloads or reuses the matching Electron Intel runtime.
4. Packages the app for `darwin-x64` outside the source tree.
5. Rebuilds and verifies `app.asar`.
6. Verifies the architecture of the output binaries.
7. Applies and verifies an ad-hoc code signature.

Add a brief launch test after conversion:

```bash
npx --yes electron-arcshift convert "/Applications/Example.app" \
  --out "$HOME/Desktop/electron-arcshift-builds" \
  --smoke-test
```

The default smoke test observes the app for eight seconds and terminates it if
it is still running. Change the duration with `--smoke-seconds`.

## Options

| Option | Purpose |
| --- | --- |
| `-o, --out <directory>` | Select the output root. Defaults to `./electron-arcshift-output`. |
| `--electron <version>` | Override the Electron version detected in the input bundle. |
| `--smoke-test` | Launch the converted app briefly after verification. |
| `--smoke-seconds <n>` | Set the smoke-test duration from 1 to 120 seconds. Defaults to 8. |
| `--json` | Print a machine-readable report. |
| `--force` | Continue past ARM-only native-binary blockers. Use with care. |
| `-h, --help` | Show CLI help. |

## Output layout

Each conversion creates a timestamped job directory:

```text
Example-1.2.3-intel-2026-10-26T12-00-00-000Z/
├── original/
│   ├── app.asar
│   └── Info.plist
├── source/
├── package/
│   └── Example-darwin-x64/
│       └── Example.app
├── preflight.json
└── result.json
```

The package output is deliberately kept outside the extracted source tree so
it cannot collide with application folders such as `dist/`.

## What gets checked

- Recognizable Electron bundle structure
- Exact Electron runtime version
- Valid `package.json` and existing main-process entry
- Native `.node`, `.dylib`, `.so`, and `.a` files inside the ASAR
- Executable files without extensions inside the ASAR
- Architectures of Mach-O executables and frameworks
- Presence of the main entry in the rebuilt ASAR
- `x86_64` or universal architecture throughout the rebuilt bundle
- Valid ad-hoc code signature

## When conversion will not work

Electron ArcShift replaces the Electron runtime; it does not translate ARM
machine code. Conversion may be blocked or produce an unusable app when the
input contains:

- ARM-only native Node modules or helper executables
- Architecture-specific game engines, codecs, drivers, or dynamic libraries
- DRM, licensing, tamper detection, or custom integrity enforcement
- A custom launcher or resources stored outside the normal Electron package
- An Electron release for which no Intel macOS runtime is available
- Application logic that explicitly requires Apple Silicon

`--force` only bypasses the preflight decision. It cannot make incompatible
machine code run on Intel hardware.

## Gatekeeper and signing

Converted apps receive an ad-hoc signature for local use. They are not signed
with the original developer's certificate and are not Developer ID notarized.
After transferring the app to another Mac, macOS may require you to
Control-click the app, choose **Open**, and confirm the first launch.

## Optional global installation

If you prefer a persistent command instead of `npx`:

```bash
npm install --global electron-arcshift
electron-arcshift --help
```

To upgrade later:

```bash
npm install --global electron-arcshift@latest
```

## License

MIT
