// ============================================================
// CALETA OLIVIA DIGITAL — Cloudflare Worker
// Sirve el diario (assets estáticos), el endpoint de subida de
// imágenes a R2, y la pestaña /panoramasantacruz (ex "Apertura"),
// que lee las portadas de los diarios de Santa Cruz del lado del
// servidor y las muestra con la identidad visual del sitio.
// ============================================================

const SOURCES = [
  { id:'loa', name:'La Opinión Austral', short:'LOA', site:'https://laopinionaustral.com.ar', color:'#3949AB' },
  { id:'ts',  name:'Tiempo Sur',          short:'TS',  site:'https://www.tiemposur.com.ar',   color:'#5C6BC0' },
  { id:'dnd', name:'El Diario Nuevo Día', short:'DND', site:'https://www.eldiarionuevodia.com.ar', color:'#7986CB' },
  { id:'ec',  name:'El Caletense',        short:'EC',  site:'https://elcaletense.net',         color:'#4E5BAA' }
];

const CATEGORIES = [
  { id:'politica',   label:'Política',   keywords:['polític','gobierno','municipal','intendent','concejo deliberante','legislatura','diputad','senad','goberna','elecc','candidat','partido','ministr','presidente','provincial','concejal','milei'] },
  { id:'economia',   label:'Economía',   keywords:['económic','economía','dólar','precio','inflación','impuesto','tarifa','salario','paritaria','empresa','comercio','producción','laboral','empleo','banco','aumento','jubilac'] },
  { id:'policiales', label:'Policiales', keywords:['polic','detenido','robo','choque','accidente','homicidio','juicio','fiscal','delito','allanamiento','preso','condena','siniestro','femicidio','incendio','desaparecid','estafa'] },
  { id:'cultura',    label:'Cultura',    keywords:['cultura','arte','música','teatro','cine','libro','festival','museo','exposición','artista','patrimonio'] },
  { id:'deportes',   label:'Deportes',   keywords:['fútbol','deport','torneo','campeonato','liga','automovil','rugby','básquet','vóley'] },
  { id:'actualidad', label:'Actualidad', keywords:[] }
];

const UA = 'Mozilla/5.0 (compatible; PanoramaBot/1.0; +https://workers.cloudflare.com)';

const EXCLUDE_HREF = [
  /\/seccion\//i, /\/autor\//i, /\/tags\//i, /\/radios?\//i, /\/radio-online/i,
  /politica-de-privacidad/i, /publicidad/i, /contacto/i, /^mailto:/i, /^tel:/i,
  /^javascript:/i, /^#/, /\.(jpg|jpeg|png|webp|gif|svg|pdf|mp3|mp4)$/i,
  /facebook\.com|twitter\.com|x\.com|instagram\.com|youtube\.com|tiktok\.com|whatsapp\.com|t\.me|linkedin\.com|news\.google\.com/i
];
const MIN_TITLE_LEN = 25;
const MAX_ITEMS_PER_SOURCE = 16;

function categorize(title){
  const text = title.toLowerCase();
  for (const cat of CATEGORIES){
    if (cat.keywords.length === 0) continue;
    if (cat.keywords.some(kw => text.includes(kw))) return cat.id;
  }
  return 'actualidad';
}

function decodeEntities(str){
  if (!str) return '';
  return str
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .trim();
}

