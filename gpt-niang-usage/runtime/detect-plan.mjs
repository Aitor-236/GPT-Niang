import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveCodexExecutable} from './usage.mjs';
import {readQuota} from './source.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let config={};
try{config=JSON.parse(fs.readFileSync(path.join(root,'installation.json'),'utf8').replace(/^\uFEFF/,''));}catch{}
// Defaults to the official source so the report keeps its original meaning;
// `--source auto` shows exactly what the widget would display.
const sourceIndex=process.argv.indexOf('--source');
const quotaSource=sourceIndex>=0?process.argv[sourceIndex+1]:'codex';
const result=await readQuota({...config,quotaSource},{codexPath:resolveCodexExecutable(config.codexPath)});
// Deliberately omit account identities, fingerprints, credentials and raw replies.
const report={source:result.source??'codex',plan:result.plan,planLabel:result.planLabel,planKnown:result.planKnown,planSource:result.planSource,authType:result.authType,quotaAvailable:result.ok,queryOk:result.queryOk,windows:result.windows,balance:result.balance??null,errorCode:result.errorCode??null,error:result.error??null};
if(process.argv.includes('--json'))console.log(JSON.stringify(report,null,2));
else {
  console.log('当前套餐：'+report.planLabel+'（'+(report.plan??'未提供标识')+'）');
  console.log('登录方式：'+(report.authType??'未登录或未确认'));
  for(const window of report.windows)console.log(window.label+'：剩余 '+window.remaining+'%');
  if(report.balance)console.log('DeepSeek 余额：'+report.balance.total+' '+report.balance.currency);
  if(report.error)console.log(report.error);
}
process.exitCode=report.queryOk?0:1;
