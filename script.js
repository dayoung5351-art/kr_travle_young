// ============ Config ============
const MAP_URL = "https://raw.githubusercontent.com/southkorea/southkorea-maps/master/kostat/2018/json/skorea-municipalities-2018-topo-simple.json";
const STORAGE_KEY = "travel-log-korea-v1";
const DOUBLE_TAP_MS = 320;
const WIDTH = 760, HEIGHT = 900;

// sido code prefix -> metro/special city name.
// Regions under these prefixes (wards, and outlying counties like 기장군/달성군/강화군/옹진군/울주군)
// are merged into a single clickable shape for that city.
const METRO_CODES = {
  "11": "서울특별시",
  "21": "부산광역시",
  "22": "대구광역시",
  "23": "인천광역시",
  "24": "광주광역시",
  "25": "대전광역시",
  "26": "울산광역시",
  "29": "세종특별자치시"
};

// ============ Storage ============
// shape: { [regionId]: { name, marked: bool, records: [{id, date, memo}] } }
let store = loadStore();

function loadStore(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  }catch(e){ return {}; }
}
function saveStore(){
  try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); }
  catch(e){ /* storage unavailable, continue in-memory only */ }
}
function getRegion(id, name){
  if(!store[id]) store[id] = { name, marked: false, records: [] };
  return store[id];
}

// ============ DOM refs ============
const svg = document.getElementById("mapSvg");
const mapLoading = document.getElementById("mapLoading");
const sheetOverlay = document.getElementById("sheetOverlay");
const bottomSheet = document.getElementById("bottomSheet");
const sheetRegionName = document.getElementById("sheetRegionName");
const recordForm = document.getElementById("recordForm");
const inputDate = document.getElementById("inputDate");
const inputMemo = document.getElementById("inputMemo");
const recordList = document.getElementById("recordList");
const recordEmpty = document.getElementById("recordEmpty");
const btnCloseSheet = document.getElementById("btnCloseSheet");
const btnAllRecords = document.getElementById("btnAllRecords");
const allRecordsModal = document.getElementById("allRecordsModal");
const allRecordsBody = document.getElementById("allRecordsBody");
const btnCloseAll = document.getElementById("btnCloseAll");
const statVisited = document.getElementById("statVisited");
const statRecords = document.getElementById("statRecords");

let activeRegionId = null;
let applyAllStates = () => {};

