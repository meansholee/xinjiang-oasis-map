/* ============================================================
   西域绿洲 · 时空舆图   app.js
   纯前端 · D3 真实经纬度投影 + Canvas 鎏金手绘底图
   ============================================================ */

const ERA_ORDER = ["西汉","东汉","三国","西晋","东晋","南北朝","隋代","唐代",
                   "五代十国","辽北宋","金南宋","元代","明代","清代","现代"];

// 新疆经纬度真实范围（来自边界数据扫描：经 73.4~96.5，纬 34.3~49.2）
const GEO_BOUNDS = { lng:[73.4, 96.6], lat:[34.2, 49.3] };

let TOWNS = [], RELICS = [];
let GEO_FULL = null, GEO_BORDER = null;
let curEra = 0;
let playing = false, playTimer = null;
let showRelic = true;

const stage   = document.getElementById('stage');
const canvas  = document.getElementById('map');
const ctx     = canvas.getContext('2d');
const svg     = d3.select('#overlay');

let W = 0, H = 0, DPR = Math.min(window.devicePixelRatio || 1, 2);
let projection, geoPath;

/* ---------- 投影：真实经纬度 → 屏幕像素 ----------
   注意：DataV 的省界 GeoJSON 环绕方向不规范，d3.geoBounds 会误判为整个地球，
   导致 fitExtent 把所有点压成一团。故改用「手动平面 Mercator fit」绕过球面判断。 */
function setupProjection(){
  const padX = 54, padTop = 96, padBottom = 118;
  const p = d3.geoMercator().scale(1).translate([0,0]).center([0,0]);
  const corners = [
    [GEO_BOUNDS.lng[0], GEO_BOUNDS.lat[0]],
    [GEO_BOUNDS.lng[1], GEO_BOUNDS.lat[0]],
    [GEO_BOUNDS.lng[1], GEO_BOUNDS.lat[1]],
    [GEO_BOUNDS.lng[0], GEO_BOUNDS.lat[1]]
  ].map(c=>p(c));
  const x0=Math.min(...corners.map(c=>c[0])), x1=Math.max(...corners.map(c=>c[0]));
  const y0=Math.min(...corners.map(c=>c[1])), y1=Math.max(...corners.map(c=>c[1]));
  const availW = W - 2*padX, availH = H - padTop - padBottom;
  const s = Math.min(availW/(x1-x0), availH/(y1-y0));
  const cx=(x0+x1)/2, cy=(y0+y1)/2;
  p.scale(s).translate([ W/2 - s*cx, (padTop + (H-padBottom))/2 - s*cy ]);
  projection = p;
  geoPath = d3.geoPath(projection, ctx);
}
function proj(lng,lat){ return projection([lng,lat]); }

/* ---------- 画布尺寸 ---------- */
function resize(){
  W = stage.clientWidth; H = stage.clientHeight;
  canvas.width = W*DPR; canvas.height = H*DPR;
  canvas.style.width = W+'px'; canvas.style.height = H+'px';
  ctx.setTransform(DPR,0,0,DPR,0,0);
  svg.attr('viewBox',`0 0 ${W} ${H}`);
  setupProjection();
  drawBase();
  renderPoints();
}

/* ============================================================
   底图：基于「真实新疆轮廓」的青绿设色山水
   省界描金 + 地州分区 + 盆地/山脉地形渲染 + 真实塔里木水系
   ============================================================ */

let _seed = 20260618;
function rnd(){ _seed = (_seed*9301+49297)%233280; return _seed/233280; }

// 用 geoPath 把某个 feature 的轮廓描成 Canvas 路径
function tracePath(feature){
  ctx.beginPath();
  geoPath(feature);
}

