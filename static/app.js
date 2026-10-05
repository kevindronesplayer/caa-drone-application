'use strict';
// ═══════════════════════════════════════════════════════════════
// 民航局無人機申請資料填寫系統 — 前端
// 步驟：1 繪製空域 → 2 案名與作業概述 → 3 預計起飛地點 → 4 確認與輸出
// ═══════════════════════════════════════════════════════════════

const MAX_POLY_POINTS = 6;
const STORAGE_KEY = 'caaDroneApp.v1';
const AS_COLORS = ['#1565c0', '#7b1fa2', '#00897b', '#ef6c00', '#c2185b', '#5d4037', '#283593', '#2e7d32'];
const LAUNCH_SECTION_TITLE = '【預計起飛地點】';
const CAA_COLOR = { '紅區': '#c62828', '黃區': '#f9a825', '灰區': '#757575' };
const AIRFIELD_KEYWORDS = ['機場', '飛行場', '航空技術學院', '飛行訓練指揮部'];

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── 狀態 ──────────────────────────────────────────────────────
function newState() {
  return {
    version: 1, step: 1, caseName: '', draft: '', overview: '',
    coordFormat: 'dms', includeLaunchInKml: false,
    airspaces: [], launchPoints: [], seq: 1, asSeq: 1,
  };
}
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...newState(), ...JSON.parse(raw) } : null;
  } catch { return null; }
}
let state = loadState() || newState();
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* 無痕模式等 */ }
  $('#caseLabel').textContent = state.caseName || '未命名案件';
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
  aiReady: null,
  aiBusy: false,
};

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
async function loadCaaZones() {
  try {
    const res = await fetch('/api/caa-zones');
    const data = await res.json();
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
      ? `民航局限制區：即時資料 ${data.features.length} 筆（僅供參考，以民航局公告為準）`
      : `⚠️ 無法連線民航局圖資，改用內建 RCR 離線快照（${data.features.length} 筆）`;
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
    shape.bindTooltip(`${as.name}｜${as.height} 公尺`, { sticky: true });
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

function commitAirspaceEdit(as) {
  updateWarnings(as);
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
    id: uid('as'), name: `空域${n}`, area: '', height: 120,
    color: AS_COLORS[(n - 1) % AS_COLORS.length], ...fields,
  };
  state.airspaces.push(as);
  updateWarnings(as);
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
async function fillAreaName(as) {
  try {
    const [lat, lng] = asCenter(as);
    const res = await fetch(`/api/reverse?lat=${lat}&lng=${lng}`);
    const j = await res.json();
    if (j.area && !as.area) { as.area = j.area; save(); renderPanel(); }
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
const kindLabel = { park: '公園', parking: '停車場', manual: '自訂' };

async function ensureCandidates(as, force = false) {
  const key = geomKey(as);
  const cur = ui.candidates[as.id];
  if (!force && cur && cur.key === key && !cur.error) {
    return cur.loading ? cur.loading : cur.list;
  }
  const [w, s, e, n] = turf.bbox(asFeature(as));
  const loading = (async () => {
    try {
      const res = await fetch('/api/launch-candidates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ south: s, west: w, north: n, east: e }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.statusText);
      const list = j.candidates.filter((c) => insideAirspace(as, c.lat, c.lng));
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
  if (candidates.length >= 2) {
    return farthestPair(candidates, pos, (c) => (c.named ? 1 : 0.85)).map((c) => ({ lat: c.lat, lng: c.lng, name: c.name, kind: c.kind }));
  }
  if (candidates.length === 1) {
    const c = candidates[0];
    const far = geo.reduce((a, b) => (distM(pos(b), pos(c)) > distM(pos(a), pos(c)) ? b : a));
    return [{ lat: c.lat, lng: c.lng, name: c.name, kind: c.kind }, far];
  }
  return farthestPair(geo, pos) || geo.slice(0, 2);
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
async function nameFromReverse(lp) {
  lp.name = '空域內地點';
  try {
    const res = await fetch(`/api/reverse?lat=${lp.lat}&lng=${lp.lng}`);
    const j = await res.json();
    if (j.place || j.area) lp.name = j.place ? `${j.place}附近空地` : `${j.area}空地`;
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
function addLaunchPoint(as, { lat, lng, name, kind }) {
  const snap = name ? null : snapToCandidate(as, lat, lng);
  const lp = {
    id: uid('lp'), airspaceId: as.id,
    lat: snap ? snap.lat : lat, lng: snap ? snap.lng : lng,
    name: snap ? snap.name : (name || ''), kind: snap ? snap.kind : (kind || 'manual'),
  };
  state.launchPoints.push(lp);
  if (!lp.name) nameFromReverse(lp);
  ui.selectedLaunchId = lp.id;
  ui.addFor = null;
  save();
  setMode('none');
  toast(`已新增起飛點 ${launchLabel(lp)}`, 'ok');
}
function moveLaunchPoint(lp, { lat, lng, name, kind }) {
  const as = getAs(lp.airspaceId);
  const snap = name ? null : snapToCandidate(as, lat, lng);
  lp.lat = snap ? snap.lat : lat;
  lp.lng = snap ? snap.lng : lng;
  lp.kind = snap ? snap.kind : (kind || 'manual');
  lp.name = snap ? snap.name : (name || '');
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
    m.bindTooltip(`起飛點 ${label}：${lp.name || ''}${outside ? '（在空域外！）' : ''}`, { direction: 'top', offset: [0, -30] });
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
  return L.divIcon({ className: '', html: `<div class="cand-icon ${kind}">${kind === 'parking' ? 'P' : '🌳'}</div>`, iconSize: [0, 0] });
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
// 已有【預計起飛地點】段落就整段取代（到下一個空白行為止），否則附加在最後
function mergeLaunchText(overview) {
  const block = buildLaunchText();
  const re = /【預計起飛地點】[^\n]*(?:\n[^\n]*\S[^\n]*)*/;
  if (re.test(overview)) return overview.replace(re, block);
  return overview.trim() ? `${overview.trimEnd()}\n\n${block}` : block;
}
function insertLaunchIntoOverview() {
  if (!state.launchPoints.length) { toast('目前沒有起飛點', 'error'); return; }
  state.overview = mergeLaunchText(state.overview);
  save();
  renderPanel();
  toast('已將預計起飛地點貼到作業概述', 'ok');
}

// ═══════════════════════════════════════════════════════════════
// AI 擴寫
// ═══════════════════════════════════════════════════════════════
function airspaceSummary() {
  return state.airspaces.map((as) => {
    const lines = [`${as.name}`, `  地點：${as.area || '未填'}`];
    if (as.type === 'circle') lines.push(`  範圍：圓形，圓心 ${fmtCoord(as.center)}，半徑 ${Math.round(as.radius)} 公尺`);
    else lines.push(`  範圍：多邊形 ${as.points.length} 點，頂點 ${as.points.map(fmtCoord).join('；')}`);
    lines.push(`  面積：約 ${(asArea(as) / 1e4).toFixed(2)} 公頃`);
    lines.push(`  飛航高度：距地面 ${as.height} 公尺（約 ${ft(as.height)} 呎）以下`);
    const w = ui.warnings[as.id];
    if (w?.zones.length) lines.push(`  與民航局公告限制區重疊：${w.zones.join('、')}`);
    const pts = lpsOf(as.id);
    if (pts.length) lines.push(`  預計起飛點：${pts.map((p) => p.name).join('、')}`);
    return lines.join('\n');
  }).join('\n');
}
async function runAiExpand() {
  if (!state.draft.trim()) { toast('請先輸入作業大致內容', 'error'); return; }
  if (state.overview.trim() && !confirm('作業概述已有內容，AI 生成會覆蓋（起飛點段落會保留）。確定繼續？')) return;
  const hadLaunch = state.overview.includes(LAUNCH_SECTION_TITLE);
  ui.aiBusy = true;
  renderPanel();
  const ta = () => document.querySelector('[data-field="overview"]');
  try {
    const res = await fetch('/api/ai-expand', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ case_name: state.caseName, draft: state.draft, airspace_summary: airspaceSummary() }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || res.statusText);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      state.overview = text;
      const el = ta();
      if (el) { el.value = text; el.scrollTop = el.scrollHeight; }
    }
    state.overview = text.trim();
    if (hadLaunch && state.launchPoints.length) state.overview = mergeLaunchText(state.overview);
    toast('AI 已完成作業概述，可直接修改', 'ok');
  } catch (err) {
    toast(`AI 生成失敗：${err.message}`, 'error');
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
const safeName = (s) => (s || '未命名案件').replace(/[\\/:*?"<>|]/g, '_');
const xmlEsc = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
function kmlColor(hex, alpha) { // #rrggbb → aabbggrr
  const h = hex.replace('#', '');
  return `${alpha}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`;
}
function buildKml(includeLaunch) {
  const styles = state.airspaces.map((as, i) => `
    <Style id="as${i}"><LineStyle><color>${kmlColor(as.color, 'ff')}</color><width>2.5</width></LineStyle><PolyStyle><color>${kmlColor(as.color, '55')}</color></PolyStyle></Style>`).join('');
  const placemarks = state.airspaces.map((as, i) => {
    const ring = asFeature(as).geometry.coordinates[0];
    // KML 外環建議逆時針
    const ccw = turf.booleanClockwise(ring) ? ring.slice().reverse() : ring;
    const coords = ccw.map(([lng, lat]) => `${lng.toFixed(7)},${lat.toFixed(7)},0`).join(' ');
    const desc = [
      `地點：${as.area || ''}`,
      `高度：${as.height} 公尺（約 ${ft(as.height)} 呎）`,
      as.type === 'circle' ? `圓形：圓心 ${fmtCoord(as.center)}，半徑 ${Math.round(as.radius)} 公尺` : `多邊形頂點：${as.points.map(fmtCoord).join('；')}`,
    ].join('<br>');
    return `
    <Placemark>
      <name>${xmlEsc(as.name)}</name>
      <description><![CDATA[${desc}]]></description>
      <styleUrl>#as${i}</styleUrl>
      <ExtendedData>
        <Data name="地點"><value>${xmlEsc(as.area)}</value></Data>
        <Data name="高度_公尺"><value>${xmlEsc(as.height)}</value></Data>
        <Data name="形狀"><value>${as.type === 'circle' ? '圓形' : '多邊形'}</value></Data>
        ${as.type === 'circle' ? `<Data name="半徑_公尺"><value>${Math.round(as.radius)}</value></Data>` : ''}
        <Data name="CKWT座標"><value>${xmlEsc(ckwtList(as))}</value></Data>
      </ExtendedData>
      <Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon>
    </Placemark>`;
  }).join('');
  const launch = includeLaunch && state.launchPoints.length ? `
    <Folder><name>預計起飛地點</name>${state.launchPoints.map((lp) => `
      <Placemark><name>起飛點 ${launchLabel(lp)} ${xmlEsc(lp.name)}</name>
        <description>${xmlEsc(`${getAs(lp.airspaceId)?.name || ''}｜${fmtCoord([lp.lat, lp.lng])}`)}</description>
        <Point><coordinates>${lp.lng.toFixed(7)},${lp.lat.toFixed(7)},0</coordinates></Point></Placemark>`).join('')}
    </Folder>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${xmlEsc(state.caseName || '無人機作業空域')}</name>${styles}
    <Folder><name>作業空域</name>${placemarks}
    </Folder>${launch}
  </Document>
</kml>
`;
}
function exportKml() {
  if (!state.airspaces.length) { toast('尚未繪製任何空域', 'error'); return; }
  const includeLaunch = state.step >= 3 && state.includeLaunchInKml;
  download(new Blob([buildKml(includeLaunch)], { type: 'application/vnd.google-earth.kml+xml' }), `${safeName(state.caseName)}_空域.kml`);
}
async function exportWord() {
  if (!state.overview.trim()) { toast('作業概述是空的', 'error'); return; }
  try {
    const res = await fetch('/api/export-docx', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ case_name: state.caseName, overview: state.overview }),
    });
    if (!res.ok) throw new Error(res.statusText);
    download(await res.blob(), `${safeName(state.caseName)}_作業概述.docx`);
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
      state = { ...newState(), ...data };
      resetView();
      toast('專案已開啟', 'ok');
    } catch (err) { toast(`無法開啟專案檔：${err.message}`, 'error'); }
  };
  reader.readAsText(file);
}
function resetView() {
  ui.candidates = {};
  ui.warnings = {};
  ui.selectedAirspaceId = null;
  ui.selectedLaunchId = null;
  state.airspaces.forEach(updateWarnings);
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
  if (!force && n === state.step) return;
  if (ui.mode !== 'none') cancelMode();
  state.step = n;
  ui.selectedLaunchId = null;
  if (n !== 1 && n !== 4) ui.selectedAirspaceId = null;
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
      <div class="grid2">
        <label class="field">地點<input type="text" data-as-field="area" data-id="${as.id}" value="${esc(as.area)}" placeholder="自動帶入縣市鄉鎮"></label>
        <label class="field">最大高度（公尺）<input type="number" min="1" data-as-field="height" data-id="${as.id}" value="${esc(as.height)}"><small>約 ${ft(as.height)} 呎</small></label>
      </div>
      ${airspaceInfoHtml(as)}
      <div class="btn-row">
        <button class="btn ghost small" data-action="as-select" data-id="${as.id}">${as.id === ui.selectedAirspaceId ? '✏️ 編輯中' : '✏️ 選取編輯'}</button>
        <button class="btn danger small" data-action="as-delete" data-id="${as.id}">🗑 刪除</button>
      </div>
    </div>`).join('');

  return `<div class="panel-body">
    <div>
      <h2>步驟 1　繪製作業空域</h2>
      <p class="lead">在地圖上畫出申請的飛航空域，可畫多個。多邊形最多 ${MAX_POLY_POINTS} 個點；選取後可直接拖曳頂點、點虛線圓點新增頂點、點頂點刪除。</p>
    </div>
    <div class="btn-row">
      <button class="btn ${ui.mode === 'drawPolygon' ? 'active' : ''}" data-action="draw-polygon">⬠ 畫多邊形</button>
      <button class="btn ${ui.mode === 'drawCircle' ? 'active' : ''}" data-action="draw-circle">◯ 畫圓形</button>
      ${drawing ? '<button class="btn ghost" data-action="mode-cancel">取消</button>' : ''}
    </div>
    ${ui.mode === 'drawPolygon' ? `<div class="notice info">已點 <b>${n}/${MAX_POLY_POINTS}</b> 點。點回第一點、雙擊或按「完成」結束。
      <div class="btn-row" style="margin-top:6px">
        <button class="btn small" data-action="draw-finish" ${n < 3 ? 'disabled' : ''}>✔ 完成</button>
        <button class="btn ghost small" data-action="draw-undo" ${n ? '' : 'disabled'}>↶ 復原上一點</button>
      </div></div>` : ''}
    ${ui.mode === 'drawCircle' ? '<div class="notice info">先點圓心，再點一下決定半徑；完成後可在下方輸入精確半徑或拖曳方形把手。</div>' : ''}
    ${cards || '<div class="empty">尚未建立空域<br>點上方「畫多邊形」或「畫圓形」開始</div>'}
  </div>
  ${footer(
    `<button class="btn ghost" data-action="export-kml" ${state.airspaces.length ? '' : 'disabled'}>⬇ 輸出 KML</button>`,
    `<button class="btn" data-action="next" ${state.airspaces.length ? '' : 'disabled'}>下一步：案名與作業概述 →</button>`,
  )}`;
}

function renderStep2() {
  const aiNote = ui.aiReady === false
    ? '<div class="notice warn">尚未設定 Claude API 金鑰，AI 擴充無法使用。請在專案資料夾的 <code>.env</code> 檔填入 <code>ANTHROPIC_API_KEY=...</code> 後重新啟動。仍可手動撰寫作業概述。</div>'
    : '';
  return `<div class="panel-body">
    <div>
      <h2>步驟 2　案名與作業概述</h2>
      <p class="lead">先輸入大致內容（目的、時間、方式…），再按 AI 擴充，系統會結合空域資料寫成正式的作業概述。缺少的資訊會以【待確認】標示。</p>
    </div>
    <label class="field">案名<input type="text" data-field="caseName" value="${esc(state.caseName)}" placeholder="例：115年宜蘭縣頭城海岸空拍作業"></label>
    <label class="field">作業大致內容
      <textarea data-field="draft" rows="6" placeholder="例：受宜蘭縣政府委託，於11月期間拍攝頭城海岸線宣傳影片，使用 DJI Mavic 3，每日上午 9 點到下午 4 點，預計飛行 5 天…">${esc(state.draft)}</textarea>
    </label>
    ${aiNote}
    <div class="btn-row">
      <button class="btn" data-action="ai-expand" ${ui.aiBusy ? 'disabled' : ''}>${ui.aiBusy ? '<span class="spinner"></span> AI 撰寫中…' : '✨ AI 擴充生成作業概述'}</button>
    </div>
    <label class="field">作業概述 <small>可直接編輯；下一步的起飛點可一鍵貼到這裡</small>
      <textarea class="overview" data-field="overview" ${ui.aiBusy ? 'readonly' : ''} placeholder="按「AI 擴充生成」或自行輸入">${esc(state.overview)}</textarea>
    </label>
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
      : `空域內找到 ${c.list.filter((x) => x.kind === 'park').length} 處公園、${c.list.filter((x) => x.kind === 'parking').length} 處戶外停車場`;
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
      <p class="lead">每個空域自動產生 2 個起飛點：優先挑空域內<b>相距最遠</b>的公園或戶外停車場，找不到時改用空域對角線位置。
      點選地圖上的起飛點後，再點新位置或綠色🌳／藍色P候選點即可修改，也可直接拖曳（拖到候選點旁會自動吸附）。</p>
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
      <div class="grid2">
        <label class="field">地點<input type="text" data-as-field="area" data-id="${as.id}" value="${esc(as.area)}"></label>
        <label class="field">最大高度（公尺）<input type="number" min="1" data-as-field="height" data-id="${as.id}" value="${esc(as.height)}"><small>約 ${ft(as.height)} 呎</small></label>
      </div>
      ${airspaceInfoHtml(as)}
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
    <label class="field">作業概述
      <textarea class="overview" data-field="overview">${esc(state.overview)}</textarea>
    </label>
    <div class="btn-row">
      <button class="btn ghost small" data-action="lp-insert">📋 重新貼上最新起飛點</button>
    </div>
    ${coordFormatSelect()}
    <h3>空域與起飛點</h3>
    ${asCards}
    <label class="inline"><input type="checkbox" data-field="includeLaunchInKml" ${state.includeLaunchInKml ? 'checked' : ''}> KML 同時包含起飛點</label>
  </div>
  ${footer(
    '<button class="btn ghost" data-action="prev">← 上一步</button>',
    `<button class="btn ghost" data-action="export-kml">🗺 輸出 KML</button>
     <button class="btn" data-action="export-word">📄 輸出 Word</button>`,
  )}`;
}

// ── 面板事件（委派）──
const panelEl = $('#panel');
panelEl.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.field) {
    const key = t.dataset.field;
    state[key] = t.type === 'checkbox' ? t.checked : t.value;
    save();
    if (key === 'coordFormat') { renderPanel(); }
    return;
  }
  if (t.dataset.asField) {
    const as = getAs(t.dataset.id);
    if (!as) return;
    const f = t.dataset.asField;
    if (f === 'height') {
      as.height = Number(t.value) || 0;
      const small = t.parentElement.querySelector('small');
      if (small) small.textContent = `約 ${ft(as.height)} 呎`;
    } else if (f === 'radius') {
      const r = Number(t.value);
      if (r >= 10) { as.radius = r; shapeById[as.id]?.setRadius(r); renderEditHandles(); }
    } else {
      as[f] = t.value;
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
  if (t.dataset.asField) {
    const as = getAs(t.dataset.id);
    if (!as) return;
    if (t.dataset.asField === 'radius') { commitAirspaceEdit(as); return; }
    renderAirspaces();
    renderLaunch();
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
    case 'export-kml': exportKml(); break;
    case 'export-word': exportWord(); break;
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
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const j = await res.json();
    if (!j.results?.length) { toast('找不到這個地點'); return; }
    const r = j.results[0];
    if (r.bbox) map.fitBounds([[r.bbox[0], r.bbox[2]], [r.bbox[1], r.bbox[3]]], { maxZoom: 17 });
    else map.setView([r.lat, r.lng], 16);
    toast(r.name);
  } catch (err) { toast(`搜尋失敗：${err.message}`, 'error'); }
});

// ── 啟動 ──
(async function init() {
  save();
  state.airspaces.forEach(updateWarnings);
  renderAirspaces();
  goStep(state.step || 1, true);
  fitAll();
  loadCaaZones();
  try {
    const j = await (await fetch('/api/status')).json();
    ui.aiReady = j.ai_ready;
    if (state.step === 2) renderPanel();
  } catch { ui.aiReady = false; }
})();
