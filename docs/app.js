'use strict';
// ═══════════════════════════════════════════════════════════════
// 民航局無人機申請資料填寫系統 — 前端
// 步驟：1 繪製空域 → 2 案名與作業概述 → 3 預計起飛地點 → 4 確認與輸出
// ═══════════════════════════════════════════════════════════════

const MAX_POLY_POINTS = 6;
const STORAGE_KEY = 'caaDroneApp.v1';
const AS_COLORS = ['#1565c0', '#7b1fa2', '#00897b', '#ef6c00', '#c2185b', '#5d4037', '#283593', '#2e7d32'];
const LAUNCH_SECTION_TITLE = '【預計起飛地點】';
// 作業概述格式：第一段 →【預計起飛地點】→ 結語；第一段預設為範本
const DEFAULT_INTRO = '本案係辦理「XX」紀錄片，受XX委託，(拍攝規劃與內容)。因素材拍攝範圍廣，須執行人群聚集或室外集會遊行上空活動、視距外操作及夜間飛行等操作限制。';
const CLOSING_LINE = '將遵循所有規定並加強安全控管';
const CLOSING_RE = /^\s*將遵循所有規定並加強安全控管\s*[。.]?\s*$/;
const DEFAULT_OVERVIEW = `${DEFAULT_INTRO}\n${CLOSING_LINE}`;
const CAA_COLOR = { '紅區': '#c62828', '黃區': '#f9a825', '灰區': '#757575' };
const AIRFIELD_KEYWORDS = ['機場', '飛行場', '航空技術學院', '飛行訓練指揮部'];

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── 狀態 ──────────────────────────────────────────────────────
function newState() {
  return {
    version: 4, step: 1, caseName: '', caseNameAuto: true, highAltitude: false, overview: DEFAULT_OVERVIEW,
    coordFormat: 'decimal',
    airspaces: [], launchPoints: [], seq: 1, asSeq: 1,
  };
}
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? migrate({ ...newState(), ...JSON.parse(raw) }) : null;
  } catch { return null; }
}
// v2：座標預設改十進位、取消「最大高度」欄位
function migrate(s) {
  if ((s.version || 1) < 2) {
    s.coordFormat = 'decimal';
    s.airspaces.forEach((as) => delete as.height);
    s.version = 2;
  }
  if (s.version < 3) { // v3：案名預設格式、400 呎以上選項
    s.caseNameAuto = !s.caseName;
    s.highAltitude = false;
    s.version = 3;
  }
  if (s.version < 4) { // v4：作業大致內容併入作業概述（預設範本）、KML 不含起飛點
    if (!s.overview.trim()) s.overview = DEFAULT_OVERVIEW;
    delete s.draft;
    delete s.includeLaunchInKml;
    s.version = 4;
  }
  s.overview = ensureClosing(s.overview || ''); // 結語一定在最後一行
  return s;
}
let state = loadState() || newState();
function save() {
  if (state.caseNameAuto) state.caseName = defaultCaseName();
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* 無痕模式等 */ }
  $('#caseLabel').textContent = state.caseName || '未命名案件';
}
// 案名預設：年份＋季節＋各空域縣市＋紀錄片拍攝 空拍攝影，400 呎以上加 (高空)
const CASE_NAME_SUFFIX = '紀錄片拍攝 空拍攝影';
const HIGH_ALT_SUFFIX = '(高空)';
function seasonOf(d) {
  const m = d.getMonth() + 1;
  if (m >= 3 && m <= 5) return '春季';
  if (m >= 6 && m <= 8) return '夏季';
  if (m >= 9 && m <= 11) return '秋季';
  return '冬季';
}
const shortCounty = (c) => c.replace(/^臺/, '台').replace(/[縣市]$/, '');
function caseCounties() {
  const list = [];
  for (const as of state.airspaces) {
    const fromArea = (as.area || '').match(/^(.{2}[縣市])/)?.[1];
    const counties = ui.regions[as.id]?.counties?.length ? ui.regions[as.id].counties : (fromArea ? [fromArea] : []);
    counties.forEach((c) => { const sc = shortCounty(c); if (!list.includes(sc)) list.push(sc); });
  }
  return list;
}
function defaultCaseName() {
  const now = new Date();
  return `${now.getFullYear()}${seasonOf(now)}${caseCounties().join('')}${CASE_NAME_SUFFIX}${state.highAltitude ? HIGH_ALT_SUFFIX : ''}`;
}
const uid = (prefix) => `${prefix}${state.seq++}`;

// 暫時性的介面狀態（不存檔）
const ui = {
  mode: 'none',            // none | drawPolygon | drawCircle | addLaunch | moveLaunch
  draw: null,              // { points, center, mouse }
  addFor: null,            // addLaunch 的空域 id
  selectedAirspaceId: null,
  selectedLaunchId: null,
  candidates: {},          // asId → { key, list, loading, error }
  caa: { items: [], source: null },
  warnings: {},            // asId → { zones: [], kinks: bool }
  airports: {},            // asId → 10 公里內的機場與最近跑道頭距離
  regions: {},             // asId → 涵蓋的縣市、是否跨海岸線、計為幾個空域
  aiBusy: false,
};

// 「空域N」的 N 就是排列順序：改名成空域1 會移到最前面，其他「空域N」依位置重新編號
const AS_NAME_RE = /^空域\s*([0-9０-９]+)$/;
function asNumber(name) {
  const m = String(name).trim().match(AS_NAME_RE);
  return m ? Number(m[1].replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))) : null;
}
function renumberAirspaces() {
  state.airspaces.forEach((a, i) => { if (asNumber(a.name) != null) a.name = `空域${i + 1}`; });
}
function moveByName(as) {
  const k = asNumber(as.name);
  if (k == null) return false;
  const others = state.airspaces.filter((a) => a !== as);
  others.splice(Math.min(Math.max(k - 1, 0), others.length), 0, as);
  state.airspaces = others;
  renumberAirspaces();
  return true;
}
const getAs = (id) => state.airspaces.find((a) => a.id === id);
const getLp = (id) => state.launchPoints.find((p) => p.id === id);
const lpsOf = (asId) => state.launchPoints.filter((p) => p.airspaceId === asId);

// ── 幾何工具 ──────────────────────────────────────────────────
function asFeature(as) {
  if (as.type === 'circle') {
    return turf.circle([as.center[1], as.center[0]], as.radius / 1000, { steps: 72, units: 'kilometers' });
  }
  const ring = as.points.map((p) => [p[1], p[0]]);
  ring.push(ring[0]);
  return turf.polygon([ring]);
}
const distM = (a, b) => turf.distance([a[1], a[0]], [b[1], b[0]], { units: 'meters' });
function insideAirspace(as, lat, lng) {
  if (as.type === 'circle') return distM(as.center, [lat, lng]) <= as.radius;
  if (as.points.length < 3) return false;
  return turf.booleanPointInPolygon([lng, lat], asFeature(as));
}
function asCenter(as) {
  if (as.type === 'circle') return as.center;
  const c = turf.centroid(asFeature(as)).geometry.coordinates;
  return [c[1], c[0]];
}
const asArea = (as) => turf.area(asFeature(as));
const geomKey = (as) => JSON.stringify(as.type === 'circle' ? [as.center, Math.round(as.radius)] : as.points);

// ── 座標格式 ──────────────────────────────────────────────────
function dmsParts(v) {
  const a = Math.abs(v);
  let d = Math.floor(a);
  let m = Math.floor((a - d) * 60);
  let s = Math.round(((a - d) * 60 - m) * 60 * 100) / 100;
  if (s >= 60) { s = 0; m += 1; }
  if (m >= 60) { m = 0; d += 1; }
  return { d, m, s };
}
function dmsText(v, pos, neg) {
  const { d, m, s } = dmsParts(v);
  return `${v >= 0 ? pos : neg}${d}°${String(m).padStart(2, '0')}'${s.toFixed(2).padStart(5, '0')}"`;
}
// 民航局 CKWT 度分秒格式：232244.59,1200852.64
function ckwt(v) {
  const { d, m, s } = dmsParts(v);
  return `${d}${String(m).padStart(2, '0')}${s.toFixed(2).padStart(5, '0')}`;
}
function fmtCoord(p) {
  const [lat, lng] = p;
  if (state.coordFormat === 'decimal') return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  if (state.coordFormat === 'ckwt') return `${ckwt(lat)},${ckwt(lng)}`;
  return `${dmsText(lat, 'N', 'S')} ${dmsText(lng, 'E', 'W')}`;
}
const ckwtList = (as) => as.type === 'circle'
  ? `${ckwt(as.center[0])},${ckwt(as.center[1])}`
  : as.points.map((p) => `${ckwt(p[0])},${ckwt(p[1])}`).join(' ');
const ft = (m) => Math.round(Number(m) * 3.28084);

// ── 提示訊息 ──────────────────────────────────────────────────
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3500);
}

// ═══════════════════════════════════════════════════════════════
// OpenStreetMap 服務（瀏覽器直接呼叫）
// ═══════════════════════════════════════════════════════════════
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
// 有些地下／立體停車場沒標 parking 類型，只寫在名稱裡
const INDOOR_PARKING_WORDS = ['地下', '立體', '室內', '大樓', 'B1', 'B2'];
// 宗教場所只要廟宇；沒標宗教別的教堂靠名稱排除
const NON_TEMPLE_WORDS = ['教會', '教堂', '天主堂', '禮拜堂', '清真寺', '聚會所'];
const overpassCache = new Map();

// 範圍內的公園與戶外停車場；各鏡像站速度時好時壞，同時查詢取最先成功的
async function queryLaunchCandidates(south, west, north, east) {
  const key = [south, west, north, east].map((v) => v.toFixed(4)).join(',');
  if (overpassCache.has(key)) return overpassCache.get(key);
  const bbox = `${south},${west},${north},${east}`;
  const query = `[out:json][timeout:50];
(
  nwr["leisure"~"^(park|recreation_ground|garden)$"]["access"!~"^(private|no)$"](${bbox});
  nwr["amenity"="parking"]["parking"!~"^(underground|multi-storey|rooftop)$"]["location"!~"underground"]["access"!~"^(private|no)$"](${bbox});
  nwr["amenity"="place_of_worship"]["religion"!~"^(christian|muslim|jewish|bahai)$"](${bbox});
);
out center tags 800;`;
  const ctrls = OVERPASS_URLS.map(() => new AbortController());
  const timer = setTimeout(() => ctrls.forEach((c) => c.abort()), 60000);
  let elements;
  try {
    elements = await Promise.any(OVERPASS_URLS.map(async (url, i) => {
      const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: ctrls[i].signal });
      if (!res.ok) throw new Error(`${res.status}`);
      return (await res.json()).elements || [];
    }));
  } catch {
    throw new Error('OpenStreetMap 查詢逾時或失敗');
  } finally {
    clearTimeout(timer);
    ctrls.forEach((c) => c.abort());
  }
  const list = [];
  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat == null || lng == null) continue;
    const tags = el.tags || {};
    const kind = tags.amenity === 'parking' ? 'parking' : tags.amenity === 'place_of_worship' ? 'temple' : 'park';
    let name = tags['name:zh'] || tags.name || '';
    if (kind === 'parking' && INDOOR_PARKING_WORDS.some((w) => name.includes(w))) continue;
    if (kind === 'temple' && NON_TEMPLE_WORDS.some((w) => name.includes(w))) continue;
    const named = Boolean(name);
    if (!name) name = { parking: '戶外停車場', temple: '廟宇', park: '公園綠地' }[kind];
    list.push({ id: `${el.type}/${el.id}`, lat, lng, kind, name, named });
  }
  overpassCache.set(key, list);
  return list;
}

