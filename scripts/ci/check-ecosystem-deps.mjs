import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const repos = [
  'consensus-agent-action-guard',
  'consensus-code-merge-guard',
  'consensus-deployment-guard',
  'consensus-permission-escalation-guard',
  'consensus-publish-guard',
  'consensus-send-email-guard',
  'consensus-support-reply-guard',
  'consensus-persona-generator',
  'consensus-persona-respawn'
];

const minimums = {
  'consensus-guard-core': '1.1.10'
};

function parse(v){ return v.replace(/^[^0-9]*/, '').split('.').map(n=>parseInt(n||'0',10)); }
function gte(a,b){ const A=parse(a),B=parse(b); for(let i=0;i<3;i++){ if((A[i]||0)>(B[i]||0)) return true; if((A[i]||0)<(B[i]||0)) return false; } return true; }

const rows=[];
let failed=false;

for(const repo of repos){
  const pkgPath = path.join(root, 'ecosystem', repo, 'package.json');
  if(!fs.existsSync(pkgPath)){
    rows.push([repo,'MISSING_REPO','','']);
    failed=true;
    continue;
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath,'utf8'));
  const deps = pkg.dependencies || {};
  const dep = deps['consensus-guard-core'] || '';
  const hasFile = String(dep).startsWith('file:');
  const min = minimums['consensus-guard-core'];
  const ok = dep && !hasFile && gte(dep, min);
  rows.push([repo, dep || '(none)', hasFile ? 'file:DEP' : '', ok ? 'OK' : `FAIL(min ${min})`]);
  if(!ok) failed=true;
}

const outDir = path.join(root,'artifacts','reports');
fs.mkdirSync(outDir,{recursive:true});
const out = path.join(outDir,'ecosystem-deps-report.md');
let md = '# Ecosystem Dependency Report\n\n';
md += '| Repo | consensus-guard-core dep | Flags | Status |\n|---|---:|---|---|\n';
for(const r of rows) md += `| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} |\n`;
fs.writeFileSync(out, md);
console.log(md);
if(failed) process.exit(1);