/* —— 真实塔里木河 / 主要水系（简化经纬度折线）—— */
const RIVERS = [
  // 塔里木河干流（自西向东，沿塔克拉玛干北缘）
  {name:'塔里木河', w:3.4, pts:[[78.3,40.5],[80.3,40.9],[81.3,40.6],[82.0,40.9],[83.6,41.1],[84.8,41.0],[85.5,41.0],[86.1,40.9],[87.0,40.8]]},
  // 和田河（南向北汇入）
  {name:'和田河', w:2, pts:[[79.9,37.1],[80.0,38.2],[80.2,39.3],[80.6,40.4],[81.0,40.9]]},
  // 叶尔羌河
  {name:'叶尔羌河', w:2, pts:[[76.0,38.0],[77.2,38.6],[78.3,39.4],[79.0,40.1],[79.8,40.5]]},
  // 阿克苏河
  {name:'阿克苏河', w:2, pts:[[79.6,41.6],[80.0,41.2],[80.6,40.8],[81.0,40.9]]},
  // 伊犁河（西流）
  {name:'伊犁河', w:2.6, pts:[[84.5,43.6],[83.2,43.8],[81.8,43.9],[80.6,43.9],[80.2,44.0]]},
  // 孔雀河 / 开都河 — 博斯腾湖一带
  {name:'孔雀河', w:1.8, pts:[[86.6,42.0],[86.2,41.7],[85.8,41.5],[85.3,41.2]]}
];

// 博斯腾湖、艾比湖等（简化为多边形点）
const LAKES = [
  {name:'博斯腾湖', cx:87.0, cy:41.95, rx:0.42, ry:0.22},
  {name:'艾比湖',   cx:82.9, cy:44.9,  rx:0.30, ry:0.18},
  {name:'乌伦古湖', cx:87.3, cy:47.25, rx:0.28, ry:0.15}
];

// 山脉脊线（天山、昆仑、阿尔泰）— 用于地形阴影
const RANGES = [
  {name:'阿尔泰山', pts:[[85.8,48.8],[87.5,48.2],[89.5,47.8],[90.8,47.2]], width:34, tone:'#5b7a6a'},
  {name:'天山',     pts:[[78.0,42.2],[80.5,42.6],[83.0,43.2],[85.5,43.4],[88.0,43.3],[90.5,43.1],[93.0,42.6]], width:46, tone:'#4a6b78'},
  {name:'昆仑山',   pts:[[76.5,36.2],[79.0,36.4],[82.0,36.6],[85.0,36.8],[88.0,37.2],[91.0,37.6]], width:40, tone:'#3f5d70'},
  {name:'阿尔金山', pts:[[88.0,38.4],[90.0,38.0],[92.0,37.6],[93.5,37.2]], width:30, tone:'#46606e'}
];

