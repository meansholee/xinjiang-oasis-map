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
let projection;

// 背景图预加载（file:// 离线可用）
const bgImage = new Image();
bgImage.onload = () => { if(projection){ drawBase(); startBgAnim(); } };
bgImage.src = 'bg2.png';

// 独立背景 canvas（用于流动动画，与主地图分层）
const bgCanvas = document.getElementById('bgCanvas');
const bgCtx    = bgCanvas.getContext('2d');
let bgTick = 0, bgAnimRunning = false;

function resizeBgCanvas(){
  bgCanvas.width  = W * DPR; bgCanvas.height = H * DPR;
  bgCanvas.style.width = W+'px'; bgCanvas.style.height = H+'px';
  bgCtx.setTransform(DPR,0,0,DPR,0,0);
}

function drawBgFrame(){
  bgTick += 0.18; // 极慢漂移速度
  const r  = bgTick * Math.PI / 180;
  const ox = Math.sin(r * 0.55) * 16;   // X轴漂移 ±16px
  const oy = Math.cos(r * 0.38) * 9;    // Y轴漂移 ±9px
  const sc = 1 + Math.sin(r * 0.22) * 0.006; // 呼吸缩放 ±0.6%

  bgCtx.clearRect(0, 0, W, H);
  if(!bgImage.complete || !bgImage.naturalWidth) return;

  bgCtx.save();
  bgCtx.filter = 'blur(4px)';
  bgCtx.translate(W/2 + ox, H/2 + oy);
  bgCtx.scale(sc, sc);
  const m = 20;
  bgCtx.drawImage(bgImage, -W/2 - m, -H/2 - m, W + m*2, H + m*2);
  bgCtx.filter = 'none';
  bgCtx.restore();

  requestAnimationFrame(drawBgFrame);
}

function startBgAnim(){
  if(!bgAnimRunning){ bgAnimRunning = true; drawBgFrame(); }
}

/* ---------- 投影：真实经纬度 → 屏幕像素 ----------
   DataV 省界 GeoJSON 环绕方向不规范（外环顺时针，GeoJSON 标准应为逆时针）。
   1. fitExtent：d3.geoBounds 用球面几何误判为「整个地球减去新疆」→ 改用手动平面 fit
   2. geoPath：d3.geoPath 内置球面反子午线裁剪同样受影响 → tracePath 改用直接投影，绕过裁剪 */
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
}
function proj(lng,lat){ return projection([lng,lat]); }

