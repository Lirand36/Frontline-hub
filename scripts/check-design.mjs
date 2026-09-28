// Design check: the rules in CLAUDE.md that a script can enforce. Run with `npm run check:design`.
// It fails (exit 1) and says where, so drift is caught before a feature ships, not after.

import { readFileSync, readdirSync } from 'node:fs';

const problems = [];
const report = (file, line, msg) => problems.push(`${file}:${line}  ${msg}`);
const lines = (file) => readFileSync(file, 'utf8').split('\n');

// ---- styles.css: shared values only (tokens are defined in the :root blocks at the top)
{
  const file = 'public/styles.css';
  const all = lines(file);
  const start = all.findIndex((l) => l.startsWith('* {')); // everything before this is the token definitions
  const RADIUS_OK = /^(var\(--(r-(sm|md|lg|pill)|radius)\)|50%|0|inherit|0 3px 3px 0)$/;
  all.forEach((l, i) => {
    if (i < start) return;
    const n = i + 1;
    const code = l.replace(/\/\*.*?\*\//g, '');
    for (const m of code.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) report(file, n, `raw color ${m[0]}: use a color token (var(--…))`);
    for (const m of code.matchAll(/font-size:\s*([^;}]+)/g)) if (!/^var\(--fs-[\w]+\)$/.test(m[1].trim())) report(file, n, `font-size ${m[1].trim()}: use the type scale (var(--fs-2xs … --fs-title))`);
    for (const m of code.matchAll(/(?<![\w-])border-radius:\s*([^;}]+)/g)) if (!RADIUS_OK.test(m[1].trim())) report(file, n, `border-radius ${m[1].trim()}: use var(--r-sm|md|lg|pill)`);
    for (const m of code.matchAll(/font:\s*([\d.]+px)/g)) report(file, n, `font ${m[1]}: use var(--fs-…)`);
    for (const m of code.matchAll(/font-family:\s*([^;}]+)/g)) if (!/^(var\(--(font|font-display|mono)\)|inherit)$/.test(m[1].trim())) report(file, n, `font-family ${m[1].trim()}: use var(--font), var(--font-display) or var(--mono)`);
  });
}

// ---- UI code: no one-off styles, no emoji, titles read "Account · action"
const uiFiles = ['public/app.js', 'public/index.html', 'src/home.js', 'src/ops.js', 'src/deals.js', 'src/cs.js'];
for (const file of uiFiles) {
  lines(file).forEach((l, i) => {
    const n = i + 1;
    for (const m of l.matchAll(/style="([^"]*)"/g)) if (!m[1].includes('${')) report(file, n, `inline style "${m[1]}": use a utility class (mt-2, fw-600…) or a component class`);
    for (const m of l.matchAll(/\p{Extended_Pictographic}/gu)) report(file, n, `emoji ${m[0]}: use a line icon from the sprite in index.html`);
    if (/\$\{(esc\()?a\??\.name\)?\}: /.test(l)) report(file, n, 'title uses "Account: …": write "Account · …"');
    if (/class="kpis|class="card kpi/.test(l)) report(file, n, 'number-card row: open the page with a summary sentence (dek + dn) or figures()');
  });
}

// ---- every page in the router has a title, an access rule and a nav entry
{
  const app = readFileSync('public/app.js', 'utf8');
  const html = readFileSync('public/index.html', 'utf8');
  const titles = [...(app.match(/const TITLES = \{([^}]*)\}/)?.[1] ?? '').matchAll(/(\w+):/g)].map((m) => m[1]);
  const caps = [...(app.match(/const PAGE_CAP = \{([^}]*)\}/)?.[1] ?? '').matchAll(/(\w+):/g)].map((m) => m[1]);
  for (const sec of [...app.matchAll(/section === '(\w+)'\) (?:await )?render/g)].map((m) => m[1])) {
    if (!titles.includes(sec)) report('public/app.js', 0, `page "${sec}" has no entry in TITLES`);
    if (sec !== 'home' && sec !== 'accounts' && !caps.includes(sec)) report('public/app.js', 0, `page "${sec}" has no access rule in PAGE_CAP`);
    if (!html.includes(`data-nav="${sec}"`)) report('public/index.html', 0, `page "${sec}" has no sidebar link`);
  }
}

if (problems.length) {
  console.error(`Design check: ${problems.length} problem${problems.length === 1 ? '' : 's'} (rules in CLAUDE.md)\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`Design check passed (${uiFiles.length + 1} files).`);