function drawBase(){
  _seed = 20260618;
  ctx.clearRect(0,0,W,H);

  if(!GEO_FULL){ return; }

  // 1) 绢本底色（暗金，作画外背景）
  const bg = ctx.createLinearGradient(0,0,0,H);
  bg.addColorStop(0,'#1c1710');
  bg.addColorStop(1,'#241c12');
  ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);

  // 2) 新疆整体轮廓 → 作为「画纸」剪影（鎏金绢面）
  ctx.save();
  tracePath(GEO_BORDER);
  // 投影外发光（金边晕染）
  ctx.shadowColor='rgba(201,154,74,.55)'; ctx.shadowBlur=26;
  const land = ctx.createLinearGradient(0,0,W,H);
  land.addColorStop(0,'#efdcae');
  land.addColorStop(0.5,'#e7cd92');
  land.addColorStop(1,'#dcbd7a');
  ctx.fillStyle=land; ctx.fill();
  ctx.restore();

  // 3) 用轮廓做裁剪，后续地形只画在新疆境内
  ctx.save();
  tracePath(GEO_BORDER);
  ctx.clip();

  // 3a) 两大盆地（塔里木 / 准噶尔）—— 沙金色洼地
  paintBasin(85.0, 39.2, 7.8, 2.6, '#e9c87f', '#d8a857');   // 塔克拉玛干/塔里木盆地
  paintBasin(86.5, 45.3, 4.2, 1.9, '#e3c98e', '#cdb072');   // 准噶尔盆地

  // 3b) 山脉地形（青绿黛染，带脊线高光）
  RANGES.forEach(drawRange);

  // 3c) 河流（青金石蓝，描金边）
  RIVERS.forEach(drawRiver);
  LAKES.forEach(drawLake);

  // 3d) 宣纸噪点 + 皴擦肌理
  ctx.globalAlpha=1;
  for(let i=0;i<2200;i++){
    const x=rnd()*W, y=rnd()*H, r=rnd()*1.3;
    ctx.fillStyle=`rgba(${rnd()>0.5?'255,248,228':'120,92,48'},${rnd()*0.045})`;
    ctx.beginPath();ctx.arc(x,y,r,0,6.28);ctx.fill();
  }
  ctx.restore();

  // 4) 地州分区界线（淡墨，营造"舆图"分野感）
  ctx.save();
  ctx.lineWidth=0.7; ctx.strokeStyle='rgba(92,67,34,.32)';
  ctx.setLineDash([4,3]);
  GEO_FULL.features.forEach(f=>{ tracePath(f); ctx.stroke(); });
  ctx.restore();

  // 5) 省界描金（双线：粗暗金 + 细亮金）
  ctx.save();
  tracePath(GEO_BORDER);
  ctx.lineWidth=4.5; ctx.strokeStyle='rgba(120,86,40,.9)';
  ctx.lineJoin='round'; ctx.stroke();
  tracePath(GEO_BORDER);
  ctx.lineWidth=1.8; ctx.strokeStyle='#f0d9a0'; ctx.stroke();
  ctx.restore();

  // 6) 四角暗角
  const vig=ctx.createRadialGradient(W/2,H*0.46,H*0.34,W/2,H*0.46,H*0.92);
  vig.addColorStop(0,'rgba(0,0,0,0)');
  vig.addColorStop(1,'rgba(28,18,8,.5)');
  ctx.fillStyle=vig;ctx.fillRect(0,0,W,H);
}

// 盆地：以地理中心向外的径向渐变洼地
function paintBasin(lng,lat,wDeg,hDeg,c1,c2){
  const c=proj(lng,lat);
  const e=proj(lng+wDeg,lat), n=proj(lng,lat+hDeg);
  const rx=Math.abs(e[0]-c[0]), ry=Math.abs(n[1]-c[1]);
  ctx.save();
  ctx.translate(c[0],c[1]); ctx.scale(1, ry/rx);
  const g=ctx.createRadialGradient(0,0,rx*0.1,0,0,rx);
  g.addColorStop(0,c1); g.addColorStop(0.7,c2); g.addColorStop(1,'rgba(216,168,87,0)');
  ctx.fillStyle=g;
  ctx.beginPath(); ctx.arc(0,0,rx,0,6.28); ctx.fill();
  ctx.restore();
}

// 山脉：沿脊线画带状青绿地形 + 雪线高光
function drawRange(r){
  const scr=r.pts.map(p=>proj(p[0],p[1]));
  // 底部阴影带
  ctx.save();
  ctx.lineCap='round'; ctx.lineJoin='round';
  // 外晕
  ctx.strokeStyle=hexA(r.tone,0.28); ctx.lineWidth=r.width;
  strokePoly(scr);
  // 主脊
  ctx.strokeStyle=hexA(r.tone,0.62); ctx.lineWidth=r.width*0.55;
  strokePoly(scr);
  // 脊线高光（雪线）
  ctx.strokeStyle='rgba(240,236,224,.5)'; ctx.lineWidth=r.width*0.16;
  strokePoly(scr);
  ctx.restore();
}
function strokePoly(scr){
  ctx.beginPath();
  scr.forEach((p,i)=>{
    if(i===0) ctx.moveTo(p[0],p[1]);
    else{
      const pr=scr[i-1];
      const mx=(pr[0]+p[0])/2, my=(pr[1]+p[1])/2;
      ctx.quadraticCurveTo(pr[0],pr[1],mx,my);
    }
  });
  ctx.stroke();
}

