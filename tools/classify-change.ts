/**
 * Decides how much human attention a change needs, using fixed rules on the diff,
 * not an agent's opinion. Agents may raise the class afterwards, never lower it.
 *
 *   A = crew merges, listed in the digest
 *   B = crew merges, highlighted in the digest; you can veto and it gets reverted
 *   C = crew opens a draft PR and escalates; waits for you
 *
 * CLI:  node tools/classify-change.ts [base-ref]   (default origin/main)
 */

export type ChangeClass = 'A' | 'B' | 'C';

export interface ChangeFacts {
  branch: string;
  files: { status: string; path: string }[];
  depsBase: Record<string, string>;
  depsHead: Record<string, string>;
  testCountBase: number;
  testCountHead: number;
  addedLines: { path: string; text: string }[];
}

/** Files the crew may not change without you: the rules it runs under. */
export const PROTECTED = [
  'CLAUDE.md', 'PLAN.md', 'docs/AUTONOMY.md', 'docs/QUALITY.md', 'docs/CREW.md',
  '.claude/', '.github/', 'tools/classify-change.ts', 'tests/classify-change.test.ts',
];

export const ALLOWED_HOSTS = [
  'overpass-api.de', 'overpass.kumi.systems', 'nominatim.openstreetmap.org', 's3.amazonaws.com',
  'openstreetmap.org', 'www.openstreetmap.org',
];

/** The classifier and its own tests contain example patterns on purpose; the lockfile lists registry URLs. */
const NOT_SCANNED = ['tools/classify-change.ts', 'tests/classify-change.test.ts', 'package-lock.json'];
const SHIPS_TO_PLAYER = (p: string) => p.startsWith('src/') || p === 'index.html';

const RANK: Record<ChangeClass, number> = { A: 0, B: 1, C: 2 };
const major = (v: string) => (v.replace(/^[^\d]*/, '').split('.')[0] ?? '');

export function classify(f: ChangeFacts): { cls: ChangeClass; reasons: string[] } {
  let cls: ChangeClass = 'A';
  const reasons: string[] = [];
  const raise = (to: ChangeClass, why: string) => {
    if (RANK[to] > RANK[cls]) cls = to;
    reasons.push(`${to}: ${why}`);
  };

  for (const { status, path } of f.files) {
    const hit = PROTECTED.find((p) => !p.includes(':') && (p.endsWith('/') ? path.startsWith(p) : path === p));
    if (hit) raise('C', `changes protected file ${path}`);
    if (status.startsWith('D') && path.startsWith('tests/')) raise('C', `deletes test file ${path}`);
    if (path.startsWith('maps/private/')) raise('C', `touches private map data ${path}`);
  }

  for (const name of new Set([...Object.keys(f.depsBase), ...Object.keys(f.depsHead)])) {
    const a = f.depsBase[name];
    const b = f.depsHead[name];
    if (a === undefined) raise('C', `adds dependency ${name}`);
    else if (b === undefined) raise('C', `removes dependency ${name}`);
    else if (a !== b) raise(major(a) === major(b) ? 'B' : 'C', `changes ${name} ${a} → ${b}`);
  }

  if (f.testCountHead < f.testCountBase) raise('C', `test count fell ${f.testCountBase} → ${f.testCountHead}`);

  for (const { path, text } of f.addedLines) {
    if (NOT_SCANNED.includes(path)) continue;
    if (path.startsWith('tests/') && /\b(it|test|describe)\.(skip|only|todo)\b/.test(text)) {
      raise('C', `skips or isolates a test in ${path}: ${text.trim().slice(0, 60)}`);
    }
    if (/(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}/i.test(text)) raise('C', `possible secret in ${path}`);
    if (!SHIPS_TO_PLAYER(path)) continue;
    if (/\bMath\.random\s*\(/.test(text)) raise('B', `adds Math.random() in ${path} (must not be in mission logic)`);
    for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
      const host = m[1].toLowerCase();
      if (!ALLOWED_HOSTS.some((h) => host === h || host.endsWith('.' + h)) && host !== 'localhost') {
        raise('C', `new external host ${host} in ${path}`);
      }
    }
  }

  const touchesSrc = f.files.some((x) => x.path.startsWith('src/'));
  if (touchesSrc && f.branch.startsWith('feat/')) raise('B', 'new feature behaviour');
  if (touchesSrc && !/^(feat|fix|refactor|perf|test|chore)\//.test(f.branch)) raise('B', `unrecognised branch name ${f.branch}`);
  if (reasons.length === 0) reasons.push('A: no rule triggered');
  return { cls, reasons };
}

// ---------- CLI: gather facts from git ----------
async function main() {
  const { execSync } = await import('node:child_process');
  const sh = (c: string) => execSync(c, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const base = process.argv[2] ?? 'origin/main';
  const mergeBase = sh(`git merge-base ${base} HEAD`).trim();
  const files = sh(`git diff --name-status ${mergeBase} HEAD`).trim().split('\n').filter(Boolean)
    .map((l) => { const [status, ...rest] = l.split('\t'); return { status, path: rest[rest.length - 1] }; });
  const deps = (ref: string) => {
    try {
      const p = JSON.parse(sh(`git show ${ref}:package.json`));
      return { ...p.dependencies, ...p.devDependencies } as Record<string, string>;
    } catch { return {}; }
  };
  const countTests = (ref: string) => {
    const list = sh(`git ls-tree -r --name-only ${ref} -- tests`).trim().split('\n').filter((p) => /\.test\.ts$/.test(p));
    return list.reduce((n, p) => n + (sh(`git show ${ref}:${p}`).match(/\b(it|test)\s*\(/g)?.length ?? 0), 0);
  };
  const addedLines: { path: string; text: string }[] = [];
  let current = '';
  for (const l of sh(`git diff -U0 ${mergeBase} HEAD`).split('\n')) {
    if (l.startsWith('+++ ')) current = l.replace(/^\+\+\+ (b\/)?/, '');
    else if (l.startsWith('+')) addedLines.push({ path: current, text: l.slice(1) });
  }
  const branch = sh('git rev-parse --abbrev-ref HEAD').trim();
  const result = classify({
    branch, files, depsBase: deps(mergeBase), depsHead: deps('HEAD'),
    testCountBase: countTests(mergeBase), testCountHead: countTests('HEAD'), addedLines,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
