/**
 * Decides how much human attention a change needs, using fixed rules on the diff,
 * not an agent's opinion. Agents may raise the class afterwards, never lower it.
 *
 *   A = crew merges, listed in the digest
 *   B = crew merges, highlighted in the digest; you can veto and it gets reverted
 *   C = crew opens a draft PR and escalates; waits for you
 *
 * CLI:  npm run -s classify -- [--base <ref> | --base=<ref> | <ref>] [--head <ref>]
 *       base defaults to origin/main, head to HEAD.
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
export interface CliArgs { base: string; head: string }

/** Pure parser for the CLI arguments (argv without node and script). Throws Error with a clear message. */
export function parseArgs(argv: string[]): CliArgs {
  let base: string | undefined;
  let head: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--(base|head)(?:=(.*))?$/.exec(a);
    if (m) {
      let val = m[2];
      if (val === undefined) {
        val = argv[++i];
        if (val === undefined || val.startsWith('-')) throw new Error(`--${m[1]} needs a ref, e.g. --${m[1]} origin/main`);
      }
      if (val === '') throw new Error(`--${m[1]} needs a non-empty ref`);
      if (m[1] === 'base') base = val; else head = val;
    } else if (a.startsWith('-')) {
      throw new Error(`unknown option ${a}. Usage: classify [--base <ref> | <ref>] [--head <ref>]`);
    } else positional.push(a);
  }
  if (positional.length > 1) throw new Error(`too many arguments: ${positional.join(' ')}`);
  if (positional.length === 1) {
    if (base !== undefined) throw new Error('give the base ref once: either --base <ref> or a bare ref, not both');
    base = positional[0];
  }
  return { base: base ?? 'origin/main', head: head ?? 'HEAD' };
}

async function main() {
  const { execFileSync } = await import('node:child_process');
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  let args: CliArgs;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`classify: ${(e as Error).message}`); process.exit(2); }
  const resolve = (label: string, ref: string) => {
    try { return git('rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`).trim(); }
    catch { console.error(`classify: ${label} ref '${ref}' does not exist (try 'git fetch origin')`); process.exit(2); }
  };
  const baseSha = resolve('base', args.base);
  const headSha = resolve('head', args.head);
  const mergeBase = git('merge-base', baseSha, headSha).trim();
  const files = git('diff', '--name-status', mergeBase, headSha).trim().split('\n').filter(Boolean)
    .map((l) => { const [status, ...rest] = l.split('\t'); return { status, path: rest[rest.length - 1] }; });
  const deps = (ref: string) => {
    try {
      const p = JSON.parse(git('show', `${ref}:package.json`));
      return { ...p.dependencies, ...p.devDependencies } as Record<string, string>;
    } catch { return {}; }
  };
  const countTests = (ref: string) => {
    const list = git('ls-tree', '-r', '--name-only', ref, '--', 'tests').trim().split('\n').filter((p) => /\.test\.ts$/.test(p));
    return list.reduce((n, p) => n + (git('show', `${ref}:${p}`).match(/\b(it|test)\s*\(/g)?.length ?? 0), 0);
  };
  const addedLines: { path: string; text: string }[] = [];
  let current = '';
  for (const l of git('diff', '-U0', mergeBase, headSha).split('\n')) {
    if (l.startsWith('+++ ')) current = l.replace(/^\+\+\+ (b\/)?/, '');
    else if (l.startsWith('+')) addedLines.push({ path: current, text: l.slice(1) });
  }
  const branch = args.head === 'HEAD' ? git('rev-parse', '--abbrev-ref', 'HEAD').trim() : args.head.replace(/^(refs\/heads\/|origin\/)/, '');
  const result = classify({
    branch, files, depsBase: deps(mergeBase), depsHead: deps(headSha),
    testCountBase: countTests(mergeBase), testCountHead: countTests(headSha), addedLines,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
