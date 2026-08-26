import { execFile as execFileCb } from "node:child_process";
import { dirname, resolve } from "node:path";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

const execFile = promisify(execFileCb);

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const pkg = JSON.parse(
  await readFile(resolve(projectRoot, "package.json"), "utf-8")
);
const { rpm: rpmOptions } = await import(
  new URL("../packaging/options.ts", import.meta.url).href
);

const electronVersion: string = pkg.devDependencies.electron;
const outDir = resolve(projectRoot, "out/make/srpm");

// --- Step 1: Create a minimal fake app dir for electron-installer-redhat ---
// It needs: version file, resources/app/package.json, and a fake binary
const fakeAppDir = await mkdtemp(resolve(tmpdir(), "fake-electron-app-"));
await writeFile(resolve(fakeAppDir, "version"), electronVersion);
await mkdir(resolve(fakeAppDir, "resources/app"), { recursive: true });
await writeFile(
  resolve(fakeAppDir, "resources/app/package.json"),
  JSON.stringify({
    name: rpmOptions.name,
    version: pkg.version,
    description: rpmOptions.description,
    license: rpmOptions.license,
    homepage: rpmOptions.homepage,
    productName: rpmOptions.productName,
  })
);
// Fake binary so createBinarySymlink doesn't throw
await writeFile(resolve(fakeAppDir, rpmOptions.name), "");
// Copy LICENSE so createCopyright can find it
await cp(resolve(projectRoot, "LICENSE"), resolve(fakeAppDir, "LICENSE"));

// --- Step 2: Run electron-installer-redhat to generate scaffolding ---
// eslint-disable-next-line import/no-unresolved
const { Installer } = await import("electron-installer-redhat");

const installer = new Installer({
  ...rpmOptions,
  // Resolve icon path relative to project root
  icon: resolve(projectRoot, rpmOptions.icon),
  src: fakeAppDir,
  dest: outDir,
  arch: "noarch", // SRPM is arch-independent
  logger: () => {},
});

await installer.generateDefaults();
await installer.generateOptions();
await installer.generateScripts();
await installer.createStagingDir();

// Run content functions except copyApplication — we don't have a real app
for (const fn of installer.contentFunctions) {
  if (fn === "copyApplication") continue;
  await (installer[fn] as () => Promise<void>)();
}

// Copy staging dir to outDir
await mkdir(outDir, { recursive: true });
await cp(installer.stagingDir, outDir, { recursive: true });

// Fix the binary symlink — fs.cp resolves relative symlinks to absolute paths
// based on the source, so we must recreate it after copying.
const installerName = (installer.options as { name: string }).name;
const installerBin = (installer.options as { bin: string }).bin;
const symlinkPath = resolve(outDir, "BUILD/usr/bin", installerName);
await unlink(symlinkPath);
await symlink(`../lib/${installerName}/${installerBin}`, symlinkPath);

// --- Step 3: Remove the fake app dir from BUILD (nothing to ship) ---
await rm(resolve(outDir, "BUILD/usr/lib", rpmOptions.name), {
  recursive: true,
  force: true,
});

// --- Step 4: Create source tarball of the project ---
const { name, version } = installer.options as {
  name: string;
  version: string;
};
const sourcesDir = resolve(outDir, "SOURCES");
const srpmsDir = resolve(outDir, "SRPMS");
const projectTarball = `${name}-${version}.tar.gz`;
const scaffoldTarball = `${name}-${version}-rpm-scaffolding.tar.gz`;

await mkdir(sourcesDir, { recursive: true });
await mkdir(srpmsDir, { recursive: true });

// Project source (excluding build artifacts, data, node_modules, out)
await execFile(
  "tar",
  [
    "czf",
    resolve(sourcesDir, projectTarball),
    "--transform",
    `s,^\\.,${name}-${version},`,
    "--exclude=./node_modules",
    "--exclude=./out",
    "--exclude=./target",
    "--exclude=./data",
    "--exclude=./.git",
    "-C",
    projectRoot,
    ".",
  ],
  { maxBuffer: 10 * 1024 * 1024 }
);

