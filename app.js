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
let prevEra = -1;                 // 上一显示朝代（用于判断"前进"以触发消亡闪灭）
let playing = false, playTimer = null;
let showTown = true;
let showRelic = true;
let showGhost = true;             // 幽灵图层：已消亡绿洲的灰色残影
let searchHL = null;              // 搜索高亮的城镇 id（其余点位灰显）

/* 绿洲生命谱：按"名称"聚合，记录每个绿洲存续的朝代区间。
   同名城邦在多个朝代出现 → 视为同一绿洲的延续；其"最后出现朝代"之后即视为消亡。 */
let OASIS_LIFE = {};              // name -> { eras:[升序朝代下标], byEra:{ idx:town } }
function buildOasisLife(){
  OASIS_LIFE = {};
  TOWNS.forEach(t=>{
    let o = OASIS_LIFE[t.name];
    if(!o){ o = OASIS_LIFE[t.name] = { eras:[], byEra:{} }; }
    if(!(t.eraIndex in o.byEra)){ o.byEra[t.eraIndex] = t; o.eras.push(t.eraIndex); }
  });
  Object.keys(OASIS_LIFE).forEach(k=>OASIS_LIFE[k].eras.sort((a,b)=>a-b));
}

const stage   = document.getElementById('stage');
const canvas  = document.getElementById('map');
const ctx     = canvas.getContext('2d');
const svg     = d3.select('#overlay');

let W = 0, H = 0, DPR = Math.min(window.devicePixelRatio || 1, 2);
let projection;

/* 无障碍：尊重系统「减少动态效果」偏好 —— 停掉氛围性无限动画（背景漂移、光晕呼吸）*/
const REDUCE_MOTION = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

// 背景图预加载（file:// 离线可用）
const bgImage = new Image();
bgImage.onload = () => { if(projection){ drawBase(); startBgAnim(); } };
bgImage.src = 'art/bg2.png';

/* 手绘地形素材（按海拔/类型选用）+ 纸纹底图 —— 加载后重绘底图 */
const TERRAIN = {};
const TERRAIN_SRC = {
  low:  'art/小山_中式手绘.png',   // 低海拔山脉
  high: 'art/高山_中式手绘.png',   // 高海拔山脉
  snow: 'art/雪山_中式手绘.png',   // 常年积雪山脉
  river:'art/河流_中式手绘.png',   // 河流
  lake: 'art/湖泊_中式手绘.png',   // 湖泊
  paper:'art/底纹.jpg',            // 新疆境内底纹
  map:  'art/map.png'              // 成品地形底图
};
Object.keys(TERRAIN_SRC).forEach(k=>{
  const im = new Image();
  im.onload = () => { if(projection) drawBase(); };
  im.src = TERRAIN_SRC[k];
  TERRAIN[k] = im;
});
function imgReady(im){ return im && im.complete && im.naturalWidth > 0; }

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
  if(REDUCE_MOTION){ drawBgStatic(); return; }   // 减少动态：仅绘一帧静态背景
  if(!bgAnimRunning){ bgAnimRunning = true; drawBgFrame(); }
}
/* 静态背景帧（无漂移/呼吸），供「减少动态效果」偏好使用 */
function drawBgStatic(){
  bgCtx.clearRect(0, 0, W, H);
  if(!bgImage.complete || !bgImage.naturalWidth) return;
  bgCtx.save();
  bgCtx.filter = 'blur(4px)';
  const m = 20;
  bgCtx.drawImage(bgImage, -m, -m, W + m*2, H + m*2);
  bgCtx.filter = 'none';
  bgCtx.restore();
}

/* ---------- 投影：真实经纬度 → 屏幕像素 ----------
   DataV 省界 GeoJSON 环绕方向不规范（外环顺时针，GeoJSON 标准应为逆时针）。
   1. fitExtent：d3.geoBounds 用球面几何误判为「整个地球减去新疆」→ 改用手动平面 fit
   2. geoPath：d3.geoPath 内置球面反子午线裁剪同样受影响 → tracePath 改用直接投影，绕过裁剪 */
function setupProjection(){
  const padX = 54, padTop = 72, padBottom = 118;  // 上边距留出顶部菜单栏(46px)；下边距避让时间轴
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
/* 每经度对应的屏幕像素（用于按地理尺度缩放手绘素材，随缩放/窗口自适应）*/
function pxPerDeg(){ const a=proj(82,42), b=proj(83,42); return Math.abs(b[0]-a[0]); }
/* 以 cover 方式把图片铺满目标矩形（保持纵横比，居中裁切）*/
function drawImageCover(img,dx,dy,dw,dh){
  const ir=img.naturalWidth/img.naturalHeight, dr=dw/dh;
  let sw,sh,sx,sy;
  if(ir>dr){ sh=img.naturalHeight; sw=sh*dr; sx=(img.naturalWidth-sw)/2; sy=0; }
  else     { sw=img.naturalWidth;  sh=sw/dr; sx=0; sy=(img.naturalHeight-sh)/2; }
  ctx.drawImage(img,sx,sy,sw,sh,dx,dy,dw,dh);
}

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
  syncZoomExtent();
}

/* ---------- 地图模块：滚轮缩放 + 左键拖动平移（仅 #mapPan，UI 固定）---------- */
let zoomBehavior = null;
function setupZoom(){
  const mapPan = document.getElementById('mapPan');
  if(!mapPan || zoomBehavior) return;
  zoomBehavior = d3.zoom()
    .scaleExtent([1, 6])
    .translateExtent([[0,0],[W,H]])
    // 滚轮始终缩放；拖拽平移仅从非要素(空白地图)处开始，避免与城镇点点击冲突
    .filter(ev => ev.type==='wheel' || (!ev.button && !(ev.target.closest && ev.target.closest('.hit'))))
    .on('zoom', ev=>{
      const t = ev.transform;
      mapPan.style.transform = `translate(${t.x}px,${t.y}px) scale(${t.k})`;
    })
    .on('start', ()=> mapPan.classList.add('grabbing'))
    .on('end',   ()=> mapPan.classList.remove('grabbing'));
  d3.select(mapPan).call(zoomBehavior);
  // 与地图的任何交互（平移/点击空白/点击点位）都算「下一步操作」→ 清除搜索高亮
  mapPan.addEventListener('pointerdown', clearSearchHighlight);
}

