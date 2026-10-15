// Make sure the native build packages for this platform are installed.
//
// npm treats them as optional dependencies and silently skips one whose
// download fails, which leaves `next build` without Turbopack's native
// bindings. Install any that are missing at the version in package-lock.json,
// and fail loudly if that does not work either. Run after `npm ci` (Docker).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");

if (process.platform !== "linux") process.exit(0);

const arch = process.arch; // x64 | arm64
let libc = "gnu";
try {
  if (!process.report.getReport().header.glibcVersionRuntime) libc = "musl";
} catch {}

const wanted = [
  `@next/swc-linux-${arch}-${libc}`,
  `@tailwindcss/oxide-linux-${arch}-${libc}`,
  `lightningcss-linux-${arch}-${libc}`,
];
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const installed = (name) => fs.existsSync(path.join(root, "node_modules", name, "package.json"));

const missing = wanted.filter((name) => lock.packages[`node_modules/${name}`] && !installed(name));
if (missing.length === 0) process.exit(0);

const specs = missing.map((name) => `${name}@${lock.packages[`node_modules/${name}`].version}`);
console.warn(`ensure-native: npm skipped ${specs.join(", ")}; installing`);
execFileSync("npm", ["install", "--no-save", "--no-audit", "--no-fund", "--fetch-retries=5", ...specs], {
  stdio: "inherit",
  cwd: root,
});
const still = missing.filter((name) => !installed(name));
if (still.length) {
  console.error(`ensure-native: still missing ${still.join(", ")}`);
  process.exit(1);
}
