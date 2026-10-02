/// <reference path="./kino.d.ts" />
// Doramas.org — plugin para Kino
// Doramas y películas asiáticas subtituladas. Basado en doramasorg.py.

const HOST = "https://www.doramas.org/";
const SEARCH_URL = HOST + "ajax/search.php";
const PLAY_SERIES_URL = HOST + "ajax/play.php";
const PLAY_MOVIES_URL = HOST + "ajax/play_peliculas.php";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const BASE_HEADERS = { "User-Agent": UA, "Accept-Language": "es-ES,es;q=0.9" };

// ---------- utilidades ----------

// El sitio a veces responde una verificación anti-robots ("One moment, please...")
// en lugar del contenido; se detecta y se reintenta.
function esVerificacion(html) {
  return html.indexOf("One moment, please") !== -1 && html.indexOf("wsidchk") !== -1;
}

// Igual que el .py: quita saltos de línea, espacios repetidos y &nbsp;.
function compactar(html) {
  return html.replace(/\r|\n|\t|&nbsp;|<br\s*\/?>|\s{2,}/g, "");
}

function primerMatch(texto, re) {
  const m = texto.match(re);
  return m ? m[1].trim() : "";
}

// Recorre un regex global y devuelve todos los matches.
function scan(re, texto) {
  const out = [];
  let m;
  while ((m = re.exec(texto)) !== null) {
    out.push(m);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

// Descarga texto reintentando cuando sale la verificación anti-robots.
async function bajarTexto(url, opciones) {
  for (let i = 0; i < 3; i++) {
    const r = await kino.fetch(url, opciones || {});
    const cuerpo = r.text();
    if (r.status === 429) throw kino.error("rate_limited", "doramas.org está limitando las peticiones");
    if (esVerificacion(cuerpo)) { await kino.sleep(1200); continue; }
    if (!r.ok) throw kino.error("unavailable", "doramas.org respondió " + r.status);
    return cuerpo;
  }
  throw kino.error("unavailable", "doramas.org no pasó la verificación automática; inténtalo de nuevo");
}

function bajarPagina(url, headersExtra) {
  return bajarTexto(url, { headers: Object.assign({}, BASE_HEADERS, headersExtra || {}) });
}

function postForm(url, campos, referer) {
  return bajarTexto(url, {
    method: "POST",
    headers: Object.assign({}, BASE_HEADERS, { Referer: referer, "X-Requested-With": "XMLHttpRequest" }),
    body: { form: campos },
  });
}

function slugDe(url) {
  const partes = url.replace(/\/+$/, "").split("/");
  return partes[partes.length - 1] || partes[partes.length - 2] || "item";
}

function absolutizar(url) {
  if (!url) return "";
  if (url.indexOf("//") === 0) return "https:" + url;
  if (url.charAt(0) === "/") return HOST + url;
  return url;
}

// ---------- catálogo (tarjetas) ----------

const RE_TARJETA = /<li class="col-6 col-sm-6 col-md-4 col-lg-3 col-xl-2 col-xxl-2">([\s\S]*?)<\/li>/g;
const RE_TITULO_TARJETA = /<div class="content_title fs-15 (?:pr-3|pe-3) truncate">([^<]+)<\/div>/;
const RE_ANIO = /<div class="status">([^<]*)<\/div>/;

function tarjetaAItem(bloque, tipo) {
  const url = primerMatch(bloque, /href="([^"]+)"/);
  if (!url) return null;
  let titulo = primerMatch(bloque, RE_TITULO_TARJETA);
  const anio = primerMatch(bloque, RE_ANIO);
  if (anio && titulo.indexOf("(" + anio + ")") !== -1) titulo = titulo.replace("(" + anio + ")", "").trim();
  const poster = primerMatch(bloque, /src="([^"]+)"/);
  if (!titulo) return null;
  const slug = slugDe(url);
  return {
    id: (tipo === "movie" ? "m-" : "s-") + slug,
    ref: (tipo === "movie" ? "m:" : "s:") + url,
    title: titulo,
    kind: tipo,
    year: anio || undefined,
    poster: poster || undefined,
    lang: "es",
  };
}

function parsearCatalogo(html, tipo) {
  const items = [];
  for (const m of scan(RE_TARJETA, html)) {
    const it = tarjetaAItem(compactar(m[1]), tipo);
    if (it) items.push(it);
  }
  return items;
}

function siguienteCursor(html, actual) {
  const c = compactar(html);
  const i = c.indexOf('aria-label="Page navigation"');
  if (i === -1) return null;
  const nav = c.slice(i, i + 6000);
  const a = nav.indexOf("page-item active");
  if (a === -1) return null;
  const cur = parseInt(actual || "1", 10);
  for (const m of scan(/href="[^"]*pagina=(\d+)[^"]*"/g, nav.slice(a))) {
    if (parseInt(m[1], 10) > cur) return m[1];
  }
  return null;
}