/* ---------- 搜索高亮：灰显其余点位、突出选中点（变红 + 脉冲）---------- */
function applySearchHighlight(town){
  if(!town) return;
  setEra(town.eraIndex);                 // 切到该城所属朝代（点位按朝代渲染）
  if(svg.empty()) return;
  svg.classed('search-mode', true);
  const hit = svg.selectAll('g.town').filter(d => d && d.id === town.id);
  if(hit.empty()){ svg.classed('search-mode', false); return; }
  hit.classed('search-hit', true).raise();
  hit.select('.label').attr('opacity', 1);
  hit.append('circle').attr('class','search-pulse').attr('r', 10);
  searchHL = town.id;
}
function clearSearchHighlight(){
  if(searchHL == null) return;
  searchHL = null;
  svg.classed('search-mode', false);
  svg.selectAll('g.town.search-hit').classed('search-hit', false)
     .select('.label').attr('opacity', 0);
  svg.selectAll('circle.search-pulse').remove();
}
function syncZoomExtent(){
  if(!zoomBehavior) return;
  const mapPan = document.getElementById('mapPan');
  zoomBehavior.translateExtent([[0,0],[W,H]]);
  // 尺寸变化后重置变换，保证与重绘后的底图对齐
  d3.select(mapPan).call(zoomBehavior.transform, d3.zoomIdentity);
  mapPan.style.transform = '';
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

// 山脉脊线（天山、昆仑、阿尔泰、阿尔金）
//   elev：代表海拔(0~1)，决定选用 小山/高山/雪山 素材与尺寸
//   arid：干旱少雪山脉（如阿尔金山）不使用雪山素材
const RANGES = [
  {name:'阿尔泰山', elev:0.62, arid:false, pts:[[85.8,48.8],[87.5,48.2],[89.5,47.8],[90.8,47.2]]},
  {name:'天山',     elev:0.86, arid:false, pts:[[78.0,42.2],[80.5,42.6],[83.0,43.2],[85.5,43.4],[88.0,43.3],[90.5,43.1],[93.0,42.6]]},
  {name:'昆仑山',   elev:0.93, arid:false, pts:[[76.5,36.2],[79.0,36.4],[82.0,36.6],[85.0,36.8],[88.0,37.2],[91.0,37.6]]},
  {name:'阿尔金山', elev:0.66, arid:true,  pts:[[88.0,38.4],[90.0,38.0],[92.0,37.6],[93.5,37.2]]}
];

/* map.png 的纯白剪影（取其 alpha 轮廓），用于生成贴合的白边/外发光 —— 仅构建一次缓存 */
let _mapWhite = null;
function getMapWhite(){
  if(_mapWhite) return _mapWhite;
  const im = TERRAIN.map;
  if(!imgReady(im)) return null;
  const cv = document.createElement('canvas');
  cv.width = im.naturalWidth; cv.height = im.naturalHeight;
  const c2 = cv.getContext('2d');
  c2.drawImage(im, 0, 0);
  c2.globalCompositeOperation = 'source-in';   // 仅保留不透明区域
  c2.fillStyle = '#fff';
  c2.fillRect(0, 0, cv.width, cv.height);
  _mapWhite = cv;
  return _mapWhite;
}

function drawBase(){
  _seed = 20260618;
  ctx.clearRect(0,0,W,H);
  if(!GEO_FULL){ return; }
  if(!imgReady(TERRAIN.map)) return;

  const tl = proj(GEO_BOUNDS.lng[0], GEO_BOUNDS.lat[1]); // 左上：最西、最北
  const br = proj(GEO_BOUNDS.lng[1], GEO_BOUNDS.lat[0]); // 右下：最东、最南
  const x=tl[0], y=tl[1], w=br[0]-tl[0], h=br[1]-tl[1];

  const white = getMapWhite();
  if(white){
    const pad = 3;  // 白边宽度（屏幕像素）
    ctx.save();
    // 白色外发光（羽化光晕）：白剪影 + 白阴影，两遍叠加；与 map.png 同一 alpha 轮廓，必然贴合
    ctx.shadowColor = 'rgba(255,255,255,0.62)';
    ctx.shadowBlur  = 36;
    ctx.drawImage(white, x-pad, y-pad, w+pad*2, h+pad*2);
    ctx.shadowBlur  = 15;
    ctx.drawImage(white, x-pad, y-pad, w+pad*2, h+pad*2);
    ctx.restore();
  }

  // 成品地形底图（盖住白剪影内部，仅在边缘留出 pad 宽白边 + 外侧羽化光晕）
  ctx.drawImage(TERRAIN.map, x, y, w, h);
}

// 盆地：以地理中心向外的径向渐变洼地（旧版，保留备用）
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

// 低地设色：地理椭圆范围内由中心(深褐)向外渐隐，压暗成洼地
function paintLow(lng,lat,wDeg,hDeg,color){
  const c=proj(lng,lat);
  const e=proj(lng+wDeg,lat), n=proj(lng,lat+hDeg);
  const rx=Math.abs(e[0]-c[0]), ry=Math.abs(n[1]-c[1]);
  if(rx<1) return;
  ctx.save();
  ctx.translate(c[0],c[1]); ctx.scale(1, ry/rx);
  const g=ctx.createRadialGradient(0,0,0,0,0,rx);
  g.addColorStop(0,    color);
  g.addColorStop(0.55, hexA(color,0.6));
  g.addColorStop(1,    hexA(color,0));
  ctx.fillStyle=g;
  ctx.beginPath(); ctx.arc(0,0,rx,0,6.28); ctx.fill();
  ctx.restore();
}

// 高地设色：沿山脊线叠加柔光圆斑提亮（亮度/范围随海拔 elev），与手绘山峦衔接
function paintHigh(r){
  const scr=r.pts.map(p=>proj(p[0],p[1]));
  let total=0; const segs=[];
  for(let i=1;i<scr.length;i++){ const l=Math.hypot(scr[i][0]-scr[i-1][0],scr[i][1]-scr[i-1][1]); segs.push(l); total+=l; }
  if(total<1) return;
  const R     = pxPerDeg()*(0.85 + r.elev*1.5);   // 海拔越高，提亮范围越大
  const step  = R*0.42;
  const n     = Math.max(2, Math.round(total/step));
  const tone  = r.arid ? '226,212,158' : '240,236,212'; // 干旱山脉偏黄，常雪山脉偏米白
  const aPeak = 0.28 + r.elev*0.5;                 // 海拔越高越亮
  for(let k=0;k<=n;k++){
    const target=(k/n)*total;
    let trav=0, idx=1;
    for(; idx<scr.length; idx++){ if(trav+segs[idx-1]>=target || idx===scr.length-1) break; trav+=segs[idx-1]; }
    const t=segs[idx-1]>0?Math.min(1,(target-trav)/segs[idx-1]):0;
    const x=scr[idx-1][0]+(scr[idx][0]-scr[idx-1][0])*t;
    const y=scr[idx-1][1]+(scr[idx][1]-scr[idx-1][1])*t;
    const g=ctx.createRadialGradient(x,y,0,x,y,R);
    g.addColorStop(0,   `rgba(${tone},${aPeak})`);
    g.addColorStop(0.5, `rgba(${tone},${aPeak*0.42})`);
    g.addColorStop(1,   `rgba(${tone},0)`);
    ctx.fillStyle=g;
    ctx.beginPath(); ctx.arc(x,y,R,0,6.28); ctx.fill();
  }
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

/* ---------- 山脉：沿脊线堆叠手绘山峦素材 ----------
   遍历脊线坐标 → Projection 取平面位置 → 依海拔(elev)选用
   小山/高山/雪山素材，按经纬尺度(pxPerDeg)与海拔自动缩放，
   重叠堆叠形成连绵山体；缺素材时回退到三角山峰矢量绘制。 */
function tierFor(e, arid){
  if(!arid && e >= 0.74) return 'snow';
  if(e >= 0.46) return 'high';
  return 'low';
}
function drawRange(r){
  const scr = r.pts.map(p=>proj(p[0],p[1]));
  // 脊线分段长度
  let totalLen = 0; const segLens = [];
  for(let i=1;i<scr.length;i++){
    const l = Math.hypot(scr[i][0]-scr[i-1][0], scr[i][1]-scr[i-1][1]);
    segLens.push(l); totalLen += l;
  }
  if(totalLen < 1) return;

  const ppd   = pxPerDeg();
  const baseW = ppd * (1.45 + r.elev*1.35);   // 海拔越高山体越大
  const step  = baseW * 0.46;                  // 步距 < 山体宽 → 重叠堆叠
  const count = Math.max(3, Math.round(totalLen/step));

  // 采样脊线站点 + 每点的素材/尺寸（确定性随机，重绘稳定）
  const stamps = [];
  for(let pi=0; pi<=count; pi++){
    const target = (pi/count) * totalLen;
    let traveled=0, cx=scr[0][0], cy=scr[0][1];
    for(let i=1;i<scr.length;i++){
      if(traveled+segLens[i-1] >= target || i===scr.length-1){
        const t = segLens[i-1]>0 ? Math.min(1,(target-traveled)/segLens[i-1]) : 0;
        cx = scr[i-1][0] + (scr[i][0]-scr[i-1][0])*t;
        cy = scr[i-1][1] + (scr[i][1]-scr[i-1][1])*t;
        break;
      }
      traveled += segLens[i-1];
    }
    const e     = Math.max(0, Math.min(1, r.elev + (rnd()-0.5)*0.26));
    const tier  = tierFor(e, r.arid);
    const sizeF = 0.80 + e*0.46 + (rnd()-0.5)*0.16;
    const w     = baseW * sizeF;
    const jx    = (rnd()-0.5) * baseW * 0.20;
    const jy    = (rnd()-0.5) * baseW * 0.10;
    const flip  = rnd() > 0.5;
    const alpha = 0.9 + rnd()*0.1;
    stamps.push({x:cx+jx, y:cy+jy, w, tier, flip, alpha});
  }

  // 由远及近（y 小者偏远先画）形成自然遮挡层次
  stamps.sort((a,b)=>a.y - b.y);

  const anchorY = 0.78;  // 素材中山体基线约在 78% 高度 → 落在脊线上
  ctx.save();
  stamps.forEach(s=>{
    const im = TERRAIN[s.tier];
    if(!imgReady(im)){ drawPeakVector(s); return; }   // 素材未就绪时回退
    const ar = im.naturalHeight / im.naturalWidth;
    const w = s.w, h = w*ar;
    ctx.save();
    ctx.globalAlpha = s.alpha;
    ctx.translate(s.x, s.y);
    if(s.flip) ctx.scale(-1,1);
    ctx.drawImage(im, -w/2, -h*anchorY, w, h);
    ctx.restore();
  });
  ctx.restore();
}
/* 素材未加载时的临时三角山峰（保证不空白）*/
function drawPeakVector(s){
  const h = s.w*0.5, w = s.w*0.4;
  ctx.save();
  ctx.translate(s.x, s.y); ctx.globalAlpha = s.alpha*0.6;
  ctx.beginPath(); ctx.moveTo(0,-h); ctx.lineTo(-w/2,0); ctx.lineTo(w/2,0); ctx.closePath();
  const pg = ctx.createLinearGradient(0,-h,0,0);
  pg.addColorStop(0,'rgba(230,234,220,0.7)');
  pg.addColorStop(1,'rgba(74,107,120,0.4)');
  ctx.fillStyle = pg; ctx.fill();
  ctx.restore();
}

/* ---------- 河流：手绘素材沿真实河道作"笔刷"铺设 ----------
   取素材中心一段青绿描金纹理，沿脊/河线分段旋转贴合切向、重叠铺成连续河带。
   素材未就绪时回退到矢量三层叠渲。 */
function drawRiver(r){
  const scr = r.pts.map(p=>proj(p[0],p[1]));
  const im = TERRAIN.river;
  if(!imgReady(im)){ drawRiverVector(r, scr); return; }

  // 河宽（像素）；中心裁切避开素材四角透明区
  const halfW = r.w * 3.2;
  const sx=im.naturalWidth*0.30, sy=im.naturalHeight*0.26,
        sw=im.naturalWidth*0.40, sh=im.naturalHeight*0.46;

  let totalLen=0; const segLens=[];
  for(let i=1;i<scr.length;i++){ const l=Math.hypot(scr[i][0]-scr[i-1][0],scr[i][1]-scr[i-1][1]); segLens.push(l); totalLen+=l; }
  if(totalLen<1) return;

  const stampLen = halfW * 3.4;       // 每段笔刷长度
  const step     = stampLen * 0.42;   // 重叠步距
  const n        = Math.max(2, Math.round(totalLen/step));

  ctx.save();
  ctx.globalAlpha = 0.92;
  for(let k=0;k<=n;k++){
    const target=(k/n)*totalLen;
    let traveled=0, idx=1;
    for(; idx<scr.length; idx++){ if(traveled+segLens[idx-1]>=target || idx===scr.length-1) break; traveled+=segLens[idx-1]; }
    const t = segLens[idx-1]>0 ? Math.min(1,(target-traveled)/segLens[idx-1]) : 0;
    const x = scr[idx-1][0] + (scr[idx][0]-scr[idx-1][0])*t;
    const y = scr[idx-1][1] + (scr[idx][1]-scr[idx-1][1])*t;
    const ang = Math.atan2(scr[idx][1]-scr[idx-1][1], scr[idx][0]-scr[idx-1][0]);
    ctx.save();
    ctx.translate(x,y); ctx.rotate(ang);
    ctx.drawImage(im, sx,sy,sw,sh, -stampLen/2, -halfW, stampLen, halfW*2);
    ctx.restore();
  }
  ctx.restore();
}
/* 河流矢量回退（素材未加载时）*/
function drawRiverVector(r, scr){
  ctx.save();
  ctx.lineCap='round'; ctx.lineJoin='round';
  ctx.globalAlpha=0.13; ctx.strokeStyle='#90ddf0'; ctx.lineWidth=r.w*4.5; strokeSpline(scr);
  ctx.globalAlpha=0.86; ctx.strokeStyle='#2e8fa6'; ctx.lineWidth=r.w*1.6; strokeSpline(scr);
  ctx.globalAlpha=0.52; ctx.strokeStyle='#84d4e5'; ctx.lineWidth=r.w*0.32; strokeSpline(scr);
  ctx.globalAlpha=1; ctx.restore();
}

/* ---------- 湖泊：手绘湖泊素材按地理范围缩放贴放 ---------- */
function drawLake(l){
  const c=proj(l.cx,l.cy);
  const e=proj(l.cx+l.rx,l.cy), n=proj(l.cx,l.cy+l.ry);
  const rx=Math.abs(e[0]-c[0]), ry=Math.abs(n[1]-c[1]);
  const im=TERRAIN.lake;
  if(imgReady(im)){
    // 素材中水面约占宽度 ~72% → 放大让水面覆盖湖泊范围
    const w=Math.max(rx*2, ry*2)*1.9, h=w*(im.naturalHeight/im.naturalWidth);
    ctx.save();
    ctx.globalAlpha=0.96;
    ctx.drawImage(im, c[0]-w/2, c[1]-h/2, w, h);
    ctx.restore();
    return;
  }
  drawLakeVector(l,c,rx,ry);
}
/* 湖泊矢量回退（素材未加载时）*/
function drawLakeVector(l,c,rx,ry){
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

/* 当前朝代 i 下「已消亡」的绿洲：其最后出现朝代 < i。
   残影落在该绿洲"最后一次出现"的坐标（即它消亡前的所在地）。 */
function ghostsOfEra(i){
  const out = [];
  for(const name in OASIS_LIFE){
    const o = OASIS_LIFE[name];
    const last = o.eras[o.eras.length-1];
    if(last < i){
      const t = o.byEra[last];
      out.push({ id:t.id, name:t.name, lng:t.lng, lat:t.lat, deadEra:last });
    }
  }
  return out;
}
/* 在朝代 i「恰好消亡」的绿洲（最后出现朝代 === i-1）—— 用于前进时的闪灭特效 */
function newlyDeadAt(i){
  const out = [];
  for(const name in OASIS_LIFE){
    const o = OASIS_LIFE[name];
    if(o.eras[o.eras.length-1] === i-1) out.push(o.byEra[i-1]);
  }
  return out;
}

/* 城镇点的青铜绿金属渐变（高光偏左上 → 深绿边缘），仅创建一次 */
function ensureTownGrad(){
  if(svg.select('#townGrad').size()) return;
  const defs = svg.select('defs').empty() ? svg.append('defs') : svg.select('defs');
  const g = defs.append('radialGradient').attr('id','townGrad')
    .attr('cx','50%').attr('cy','50%').attr('r','62%').attr('fx','33%').attr('fy','28%');
  g.append('stop').attr('offset','0%').attr('stop-color','#b3cf8c');   // 金属高光
  g.append('stop').attr('offset','34%').attr('stop-color','#7a9e54');
  g.append('stop').attr('offset','72%').attr('stop-color','#516f3b');
  g.append('stop').attr('offset','100%').attr('stop-color','#334c28');  // 暗绿边缘
}

function renderPoints(){
  ensureTownGrad();
  const eraTowns = showTown ? townsOfEra(curEra) : [];
  const eraRelics = showRelic ? relicsOfEra(curEra) : [];

  // --- 幽灵图层（最底层，灰色残影，不可交互）---
  // 容器固定为 SVG 第一个子节点 → 永远绘制在活点之下
  let ghostG = svg.select('g.ghost-layer');
  if(ghostG.empty()) ghostG = svg.insert('g', ':first-child').attr('class','ghost-layer');
  const ghosts = showGhost ? ghostsOfEra(curEra) : [];
  const gsel = ghostG.selectAll('g.ghost').data(ghosts, d=>'g'+d.name);
  gsel.exit().transition().duration(420).attr('opacity',0).remove();
  const genter = gsel.enter().append('g').attr('class','ghost')
    .style('pointer-events','none')           // 无法交互
    .attr('opacity',0)
    .attr('transform',d=>{const p=proj(d.lng,d.lat);return `translate(${p[0]},${p[1]})`;});
  genter.append('circle').attr('class','ghost-core').attr('r',4.2)
    .attr('fill','#6f6657').attr('opacity',0.55);
  genter.append('circle').attr('class','ghost-ring').attr('r',5).attr('fill','none')
    .attr('stroke','#9a9080').attr('stroke-width',0.6).attr('opacity',0.4);
  genter.merge(gsel).transition().duration(700)
    .attr('transform',d=>{const p=proj(d.lng,d.lat);return `translate(${p[0]},${p[1]})`;})
    .attr('opacity',1);

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
    .attr('fill','none').attr('stroke','#516f3b').attr('stroke-width',1.2).attr('opacity',0.5);
  // 主点（青铜绿 · 金属质感：径向渐变 + 暗绿描边 + 鎏金外圈）
  tenter.append('circle').attr('class','core').attr('r',6)
    .attr('fill','url(#townGrad)').attr('stroke','#2c4222').attr('stroke-width',0.7);
  tenter.append('circle').attr('class','corering').attr('r',6.4)
    .attr('fill','none').attr('stroke','#f4e2b8').attr('stroke-width',1.2).attr('opacity',0.9);
  // 金属高光点
  tenter.append('circle').attr('class','sheen').attr('r',1.7)
    .attr('cx',-1.7).attr('cy',-2).attr('fill','rgba(255,255,255,0.65)');
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
  if(REDUCE_MOTION){ sel.attr('r',14).attr('opacity',0.32); return; }  // 减少动态：光晕静止
  sel.transition().duration(1600).ease(d3.easeSinInOut)
    .attr('r',18).attr('opacity',0.05)
    .transition().duration(1600).ease(d3.easeSinInOut)
    .attr('r',13).attr('opacity',0.5)
    .on('end',function(){ pulse(d3.select(this)); });
}

/* 绿洲消亡瞬间的「啪」—— 一道亮闪 + 一圈冲击波扩散后归于沉寂，随后底层留下灰色残影。
   附加在 SVG 末尾 → 绘制在所有点之上。 */
function deathFlash(town){
  if(!town) return;
  const p = proj(town.lng, town.lat);
  const fl = svg.append('g').attr('class','death-flash')
    .style('pointer-events','none')
    .attr('transform',`translate(${p[0]},${p[1]})`);
  // 亮闪核心
  fl.append('circle').attr('r',5).attr('fill','#ffe6b0').attr('opacity',0.95)
    .transition().duration(130).ease(d3.easeQuadOut).attr('r',11).attr('opacity',1)
    .transition().duration(280).ease(d3.easeCubicIn).attr('r',0.5).attr('opacity',0);
  // 冲击波环
  fl.append('circle').attr('r',5).attr('fill','none')
    .attr('stroke','#e8c47a').attr('stroke-width',2.2).attr('opacity',0.9)
    .transition().duration(560).ease(d3.easeCubicOut)
    .attr('r',26).attr('stroke-width',0.3).attr('opacity',0)
    .on('end',()=>fl.remove());
}

/* ============================================================
   历史名片（点击交互） + 占位数据
   ============================================================ */
function showCard(d, kind){
  clearSearchHighlight();        // 查看任一点位＝下一步操作，恢复常规点位
  document.getElementById('card').classList.remove('hidden');
  document.getElementById('cardName').textContent = d.name || '（无名）';
  document.getElementById('cardSeal').textContent = (d.name||'城').slice(0,1);
  document.getElementById('cardEra').textContent = d.era + (kind==='relic'?' · 文保单位':' · 城镇治所');
  document.getElementById('cardCoord').textContent =
    `经度 ${d.lng.toFixed(4)}°E   纬度 ${d.lat.toFixed(4)}°N`;

  const bars      = document.getElementById('dataBars');
  const at        = document.getElementById('ancientText');
  const sec1      = document.getElementById('cardSec1');
  const sec2      = document.getElementById('cardSec2');
  const sec3      = document.getElementById('cardSec3');
  const webText   = document.getElementById('webText');
  const webDiv    = document.getElementById('webDivider');

  // 隐藏"网络资料"区块（默认）
  sec3.style.display = 'none';
  webText.style.display = 'none';
  webDiv.style.display = 'none';

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

    // 查询网络补充资料
    const webTexts = window.__WEB_TEXTS__;
    let webData = null;
    if(webTexts){
      webData = webTexts[d.era + '|' + d.name] || null;
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

      // 古籍载录区域：来源书目 + 地理描述 + 可能追加网络资料中的古典原文
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
      // 若网络资料含古典原文，追加到古籍载录
      if(webData && webData.classical){
        atHtml += `<p class="ancient-passage" style="margin-top:12px;border-top:1px dashed rgba(199,154,74,.4);padding-top:10px;">${webData.classical}</p>`;
      }
      at.innerHTML = atHtml;

    } else {
      // 无匹配文本
      bars.innerHTML = '<p class="placeholder">〔暂无载录〕</p>';
      if(d.era === '现代'){
        at.innerHTML = '<p class="placeholder">〔现代城市〕此为现代地名标注，暂无对应古籍载录。</p>';
      } else if(webData && webData.classical){
        // 有网络古典文本，显示在古籍载录
        at.innerHTML = `<p class="ancient-passage">${webData.classical}</p>`;
      } else {
        at.innerHTML = '<p class="placeholder">〔暂无载录〕此地名暂未在已录入的古籍中找到对应条目。</p>';
      }
    }

    // 显示"网络资料"区块（若有 summary）
    if(webData && webData.summary){
      sec3.style.display = '';
      webText.style.display = '';
      webDiv.style.display = '';
      webText.innerHTML = `<p class="ancient-passage">${webData.summary}</p>`;
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

  showLife(d, kind);
}

/* ---------- 前世今生：按「真实经纬度」就近聚类（不依赖错乱的 CSV 今地区）----------
   同一绿洲在历代的不同古名（如 于阗/和阗/和田/斡端）坐标相邻 → 归为一处，
   故按地理聚类即可正确「古今为同一地区」。聚类在 buildOasisClusters() 预生成。 */
let CLUSTER_OF = {};      // townId -> 聚类下标
let CLUSTERS   = [];      // 聚类下标 -> [town,...]
let LIFE_GROUPS = [];     // 当前展示：按朝代归并的卡片组（一卡一朝）
let lifeIndex = 0;        // 当前置顶（front）卡片下标

/* 并查集：把相距 ≤ TH 公里的城镇点连成一处绿洲（链式传递可串起绿洲在历代的迁移）*/
function buildOasisClusters(){
  CLUSTER_OF = {}; CLUSTERS = [];
  const n = TOWNS.length;
  if(!n) return;
  const parent = TOWNS.map((_,i)=>i);
  const find = x => { while(parent[x]!==x){ parent[x]=parent[parent[x]]; x=parent[x]; } return x; };
  const TH = 26;           // 公里阈值：和田绿洲跨度内相连、又不串接邻近不同绿洲
  for(let i=0;i<n;i++){
    for(let j=i+1;j<n;j++){
      const a=TOWNS[i], b=TOWNS[j];
      const mid=(a.lat+b.lat)/2*Math.PI/180;
      const dx=(b.lng-a.lng)*Math.cos(mid)*111.32;
      const dy=(b.lat-a.lat)*111.32;
      if(dx*dx+dy*dy <= TH*TH){ const ra=find(i), rb=find(j); if(ra!==rb) parent[ra]=rb; }
    }
  }
  const byRoot={};
  for(let i=0;i<n;i++){ const r=find(i); (byRoot[r]||(byRoot[r]=[])).push(TOWNS[i]); }
  Object.keys(byRoot).forEach(r=>{
    const cid=CLUSTERS.length; CLUSTERS.push(byRoot[r]);
    byRoot[r].forEach(t=>CLUSTER_OF[t.id]=cid);
  });
}

/* 取某城镇点的简介：优先古籍地理描述，其次网络资料概述 */
function lifeDescFor(t){
  const key = t.era + '|' + t.name;
  const tt = (window.__TOWN_TEXTS__ || {})[key];
  const wt = (window.__WEB_TEXTS__  || {})[key];
  let s = (tt && (tt.geo || tt.products)) || (wt && wt.summary) || '';
  return (s || '').trim();
}

function showLife(d, kind){
  const block   = document.getElementById('lifeBlock');
  const divider = document.getElementById('lifeDivider');
  const title   = document.getElementById('lifeSecTitle');
  const regionEl= document.getElementById('lifeRegion');
  if(!block) return;
  const hideAll = ()=>{
    block.style.display='none';
    if(divider) divider.style.display='none';
    if(title)   title.style.display='none';
  };
  // 仅城镇点参与前世今生（文保点不纳入）
  if(kind!=='town' || !d || CLUSTER_OF[d.id]==null){ hideAll(); return; }
  const cluster = CLUSTERS[CLUSTER_OF[d.id]] || [];
  // 按朝代归并（ERA_ORDER 古→今）
  const byEra = {};
  cluster.forEach(t=>{ (byEra[t.era] || (byEra[t.era]=[])).push(t); });
  const eras = ERA_ORDER.filter(e=>byEra[e]);
  // 仅当该地跨 ≥2 个朝代才有「前世今生」可言
  if(eras.length < 2){ hideAll(); return; }
  LIFE_GROUPS = eras.map(e=>({
    era: e,
    cities: byEra[e].map(t=>({ name:t.name, desc:lifeDescFor(t) }))
  }));
  // 从最早的朝代起（古→今），完整呈现叠层
  lifeIndex = 0;
  // 今地标签：取该绿洲「现代」城镇名；无则不显示
  const modern = cluster.find(t=>t.era==='现代');
  if(regionEl){
    if(modern){ regionEl.textContent = '今 · ' + modern.name; regionEl.style.display=''; }
    else regionEl.style.display='none';
  }
  buildLifeDeck();
  if(divider) divider.style.display='';
  if(title)   title.style.display='';
  block.style.display='';
}

/* 构建叠层卡：一卡一朝；同一朝代的多座古城并列于同一张卡（LIFE_GROUPS 已就绪）*/
function buildLifeDeck(){
  const deck = document.getElementById('lifeDeck');
  if(!deck) return;
  const M = LIFE_GROUPS.length;
  deck.innerHTML = LIFE_GROUPS.map((g,i)=>{
    const cities = g.cities.map(c=>{
      const desc = (c.desc || '').trim();
      return `<div class="lc-city"><div class="lc-name">${c.name}</div>`+
             `<div class="lc-desc${desc?'':' lc-empty'}">${desc || '〔暂无记载〕'}</div></div>`;
    }).join('');
    return `<div class="life-deck-card" data-i="${i}">`+
           `<span class="lc-ord">第 ${i+1} 世 · 共 ${M} 世</span>`+
           `<span class="lc-era">${g.era}</span>`+
           `<div class="lc-body">${cities}</div>`+
           `</div>`;
  }).join('');
  // 点击置顶卡 → 翻到下一朝
  deck.querySelectorAll('.life-deck-card').forEach(c=>{
    c.addEventListener('click',()=>{ if(c.classList.contains('front')) lifeGo(1); });
  });
  updateLifeDeck();
}

/* 依据 lifeIndex 重排各卡的纵深层叠 / 翻页姿态 */
function updateLifeDeck(){
  const deck = document.getElementById('lifeDeck');
  if(!deck) return;
  const N = LIFE_GROUPS.length;
  deck.querySelectorAll('.life-deck-card').forEach((c,i)=>{
    const pos = i - lifeIndex;
    let t, op, z, front = false;
    if(pos === 0){
      t = 'translateY(0) translateZ(0) scale(1) rotate(0deg)'; op = 1; z = 100; front = true;
    } else if(pos < 0){
      // 已翻过：上飞旋出
      t = `translateY(-128%) translateZ(0) scale(.92) rotate(${-8 + pos*1.5}deg)`;
      op = 0; z = 10 + pos;
    } else {
      // 待展示：叠在身后，底缘渐次露出
      const p = Math.min(pos, 4);
      t = `translateY(${p*10}px) translateZ(${-p*34}px) scale(${(1 - p*0.05).toFixed(3)}) rotate(0deg)`;
      op = pos > 4 ? 0 : Math.max(0, 1 - p*0.22);
      z = 100 - pos;
    }
    c.style.transform = t;
    c.style.opacity = op;
    c.style.zIndex = z;
    c.style.pointerEvents = front ? 'auto' : 'none';
    c.classList.toggle('front', front);
  });
  const cnt = document.getElementById('lifeCount');
  if(cnt) cnt.textContent = `${lifeIndex+1} / ${N}`;
  const prev = document.getElementById('lifePrev');
  const next = document.getElementById('lifeNext');
  if(prev) prev.disabled = lifeIndex <= 0;
  if(next) next.disabled = lifeIndex >= N-1;
}

function lifeGo(step){
  const N = LIFE_GROUPS.length;
  if(!N) return;
  lifeIndex = Math.max(0, Math.min(N-1, lifeIndex + step));
  updateLifeDeck();
}

function barRow(label,val,tag){
  return `<div class="bar-row">
    <div class="bar-label"><span>${label} <small style="color:#a08a5e">${tag}</small></span><span>${val}</span></div>
    <div class="bar-track"><div class="bar-fill" style="width:${val}%"></div></div></div>`;
}
document.getElementById('cardClose').onclick =
  ()=>document.getElementById('card').classList.add('hidden');

/* 前世今生：朝代翻页 */
(function lifeCtrlInit(){
  const prev = document.getElementById('lifePrev');
  const next = document.getElementById('lifeNext');
  if(prev) prev.onclick = ()=>lifeGo(-1);
  if(next) next.onclick = ()=>lifeGo(1);
})();

/* ============================================================
   时间轴
   ============================================================ */
function setEra(i){
  clearSearchHighlight();        // 切换朝代＝下一步操作，恢复常规点位
  const target = Math.max(0, Math.min(ERA_ORDER.length-1, i));
  prevEra = curEra;
  curEra = target;
  const name = ERA_ORDER[curEra];
  // 前进一朝时，对「恰在此朝消亡」的绿洲逐个闪灭（楼兰、尼雅式的"啪"地熄灭）
  if(showGhost && curEra === prevEra + 1){
    newlyDeadAt(curEra).forEach((t,k)=> setTimeout(()=>deathFlash(t), 90*k));
  }
  // 横排纪年轨：定位金珠 + 填充（古→今，自左而右）
  const frac = curEra / (ERA_ORDER.length - 1);
  const bead = document.getElementById('eraBead');
  const fill = document.getElementById('eraRailFill');
  if(bead) bead.style.left  = (frac*100) + '%';
  if(fill) fill.style.width = (frac*100) + '%';
  const rail = document.getElementById('eraRail');
  if(rail){ rail.setAttribute('aria-valuetext', name); rail.setAttribute('aria-valuenow', curEra); }
  const _eraName = document.getElementById('eraName');
  if(_eraName) _eraName.textContent = name;   // 右端朝代名已移除，左上角牌匾仍显示
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

/* 竖排纪年轨 · 点击/拖动/键盘 */
(function eraRailCtrl(){
  const rail = document.getElementById('eraRail');
  if(!rail) return;
  const N = ERA_ORDER.length;
  let dragging = false;
  function pick(clientX){
    const r = rail.getBoundingClientRect();
    let f = (clientX - r.left) / r.width;
    f = Math.max(0, Math.min(1, f));
    const idx = Math.round(f * (N - 1));
    if(idx !== curEra){ stopPlay(); setEra(idx); }
  }
  rail.addEventListener('pointerdown', e=>{
    dragging = true; rail.classList.add('dragging');
    rail.setPointerCapture(e.pointerId); pick(e.clientX); e.preventDefault();
  });
  rail.addEventListener('pointermove', e=>{ if(dragging) pick(e.clientX); });
  rail.addEventListener('pointerup',   ()=>{ dragging = false; rail.classList.remove('dragging'); });
  rail.addEventListener('pointercancel',()=>{ dragging = false; rail.classList.remove('dragging'); });
  rail.addEventListener('keydown', e=>{
    if(e.key==='ArrowUp'||e.key==='ArrowLeft'){ stopPlay(); setEra(curEra-1); e.preventDefault(); }
    else if(e.key==='ArrowDown'||e.key==='ArrowRight'){ stopPlay(); setEra(curEra+1); e.preventDefault(); }
  });
})();

function startPlay(){
  playing=true;
  const b=document.getElementById('playBtn'); b.textContent='❚❚'; b.setAttribute('aria-pressed','true');
  playTimer=setInterval(()=>{
    let next=curEra+1;
    if(next>=ERA_ORDER.length){ next=0; }
    setEra(next);
  },1800);
}
function stopPlay(){
  playing=false;
  const b=document.getElementById('playBtn'); b.textContent='▶'; b.setAttribute('aria-pressed','false');
  if(playTimer){clearInterval(playTimer);playTimer=null;}
}
document.getElementById('playBtn').onclick=()=>playing?stopPlay():startPlay();

/* 文字粒子：切换年代时朝代名上浮 */
function spawnGlyph(text){
  const chars=text.split('');
  chars.forEach((ch,i)=>{
    const el=document.createElement('div');
    el.className='float-glyph';el.textContent=ch;
    const base=40;                                   // 朝代名字号（放大）
    el.style.left=(W*0.5 + (i-chars.length/2)*base)+'px';
    el.style.top=(H*0.5)+'px';
    el.style.fontSize=(base+Math.random()*16)+'px';
    stage.appendChild(el);
    el.animate([
      {opacity:0,transform:'translateY(0) scale(.8)'},
      {opacity:.85,transform:'translateY(-40px) scale(1.1)',offset:.3},
      {opacity:0,transform:'translateY(-120px) scale(1.3)'}
    ],{duration:1600,easing:'ease-out'});
    setTimeout(()=>el.remove(),1650);
  });
}

document.getElementById('toggleTown').onchange=e=>{
  showTown=e.target.checked; renderPoints();
};
document.getElementById('toggleRelic').onchange=e=>{
  showRelic=e.target.checked; renderPoints();
};
const _toggleGhost = document.getElementById('toggleGhost');
if(_toggleGhost) _toggleGhost.onchange=e=>{
  showGhost=e.target.checked; renderPoints();
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
    buildOasisLife();
    buildOasisClusters();          // 前世今生：按真实坐标就近聚类（古今同地）
    GEO_FULL = window.__GEO_FULL__ || null;
    GEO_BORDER = window.__GEO_BORDER__ || null;
    buildTicks();
    setupZoom();
    resize();
    setEra(0);
    window.addEventListener('resize', debounce(resize,200));
  }catch(err){
    document.body.innerHTML='<div style="color:#f4e2b8;padding:40px;font-size:16px">'+
      '数据加载失败：'+err.message+'</div>';
  }
})();

function debounce(fn,ms){let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms);};}

/* ============================================================
   封面页 · 聚光揭示效果（原生复刻 image-reveal）+ 丝滑进入
   ============================================================ */
(function coverFx(){
  const cover = document.getElementById('cover');
  const mask  = document.getElementById('coverMask');
  const glow  = document.getElementById('coverGlow');
  const enter = document.getElementById('enterBtn');
  if(!cover || !mask || !enter) return;

  const MAX_R = 240, SOFT = 92;
  let tx = innerWidth/2, ty = innerHeight/2, cx = tx, cy = ty;
  let tr = 0, cr = 0, hovered = false, raf = null;
  const touch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

  function onMove(e){
    const r = cover.getBoundingClientRect();
    tx = e.clientX - r.left; ty = e.clientY - r.top;
  }
  function start(){ if(!raf) raf = requestAnimationFrame(frame); }

  function frame(){
    cx += (tx - cx) * 0.18;
    cy += (ty - cy) * 0.18;
    cr += (tr - cr) * 0.13;
    if(cr > 1){
      const inner = Math.max(cr - SOFT - 20, 0);
      const g = `radial-gradient(circle ${cr}px at ${cx}px ${cy}px,`+
        `transparent 0 ${inner}px,`+
        `rgba(0,0,0,.12) ${Math.max(cr-SOFT,0)}px,`+
        `rgba(0,0,0,.32) ${Math.max(cr-SOFT/1.5,0)}px,`+
        `rgba(0,0,0,.55) ${Math.max(cr-SOFT/2,0)}px,`+
        `rgba(0,0,0,.82) ${cr}px, #000 100%)`;
      mask.style.webkitMaskImage = g;
      mask.style.maskImage = g;
      glow.style.opacity = '1';
      glow.style.background = `radial-gradient(circle ${cr+34}px at ${cx}px ${cy}px,`+
        `rgba(244,226,184,.20) 0, rgba(230,196,120,.10) 60%, transparent 100%)`;
    }
    if(hovered || cr > 0.6){
      raf = requestAnimationFrame(frame);
    } else {
      raf = null;
      mask.style.webkitMaskImage = 'none';
      mask.style.maskImage = 'none';
      glow.style.opacity = '0';
    }
  }

  if(!touch){
    cover.addEventListener('mousemove', onMove);
    cover.addEventListener('mouseenter', ()=>{ hovered = true; tr = MAX_R; start(); });
    cover.addEventListener('mouseleave', ()=>{ hovered = false; tr = 0; });
  }
  // 进入按钮的跳转交由顶部菜单的 siteNav 统一处理
})();

/* ============================================================
   顶部菜单栏 · 页面路由（首页/历史地图/参考资料/关于我们）
   ============================================================ */
(function siteNav(){
  const cover = document.getElementById('cover');
  const refs  = document.getElementById('refsPage');
  const about = document.getElementById('aboutPage');

  function hideCover(){
    if(!cover || cover.style.display === 'none') return;
    cover.classList.add('cover-exit');
    setTimeout(()=>{ cover.style.display = 'none'; }, 900);
  }
  function showCover(){
    if(!cover) return;
    cover.style.display = '';
    void cover.offsetWidth;                  // 触发重排 → 淡入动画生效
    cover.classList.remove('cover-exit');
  }
  function setActive(p){
    document.querySelectorAll('#topnav .nav-item').forEach(a=>
      a.classList.toggle('active', a.dataset.nav === p));
  }
  function showPage(p){
    if(refs)  refs.classList.toggle('hidden',  p !== 'refs');
    if(about) about.classList.toggle('hidden', p !== 'about');
    if(p === 'home') showCover(); else hideCover();
    setActive(p);
  }

  document.querySelectorAll('#topnav .nav-item').forEach(a=>{
    a.addEventListener('click', e=>{ e.preventDefault(); showPage(a.dataset.nav); });
  });
  const enter = document.getElementById('enterBtn');
  if(enter) enter.addEventListener('click', ()=> showPage('map'));
})();

/* ============================================================
   顶栏搜索 · 按地名检索城镇（同名多朝代分列），选中后定位并高亮
   ============================================================ */
(function searchInit(){
  const input = document.getElementById('navSearch');
  const box   = document.getElementById('navSearchResults');
  if(!input || !box) return;

  function render(q){
    q = (q || '').trim();
    if(!q){ box.classList.add('hidden'); box.innerHTML = ''; return; }
    const ql = q.toLowerCase();
    const seen = {}, res = [];
    for(const t of TOWNS){
      if(!t.name || !t.name.toLowerCase().includes(ql)) continue;
      const k = t.name + '|' + t.era;
      if(seen[k]) continue; seen[k] = 1;
      res.push(t);
    }
    res.sort((a,b)=>{
      const ea = a.name === q ? 0 : 1, eb = b.name === q ? 0 : 1;
      if(ea !== eb) return ea - eb;
      if(a.name !== b.name) return a.name.localeCompare(b.name, 'zh');
      return a.eraIndex - b.eraIndex;
    });
    const top = res.slice(0, 40);
    box.innerHTML = top.length
      ? top.map(t=>`<div class="search-row" data-id="${t.id}"><span class="sr-name">${t.name}</span><span class="sr-era">${t.era}</span></div>`).join('')
      : '<div class="search-empty">未找到匹配地名</div>';
    box.classList.remove('hidden');
  }

  function pick(town){
    if(!town) return;
    box.classList.add('hidden');
    input.value = town.name;
    input.blur();
    const mapNav = document.querySelector('#topnav .nav-item[data-nav="map"]');
    if(mapNav) mapNav.click();        // 确保在地图页
    stopPlay();
    applySearchHighlight(town);
  }

  input.addEventListener('input', ()=> render(input.value));
  input.addEventListener('focus', ()=>{ if(input.value.trim()) render(input.value); });
  input.addEventListener('keydown', e=>{
    if(e.key === 'Escape'){ input.value = ''; box.classList.add('hidden'); input.blur(); }
    else if(e.key === 'Enter'){ const first = box.querySelector('.search-row'); if(first) first.click(); }
  });
  box.addEventListener('click', e=>{
    const row = e.target.closest('.search-row'); if(!row) return;
    pick(TOWNS.find(t=> t.id === +row.dataset.id));
  });
  document.addEventListener('click', e=>{
    if(!e.target.closest('.nav-search')) box.classList.add('hidden');
  });
})();
