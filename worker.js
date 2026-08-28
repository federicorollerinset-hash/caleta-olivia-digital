// ============================================================
// CALETA OLIVIA DIGITAL — Cloudflare Worker
// Sirve el diario (assets estáticos), el endpoint de subida de
// imágenes a R2, la pestaña /panoramasantacruz (ex "Apertura"),
// que lee las portadas de los diarios de Santa Cruz del lado del
// servidor y las muestra con la identidad visual del sitio, y
// los meta tags de Open Graph dinámicos para /nota.html (para
// que Facebook, WhatsApp, etc. muestren título/imagen reales).
//
// SEGURIDAD: todas las escrituras (login, notas, usuarios,
// imágenes) pasan por acá y usan la SERVICE ROLE key de Supabase,
// que nunca llega al navegador. El navegador solo tiene la key
// pública (anon), que en Supabase quedó restringida a lectura de
// notas publicadas — ver el bloque de políticas RLS al final de
// este archivo (comentario) para aplicarlas en el SQL editor.
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

// ============================================================
// OG TAGS DINÁMICOS PARA /nota.html
// Facebook (y WhatsApp, Twitter, Slack, etc) no ejecutan JS:
// leen el HTML crudo. Como nota.html arma el título/imagen con
// JS del lado del cliente, hay que inyectar los meta tags acá,
// en el servidor, antes de devolver la página.
// Esto usa el anon key porque solo LEE notas publicadas, algo
// que sigue siendo público a propósito.
// ============================================================

const SUPABASE_URL = 'https://rmbutukkldktjknvhizj.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_HJbQIiqaB6MGWnfTq0GlHw_dDO7tbAe';