// Nominatim 使用規範：每秒最多 1 次請求，這裡排隊送出
let nominatimChain = Promise.resolve();
function nominatim(path, params) {
  const run = async () => {
    const url = `https://nominatim.openstreetmap.org/${path}?${new URLSearchParams({ format: 'jsonv2', 'accept-language': 'zh-TW', ...params })}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  };
  const p = nominatimChain.then(run);
  nominatimChain = p.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 1100)));
  return p;
}
const reverseCache = new Map();
async function reverseGeocode(lat, lng) {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (reverseCache.has(key)) return reverseCache.get(key);
  const addr = (await nominatim('reverse', { lat, lon: lng, zoom: 16 })).address || {};
  const city = addr.city || addr.county || addr.state || '';
  let town = addr.town || addr.suburb || addr.city_district || addr.village || '';
  if (town === city) town = '';
  const result = { area: `${city}${town}`, place: addr.amenity || addr.leisure || addr.road || '', road: addr.road || '' };
  reverseCache.set(key, result);
  return result;
}

// ═══════════════════════════════════════════════════════════════
// 空域內最大地表高度（AWS Terrain Tiles／Terrarium 編碼，逐像素掃描）
// ═══════════════════════════════════════════════════════════════
const TERRAIN_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const TERRAIN_MAX_ZOOM = 15;
const terrainTiles = new Map();
const lng2tx = (lng, z) => ((lng + 180) / 360) * 2 ** z;
const lat2ty = (lat, z) => { const r = lat * Math.PI / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z; };
const tx2lng = (x, z) => (x / 2 ** z) * 360 - 180;
const ty2lat = (y, z) => { const n = Math.PI - (2 * Math.PI * y) / 2 ** z; return (180 / Math.PI) * Math.atan(Math.sinh(n)); };

function loadTerrainTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (!terrainTiles.has(key)) {
    terrainTiles.set(key, new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = 256;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        resolve(ctx.getImageData(0, 0, 256, 256).data);
      };
      img.onerror = () => { terrainTiles.delete(key); reject(new Error('地形資料載入失敗')); };
      img.src = `${TERRAIN_URL}/${key}.png`;
    }));
  }
  return terrainTiles.get(key);
}
// 快速點在空域內判斷（逐像素用，turf 太慢）
function insideTester(as) {
  if (as.type === 'circle') {
    const [clat, clng] = as.center;
    const kx = 111320 * Math.cos(clat * Math.PI / 180);
    const r2 = as.radius ** 2;
    return (lat, lng) => ((lng - clng) * kx) ** 2 + ((lat - clat) * 110540) ** 2 <= r2;
  }
  const pts = as.points;
  return (lat, lng) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [yi, xi] = pts[i]; const [yj, xj] = pts[j];
      if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
}
async function computeMaxElevation(as) {
  const [w, s, e, n] = turf.bbox(asFeature(as));
  let z = TERRAIN_MAX_ZOOM;
  const range = (zz) => [Math.floor(lng2tx(w, zz)), Math.floor(lng2tx(e, zz)), Math.floor(lat2ty(n, zz)), Math.floor(lat2ty(s, zz))];
  while (z > 8) {
    const [x0, x1, y0, y1] = range(z);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 16) break;
    z -= 1;
  }
  const [x0, x1, y0, y1] = range(z);
  const inside = insideTester(as);
  let best = null;
  const jobs = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      jobs.push(loadTerrainTile(z, x, y).then((data) => {
        for (let py = 0; py < 256; py++) {
          const lat = ty2lat(y + (py + 0.5) / 256, z);
          if (lat < s || lat > n) continue;
          for (let px = 0; px < 256; px++) {
            const lng = tx2lng(x + (px + 0.5) / 256, z);
            if (lng < w || lng > e || !inside(lat, lng)) continue;
            const i = (py * 256 + px) * 4;
            const m = data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
            if (!best || m > best.m) best = { m, lat, lng };
          }
        }
      }));
    }
  }
  await Promise.all(jobs);
  if (!best) { // 空域比一個像素還小：取中心點
    const [lat, lng] = asCenter(as);
    const tx = lng2tx(lng, z); const ty = lat2ty(lat, z);
    const data = await loadTerrainTile(z, Math.floor(tx), Math.floor(ty));
    const i = (Math.floor((ty % 1) * 256) * 256 + Math.floor((tx % 1) * 256)) * 4;
    best = { m: data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768, lat, lng };
  }
  const m = Math.max(0, best.m); // 海面為負值
  return { v: ELEV_VERSION, key: geomKey(as), m: Math.round(m), ft: Math.ceil(m * 3.28084), lat: best.lat, lng: best.lng };
}
const ELEV_VERSION = 2; // v2：英尺改為無條件進位
const MIN_HEIGHT_MARGIN_FT = 400;
const elevReady = (as) => as.elev && !as.elev.error && as.elev.v === ELEV_VERSION && as.elev.key === geomKey(as);
const minApplyFt = (as) => Math.ceil((as.elev.ft + MIN_HEIGHT_MARGIN_FT) / 100) * 100;
const elevPending = new Map();
function refreshElevation(as) {
  const key = geomKey(as);
  if (elevReady(as) || elevPending.get(as.id) === key) return;
  elevPending.set(as.id, key);
  computeMaxElevation(as).then((elev) => {
    if (geomKey(as) !== elev.key) return; // 計算期間空域又被改過
    as.elev = elev;
    save();
    renderElevation();
    renderPanel();
  }).catch((err) => {
    as.elev = { key, error: err.message };
    renderPanel();
  }).finally(() => { if (elevPending.get(as.id) === key) elevPending.delete(as.id); });
}
function elevationHtml(as) {
  const ev = as.elev;
  if (ev?.error && ev.key === geomKey(as)) return `<div class="meta">⚠️ 最大地表高度計算失敗（${esc(ev.error)}）</div>`;
  if (!elevReady(as)) return '<div class="meta"><span class="spinner"></span> 計算空域內最大地表高度…</div>';
  return `<div class="stat">⛰ 空域內最大地表高度：<b>${ev.ft.toLocaleString()} ft</b> <span class="meta">（${ev.m} m，位置 ${esc(fmtCoord([ev.lat, ev.lng]))}）</span></div>
    <div class="stat">🛫 最低可申請高度：<b>${minApplyFt(as).toLocaleString()} ft</b> <span class="meta">（最大地表高度 + ${MIN_HEIGHT_MARGIN_FT} ft，無條件進位到百位）</span></div>`;
}

// ═══════════════════════════════════════════════════════════════
// 機場跑道頭距離（OurAirports 跑道資料，含內移跑道頭修正）
// ═══════════════════════════════════════════════════════════════
const AIRPORT_RANGE_M = 10000;
const NM = 1852;
let runwayData = [];
async function loadRunways() {
  try {
    const res = await fetch('data/tw_runways.json');
    runwayData = (await res.json()).airports || [];
    state.airspaces.forEach(updateAirports);
    renderAirportLines();
    renderPanel();
  } catch (err) { console.warn('跑道資料載入失敗', err); /* 沒有跑道資料就不顯示機場距離 */ }
}
// 空域上離 pt 最近的點（pt 在空域內則為 pt 本身）
function nearestPointInAirspace(as, lat, lng) {
  if (insideAirspace(as, lat, lng)) return [lat, lng];
  if (as.type === 'circle') {
    const bearing = turf.bearing([as.center[1], as.center[0]], [lng, lat]);
    const c = turf.destination([as.center[1], as.center[0]], as.radius / 1000, bearing, { units: 'kilometers' }).geometry.coordinates;
    return [c[1], c[0]];
  }
  const p = turf.nearestPointOnLine(turf.polygonToLine(asFeature(as)), [lng, lat]).geometry.coordinates;
  return [p[1], p[0]];
}
function updateAirports(as) {
  const near = [];
  for (const ap of runwayData) {
    let best = null;
    for (const th of ap.thresholds) {
      const p = nearestPointInAirspace(as, th.lat, th.lng);
      const d = distM(p, [th.lat, th.lng]);
      if (!best || d < best.d) best = { d, th, p };
    }
    if (best && best.d <= AIRPORT_RANGE_M) {
      near.push({ icao: ap.icao, name: ap.name, rwy: best.th.rwy, th: [best.th.lat, best.th.lng], p: best.p, nm: best.d / NM });
    }
  }
  near.sort((a, b) => a.nm - b.nm);
  ui.airports[as.id] = near;
}
const APPROACH_NM = 3;
const fmtNm = (a) => `${a.nm.toFixed(2)} 海里（${(a.nm * NM / 1000).toFixed(2)} 公里）`;
// 以顯示到小數第 2 位的值判斷，避免畫面顯示 3.00 卻沒有提示
const inApproach = (a) => Number(a.nm.toFixed(2)) <= APPROACH_NM;
function airportHtml(as) {
  const near = ui.airports[as.id];
  if (!near?.length) return '';
  return near.map((a) => `<div class="notice danger">✈️ 位於 <b>${esc(a.name)}</b>（${a.icao}）10 公里內：空域最近點距 <b>RWY ${esc(a.rwy)} 跑道頭 ${fmtNm(a)}</b>
    ${inApproach(a) ? `<div class="approach">⚠️ 受${esc(a.name)}近離場影響</div>` : ''}
    <div class="meta">空域最近點 ${esc(fmtCoord(a.p))}</div></div>`).join('');
}

// ═══════════════════════════════════════════════════════════════
// 縣市／鄉鎮／海岸線（內政部鄉鎮市區界線，簡化至約 10 公尺）
// 跨縣市或跨海岸線的空域，每一塊都算一個空域；每個專案最多 5 個
// ═══════════════════════════════════════════════════════════════
const MAX_AIRSPACES = 5;
const MIN_PIECE_RATIO = 0.01;   // 小於空域面積 1% 或 1000 m² 的邊界誤差不算
const MIN_PIECE_M2 = 1000;
let townData = [];
async function loadTowns() {
  try {
    const res = await fetch('data/tw_towns.geojson');
    townData = (await res.json()).features.map((f) => ({ f, bbox: turf.bbox(f), county: f.properties.c, town: f.properties.t }));
    state.airspaces.forEach(refreshDerived);
    save();
    renderPanel();
  } catch (err) { console.warn('鄉鎮界線載入失敗', err); }
}
function updateRegions(as) {
  if (!townData.length) return;
  const feat = asFeature(as);
  const total = turf.area(feat);
  const [w0, s0, e0, n0] = turf.bbox(feat);
  const minPiece = Math.max(MIN_PIECE_M2, total * MIN_PIECE_RATIO);
  const counties = new Map(); // 縣市 → 面積
  let land = 0; let main = null;
  for (const t of townData) {
    const [w1, s1, e1, n1] = t.bbox;
    if (w1 > e0 || e1 < w0 || s1 > n0 || n1 < s0) continue;
    let inter = null;
    try { inter = turf.intersect(turf.featureCollection([feat, t.f])); } catch { /* 幾何異常略過 */ }
    if (!inter) continue;
    const a = turf.area(inter);
    land += a;
    counties.set(t.county, (counties.get(t.county) || 0) + a);
    if (!main || a > main.a) main = { a, county: t.county, town: t.town };
  }
  const countyList = [...counties.entries()].filter(([, a]) => a >= minPiece).sort((x, y) => y[1] - x[1]).map(([c]) => c);
  const sea = total - land >= minPiece;
  const hasLand = countyList.length > 0;
  ui.regions[as.id] = {
    counties: countyList, sea, hasLand,
    count: Math.max(1, countyList.length + (sea && hasLand ? 1 : 0)),
    main: main && { county: main.county, town: main.town },
  };
  // 地點自動帶入面積最大的鄉鎮（使用者手動改過就不動）
  if (main && (as.areaAuto !== false || !as.area)) {
    as.area = `${main.county}${main.town}`;
    as.areaAuto = true;
  }
}
const regionCount = (as) => ui.regions[as.id]?.count || 1;
const overLimit = () => totalRegionCount() > MAX_AIRSPACES;
const totalRegionCount = () => state.airspaces.reduce((s, as) => s + regionCount(as), 0);
function regionHtml(as) {
  const r = ui.regions[as.id];
  if (!r || r.count <= 1) return '';
  const why = [r.counties.length > 1 ? `跨縣市（${r.counties.map(esc).join('、')}）` : '', r.sea && r.hasLand ? '跨海岸線' : ''].filter(Boolean).join('、');
  return `<div class="notice danger">⚠️ 此空域${why}，計為 <b>${r.count} 個空域</b>，建議依縣市／海岸線拆開繪製</div>`;
}
function airspaceCountHtml() {
  const n = totalRegionCount();
  const over = n > MAX_AIRSPACES;
  return `<div class="notice ${over ? 'danger' : 'info'}">空域數：<b>${n} / ${MAX_AIRSPACES}</b>${n !== state.airspaces.length ? `（共 ${state.airspaces.length} 塊，跨縣市或跨海岸線的會計為多個）` : ''}
    ${over ? `<br>⚠️ 超過每個專案 ${MAX_AIRSPACES} 個空域的上限，請刪除或調整空域後才能繼續` : ''}</div>`;
}

// ═══════════════════════════════════════════════════════════════
// 地圖
// ═══════════════════════════════════════════════════════════════
const map = L.map('map', { zoomControl: true }).setView([23.75, 120.95], 8);
const baseLayers = {
  'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
  }),
  '國土測繪 電子地圖': L.tileLayer('https://wmts.nlsc.gov.tw/wmts/EMAP/default/GoogleMapsCompatible/{z}/{y}/{x}', {
    maxZoom: 19, attribution: '&copy; 內政部國土測繪中心',
  }),
  '國土測繪 正射影像': L.tileLayer('https://wmts.nlsc.gov.tw/wmts/PHOTO2/default/GoogleMapsCompatible/{z}/{y}/{x}', {
    maxZoom: 19, attribution: '&copy; 內政部國土測繪中心',
  }),
};
baseLayers['OpenStreetMap'].addTo(map);

map.createPane('caa').style.zIndex = 350;
map.createPane('airspace').style.zIndex = 420;
map.createPane('cand').style.zIndex = 590;
const caaRenderer = L.canvas({ pane: 'caa' });

const airspaceGroup = L.layerGroup().addTo(map);
const editGroup = L.layerGroup().addTo(map);
const drawGroup = L.layerGroup().addTo(map);
const candGroup = L.layerGroup().addTo(map);
const launchGroup = L.layerGroup().addTo(map);
const elevGroup = L.layerGroup().addTo(map);
const airportGroup = L.layerGroup().addTo(map);
const layerControl = L.control.layers(baseLayers, {}, { collapsed: true }).addTo(map);
layerControl.addOverlay(candGroup, '🌳 起飛點候選（公園／戶外停車場）');
L.control.scale({ imperial: false }).addTo(map);

const shapeById = {};
new ResizeObserver(() => map.invalidateSize()).observe(map.getContainer());

// ── 民航局限制區 ──
function classifyZone(props) {
  const cat = props?.['空域類別名稱'] || props?.['空域類別'] || '';
  const name = props?.['空域名稱'] || '';
  if (cat.includes('機場') || AIRFIELD_KEYWORDS.some((k) => name.includes(k))) return '機場';
  if (cat.includes('飛航情報限航區') || cat.includes('RCR') || name.includes('RCR')) return 'RCR區域';
  return '其他限制區';
}
// 民航局伺服器不允許瀏覽器跨網域讀取，改讀 GitHub Actions 每日更新的檔案；失敗再用內建 RCR 快照
async function fetchCaaData() {
  try {
    const res = await fetch('data/caa_zones.geojson', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.statusText);
    return await res.json();
  } catch {
    const res = await fetch('data/rcr_fallback.geojson');
    return { ...(await res.json()), source: 'fallback' };
  }
}
async function loadCaaZones() {
  try {
    const data = await fetchCaaData();
    const groups = { '機場': [], 'RCR區域': [], '其他限制區': [] };
    for (const f of data.features || []) {
      if (!f.geometry) continue;
      const type = classifyZone(f.properties);
      groups[type].push(f);
      ui.caa.items.push({ feature: f, bbox: turf.bbox(f), type });
    }
    const emoji = { '機場': '✈️', 'RCR區域': '🔴', '其他限制區': '🟡' };
    for (const [type, feats] of Object.entries(groups)) {
      if (!feats.length) continue;
      const layer = L.geoJSON({ type: 'FeatureCollection', features: feats }, {
        pane: 'caa', renderer: caaRenderer,
        style: (f) => {
          const c = CAA_COLOR[f.properties?.['空域顏色']] || '#b71c1c';
          return { color: c, weight: 1.5, fillColor: c, fillOpacity: 0.12, dashArray: '5,3' };
        },
        onEachFeature: (f, l) => {
          const p = f.properties || {};
          l.bindTooltip(`${esc(p['空域名稱'] || '限制區')}`, { sticky: true });
          l.bindPopup(`<b>${esc(p['空域名稱'] || '限制區')}</b><br>
            類別：${esc(p['空域類別名稱'] || p['空域類別'] || '')}<br>
            ${p['空域顏色'] ? `顏色：${esc(p['空域顏色'])}<br>` : ''}
            ${p['主管機關名稱'] ? `主管機關：${esc(p['主管機關名稱'])}<br>` : ''}
            ${p['條件'] ? `條件：${esc(p['條件'])}<br>` : ''}
            ${p['有效日期起'] ? `有效：${esc(fmtCaaDate(p['有效日期起']))} ~ ${esc(fmtCaaDate(p['有效日期迄']))}` : ''}`, { maxWidth: 300 });
        },
      });
      layer.addTo(map);
      layerControl.addOverlay(layer, `${emoji[type]} 民航局限制區（${type}，${feats.length}筆）`);
    }
    $('#caaStatus').textContent = data.source === 'live'
      ? `民航局限制區：${new Date(data.fetched_at * 1000).toLocaleDateString('zh-TW')} 更新，${data.features.length} 筆（僅供參考，以民航局公告為準）`
      : `⚠️ 無法載入民航局限制區，改用內建 RCR 離線快照（${data.features.length} 筆）`;
    state.airspaces.forEach(updateWarnings);
    renderPanel();
  } catch (err) {
    $('#caaStatus').textContent = `⚠️ 民航局限制區載入失敗：${err.message}`;
  }
}
function fmtCaaDate(v) {
  if (!v) return '';
  const d = new Date(typeof v === 'number' ? v : Date.parse(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('zh-TW');
}
function setCaaInteractive(on) { map.getPane('caa').style.pointerEvents = on ? '' : 'none'; }

function updateWarnings(as) {
  const w = { zones: [], kinks: false };
  if (as.type === 'polygon' && as.points.length >= 4) {
    try { w.kinks = turf.kinks(asFeature(as)).features.length > 0; } catch { /* ignore */ }
  }
  if (ui.caa.items.length) {
    const feat = asFeature(as);
    const [w0, s0, e0, n0] = turf.bbox(feat);
    const seen = new Set();
    for (const it of ui.caa.items) {
      const [w1, s1, e1, n1] = it.bbox;
      if (w1 > e0 || e1 < w0 || s1 > n0 || n1 < s0) continue;
      try {
        if (turf.booleanIntersects(feat, it.feature)) {
          const p = it.feature.properties || {};
          const label = `${p['空域名稱'] || '限制區'}${p['空域顏色'] ? `（${p['空域顏色']}）` : ''}`;
          if (!seen.has(label)) { seen.add(label); w.zones.push(label); }
        }
      } catch { /* 幾何異常略過 */ }
    }
  }
  ui.warnings[as.id] = w;
}

// ── 空域繪製 ──
function renderAirspaces() {
  airspaceGroup.clearLayers();
  for (const k of Object.keys(shapeById)) delete shapeById[k];
  state.airspaces.forEach((as) => {
    const selected = as.id === ui.selectedAirspaceId;
    const style = { color: as.color, weight: selected ? 3.5 : 2, fillColor: as.color, fillOpacity: selected ? 0.22 : 0.15, pane: 'airspace' };
    if (as.type === 'polygon' && as.points.length < 3) return;
    const shape = as.type === 'circle' ? L.circle(as.center, { radius: as.radius, ...style }) : L.polygon(as.points, style);
    shape.bindTooltip(as.name, { sticky: true });
    shape.on('click', (e) => {
      if (ui.mode !== 'none') return;
      if (state.step === 1 || state.step === 4) {
        L.DomEvent.stopPropagation(e);
        selectAirspace(as.id);
      }
    });
    shape.addTo(airspaceGroup);
    shapeById[as.id] = shape;
  });
  renderEditHandles();
  renderElevation();
  renderAirportLines();
}

// 最高點標記
function renderElevation() {
  elevGroup.clearLayers();
  state.airspaces.forEach((as) => {
    const ev = as.elev;
    if (!elevReady(as)) return;
    L.marker([ev.lat, ev.lng], {
      icon: L.divIcon({ className: '', html: '<div class="peak-icon">▲</div>', iconSize: [0, 0] }),
      interactive: true, keyboard: false,
    }).bindTooltip(`${as.name} 最大地表高度 約 ${ev.ft.toLocaleString()} ft（${ev.m} m）`, { direction: 'top' }).addTo(elevGroup);
  });
}
// 空域最近點 → 跑道頭的距離線
function renderAirportLines() {
  airportGroup.clearLayers();
  state.airspaces.forEach((as) => {
    (ui.airports[as.id] || []).forEach((a) => {
      L.polyline([a.p, a.th], { color: '#c62828', weight: 2, dashArray: '6,5', interactive: false })
        .bindTooltip(`${a.nm.toFixed(2)} NM（${(a.nm * NM / 1000).toFixed(2)} km）`, { permanent: true, direction: 'center', className: 'dist-label' })
        .addTo(airportGroup);
      L.circleMarker(a.th, { radius: 5, color: '#c62828', fillColor: '#fff', fillOpacity: 1, weight: 2 })
        .bindTooltip(`${a.name} RWY ${a.rwy} 跑道頭`, { direction: 'top' })
        .addTo(airportGroup);
    });
  });
}

const vtxIcon = L.divIcon({ className: '', html: '<div class="vtx-icon"></div>', iconSize: [0, 0] });
const midIcon = L.divIcon({ className: '', html: '<div class="mid-icon"></div>', iconSize: [0, 0] });
const radiusIcon = L.divIcon({ className: '', html: '<div class="radius-icon"></div>', iconSize: [0, 0] });

function renderEditHandles() {
  editGroup.clearLayers();
  const as = getAs(ui.selectedAirspaceId);
  if (!as || ui.mode !== 'none' || !(state.step === 1 || state.step === 4)) return;
  const shape = shapeById[as.id];
  if (!shape) return;

  if (as.type === 'polygon') {
    as.points.forEach((p, idx) => {
      const m = L.marker(p, { icon: vtxIcon, draggable: true, zIndexOffset: 1000, title: '拖曳移動；點擊可刪除' });
      m.on('dragstart', () => editGroup.eachLayer((l) => l.options.isMid && l.setOpacity(0)));
      m.on('drag', (e) => {
        const ll = e.target.getLatLng();
        as.points[idx] = [ll.lat, ll.lng];
        shape.setLatLngs(as.points);
      });
      m.on('dragend', () => commitAirspaceEdit(as));
      m.on('click', (e) => { L.DomEvent.stopPropagation(e); openVertexPopup(as, idx); });
      m.on('contextmenu', () => deleteVertex(as, idx));
      editGroup.addLayer(m);
    });
    if (as.points.length < MAX_POLY_POINTS) {
      as.points.forEach((p, idx) => {
        const q = as.points[(idx + 1) % as.points.length];
        const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        const m = L.marker(mid, { icon: midIcon, draggable: true, isMid: true, title: '拖曳或點擊新增頂點' });
        let insertedAt = null;
        m.on('dragstart', () => { as.points.splice(idx + 1, 0, mid.slice()); insertedAt = idx + 1; });
        m.on('drag', (e) => {
          const ll = e.target.getLatLng();
          as.points[insertedAt] = [ll.lat, ll.lng];
          shape.setLatLngs(as.points);
        });
        m.on('dragend', () => commitAirspaceEdit(as));
        m.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          as.points.splice(idx + 1, 0, mid);
          commitAirspaceEdit(as);
        });
        editGroup.addLayer(m);
      });
    }
  } else {
    const handlePos = () => {
      const d = turf.destination([as.center[1], as.center[0]], as.radius / 1000, 90, { units: 'kilometers' }).geometry.coordinates;
      return [d[1], d[0]];
    };
    const rHandle = L.marker(handlePos(), { icon: radiusIcon, draggable: true, zIndexOffset: 1000, title: '拖曳調整半徑' });
    const cHandle = L.marker(as.center, { icon: vtxIcon, draggable: true, zIndexOffset: 1000, title: '拖曳移動圓心' });
    cHandle.on('drag', (e) => {
      const ll = e.target.getLatLng();
      as.center = [ll.lat, ll.lng];
      shape.setLatLng(ll);
      rHandle.setLatLng(handlePos());
    });
    cHandle.on('dragend', () => commitAirspaceEdit(as));
    rHandle.on('drag', (e) => {
      const ll = e.target.getLatLng();
      as.radius = Math.max(10, distM(as.center, [ll.lat, ll.lng]));
      shape.setRadius(as.radius);
      const input = document.querySelector(`[data-as-field="radius"][data-id="${as.id}"]`);
      if (input) input.value = Math.round(as.radius);
    });
    rHandle.on('dragend', () => { as.radius = Math.round(as.radius); commitAirspaceEdit(as); });
    editGroup.addLayer(cHandle);
    editGroup.addLayer(rHandle);
  }
}

function openVertexPopup(as, idx) {
  const el = document.createElement('div');
  const p = as.points[idx];
  el.innerHTML = `<b>${esc(as.name)} 頂點 ${idx + 1}</b><br><span class="coord">${esc(fmtCoord(p))}</span>
    <div class="popup-actions"><button class="btn danger small" ${as.points.length <= 3 ? 'disabled' : ''}>🗑 刪除此頂點</button></div>
    ${as.points.length <= 3 ? '<div class="meta">多邊形至少需要 3 個點</div>' : ''}`;
  el.querySelector('button').addEventListener('click', () => { map.closePopup(); deleteVertex(as, idx); });
  L.popup({ offset: [0, -4] }).setLatLng(p).setContent(el).openOn(map);
}
function deleteVertex(as, idx) {
  if (as.points.length <= 3) { toast('多邊形至少需要 3 個點', 'error'); return; }
  as.points.splice(idx, 1);
  commitAirspaceEdit(as);
}

// 空域幾何變動後重算：限制區重疊、機場距離、最大地表高度
function refreshDerived(as) {
  updateRegions(as);
  updateWarnings(as);
  updateAirports(as);
  refreshElevation(as);
}
function commitAirspaceEdit(as) {
  refreshDerived(as);
  save();
  renderAirspaces();
  renderLaunch();
  renderCandidates();
  renderPanel();
  const outside = lpsOf(as.id).filter((p) => !insideAirspace(as, p.lat, p.lng));
  if (outside.length) toast(`${as.name} 有 ${outside.length} 個起飛點已在空域外，請到「預計起飛地點」調整`, 'error');
}

function selectAirspace(id, fly = false) {
  ui.selectedAirspaceId = id;
  renderAirspaces();
  renderPanel();
  const as = getAs(id);
  if (fly && as && shapeById[id]) map.fitBounds(shapeById[id].getBounds(), { padding: [60, 60], maxZoom: 17 });
  requestAnimationFrame(() => document.querySelector(`[data-card="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
}

// ── 繪圖模式 ──
function setMode(mode, extra = {}) {
  ui.mode = mode;
  Object.assign(ui, extra);
  const drawing = mode !== 'none';
  map.getContainer().classList.toggle('mode-draw', drawing);
  setCaaInteractive(!drawing);
  if (mode === 'drawPolygon') map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
  updateHint();
  renderEditHandles();
  renderLaunch();
  renderPanel();
}
function updateHint() {
  const hint = $('#mapHint');
  let text = '';
  if (ui.mode === 'drawPolygon') {
    const n = ui.draw.points.length;
    text = n < 3
      ? `多邊形：在地圖上依序點選頂點（已點 ${n}/${MAX_POLY_POINTS}）`
      : `已點 ${n}/${MAX_POLY_POINTS}：點第一個點、雙擊或按 Enter 完成；Backspace 復原；Esc 取消`;
  } else if (ui.mode === 'drawCircle') {
    text = ui.draw.center ? '移動滑鼠調整半徑，再點一下完成（Esc 取消）' : '圓形：先點選圓心位置';
  } else if (ui.mode === 'addLaunch') {
    text = `新增起飛點：點選「${getAs(ui.addFor)?.name}」範圍內的位置，或點候選點（Esc 取消）`;
  } else if (ui.mode === 'moveLaunch') {
    const lp = getLp(ui.selectedLaunchId);
    text = `移動起飛點 ${lp ? launchLabel(lp) : ''}：點選空域內新位置或候選點，也可直接拖曳（Esc 取消）`;
  }
  hint.hidden = !text;
  hint.textContent = text;
}
function startDraw(type) {
  if (totalRegionCount() >= MAX_AIRSPACES) { toast(`每個專案最多 ${MAX_AIRSPACES} 個空域（跨縣市或跨海岸線的空域會計為多個）`, 'error'); return; }
  ui.selectedAirspaceId = null;
  ui.draw = { points: [], center: null, mouse: null };
  setMode(type === 'polygon' ? 'drawPolygon' : 'drawCircle');
  renderAirspaces();
  renderDraw();
}
function cancelMode() {
  ui.draw = null;
  ui.addFor = null;
  if (ui.mode === 'moveLaunch') ui.selectedLaunchId = null;
  drawGroup.clearLayers();
  setMode('none');
}
function renderDraw() {
  drawGroup.clearLayers();
  const d = ui.draw;
  if (!d) return;
  if (ui.mode === 'drawPolygon') {
    const pts = d.points;
    if (pts.length) {
      const line = d.mouse ? [...pts, d.mouse] : pts;
      L.polyline(line, { color: '#ff6f00', weight: 2, dashArray: '6,4', interactive: false }).addTo(drawGroup);
      if (pts.length >= 2 && d.mouse) L.polyline([d.mouse, pts[0]], { color: '#ff6f00', weight: 1, opacity: 0.5, dashArray: '2,6', interactive: false }).addTo(drawGroup);
      pts.forEach((p, i) => {
        const icon = L.divIcon({ className: '', html: `<div class="draw-dot ${i === 0 ? 'first' : ''}"></div>`, iconSize: [0, 0] });
        const m = L.marker(p, { icon, interactive: i === 0 && pts.length >= 3 });
        if (i === 0) m.on('click', (e) => { L.DomEvent.stopPropagation(e); finishPolygon(); });
        m.addTo(drawGroup);
      });
    }
  } else if (ui.mode === 'drawCircle' && d.center) {
    L.marker(d.center, { icon: L.divIcon({ className: '', html: '<div class="draw-dot"></div>', iconSize: [0, 0] }), interactive: false }).addTo(drawGroup);
    if (d.mouse) {
      const r = distM(d.center, d.mouse);
      L.circle(d.center, { radius: r, color: '#ff6f00', weight: 2, dashArray: '6,4', fillOpacity: 0.08, interactive: false }).addTo(drawGroup);
      L.polyline([d.center, d.mouse], { color: '#ff6f00', weight: 1, interactive: false })
        .bindTooltip(`${Math.round(r)} 公尺`, { permanent: true, direction: 'center', className: 'as-label' }).addTo(drawGroup);
    }
  }
}
function newAirspace(fields) {
  const n = state.asSeq++;
  const as = {
    id: uid('as'), name: `空域${state.airspaces.length + 1}`, area: '',
    color: AS_COLORS[(n - 1) % AS_COLORS.length], ...fields,
  };
  state.airspaces.push(as);
  refreshDerived(as);
  save();
  fillAreaName(as);
  cancelMode();
  selectAirspace(as.id);
  return as;
}
function finishPolygon() {
  const pts = ui.draw?.points || [];
  if (pts.length < 3) { toast('多邊形至少需要 3 個點', 'error'); return; }
  newAirspace({ type: 'polygon', points: pts.slice(0, MAX_POLY_POINTS) });
}
function finishCircle(radius) {
  if (radius < 10) { toast('半徑太小（至少 10 公尺）', 'error'); return; }
  newAirspace({ type: 'circle', center: ui.draw.center, radius: Math.round(radius) });
}
// ── 匯入 KML / KMZ ──
const JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3/+esm';
const kmlEls = (node, name) => [...node.getElementsByTagNameNS('*', name)];
const kmlChild = (node, name) => [...node.children].find((c) => c.localName === name);

async function readKmlText(file) {
  if (!/\.kmz$/i.test(file.name)) return file.text();
  const { default: JSZip } = await import(JSZIP_URL);
  const zip = await JSZip.loadAsync(file);
  const entry = Object.values(zip.files).find((f) => /\.kml$/i.test(f.name));
  if (!entry) throw new Error('KMZ 內找不到 KML 檔');
  return entry.async('string');
}
function parseKmlCoords(text) {
  const pts = [];
  for (const t of text.trim().split(/\s+/)) {
    const [lng, lat] = t.split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lng)) pts.push([lat, lng]);
  }
  return pts;
}
function kmlExtendedData(pm) {
  const data = {};
  kmlEls(pm, 'Data').forEach((d) => { data[d.getAttribute('name')] = kmlChild(d, 'value')?.textContent.trim() ?? ''; });
  kmlEls(pm, 'SimpleData').forEach((d) => { data[d.getAttribute('name')] = d.textContent.trim(); });
  return data;
}
// 逐一移除「與相鄰兩點圍成面積最小」的頂點，直到剩 max 點（保留原始頂點，不產生新點）
function simplifyRing(pts, max) {
  const ring = pts.slice();
  const kx = Math.cos(asCenterOfPoints(ring)[0] * Math.PI / 180);
  const area = (a, b, c) => Math.abs((b[1] - a[1]) * kx * (c[0] - a[0]) - (c[1] - a[1]) * kx * (b[0] - a[0]));
  while (ring.length > max) {
    let minI = 0; let minA = Infinity;
    ring.forEach((p, i) => {
      const a = area(ring[(i - 1 + ring.length) % ring.length], p, ring[(i + 1) % ring.length]);
      if (a < minA) { minA = a; minI = i; }
    });
    ring.splice(minI, 1);
  }
  return ring;
}
const asCenterOfPoints = (pts) => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
// 外環轉成空域：本系統輸出的圓形或看起來是圓的多邊形 → 圓形；超過 6 點 → 簡化
function ringToAirspace(ringIn, meta) {
  const ring = [];
  for (const p of ringIn) {
    const last = ring[ring.length - 1];
    if (!last || distM(last, p) > 0.5) ring.push(p);
  }
  if (ring.length > 1 && distM(ring[0], ring[ring.length - 1]) <= 0.5) ring.pop();
  if (ring.length < 3) return null;
  const center = asCenterOfPoints(ring);
  const radii = ring.map((p) => distM(center, p));
  const meanR = radii.reduce((s, r) => s + r, 0) / radii.length;
  const isCircle = (meta['形狀'] === '圓形' && Number(meta['半徑_公尺']) > 0)
    || (ring.length >= 16 && Math.max(...radii.map((r) => Math.abs(r - meanR))) / meanR < 0.02);
  if (isCircle) {
    return { airspace: { type: 'circle', center, radius: Math.round(Number(meta['半徑_公尺']) || meanR) } };
  }
  if (ring.length <= MAX_POLY_POINTS) return { airspace: { type: 'polygon', points: ring } };
  return { airspace: { type: 'polygon', points: simplifyRing(ring, MAX_POLY_POINTS) }, simplifiedFrom: ring.length };
}
async function importKmlFile(file) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(await readKmlText(file), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('檔案格式錯誤');
  } catch (err) { toast(`無法讀取 ${file.name}：${err.message}`, 'error'); return; }

  if (ui.mode !== 'none') cancelMode();
  const added = []; const notes = []; const points = []; let skipped = 0;
  for (const pm of kmlEls(doc, 'Placemark')) {
    const name = kmlChild(pm, 'name')?.textContent.trim() || '';
    const meta = kmlExtendedData(pm);
    const polys = kmlEls(pm, 'Polygon');
    polys.forEach((poly, k) => {
      if (state.airspaces.length >= MAX_AIRSPACES) { skipped += 1; return; }
      const outer = kmlEls(poly, 'outerBoundaryIs')[0] || poly;
      const coords = kmlEls(outer, 'coordinates')[0];
      const res = coords && ringToAirspace(parseKmlCoords(coords.textContent), meta);
      if (!res) return;
      const n = state.asSeq++;
      const label = name ? (polys.length > 1 ? `${name}-${k + 1}` : name) : `空域${state.airspaces.length + 1}`;
      const as = {
        id: uid('as'), name: label, area: meta['地點'] || '',
        color: AS_COLORS[(n - 1) % AS_COLORS.length], ...res.airspace,
      };
      state.airspaces.push(as);
      added.push(as);
      if (res.simplifiedFrom) notes.push(`「${label}」原有 ${res.simplifiedFrom} 點，已簡化為 ${MAX_POLY_POINTS} 點，請確認形狀`);
    });
    // 本系統匯出的起飛點（名稱「起飛點 1-1 …」或在「預計起飛地點」資料夾內）
    const folder = pm.parentElement?.localName === 'Folder' ? kmlChild(pm.parentElement, 'name')?.textContent || '' : '';
    if (!polys.length && (name.startsWith('起飛點') || folder.includes('起飛'))) {
      const c = kmlEls(pm, 'Point')[0] && kmlEls(kmlEls(pm, 'Point')[0], 'coordinates')[0];
      const pt = c && parseKmlCoords(c.textContent)[0];
      if (pt) points.push({ lat: pt[0], lng: pt[1], name: name.replace(/^起飛點\s*\d+-\d+\s*/, '').trim() });
    }
  }
  if (skipped) notes.push(`已達每個專案 ${MAX_AIRSPACES} 個空域上限，有 ${skipped} 個空域未匯入`);
  if (!added.length) { toast(skipped ? notes[0] : `${file.name} 裡沒有找到多邊形空域`, 'error'); return; }

  let lpCount = 0;
  for (const p of points) {
    const as = added.find((a) => insideAirspace(a, p.lat, p.lng));
    if (!as) continue;
    state.launchPoints.push({ id: uid('lp'), airspaceId: as.id, lat: p.lat, lng: p.lng, name: p.name || '空域內地點', kind: 'manual' });
    lpCount += 1;
  }
  renumberAirspaces();
  added.forEach((as) => { refreshDerived(as); if (!as.area) fillAreaName(as); });
  ui.selectedAirspaceId = added[0].id;
  save();
  renderAirspaces();
  renderLaunch();
  renderPanel();
  map.fitBounds(L.featureGroup(added.map((a) => shapeById[a.id]).filter(Boolean)).getBounds(), { padding: [50, 50], maxZoom: 17 });
  toast(`已匯入 ${added.length} 個空域${lpCount ? `、${lpCount} 個起飛點` : ''}，可直接拖曳修改`, 'ok');
  notes.forEach((m) => toast(m, 'error'));
}