function drawRiver(r){
  const scr=r.pts.map(p=>proj(p[0],p[1]));
  ctx.save(); ctx.lineCap='round'; ctx.lineJoin='round';
  // 水体
  ctx.strokeStyle='#2f6f8a'; ctx.lineWidth=r.w*1.9; strokePoly(scr);
  ctx.strokeStyle='#3f93ad'; ctx.lineWidth=r.w; strokePoly(scr);
  // 金线高光
  ctx.strokeStyle='rgba(240,217,160,.5)'; ctx.lineWidth=Math.max(0.6,r.w*0.3); strokePoly(scr);
  ctx.restore();
}
function drawLake(l){
  const c=proj(l.cx,l.cy);
  const e=proj(l.cx+l.rx,l.cy), n=proj(l.cx,l.cy+l.ry);
  const rx=Math.abs(e[0]-c[0]), ry=Math.abs(n[1]-c[1]);
  ctx.save();
  ctx.translate(c[0],c[1]);
  const g=ctx.createRadialGradient(0,0,1,0,0,Math.max(rx,ry));
  g.addColorStop(0,'#3f93ad'); g.addColorStop(1,'#2a5f78');
  ctx.fillStyle=g;
  ctx.beginPath(); ctx.ellipse(0,0,rx,ry,0,0,6.28); ctx.fill();
  ctx.strokeStyle='rgba(240,217,160,.6)'; ctx.lineWidth=1.2;
  ctx.beginPath(); ctx.ellipse(0,0,rx,ry,0,0,6.28); ctx.stroke();
  ctx.restore();
}
// hex + alpha 工具
function hexA(hex,a){
  const n=parseInt(hex.slice(1),16);
  return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;
}

/* ============================================================
   城镇点 + 文保点（D3 数据绑定，真实经纬度投影）
   ============================================================ */
function townsOfEra(i){ return TOWNS.filter(t=>t.eraIndex===i); }
function relicsOfEra(i){ return RELICS.filter(r=>r.eraIndex===i); }

