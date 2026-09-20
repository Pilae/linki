const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const Module = require('module');

// Compile the production modules together so fixtures exercise shared imports.
const cache = new Map();
function loadLinkedIn(file) {
  if (cache.has(file)) return cache.get(file);
  const filename = path.join(__dirname, '../lib/linkedin', file + '.ts');
  const m = new Module(filename);
  m.require = name => name.startsWith('./') ? loadLinkedIn(name.slice(2)) : require(name);
  m._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText, filename);
  cache.set(file, m.exports);
  return m.exports;
}
module.exports = {loadLinkedIn};