async function fillAreaName(as) {
  try {
    const [lat, lng] = asCenter(as);
    const j = await reverseGeocode(lat, lng);
    if (j.area && !as.area) { as.area = j.area; as.areaAuto = true; save(); renderPanel(); }
  } catch { /* 使用者可手動填 */ }
}

// ── 地圖事件 ──
map.on('click', (e) => {
  const ll = [e.latlng.lat, e.latlng.lng];
  switch (ui.mode) {
    case 'drawPolygon': {
      const pts = ui.draw.points;
      if (pts.length) {
        const last = map.latLngToContainerPoint(pts[pts.length - 1]);
        if (last.distanceTo(e.containerPoint) < 8) return; // 雙擊的第二下
        if (pts.length >= 3 && map.latLngToContainerPoint(pts[0]).distanceTo(e.containerPoint) < 12) { finishPolygon(); return; }
      }
      pts.push(ll);
      if (pts.length >= MAX_POLY_POINTS) { finishPolygon(); toast(`已達上限 ${MAX_POLY_POINTS} 點，自動完成多邊形`); return; }
      renderDraw(); updateHint();
      return;
    }
    case 'drawCircle':
      if (!ui.draw.center) { ui.draw.center = ll; renderDraw(); updateHint(); } else finishCircle(distM(ui.draw.center, ll));
      return;
    case 'addLaunch': {
      const as = getAs(ui.addFor);
      if (!as || !insideAirspace(as, ...ll)) { toast(`起飛點必須在「${as?.name}」範圍內`, 'error'); return; }
      addLaunchPoint(as, { lat: ll[0], lng: ll[1] });
      return;
    }
    case 'moveLaunch': {
      const lp = getLp(ui.selectedLaunchId);
      const as = lp && getAs(lp.airspaceId);
      if (!as) { cancelMode(); return; }
      if (!insideAirspace(as, ...ll)) { toast(`起飛點必須在「${as.name}」範圍內`, 'error'); return; }
      moveLaunchPoint(lp, { lat: ll[0], lng: ll[1] });
      return;
    }
    default:
      if (ui.selectedAirspaceId && (state.step === 1 || state.step === 4)) {
        ui.selectedAirspaceId = null;
        renderAirspaces(); renderPanel();
      }
  }
});
map.on('mousemove', (e) => {
  if ((ui.mode === 'drawPolygon' || ui.mode === 'drawCircle') && ui.draw) {
    ui.draw.mouse = [e.latlng.lat, e.latlng.lng];
    renderDraw();
  }
});
map.on('dblclick', () => { if (ui.mode === 'drawPolygon') finishPolygon(); });
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === 'Escape' && ui.mode !== 'none') cancelMode();
  if (ui.mode === 'drawPolygon') {
    if (e.key === 'Enter') finishPolygon();
    if (e.key === 'Backspace') { e.preventDefault(); ui.draw.points.pop(); renderDraw(); updateHint(); }
  }
});