function escapeAttr(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function obtenerNotaParaOg(id) {
  const url = `${SUPABASE_URL}/rest/v1/notas?id=eq.${encodeURIComponent(id)}&estado=eq.publicada&select=titulo,bajada,imagen_url`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`
    }
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

async function handleNotaHtml(request, env, url) {
  const assetResponse = await env.ASSETS.fetch(request);
  const id = url.searchParams.get('id');
  if (!id) return assetResponse;

  let nota = null;
  try {
    nota = await obtenerNotaParaOg(id);
  } catch (e) {
    return assetResponse;
  }
  if (!nota) return assetResponse;

  const html = await assetResponse.text();

  const titulo = escapeAttr(nota.titulo || 'Caleta Olivia Digital');
  const descripcion = escapeAttr(
    nota.bajada || 'Noticias de Caleta Olivia y Santa Cruz.'
  );
  const notaUrl = escapeAttr(url.href);

  let metaTags = `
<meta property="og:type" content="article">
<meta property="og:title" content="${titulo}">
<meta property="og:description" content="${descripcion}">
<meta property="og:url" content="${notaUrl}">
<meta property="og:site_name" content="Caleta Olivia Digital">
<meta name="twitter:card" content="${nota.imagen_url ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${titulo}">
<meta name="twitter:description" content="${descripcion}">
`;

  if (nota.imagen_url) {
    const imagen = escapeAttr(nota.imagen_url);
    metaTags += `<meta property="og:image" content="${imagen}">\n<meta name="twitter:image" content="${imagen}">\n`;
  }

  const newHtml = html.replace(
    /<title>[\s\S]*?<\/title>/,
    `<title>${nota.titulo} — Caleta Olivia Digital</title>${metaTags}`
  );

  const headers = new Headers(assetResponse.headers);
  headers.delete('content-length');

  return new Response(newHtml, {
    status: assetResponse.status,
    headers
  });
}

// ============================================================
// AUTENTICACIÓN Y ESCRITURAS PROTEGIDAS
// A partir de acá: login, sesiones firmadas, y todos los
// endpoints que crean/editan/borran datos. Todos usan
// env.SUPABASE_SERVICE_KEY (secreto de Cloudflare, nunca en el
// código ni en el navegador) para hablar con Supabase saltando
// RLS del lado del servidor, después de validar el permiso acá.
// ============================================================

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
  });
}

function toBase64Url(bytes) {
  let bin = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64Url(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  return new Uint8Array([...bin].map(c => c.charCodeAt(0)));
}

async function hmacFirmar(secreto, texto) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secreto), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(texto));
  return toBase64Url(new Uint8Array(sig));
}

// token de sesión: <payload en base64url>.<firma hmac>, vence a los 7 días
async function crearToken(env, payload) {
  const cuerpo = { ...payload, exp: Date.now() + 1000 * 60 * 60 * 24 * 7 };
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(cuerpo)));
  const firma = await hmacFirmar(env.SESSION_SECRET, payloadB64);
  return `${payloadB64}.${firma}`;
}

async function verificarToken(env, token) {
  if (!token) return null;
  const partes = token.split('.');
  if (partes.length !== 2) return null;
  const [payloadB64, firma] = partes;
  const firmaEsperada = await hmacFirmar(env.SESSION_SECRET, payloadB64);
  if (firma !== firmaEsperada) return null;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64))); }
  catch (e) { return null; }
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

function getBearerToken(request) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer (.+)$/);
  return m ? m[1] : null;
}

async function requireSesion(request, env) {
  return verificarToken(env, getBearerToken(request));
}

// Habla con Supabase usando la service role key (bypassa RLS) — solo se llama server-side
async function sbService(env, path, options = {}) {
  const headers = {
    apikey: env.SUPABASE_SERVICE_KEY,
    // OJO: las keys nuevas de Supabase (sb_secret_...) NO van en Authorization,
    // solo en apikey — si se manda también ahí, Supabase la rechaza como "Invalid API key".
    'Content-Type': 'application/json',
    Prefer: options.prefer || 'return=representation',
    ...(options.headers || {})
  };
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...options, headers });
}

// si esta nota va a ocupar un lugar destacado, la que estaba ahí pasa a "regular" (server-side)
async function liberarPosicionServer(env, posicion, idAExcluir) {
  if (posicion === 'regular') return;
  let path = `notas?posicion=eq.${posicion}&estado=eq.publicada`;
  if (idAExcluir) path += `&id=neq.${idAExcluir}`;
  await sbService(env, path, { method: 'PATCH', body: JSON.stringify({ posicion: 'regular' }), prefer: 'return=minimal' });
}

async function handleApi(request, env, url) {
  const { pathname } = url;
  const metodo = request.method;

  // ---------- LOGIN ----------
  if (pathname === '/api/login' && metodo === 'POST') {
    const { email, password } = await request.json().catch(() => ({}));
    if (!email || !password) return jsonResponse({ error: 'Completá email y contraseña.' }, 400);

    // 1) Validar email+contraseña contra Supabase Auth (usa la key pública, no la service key)
    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.toLowerCase(), password })
    });
    if (!authRes.ok) return jsonResponse({ error: 'Email o contraseña incorrectos.' }, 401);
    const authData = await authRes.json();
    const accessToken = authData.access_token;
    const authUser = authData.user;
    if (!accessToken || !authUser) return jsonResponse({ error: 'Email o contraseña incorrectos.' }, 401);

    // 2) Traer el perfil (nombre, rol, activo) — con el token del propio usuario, respeta RLS
    const perfilRes = await fetch(`${SUPABASE_URL}/rest/v1/perfiles?id=eq.${authUser.id}&select=*`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` }
    });
    const perfiles = await perfilRes.json().catch(() => []);
    const perfil = Array.isArray(perfiles) ? perfiles[0] : null;
    if (!perfil || perfil.activo === false) {
      return jsonResponse({ error: 'Tu cuenta todavía no tiene perfil asignado. Avisá a un administrador.' }, 403);
    }

    const usuario = { id: authUser.id, email: authUser.email, nombre: perfil.nombre, rol: perfil.rol };
    const token = await crearToken(env, usuario);
    return jsonResponse({ token, user: usuario });
  }

  // ---------- OLVIDÉ MI CONTRASEÑA: pide a Supabase que mande el mail ----------
  if (pathname === '/api/recuperar-clave' && metodo === 'POST') {
    const { email } = await request.json().catch(() => ({}));
    if (email) {
      // el link vuelve acá mismo (panel.html), con #access_token=...&type=recovery en el hash
      const redirectTo = `${url.origin}/panel.html`;
      await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
        method: 'POST',
        headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.toLowerCase(), options: { redirect_to: redirectTo } })
      }).catch(() => {});
    }
    // siempre respondemos igual, exista o no el email, para no filtrar qué mails están registrados
    return jsonResponse({ ok: true });
  }

  // ---------- CONFIRMAR NUEVA CONTRASEÑA (viene del link del mail) ----------
  if (pathname === '/api/actualizar-clave' && metodo === 'POST') {
    const { access_token, password } = await request.json().catch(() => ({}));
    if (!access_token || !password || password.length < 8) {
      return jsonResponse({ error: 'Faltan datos o la contraseña es muy corta.' }, 400);
    }
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: 'PUT',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ password })
    });
    if (!res.ok) {
      return jsonResponse({ error: 'El link venció o no es válido. Pedí uno nuevo.' }, 400);
    }
    return jsonResponse({ ok: true });
  }

  // ---------- SUBIR IMAGEN (requiere sesión) ----------
  if (pathname === '/api/subir-imagen' && metodo === 'POST') {
    const sesion = await requireSesion(request, env);
    if (!sesion) return jsonResponse({ error: 'No autorizado.' }, 401);
    try {
      const formData = await request.formData();
      const file = formData.get('file');
      if (!file) return jsonResponse({ error: 'No se envió ningún archivo' }, 400);

      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
      const nombreArchivo = `notas/${Date.now()}-${crypto.randomUUID()}.${ext}`;
      await env.IMAGENES.put(nombreArchivo, file.stream(), { httpMetadata: { contentType: file.type || 'image/jpeg' } });
      const urlPublica = `https://pub-2f0378f77190435e86bc93accabc379c.r2.dev/${nombreArchivo}`;

      // registrar en el banco de imágenes reutilizables
      await sbService(env, 'imagenes', {
        method: 'POST',
        prefer: 'return=minimal',
        body: JSON.stringify({ url: urlPublica, nombre_archivo: file.name, subida_por: sesion.nombre })
      });

      return jsonResponse({ url: urlPublica });
    } catch (err) {
      return jsonResponse({ error: 'Error al subir la imagen: ' + err.message }, 500);
    }
  }

  // ---------- GALERÍA DE IMÁGENES (requiere sesión) ----------
  if (pathname === '/api/imagenes' && metodo === 'GET') {
    const sesion = await requireSesion(request, env);
    if (!sesion) return jsonResponse({ error: 'No autorizado.' }, 401);
    const res = await sbService(env, 'imagenes?select=*&order=created_at.desc&limit=40');
    return jsonResponse({ data: await res.json() });
  }

  // ---------- MIS NOTAS (propias, incluye borradores) ----------
  if (pathname === '/api/mis-notas' && metodo === 'GET') {
    const sesion = await requireSesion(request, env);
    if (!sesion) return jsonResponse({ error: 'No autorizado.' }, 401);
    const res = await sbService(env, `notas?autor_id=eq.${sesion.id}&select=*&order=created_at.desc`);
    return jsonResponse({ data: await res.json() });
  }

  // ---------- UNA NOTA PUNTUAL (para editar) ----------
  if (pathname.startsWith('/api/notas/') && metodo === 'GET') {
    const sesion = await requireSesion(request, env);
    if (!sesion) return jsonResponse({ error: 'No autorizado.' }, 401);
    const id = pathname.split('/').pop();
    const res = await sbService(env, `notas?id=eq.${id}&select=*`);
    const filas = await res.json();
    if (!filas[0]) return jsonResponse({ error: 'No encontrada.' }, 404);
    if (sesion.rol === 'redactor' && filas[0].autor_id !== sesion.id) return jsonResponse({ error: 'No podés editar esta nota.' }, 403);
    return jsonResponse({ data: filas[0] });
  }

  // ---------- CREAR NOTA ----------
  if (pathname === '/api/notas' && metodo === 'POST') {
    const sesion = await requireSesion(request, env);
    if (!sesion) return jsonResponse({ error: 'No autorizado.' }, 401);
    const datos = await request.json().catch(() => null);
    if (!datos) return jsonResponse({ error: 'Datos inválidos.' }, 400);

    if (datos.estado === 'publicada' && datos.posicion && datos.posicion !== 'regular') {
      await liberarPosicionServer(env, datos.posicion, null);
    }
    datos.autor_id = sesion.id;

    const res = await sbService(env, 'notas', { method: 'POST', body: JSON.stringify(datos) });
    if (!res.ok) {
      const detalle = await res.json().catch(() => null);
      const k = env.SUPABASE_SERVICE_KEY || '';
      return jsonResponse({
        error: 'No se pudo crear la nota.',
        diagnostico_status: res.status,
        diagnostico_key_largo: k.length,
        diagnostico_key_inicio: k.slice(0, 12),
        diagnostico_key_final: k.slice(-6),
        diagnostico_nombres_variables: Object.keys(env),
        diagnostico_supabase: detalle
      }, 500);
    }
    const filas = await res.json();
    return jsonResponse({ data: filas[0] });
  }

  // ---------- EDITAR / BORRAR NOTA ----------
  if (pathname.startsWith('/api/notas/') && (metodo === 'PUT' || metodo === 'DELETE')) {
    const sesion = await requireSesion(request, env);
    if (!sesion) return jsonResponse({ error: 'No autorizado.' }, 401);
    const id = pathname.split('/').pop();

    // se busca la nota actual una sola vez: sirve para chequear permiso de
    // redactor y, si corresponde, completar la fecha de publicación
    const actualRes = await sbService(env, `notas?id=eq.${id}&select=autor_id,publicada_at`);
    const actualFilas = await actualRes.json();
    if (!actualFilas[0]) return jsonResponse({ error: 'No se encontró la nota.' }, 404);
    if (sesion.rol === 'redactor' && actualFilas[0].autor_id !== sesion.id) {
      return jsonResponse({ error: 'No tenés permiso sobre esta nota.' }, 403);
    }

    if (metodo === 'DELETE') {
      const res = await sbService(env, `notas?id=eq.${id}`, { method: 'DELETE' });
      if (!res.ok) return jsonResponse({ error: 'No se pudo borrar la nota.' }, 500);
      return jsonResponse({ ok: true });
    }

    const datos = await request.json().catch(() => null);
    if (!datos) return jsonResponse({ error: 'Datos inválidos.' }, 400);
    delete datos.autor_id; // nunca se cambia el autor desde el cliente

    if (datos.estado === 'publicada' && !actualFilas[0].publicada_at) {
      datos.publicada_at = new Date().toISOString();
    }
    if (datos.posicion && datos.posicion !== 'regular') {
      await liberarPosicionServer(env, datos.posicion, id);
    }

    const res = await sbService(env, `notas?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(datos), prefer: 'return=minimal' });
    if (!res.ok) return jsonResponse({ error: 'No se pudo editar la nota.' }, 500);
    return jsonResponse({ ok: true });
  }

  // ---------- SUMAR UNA VISTA (público, sin sesión — solo suma 1) ----------
  if (pathname.startsWith('/api/vista/') && metodo === 'POST') {
    const id = pathname.split('/').pop();
    const res = await sbService(env, `notas?id=eq.${id}&estado=eq.publicada&select=vistas`);
    const filas = await res.json();
    if (!filas[0]) return jsonResponse({ ok: false }, 404);
    const nuevasVistas = (filas[0].vistas || 0) + 1;
    await sbService(env, `notas?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ vistas: nuevasVistas }), prefer: 'return=minimal' });
    return jsonResponse({ ok: true });
  }

  // ---------- USUARIOS (solo admin) ----------
  if (pathname === '/api/usuarios' && metodo === 'GET') {
    const sesion = await requireSesion(request, env);
    if (!sesion || sesion.rol !== 'admin') return jsonResponse({ error: 'No autorizado.' }, 403);
    const res = await sbService(env, 'usuarios?select=*&order=created_at');
    const data = await res.json();
    data.forEach(u => delete u.password_hash);
    return jsonResponse({ data });
  }

  if (pathname === '/api/usuarios' && metodo === 'POST') {
    const sesion = await requireSesion(request, env);
    if (!sesion || sesion.rol !== 'admin') return jsonResponse({ error: 'No autorizado.' }, 403);
    const datos = await request.json().catch(() => null);
    if (!datos) return jsonResponse({ error: 'Datos inválidos.' }, 400);

    const res = await sbService(env, 'usuarios', { method: 'POST', body: JSON.stringify(datos) });
    if (!res.ok) {
      const texto = await res.text();
      const dup = texto.includes('duplicate');
      return jsonResponse({ error: dup ? 'Ya existe un usuario con ese email.' : 'No se pudo crear el usuario.' }, 500);
    }
    const filas = await res.json();
    if (filas[0]) delete filas[0].password_hash;
    return jsonResponse({ data: filas[0] });
  }

  return null; // no es una ruta de /api que manejemos acá
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      const respuestaApi = await handleApi(request, env, url);
      if (respuestaApi) return respuestaApi;
    }

    if (url.pathname === '/panoramasantacruz') {
      return new Response(PANORAMA_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (url.pathname === '/api/panorama-noticias') {
      return handlePanoramaApi(request, ctx);
    }

    if (url.pathname === '/nota.html') {
      return handleNotaHtml(request, env, url);
    }

    return env.ASSETS.fetch(request);
  }
};

// ============================================================
// PENDIENTE DE CONFIGURAR EN CLOUDFLARE (una sola vez):
//
// npx wrangler secret put SUPABASE_SERVICE_KEY
//   → pegar la "service_role" key de Supabase (Project Settings
//     → API → service_role secret). NUNCA la anon/publishable.
//
// npx wrangler secret put SESSION_SECRET
//   → pegar cualquier cadena larga y aleatoria (ej: generada con
//     `openssl rand -hex 32`). Se usa para firmar las sesiones.
//
// Y en Supabase (SQL editor) hay que cerrar el acceso directo
// del anon key — ver notas aparte.
// ============================================================
