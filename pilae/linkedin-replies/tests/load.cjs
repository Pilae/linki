const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
exports.loader=function(stubs={}) {
 const cache=new Map();
 function load(file) {
  const filename=path.resolve(__dirname,'../../..',file);
  if(cache.has(filename))return cache.get(filename).exports;
  const m=new Module(filename);cache.set(filename,m);
  m.require=name=>{
   if(Object.hasOwn(stubs,name))return stubs[name];
   if(name.startsWith('./'))return load(path.relative(path.resolve(__dirname,'../../..'),path.resolve(path.dirname(filename),name))+'.ts');
   if(name.startsWith('@/'))return load(name.slice(2)+'.ts');
   return require(name);
  };
  m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,filename);
  return m.exports;
 }
 return load;
};
