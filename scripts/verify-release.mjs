import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const PACKAGES = [
  { directory: "packages/core", entries: ["dist/index.js", "dist/index.d.ts"] },
  { directory: "packages/cli", entries: ["dist/index.js"], dependsOnCore: true },
  { directory: "packages/mcp-server", entries: ["dist/index.js"], dependsOnCore: true },
];
const ALLOWED_FILE = /^(?:dist\/|package\.json$|readme(?:\..*)?$|license(?:\..*)?$)/i;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

function runNpm(args) {
  return spawnSync(NPM, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

async function readManifest(directory) {
  const contents = await readFile(resolve(ROOT, directory, "package.json"), "utf8");
  return JSON.parse(contents);
}

function inspectPack(packageInfo, manifest) {
  const result = runNpm([
    "pack",
    "--dry-run",
    "--json",
    "--ignore-scripts",
    `--workspace=${packageInfo.directory}`,
  ]);
  if (result.status !== 0) {
    throw new Error(`npm pack failed for ${manifest.name}:\n${result.stderr}`);
  }

  const pack = JSON.parse(result.stdout)[0];
  const paths = new Set(pack.files.map(({ path }) => path));
  const unexpected = [...paths].filter((path) => !ALLOWED_FILE.test(path));
  const missing = packageInfo.entries.filter((path) => !paths.has(path));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `${manifest.name} pack mismatch; unexpected=[${unexpected}], missing=[${missing}]`,
    );
  }
  console.log(`${manifest.name}: ${paths.size} packed files verified`);
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
if (!SEMVER.test(expectedVersion ?? "")) {
  throw new Error("Pass the exact release version (for example, 1.2.3)");
}

for (const packageInfo of PACKAGES) {
  const manifest = await readManifest(packageInfo.directory);
  if (manifest.version !== expectedVersion) {
    throw new Error(`${manifest.name} version is ${manifest.version}, expected ${expectedVersion}`);
  }
  if (
    packageInfo.dependsOnCore &&
    manifest.dependencies?.["@tk_wfl/o2n-core"] !== `^${expectedVersion}`
  ) {
    throw new Error(`${manifest.name} must depend on @tk_wfl/o2n-core@^${expectedVersion}`);
  }
  inspectPack(packageInfo, manifest);
  if (checkRegistry) assertNotPublished(manifest.name, expectedVersion);
}
