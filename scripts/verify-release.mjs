import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const PACKAGES = [
  {
    directory: "packages/core",
    name: "@tk_wfl/o2n-core",
    artifact: "o2n-core.tgz",
    entries: ["dist/index.js", "dist/index.d.ts"],
  },
  {
    directory: "packages/cli",
    name: "@tk_wfl/o2n-cli",
    artifact: "o2n-cli.tgz",
    entries: ["dist/index.js"],
    dependsOnCore: true,
  },
  {
    directory: "packages/mcp-server",
    name: "@tk_wfl/o2n-mcp-server",
    artifact: "o2n-mcp-server.tgz",
    entries: ["dist/index.js"],
    dependsOnCore: true,
  },
];
const ALLOWED_FILE = /^(?:dist\/|package\.json$|readme(?:\..*)?$|license(?:\..*)?$)/i;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

function run(command, args) {
  return spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

function runNpm(args) {
  return run(NPM, args);
}

async function readManifest(directory) {
  const contents = await readFile(resolve(ROOT, directory, "package.json"), "utf8");
  return JSON.parse(contents);
}

function inspectPack(packageInfo, manifest, destination) {
  const args = ["pack", "--json", "--ignore-scripts", `--workspace=${packageInfo.directory}`];
  args.push(destination ? `--pack-destination=${destination}` : "--dry-run");
  const result = runNpm(args);
  if (result.status !== 0) {
    throw new Error(`npm pack failed for ${manifest.name}:\n${result.stderr}`);
  }

  const packs = JSON.parse(result.stdout);
  if (packs.length !== 1) throw new Error(`Expected one tarball for ${packageInfo.name}`);
  const pack = packs[0];
  if (pack.name !== packageInfo.name || pack.version !== manifest.version) {
    throw new Error(
      `${packageInfo.directory} tarball metadata is ${pack.name}@${pack.version}, expected ${packageInfo.name}@${manifest.version}`,
    );
  }
  const paths = new Set(pack.files.map(({ path }) => path));
  const unexpected = [...paths].filter((path) => !ALLOWED_FILE.test(path));
  const missing = packageInfo.entries.filter((path) => !paths.has(path));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `${manifest.name} pack mismatch; unexpected=[${unexpected}], missing=[${missing}]`,
    );
  }
  console.log(`${manifest.name}: ${paths.size} packed files verified`);
  return pack;
}

function assertSafeArchive(archivePath, expectedPaths) {
  const list = run("tar", ["-tzf", archivePath]);
  const verbose = run("tar", ["-tvzf", archivePath]);
  if (list.status !== 0 || verbose.status !== 0) {
    throw new Error(`Could not inspect archive ${basename(archivePath)}`);
  }

  const entries = list.stdout.trim().split("\n");
  const unsafe = entries.filter((entry) => {
    const parts = entry.split("/");
    return (
      !entry.startsWith("package/") ||
      entry.includes("\\") ||
      /[\0-\x1f]/.test(entry) ||
      parts.some((part, index) => index > 0 && (part === "." || part === ".."))
    );
  });
  const unsafeTypes = verbose.stdout
    .trim()
    .split("\n")
    .filter((entry) => entry[0] !== "-");
  const archivePaths = entries.map((entry) => entry.slice("package/".length)).sort();
  const expected = [...expectedPaths].sort();
  if (
    unsafe.length > 0 ||
    unsafeTypes.length > 0 ||
    JSON.stringify(archivePaths) !== JSON.stringify(expected)
  ) {
    throw new Error(`${basename(archivePath)} contains unsafe or unexpected archive entries`);
  }
}

async function prepareArtifact(packageInfo, manifest, destination) {
  const pack = inspectPack(packageInfo, manifest, destination);
  if (basename(pack.filename) !== pack.filename) {
    throw new Error(`npm returned an unsafe tarball filename: ${pack.filename}`);
  }

  const generatedPath = resolve(destination, pack.filename);
  const artifactPath = resolve(destination, packageInfo.artifact);
  assertSafeArchive(generatedPath, pack.files.map(({ path }) => path));
  await rename(generatedPath, artifactPath);
  const digest = createHash("sha256").update(await readFile(artifactPath)).digest("hex");
  return `${digest}  ${packageInfo.artifact}`;
}

async function prepareOutput(argument) {
  if (!argument) return undefined;
  const destination = resolve(ROOT, argument);
  if (destination === ROOT || !destination.startsWith(`${ROOT}${sep}`)) {
    throw new Error("Pack output must be a directory inside the repository");
  }
  await rm(destination, { force: true, recursive: true });
  await mkdir(destination, { recursive: true });
  return destination;
}

async function assertArtifactSet(destination) {
  const expected = new Set([...PACKAGES.map(({ artifact }) => artifact), "SHA256SUMS"]);
  const entries = await readdir(destination);
  if (entries.length !== expected.size || entries.some((entry) => !expected.has(entry))) {
    throw new Error(`Unexpected release artifact set: ${entries}`);
  }
  for (const entry of entries) {
    const stats = await lstat(resolve(destination, entry));
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Release artifact must be a regular file: ${entry}`);
    }
  }
}

function assertNotPublished(name, version) {
  const result = runNpm(["view", `${name}@${version}`, "version", "--json"]);
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0) {
    throw new Error(`${name}@${version} already exists on npm`);
  }
  if (!output.includes("E404")) {
    throw new Error(`Could not safely check ${name}@${version}:\n${output}`);
  }
}

const expectedVersion = process.argv[2];
const checkRegistry = process.argv.includes("--check-registry");
const packDirectoryArgument = process.argv
  .find((argument) => argument.startsWith("--pack-dir="))
  ?.slice("--pack-dir=".length);
if (!SEMVER.test(expectedVersion ?? "")) {
  throw new Error("Pass the exact release version (for example, 1.2.3)");
}

const packDirectory = await prepareOutput(packDirectoryArgument);
const checksums = [];
for (const packageInfo of PACKAGES) {
  const manifest = await readManifest(packageInfo.directory);
  if (manifest.name !== packageInfo.name) {
    throw new Error(`${packageInfo.directory} must be named ${packageInfo.name}`);
  }
  if (manifest.version !== expectedVersion) {
    throw new Error(`${packageInfo.name} version is ${manifest.version}, expected ${expectedVersion}`);
  }
  if (
    packageInfo.dependsOnCore &&
    manifest.dependencies?.["@tk_wfl/o2n-core"] !== `^${expectedVersion}`
  ) {
    throw new Error(`${packageInfo.name} must depend on @tk_wfl/o2n-core@^${expectedVersion}`);
  }
  if (packDirectory) {
    checksums.push(await prepareArtifact(packageInfo, manifest, packDirectory));
  } else {
    inspectPack(packageInfo, manifest);
  }
  if (checkRegistry) assertNotPublished(packageInfo.name, expectedVersion);
}

if (packDirectory) {
  await writeFile(resolve(packDirectory, "SHA256SUMS"), `${checksums.join("\n")}\n`);
  await assertArtifactSet(packDirectory);
}
