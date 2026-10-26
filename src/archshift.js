import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { extractAll } from '@electron/asar';
import { packager } from '@electron/packager';

const NATIVE_EXTENSIONS = new Set(['.node', '.dylib', '.so', '.a']);
const MACHO_MARKERS = ['Mach-O', 'universal binary'];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

async function commandExists(command) {
  const result = await run('/usr/bin/which', [command]);
  return result.code === 0;
}

async function plistValue(plist, key, fallback = null) {
  const result = await run('/usr/bin/plutil', ['-extract', key, 'raw', plist]);
  return result.code === 0 && result.stdout ? result.stdout : fallback;
}

async function describeBinary(filePath) {
  const result = await run('/usr/bin/file', ['-b', filePath]);
  return result.code === 0 ? result.stdout : '';
}

export function classifyArchitecture(description) {
  const hasX64 = /\bx86_64\b/.test(description);
  const hasArm64 = /\barm64e?\b/.test(description);
  if (hasX64 && hasArm64) return 'universal';
  if (hasX64) return 'x86_64';
  if (hasArm64) return 'arm64';
  return 'unknown';
}

async function walk(root) {
  const files = [];
  const queue = [root];
  while (queue.length) {
    const current = queue.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  }
  return files;
}

async function scanNativeFiles(sourceDirectory) {
  const files = await walk(sourceDirectory);
  const candidates = [];
  for (const file of files) {
    const extension = path.extname(file).toLowerCase();
    const stat = await fsp.stat(file);
    if (NATIVE_EXTENSIONS.has(extension) || (stat.mode & 0o111) !== 0) candidates.push(file);
  }
  const results = [];
  for (const file of candidates) {
    const description = await describeBinary(file);
    const extension = path.extname(file).toLowerCase();
    if (!NATIVE_EXTENSIONS.has(extension) && !MACHO_MARKERS.some((marker) => description.includes(marker))) continue;
    results.push({
      path: path.relative(sourceDirectory, file),
      description,
      architecture: classifyArchitecture(description),
    });
  }
  return results;
}

async function scanBundleExecutables(appPath) {
  const roots = [path.join(appPath, 'Contents', 'MacOS'), path.join(appPath, 'Contents', 'Frameworks')];
  const results = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const file of await walk(root)) {
      const description = await describeBinary(file);
      if (!MACHO_MARKERS.some((marker) => description.includes(marker))) continue;
      results.push({
        path: path.relative(appPath, file),
        description,
        architecture: classifyArchitecture(description),
      });
    }
  }
  return results;
}

function normalizeElectronVersion(version) {
  return version?.replace(/^v/, '').trim() || null;
}

async function validateHost() {
  if (process.platform !== 'darwin') throw new Error('ArchShift currently runs only on macOS.');
  for (const command of ['file', 'plutil', 'codesign']) {
    if (!(await commandExists(command))) throw new Error(`Required macOS tool is missing: ${command}`);
  }
}

