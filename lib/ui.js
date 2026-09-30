/** 登录页 / 管理后台共用的样式与转义工具。 */

export function escapeHTML(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )
}

export const AUTH_STYLE = `<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:#f6f7f9;color:#222}
body.center{display:flex;min-height:100vh;align-items:center;justify-content:center}
a{color:#06c;text-decoration:none}
a:hover{text-decoration:underline}
.card{background:#fff;padding:2.2rem 2rem;border-radius:12px;box-shadow:0 2px 24px rgba(0,0,0,.08);width:min(92vw,22rem)}
h1{font-size:1.2rem;margin:0 0 .3rem}
.sub{color:#888;font-size:.85rem;margin:0 0 1.4rem}
label{display:block;font-size:.82rem;color:#666;margin:.9rem 0 .3rem}
input,select{width:100%;padding:.6rem .7rem;border:1px solid #d8dade;border-radius:8px;font-size:1rem;background:#fff;color:#222}
input:focus,select:focus{outline:2px solid #06c;outline-offset:-1px;border-color:#06c}
button{padding:.55rem .9rem;border:0;border-radius:8px;background:#06c;color:#fff;font-size:.9rem;cursor:pointer}
button:hover{background:#0057ad}
button.ghost{background:#eef0f3;color:#333}
button.ghost:hover{background:#e2e5ea}
button.danger{background:#d93025}
button.danger:hover{background:#b3261e}
button.primary{width:100%;margin-top:1.4rem;padding:.65rem;font-size:1rem}
.err{margin-top:1rem;padding:.55rem .7rem;border-radius:8px;background:#fdecec;color:#b3261e;font-size:.88rem}
.ok{margin-top:1rem;padding:.55rem .7rem;border-radius:8px;background:#e8f5e9;color:#1b5e20;font-size:.88rem}
.info{margin-top:1rem;padding:.55rem .7rem;border-radius:8px;background:#fff7e6;color:#8a5a00;font-size:.88rem}
.msg{margin-top:1rem;padding:.55rem .7rem;border-radius:8px;font-size:.88rem}
.foot{margin-top:1.4rem;text-align:center;color:#aaa;font-size:.75rem}
.wrap{max-width:60rem;margin:0 auto;padding:2rem 1rem 4rem}
.top{display:flex;flex-wrap:wrap;gap:.6rem;align-items:baseline;justify-content:space-between;margin-bottom:1.5rem}
.top h1{font-size:1.3rem;margin:0}
.top .who{color:#888;font-size:.85rem}
section{background:#fff;border-radius:12px;padding:1.4rem 1.5rem;margin-bottom:1.4rem;box-shadow:0 1px 3px rgba(0,0,0,.06)}
section h2{font-size:1rem;margin:0 0 1rem}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:.55rem .5rem;border-bottom:1px solid #eee;font-size:.9rem;vertical-align:middle}
th{color:#888;font-weight:500;font-size:.8rem;white-space:nowrap}
tr:last-child td{border-bottom:0}
td.actions{white-space:nowrap;text-align:right}
td.actions form{display:inline-flex;gap:.35rem;align-items:center;margin-left:.35rem}
td.actions input{width:9rem;padding:.35rem .5rem;font-size:.85rem}
td.actions button{padding:.35rem .6rem;font-size:.8rem}
.tag{display:inline-block;padding:.1rem .45rem;border-radius:99px;font-size:.75rem;background:#eef0f3;color:#555;white-space:nowrap}
.tag.admin{background:#e3f0ff;color:#0b63c5}
.tag.off{background:#fdecec;color:#b3261e}
.newuser{display:flex;flex-wrap:wrap;gap:.6rem;align-items:flex-end}
.newuser .f{flex:1 1 10rem}
.newuser label{margin-top:0}
@media (prefers-color-scheme:dark){
  body{background:#16181d;color:#e8eaee}
  .card,section{background:#1e2127;box-shadow:none;border:1px solid #2b2f37}
  h1,input,select,td{color:#e8eaee}
  input,select{background:#14161a;border-color:#333942}
  th,td{border-color:#2b2f37}
  th,.top .who,.sub{color:#8b93a1}
  .err{background:#3a1d1d;color:#ffb4ab}
  .ok{background:#1c3323;color:#a5d6a7}
  .info{background:#3a2f14;color:#ffd28a}
  .tag{background:#2b2f37;color:#b9c0cc}
  .tag.admin{background:#12293f;color:#7cb8f5}
  .tag.off{background:#3a1d1d;color:#ffb4ab}
  button.ghost{background:#2b2f37;color:#e8eaee}
  button.ghost:hover{background:#353a44}
}
</style>`