// ---------- temporadas y capítulos ----------

const RE_TEMPORADA = /<a class="number__season[^"]*"[^>]*href="([^"]+)"[\s\S]*?<h6 class="card-title">([^<]+)<\/h6>/g;
const RE_BLOQUE_CAPS = /<div class="chapters__list([\s\S]*?)<\/article>/;
const RE_CAPITULO = /<a class="media"[\s\S]*?href="([^"]+)"[\s\S]*?<h6 class="body-title truncate">([^<]+)<\/h6>/g;

function enlacesTemporadas(html) {
  const out = [];
  for (const m of scan(RE_TEMPORADA, compactar(html))) {
    const n = parseInt((m[2].match(/\d+/) || [])[0] || "0", 10) || out.length + 1;
    out.push({ url: m[1], numero: n });
  }
  return out;
}

function parsearCapitulos(html, temporada) {
  const m = html.match(RE_BLOQUE_CAPS);
  const bloque = m ? m[1] : "";
  const caps = [];
  for (const c of scan(RE_CAPITULO, bloque)) {
    const etiqueta = c[2].replace(/\s+/g, " ").trim();
    let numero = parseInt((etiqueta.match(/\d+/) || [])[0] || "0", 10);
    if (!numero) numero = caps.length + 1;
    caps.push({ season: temporada || 1, number: numero, ref: "e:" + c[1], title: etiqueta });
  }
  return caps;
}

async function listarCapitulos(urlSerie) {
  const html = await bajarPagina(urlSerie);
  const temporadas = enlacesTemporadas(html);
  const caps = [];
  if (temporadas.length) {
    for (const t of temporadas) {
      const pagina = await bajarPagina(t.url);
      for (const cap of parsearCapitulos(pagina, t.numero)) {
        if (!caps.some((x) => x.season === cap.season && x.number === cap.number)) caps.push(cap);
      }
    }
  } else {
    caps.push(...parsearCapitulos(html, 1));
  }
  return caps;
}

// ---------- búsqueda ----------

async function buscarAjax(texto, tipo) {
  const referer = tipo === "movie" ? HOST + "movies/" : HOST + "catalogo/";
  const cuerpo = await postForm(SEARCH_URL, { title: texto.replace(/ /g, "+") }, referer);
  const raw = cuerpo.replace(/\\\//g, "/");
  const items = [];
  const vistos = {};
  const re = /"slug"\s*:\s*"([^"]+)"[\s\S]*?"titulo"\s*:\s*"([^"]*)"[\s\S]*?"img"\s*:\s*"([^"]*)"/g;
  for (const m of scan(re, raw)) {
    const slug = m[1];
    if (!slug || vistos[tipo + slug]) continue;
    vistos[tipo + slug] = 1;
    const titulo = m[2].trim();
    if (!titulo) continue;
    let poster = (m[3] || "").trim();
    if (poster && poster.charAt(0) === "/") poster = "https://pics.doramas.org" + poster;
    if (tipo === "movie") {
      items.push({ id: "m-" + slug, ref: "m:" + HOST + "movies/" + slug + "/", title: titulo, kind: "movie", poster: poster || undefined, lang: "es" });
    } else {
      items.push({ id: "s-" + slug, ref: "s:" + HOST + slug + "/", title: titulo, kind: "series", poster: poster || undefined, lang: "es" });
    }
    if (items.length >= 60) break;
  }
  return items;
}

export async function search(query) {
  await null;
  const texto = (query.q || "").trim();
  if (!texto) return [];
  if (query.type === "movie") return await buscarAjax(texto, "movie");
  if (query.type === "series") return await buscarAjax(texto, "series");
  const series = await buscarAjax(texto, "series");
  const pelis = await buscarAjax(texto, "movie");
  return series.concat(pelis).slice(0, 100);
}

// ---------- home ----------

const RE_TARJETA_CAP = /<li class="col-6 col-sm-6 col-md-4 col-lg-4 col-xl-3 col-xxl-3">([\s\S]*?)<\/li>/g;

async function filaUltimos() {
  const html = await bajarPagina(HOST + "nuevos/");
  const items = [];
  for (const m of scan(RE_TARJETA_CAP, html)) {
    const bloque = compactar(m[1]);
    const url = primerMatch(bloque, /href="([^"]+)"/);
    const serie = primerMatch(bloque, /<div class="content_subtitle truncate">([^<]+)<\/div>/);
    if (!url || !serie) continue;
    const etiqueta = primerMatch(bloque, /<div class="content_title truncate">([^<]+)</);
    const numero = parseInt((etiqueta.match(/\d+/) || [])[0] || "0", 10);
    const poster = primerMatch(bloque, /src="([^"]+)"/);
    items.push({
      id: "u-" + slugDe(url),
      ref: "ep:" + url,
      title: serie + (numero ? " — Cap. " + numero : ""),
      kind: "series",
      poster: poster || undefined,
      lang: "es",
      badges: numero ? ["Cap. " + numero] : undefined,
    });
    if (items.length >= 12) break;
  }
  return items;
}

