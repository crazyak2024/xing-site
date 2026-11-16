/* Public projection only: no model internals and no invented percent. */
(function(root){
 const names={bilibili:'B站',douyin:'抖音',kuaishou:'快手',wechat_channels:'视频号',channels:'视频号'};
 function view(d,displayedIds=[]){
  const r=d?.run||{}, p=r.progress;
  if(!p)return null;
  const states=Object.values(p.candidates||{}),searches=Object.entries(p.searches||{});
  const count=s=>states.filter(x=>s.includes(x)).length;
  const platformIds=[...new Set(searches.map(([key])=>key.split('\n')[0]))];
  const ready=new Set(Object.entries(p.candidates||{}).filter(([,s])=>s==='ready').map(([id])=>id));
  const shown=displayedIds.filter(id=>ready.has(id)).length;
  const paused=d.service_paused||['waiting_model_capacity','waiting_budget_reconciliation'].includes(r.phase);
  const pauseTitle=d.service_paused?'补搜暂时暂停，问题已保存':r.phase==='waiting_budget_reconciliation'?'处理暂时中断，正在核对任务状态；你的问题已保留':'已保存进度，等待处理额度恢复';
  const running=!paused&&['RUNNING','PENDING','EXPORTING'].includes(r.state);
  const stale=running&&(p.heartbeat_at||p.updated_at)&&Date.now()/1000-(p.heartbeat_at||p.updated_at)>45;
  const activities=[];
  if(running&&!stale){
   const searching=platformIds.filter(id=>searches.some(([key,s])=>key.split('\n')[0]===id&&s==='searching'));
   if(searching.length)activities.push('正在搜索'+searching.map(x=>names[x]||x).join('、'));
   const understanding=count(['understanding']);if(understanding)activities.push('理解内容 '+understanding+' 条');
   const judging=count(['judging','reviewing']);if(judging)activities.push('质量评估 '+judging+' 条');
   const checking=count(['checking','reviewing']);if(checking)activities.push('事实复核 '+checking+' 条');
  }
  if(String(p.strategy_version||'').startsWith('0.3')) {
   const phase={continuing_search:'已有内容可以先看，正在继续筛选其余视频',library:'正在寻找库内已有的答案',sufficiency:'正在确认这些视频能否回答你的问题',searching:'正在其他平台寻找相关视频',quality:'正在筛选值得看的内容',judging:'正在筛选值得看的内容'};
   const end={sufficient:'已找到能回答这个问题的视频',user_satisfied:'已找到答案，本轮搜索结束',time_limit:'这次搜索已结束，已有内容可以先看',budget_limit:'这次搜索已结束，已有内容可以先看',page_limit:'这次搜索已结束，已有内容可以先看',exhausted:'这次搜索已结束，已有内容可以先看'};
   return {title:paused?pauseTitle:r.state==='FAILED'?'搜索遇到问题，已有结果仍可看':r.state==='CLOSED'?(end[r.close_reason]||'这次搜索已结束'):phase[r.phase]||'正在为你寻找答案',
    summary:'',activities:[],stale,paused,running,shown,ready:ready.size,rejected:0,unfinished:0,version:p.strategy_version||''};
  }
  return {title:paused?'补搜已暂停，已有结果仍可看':r.state==='FAILED'?'补搜遇到问题，已有结果仍可看':shown?`已为你展示 ${shown} 条优选视频`:ready.size?`${ready.size} 条已选好，正在准备展示`:r.state==='CLOSED'?'本轮补搜已结束':'正在为你的问题筛选视频',
   summary:`搜索 ${platformIds.length} 个平台 · 找到 ${states.length} 条候选 · 完成 ${count(['ready','rejected','deferred','unavailable'])} 条筛选`,
   activities,stale,paused,running,shown,ready:ready.size,
   rejected:count(['rejected']),unfinished:count(['deferred','unavailable']),version:p.strategy_version||''};
 }
 function render(d,ids=[]){
  const v=view(d,ids);if(!v)return null;
  const h=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return `<p class="supp-value" role="status">${h(v.title)}</p>${v.summary?`<p class="supp-work">${h(v.summary)}</p>`:''}
   ${v.running&&!v.stale?'<div class="supp-progress indeterminate" role="progressbar" aria-label="补搜正在进行"><i></i></div>':''}
   <div class="supp-activities">${v.activities.map(x=>`<span>${h(x)}</span>`).join('')}</div>
   ${v.stale?'<p class="supp-muted">进度更新延迟，已有结果仍可看</p>':''}
   ${d.run?.state==='CLOSED'&&!v.version.startsWith('0.3')?`<p class="supp-muted">${v.rejected} 条未通过筛选 · ${v.unfinished} 条尚未完成核验</p>`:''}`;
 }
 root.XingSearchProgress={view,render};
 if(typeof module!=='undefined')module.exports={view,render};
})(typeof window==='undefined'?globalThis:window);
