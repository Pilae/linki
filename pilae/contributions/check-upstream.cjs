#!/usr/bin/env node
// Run this trusted script from Pilae main, with candidate refs in the same object database.
const {execFileSync}=require('node:child_process');
function git(...args){return execFileSync('git',args,{encoding:'utf8',maxBuffer:10*1024*1024}).trim();}
function check(base,head){
 const b=git('rev-parse','--verify',base+'^{commit}'),h=git('rev-parse','--verify',head+'^{commit}');
 git('merge-base','--is-ancestor',b,h);
 // Conservative by design: even removing/renaming a marker cannot hide a Pilae hook here.
 const shared=new Set(['instrumentation.ts','lib/linkedin/runner.ts','lib/campaign-metrics.ts']);
 const forbidden=p=>p.startsWith('pilae/')||p.startsWith('pages/api/pilae/')||p.startsWith('pages/pilae/')||p.startsWith('.github/workflows/pilae-')||shared.has(p);
 const rejected=new Set();
 for(const commit of git('rev-list',`${b}..${h}`).split('\n').filter(Boolean)){
  // Inspect every commit, including merge parents; add-then-remove cannot launder fork changes.
  const files=git('diff-tree','--no-commit-id','--name-only','-r','-m',commit).split('\n').filter(Boolean);
  for(const file of files)if(forbidden(file))rejected.add(file);
  const patch=git('show','--format=','--no-ext-diff',commit,'--');
  if(/^[+-](?![+-]).*(?:pilae|PILAE_REPLY|hasRunReply|syncPremium|linkedin_reply)/mi.test(patch))rejected.add('Pilae integration marker in shared-file patch');
 }
 if(rejected.size)throw Error('Upstream export rejected:\n'+[...rejected].join('\n'));
 return 'Upstream boundary check passed';
}
exports.check=check;
if(require.main===module){try{if(process.argv.length!==4)throw Error('Usage: node check-upstream.cjs UPSTREAM_BASE CANDIDATE');console.log(check(process.argv[2],process.argv[3]));}catch(e){console.error(e.message);process.exitCode=1;}}