// ═══════════════════════════════════════════════════════════════
// 起飛點
// ═══════════════════════════════════════════════════════════════
function launchLabel(lp) {
  const asIdx = state.airspaces.findIndex((a) => a.id === lp.airspaceId);
  const k = lpsOf(lp.airspaceId).findIndex((p) => p.id === lp.id);
  return `${asIdx + 1}-${k + 1}`;
}
const kindLabel = { park: '公園', parking: '停車場', temple: '廟宇', manual: '自訂' };

async function ensureCandidates(as, force = false) {
  const key = geomKey(as);
  const cur = ui.candidates[as.id];
  if (!force && cur && cur.key === key && !cur.error) {
    return cur.loading ? cur.loading : cur.list;
  }
  const [w, s, e, n] = turf.bbox(asFeature(as));
  const loading = (async () => {
    try {
      const all = await queryLaunchCandidates(s, w, n, e);
      const list = all.filter((c) => insideAirspace(as, c.lat, c.lng));
      ui.candidates[as.id] = { key, list };
      return list;
    } catch (err) {
      ui.candidates[as.id] = { key, list: [], error: err.message };
      toast(`${as.name} 公園／停車場查詢失敗，改用空域幾何位置：${err.message}`, 'error');
      return [];
    } finally {
      renderCandidates();
      renderPanel();
    }
  })();
  ui.candidates[as.id] = { key, list: [], loading };
  renderPanel();
  return loading;
}