function generosDe(html) {
  const c = compactar(html);
  const i = c.indexOf("los generos");
  const f = c.indexOf("los paises", i);
  const bloque = i === -1 ? "" : c.slice(i, f === -1 ? i + 8000 : f);
  const out = [];
  const re = /id="([^"]+)"[^>]*><label class="(?:form-check-label|custom-control-label)"[^>]*>([^<]+)<\/label>/g;
  for (const m of scan(re, bloque)) {
    const nombre = m[2].trim();
    if (m[1] && nombre) out.push({ id: m[1], nombre: nombre });
  }
  out.sort((a, b) => (a.nombre.toLowerCase() < b.nombre.toLowerCase() ? -1 : 1));
  return out;
}

export async function home() {
  await null;
  const filas = [];
  try {
    const items = await filaUltimos();
    if (items.length) filas.push({ id: "ultimos", title: "Últimos capítulos", items: items, genre: "series" });
  } catch (e) { kino.log("doramas: no se pudo cargar últimos capítulos:", String((e && e.message) || e)); }

  const catalogos = [
    { id: "doramas", titulo: "Doramas", ref: "cat:catalogo", url: HOST + "catalogo/", tipo: "series", genre: "series", guardarHtml: true },
    { id: "peliculas", titulo: "Películas asiáticas", ref: "cat:movies", url: HOST + "movies/", tipo: "movie", genre: "peliculas" },
    { id: "emision", titulo: "En emisión", ref: "status:1", url: HOST + "catalogo?status=1", tipo: "series", genre: "series" },
    { id: "finalizados", titulo: "Finalizados", ref: "status:2", url: HOST + "catalogo?status=2", tipo: "series", genre: "series" },
  ];
  let htmlCatalogo = "";
  for (const cat of catalogos) {
    try {
      const html = await bajarPagina(cat.url);
      if (cat.guardarHtml) htmlCatalogo = html;
      const items = parsearCatalogo(html, cat.tipo).slice(0, 12);
      if (items.length) filas.push({ id: cat.id, title: cat.titulo, ref: cat.ref, items: items, genre: cat.genre });
    } catch (e) { kino.log("doramas: fila " + cat.id + " falló:", String((e && e.message) || e)); }
  }

  // Filas por género (máximo 6), reutilizando el HTML del catálogo.
  try {
    if (!htmlCatalogo) htmlCatalogo = await bajarPagina(HOST + "catalogo/");
    for (const g of generosDe(htmlCatalogo).slice(0, 6)) {
      try {
        const url = HOST + "catalogo?genre%5B%5D=" + encodeURIComponent(g.id);
        const items = parsearCatalogo(await bajarPagina(url), "series").slice(0, 12);
        if (items.length) filas.push({ id: "g" + g.id.replace(/[^A-Za-z0-9]/g, ""), title: "Doramas de " + g.nombre, ref: "genre:" + g.id, items: items, genre: "series" });
      } catch (e) { kino.log("doramas: género " + g.nombre + " falló"); }
    }
  } catch (e) { kino.log("doramas: no se pudieron cargar los géneros"); }

  if (!filas.length) throw kino.error("unavailable", "no se pudo cargar ninguna fila");
  return filas;
}

// ---------- browse (Ver más) ----------

export async function browse(ref, cursor) {
  await null;
  const partes = ref.split(":");
  let url, tipo;
  if (partes[0] === "cat") {
    url = HOST + partes[1] + "/";
    tipo = partes[1] === "movies" ? "movie" : "series";
  } else if (partes[0] === "status") {
    url = HOST + "catalogo?status=" + encodeURIComponent(partes[1] || "1");
    tipo = "series";
  } else if (partes[0] === "genre") {
    url = HOST + "catalogo?genre%5B%5D=" + encodeURIComponent(partes.slice(1).join(":"));
    tipo = "series";
  } else {
    throw kino.error("not_found", "sección desconocida");
  }
  if (cursor) url += (url.indexOf("?") === -1 ? "?" : "&") + "pagina=" + encodeURIComponent(cursor);
  const html = await bajarPagina(url);
  const items = parsearCatalogo(html, tipo);
  if (!items.length) throw kino.error("not_found", "esta sección está vacía o no existe");
  const pagina = { items: items };
  const next = siguienteCursor(html, cursor);
  if (next) pagina.next = next;
  return pagina;
}

// ---------- episodes ----------