// ============ Map loading & rendering ============
d3.json(MAP_URL).then(topo => {
  const objectKey = Object.keys(topo.objects)[0];
  const geometries = topo.objects[objectKey].geometries;

  // Group geometries: metro/special cities get merged into one shape each,
  // everything else (일반 시/군/구) stays as its own shape.
  const metroGroups = {};
  const soloGeometries = [];
  geometries.forEach(g => {
    const code = (g.properties && g.properties.code) || "";
    const sido = code.slice(0, 2);
    if(METRO_CODES[sido]){
      (metroGroups[sido] = metroGroups[sido] || []).push(g);
    }else{
      soloGeometries.push(g);
    }
  });

  const features = [];
  Object.keys(metroGroups).forEach(sido => {
    const mergedGeom = topojson.merge(topo, metroGroups[sido]);
    features.push({
      type: "Feature",
      properties: { name: METRO_CODES[sido], code: sido + "000" },
      geometry: mergedGeom
    });
  });
  soloGeometries.forEach(g => {
    features.push(topojson.feature(topo, g));
  });

  const geo = { type: "FeatureCollection", features };

  const projection = d3.geoMercator().fitExtent([[16, 16], [WIDTH - 16, HEIGHT - 16]], geo);
  const path = d3.geoPath().projection(projection);

  const svgSel = d3.select(svg);
  const viewport = svgSel.append("g").attr("class", "viewport");
  const regionsLayer = viewport.append("g").attr("class", "regions");
  const labelLayer = viewport.append("g").attr("class", "labels");
  const stampLayer = viewport.append("g").attr("class", "stamps");

  // ---- Regions ----
  const paths = regionsLayer.selectAll("path.region")
    .data(features)
    .enter()
    .append("path")
    .attr("class", "region")
    .attr("d", path)
    .attr("id", d => "region-" + d.properties.code);

  paths.each(function(d){
    const id = d.properties.code;
    const name = d.properties.name;
    this.addEventListener("click", () => handleTap(this, id, name));
  });

  // ---- Labels (name text at each region's centroid) ----
  const labelData = [];
  features.forEach(f => {
    const b = path.bounds(f);
    const w = b[1][0] - b[0][0], h = b[1][1] - b[0][1];
    const area = w * h;
    const [cx, cy] = path.centroid(f);
    if(!isFinite(cx) || !isFinite(cy) || area < 10) return;
    const isMetro = !!METRO_CODES[f.properties.code.slice(0,2)] && f.properties.code.endsWith("000");
    const baseFontSize = isMetro
      ? 12
      : Math.max(10, Math.min(13, Math.sqrt(area) / 6));
    labelData.push({ id: f.properties.code, name: f.properties.name, cx, cy, baseFontSize });
  });

  labelLayer.selectAll("g.label-g")
    .data(labelData, d => d.id)
    .enter()
    .append("g")
    .attr("class", "label-g")
    .attr("transform", d => `translate(${d.cx},${d.cy})`)
    .append("text")
    .attr("class", "region-label")
    .attr("text-anchor", "middle")
    .attr("dy", "0.32em")
    .attr("font-size", d => d.baseFontSize)
    .text(d => d.name);

  // ---- Zoom & pan ----
  const zoomBehavior = d3.zoom()
    .scaleExtent([1, 8])
    .translateExtent([[-100, -100], [WIDTH + 100, HEIGHT + 100]])
    .on("zoom", (event) => {
      viewport.attr("transform", event.transform);
      const invK = 1 / event.transform.k;
      labelLayer.selectAll("g.label-g")
        .attr("transform", d => `translate(${d.cx},${d.cy}) scale(${invK})`);
      stampLayer.selectAll("g.stamp-mark")
        .attr("transform", d => `translate(${d.cx},${d.cy}) rotate(${d.rot}) scale(${invK})`);
    });

  svgSel.call(zoomBehavior).on("dblclick.zoom", null);

  // ---- Stamp marks for regions with saved records ----
  function renderStamps(){
    const k = d3.zoomTransform(svg).k || 1;
    const stampData = [];
    features.forEach(f => {
      const id = f.properties.code;
      const region = store[id];
      if(region && region.records && region.records.length){
        const [cx, cy] = path.centroid(f);
        if(!isFinite(cx) || !isFinite(cy)) return;
        const rot = ((id.charCodeAt(0) || 0) % 14) - 7;
        stampData.push({ id, cx, cy, rot, count: region.records.length });
      }
    });
    const sel = stampLayer.selectAll("g.stamp-mark").data(stampData, d => d.id);
    sel.exit().remove();
    const enter = sel.enter().append("g").attr("class", "stamp-mark");
    enter.append("circle").attr("r", 8);
    enter.append("text").attr("y", 2.5);
    const merged = enter.merge(sel);
    merged.attr("transform", d => `translate(${d.cx},${d.cy}) rotate(${d.rot}) scale(${1 / k})`);
    merged.select("text").text(d => d.count);
  }

  applyAllStates = function(){
    paths.classed("marked", d => !!(store[d.properties.code] && store[d.properties.code].marked));
    renderStamps();
    updateStats();
  };

  applyAllStates();
  mapLoading.classList.add("hidden");
}).catch(() => {
  mapLoading.textContent = "지도를 불러오지 못했어요. 인터넷 연결을 확인해주세요.";
});

// ============ Tap / double-tap handling ============
function handleTap(el, id, name){
  const now = Date.now();
  const last = el._lastTap || 0;
  if(now - last < DOUBLE_TAP_MS){
    clearTimeout(el._tapTimer);
    el._lastTap = 0;
    openSheet(id, name);
  }else{
    el._lastTap = now;
    el._tapTimer = setTimeout(() => {
      toggleMarked(id, name, el);
    }, DOUBLE_TAP_MS);
  }
}

function toggleMarked(id, name, el){
  const region = getRegion(id, name);
  region.marked = !region.marked;
  saveStore();
  el.classList.toggle("marked", region.marked);
  updateStats();
}

