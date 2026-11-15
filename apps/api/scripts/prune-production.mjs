// Image build only (apps/api/Dockerfile, prod-deps stage): after `npm ci --omit=dev`, deletes installed
// packages that the API cannot reach at run time.
//
// Why: @prisma/client lists the Prisma command-line tool (and TypeScript) as *optional* peers, so npm
// keeps them, and with them Prisma Studio, its dev server and their dependencies (about 300 MB), even
// with --omit=dev. Starting from the API's and the shared package's dependencies, this follows the
// lockfile the way Node resolves packages (dependencies, optional dependencies and required peers, not
// optional peers) and removes every installed package it never reaches. Versions stay as locked.
//   node apps/api/scripts/prune-production.mjs [root=/app]
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '/app');
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages;
const starts = ['apps/api', 'packages/shared'];

/** Where Node would find `name` when required from the package at `from` (a lockfile path). */
function resolve(from, name) {
  let dir = from;
  for (;;) {
    const candidate = `${dir ? `${dir}/` : ''}node_modules/${name}`;
    if (lock[candidate]) return candidate;
    if (!dir) return null;
    const i = dir.lastIndexOf('/node_modules/');
    dir =
      i >= 0
        ? dir.slice(0, i)
        : dir.startsWith('node_modules/')
          ? ''
          : path.posix.dirname(dir) === '.'
            ? ''
            : path.posix.dirname(dir);
  }
}

const reached = new Set();
const queue = [...starts];
while (queue.length) {
  const at = queue.pop();
  if (reached.has(at)) continue;
  reached.add(at);
  const pkg = lock[at];
  if (!pkg) continue;
  if (pkg.link && pkg.resolved) queue.push(pkg.resolved); // a workspace link, e.g. @attendsure/shared
  const optionalPeers = pkg.peerDependenciesMeta ?? {};
  const names = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}).filter((n) => !optionalPeers[n]?.optional),
  ];
  for (const name of names) {
    const found = resolve(at, name);
    if (found) queue.push(found);
  }
}

let removed = 0;
const installed = Object.keys(lock)
  .filter((k) => k.includes('node_modules/'))
  .sort((a, b) => a.length - b.length);
for (const key of installed) {
  if (reached.has(key)) continue;
  const dir = path.join(root, key);
  if (!existsSync(dir)) continue; // not installed (dev, or another workspace's), or already removed with its parent
  rmSync(dir, { recursive: true, force: true });
  removed++;
}
console.warn(`prune-production: kept ${reached.size} packages, removed ${removed} the API never reaches.`);
