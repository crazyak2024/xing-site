/* Explicit opt-in: the legacy lane remains isolated until NODE_SEARCH_V2 is deployed.
 * Read /node on visits; only an explicit, verified action writes /ask. */
(() => {
  'use strict';
  const KEY = 'xing_asked';
  const snapshots = new Map(), retained = new Map(), errors = new Map(), loading = new Set();
  let rows = [], writable = true, loaded = false, searchSeq = 0, timer = null, current = null;
  let shownKey = "", shownLimit = 6;
  let verification = null, busy = false, flash = '', mismatch = false;
  const config = () => window.XING_SUPPLEMENTAL_V2 || {};
  const enabled = () => config().enabled === true;
  const base = () => String(config().apiBase || COLLECT_URL).replace(/\/$/, '');
  const h = value => esc(String(value ?? ''));
  const platformNames = {douyin:'抖音',bilibili:'B站',kuaishou:'快手',wechat_channels:'视频号'};
  const platforms = d => (d?.run?.platforms_searched || d?.platforms_searched || []).map(p => platformNames[p] || p).join('、');
  const active = d => ['PENDING','RUNNING','EXPORTING'].includes(d?.run?.state);
  function load() {
    if (loaded) return; loaded = true;
    try {
      const stored=localStorage.getItem(KEY);
      const raw = JSON.parse(stored || '[]'); rows = Array.isArray(raw) ? raw.filter(r => r && typeof r.node === 'string').slice(0,50) : [];
      if(stored===null){const old=JSON.parse(localStorage.getItem('xing.asks.v1')||'[]');if(Array.isArray(old)){rows=old.filter(r=>typeof r?.q==='string'&&r.q).slice(0,50).map(r=>({node:'legacy:'+r.q,q:r.q,title:r.q,last_seen_at:'',summary:'此前问过，点开查看已有内容'}));save();}}
    }
    catch (_) { writable = false; }
  }
  function save() { try { localStorage.setItem(KEY,JSON.stringify(rows)); } catch (_) { writable = false; } }
  function status(d) {
    if (!d) return '正在读取进度';
    const r = d.run;
    if (d.status === 'locked' || r?.state === 'FAILED') return '补搜遇到问题，正在处理';
    if (r?.state === 'RUNNING') return r.phase === 'judging' ? '更多内容正在路上——我们正在努力抓取和筛选，请耐心等待' : (platforms(d) ? `正在${platforms(d)}上搜` : '正在寻找相关内容');
    if (r?.state === 'EXPORTING') return '收尾中：在把内容发布上站';
    if (r?.state === 'PENDING') return d.queue_position ? `排在第 ${d.queue_position} 位 · 已记入「我问过的」` : '已收到，正在排队补搜';
    if (!active(d) && d.reason && d.message) return d.message;
    if (r?.state === 'CLOSED') {
      if (r.close_reason === 'no_supply') return platforms(d) ? `在${platforms(d)}上没搜到正面讲这个的口播内容` : '暂时没搜到正面讲这个的口播内容';
      if (r.close_reason === 'all_rejected') return '找到的内容都没过质量关';
      return platforms(d) ? `这是我们从${platforms(d)}上筛选出的最好内容` : '这一轮补搜已结束';
    }
    return d.message || '已收到，正在判断要不要补搜';
  }
  function progress(d) {
    if (!active(d)) return '';
    const r=d.run, n=Number(r.n_candidates), done=Number(r.n_done);
    const determinate=r.state==='RUNNING' && n>0 && Number.isFinite(done);
    const pct=determinate ? Math.max(0,Math.min(100,done/n*100)) : 0;
    return `<div class="supp-progress${determinate?'':' indeterminate'}" role="progressbar" aria-label="补搜进度"${determinate?` aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}"`:''}><i${determinate?` style="width:${pct}%"`:''}></i></div>`;
  }
  async function api(path,body) {
    const controller=new AbortController(), timeout=setTimeout(()=>controller.abort(),15000);
    try {
      const r=await fetch(base()+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:controller.signal,cache:'no-store'});
      const d=await r.json();
      if (!r.ok || d.ok===false) throw new Error(r.status===403?'验证未通过，请稍后重试':r.status===503?'补搜服务暂时不可用，请稍后重试':d.message||'暂时无法连接补搜服务，请重试');
      return d;
    } catch(e) { if(e.name==='AbortError') throw new Error('连接超时，请稍后重试'); throw e; }
    finally {clearTimeout(timeout);}
  }
  function remember(d, oldNode) {
    if (!d.node) return;
    snapshots.set(d.node,d); errors.delete(d.node); if(oldNode) {snapshots.set(oldNode,d); errors.delete(oldNode);}
    const prior=retained.get(oldNode||d.node)||[];
    retained.set(d.node,[...new Map([...prior,...(d.run?.fresh_items||[])].filter(laneUsable).map(x=>[x.id,x])).values()]);
    let changed=false;
    rows.forEach(r=> {if(r.node===d.node||r.node===oldNode){r.node=d.node;r.title=d.display_name||r.title;r.summary=status(d);r.updated_at=d.run?.closed_at||d.run?.updated_at||'';changed=true;}});
    if(changed) save();
  }
  async function read(node) {
    if (!node || node.startsWith('legacy:') || loading.has(node)) return; loading.add(node);
    try {
      const old=snapshots.get(node), d=await api('/node?name='+encodeURIComponent(node)); remember(d,node);
      if(current?.node===node) current={...current,...d,q:current.q,mapping:current.mapping==='suggested'?'suggested':d.mapping||current.mapping};
      if(d.run?.state==='CLOSED' && old?.run?.state!=='CLOSED') {
        // Preserve already seen fresh cards while the immutable library catches up.
        fetch('data.json',{cache:'no-cache'}).then(r=>r.ok?r.json():Promise.reject()).then(x=>{if(Array.isArray(x.items)){ALL_DATA=x.items;applyDomain();paint();}}).catch(()=>{});
      }
    } catch(e) {errors.set(node,e.message);}
    finally {loading.delete(node);paint();}
  }
  function paint() {
    refreshList(); if(state.asks) renderList(); else if(state.node||state.q) renderResults();
  }
  function selected() {
    if(state.node) return snapshots.get(state.node)||{node:state.node,display_name:state.node};
    if(current?.q===state.q) return snapshots.get(current.node)?{...snapshots.get(current.node),q:state.q,mapping:current.mapping}:current;
    const row=rows.find(r=>r.q===state.q); if(row?.node.startsWith('legacy:')) return {q:state.q}; return row ? {...(snapshots.get(row.node)||{node:row.node,display_name:row.title}),q:state.q} : {q:state.q};
  }
  function renderResults() {
    if(!state.node&&!state.q) return false;
    load(); const focus=document.activeElement;
    const editing=focus?.id==='supp-rephrase'?{value:focus.value,start:focus.selectionStart,end:focus.selectionEnd}:null;
    const focusedAction=focus?.dataset?.suppAction;
    const d=selected(), node=d.node;
    if(node&&!snapshots.has(node)&&!errors.has(node)&&!loading.has(node)) void read(node);
    const lib=node?ALL_DATA.filter(x=>x.node===node):matchedByQuery();
    const fresh=(retained.get(node)||d.run?.fresh_items||[]).filter(laneUsable);
    const items=[...new Map([...fresh,...lib].map(x=>[x.id,x])).values()];
    const r=d.run, hasStatus=Boolean(r||d.reason||d.message), q=state.q;
    const key=node||q;if(shownKey!==key){shownKey=key;shownLimit=6;}
    const shown=items.slice(0,shownLimit);
    const mapping=q&&node&&!node.startsWith('q:') ? `<div class="supp-mapping">你问的是“${h(q)}”，${d.mapping_overdue?'归类待人工确认':d.mapping==='suggested'?'可能对应':d.mapping==='pending'?'已归入，待确认':'已归入'}“${h(d.display_name||node)}”<button class="linklike" data-supp-action="mismap">这不是我问的问题</button></div>` : '';
    const title=node&&!node.startsWith('q:')?d.display_name||node:q||'新问题（评估中）';
    const errs=errors.get(node)||'';
    document.querySelector('.toolbar').hidden=true;
    document.getElementById('result-count').textContent='';
    const el=document.getElementById('results');
    el.innerHTML=`<article class="supp-node"><header>${mapping}<p class="supp-eyebrow">从问题出发</p><h1>${h(title)}</h1></header>${active(d)?`<div class="supp-summary" aria-label="当前补搜状态"><p>${h(status(d))}</p>${progress(d)}</div>`:''}
      <section class="supp-content" aria-label="现有内容"><h2>${items.length?'已经找到的答案':'先看看已有内容'}</h2>${items.length?`<div class="cards grid">${shown.map(laneCardHtml).join('')}</div>${items.length>shownLimit?'<button class="supp-more">显示更多答案</button>':''}`:`<p class="supp-muted">${!DATA_LOADED?'正在载入已有内容…':'这里还没有经过核验的答案。'}</p>`}</section>
      ${active(d)?`<section class="supp-running" aria-label="补搜进度" aria-live="polite"><p>${h(status(d))}</p>${progress(d)}</section>`:''}
      ${!active(d)&&hasStatus?`<section class="supp-decision" aria-label="补搜结论"><p>${h(status(d))}</p>${r?.close_reason==='all_rejected'&&Array.isArray(r.close_detail)?`<details><summary>为什么没有收录</summary><ul>${r.close_detail.map(x=>`<li>${h(typeof x==='string'?x:x.reason||'未满足收录标准')}</li>`).join('')}</ul></details>`:''}</section>`:''}
      <section class="supp-actions" aria-label="补搜操作"><button class="btn-primary" ${active(d)||busy?'disabled':''} data-supp-action="${items.length?'not_answered':'want_this'}">${busy?'正在提交…':active(d)?'正在补搜':items.length?'这些没回答我的问题':'我要这个'}</button><p class="supp-feedback" role="status">${h(flash||errs||(!node&&current?.q===q&&current?.searching?'正在理解你的问题…':''))}</p>${errs?'<button class="linklike" data-supp-retry>重新读取进度</button>':''}${mismatch?`<form class="supp-rephrase"><label for="supp-rephrase">换一种说法再搜</label><div><input id="supp-rephrase" value="${h(q)}" maxlength="60"><button type="submit">重新搜索</button></div></form>`:''}</section></article>`;
    el.querySelector('.supp-more')?.addEventListener('click',()=>{shownLimit+=6;renderResults();});
    bindLaneCards(el); el.querySelectorAll('[data-supp-action]').forEach(b=>b.addEventListener('click',()=>submit(b.dataset.suppAction,b)));
    el.querySelector('[data-supp-retry]')?.addEventListener('click',()=>{errors.delete(node);void read(node);});
    el.querySelector('form')?.addEventListener('submit',e=>{e.preventDefault();const v=el.querySelector('input').value.trim();document.getElementById('q').value=v;go({q:v,node:null});void search(v);});
    if(editing){const input=el.querySelector('#supp-rephrase');if(input){input.value=editing.value;input.focus({preventScroll:true});input.setSelectionRange(editing.start,editing.end);}}
    else if(focusedAction)el.querySelector(`[data-supp-action="${focusedAction}"]`)?.focus({preventScroll:true});
    return true;
  }
  async function search(q) {
    if(!q) return; const seq=++searchSeq;flash='';mismatch=false;current={q,searching:true};paint();
    try {
      const d=await api('/semantic',{q}); if(seq!==searchSeq||state.q!==q) return;
      const top=d.top?.[0];
      current=top&&top.score>=0.40?{q,node:top.name,display_name:top.name,mapping:top.score>=0.60?'confirmed':'suggested'}:{q};
      if(current.node) void read(current.node);
    }catch(e){if(seq!==searchSeq)return; current={q};flash='归类暂时不可用，你仍可以提出补搜请求。';}
    paint();
  }
  function token() {
    // Internal alpha: CY deferred anti-abuse until wider testing (2026-11-12).
    if(config().internalAlpha === true) return Promise.resolve(null);
    if(verification) return verification;
    verification=new Promise((resolve,reject)=>{
      const fail=()=>finish(null,new Error('验证组件加载失败或验证未通过，请稍后重试'));
      let settled=false, widget=null, host=document.createElement('div'), timeout;
      host.className='supp-verify';host.setAttribute('role','dialog');host.setAttribute('aria-label','安全验证');
      const label=document.createElement('p');label.textContent='正在验证，请稍候';host.append(label);
      const slot=document.createElement('div');host.append(slot);
      const cancel=document.createElement('button');cancel.textContent='取消';host.append(cancel);document.body.append(host);cancel.onclick=fail;
      function finish(value,error){if(settled)return;settled=true;clearTimeout(timeout);if(widget!==null&&window.turnstile)window.turnstile.remove(widget);host.remove();error?reject(error):resolve(value);}
      timeout=setTimeout(fail,20000);
      if(!config().turnstileSiteKey){fail();return;}
      function mount(){if(settled)return;try{widget=window.turnstile.render(slot,{sitekey:config().turnstileSiteKey,callback:t=>finish(t),'error-callback':fail,'expired-callback':fail});}catch(_){fail();}}
      if(window.turnstile)mount();else {
        let script=document.getElementById('supp-turnstile');
        if(script)script.remove();script=document.createElement('script');script.id='supp-turnstile';script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';script.onload=mount;script.onerror=fail;document.head.append(script);
      }
    }).finally(()=>{verification=null;});return verification;
  }
  async function submit(kind,button) {
    if(busy)return;const d=selected();if(kind!=='mismap'&&active(d))return;busy=true;flash='';const q=state.q||d.display_name||d.node;
    const rect=button?.getBoundingClientRect();
    try {
      const turnstile_token=await token();
      let session='';try{session=sessionStorage.getItem('xing.ask.session')||'';}catch(_){}
      const result=await api('/ask',{q,node:d.mapping==='suggested'&&kind!=='mismap'?undefined:d.node,kind,turnstile_token,session});
      if(result.session)try{sessionStorage.setItem('xing.ask.session',result.session);}catch(_){}
      remember(result,d.node);
      if((state.q||state.node)===q||(state.node&&state.node===d.node))current={...result,q};
      if(kind==='mismap'){mismatch=true;flash='已记录。你可以换一种说法重新搜，我们也会复核这次归类';}
      else {
        const old=rows.find(x=>x.node===result.node);rows=rows.filter(x=>x.node!==result.node&&x.q!==q);
        rows.unshift({...old,node:result.node,q,title:result.display_name||q,last_seen_at:new Date().toISOString(),summary:status(result)});rows=rows.slice(0,50);save();refreshList();fly(q,rect);flash='已记入「我问过的」';
      }
      schedule();
    }catch(e){flash=e.message||'提交失败，请稍后重试';}
    finally{busy=false;paint();}
  }
  function openRow(row) {
    if(row.node.startsWith('legacy:')){document.getElementById('q').value=row.q;go({asks:false,mine:false,q:row.q,node:null,topic:null});void search(row.q);return;}
    current={...(snapshots.get(row.node)||{}),node:row.node,q:row.q||'',display_name:row.title};flash='';mismatch=false;row.last_seen_at=new Date().toISOString();save();
    document.getElementById('q').value=row.q||'';go({asks:false,mine:false,q:row.q||'',node:row.q?null:row.node,topic:null});void read(row.node);
  }
  function rowHtml(row,compact=false) {
    const d=snapshots.get(row.node), newer=row.updated_at&&row.updated_at>row.last_seen_at;
    return `<div class="supp-request"><button data-supp-node="${h(row.node)}"><strong>${h(row.q||row.title||row.node)}</strong><span>${newer?'有更新 · ':''}${h(errors.get(row.node)|| (d?status(d):row.summary||'正在读取进度'))}</span>${d?progress(d):''}</button>${compact?'':`<button class="supp-remove" data-supp-remove="${h(row.node)}" aria-label="从本浏览器清单移除">×</button>`}</div>`;
  }
  function bindRows(el) {el.querySelectorAll('[data-supp-node]').forEach(b=>b.onclick=()=>openRow(rows.find(r=>r.node===b.dataset.suppNode)));}
  function refreshList() {
    load();document.body.classList.add('supp-v2');const el=document.getElementById('asks-entry');if(!el)return;
    el.innerHTML=rows.length?`<button class="mine-btn" id="asks-open">我问过的 <span class="mine-n">${rows.length}</span></button><div class="supp-sidebar">${rows.map(r=>rowHtml(r,true)).join('')}</div>`:'';
    el.querySelector('#asks-open')?.addEventListener('click',()=>go({asks:true,mine:false,q:'',node:null,topic:null}));bindRows(el);
    let corner=document.getElementById('supp-corner');if(!corner){corner=document.createElement('button');corner.id='supp-corner';document.body.append(corner);corner.onclick=()=>go({asks:true,mine:false,q:'',node:null,topic:null});}
    corner.hidden=!rows.length;corner.textContent=`我问过的 · ${rows.length}`;
  }
  function renderList() {
    load();const el=document.getElementById('results');document.querySelector('.toolbar').hidden=true;
    el.innerHTML=`<div class="mine-head"><b>我问过的</b><button class="linklike" data-supp-home>回首页</button></div>${rows.length?rows.map(r=>rowHtml(r)).join(''):'<p class="supp-muted">还没有提出过补搜请求。</p>'}<p class="mine-note">仅本浏览器可见，清除浏览数据后会丢失。重新打开网站时会检查进度。${writable?'':' 这个浏览器无法保存清单，关闭页面后会丢失。'}</p>`;
    bindRows(el);el.querySelector('[data-supp-home]').onclick=goHome;
    el.querySelectorAll('[data-supp-remove]').forEach(b=>b.onclick=()=>{rows=rows.filter(r=>r.node!==b.dataset.suppRemove);save();paint();});
  }
  function fly(q,rect) {
    const dest=document.getElementById(matchMedia('(min-width: 900px)').matches?'asks-open':'supp-corner');if(!rect||!dest)return;
    const target=dest.getBoundingClientRect(), chip=document.createElement('div');chip.className='supp-flying';chip.textContent=q;document.body.append(chip);
    chip.style.left=rect.left+'px';chip.style.top=rect.top+'px';
    const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    const a=chip.animate([{opacity:1,transform:'translate(0,0) scale(1)'},{opacity:.3,transform:`translate(${target.left-rect.left}px,${target.top-rect.top}px) scale(.3)`}],{duration:reduced?1:800,easing:'cubic-bezier(.2,.7,.2,1)'});
    a.onfinish=()=>{chip.remove();dest.animate([{transform:'scale(1)'},{transform:'scale(1.15)'},{transform:'scale(1)'}],{duration:reduced?1:300});};
  }
  function schedule() {
    clearTimeout(timer);timer=setTimeout(async()=>{
      if(!document.hidden){const nodes=new Set(rows.map(r=>r.node));if(current?.node)nodes.add(current.node);if(state.node)nodes.add(state.node);await Promise.all([...nodes].map(n=>read(n)));}schedule();
    },5000);
  }
  function resume(){load();rows.forEach(r=>void read(r.node));schedule();}
  function openQuestion(q){load();const row=rows.find(r=>r.q===q);if(row)openRow(row);else void search(q);}
  document.addEventListener('visibilitychange',()=>{if(enabled()&&!document.hidden)resume();});
  window.XingSupplemental={enabled,renderResults,refreshList,renderList,search,resume,openQuestion,status,progress};
})();