function stripTags(str){
  return decodeEntities((str || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
}

function extractHeadlines(html, source){
  const sHost = new URL(source.site).host.replace(/^www\./, '');
  const seen = new Set();
  const items = [];
  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null){
    if (items.length >= MAX_ITEMS_PER_SOURCE) break;
    let href = m[1].trim();
    if (!href) continue;
    if (EXCLUDE_HREF.some(rx => rx.test(href))) continue;

    if (href.startsWith('//')) href = 'https:' + href;
    if (href.startsWith('/')) href = source.site.replace(/\/$/, '') + href;
    if (!/^https?:\/\//i.test(href)) continue;

    let u;
    try { u = new URL(href); } catch(e){ continue; }
    if (u.host.replace(/^www\./, '') !== sHost) continue;

    const segments = u.pathname.split('/').filter(Boolean);
    if (segments.length < 2) continue;

    const title = stripTags(m[2]);
    if (title.length < MIN_TITLE_LEN) continue;

    const cleanUrl = u.origin + u.pathname;
    if (seen.has(cleanUrl)) continue;
    seen.add(cleanUrl);

    items.push({ title, link: href, category: categorize(title) });
  }
  return items;
}

async function getSourceItems(source){
  try{
    const res = await fetch(source.site, { headers: { 'User-Agent': UA } });
    if (!res.ok) return { ok:false, error: `HTTP ${res.status} al pedir la portada` };
    const html = await res.text();
    const items = extractHeadlines(html, source);
    if (items.length === 0) return { ok:false, error: `portada leída (${html.length}b) pero sin titulares detectados` };
    return { ok:true, items: items.map(i => ({ ...i, sourceId: source.id })) };
  }catch(e){
    return { ok:false, error: e.message || String(e) };
  }
}

async function handlePanoramaApi(request, ctx){
  const results = await Promise.all(SOURCES.map(async s => ({ source: s, ...(await getSourceItems(s)) })));

  const items = results.flatMap(r => r.ok ? r.items : []);
  const statuses = {};
  results.forEach(r => { statuses[r.source.id] = r.ok ? { status:'ok' } : { status:'error', detail:r.error }; });

  const body = JSON.stringify({ items, statuses, generatedAt: new Date().toISOString() });
  return new Response(body, {
    headers:{
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    }
  });
}

const PANORAMA_HTML = `<!DOCTYPE html>
<html lang="es-AR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Panorama Santa Cruz · Caleta Olivia Digital</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Work+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#F3F3F9; --paper:#FFFFFF; --line:#E1E1EE;
    --text:#1B1A2E; --muted:#66647F;
    --indigo:#312E81; --indigo-deep:#211F5B;
    --blue:#4338CA; --blue-tint:rgba(67,56,202,0.08);
    --accent:#D48A2C;
  }
  *{box-sizing:border-box;} html,body{margin:0;padding:0;}
  body{ background:var(--bg); color:var(--text); font-family:'Work Sans',sans-serif; min-height:100vh; }
  a{color:inherit;text-decoration:none;}

  .topbar{ background:var(--indigo); border-bottom:3px solid var(--blue); }
  .topbar-inner{ max-width:980px;margin:0 auto; display:flex;align-items:center;justify-content:space-between; gap:14px;flex-wrap:wrap; padding:9px 20px; }
  .brand-mark{ display:flex;align-items:baseline;gap:16px;flex-wrap:wrap; }
  .brand-mark .logo{ font-family:'Fraunces',serif; font-style:italic;font-weight:700; font-size:19px;color:#fff;letter-spacing:-0.01em; }
  .brand-nav{ display:flex;gap:16px;font-size:13px; }
  .brand-nav a{ color:rgba(255,255,255,0.6); padding:2px 0; }
  .brand-nav a.active{ color:#fff;font-weight:500;border-bottom:2px solid var(--accent); }
  .topbar-right{ display:flex;align-items:center;gap:12px; }
  .clock{ font-family:'JetBrains Mono',monospace;font-size:11.5px;color:rgba(255,255,255,0.85); text-align:right;line-height:1.35; }
  .clock strong{color:#fff;font-size:13px;}

  header{ position:sticky;top:0;z-index:20; }
  .filterbar{ background:var(--paper); border-bottom:1px solid var(--line); }
  .toolbar-wrap{ max-width:980px;margin:0 auto; padding:8px 20px 8px; }
  .toolbar{ display:flex;align-items:center;gap:6px;flex-wrap:wrap; }
  .toolbar.categories{ border-top:1px solid var(--line);margin-top:6px;padding-top:6px; }
  .toolbar-label{ font-family:'JetBrains Mono',monospace; font-size:9.5px;letter-spacing:0.08em;text-transform:uppercase; color:var(--muted);margin-right:4px; }
  .pill{ font-weight:500; font-size:12px; padding:5px 12px; border-radius:999px; border:1px solid var(--line); background:var(--paper); color:var(--muted); cursor:pointer; transition:border-color .15s, color .15s, background .15s; white-space:nowrap; }
  .pill .sw{ display:inline-block;width:6px;height:6px;border-radius:50%; margin-right:5px;vertical-align:middle; }
  .pill:hover{color:var(--text);border-color:#c7c7db;}
  .pill.active{ background:var(--indigo); border-color:var(--indigo); color:#fff; }
  .toolbar-spacer{flex:1;}
  #refresh-btn{ font-weight:600; font-size:12px; padding:5px 13px; border-radius:999px; border:1px solid var(--blue); background:transparent; color:var(--blue); cursor:pointer; }
  #refresh-btn:hover{background:var(--blue-tint);}
  #refresh-btn:disabled{opacity:.5;cursor:default;}
  #last-update{ font-family:'JetBrains Mono',monospace; font-size:10.5px;color:var(--muted); margin-top:6px; }

  main{max-width:980px;margin:0 auto;padding:14px 20px 80px;}
  .item{ display:block; padding:14px 12px; margin-bottom:2px; border-radius:6px; border-bottom:1px solid var(--line); transition:background .15s; }
  .item:hover{ background:var(--blue-tint); }
  .item .meta{ display:flex;align-items:center;gap:9px;margin-bottom:5px;flex-wrap:wrap; }
  .src-tag{ font-family:'JetBrains Mono',monospace; font-size:10px; letter-spacing:0.05em; font-weight:600; color:var(--src-color); text-transform:uppercase; }
  .cat-tag{ font-size:10px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase; color:var(--blue); background:var(--blue-tint); padding:2px 8px; border-radius:4px; }
  .headline{ font-family:'Work Sans',sans-serif; font-weight:700; font-size:18px; line-height:1.32; color:var(--text); display:block; }
  .headline:hover{color:var(--blue);text-decoration:underline;text-decoration-color:var(--accent);text-underline-offset:3px;}
  .empty, .error-row{ font-family:'JetBrains Mono',monospace; font-size:12px; color:var(--muted); padding:16px 4px; border-bottom:1px solid var(--line); line-height:1.6; }
  .error-row a{color:var(--blue);}
  footer{ max-width:980px;margin:0 auto;padding:0 20px 40px; font-family:'JetBrains Mono',monospace; font-size:10.5px;color:var(--muted); text-align:center; }

  @media (max-width:560px){
    .topbar-inner{padding:8px 14px;gap:8px;}
    .brand-mark .logo{font-size:17px;}
    .brand-nav{gap:12px;}
    .clock{font-size:10px;text-align:left;}
    .clock strong{font-size:12px;}
    .toolbar-wrap{padding:7px 14px 7px;}
    .pill{font-size:11px;padding:5px 10px;}
    main{padding:10px 14px 60px;}
    .headline{font-size:16.5px;}
    footer{padding:0 14px 30px;}
  }
</style>
</head>
<body>
<header>
  <div class="topbar">
    <div class="topbar-inner">
      <div class="brand-mark">
        <span class="logo">Caleta Olivia Digital</span>
        <nav class="brand-nav">
          <a href="/">Portada</a>
          <a href="/panoramasantacruz" class="active">Panorama Santa Cruz</a>
        </nav>
      </div>
      <div class="topbar-right">
        <div class="clock"><strong id="clock-time">--:--</strong><br><span id="clock-date">-- --- ----</span></div>
      </div>
    </div>
  </div>
  <div class="filterbar">
    <div class="toolbar-wrap">
      <div class="toolbar" id="toolbar-src"></div>
      <div class="toolbar categories" id="toolbar-cat"></div>
      <div id="last-update">Cargando titulares…</div>
    </div>
  </div>
</header>
<main id="feed"></main>
<footer>Fuentes: La Opinión Austral · Tiempo Sur · El Diario Nuevo Día · El Caletense — lee directo de portada, actualiza cada 10 min</footer>
<script>
const SOURCES = ${JSON.stringify(SOURCES)};
const CATEGORIES = ${JSON.stringify(CATEGORIES.map(c => ({ id:c.id, label:c.label })))};
const AUTO_REFRESH_MS = 10 * 60 * 1000;
let allItems = [];
let statuses = {};
let activeSourceFilter = 'all';
let activeCatFilter = 'all';

function updateClock(){
  const now = new Date();
  document.getElementById('clock-time').textContent = now.toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit' });
  document.getElementById('clock-date').textContent = now.toLocaleDateString('es-AR', { weekday:'long', day:'numeric', month:'long' });
}
updateClock();
setInterval(updateClock, 15000);

function buildToolbars(){
  const srcBar = document.getElementById('toolbar-src');
  srcBar.innerHTML = '<span class="toolbar-label">Diario</span>';
  const allSrc = document.createElement('button');
  allSrc.className = 'pill active'; allSrc.textContent = 'Todas';
  allSrc.onclick = () => setSourceFilter('all', allSrc);
  srcBar.appendChild(allSrc);
  SOURCES.forEach(s => {
    const p = document.createElement('button');
    p.className = 'pill'; p.dataset.src = s.id;
    p.innerHTML = '<span class="sw" style="background:' + s.color + '"></span>' + s.short;
    p.onclick = () => setSourceFilter(s.id, p);
    srcBar.appendChild(p);
  });
  const spacer = document.createElement('div'); spacer.className = 'toolbar-spacer'; srcBar.appendChild(spacer);
  const btn = document.createElement('button'); btn.id = 'refresh-btn'; btn.textContent = '↻ Actualizar';
  btn.onclick = () => loadAll(); srcBar.appendChild(btn);

  const catBar = document.getElementById('toolbar-cat');
  catBar.innerHTML = '<span class="toolbar-label">Sección</span>';
  const allCat = document.createElement('button');
  allCat.className = 'pill active'; allCat.textContent = 'Todas';
  allCat.onclick = () => setCatFilter('all', allCat);
  catBar.appendChild(allCat);
  CATEGORIES.forEach(c => {
    const p = document.createElement('button');
    p.className = 'pill'; p.dataset.cat = c.id; p.textContent = c.label;
    p.onclick = () => setCatFilter(c.id, p);
    catBar.appendChild(p);
  });
}
function setSourceFilter(id, el){ activeSourceFilter = id; document.querySelectorAll('#toolbar-src .pill').forEach(p => p.classList.remove('active')); el.classList.add('active'); render(); }
function setCatFilter(id, el){ activeCatFilter = id; document.querySelectorAll('#toolbar-cat .pill').forEach(p => p.classList.remove('active')); el.classList.add('active'); render(); }

function render(){
  const feedEl = document.getElementById('feed');
  feedEl.innerHTML = '';
  const srcById = Object.fromEntries(SOURCES.map(s => [s.id, s]));
  const catLabel = id => (CATEGORIES.find(c => c.id === id) || {}).label || id;

  const items = allItems
    .filter(i => activeSourceFilter === 'all' || i.sourceId === activeSourceFilter)
    .filter(i => activeCatFilter === 'all' || i.category === activeCatFilter);

  if (items.length === 0){
    const div = document.createElement('div'); div.className = 'empty';
    div.textContent = 'Sin titulares para mostrar con este filtro.';
    feedEl.appendChild(div);
  }

  items.forEach(item => {
    const src = srcById[item.sourceId];
    const row = document.createElement('a');
    row.href = item.link; row.target = '_blank'; row.rel = 'noopener'; row.className = 'item';
    row.innerHTML = '<div class="meta">' +
      '<span class="src-tag" style="color:' + src.color + '">' + src.short + '</span>' +
      '<span class="cat-tag">' + catLabel(item.category) + '</span></div>' +
      '<span class="headline">' + item.title + '</span>';
    feedEl.appendChild(row);
  });

  const failed = SOURCES.filter(s => statuses[s.id] && statuses[s.id].status === 'error');
  if (failed.length){
    const div = document.createElement('div'); div.className = 'error-row';
    div.innerHTML = 'No se pudieron cargar ahora: ' + failed.map(s => '<a href="' + s.site + '" target="_blank">' + s.name + '</a>').join(', ') +
      '<br>Detalle: ' + failed.map(s => s.short + ' — ' + statuses[s.id].detail).join(' · ');
    feedEl.appendChild(div);
  }
}

async function loadAll(){
  const btn = document.getElementById('refresh-btn');
  if (btn){ btn.disabled = true; btn.textContent = 'Actualizando…'; }
  document.getElementById('last-update').textContent = 'Buscando titulares…';
  try{
    const res = await fetch('/api/panorama-noticias', { cache:'no-store' });
    const data = await res.json();
    allItems = data.items;
    statuses = data.statuses;
    const okCount = Object.values(statuses).filter(v => v.status === 'ok').length;
    document.getElementById('last-update').textContent =
      'Última actualización: ' + new Date(data.generatedAt).toLocaleTimeString('es-AR', {hour:'2-digit', minute:'2-digit'}) +
      ' — ' + allItems.length + ' titulares de ' + okCount + '/' + SOURCES.length + ' diarios';
  }catch(e){
    document.getElementById('last-update').textContent = 'Error al conectar con el servidor: ' + e.message;
  }
  render();
  if (btn){ btn.disabled = false; btn.textContent = '↻ Actualizar'; }
}

buildToolbars();
loadAll();
setInterval(loadAll, AUTO_REFRESH_MS);
</script>
</body>
</html>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/subir-imagen' && request.method === 'POST') {
      try {
        const formData = await request.formData();
        const file = formData.get('file');
        if (!file) {
          return new Response(JSON.stringify({ error: 'No se envió ningún archivo' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
        const nombreArchivo = `notas/${Date.now()}-${crypto.randomUUID()}.${ext}`;
        await env.IMAGENES.put(nombreArchivo, file.stream(), {
          httpMetadata: { contentType: file.type || 'image/jpeg' }
        });
        const urlPublica = `https://pub-2f0378f77190435e86bc93accabc379c.r2.dev/${nombreArchivo}`;
        return new Response(JSON.stringify({ url: urlPublica }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Error al subir la imagen: ' + err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    if (url.pathname === '/panoramasantacruz') {
      return new Response(PANORAMA_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (url.pathname === '/api/panorama-noticias') {
      return handlePanoramaApi(request, ctx);
    }

    return env.ASSETS.fetch(request);
  }
};