/* ---------- 画布尺寸 ---------- */
function resize(){
  W = stage.clientWidth; H = stage.clientHeight;
  canvas.width = W*DPR; canvas.height = H*DPR;
  canvas.style.width = W+'px'; canvas.style.height = H+'px';
  ctx.setTransform(DPR,0,0,DPR,0,0);
  resizeBgCanvas();
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

/* 把 GeoJSON feature/geometry 轮廓描成 Canvas 路径（手动投影，绕过 D3 球面裁剪）
   DataV 省界环绕方向不规范：d3.geoPath 的反子午线球面裁剪会把新疆误判为地球补集，
   导致 fill/clip 全部反向。改为直接调用 projection() 逐点投影，绕过该球面判断。 */
function tracePath(feature){
  ctx.beginPath();
  if(!feature) return;
  function traceRing(ring){
    ring.forEach(function(c, i){
      const p = projection([c[0], c[1]]);
      if(!p) return;
      if(i === 0) ctx.moveTo(p[0], p[1]);
      else ctx.lineTo(p[0], p[1]);
    });
    ctx.closePath();
  }
  function traceGeom(geom){
    if(!geom) return;
    if(geom.type === 'Polygon') geom.coordinates.forEach(traceRing);
    else if(geom.type === 'MultiPolygon') geom.coordinates.forEach(function(poly){ poly.forEach(traceRing); });
    else if(geom.type === 'GeometryCollection') geom.geometries.forEach(traceGeom);
  }
  if(feature.type === 'FeatureCollection') feature.features.forEach(function(f){ traceGeom(f.geometry); });
  else if(feature.type === 'Feature') traceGeom(feature.geometry);
  else traceGeom(feature);
}

/* —— 真实塔里木河 / 主要水系 —— */
/* 支流末端坐标精确对齐到干流某点，确保视觉汇流 */
const RIVERS = [
  // 塔里木河干流（自叶尔羌汇口向东至台特玛湖）
  {name:'塔里木河', w:3.4, pts:[
    [79.45,40.52],[79.8,40.6],[80.3,40.9],[80.7,40.72],
    [81.0,40.88],[81.5,40.72],[82.0,40.9],[82.6,40.98],
    [83.2,41.08],[83.6,41.1],[84.2,41.05],[84.8,41.0],
    [85.3,41.05],[85.5,41.0],[86.0,40.9],[86.5,40.82],[87.0,40.78]
  ]},
  // 叶尔羌河 → 汇入干流 [79.45, 40.52]
  {name:'叶尔羌河', w:2.0, pts:[
    [75.8,37.5],[76.5,38.0],[77.0,38.4],[77.6,38.8],
    [78.1,39.3],[78.6,39.8],[79.0,40.15],[79.25,40.4],[79.45,40.52]
  ]},
  // 和田河 → 汇入干流 [81.0, 40.88]
  {name:'和田河', w:1.9, pts:[
    [79.9,36.8],[80.0,37.5],[80.1,38.1],[80.2,38.9],
    [80.35,39.6],[80.55,40.2],[80.75,40.58],[80.9,40.76],[81.0,40.88]
  ]},
  // 阿克苏河 → 汇入干流 [81.0, 40.88]
  {name:'阿克苏河', w:1.8, pts:[
    [78.8,41.9],[79.3,41.6],[79.8,41.4],[80.2,41.2],
    [80.5,41.05],[80.75,40.95],[81.0,40.88]
  ]},
  // 伊犁河（东起伊宁，西流出境）
  {name:'伊犁河', w:2.6, pts:[
    [85.5,43.2],[84.5,43.6],[83.5,43.78],[82.4,43.88],
    [81.3,43.92],[80.4,43.95],[79.7,44.05],[79.1,44.18]
  ]},
  // 开都河 → 博斯腾湖 → 孔雀河（东流）
  {name:'孔雀河', w:1.8, pts:[
    [83.8,42.5],[84.4,42.28],[85.1,42.0],[85.7,41.72],
    [86.2,41.52],[86.55,41.25],[86.85,41.0]
  ]},
  // 额尔齐斯河（阿尔泰山北麓，西北出境）
  {name:'额尔齐斯河', w:2.1, pts:[
    [90.0,47.6],[89.2,47.72],[88.5,47.8],[87.8,47.72],
    [87.0,47.55],[86.2,47.32],[85.4,47.1],[84.6,47.0]
  ]}
];

// 主要湖泊
const LAKES = [
  {name:'博斯腾湖', cx:87.0,  cy:41.95, rx:0.44, ry:0.23},
  {name:'艾比湖',   cx:82.9,  cy:44.9,  rx:0.30, ry:0.18},
  {name:'乌伦古湖', cx:87.3,  cy:47.25, rx:0.28, ry:0.15},
  {name:'赛里木湖', cx:81.22, cy:44.58, rx:0.15, ry:0.11}
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

  // 0) 底图由 bgCanvas 动画层承载，主 canvas 透明背景
  // 颗粒噪点叠在主 canvas 上（位于底图与地图之间）
  for(let i=0;i<6000;i++){
    const x=rnd()*W, y=rnd()*H;
    const sz=rnd()*rnd()*1.6;
    const br=rnd();
    if(br>0.80)      ctx.fillStyle=`rgba(255,255,255,${rnd()*0.04})`;
    else if(br<0.10) ctx.fillStyle=`rgba(60,50,40,${rnd()*0.03})`;
    else             ctx.fillStyle=`rgba(220,215,205,${rnd()*0.02})`;
    ctx.beginPath(); ctx.arc(x,y,sz,0,6.28); ctx.fill();
  }

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

/* ---------- Catmull-Rom 三次样条（平滑折线） ----------
   替代原 strokePoly：控制点由相邻点推导，曲线精确经过每个顶点，终点不截断 */
function strokeSpline(pts){
  if(!pts || pts.length < 2) return;
  const n = pts.length;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for(let i = 0; i < n - 1; i++){
    const p0 = pts[Math.max(i-1,0)];
    const p1 = pts[i];
    const p2 = pts[i+1];
    const p3 = pts[Math.min(i+2,n-1)];
    ctx.bezierCurveTo(
      p1[0]+(p2[0]-p0[0])/6, p1[1]+(p2[1]-p0[1])/6,
      p2[0]-(p3[0]-p1[0])/6, p2[1]-(p3[1]-p1[1])/6,
      p2[0], p2[1]
    );
  }
  ctx.stroke();
}
const strokePoly = strokeSpline; // 向后兼容

/* ---------- 山脉：舆图三角山峰图标风格 ----------
   沿脊线均匀布置三角形山头（带后景小峰 + 阴影侧面），
   取代原来的粗 stroke 画管效果 */
function drawRange(r){
  const scr=r.pts.map(p=>proj(p[0],p[1]));
  ctx.save();

  // 计算路径总长以均匀布峰
  let totalLen=0;
  const segLens=[];
  for(let i=1;i<scr.length;i++){
    const dx=scr[i][0]-scr[i-1][0], dy=scr[i][1]-scr[i-1][1];
    const l=Math.sqrt(dx*dx+dy*dy);
    segLens.push(l); totalLen+=l;
  }

  const baseH=r.width*0.42;
  const numPeaks=Math.max(6, Math.floor(totalLen/(baseH*1.05)));

  for(let pi=0;pi<=numPeaks;pi++){
    const target=(pi/numPeaks)*totalLen;
    let traveled=0, cx=scr[0][0], cy=scr[0][1];
    for(let i=1;i<scr.length;i++){
      if(traveled+segLens[i-1]>=target||i===scr.length-1){
        const t=segLens[i-1]>0?Math.min(1,(target-traveled)/segLens[i-1]):0;
        cx=scr[i-1][0]+(scr[i][0]-scr[i-1][0])*t;
        cy=scr[i-1][1]+(scr[i][1]-scr[i-1][1])*t;
        break;
      }
      traveled+=segLens[i-1];
    }

    // 随机抖动（确定性 rnd 保持帧一致）
    const jx=(rnd()-0.5)*baseH*0.55;
    const jy=(rnd()-0.5)*baseH*0.22;
    const h =baseH*(0.70+rnd()*0.62);
    const w =h*(0.54+rnd()*0.18);

    ctx.save();
    ctx.translate(cx+jx, cy+jy);

    // 后景小峰（错落层次）
    if(rnd()>0.36){
      const sh=h*(0.46+rnd()*0.34), sw=sh*0.56;
      const sox=(rnd()>0.5?1:-1)*w*(0.44+rnd()*0.44);
      ctx.beginPath();
      ctx.moveTo(sox,-sh); ctx.lineTo(sox-sw/2,0); ctx.lineTo(sox+sw/2,0);
      ctx.closePath();
      ctx.fillStyle=hexA(r.tone, 0.20+rnd()*0.12);
      ctx.fill();
    }

    // 主峰体（线性渐变：雪顶→山色→山脚）
    ctx.beginPath();
    ctx.moveTo(0,-h); ctx.lineTo(-w/2,0); ctx.lineTo(w/2,0);
    ctx.closePath();
    const pg=ctx.createLinearGradient(0,-h,0,0);
    pg.addColorStop(0,'rgba(230,234,220,0.84)');
    pg.addColorStop(0.26,hexA(r.tone,0.78));
    pg.addColorStop(1,hexA(r.tone,0.38));
    ctx.fillStyle=pg;
    ctx.fill();

    // 右坡阴影（立体感）
    ctx.beginPath();
    ctx.moveTo(0,-h); ctx.lineTo(w*0.06,-h*0.36); ctx.lineTo(w/2,0);
    ctx.closePath();
    ctx.fillStyle='rgba(0,0,0,0.16)';
    ctx.fill();

    ctx.restore();
  }

  ctx.restore();
}

/* ---------- 河流：三层精细叠渲（细腻不臃肿）---------- */
function drawRiver(r){
  const scr=r.pts.map(p=>proj(p[0],p[1]));
  ctx.save();
  ctx.lineCap='round'; ctx.lineJoin='round';

  // 环境晕（窄，仅作氛围）
  ctx.globalAlpha=0.13;
  ctx.strokeStyle='#90ddf0'; ctx.lineWidth=r.w*4.5;
  strokeSpline(scr);

  // 水体主色（青绿，近传统矿物色）
  ctx.globalAlpha=0.86;
  ctx.strokeStyle='#2e8fa6'; ctx.lineWidth=r.w*1.6;
  strokeSpline(scr);

  // 高光芯线
  ctx.globalAlpha=0.52;
  ctx.strokeStyle='#84d4e5'; ctx.lineWidth=r.w*0.32;
  strokeSpline(scr);

  ctx.globalAlpha=1;
  ctx.restore();
}

/* ---------- 湖泊：深浅渐变 + 同心水波 + 顶光光斑 ---------- */
function drawLake(l){
  const c=proj(l.cx,l.cy);
  const e=proj(l.cx+l.rx,l.cy), n=proj(l.cx,l.cy+l.ry);
  const rx=Math.abs(e[0]-c[0]), ry=Math.abs(n[1]-c[1]);
  const rm=Math.max(rx,ry);
  ctx.save();
  ctx.translate(c[0],c[1]);

  // 环境光晕
  const glow=ctx.createRadialGradient(0,0,0,0,0,rm*2.2);
  glow.addColorStop(0,'rgba(79,178,206,.20)');
  glow.addColorStop(1,'rgba(79,178,206,0)');
  ctx.fillStyle=glow;
  ctx.beginPath(); ctx.ellipse(0,0,rm*2.2,rm*1.4,0,0,6.28); ctx.fill();

  // 主水体（深浅径向渐变，高光偏左上）
  const g=ctx.createRadialGradient(-rx*.22,-ry*.28,0,0,0,rm);
  g.addColorStop(0,'#62cce0');
  g.addColorStop(0.4,'#3b98b8');
  g.addColorStop(1,'#1d5e78');
  ctx.fillStyle=g;
  ctx.beginPath(); ctx.ellipse(0,0,rx,ry,0,0,6.28); ctx.fill();

  // 同心水波纹
  for(let i=1;i<=4;i++){
    const t=i/5;
    ctx.strokeStyle=`rgba(195,238,250,${0.18-t*0.03})`;
    ctx.lineWidth=0.75;
    ctx.beginPath();
    ctx.ellipse(0,0,rx*t*.88,ry*t*.88,0,0,6.28);
    ctx.stroke();
  }

  // 鎏金边
  ctx.strokeStyle='rgba(240,217,160,.72)'; ctx.lineWidth=1.4;
  ctx.beginPath(); ctx.ellipse(0,0,rx,ry,0,0,6.28); ctx.stroke();

  // 左上顶光光斑
  const glint=ctx.createRadialGradient(-rx*.30,-ry*.30,0,-rx*.30,-ry*.30,rm*.48);
  glint.addColorStop(0,'rgba(255,255,255,.32)');
  glint.addColorStop(1,'rgba(255,255,255,0)');
  ctx.fillStyle=glint;
  ctx.beginPath();
  ctx.ellipse(-rx*.30,-ry*.30,rx*.48,ry*.48,0,0,6.28);
  ctx.fill();

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

  const bars = document.getElementById('dataBars');
  const at   = document.getElementById('ancientText');
  const sec1 = document.getElementById('cardSec1');
  const sec2 = document.getElementById('cardSec2');

  if(kind === 'town'){
    sec1.textContent = '舆地数据';
    sec2.textContent = '古籍载录';
    // 查询古籍文本 —— 先精确匹配，再尝试去尾字规范化
    const texts = window.__TOWN_TEXTS__;
    let textData = null;
    if(texts){
      const exactKey = d.era + '|' + d.name;
      textData = texts[exactKey] || null;
      if(!textData){
        const stripped = d.name.replace(/[国城郡部]$/, '');
        if(stripped !== d.name){
          textData = texts[d.era + '|' + stripped] || null;
        }
      }
    }

    if(textData){
      // 数据条区域：人口 + 景观产业 以行文格式展示
      let barsHtml = '';
      if(textData.population){
        barsHtml += `<div class="info-row"><span class="info-label">人口</span><span class="info-val">${textData.population}</span></div>`;
      }
      if(textData.products){
        barsHtml += `<div class="info-row"><span class="info-label">产业</span><span class="info-val">${textData.products}</span></div>`;
      }
      if(!barsHtml){
        barsHtml = '<p class="placeholder">〔暂无人口与产业记载〕</p>';
      }
      bars.innerHTML = barsHtml;

      // 古籍载录区域：来源书目 + 地理描述
      const srcTitles = (textData.sources || []).join('　');
      const geoText   = textData.geo || '';
      let atHtml = '';
      if(srcTitles){
        atHtml += `<div class="source-title">${srcTitles}</div>`;
      }
      if(geoText){
        atHtml += `<p class="ancient-passage">${geoText}</p>`;
      } else {
        atHtml += '<p class="placeholder">〔该书目暂无地理描述〕</p>';
      }
      at.innerHTML = atHtml;

    } else {
      // 无匹配文本
      bars.innerHTML = '<p class="placeholder">〔暂无载录〕</p>';
      if(d.era === '现代'){
        at.innerHTML = '<p class="placeholder">〔现代城市〕此为现代地名标注，暂无对应古籍载录。</p>';
      } else {
        at.innerHTML = '<p class="placeholder">〔暂无载录〕此地名暂未在已录入的古籍中找到对应条目。</p>';
      }
    }

  } else {
    // 文保单位：完整属性表
    sec1.textContent = '文保信息';
    sec2.textContent = '普查说明';
    function infoRow(label, val){
      if(!val && val !== 0) return '';
      return `<div class="info-row"><span class="info-label">${label}</span><span class="info-val">${val}</span></div>`;
    }
    bars.innerHTML =
      infoRow('文物类型', d.type   || '—') +
      infoRow('保护批次', d.batch  || '—') +
      infoRow('所在城市', d.city   || '—') +
      infoRow('所在区县', d.county || '—') +
      infoRow('详细地址', d.addr   || '—') +
      (d.remark ? infoRow('备注', d.remark) : '');

    at.innerHTML = '<p style="font-size:13px;color:#7a6342;line-height:1.8;font-style:italic;">文物保护单位不附古籍载录。详情请参阅新疆文物局历次普查公布文件。</p>';
  }
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
