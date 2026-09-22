const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const script=path.join(__dirname,'check-upstream.cjs');
test('clean upstream contributions pass; namespaces and unmarked shared hooks fail',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'boundary-fixture-'));
 const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const commit=(file,body)=>{fs.mkdirSync(path.dirname(path.join(dir,file)),{recursive:true});fs.writeFileSync(path.join(dir,file),body);git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','fixture');};
 try{
 git('init');commit('README.md','base');const base=git('rev-parse','HEAD');
 commit('lib/clean.ts','export const answer=42;');assert.match(execFileSync(process.execPath,[script,base,'HEAD'],{cwd:dir,encoding:'utf8'}),/passed/);
 for(const file of ['pilae/secret.ts','pages/api/pilae/check.ts','pages/pilae/replies.tsx','lib/linkedin/runner.ts','lib/campaign-metrics.ts','instrumentation.ts']){
  git('checkout','--detach',base);commit(file,'export const harmlessName=1;');assert.throws(()=>execFileSync(process.execPath,[script,base,'HEAD'],{cwd:dir,stdio:'pipe'}));
 }
 git('checkout','--detach',base);commit('lib/other.ts','import "@/pilae/replies";');assert.throws(()=>execFileSync(process.execPath,[script,base,'HEAD'],{cwd:dir,stdio:'pipe'}));
 }finally{fs.rmSync(dir,{recursive:true});}
});