// 空域內的幾何備援點：多邊形各頂點往中心內縮、圓形 16 方位 85% 半徑
function geometricPoints(as) {
  if (as.type === 'circle') {
    const pts = [];
    for (let b = 0; b < 360; b += 22.5) {
      const d = turf.destination([as.center[1], as.center[0]], as.radius * 0.85 / 1000, b, { units: 'kilometers' }).geometry.coordinates;
      pts.push([d[1], d[0]]);
    }
    return pts;
  }
  const c = asCenter(as);
  return as.points.map((v) => {
    for (const t of [0.12, 0.25, 0.4, 0.6]) {
      const p = [v[0] + (c[0] - v[0]) * t, v[1] + (c[1] - v[1]) * t];
      if (insideAirspace(as, ...p)) return p;
    }
    return c;
  });
}
function farthestPair(items, pos, weight = () => 1) {
  let best = null; let bestScore = -1;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const score = distM(pos(items[i]), pos(items[j])) * weight(items[i]) * weight(items[j]);
      if (score > bestScore) { bestScore = score; best = [items[i], items[j]]; }
    }
  }
  return best;
}
// 自動挑 2 個起飛點：候選地點中距離最遠的一對（有名稱的優先）；不足則用對角線幾何點補
function pickLaunchSites(as, candidates) {
  const geo = geometricPoints(as).map((p) => ({ lat: p[0], lng: p[1], name: '', kind: 'manual' }));
  const pos = (c) => [c.lat, c.lng];
  const toLp = (c) => ({ lat: c.lat, lng: c.lng, name: candidateName(c), kind: c.kind });
  const farthestFrom = (c, list) => list.reduce((a, b) => (distM(pos(b), pos(c)) > distM(pos(a), pos(c)) ? b : a));
  const weight = (c) => (c.named ? 1 : 0.85);
  // 依優先順序：公園／戶外停車場 → 廟宇 → 空域對角線幾何點
  const tiers = [candidates.filter((c) => c.kind !== 'temple'), candidates.filter((c) => c.kind === 'temple'), geo];
  for (let t = 0; t < tiers.length; t++) {
    const list = tiers[t];
    if (list.length >= 2) return farthestPair(list, pos, weight).map(toLp);
    if (list.length === 1) {
      const next = tiers.slice(t + 1).find((l) => l.length);
      return [toLp(list[0]), toLp(farthestFrom(list[0], next))];
    }
  }
  return geo.slice(0, 2).map(toLp);
}
async function autoGenerate(as) {
  const list = await ensureCandidates(as);
  const picks = pickLaunchSites(as, list);
  state.launchPoints = state.launchPoints.filter((p) => p.airspaceId !== as.id);
  picks.forEach((p) => {
    const lp = { id: uid('lp'), airspaceId: as.id, ...p };
    state.launchPoints.push(lp);
    if (!lp.name) nameFromReverse(lp);
  });
  save();
  renderLaunch();
  renderPanel();
}
// 沒有名稱的地點用附近路名命名，例：民權路旁停車場
const KIND_WORD = { parking: '停車場', park: '公園綠地', temple: '廟宇', manual: '空地' };
const KIND_FALLBACK = { parking: '戶外停車場', park: '公園綠地', temple: '廟宇', manual: '空域內地點' };
async function nameFromReverse(lp) {
  const word = KIND_WORD[lp.kind] || '空地';
  lp.name = KIND_FALLBACK[lp.kind] || '空域內地點';
  try {
    const j = await reverseGeocode(lp.lat, lp.lng);
    const base = j.road || j.place || j.area;
    if (base) lp.name = `${base}旁${word}`;
  } catch { /* 保留預設名稱 */ }
  save();
  renderLaunch();
  renderPanel();
}
// 拖曳／點選位置若在候選點 40 公尺內，自動吸附並帶入名稱
function snapToCandidate(as, lat, lng) {
  const list = ui.candidates[as.id]?.list || [];
  let best = null; let bestD = 40;
  for (const c of list) {
    const d = distM([lat, lng], [c.lat, c.lng]);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}
// 候選點沒有名稱（named === false）時名稱留空，交給 nameFromReverse 用路名命名
const candidateName = (c) => (c.named === false ? '' : c.name || '');
function addLaunchPoint(as, { lat, lng, name, kind, named }) {
  const snap = name ? null : snapToCandidate(as, lat, lng);
  const src = snap || { lat, lng, name, kind: kind || 'manual', named };
  const lp = { id: uid('lp'), airspaceId: as.id, lat: src.lat, lng: src.lng, name: candidateName(src), kind: src.kind };
  state.launchPoints.push(lp);
  if (!lp.name) nameFromReverse(lp);
  ui.selectedLaunchId = lp.id;
  ui.addFor = null;
  save();
  setMode('none');
  toast(`已新增起飛點 ${launchLabel(lp)}`, 'ok');
}
function moveLaunchPoint(lp, { lat, lng, name, kind, named }) {
  const as = getAs(lp.airspaceId);
  const snap = name ? null : snapToCandidate(as, lat, lng);
  const src = snap || { lat, lng, name, kind: kind || 'manual', named };
  Object.assign(lp, { lat: src.lat, lng: src.lng, kind: src.kind, name: candidateName(src) });
  if (!lp.name) nameFromReverse(lp);
  save();
  setMode('none');
  toast(`起飛點 ${launchLabel(lp)} 已更新`, 'ok');
}
function selectLaunch(id) {
  ui.selectedLaunchId = id;
  ui.addFor = null;
  setMode(state.step === 3 ? 'moveLaunch' : 'none');
  requestAnimationFrame(() => document.querySelector(`[data-lp-row="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
}

function launchIcon(label, color, selected, outside) {
  return L.divIcon({
    className: '',
    html: `<div class="lp-icon ${selected ? 'selected' : ''} ${outside ? 'outside' : ''}" style="background:${color}"><b>${label}</b></div>`,
    iconSize: [0, 0],
  });
}
function renderLaunch() {
  launchGroup.clearLayers();
  if (state.step < 3 && !state.launchPoints.length) return;
  const editable = state.step >= 3 && !['drawPolygon', 'drawCircle'].includes(ui.mode);
  state.launchPoints.forEach((lp) => {
    const as = getAs(lp.airspaceId);
    if (!as) return;
    const label = launchLabel(lp);
    const outside = !insideAirspace(as, lp.lat, lp.lng);
    const m = L.marker([lp.lat, lp.lng], {
      icon: launchIcon(label, as.color, lp.id === ui.selectedLaunchId, outside),
      draggable: editable, zIndexOffset: 800,
    });
    m.bindTooltip(`${esc(lp.name || '')}${outside ? '（在空域外！）' : ''}`, { permanent: true, direction: 'right', offset: [8, -18], className: 'lp-label' });
    m.on('click', (e) => { L.DomEvent.stopPropagation(e); if (editable) selectLaunch(lp.id); });
    m.on('dragend', (e) => {
      const ll = e.target.getLatLng();
      if (!insideAirspace(as, ll.lat, ll.lng)) {
        toast(`起飛點必須在「${as.name}」範圍內`, 'error');
        m.setLatLng([lp.lat, lp.lng]);
        return;
      }
      ui.selectedLaunchId = lp.id;
      moveLaunchPoint(lp, { lat: ll.lat, lng: ll.lng });
    });
    launchGroup.addLayer(m);
  });
}

function candIcon(kind) {
  return L.divIcon({ className: '', html: `<div class="cand-icon ${kind}">${{ parking: 'P', temple: '廟', park: '🌳' }[kind]}</div>`, iconSize: [0, 0] });
}
function renderCandidates() {
  candGroup.clearLayers();
  if (state.step < 3) return;
  state.airspaces.forEach((as) => {
    const c = ui.candidates[as.id];
    if (!c || c.key !== geomKey(as)) return;
    c.list.forEach((cand) => {
      const m = L.marker([cand.lat, cand.lng], { icon: candIcon(cand.kind), pane: 'cand', title: cand.name });
      m.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        if (ui.mode === 'moveLaunch') {
          const lp = getLp(ui.selectedLaunchId);
          if (lp && lp.airspaceId === as.id) { moveLaunchPoint(lp, cand); return; }
        }
        if (ui.mode === 'addLaunch' && ui.addFor === as.id) { addLaunchPoint(as, cand); return; }
        openCandidatePopup(as, cand);
      });
      candGroup.addLayer(m);
    });
  });
}
function openCandidatePopup(as, cand) {
  const el = document.createElement('div');
  const sel = getLp(ui.selectedLaunchId);
  const canReplace = sel && sel.airspaceId === as.id;
  el.innerHTML = `<b>${esc(cand.name)}</b> <span class="tag ${cand.kind}">${kindLabel[cand.kind]}</span><br>
    <span class="meta">${esc(as.name)}｜<span class="coord">${esc(fmtCoord([cand.lat, cand.lng]))}</span></span>
    <div class="popup-actions">
      <button class="btn small" data-a="add">＋ 加入為 ${esc(as.name)} 的起飛點</button>
      ${canReplace ? `<button class="btn ghost small" data-a="replace">↔ 取代起飛點 ${launchLabel(sel)}</button>` : ''}
    </div>`;
  el.querySelector('[data-a="add"]').addEventListener('click', () => { map.closePopup(); addLaunchPoint(as, cand); });
  el.querySelector('[data-a="replace"]')?.addEventListener('click', () => { map.closePopup(); moveLaunchPoint(sel, cand); });
  L.popup({ offset: [0, -8] }).setLatLng([cand.lat, cand.lng]).setContent(el).openOn(map);
}

// ── 起飛點文字 → 作業概述 ──
function buildLaunchText() {
  const lines = [LAUNCH_SECTION_TITLE];
  state.airspaces.forEach((as) => {
    const pts = lpsOf(as.id);
    if (!pts.length) return;
    lines.push(`${as.name}${as.area ? `（${as.area}）` : ''}：`);
    pts.forEach((p, k) => lines.push(`　起飛點${k + 1}：${p.name || '空域內地點'}（${fmtCoord([p.lat, p.lng])}）`));
  });
  return lines.join('\n');
}
// 起飛點段落 = 標題行，加上後面「以：結尾的空域行」或「全形空白開頭的起飛點行」
const LAUNCH_BLOCK_RE = /【預計起飛地點】[^\n]*(?:\n(?:　[^\n]*|[^\n]*：[ \t]*))*/;
// 結語永遠是最後一行：移除其他位置的結語行，再補在最後
function ensureClosing(overview) {
  const lines = overview.replace(/\r\n/g, '\n').split('\n').filter((l) => !CLOSING_RE.test(l));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return [...lines, CLOSING_LINE].join('\n');
}
function mergeLaunchText(overview) {
  const block = buildLaunchText();
  if (LAUNCH_BLOCK_RE.test(overview)) return ensureClosing(overview.replace(LAUNCH_BLOCK_RE, block));
  const text = ensureClosing(overview);
  const before = text.slice(0, text.lastIndexOf(CLOSING_LINE)).trimEnd();
  return `${before ? `${before}\n` : ''}${block}\n${CLOSING_LINE}`;
}
// 第一段 = 起飛點段落（或結語）之前的文字
function introEnd(overview) {
  const m = overview.match(LAUNCH_BLOCK_RE);
  if (m) return m.index;
  const i = overview.lastIndexOf(CLOSING_LINE);
  return i >= 0 ? i : overview.length;
}
const extractIntro = (overview) => overview.slice(0, introEnd(overview)).trim();
function replaceIntro(overview, intro) {
  const rest = overview.slice(introEnd(overview)).trim();
  return ensureClosing(`${intro.trim()}\n${rest}`);
}
function insertLaunchIntoOverview() {
  if (!state.launchPoints.length) { toast('目前沒有起飛點', 'error'); return; }
  state.overview = mergeLaunchText(state.overview);
  save();
  renderPanel();
  toast('已將預計起飛地點貼到作業概述', 'ok');
}

// ═══════════════════════════════════════════════════════════════
// AI 擴寫（使用者自己的 Claude API 金鑰，只存在這個瀏覽器，不會進專案檔）
// ═══════════════════════════════════════════════════════════════
const ANTHROPIC_SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk/+esm';
const AI_MODEL = 'claude-opus-5-5';
const API_KEY_STORAGE = 'caaDroneApp.apiKey';
const AI_SYSTEM_PROMPT = `你是協助台灣無人機業者撰寫「交通部民用航空局 遙控無人機活動申請」作業概述的文書助理。
使用者會提供作業概述第一段的草稿，請潤飾、擴充後輸出。格式固定如下，只輸出這一段：

本案係辦理「片名」紀錄片，受委託單位委託，拍攝規劃與內容。因素材拍攝範圍廣，須執行人群聚集或室外集會遊行上空活動、視距外操作及夜間飛行等操作限制。

規則：
1. 片名、委託單位照草稿保留。拍攝規劃與內容依草稿改寫成一到三句通順的公文語氣，說明拍攝主題、場景與方式，可提及作業地點。
2. 草稿中仍是「XX」或「(拍攝規劃與內容)」等未填的部分，寫成【待確認：項目】，不要自行編造。
3. 最後一句「因素材拍攝範圍廣，須執行人群聚集或室外集會遊行上空活動、視距外操作及夜間飛行等操作限制。」照原文保留。
4. 使用台灣正體中文，只輸出這一段純文字：不要標題、不要換行、不要 Markdown、不要其他說明。`;

function getApiKey() {
  try { return localStorage.getItem(API_KEY_STORAGE) || ''; } catch { return ''; }
}
function setApiKey(key) {
  try {
    if (key) localStorage.setItem(API_KEY_STORAGE, key); else localStorage.removeItem(API_KEY_STORAGE);
  } catch { toast('此瀏覽器無法儲存金鑰（可能是無痕模式）', 'error'); }
}

// 給 AI 的空域資料只有名稱與地點（高度、機場距離等不帶入作業概述）
function airspaceSummary() {
  return state.airspaces.map((as) => `${as.name}：${as.area || '未填地點'}`).join('\n');
}
async function runAiExpand() {
  if (!getApiKey()) { toast('請先在上方設定 Claude API 金鑰', 'error'); return; }
  const draft = extractIntro(state.overview);
  if (!draft || draft === DEFAULT_INTRO) { toast('請先在作業概述第一段填入片名、委託單位與拍攝內容', 'error'); return; }
  const original = state.overview;
  ui.aiBusy = true;
  renderPanel();
  const ta = () => document.querySelector('[data-field="overview"]');
  let Anthropic;
  try {
    ({ default: Anthropic } = await import(ANTHROPIC_SDK_URL));
    const client = new Anthropic({ apiKey: getApiKey(), dangerouslyAllowBrowser: true });
    const userMsg = `第一段草稿：\n${draft}\n\n作業地點：\n${airspaceSummary() || '（無）'}`;
    const stream = client.beta.messages.stream({
      model: AI_MODEL,
      max_tokens: 16000,
      system: AI_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    let text = '';
    stream.on('text', (delta) => {
      text += delta;
      state.overview = replaceIntro(original, text);
      const el = ta();
      if (el) el.value = state.overview;
    });
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') { state.overview = original; throw new Error('AI 拒絕產生此內容，請修改第一段後再試'); }
    if (final.stop_reason === 'max_tokens') text += '【內容過長被截斷】';
    state.overview = replaceIntro(original, text);
    toast('AI 已完成作業概述，可直接修改', 'ok');
  } catch (err) {
    let msg = err.message;
    if (!Anthropic) msg = '無法載入 Claude SDK，請檢查網路連線';
    else if (err instanceof Anthropic.AuthenticationError) msg = 'API 金鑰無效，請重新設定';
    else if (err instanceof Anthropic.RateLimitError) msg = '請求太頻繁或額度不足，請稍後再試';
    else if (err instanceof Anthropic.APIConnectionError) msg = '無法連線 Claude API，請檢查網路';
    else if (err instanceof Anthropic.APIError) msg = `Claude API 錯誤（${err.status ?? ''}）：${err.message}`;
    state.overview = original;
    toast(`AI 生成失敗：${msg}`, 'error');
  } finally {
    ui.aiBusy = false;
    save();
    renderPanel();
  }
}

// ═══════════════════════════════════════════════════════════════
// 匯出
// ═══════════════════════════════════════════════════════════════
function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const DOCX_URL = 'https://cdn.jsdelivr.net/npm/docx@9/+esm';
const safeName = (s) => (s || '未命名案件').replace(/[\\/:*?"<>|]/g, '_');
const xmlEsc = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
function kmlColor(hex, alpha) { // #rrggbb → aabbggrr
  const h = hex.replace('#', '');
  return `${alpha}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`;
}
function buildKml(airspaces, docName) {
  const styles = airspaces.map((as, i) => `
    <Style id="as${i}"><LineStyle><color>${kmlColor(as.color, 'ff')}</color><width>2.5</width></LineStyle><PolyStyle><color>${kmlColor(as.color, '55')}</color></PolyStyle></Style>`).join('');
  const placemarks = airspaces.map((as, i) => {
    const ring = asFeature(as).geometry.coordinates[0];
    // KML 外環建議逆時針
    const ccw = turf.booleanClockwise(ring) ? ring.slice().reverse() : ring;
    const coords = ccw.map(([lng, lat]) => `${lng.toFixed(7)},${lat.toFixed(7)},0`).join(' ');
    const desc = [
      `地點：${as.area || ''}`,
      as.type === 'circle' ? `圓形：圓心 ${fmtCoord(as.center)}，半徑 ${Math.round(as.radius)} 公尺` : `多邊形頂點：${as.points.map(fmtCoord).join('；')}`,
    ].filter(Boolean).join('<br>');
    return `
    <Placemark>
      <name>${xmlEsc(as.name)}</name>
      <description><![CDATA[${desc}]]></description>
      <styleUrl>#as${i}</styleUrl>
      <ExtendedData>
        <Data name="地點"><value>${xmlEsc(as.area)}</value></Data>
        <Data name="形狀"><value>${as.type === 'circle' ? '圓形' : '多邊形'}</value></Data>
        ${as.type === 'circle' ? `<Data name="半徑_公尺"><value>${Math.round(as.radius)}</value></Data>` : ''}
        <Data name="CKWT座標"><value>${xmlEsc(ckwtList(as))}</value></Data>
      </ExtendedData>
      <Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon>
    </Placemark>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${xmlEsc(docName)}</name>${styles}
    <Folder><name>作業空域</name>${placemarks}
    </Folder>
  </Document>
</kml>
`;
}
// 每個空域一個檔案，檔名：地點_空域N（例：宜蘭縣宜蘭市_空域1.kml）
const kmlFileBase = (as) => safeName(`${as.area.trim() || '未填地點'}_${as.name.trim() || '空域'}`);
async function exportKml() {
  if (!state.airspaces.length) { toast('尚未繪製任何空域', 'error'); return; }
  for (const [i, as] of state.airspaces.entries()) {
    if (i) await new Promise((r) => setTimeout(r, 400)); // 連續下載間隔，避免瀏覽器略過
    const base = kmlFileBase(as);
    download(new Blob([buildKml([as], base)], { type: 'application/vnd.google-earth.kml+xml' }), `${base}.kml`);
  }
  if (state.airspaces.length > 1) toast(`已輸出 ${state.airspaces.length} 個 KML 檔（瀏覽器若詢問「允許下載多個檔案」請按允許）`, 'ok');
}
// PDF：以列印版面開啟系統列印視窗，選「另存為 PDF」（文字可選取、檔案小，不需另外載入中文字型）
const DOC_SECTION_RE = /^([一二三四五六七八九十]+、|【)/;
function exportPdf() {
  if (!state.overview.trim()) { toast('作業概述是空的', 'error'); return; }
  const caseName = state.caseName.trim() || '未命名案件';
  const fileTitle = `${safeName(caseName)}_作業概述`;
  state.overview = ensureClosing(state.overview);
  const body = state.overview.trim().split('\n')
    .map((line) => `<p class="${DOC_SECTION_RE.test(line.trim()) ? 'sec' : ''}">${esc(line) || '&nbsp;'}</p>`).join('');
  const html = `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><title>${esc(fileTitle)}</title><style>
    @page { size: A4; margin: 25mm; }
    body { font-family: "BiauKai", "DFKai-SB", "標楷體", "Kaiti TC", "STKaiti", serif; font-size: 12pt; line-height: 1.5; color: #000; margin: 0; }
    p { margin: 0; white-space: pre-wrap; }
    .sec { font-weight: bold; }
  </style></head><body>
    <p class="sec">作業概述</p>
    ${body}
  </body></html>`;
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(iframe);
  const pageTitle = document.title;
  iframe.onload = () => {
    document.title = fileTitle; // 部分瀏覽器用主頁標題當 PDF 預設檔名
    iframe.contentWindow.addEventListener('afterprint', () => { document.title = pageTitle; setTimeout(() => iframe.remove(), 500); });
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
  };
  iframe.srcdoc = html;
}
async function exportWord() {
  if (!state.overview.trim()) { toast('作業概述是空的', 'error'); return; }
  try {
    const d = await import(DOCX_URL);
    const caseName = state.caseName.trim() || '未命名案件';
    const font = { ascii: '標楷體', eastAsia: '標楷體', hAnsi: '標楷體', cs: '標楷體' };
    const run = (text, sizePt, bold = false) => new d.TextRun({ text, bold, size: sizePt * 2, font });
    // 「一、」「【預計起飛地點】」這類段落標題加粗，其餘照原文換行輸出
    state.overview = ensureClosing(state.overview);
    const body = state.overview.trim().split('\n').map((line) => new d.Paragraph({
      spacing: { line: 360, after: 0 },
      children: [run(line, 12, DOC_SECTION_RE.test(line.trim()))],
    }));
    const margin = d.convertMillimetersToTwip(25);
    const doc = new d.Document({
      sections: [{
        properties: { page: { margin: { top: margin, bottom: margin, left: margin, right: margin } } },
        children: [
          new d.Paragraph({ spacing: { line: 360, after: 0 }, children: [run('作業概述', 12, true)] }),
          ...body,
        ],
      }],
    });
    download(await d.Packer.toBlob(doc), `${safeName(caseName)}_作業概述.docx`);
  } catch (err) {
    toast(`Word 輸出失敗：${err.message}`, 'error');
  }
}
function saveProject() {
  download(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }), `${safeName(state.caseName)}_專案.json`);
}
function openProject(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.airspaces)) throw new Error('格式不符');
      state = migrate({ ...newState(), version: 1, ...data });
      resetView();
      toast('專案已開啟', 'ok');
    } catch (err) { toast(`無法開啟專案檔：${err.message}`, 'error'); }
  };
  reader.readAsText(file);
}
function resetView() {
  ui.candidates = {};
  ui.warnings = {};
  ui.airports = {};
  ui.regions = {};
  ui.selectedAirspaceId = null;
  ui.selectedLaunchId = null;
  state.airspaces.forEach(refreshDerived);
  save();
  cancelMode();
  goStep(state.step || 1, true);
  fitAll();
}
function fitAll() {
  const layers = Object.values(shapeById);
  if (layers.length) map.fitBounds(L.featureGroup(layers).getBounds(), { padding: [50, 50], maxZoom: 17 });
}

// ═══════════════════════════════════════════════════════════════
// 步驟與面板
// ═══════════════════════════════════════════════════════════════
function goStep(n, force = false) {
  if (n > 1 && !state.airspaces.length) { toast('請先繪製至少一個空域', 'error'); n = 1; }
  if (!force && n > state.step && overLimit()) { toast(`空域數超過 ${MAX_AIRSPACES} 個上限，請先調整空域`, 'error'); return; }
  if (!force && n === state.step) return;
  if (ui.mode !== 'none') cancelMode();
  state.step = n;
  ui.selectedLaunchId = null;
  if (n !== 1 && n !== 4) ui.selectedAirspaceId = null;
  state.overview = n === 4 && state.launchPoints.length ? mergeLaunchText(state.overview) : ensureClosing(state.overview);
  save();
  renderAirspaces();
  renderLaunch();
  renderCandidates();
  renderPanel();
  $('#panel').scrollTop = 0;
  if (n === 3) {
    state.airspaces.forEach((as) => {
      if (!lpsOf(as.id).length) autoGenerate(as);
      else ensureCandidates(as);
    });
  }
}

function renderStepper() {
  document.querySelectorAll('#stepper button').forEach((b) => {
    const s = Number(b.dataset.step);
    b.classList.toggle('active', s === state.step);
    b.classList.toggle('done', s < state.step);
    b.disabled = s > 1 && !state.airspaces.length;
  });
}

function renderPanel() {
  renderStepper();
  const panel = $('#panel');
  // 避免打字時重繪導致游標跳掉：保留焦點欄位
  const active = document.activeElement;
  const focusKey = active && panel.contains(active) ? focusSignature(active) : null;
  const selStart = active?.selectionStart; const selEnd = active?.selectionEnd;
  const scroll = panel.scrollTop;

  panel.innerHTML = [null, renderStep1, renderStep2, renderStep3, renderStep4][state.step]();

  panel.scrollTop = scroll;
  if (focusKey) {
    const el = panel.querySelector(focusKey);
    if (el) {
      el.focus();
      try { if (selStart != null) el.setSelectionRange(selStart, selEnd); } catch { /* number input */ }
    }
  }
}
function focusSignature(el) {
  for (const attr of ['data-field', 'data-as-field', 'data-lp-field']) {
    if (el.hasAttribute(attr)) {
      const id = el.dataset.id ? `[data-id="${el.dataset.id}"]` : '';
      return `[${attr}="${el.getAttribute(attr)}"]${id}`;
    }
  }
  return null;
}

function footer(left, right) {
  return `<div class="panel-footer"><div class="btn-row">${left || ''}</div><div class="btn-row">${right || ''}</div></div>`;
}

function airspaceInfoHtml(as) {
  const w = ui.warnings[as.id] || { zones: [] };
  const area = asArea(as);
  return `
    ${as.type === 'circle'
      ? `<div class="inline"><span class="meta">圓形　半徑</span>
           <input type="number" min="10" step="10" data-as-field="radius" data-id="${as.id}" value="${Math.round(as.radius)}"><span class="meta">公尺</span></div>
         <div class="meta">圓心 <span class="coord">${esc(fmtCoord(as.center))}</span></div>`
      : `<div class="meta">多邊形 ${as.points.length}/${MAX_POLY_POINTS} 點</div>`}
    <div class="meta">面積約 ${(area / 1e4).toFixed(2)} 公頃（${Math.round(area).toLocaleString()} m²）</div>
    ${regionHtml(as)}
    ${elevationHtml(as)}
    ${airportHtml(as)}
    ${w.kinks ? '<div class="notice danger">⚠️ 多邊形邊線交錯，請拖曳頂點修正</div>' : ''}
    ${w.zones.length ? `<details class="notice warn"><summary>⚠️ 與 ${w.zones.length} 處民航局公告限制區重疊（點開查看）</summary>${w.zones.map(esc).join('<br>')}</details>` : ''}`;
}

function renderStep1() {
  const drawing = ui.mode === 'drawPolygon' || ui.mode === 'drawCircle';
  const n = ui.draw?.points?.length || 0;
  const cards = state.airspaces.map((as) => `
    <div class="card ${as.id === ui.selectedAirspaceId ? 'selected' : ''}" data-card="${as.id}">
      <div class="card-head">
        <span class="swatch" style="background:${as.color}"></span>
        <input type="text" data-as-field="name" data-id="${as.id}" value="${esc(as.name)}">
      </div>
      <label class="field">地點<input type="text" data-as-field="area" data-id="${as.id}" value="${esc(as.area)}" placeholder="自動帶入縣市鄉鎮"></label>
      ${airspaceInfoHtml(as)}
      <div class="btn-row">
        <button class="btn ghost small" data-action="as-select" data-id="${as.id}">${as.id === ui.selectedAirspaceId ? '✏️ 編輯中' : '✏️ 選取編輯'}</button>
        <button class="btn danger small" data-action="as-delete" data-id="${as.id}">🗑 刪除</button>
      </div>
    </div>`).join('');

  return `<div class="panel-body">
    <div>
      <h2>步驟 1　繪製作業空域</h2>
      <p class="lead">在地圖上畫出申請的飛航空域，或匯入 KML（也可把檔案拖到地圖上），可有多個。多邊形最多 ${MAX_POLY_POINTS} 個點；選取後可直接拖曳頂點、點虛線圓點新增頂點、點頂點刪除。</p>
    </div>
    <div class="btn-row">
      <button class="btn ${ui.mode === 'drawPolygon' ? 'active' : ''}" data-action="draw-polygon">⬠ 畫多邊形</button>
      <button class="btn ${ui.mode === 'drawCircle' ? 'active' : ''}" data-action="draw-circle">◯ 畫圓形</button>
      <button class="btn ghost" data-action="kml-import" title="匯入 KML／KMZ 檔，也可以直接把檔案拖到地圖上">📂 匯入 KML</button>
      ${drawing ? '<button class="btn ghost" data-action="mode-cancel">取消</button>' : ''}
    </div>
    ${ui.mode === 'drawPolygon' ? `<div class="notice info">已點 <b>${n}/${MAX_POLY_POINTS}</b> 點。點回第一點、雙擊或按「完成」結束。
      <div class="btn-row" style="margin-top:6px">
        <button class="btn small" data-action="draw-finish" ${n < 3 ? 'disabled' : ''}>✔ 完成</button>
        <button class="btn ghost small" data-action="draw-undo" ${n ? '' : 'disabled'}>↶ 復原上一點</button>
      </div></div>` : ''}
    ${ui.mode === 'drawCircle' ? '<div class="notice info">先點圓心，再點一下決定半徑；完成後可在下方輸入精確半徑或拖曳方形把手。</div>' : ''}
    ${state.airspaces.length ? airspaceCountHtml() : ''}
    ${cards || '<div class="empty">尚未建立空域<br>點上方「畫多邊形」或「畫圓形」開始</div>'}
  </div>
  ${footer(
    `<button class="btn ghost" data-action="export-kml" ${state.airspaces.length && !overLimit() ? '' : 'disabled'}>⬇ 輸出 KML</button>`,
    `<button class="btn" data-action="next" ${state.airspaces.length && !overLimit() ? '' : 'disabled'}>下一步：案名與作業概述 →</button>`,
  )}`;
}

function caseNameOptionsHtml() {
  return `<div class="inline case-options">
      <label class="inline"><input type="checkbox" data-field="highAltitude" ${state.highAltitude ? 'checked' : ''}> 400 呎以上（案名加註 ${HIGH_ALT_SUFFIX}）</label>
      ${state.caseNameAuto ? '<span class="meta">（依預設格式自動產生）</span>' : '<button class="btn ghost tiny" data-action="case-name-default">↻ 套用預設格式</button>'}
    </div>`;
}

function renderStep2() {
  const hasKey = Boolean(getApiKey());
  const aiNote = hasKey
    ? `<details class="notice ok"><summary>✓ 已設定 Claude API 金鑰（只存在這個瀏覽器）</summary>
         <div class="btn-row" style="margin-top:6px"><button class="btn danger tiny" data-action="api-key-clear">清除金鑰</button></div></details>`
    : `<div class="notice warn">AI 擴充需要你自己的 Claude API 金鑰（可到 <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a> 申請）。
         金鑰只會存在這個瀏覽器，直接傳給 Claude，不會上傳到其他地方，也不會存進專案檔。沒有金鑰也可以手動撰寫作業概述。
         <div class="inline" style="margin-top:6px">
           <input type="password" id="apiKeyInput" placeholder="sk-ant-..." autocomplete="off">
           <button class="btn small" data-action="api-key-save">儲存</button>
         </div></div>`;
  return `<div class="panel-body">
    <div>
      <h2>步驟 2　案名與作業概述</h2>
      <p class="lead">在作業概述第一段填入片名（XX）、委託單位（XX）與拍攝規劃與內容，可按 AI 潤飾第一段；未填的部分會以【待確認】標示。【預計起飛地點】會在下一步貼入。</p>
    </div>
    <label class="field">案名<input type="text" data-field="caseName" value="${esc(state.caseName)}"></label>
    ${caseNameOptionsHtml()}
    <label class="field">作業概述
      <textarea class="overview" data-field="overview" ${ui.aiBusy ? 'readonly' : ''}>${esc(state.overview)}</textarea>
    </label>
    <div class="btn-row">
      <button class="btn" data-action="ai-expand" ${ui.aiBusy ? 'disabled' : ''}>${ui.aiBusy ? '<span class="spinner"></span> AI 撰寫中…' : '✨ AI 潤飾第一段'}</button>
      <button class="btn ghost small" data-action="overview-reset">↺ 還原預設範本</button>
    </div>
    ${aiNote}
  </div>
  ${footer(
    '<button class="btn ghost" data-action="prev">← 上一步</button>',
    '<button class="btn" data-action="next">下一步：預計起飛地點 →</button>',
  )}`;
}

function coordFormatSelect() {
  return `<label class="field">座標格式
    <select data-field="coordFormat">
      <option value="dms" ${state.coordFormat === 'dms' ? 'selected' : ''}>度分秒（N24°51'30.12" E121°49'03.45"）</option>
      <option value="ckwt" ${state.coordFormat === 'ckwt' ? 'selected' : ''}>民航局 CKWT（245130.12,1214903.45）</option>
      <option value="decimal" ${state.coordFormat === 'decimal' ? 'selected' : ''}>十進位度（24.858367, 121.817625）</option>
    </select></label>`;
}

function launchRowsHtml(as, compact = false) {
  return lpsOf(as.id).map((lp) => {
    const outside = !insideAirspace(as, lp.lat, lp.lng);
    const sel = lp.id === ui.selectedLaunchId;
    return `<div class="lp-row ${sel ? 'selected' : ''} ${outside ? 'outside' : ''}" data-lp-row="${lp.id}">
      <span class="lp-badge" style="background:${as.color}">${launchLabel(lp)}</span>
      <div>
        <input type="text" data-lp-field="name" data-id="${lp.id}" value="${esc(lp.name)}">
        <div class="meta"><span class="tag ${lp.kind}">${kindLabel[lp.kind] || '自訂'}</span> <span class="coord">${esc(fmtCoord([lp.lat, lp.lng]))}</span>
        ${outside ? '<br><b style="color:var(--danger)">⚠️ 已在空域外，請移動</b>' : ''}</div>
      </div>
      <div class="lp-actions">
        ${compact ? '' : `<button class="btn ghost tiny" data-action="lp-move" data-id="${lp.id}" title="在地圖上點選新位置">${sel && ui.mode === 'moveLaunch' ? '移動中' : '移動'}</button>`}
        <button class="btn danger tiny" data-action="lp-delete" data-id="${lp.id}" title="刪除">✕</button>
      </div>
    </div>`;
  }).join('') || '<div class="meta">尚無起飛點</div>';
}

function renderStep3() {
  const groups = state.airspaces.map((as) => {
    const c = ui.candidates[as.id];
    const status = !c ? '' : c.loading ? '<span class="spinner"></span> 搜尋公園／停車場中…'
      : c.error ? `⚠️ 查詢失敗（${esc(c.error)}）`
      : `空域內找到 ${c.list.filter((x) => x.kind === 'park').length} 處公園、${c.list.filter((x) => x.kind === 'parking').length} 處戶外停車場、${c.list.filter((x) => x.kind === 'temple').length} 處廟宇`;
    const adding = ui.mode === 'addLaunch' && ui.addFor === as.id;
    return `<div class="card" data-card="${as.id}">
      <div class="card-head"><span class="swatch" style="background:${as.color}"></span><b>${esc(as.name)}</b><span class="meta">${esc(as.area)}</span></div>
      <div class="meta">${status}</div>
      ${launchRowsHtml(as)}
      <div class="btn-row">
        <button class="btn ghost small ${adding ? 'active' : ''}" data-action="lp-add" data-id="${as.id}">${adding ? '請點地圖…' : '＋ 新增起飛點'}</button>
        <button class="btn ghost small" data-action="lp-regen" data-id="${as.id}">🔄 重新自動產生</button>
        <button class="btn ghost small" data-action="as-zoom" data-id="${as.id}">🔍 定位</button>
      </div>
    </div>`;
  }).join('');

  return `<div class="panel-body">
    <div>
      <h2>步驟 3　預計起飛地點</h2>
      <p class="lead">每個空域自動產生 2 個起飛點：優先挑空域內<b>相距最遠</b>的公園或戶外停車場，不足時用廟宇，再不足才用空域對角線位置。
      點選地圖上的起飛點後，再點新位置或候選點（🌳公園／P停車場／廟）即可修改，也可直接拖曳（拖到候選點旁會自動吸附）。</p>
    </div>
    ${ui.mode === 'moveLaunch' ? `<div class="notice info">正在移動起飛點 <b>${launchLabel(getLp(ui.selectedLaunchId) || {})}</b>：點選空域內新位置或候選點。<button class="btn ghost tiny" data-action="mode-cancel">取消</button></div>` : ''}
    ${ui.mode === 'addLaunch' ? '<div class="notice info">點選空域內的位置或候選點以新增。<button class="btn ghost tiny" data-action="mode-cancel">取消</button></div>' : ''}
    ${groups}
    ${coordFormatSelect()}
    <div class="card">
      <h3>貼到作業概述的內容預覽</h3>
      <pre class="preview">${esc(buildLaunchText())}</pre>
      <button class="btn" data-action="lp-insert">📋 貼到作業概述</button>
      <div class="meta">若作業概述已有【預計起飛地點】段落，會整段更新。</div>
    </div>
  </div>
  ${footer(
    '<button class="btn ghost" data-action="prev">← 上一步</button>',
    '<button class="btn" data-action="next">下一步：確認與輸出 →</button>',
  )}`;
}

function renderStep4() {
  const outsideCount = state.launchPoints.filter((lp) => { const as = getAs(lp.airspaceId); return as && !insideAirspace(as, lp.lat, lp.lng); }).length;
  const asCards = state.airspaces.map((as) => `
    <div class="card ${as.id === ui.selectedAirspaceId ? 'selected' : ''}" data-card="${as.id}">
      <div class="card-head">
        <span class="swatch" style="background:${as.color}"></span>
        <input type="text" data-as-field="name" data-id="${as.id}" value="${esc(as.name)}">
        <button class="btn ghost tiny" data-action="as-select" data-id="${as.id}" title="在地圖上編輯形狀">✏️</button>
      </div>
      <label class="field">地點<input type="text" data-as-field="area" data-id="${as.id}" value="${esc(as.area)}"></label>
      ${airspaceInfoHtml(as)}
      <div class="meta">KML 檔名：<b>${esc(kmlFileBase(as))}.kml</b></div>
      <div class="meta">CKWT 座標${as.type === 'circle' ? '（圓心）' : ''}：</div>
      <div class="inline"><input type="text" class="coord" readonly value="${esc(ckwtList(as))}"><button class="btn ghost tiny" data-action="copy" data-text="${esc(ckwtList(as))}">複製</button></div>
      <div class="meta"><b>起飛點</b></div>
      ${launchRowsHtml(as, true)}
    </div>`).join('');

  return `<div class="panel-body">
    <div>
      <h2>步驟 4　確認與輸出</h2>
      <p class="lead">所有欄位都可在此修改；地圖上點空域可再調整形狀、拖曳起飛點。確認後輸出 Word（案名＋作業概述）與 KML（空域）。</p>
    </div>
    ${outsideCount ? `<div class="notice danger">⚠️ 有 ${outsideCount} 個起飛點在空域外，請拖曳修正。</div>` : ''}
    <label class="field">案名<input type="text" data-field="caseName" value="${esc(state.caseName)}"></label>
    ${caseNameOptionsHtml()}
    <label class="field">作業概述
      <textarea class="overview" data-field="overview">${esc(state.overview)}</textarea>
    </label>
    <div class="btn-row">
      <button class="btn ghost small" data-action="lp-insert">📋 重新貼上最新起飛點</button>
    </div>
    ${coordFormatSelect()}
    <h3>空域與起飛點</h3>
    ${asCards}
  </div>
  ${footer(
    '<button class="btn ghost" data-action="prev">← 上一步</button>',
    `<button class="btn ghost small" data-action="export-kml" ${overLimit() ? 'disabled' : ''}>🗺 KML</button>
     <button class="btn ghost small" data-action="export-pdf" ${overLimit() ? 'disabled' : ''}>📑 PDF</button>
     <button class="btn small" data-action="export-word" ${overLimit() ? 'disabled' : ''}>📄 Word</button>`,
  )}`;
}

// ── 面板事件（委派）──
const panelEl = $('#panel');
panelEl.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.field) {
    const key = t.dataset.field;
    state[key] = t.type === 'checkbox' ? t.checked : t.value;
    if (key === 'caseName') state.caseNameAuto = false;
    if (key === 'highAltitude' && !state.caseNameAuto) {
      // 手動改過的案名：只加上或拿掉結尾的 (高空)
      const base = state.caseName.trimEnd().replace(/\(高空\)$/, '').trimEnd();
      state.caseName = state.highAltitude ? `${base}${HIGH_ALT_SUFFIX}` : base;
    }
    save();
    if (key === 'coordFormat' || key === 'highAltitude') renderPanel();
    return;
  }
  if (t.dataset.asField) {
    const as = getAs(t.dataset.id);
    if (!as) return;
    const f = t.dataset.asField;
    if (f === 'radius') {
      const r = Number(t.value);
      if (r >= 10) { as.radius = r; shapeById[as.id]?.setRadius(r); renderEditHandles(); }
    } else {
      as[f] = t.value;
      if (f === 'area') as.areaAuto = false;
      if (f === 'name' && asNumber(as.name) != null && state.airspaces.indexOf(as) !== Math.min(asNumber(as.name), state.airspaces.length) - 1) {
        moveByName(as);
        save();
        renderAirspaces();
        renderLaunch();
        renderPanel();
        requestAnimationFrame(() => document.querySelector(`[data-card="${as.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
        return;
      }
    }
    save();
    return;
  }
  if (t.dataset.lpField) {
    const lp = getLp(t.dataset.id);
    if (lp) { lp[t.dataset.lpField] = t.value; save(); }
  }
});
panelEl.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.field === 'overview') {
    state.overview = ensureClosing(state.overview);
    t.value = state.overview;
    save();
    return;
  }
  if (t.dataset.asField) {
    const as = getAs(t.dataset.id);
    if (!as) return;
    if (t.dataset.asField === 'radius') { commitAirspaceEdit(as); return; }
    if (t.dataset.asField === 'name' && moveByName(as)) {
      save();
      renderAirspaces();
      renderLaunch();
      renderPanel();
      requestAnimationFrame(() => document.querySelector(`[data-card="${as.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
      return;
    }
    renderAirspaces();
    renderLaunch();
    if (t.dataset.asField === 'area') renderPanel();
  }
  if (t.dataset.lpField) renderLaunch();
});
panelEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (btn) handleAction(btn.dataset.action, btn.dataset, btn);
});
$('#stepper').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-step]');
  if (b && !b.disabled) goStep(Number(b.dataset.step));
});
document.querySelector('.top-actions').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (btn) handleAction(btn.dataset.action, btn.dataset, btn);
});
$('#kmlFile').addEventListener('change', async (e) => {
  for (const f of e.target.files) await importKmlFile(f);
  e.target.value = '';
});
// 把 KML／KMZ 拖到地圖上即可匯入
const mapWrap = $('.map-wrap');
mapWrap.addEventListener('dragover', (e) => { e.preventDefault(); mapWrap.classList.add('drop-hover'); });
mapWrap.addEventListener('dragleave', () => mapWrap.classList.remove('drop-hover'));
mapWrap.addEventListener('drop', async (e) => {
  e.preventDefault();
  mapWrap.classList.remove('drop-hover');
  const files = [...e.dataTransfer.files].filter((f) => /\.km[lz]$/i.test(f.name));
  if (!files.length) { toast('請拖入 .kml 或 .kmz 檔', 'error'); return; }
  if (state.step !== 1) goStep(1);
  for (const f of files) await importKmlFile(f);
});
$('#projectFile').addEventListener('change', (e) => {
  if (e.target.files[0]) openProject(e.target.files[0]);
  e.target.value = '';
});

function handleAction(action, data, btn) {
  const as = data.id ? getAs(data.id) : null;
  switch (action) {
    case 'next': goStep(state.step + 1); break;
    case 'prev': goStep(state.step - 1); break;
    case 'draw-polygon': startDraw('polygon'); break;
    case 'draw-circle': startDraw('circle'); break;
    case 'draw-finish': finishPolygon(); break;
    case 'draw-undo': ui.draw.points.pop(); renderDraw(); updateHint(); renderPanel(); break;
    case 'mode-cancel': cancelMode(); break;
    case 'as-select':
      if (ui.mode !== 'none') cancelMode();
      selectAirspace(data.id, true);
      break;
    case 'as-zoom':
      if (shapeById[data.id]) map.fitBounds(shapeById[data.id].getBounds(), { padding: [60, 60], maxZoom: 17 });
      break;
    case 'as-delete': {
      const n = lpsOf(data.id).length;
      if (!confirm(`確定刪除「${as.name}」${n ? `及其 ${n} 個起飛點` : ''}？`)) return;
      state.airspaces = state.airspaces.filter((a) => a.id !== data.id);
      state.launchPoints = state.launchPoints.filter((p) => p.airspaceId !== data.id);
      if (ui.selectedAirspaceId === data.id) ui.selectedAirspaceId = null;
      renumberAirspaces();
      save(); renderAirspaces(); renderLaunch(); renderCandidates(); renderPanel();
      break;
    }
    case 'lp-add':
      ui.selectedLaunchId = null;
      if (ui.mode === 'addLaunch' && ui.addFor === data.id) cancelMode();
      else { setMode('addLaunch', { addFor: data.id }); if (shapeById[data.id]) map.fitBounds(shapeById[data.id].getBounds(), { padding: [60, 60], maxZoom: 17 }); }
      break;
    case 'lp-move': {
      const lp = getLp(data.id);
      if (ui.mode === 'moveLaunch' && ui.selectedLaunchId === data.id) { cancelMode(); break; }
      selectLaunch(data.id);
      map.panTo([lp.lat, lp.lng]);
      break;
    }
    case 'lp-delete': {
      state.launchPoints = state.launchPoints.filter((p) => p.id !== data.id);
      if (ui.selectedLaunchId === data.id) { ui.selectedLaunchId = null; if (ui.mode === 'moveLaunch') setMode('none'); }
      save(); renderLaunch(); renderPanel();
      break;
    }
    case 'lp-regen':
      if (lpsOf(data.id).length && !confirm(`重新產生會取代「${as.name}」目前的起飛點，確定？`)) return;
      autoGenerate(as);
      break;
    case 'lp-insert': insertLaunchIntoOverview(); break;
    case 'ai-expand': runAiExpand(); break;
    case 'api-key-save': {
      const key = $('#apiKeyInput')?.value.trim();
      if (!key) { toast('請輸入金鑰', 'error'); return; }
      setApiKey(key);
      renderPanel();
      toast('金鑰已儲存在這個瀏覽器', 'ok');
      break;
    }
    case 'api-key-clear':
      setApiKey('');
      renderPanel();
      toast('金鑰已清除');
      break;
    case 'export-kml': exportKml(); break;
    case 'export-word': exportWord(); break;
    case 'export-pdf': exportPdf(); break;
    case 'overview-reset':
      if (!confirm('作業概述會還原成預設範本（起飛點段落會保留），確定？')) return;
      state.overview = replaceIntro(state.overview, DEFAULT_INTRO);
      save();
      renderPanel();
      break;
    case 'case-name-default':
      state.caseNameAuto = true;
      save();
      renderPanel();
      break;
    case 'copy':
      navigator.clipboard.writeText(data.text).then(() => toast('已複製', 'ok'), () => toast('複製失敗', 'error'));
      break;
    case 'project-new':
      if (!confirm('確定開新案件？目前資料會清除（建議先「儲存專案」）。')) return;
      state = newState();
      resetView();
      map.setView([23.75, 120.95], 8);
      break;
    case 'project-open': $('#projectFile').click(); break;
    case 'kml-import': $('#kmlFile').click(); break;
    case 'project-save': saveProject(); break;
    default: break;
  }
}

// ── 地點搜尋 ──
$('#mapSearch').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#mapSearchInput').value.trim();
  if (!q) return;
  try {
    const results = await nominatim('search', { q, limit: 5, countrycodes: 'tw' });
    if (!results.length) { toast('找不到這個地點'); return; }
    const r = results[0];
    const bb = r.boundingbox?.map(Number); // [south, north, west, east]
    if (bb) map.fitBounds([[bb[0], bb[2]], [bb[1], bb[3]]], { maxZoom: 17 });
    else map.setView([Number(r.lat), Number(r.lon)], 16);
    toast(r.display_name);
  } catch (err) { toast(`搜尋失敗：${err.message}`, 'error'); }
});

// ── 啟動 ──
(function init() {
  save();
  state.airspaces.forEach(refreshDerived);
  renderAirspaces();
  goStep(state.step || 1, true);
  fitAll();
  loadCaaZones();
  loadRunways();
  loadTowns();
})();