async function inspectBundle(inputPath, overrideVersion) {
  await validateHost();
  const appPath = path.resolve(inputPath);
  const stat = await fsp.stat(appPath).catch(() => null);
  if (!stat?.isDirectory() || path.extname(appPath).toLowerCase() !== '.app') {
    throw new Error(`Not an .app bundle: ${appPath}`);
  }
  const contents = path.join(appPath, 'Contents');
  const resources = path.join(contents, 'Resources');
  const plist = path.join(contents, 'Info.plist');
  const asarPath = path.join(resources, 'app.asar');
  const frameworkPlist = path.join(contents, 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources', 'Info.plist');
  for (const required of [plist, asarPath, frameworkPlist]) {
    if (!fs.existsSync(required)) throw new Error(`This does not look like a packaged Electron app; missing ${required}`);
  }
  const electronVersion = normalizeElectronVersion(overrideVersion || await plistValue(frameworkPlist, 'CFBundleVersion'));
  if (!electronVersion || !/^\d+\.\d+\.\d+/.test(electronVersion)) {
    throw new Error('Could not determine a valid Electron version; pass --electron <version>.');
  }
  const executableName = await plistValue(plist, 'CFBundleExecutable');
  const appName = await plistValue(plist, 'CFBundleDisplayName') || await plistValue(plist, 'CFBundleName') || path.basename(appPath, '.app');
  const executablePath = path.join(contents, 'MacOS', executableName || appName);
  if (!fs.existsSync(executablePath)) throw new Error('Could not locate the app executable.');
  return {
    appPath,
    asarPath,
    plist,
    resources,
    electronVersion,
    appName,
    executableName,
    executablePath,
    bundleId: await plistValue(plist, 'CFBundleIdentifier'),
    version: await plistValue(plist, 'CFBundleShortVersionString', '0.0.0'),
    buildVersion: await plistValue(plist, 'CFBundleVersion', '0.0.0'),
    iconPath: fs.existsSync(path.join(resources, 'icon.icns')) ? path.join(resources, 'icon.icns') : null,
  };
}

async function auditExtracted(bundle, sourceDirectory) {
  const packagePath = path.join(sourceDirectory, 'package.json');
  let packageJson = null;
  let packageError = null;
  try {
    packageJson = JSON.parse(await fsp.readFile(packagePath, 'utf8'));
  } catch (error) {
    packageError = error instanceof Error ? error.message : String(error);
  }
  const nativeFiles = await scanNativeFiles(sourceDirectory);
  const bundleBinaries = await scanBundleExecutables(bundle.appPath);
  const blockers = [];
  const warnings = [];
  if (packageError) blockers.push(`Invalid or missing package.json: ${packageError}`);
  if (packageJson && (!packageJson.main || !fs.existsSync(path.join(sourceDirectory, packageJson.main)))) {
    blockers.push(`The package.json main entry does not exist: ${packageJson?.main || '(missing)'}`);
  }
  for (const native of nativeFiles) {
    if (native.architecture === 'arm64') blockers.push(`ARM-only native dependency: ${native.path}`);
    else if (native.architecture === 'unknown') warnings.push(`Native-looking file has unknown architecture: ${native.path}`);
  }
  const standardFrameworkPrefixes = [
    'Contents/Frameworks/Electron Framework.framework/',
    'Contents/Frameworks/Mantle.framework/',
    'Contents/Frameworks/ReactiveObjC.framework/',
    'Contents/Frameworks/Squirrel.framework/',
    `Contents/Frameworks/${bundle.appName} Helper`,
  ];
  const extraArmBinaries = bundleBinaries.filter((item) => {
    if (item.architecture !== 'arm64') return false;
    if (item.path === `Contents/MacOS/${bundle.executableName}`) return false;
    return !standardFrameworkPrefixes.some((prefix) => item.path.startsWith(prefix));
  });
  for (const binary of extraArmBinaries) blockers.push(`ARM-only bundled helper: ${binary.path}`);
  if (nativeFiles.length === 0) warnings.push('No native Node modules were found in app.asar.');
  return { packageJson, nativeFiles, bundleBinaries, blockers, warnings };
}

async function withTemporaryExtraction(bundle, callback) {
  const tempDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'electron-arcshift-check-'));
  try {
    await extractAll(bundle.asarPath, tempDirectory);
    return await callback(tempDirectory);
  } finally {
    await fsp.rm(tempDirectory, { recursive: true, force: true });
  }
}

export async function checkApp(inputPath, options = {}) {
  const bundle = await inspectBundle(inputPath, options.electronVersion);
  const audit = await withTemporaryExtraction(bundle, (source) => auditExtracted(bundle, source));
  const inputDescription = await describeBinary(bundle.executablePath);
  return {
    command: 'check',
    input: bundle.appPath,
    appName: bundle.appName,
    appVersion: bundle.version,
    electronVersion: bundle.electronVersion,
    inputArchitecture: classifyArchitecture(inputDescription),
    nativeFiles: audit.nativeFiles,
    bundleBinaries: audit.bundleBinaries,
    blockers: audit.blockers,
    warnings: audit.warnings,
    eligible: audit.blockers.length === 0,
  };
}

async function verifyOutput(appPath, expectedMain) {
  if (!expectedMain) throw new Error('Cannot verify output without a package.json main entry.');
  const binaries = await scanBundleExecutables(appPath);
  const wrongArchitecture = binaries.filter((item) => !['x86_64', 'universal'].includes(item.architecture));
  const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar');
  const extracted = await fsp.mkdtemp(path.join(os.tmpdir(), 'electron-arcshift-verify-'));
  try {
    await extractAll(asarPath, extracted);
    const mainExists = fs.existsSync(path.join(extracted, expectedMain));
    if (!mainExists) throw new Error(`Packaged ASAR is missing its main entry: ${expectedMain}`);
  } finally {
    await fsp.rm(extracted, { recursive: true, force: true });
  }
  if (wrongArchitecture.length) {
    throw new Error(`Output contains non-Intel binaries:\n${wrongArchitecture.map((item) => `  ${item.path}: ${item.description}`).join('\n')}`);
  }
  return binaries;
}

async function smokeTest(appPath, seconds) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const executable = await plistValue(plist, 'CFBundleExecutable');
  const binary = path.join(appPath, 'Contents', 'MacOS', executable);
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' } });
    let stderr = '';
    let settled = false;
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve({ status: 'exited cleanly', code, signal, stderr: stderr.trim() });
      else reject(new Error(`Smoke test exited early (${code ?? signal}).\n${stderr.trim()}`));
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({ status: `stayed running for ${seconds}s`, code: null, signal: 'SIGTERM', stderr: stderr.trim() });
    }, seconds * 1000);
  });
}