function renderPoints(){
  const eraTowns = townsOfEra(curEra);
  const eraRelics = showRelic ? relicsOfEra(curEra) : [];

  // --- 文保点（底层，小蓝点）---
  const rsel = svg.selectAll('g.relic').data(eraRelics, d=>'r'+d.id);
  rsel.exit().transition().duration(300).attr('opacity',0).remove();
  const renter = rsel.enter().append('g').attr('class','relic hit')
    .attr('opacity',0)
    .attr('transform',d=>{const p=proj(d.lng,d.lat);return `translate(${p[0]},${p[1]})`;})
    .on('click',(e,d)=>showCard(d,'relic'));
  renter.append('circle').attr('r',4).attr('fill','#1c3a5e')
    .attr('stroke','#f4e2b8').attr('stroke-width',0.8).attr('opacity',0.85);
  renter.merge(rsel).transition().duration(400)
    .attr('transform',d=>{const p=proj(d.lng,d.lat);return `translate(${p[0]},${p[1]})`;})
    .attr('opacity',1);

  // --- 城镇点（上层，朱砂大点 + 光晕）---
  const tsel = svg.selectAll('g.town').data(eraTowns, d=>'t'+d.id);
  tsel.exit().transition().duration(300).attr('opacity',0)
    .attr('transform',d=>{const p=proj(d.lng,d.lat);return `translate(${p[0]},${p[1]}) scale(0.2)`;})
    .remove();

  const tenter = tsel.enter().append('g').attr('class','town hit')
    .attr('opacity',0)
    .attr('transform',d=>{const p=proj(d.lng,d.lat);return `translate(${p[0]},${p[1]}) scale(0.2)`;})
    .on('click',(e,d)=>showCard(d,'town'))
    .on('mouseenter',function(){d3.select(this).select('.label').attr('opacity',1);})
    .on('mouseleave',function(){d3.select(this).select('.label').attr('opacity',0);});

  // 外光晕
  tenter.append('circle').attr('class','halo').attr('r',13)
    .attr('fill','none').attr('stroke','#b3361f').attr('stroke-width',1.2).attr('opacity',0.5);
  // 主点
  tenter.append('circle').attr('class','core').attr('r',6)
    .attr('fill','#b3361f').attr('stroke','#f4e2b8').attr('stroke-width',1.5);
  // 标签（默认隐藏，hover 显示）
  tenter.append('text').attr('class','label').attr('y',-16).attr('text-anchor','middle')
    .attr('opacity',0).attr('font-size',13).attr('font-weight',700)
    .attr('fill','#2a1c0e').attr('paint-order','stroke')
    .attr('stroke','#f6ead0').attr('stroke-width',3).text(d=>d.name);

  const tmerge = tenter.merge(tsel);
  tmerge.transition().duration(500).delay((d,i)=>i*18)
    .attr('opacity',1)
    .attr('transform',d=>{const p=proj(d.lng,d.lat);return `translate(${p[0]},${p[1]}) scale(1)`;});

  // 光晕呼吸动画
  svg.selectAll('.halo').each(function(){ pulse(d3.select(this)); });
}

function pulse(sel){
  sel.transition().duration(1600).ease(d3.easeSinInOut)
    .attr('r',18).attr('opacity',0.05)
    .transition().duration(1600).ease(d3.easeSinInOut)
    .attr('r',13).attr('opacity',0.5)
    .on('end',function(){ pulse(d3.select(this)); });
}

/* ============================================================
   历史名片（点击交互） + 占位数据
   ============================================================ */
function showCard(d, kind){
  document.getElementById('card').classList.remove('hidden');
  document.getElementById('cardName').textContent = d.name || '（无名）';
  document.getElementById('cardSeal').textContent = (d.name||'城').slice(0,1);
  document.getElementById('cardEra').textContent = d.era + (kind==='relic'?' · 文保单位':' · 城镇治所');
  document.getElementById('cardCoord').textContent =
    `经度 ${d.lng.toFixed(4)}°E   纬度 ${d.lat.toFixed(4)}°N`;

  // 数据条（占位：等真实气候/人口/耕地数据替换）
  const bars = document.getElementById('dataBars');
  if(kind==='town'){
    // 用经纬度做伪随机演示值，待真实数据替换
    const seed = (d.lng*7 + d.lat*13) % 1;
    const pop  = Math.round(20 + ((d.lng*31)%1)*78);
    const farm = Math.round(15 + ((d.lat*47)%1)*80);
    const water= Math.round(25 + ((seed*1000)%1*0+((d.lng*53)%1))*70);
    bars.innerHTML = barRow('人口规模', pop, '〔示例〕') +
                     barRow('耕地垦殖', farm, '〔示例〕') +
                     barRow('水源丰度', water, '〔示例〕');
  } else {
    bars.innerHTML = `<div style="font-size:13px;color:#5c4322;line-height:1.9">
      <div>类型：${d.type||'—'}</div>
      <div>地址：${d.addr||'—'}</div>
      <div>批次：${d.batch||'—'}</div></div>`;
  }

  // 古籍段落（占位）
  const at = document.getElementById('ancientText');
  at.innerHTML = `<p class="placeholder">〔 ${d.name} · ${d.era} 〕<br/>
    此处将载录该地对应年代之史志原文（如《汉书·西域传》《大唐西域记》《西域水道记》等）。
    提供古籍文字数据后，将自动按「城镇名＋年代」匹配填充于此，并以竖排呈现。</p>`;
}
function barRow(label,val,tag){
  return `<div class="bar-row">
    <div class="bar-label"><span>${label} <small style="color:#a08a5e">${tag}</small></span><span>${val}</span></div>
    <div class="bar-track"><div class="bar-fill" style="width:${val}%"></div></div></div>`;
}
document.getElementById('cardClose').onclick =
  ()=>document.getElementById('card').classList.add('hidden');

