const fs = require('node:fs'), path = require('node:path'), ts = require('typescript'), Module = require('node:module');
function loader(overrides = {}) {
  const cache = new Map();
  function load(file) {
    const full = path.resolve(__dirname, '..', file + '.ts');
    if (cache.has(full)) return cache.get(full);
    const m = new Module(full);
    m.require = n => Object.hasOwn(overrides,n) ? overrides[n] : n.startsWith('@/') ? load(n.slice(2)) : n.startsWith('.') ? load(path.relative(path.resolve(__dirname,'..'),path.resolve(path.dirname(full),n))) : require(n);
    m._compile(ts.transpileModule(fs.readFileSync(full,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText, full);
    cache.set(full,m.exports); return m.exports;
  }
  return load;
}
module.exports = {loader};