export async function episodes(ref) {
  await null;
  if (ref.startsWith("s:")) {
    const caps = await listarCapitulos(ref.slice(2));
    if (!caps.length) throw kino.error("not_found", "no se encontraron capítulos");
    return { episodes: caps };
  }
  if (ref.startsWith("ep:")) {
    // Viene de "Últimos capítulos": la ref apunta a la página de UN capítulo.
    const urlCap = ref.slice(3);
    const html = await bajarPagina(urlCap);
    if (enlacesTemporadas(html).length) {
      const caps = await listarCapitulos(urlCap);
      if (caps.length) return { episodes: caps };
    }
    let caps = parsearCapitulos(html, 1);
    if (caps.length) return { episodes: caps };
    // Se adivina la página de la serie: .../nombre-c8/ -> .../nombre/
    const m = urlCap.match(/\/([a-z0-9-]+)-c(\d+)\/?$/);
    if (m) {
      caps = await listarCapitulos(HOST + m[1] + "/");
      if (caps.length) return { episodes: caps };
    }
    throw kino.error("not_found", "no se encontró la serie de este capítulo");
  }
  throw kino.error("not_found", "referencia desconocida");
}

// ---------- resolve (video) ----------

const RE_BLOQUE_SERVERS = /<ul class="dropdown-menu server([\s\S]*?)<\/ul>/;
const RE_SERVER = /<li data-lang="([^"]*)"[^>]*data-langname="([^"]*)"[\s\S]*?<a class="check">([^<]*)<\/a>/g;
const RE_IFRAME = /<iframe[^>]+src="([^"]+)"/;

function encabezadosStream(referer) {
  return { Referer: referer, "User-Agent": UA };
}

// Busca una dirección de video directa (.m3u8/.mp4) dentro de la página del reproductor externo.
function buscarVideoDirecto(html) {
  const limpiar = (u) => u.replace(/\\\//g, "/").replace(/["'\\<>\s]+$/, "").trim();
  const m3u8 = [], archivos = [], otros = [];
  for (const m of scan(/https?:(?:\\?\/){2}[^\s"'<>]+?\.m3u8[^\s"'<>]*/g, html)) m3u8.push(limpiar(m[0]));
  for (const m of scan(/["']file["']\s*:\s*["']([^"']+)["']/g, html)) archivos.push(limpiar(m[1]));
  for (const m of scan(/https?:(?:\\?\/){2}[^\s"'<>]+?\.(?:mp4|webm|mkv)[^\s"'<>]*/gi, html)) otros.push(limpiar(m[0]));
  for (const u of m3u8.concat(archivos, otros)) {
    if (/^https?:\/\//.test(u)) return u;
  }
  return "";
}

export async function resolve(ref) {
  await null;
  let tipo, url;
  if (ref.startsWith("m:")) { tipo = "movie"; url = ref.slice(2); }
  else if (ref.startsWith("e:")) { tipo = "episode"; url = ref.slice(2); }
  else if (ref.startsWith("ep:")) { tipo = "episode"; url = ref.slice(3); }
  else throw kino.error("not_found", "referencia desconocida");

  const html = await bajarPagina(url);
  const cuerpo = compactar(html);
  const bloqueM = cuerpo.match(RE_BLOQUE_SERVERS);
  const intents = [];
  for (const m of scan(RE_SERVER, bloqueM ? bloqueM[0] : "")) {
    if (m[1]) intents.push({ id: m[1], nombre: m[3].trim() });
  }
  if (!intents.length) {
    // algunas películas traen el iframe directo en la página (como dice el .py)
    const src = primerMatch(cuerpo, RE_IFRAME);
    if (src) intents.push({ iframe: absolutizar(src) });
  }

  const playUrl = tipo === "movie" ? PLAY_MOVIES_URL : PLAY_SERIES_URL;
  let detalle = "";
  for (const it of intents.slice(0, 8)) {
    let embed = it.iframe || "";
    if (!embed) {
      try {
        const resp = await postForm(playUrl, { id: it.id }, url);
        embed = absolutizar(primerMatch(compactar(resp), RE_IFRAME));
      } catch (e) {
        detalle = String((e && e.message) || e);
        continue;
      }
    }
    if (!embed) continue;
    if (/\.(m3u8|mp4|webm|mkv)(\?|#|$)/i.test(embed)) {
      return { url: embed, headers: encabezadosStream(url), expiresInSeconds: 3600 };
    }
    try {
      const paginaEmbed = await bajarPagina(embed, { Referer: url });
      const video = buscarVideoDirecto(paginaEmbed);
      if (video) return { url: video, headers: encabezadosStream(embed), expiresInSeconds: 3600 };
    } catch (e) {
      detalle = String((e && e.message) || e);
    }
  }
  throw kino.error("not_found", "no se encontró un video reproducible" + (detalle ? ": " + detalle.slice(0, 140) : ""));
}