function updateStats(){
  const ids = Object.keys(store);
  const visited = ids.filter(id => store[id].marked || (store[id].records||[]).length).length;
  const records = ids.reduce((sum, id) => sum + (store[id].records||[]).length, 0);
  statVisited.textContent = visited;
  statRecords.textContent = records;
}

// ============ Bottom sheet ============
function openSheet(id, name){
  activeRegionId = id;
  getRegion(id, name);
  sheetRegionName.textContent = name;
  inputDate.value = "";
  inputMemo.value = "";
  renderRecordList();
  bottomSheet.classList.add("open");
  sheetOverlay.classList.add("show");
  bottomSheet.setAttribute("aria-hidden", "false");
}
function closeSheet(){
  bottomSheet.classList.remove("open");
  sheetOverlay.classList.remove("show");
  bottomSheet.setAttribute("aria-hidden", "true");
  activeRegionId = null;
}
btnCloseSheet.addEventListener("click", closeSheet);
sheetOverlay.addEventListener("click", () => { closeSheet(); closeAllModal(); });

recordForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if(!activeRegionId) return;
  if(!inputDate.value) return;
  const region = store[activeRegionId];
  region.records.push({
    id: "r" + Date.now(),
    date: inputDate.value,
    memo: inputMemo.value.trim()
  });
  region.marked = true;
  saveStore();
  inputDate.value = "";
  inputMemo.value = "";
  renderRecordList();
  document.getElementById("region-" + activeRegionId)?.classList.add("marked");
  applyAllStates();
});

function renderRecordList(){
  const region = store[activeRegionId];
  const records = (region && region.records ? region.records.slice() : [])
    .sort((a,b) => a.date.localeCompare(b.date));
  recordList.innerHTML = "";
  recordEmpty.style.display = records.length ? "none" : "block";
  records.forEach(r => {
    const li = document.createElement("li");
    li.className = "record-item";
    li.innerHTML = `
      <span class="record-date">${formatDate(r.date)}</span>
      <span class="record-memo">${escapeHtml(r.memo) || "<span style='color:#9a9a8a'>메모 없음</span>"}</span>
      <button class="record-del" aria-label="삭제">✕</button>
    `;
    li.querySelector(".record-del").addEventListener("click", () => {
      region.records = region.records.filter(x => x.id !== r.id);
      saveStore();
      renderRecordList();
      applyAllStates();
    });
    recordList.appendChild(li);
  });
}

// ============ All records modal ============
btnAllRecords.addEventListener("click", openAllModal);
btnCloseAll.addEventListener("click", closeAllModal);

function openAllModal(){
  const flat = [];
  Object.keys(store).forEach(id => {
    const region = store[id];
    (region.records||[]).forEach(r => flat.push({ region: region.name, date: r.date, memo: r.memo }));
  });
  flat.sort((a,b) => b.date.localeCompare(a.date));

  allRecordsBody.innerHTML = "";
  if(!flat.length){
    allRecordsBody.innerHTML = `<p class="all-empty">아직 남긴 기록이 없어요.<br>지도를 더블탭해서 첫 기록을 남겨보세요.</p>`;
  }else{
    flat.forEach(r => {
      const row = document.createElement("div");
      row.className = "all-group";
      row.innerHTML = `
        <div class="all-group-label">${formatDate(r.date)} · ${escapeHtml(r.region)}</div>
        <div class="record-item" style="border-left-color:var(--gold)">
          <span class="record-memo">${escapeHtml(r.memo) || "<span style='color:#9a9a8a'>메모 없음</span>"}</span>
        </div>
      `;
      allRecordsBody.appendChild(row);
    });
  }
  allRecordsModal.classList.add("open");
  allRecordsModal.setAttribute("aria-hidden", "false");
}
function closeAllModal(){
  allRecordsModal.classList.remove("open");
  allRecordsModal.setAttribute("aria-hidden", "true");
}

// ============ Utils ============
function formatDate(iso){
  if(!iso) return "";
  const [y,m,d] = iso.split("-");
  return `${y}.${m}.${d}`;
}
function escapeHtml(str){
  if(!str) return "";
  return str.replace(/[&<>"']/g, s => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
  }[s]));
}