// Scaffolding tarball (desktop file, icon, symlink, docs — everything except the app)
await execFile("tar", [
  "czf",
  resolve(sourcesDir, scaffoldTarball),
  "-C",
  resolve(outDir, "BUILD"),
  ".",
]);

// --- Step 5: Patch the spec ---
const specPath = resolve(outDir, "SPECS", `${name}.spec`);
let spec = await readFile(specPath, "utf-8");

// Disable debuginfo — Electron ships pre-built binaries (e.g. libvulkan.so.1)
// with split DWARF that find-debuginfo cannot process.
spec = `%global debug_package %{nil}\n` + spec;

// Add Source0, Source1, and BuildRequires
spec = spec.replace(
  /^(URL:.*)$/m,
  `$1\nSource0: ${projectTarball}\nSource1: ${scaffoldTarball}\nBuildRequires: gcc, gcc-c++, make, git, curl, clang-devel`
);

// Rewrite %install to combine scaffolding + freshly-built app
spec = spec.replace(
  /(%install\n)[\s\S]*?(\n%)/,
  [
    "$1",
    "# Install scaffolding (desktop file, icon, symlink, docs)",
    "mkdir -p %{buildroot}",
    "tar xf %{SOURCE1} -C %{buildroot}",
    "",
    "# Install the freshly-built Electron app",
    `mkdir -p %{buildroot}/usr/lib/%{name}`,
    `cp -r %{_builddir}/%{name}-%{version}/out/%{name}-linux-*/. %{buildroot}/usr/lib/%{name}/`,
    "$2",
  ].join("\n")
);

// Add %prep and %build sections before %install
const buildSection = [
  "%prep",
  "%setup -q",
  "",
  "%build",
  "# Use a writable HOME for toolchain installs",
  'export HOME="$(mktemp -d)"',
  "",
  "# Install Rust toolchain for native modules",
  "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y",
  '. "$HOME/.cargo/env"',
  "rustup target add wasm32-unknown-unknown",
  `version=$(awk '/^wasm-bindgen =/ { gsub(/"/, "", $3); print $3; exit }' Cargo.toml)`,
  `cargo install "wasm-bindgen-cli@$version"`,
  "# Install nvm and Node.js",
  "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash",
  '. "$HOME/.nvm/nvm.sh"',
  "nvm install 24",
  "corepack enable pnpm",
  "corepack install",
  "",
  "# Install dependencies and build native modules",
  "pnpm install --frozen-lockfile",
  "# Copr adds some flag that is not suppored by WASM rust-lld",
  `ORIGINAL_RUSTFLAGS="$RUSTFLAGS"`,
  `export RUSTFLAGS="\${RUSTFLAGS//-Clink-arg=-specs=\\/usr\\/lib\\/rpm\\/redhat\\/redhat-package-notes/}"`,
  "pnpm run build:modules",
  `export RUSTFLAGS="$ORIGINAL_RUSTFLAGS"`,
  "",
  "# Package the Electron app (no make, just package)",
  "pnpm run package",
  "",
].join("\n");

spec = spec.replace(/^%install/m, `${buildSection}\n%install`);

await writeFile(specPath, spec);

// --- Step 6: Build the SRPM ---
await execFile("rpmbuild", ["--define", `_topdir ${outDir}`, "-bs", specPath]);

// --- Step 7: Clean up ---
const srpms = await readdir(srpmsDir);

// Move SRPMs up
await Promise.all(
  srpms.map((f) => cp(resolve(srpmsDir, f), resolve(outDir, f)))
);

// Remove everything except SRPMs
const entries = await readdir(outDir);
await Promise.all(
  entries
    .filter((e) => !srpms.includes(e))
    .map((e) => rm(resolve(outDir, e), { recursive: true, force: true }))
);

// Clean up fake app dir
await rm(fakeAppDir, { recursive: true, force: true });

console.log("SRPM(s) created:");
for (const f of srpms) {
  console.log(`  ${resolve(outDir, f)}`);
}
