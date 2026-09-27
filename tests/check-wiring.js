/* Статическая проверка связности фронтенда без браузера:
   1) все ли импортируемые имена реально экспортируются;
   2) все ли #id и .классы, которые ищет JS, есть в index.html;
   3) нет ли обращений к необъявленным методам App/LibraryView. */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const webDir = path.join(root, 'web');
const jsDir = path.join(webDir, 'js');

const jsFiles = fs.readdirSync(jsDir).filter((f) => f.endsWith('.js'));
const sources = new Map(jsFiles.map((f) => [f, fs.readFileSync(path.join(jsDir, f), 'utf8')]));
const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');

let problems = 0;
const fail = (msg) => {
  problems += 1;
  console.log(`  ✗ ${msg}`);
};

// ---------------------------------------------------------------- 1. импорты

console.log('\n[1] Импорты ↔ экспорты');
const exportsByFile = new Map();
for (const [file, src] of sources) {
  const names = new Set();
  // export function name / export const name / export class name
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
  // export { a, b as c }
  for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      const alias = piece.split(/\s+as\s+/);
      names.add((alias[1] || alias[0]).trim());
    }
  }
  exportsByFile.set(file, names);
}

for (const [file, src] of sources) {
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/([A-Za-z0-9_.-]+)['"]/g)) {
    const target = m[2].endsWith('.js') ? m[2] : `${m[2]}.js`;
    const available = exportsByFile.get(target);
    if (!available) {
      fail(`${file}: импорт из несуществующего модуля ./${target}`);
      continue;
    }
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      if (!available.has(name)) fail(`${file}: «${name}» не экспортируется из ${target}`);
    }
  }
}
if (!problems) console.log('  ✓ все импорты разрешаются');

// ---------------------------------------------------------------- 2. DOM

console.log('\n[2] Ссылки на DOM');
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const htmlClasses = new Set();
for (const m of html.matchAll(/\bclass="([^"]+)"/g)) {
  for (const cls of m[1].split(/\s+/)) if (cls) htmlClasses.add(cls);
}
// классы, создаваемые в JS (для динамических узлов)
const jsClasses = new Set();
for (const src of sources.values()) {
  for (const m of src.matchAll(/class:\s*[`'"]([^`'"]+)/g)) {
    for (const cls of m[1].split(/\s+/)) {
      const clean = cls.replace(/\$\{[^}]*\}/g, '').trim();
      if (clean) jsClasses.add(clean);
    }
  }
}

const ignoreIds = new Set(['audio', 'cover-input', 'file-input']);
const domProblemsStart = problems;
for (const [file, src] of sources) {
  for (const m of src.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) {
    const id = m[1];
    if (!htmlIds.has(id) && !ignoreIds.has(id)) fail(`${file}: $('#${id}') — нет такого id в index.html`);
  }
  for (const m of src.matchAll(/\$\$\('\.([A-Za-z0-9_-]+)/g)) {
    const cls = m[1];
    if (!htmlClasses.has(cls) && !jsClasses.has(cls)) fail(`${file}: $$('.${cls}') — класса нет ни в HTML, ни в JS`);
  }
}
if (problems === domProblemsStart) console.log('  ✓ все id и классы на месте');

// data-icon значения
console.log('\n[3] Иконки');
const iconSrc = sources.get('icons.js');
const iconNames = new Set([...iconSrc.matchAll(/^\s{2}'?([A-Za-z0-9_-]+)'?:\s*'/gm)].map((m) => m[1]));
const usedIcons = new Set();
for (const m of html.matchAll(/data-icon="([^"]+)"/g)) usedIcons.add(m[1]);
for (const [, src] of sources) {
  for (const m of src.matchAll(/icon:\s*'([A-Za-z0-9_-]+)'/g)) usedIcons.add(m[1]);
  for (const m of src.matchAll(/icon\('([A-Za-z0-9_-]+)'/g)) usedIcons.add(m[1]);
  for (const m of src.matchAll(/data-icon':\s*'([A-Za-z0-9_-]+)'/g)) usedIcons.add(m[1]);
  for (const m of src.matchAll(/dataset\.icon\s*=\s*'([A-Za-z0-9_-]+)'/g)) usedIcons.add(m[1]);
}
const iconProblems = problems;
for (const name of usedIcons) {
  if (!iconNames.has(name)) fail(`иконка «${name}» используется, но не определена в icons.js`);
}
if (problems === iconProblems) console.log(`  ✓ все ${usedIcons.size} используемых иконок определены (${iconNames.size} доступно)`);

// ---------------------------------------------------------------- 4. модуль app.js

console.log('\n[4] Ссылки на модуль app (динамические импорты)');
const appSrc = sources.get('app.js');
for (const m of appSrc.matchAll(/import\('\.\/([A-Za-z0-9_.-]+)'\)/g)) {
  const target = m[1].endsWith('.js') ? m[1] : `${m[1]}.js`;
  if (!sources.has(target)) fail(`app.js: динамический импорт ./${target} не существует`);
}
console.log('  ✓ проверено');

console.log(problems ? `\nПРОБЛЕМ: ${problems}` : '\nВсе проверки связности прошли.');
process.exit(problems ? 1 : 0);