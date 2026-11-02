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
td.actions form.inline{display:inline-flex}
.tabs{display:flex;gap:.35rem;margin:.2rem 0 1.3rem;border-bottom:1px solid #e6e8ec}
.tabs .tab{padding:.5rem .95rem;color:#666;font-size:.9rem;border-bottom:2px solid transparent;margin-bottom:-1px}
.tabs .tab.on{color:#06c;border-color:#06c;font-weight:600}
.tabs .tab:hover{text-decoration:none;color:#06c}
.mk{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;padding:1rem;background:rgba(0,0,0,.35)}
.mk[hidden]{display:none}
.mk-window{display:flex;width:min(94vw,62rem);height:min(82vh,36rem);background:#fff;border:1px solid rgba(0,0,0,.12);border-radius:12px;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.32)}
.mk-side{width:12.5rem;flex:none;padding:.7rem .5rem;background:#f1f2f4;border-right:1px solid #dcdde1;overflow:auto}
.mk-side-title{padding:.7rem .6rem .25rem;font-size:.72rem;font-weight:600;color:#8a8f98}
.mk-side-ico{display:inline-block;width:1.1rem;margin-right:.35rem;text-align:center;opacity:.75}
.mk-side-item{display:flex;align-items:center;width:100%;padding:.32rem .6rem;border:0;border-radius:6px;background:transparent;color:#333;font-size:.85rem;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.mk-side-item:hover{background:#e4e6ea}
.mk-side-item.on{background:#d8dade;font-weight:600}
.mk-main{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}
.mk-title{padding:.7rem 1rem .1rem;font-size:.9rem;font-weight:600;text-align:center;color:#222}
.mk-toolbar{display:flex;align-items:center;gap:.5rem;padding:.55rem .8rem;border-bottom:1px solid #e6e8ec}
.mk-icon{width:1.9rem;height:1.7rem;border:0;border-radius:6px;background:#f1f2f4;color:#333;font-size:1.1rem;line-height:1;cursor:pointer}
.mk-icon:hover{background:#e4e6ea}
.mk-icon:disabled{opacity:.4;cursor:default}
.mk-crumbs{flex:1;min-width:0;display:flex;align-items:center;gap:.1rem;overflow:auto;white-space:nowrap;font-size:.85rem;color:#555}
.mk-crumb{padding:.1rem .2rem;border:0;border-radius:4px;background:transparent;color:#06c;font-size:.85rem;cursor:pointer}
.mk-crumb:hover{background:#eef0f3;text-decoration:none}
.mk-sep{color:#bbb}
.mk-search{width:11rem;padding:.3rem .5rem;border:1px solid #d8dade;border-radius:6px;background:#fff;font-size:.85rem;color:#222}
.mk-table{flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden}
.mk-head,.mk-row{display:grid;grid-template-columns:1.5rem minmax(0,1fr) 4.5rem 6rem 9.5rem;align-items:center;gap:.45rem;padding:.32rem .8rem;font-size:.85rem}
.mk-head{padding-top:.4rem;padding-bottom:.4rem;border-bottom:1px solid #e6e8ec;color:#8a8f98;font-size:.75rem}
.mk-body{flex:1;min-height:0;overflow:auto;padding:.25rem 0}
.mk-row{margin:0 .35rem;border-radius:6px;color:#222;cursor:default}
.mk-row:hover{background:#f2f4f7}
.mk-row.on{background:#0a66ff;color:#fff}
.mk-row .c-size,.mk-row .c-kind,.mk-row .c-date{color:#8a8f98}
.mk-row.on .c-size,.mk-row.on .c-kind,.mk-row.on .c-date{color:#dbe7ff}
.mk-icon-cell{font-size:.95rem;text-align:center}
.c-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.c-size{text-align:right}
.c-date{white-space:nowrap}
.mk-empty{padding:2.2rem;text-align:center;color:#9aa0a8;font-size:.85rem}
.mk-foot{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex:none;padding:.6rem .8rem;border-top:1px solid #e6e8ec;background:#fafbfc}
.mk-msg{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.8rem;color:#8a5a00}
.mk-actions{display:flex;flex:none;gap:.5rem}
.mk-btn{white-space:nowrap;padding:.35rem .95rem;border:1px solid #d8dade;border-radius:6px;background:#fff;color:#222;font-size:.85rem;cursor:pointer}
.mk-btn:hover{background:#f1f2f4}
.mk-btn.primary{background:#0a66ff;border-color:#0a66ff;color:#fff}
.mk-btn.primary:hover{background:#0057d8}
.mk-btn:disabled{opacity:.5;cursor:default}
.dir-chip{max-width:18rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
td.actions input{width:9rem;padding:.35rem .5rem;font-size:.85rem}
td.actions input.days{width:4.2rem}
label.check{display:flex;gap:.5rem;align-items:center;margin:.9rem 0 0;font-size:.85rem;color:#555}
label.check input{width:auto;margin:0}
td.actions button{padding:.35rem .6rem;font-size:.8rem}
.tag{display:inline-block;padding:.1rem .45rem;border-radius:99px;font-size:.75rem;background:#eef0f3;color:#555;white-space:nowrap}
.tag.admin{background:#e3f0ff;color:#0b63c5}
.tag.off{background:#fdecec;color:#b3261e}
.newuser{display:flex;flex-wrap:wrap;gap:.6rem;align-items:flex-end}
.newuser .f{flex:1 1 10rem}
.newuser label{margin-top:0}
.dirlinks{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.6rem}
.dirlinks a{display:inline-block;max-width:18rem;padding:.22rem .55rem;border:1px solid #d8dade;border-radius:8px;background:#fff;color:#06c;font-size:.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dirlinks a:hover{background:#eef0f3;text-decoration:none}
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
  .dirlinks a{background:#14161a;border-color:#333942;color:#7cb8f5}
  .dirlinks a:hover{background:#1b1e24}
  .tabs{border-color:#2b2f37}
  .tabs .tab{color:#8b93a1}
  .mk-window{background:#1e2127;border-color:#2b2f37}
  .mk-side{background:#191c22;border-color:#2b2f37}
  .mk-side-item{color:#d7dbe2}
  .mk-side-item:hover{background:#252932}
  .mk-side-item.on{background:#2f343e}
  .mk-title{color:#e8eaee}
  .mk-toolbar,.mk-foot{border-color:#2b2f37}
  .mk-foot{background:#191c22}
  .mk-icon,.mk-btn{background:#252932;border-color:#333942;color:#e8eaee}
  .mk-head,.mk-row{color:#e8eaee}
  .mk-head{border-color:#2b2f37;color:#8b93a1}
  .mk-row:hover{background:#252932}
  .mk-search{background:#14161a;border-color:#333942;color:#e8eaee}
  .mk-crumb:hover{background:#252932}
}
</style>`