/* ============================================================
   时间轴
   ============================================================ */
function setEra(i){
  curEra = Math.max(0, Math.min(ERA_ORDER.length-1, i));
  const name = ERA_ORDER[curEra];
  document.getElementById('eraSlider').value = curEra;
  document.getElementById('eraName').textContent = name;
  document.getElementById('eraNameBig').textContent = name;
  const n = townsOfEra(curEra).length;
  document.getElementById('eraCount').textContent = `${n} 城`;
  // tick 高亮
  document.querySelectorAll('.track-ticks span').forEach((s,idx)=>
    s.classList.toggle('active', idx===curEra));
  renderPoints();
  spawnGlyph(name);
}

function buildTicks(){
  const wrap = document.getElementById('trackTicks');
  wrap.innerHTML = '';
  ERA_ORDER.forEach((e,i)=>{
    const s=document.createElement('span');
    s.textContent=e;
    s.onclick=()=>{stopPlay();setEra(i);};
    wrap.appendChild(s);
  });
}

document.getElementById('eraSlider').oninput = e=>{ stopPlay(); setEra(+e.target.value); };

function startPlay(){
  playing=true; document.getElementById('playBtn').textContent='❚❚';
  playTimer=setInterval(()=>{
    let next=curEra+1;
    if(next>=ERA_ORDER.length){ next=0; }
    setEra(next);
  },1800);
}
function stopPlay(){
  playing=false; document.getElementById('playBtn').textContent='▶';
  if(playTimer){clearInterval(playTimer);playTimer=null;}
}
document.getElementById('playBtn').onclick=()=>playing?stopPlay():startPlay();

/* 文字粒子：切换年代时朝代名上浮 */
function spawnGlyph(text){
  const chars=text.split('');
  chars.forEach((ch,i)=>{
    const el=document.createElement('div');
    el.className='float-glyph';el.textContent=ch;
    el.style.left=(W*0.5 + (i-chars.length/2)*26)+'px';
    el.style.top=(H*0.5)+'px';
    el.style.fontSize=(28+Math.random()*10)+'px';
    stage.appendChild(el);
    el.animate([
      {opacity:0,transform:'translateY(0) scale(.8)'},
      {opacity:.85,transform:'translateY(-40px) scale(1.1)',offset:.3},
      {opacity:0,transform:'translateY(-120px) scale(1.3)'}
    ],{duration:1600,easing:'ease-out'});
    setTimeout(()=>el.remove(),1650);
  });
}

document.getElementById('toggleRelic').onchange=e=>{
  showRelic=e.target.checked; renderPoints();
};

/* ============================================================
   启动 —— 读取内嵌数据（data.js），file:// 双击即可运行
   ============================================================ */
(function start(){
  try{
    const td = window.__TOWNS__, rd = window.__RELICS__;
    if(!td || !rd) throw new Error('内嵌数据未加载');
    TOWNS = td.towns;
    RELICS = rd.relics;
    GEO_FULL = window.__GEO_FULL__ || null;
    GEO_BORDER = window.__GEO_BORDER__ || null;
    buildTicks();
    resize();
    setEra(0);
    window.addEventListener('resize', debounce(resize,200));
  }catch(err){
    document.body.innerHTML='<div style="color:#f4e2b8;padding:40px;font-size:16px">'+
      '数据加载失败：'+err.message+'</div>';
  }
})();

function debounce(fn,ms){let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms);};}
