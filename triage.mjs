// Ask the proxy directly what happened. When its upstream fetch fails it
// returns a stub page that posts proxy-failed — no browser needed to detect
// that, and it separates "our proxy cannot fetch this site" from "it fetched
// fine and the page would not render".
import fs from 'fs'
const BASE='https://hitmanslibrary.xyz'
const fails=JSON.parse(fs.readFileSync('preview-results.json','utf8')).filter(r=>!r.ok)
const out=[]
const q=[...fails]
async function worker(){
  while(q.length){
    const f=q.shift()
    try{
      const res=await fetch(`${BASE}/api/proxy?url=${encodeURIComponent(f.url)}&picker=0`,{signal:AbortSignal.timeout(45000)})
      const body=await res.text()
      // Every proxied page carries the injected script, and that script
      // contains the literal 'proxy-failed'. The stub the proxy returns when
      // its own fetch fails is the one response with no <base href> rewrite
      // in it, and it is a few hundred bytes rather than a real document.
      const proxyFailed = !body.includes('<base href=')
      const reason = proxyFailed
        ? (body.match(/reason:\s*("[^"]*")/) || [, null])[1] ?? body.slice(0, 120)
        : null
      out.push({...f, proxyStatus:res.status, proxyFailed, bytes:body.length, reason})
    }catch(e){ out.push({...f, proxyStatus:0, proxyFailed:true, reason:String(e).slice(0,60)}) }
  }
}
await Promise.all(Array.from({length:5},worker))
fs.writeFileSync('triage.json',JSON.stringify(out,null,1))
const cannotFetch=out.filter(o=>o.proxyFailed)
const fetched=out.filter(o=>!o.proxyFailed)
console.log(`proxy cannot fetch at all: ${cannotFetch.length}`)
console.log(`proxy fetched fine, page would not render: ${fetched.length}`)
console.log('\nreasons the fetch failed:')
const by={}; for(const c of cannotFetch){const k=(c.reason||'?').replace(/\d{3,}/g,'N').slice(0,60);by[k]=(by[k]||0)+1}
console.log(Object.entries(by).sort((a,b)=>b[1]-a[1]).map(([k,n])=>`  ${n}  ${k}`).join('\n'))