export async function convertApp(inputPath, options = {}, progress = () => {}) {
  const bundle = await inspectBundle(inputPath, options.electronVersion);
  const outputRoot = path.resolve(options.out || 'electron-arcshift-output');
  const safeName = bundle.appName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'ElectronApp';
  const safeVersion = bundle.version.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jobDirectory = path.join(outputRoot, `${safeName}-${safeVersion}-intel-${stamp}`);
  const sourceDirectory = path.join(jobDirectory, 'source');
  const backupDirectory = path.join(jobDirectory, 'original');
  const packageDirectory = path.join(jobDirectory, 'package');
  await fsp.mkdir(sourceDirectory, { recursive: true });
  await fsp.mkdir(backupDirectory, { recursive: true });
  progress('Preserving the original app.asar');
  await fsp.copyFile(bundle.asarPath, path.join(backupDirectory, 'app.asar'));
  await fsp.copyFile(bundle.plist, path.join(backupDirectory, 'Info.plist'));
  progress('Extracting app.asar into a separate source directory');
  await extractAll(bundle.asarPath, sourceDirectory);
  progress('Scanning packaged code and native binaries');
  const audit = await auditExtracted(bundle, sourceDirectory);
  const report = {
    command: 'convert',
    input: bundle.appPath,
    appName: bundle.appName,
    appVersion: bundle.version,
    electronVersion: bundle.electronVersion,
    inputArchitecture: classifyArchitecture(await describeBinary(bundle.executablePath)),
    nativeFiles: audit.nativeFiles,
    bundleBinaries: audit.bundleBinaries,
    blockers: audit.blockers,
    warnings: audit.warnings,
    eligible: audit.blockers.length === 0,
  };
  await fsp.writeFile(path.join(jobDirectory, 'preflight.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (!report.eligible && !options.force) {
    throw new Error(`Preflight found blockers. No package was created. Review ${path.join(jobDirectory, 'preflight.json')} or rerun with --force.`);
  }
  const structuralBlockers = report.blockers.filter((blocker) => !blocker.startsWith('ARM-only'));
  if (structuralBlockers.length) {
    throw new Error(`Preflight found structural blockers that --force cannot bypass. Review ${path.join(jobDirectory, 'preflight.json')}.`);
  }
  progress(`Packaging with Electron ${bundle.electronVersion} for darwin-x64`);
  const packageJson = audit.packageJson || {};
  const packagerOptions = {
    dir: sourceDirectory,
    name: bundle.appName,
    platform: 'darwin',
    arch: 'x64',
    electronVersion: bundle.electronVersion,
    out: packageDirectory,
    overwrite: true,
    asar: true,
    quiet: true,
    appBundleId: bundle.bundleId || undefined,
    appVersion: bundle.version || packageJson.version,
    buildVersion: bundle.buildVersion || bundle.version,
    icon: bundle.iconPath || undefined,
  };
  const appPaths = await packager(packagerOptions);
  if (appPaths.length !== 1) throw new Error(`Expected one packaged app, received ${appPaths.length}.`);
  const packagedApps = (await fsp.readdir(appPaths[0], { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
  if (packagedApps.length !== 1) throw new Error(`Expected one .app in ${appPaths[0]}, received ${packagedApps.length}.`);
  const appPath = path.join(appPaths[0], packagedApps[0].name);
  progress('Applying an ad-hoc code signature');
  const sign = await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath]);
  if (sign.code !== 0) throw new Error(`Code signing failed: ${sign.stderr || sign.stdout}`);
  const signature = await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  if (signature.code !== 0) throw new Error(`Signature verification failed: ${signature.stderr || signature.stdout}`);
  progress('Verifying packaged ASAR and Intel binaries');
  const outputBinaries = await verifyOutput(appPath, packageJson.main);
  let smokeResult = null;
  if (options.smokeTest) {
    progress(`Running a ${options.smokeSeconds}-second launch smoke test`);
    smokeResult = await smokeTest(appPath, options.smokeSeconds);
  }
  const result = { report, appPath, jobDirectory, outputBinaries, smokeTest: smokeResult };
  await fsp.writeFile(path.join(jobDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export function formatReport(report) {
  const lines = [
    `App: ${report.appName} ${report.appVersion}`,
    `Input: ${report.input}`,
    `Input architecture: ${report.inputArchitecture}`,
    `Electron: ${report.electronVersion}`,
    `Native files in ASAR: ${report.nativeFiles.length}`,
    `Preflight: ${report.eligible ? 'ELIGIBLE' : 'BLOCKED'}`,
  ];
  if (report.blockers.length) {
    lines.push('', 'Blockers:');
    for (const blocker of report.blockers) lines.push(`  - ${blocker}`);
  }
  if (report.warnings.length) {
    lines.push('', 'Notes:');
    for (const warning of report.warnings) lines.push(`  - ${warning}`);
  }
  return lines.join('\n');
}
