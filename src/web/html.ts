/**
 * HTML for the panel web view.
 *
 * Everything is inlined — no CDN, no external fonts, no remote anything. The page is
 * served from a loopback socket and must work with no network at all, which is also
 * what lets the CSP be as strict as it is.
 */

const ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

/**
 * Escape text for interpolation into HTML.
 *
 * Transcripts are arbitrary text — code, markup, prompt-injection attempts — so every
 * value that reaches the DOM goes through here or through `textContent`. Unescaped, a
 * transcript containing `<script>` is stored XSS against a page that holds the token.
 */
export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Escape a string for safe embedding inside a <script> block as a JSON literal. */
function jsonForScript(value: unknown): string {
	// `</script>` inside a string would close the block; `<!--` can start a comment in
	// legacy parsing modes. U+2028/9 are literal line terminators in JS source.
	return JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fbfbfa;--panel:#fff;--line:#e4e4e1;--fg:#1b1b19;--dim:#6b6b66;--accent:#3b6ea5;--user:#eef3f8;--assistant:#f7f7f5}
@media(prefers-color-scheme:dark){:root{--bg:#17171a;--panel:#1e1e22;--line:#32323a;--fg:#e9e9e6;--dim:#9a9a94;--accent:#7aa9dd;--user:#22303f;--assistant:#26262c}}
*{box-sizing:border-box}
body{margin:0;font:14px/1.55 ui-sans-serif,-apple-system,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--fg);height:100vh;display:flex;flex-direction:column}
header{padding:10px 14px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
h1{font-size:14px;margin:0;font-weight:650;letter-spacing:-.01em}
#stats{color:var(--dim);font-size:12px}
input[type=search]{flex:1;min-width:200px;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--fg);font:inherit}
select{padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--fg);font:inherit}
main{flex:1;display:flex;min-height:0}
#list{width:min(46%,560px);border-right:1px solid var(--line);overflow-y:auto}
.row{padding:9px 14px;border-bottom:1px solid var(--line);cursor:pointer}
.row:hover{background:var(--panel)}
.row[aria-selected=true]{background:var(--panel);box-shadow:inset 3px 0 0 var(--accent)}
.row .t{font-weight:600;margin-bottom:2px;overflow-wrap:anywhere}
.row .m{color:var(--dim);font-size:12px;display:flex;gap:8px;flex-wrap:wrap}
.tag{border:1px solid var(--line);border-radius:999px;padding:0 6px;font-size:11px}
.stranded{color:#b4553d;border-color:#b4553d}
#detail{flex:1;overflow-y:auto;padding:16px 20px}
#detail h2{font-size:16px;margin:0 0 4px;overflow-wrap:anywhere}
.meta{color:var(--dim);font-size:12px;margin-bottom:6px;overflow-wrap:anywhere}
.resume{display:flex;gap:8px;align-items:center;margin:10px 0 18px}
code{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--panel);border:1px solid var(--line);border-radius:5px;padding:3px 7px;overflow-wrap:anywhere}
button{font:inherit;padding:4px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--fg);cursor:pointer}
button:hover{border-color:var(--accent)}
.msg{border:1px solid var(--line);border-radius:8px;padding:9px 12px;margin-bottom:10px;white-space:pre-wrap;overflow-wrap:anywhere}
.msg.user{background:var(--user)}
.msg.assistant{background:var(--assistant)}
.role{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin-bottom:4px}
.empty{color:var(--dim);padding:24px 0}
mark{background:#f3e08a;color:#1b1b19}
`;

// The client is deliberately small and dependency-free. Every value from the server is
// inserted with textContent, never innerHTML, so transcript content can never become
// markup — the one exception is search highlighting, which escapes first.
const SCRIPT = `
const T=window.__T;let all=[],cur=null,mode='local';
const $=s=>document.querySelector(s);
const api=(p)=>fetch(p+(p.includes('?')?'&':'?')+'t='+encodeURIComponent(T)).then(r=>{if(!r.ok)throw new Error(r.status);return r.json()});
const when=s=>{if(!s)return'unknown';const d=new Date(s),p=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())};
const size=b=>b>=1048576?(b/1048576).toFixed(1)+'MB':Math.max(1,Math.round(b/1024))+'KB';
function rows(items){
  const list=$('#list');list.textContent='';
  if(!items.length){const d=document.createElement('div');d.className='empty';d.style.padding='16px';d.textContent='No sessions match.';list.append(d);return}
  for(const s of items){
    const r=document.createElement('div');r.className='row';r.setAttribute('role','option');r.dataset.id=s.sessionId;
    const t=document.createElement('div');t.className='t';t.textContent=s.title;r.append(t);
    const m=document.createElement('div');m.className='m';
    for(const [txt,cls] of [[when(s.lastMessageAt),''],[s.agentId,'tag'],[s.projectName,'tag'],[s.messageCount+' msgs',''],[size(s.sizeBytes),'']]){
      const x=document.createElement('span');if(cls)x.className=cls;x.textContent=txt;m.append(x)}
    if(s.stranded){const x=document.createElement('span');x.className='tag stranded';x.textContent='stranded';m.append(x)}
    r.append(m);r.onclick=()=>open(s.sessionId);list.append(r)}
}
function open(id){
  cur=id;
  for(const r of document.querySelectorAll('.row'))r.setAttribute('aria-selected',String(r.dataset.id===id));
  const d=$('#detail');d.textContent='Loading…';
  api('/api/sessions/'+encodeURIComponent(id)).then(({session,messages})=>{
    d.textContent='';
    const h=document.createElement('h2');h.textContent=session.title;d.append(h);
    const meta=document.createElement('div');meta.className='meta';
    meta.textContent=session.agentId+' · '+session.projectPath+' · '+when(session.lastMessageAt)+' · '+session.messageCount+' msgs · '+size(session.sizeBytes)+(session.stranded?' · project path no longer exists':'');
    d.append(meta);
    const rw=document.createElement('div');rw.className='resume';
    const c=document.createElement('code');c.textContent=session.fullResumeCommand;
    const b=document.createElement('button');b.textContent='Copy';
    b.onclick=()=>{navigator.clipboard.writeText(session.fullResumeCommand);b.textContent='Copied';setTimeout(()=>b.textContent='Copy',1200)};
    rw.append(c,b);d.append(rw);
    if(!messages.length){const e=document.createElement('div');e.className='empty';e.textContent='No readable messages in this transcript.';d.append(e);return}
    for(const m of messages){
      const el=document.createElement('div');el.className='msg '+(m.role==='user'?'user':'assistant');
      const r=document.createElement('div');r.className='role';r.textContent=m.role;
      const p=document.createElement('div');p.textContent=m.text;
      el.append(r,p);d.append(el)}
  }).catch(e=>{d.textContent='Failed to load session ('+e.message+')'});
}
function apply(){
  const q=$('#q').value.trim().toLowerCase(),agent=$('#agent').value;
  let items=all.filter(s=>agent==='all'||s.agentId===agent);
  if(mode==='local'&&q)items=items.filter(s=>(s.title+' '+s.projectName+' '+s.projectPath+' '+s.sessionId).toLowerCase().includes(q));
  rows(items);$('#stats').textContent=items.length+' of '+all.length+' sessions';
}
function deep(){
  const q=$('#q').value.trim();if(!q)return;
  $('#stats').textContent='Searching transcripts…';
  api('/api/search?q='+encodeURIComponent(q)).then(hits=>{
    const byId=new Map(all.map(s=>[s.sessionId,s]));
    const items=hits.map(h=>byId.get(h.sessionId)).filter(Boolean);
    rows(items);$('#stats').textContent=hits.length+' sessions contain "'+q+'"';
    const snip=new Map(hits.map(h=>[h.sessionId,h.snippet]));
    for(const r of document.querySelectorAll('.row')){
      const s=snip.get(r.dataset.id);if(!s)continue;
      const d=document.createElement('div');d.className='m';d.style.marginTop='3px';d.textContent=s;r.append(d)}
  }).catch(e=>{$('#stats').textContent='Search failed ('+e.message+')'});
}
$('#q').addEventListener('input',apply);
$('#q').addEventListener('keydown',e=>{if(e.key==='Enter')deep()});
$('#agent').addEventListener('change',apply);
$('#deep').addEventListener('click',deep);
api('/api/sessions').then(s=>{all=s;apply()}).catch(e=>{$('#list').textContent='Failed to load sessions ('+e.message+')'});
`;

export function renderShell(opts: { token: string }): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>CodeTeleport — local sessions</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>Local sessions</h1>
  <input id="q" type="search" placeholder="Filter by title, project or id — press Enter to search inside transcripts" autocomplete="off" spellcheck="false">
  <select id="agent" aria-label="Agent">
    <option value="all">All agents</option>
    <option value="claude-code">Claude Code</option>
    <option value="codex">Codex</option>
    <option value="antigravity">Antigravity</option>
  </select>
  <button id="deep" type="button">Search transcripts</button>
  <span id="stats"></span>
</header>
<main>
  <div id="list" role="listbox" aria-label="Sessions"></div>
  <div id="detail"><div class="empty">Select a session to read it.</div></div>
</main>
<script>window.__T=${jsonForScript(opts.token)};</script>
<script>${SCRIPT}</script>
</body>
</html>`;
}
