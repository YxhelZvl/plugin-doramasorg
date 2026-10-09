/// <reference path="./kino.d.ts" />
// Doramas.org — plugin para Kino
// Doramas y películas asiáticas subtituladas al español.
// Fuente: https://www.doramas.org/
//
// Servidores del sitio (se eligen por idioma, su hash cambia por título):
//   Korii  -> kory.4meplayer.pro   (armado por JS: navegador oculto)
//   Maru   -> my.mail.ru           (API de metadatos: MP4 directo)
//   Okru   -> ok.ru                (armado por JS: navegador oculto)
//   PDrive -> doramas.org/kmp4.php -> stream.php -> MP4 directo (pixeldrain)
//   Evo    -> voe.sx               (armado por JS: navegador oculto)
// El video final vive en CDNs que rotan (pixeldrain, cdn*.my.mail.ru, ...),
// por eso el manifiesto declara "streamHosts": "any".

const HOST = "https://www.doramas.org/";
const SEARCH_URL = HOST + "ajax/search.php";
const PLAY_SERIES_URL = HOST + "ajax/play.php";
const PLAY_MOVIES_URL = HOST + "ajax/play_peliculas.php";
const LIST_CHAPTER_URL = HOST + "ajax/list_chapter.php";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ---------- idioma y textos ----------

function esIngles() {
  return typeof kino.lang === "string" && kino.lang.slice(0, 2) === "en";
}

// Frases propias para la persona (apiVersion 6, userMessage). Siguen kino.lang.
function texto(clave) {
  const tabla = {
    sinServidores: { es: "No se encontraron servidores para este título.", en: "No servers found for this title." },
    sinVideo: { es: "Este título ya no está disponible en ningún servidor.", en: "This title is no longer available on any server." },
    servidorCaido: { es: "Este servidor no responde; prueba con otro.", en: "This server is not responding; try another one." },
  };
  const m = tabla[clave];
  return m ? (esIngles() ? m.en : m.es) : "";
}

function encabezadosBase() {
  return {
    "User-Agent": UA,
    "Accept-Language": esIngles() ? "en-US,en;q=0.9" : "es-ES,es;q=0.9",
  };
}

// Un error propio de Kino (kino.error) se propaga; un fallo de red de un
// servidor concreto no mata la llamada.
function esKinoError(e) {
  return !!e && typeof e.name === "string" && e.name.indexOf("KinoError_") === 0;
}

// ---------- utilidades ----------

// El sitio a veces responde una verificación anti-robots en lugar del contenido.
function esVerificacion(html) {
  return html.indexOf("One moment, please") !== -1 && html.indexOf("wsidchk") !== -1;
}

function compactar(html) {
  return html.replace(/\r|\n|\t|&nbsp;|<br\s*\/?>|\s{2,}/g, "");
}

function primerMatch(texto, re) {
  const m = texto.match(re);
  return m ? m[1].trim() : "";
}

function scan(re, texto) {
  const out = [];
  let m;
  while ((m = re.exec(texto)) !== null) {
    out.push(m);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

function slugDe(url) {
  const partes = url.replace(/\/+$/, "").split("/");
  return partes[partes.length - 1] || partes[partes.length - 2] || "item";
}

function absolutizar(url) {
  if (!url) return "";
  if (url.indexOf("//") === 0) return "https:" + url;
  if (url.charAt(0) === "/") return HOST + url.slice(1);
  return url;
}

function hostDe(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return "";
  }
}

// ---------- red ----------

// Descarga texto reintentando cuando sale la verificación anti-robots.
async function bajarTexto(url, opciones) {
  for (let i = 0; i < 3; i++) {
    const r = await kino.fetch(url, opciones || {});
    const cuerpo = r.text();
    if (r.status === 429) throw kino.error("rate_limited", "doramas.org está limitando las peticiones");
    if (esVerificacion(cuerpo)) {
      await kino.sleep(1200);
      continue;
    }
    if (!r.ok) throw kino.error("unavailable", "doramas.org respondió " + r.status);
    return cuerpo;
  }
  throw kino.error("unavailable", "doramas.org no pasó la verificación automática");
}

function bajarPagina(url, headersExtra) {
  return bajarTexto(url, { headers: Object.assign(encabezadosBase(), headersExtra || {}) });
}

function postForm(url, campos, referer) {
  return bajarTexto(url, {
    method: "POST",
    headers: Object.assign(encabezadosBase(), {
      Referer: referer,
      "X-Requested-With": "XMLHttpRequest",
    }),
    body: { form: campos },
  });
}

async function postJSON(url, campos, referer) {
  const cuerpo = await postForm(url, campos, referer);
  try {
    return JSON.parse(cuerpo);
  } catch (e) {
    return null;
  }
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

// ---------- géneros ----------

function generosDe(html) {
  const c = compactar(html);
  const i = c.indexOf("los generos");
  if (i === -1) return [];
  const f = c.indexOf("los paises", i);
  const bloque = f === -1 ? c.slice(i, i + 12000) : c.slice(i, f);
  const out = [];
  const vistos = {};
  for (const m of scan(/id="([^"]+)"[^>]*name="genre\[\]"[^>]*value="([^"]+)"[^>]*><label class="(?:form-check-label|custom-control-label)"[^>]*>([^<]+)<\/label>/g, bloque)) {
    const id = m[2] || m[1];
    const nombre = m[3].trim();
    if (id && nombre && !vistos[id]) {
      vistos[id] = 1;
      out.push({ id: id, nombre: nombre });
    }
  }
  out.sort((a, b) => (a.nombre.toLowerCase() < b.nombre.toLowerCase() ? -1 : 1));
  return out;
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

// El botón "Lista" de la página trae el id numérico de la serie.
function idDePagina(html) {
  const m = compactar(html).match(/id="lista"[^>]*data-id="(\d+)"/);
  return m ? m[1] : "";
}

// API de capítulos del sitio: drama{titulo,slug}, temps[] y caps[] de la temporada pedida.
async function apiCapitulos(id, temporada) {
  const data = await postJSON(LIST_CHAPTER_URL, { id: id, ids: temporada }, HOST);
  return data || {};
}

function episodioDeApi(c, slug, temporada) {
  const cap = parseInt(c.cap, 10);
  if (!cap || !slug) return null;
  const url = (c.web || "https://www.doramas.org") + "/" + slug + (temporada === 1 ? "" : "-t" + temporada) + "-c" + c.cap + "/";
  return {
    season: temporada,
    number: cap,
    ref: "e:" + url,
    title: "Capítulo " + (c.capitulo || c.cap),
    still: c.img_caps || undefined,
  };
}

// Episodios por la API del sitio. La temporada 1 de algunas series solo existe
// inline en su página: si la API no la devuelve, se usan esos capítulos.
async function episodiosConId(id, capsInline) {
  const primera = await apiCapitulos(id, 1);
  const drama = primera.drama || {};
  const slug = drama.slug || "";
  const temps = (primera.temps || []).map((t) => parseInt(t.temporada, 10) || 1);
  const episodios = [];
  const vistos = {};
  let inlinePendiente = capsInline.length > 0;
  for (const t of temps) {
    let caps = t === 1 ? primera.caps || [] : (await apiCapitulos(id, t)).caps || [];
    if (t === 1 && !caps.length) caps = capsInline;
    if (t === 1 && caps.length) inlinePendiente = false;
    for (const c of caps) {
      const ep = episodioDeApi(c, slug, t);
      if (!ep) continue;
      const clave = ep.season + "x" + ep.number;
      if (!vistos[clave]) {
        vistos[clave] = 1;
        episodios.push(ep);
      }
    }
  }
  if (inlinePendiente) {
    for (const cap of capsInline) {
      const clave = cap.season + "x" + cap.number;
      if (!vistos[clave]) {
        vistos[clave] = 1;
        episodios.push(cap);
      }
    }
  }
  return { titulo: drama.titulo || "", episodios: episodios };
}

// El id de la serie no está en su página: se pide la de su primer capítulo.
async function idDeSerie(html, urlSerie, capsInline) {
  const id = idDePagina(html);
  if (id) return id;
  let urlCap = capsInline.length ? capsInline[0].ref.slice(2) : HOST + slugDe(urlSerie) + "-c1/";
  try {
    const htmlCap = await bajarPagina(urlCap);
    return idDePagina(htmlCap);
  } catch (e) {
    return "";
  }
}

function infoDeSerie(html, tituloApi) {
  const info = {};
  const titulo = tituloApi || primerMatch(html, /property="og:title" content="([^"]*)"/);
  if (titulo) info.title = titulo;
  const poster = primerMatch(html, /property="og:image" content="([^"]*)"/);
  if (poster) info.poster = poster;
  return info;
}

// ---------- búsqueda ----------

// El sitio solo busca series por texto (las películas se exploran en el catálogo).
export async function search(query) {
  await null;
  const q = (query.q || "").trim();
  if (!q) return [];
  if (query.type === "movie") return [];
  const data = await postJSON(SEARCH_URL, { title: q }, HOST + "catalogo/");
  const fichas = (data && data.fichas) || [];
  const items = [];
  const vistos = {};
  for (const f of fichas) {
    if (!f.slug || !f.titulo || vistos[f.slug]) continue;
    vistos[f.slug] = 1;
    let poster = (f.img || "").trim();
    if (poster && poster.charAt(0) === "/") poster = "https://pics.doramas.org" + poster;
    items.push({
      id: "s-" + f.slug,
      ref: "s:" + HOST + f.slug + "/",
      title: f.titulo.trim(),
      kind: "series",
      poster: poster || undefined,
      lang: "es",
    });
    if (items.length >= 100) break;
  }
  return items;
}

// ---------- Inicio ----------

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

export async function home() {
  await null;
  const filas = [];
  try {
    const items = await filaUltimos();
    if (items.length) filas.push({ id: "ultimos", title: "Últimos capítulos", items: items, genre: "series" });
  } catch (e) {
    kino.log("doramas: no se pudo cargar últimos capítulos:", String((e && e.message) || e));
  }

  const catalogos = [
    { id: "doramas", titulo: "Doramas", ref: "cat:catalogo", url: HOST + "catalogo/", tipo: "series", genre: "series" },
    { id: "peliculas", titulo: "Películas asiáticas", ref: "cat:movies", url: HOST + "movies/", tipo: "movie", genre: "peliculas" },
    { id: "emision", titulo: "En emisión", ref: "status:1", url: HOST + "catalogo?status=1", tipo: "series", genre: "series" },
    { id: "finalizados", titulo: "Finalizados", ref: "status:2", url: HOST + "catalogo?status=2", tipo: "series", genre: "series" },
  ];
  let htmlCatalogo = "";
  for (const cat of catalogos) {
    try {
      const html = await bajarPagina(cat.url);
      if (cat.id === "doramas") htmlCatalogo = html;
      const items = parsearCatalogo(html, cat.tipo).slice(0, 12);
      if (items.length) filas.push({ id: cat.id, title: cat.titulo, ref: cat.ref, items: items, genre: cat.genre });
    } catch (e) {
      kino.log("doramas: fila " + cat.id + " falló:", String((e && e.message) || e));
    }
  }

  // Filas por género (máximo 6), reutilizando el HTML del catálogo.
  try {
    if (!htmlCatalogo) htmlCatalogo = await bajarPagina(HOST + "catalogo/");
    let n = 0;
    for (const g of generosDe(htmlCatalogo).slice(0, 6)) {
      n++;
      try {
        const url = HOST + "catalogo?genre%5B%5D=" + encodeURIComponent(g.id);
        const items = parsearCatalogo(await bajarPagina(url), "series").slice(0, 12);
        if (items.length) {
          filas.push({
            id: "g" + n + "-" + g.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 16),
            title: "Doramas de " + g.nombre,
            ref: "genre:" + g.id,
            items: items,
            genre: "series",
          });
        }
      } catch (e) {
        kino.log("doramas: género " + g.nombre + " falló");
      }
    }
  } catch (e) {
    kino.log("doramas: no se pudieron cargar los géneros");
  }

  if (!filas.length) throw kino.error("unavailable", "no se pudo cargar ninguna fila");
  return filas;
}

// ---------- Categorías (apiVersion 6) ----------

export async function categories() {
  await null;
  const out = [
    { id: "doramas", title: "Doramas", ref: "cat:catalogo" },
    { id: "peliculas", title: "Películas", ref: "cat:movies" },
    { id: "emision", title: "En emisión", ref: "status:1" },
    { id: "finalizados", title: "Finalizados", ref: "status:2" },
  ];
  try {
    const html = await bajarPagina(HOST + "catalogo/");
    let n = 0;
    for (const g of generosDe(html)) {
      n++;
      out.push({
        id: "g" + n + "-" + g.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 16),
        title: g.nombre.slice(0, 40),
        ref: "genre:" + g.id,
      });
      if (out.length >= 24) break;
    }
  } catch (e) {
    kino.log("doramas: no se pudieron cargar los géneros de Categorías");
  }
  return out;
}

// ---------- Explorar más (browse) ----------

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
  } else if (partes[0] === "mgenre") {
    url = HOST + "movies?genre%5B%5D=" + encodeURIComponent(partes.slice(1).join(":"));
    tipo = "movie";
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

// ---------- episodios ----------

export async function episodes(ref) {
  await null;
  if (ref.startsWith("s:")) return await episodiosDeSerie(ref.slice(2));
  if (ref.startsWith("ep:")) return await episodiosDeCapitulo(ref.slice(3));
  throw kino.error("not_found", "referencia desconocida");
}

async function episodiosDeSerie(urlSerie) {
  const html = await bajarPagina(urlSerie);
  const capsInline = parsearCapitulos(html, 1);
  const id = await idDeSerie(html, urlSerie, capsInline);
  if (id) {
    const r = await episodiosConId(id, capsInline);
    if (r.episodios.length) return { series: infoDeSerie(html, r.titulo), episodes: r.episodios };
  }
  // Sin API: temporadas como enlaces y sus páginas.
  const caps = await episodiosHTML(html, urlSerie);
  if (!caps.length) throw kino.error("not_found", "no se encontraron capítulos");
  return { episodes: caps };
}

async function episodiosHTML(html, urlSerie) {
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

// "Últimos capítulos": la ref apunta a la página de UN capítulo.
async function episodiosDeCapitulo(urlCap) {
  const html = await bajarPagina(urlCap);
  const id = idDePagina(html);
  if (id) {
    const r = await episodiosConId(id, []);
    if (r.episodios.length) return { series: { title: r.titulo }, episodes: r.episodios };
  }
  const urlSerie = enlaceASerie(html);
  if (urlSerie) return await episodiosDeSerie(urlSerie);
  const adivinada = urlCap.match(/\/([a-z0-9-]+)-t?\d*-c\d+\/?$/);
  if (adivinada) return await episodiosDeSerie(HOST + adivinada[1] + "/");
  throw kino.error("not_found", "no se encontró la serie de este capítulo");
}

// Enlace a la serie desde su página de capítulo (el título, con class="item").
function enlaceASerie(html) {
  const m = compactar(html).match(/<a class="item" href="(https:\/\/www\.doramas\.org\/[^"]*\/[^"]*\/)"/);
  return m ? m[1] : "";
}

// ---------- resolve (video) ----------

const RE_IFRAME = /<iframe[^>]+src="([^"]+)"/;

// Desplegables de idioma y de servidores de la página del título.
function desplegable(html, clase) {
  const m = html.match(new RegExp('<ul class="dropdown-menu[^"]*' + clase + '[^"]*"[^>]*>([\\s\\S]*?)<\\/ul>'));
  return m ? m[1] : "";
}

function parsearEntradas(bloque) {
  const out = [];
  for (const m of scan(/<li data-lang="([^"]+)"([^>]*)>([\s\S]*?)<\/li>/g, bloque)) {
    const attrs = m[2];
    const langname = primerMatch(attrs, /data-langname="([^"]*)"/);
    const clase = primerMatch(attrs, /class="([^"]*)"/);
    const nombre = m[3].replace(/<[^>]*>/g, "").trim();
    if (m[1] && nombre) {
      out.push({ hash: m[1], langname: langname || "", activo: clase.indexOf("active") !== -1, nombre: nombre });
    }
  }
  return out;
}

// Idiomas y servidores, con los del idioma activo primero.
function idiomasYServidores(html) {
  const c = compactar(html);
  const idiomas = parsearEntradas(desplegable(c, "select_langser") + desplegable(c, "select_langs"));
  const servidores = parsearEntradas(desplegable(c, "select_servers") + desplegable(c, "select_movie_servers"));
  const activo = idiomas.find((i) => i.activo) || idiomas[0] || null;
  const lang = activo ? activo.hash : "";
  const ordenados = [];
  for (const s of servidores) if (s.langname === lang) ordenados.push(s);
  for (const s of servidores) if (s.langname !== lang) ordenados.push(s);
  return { idioma: activo, servidores: ordenados };
}

// El iframe de un servidor: POST al endpoint del sitio con el hash del servidor.
async function iframeDeServidor(hash, esPelicula, referer) {
  const cuerpo = await postForm(esPelicula ? PLAY_MOVIES_URL : PLAY_SERIES_URL, { id: hash }, referer);
  return primerMatch(cuerpo, RE_IFRAME);
}

// PDrive: reproductor JW cuyo "file" es stream.php, que redirige al MP4
// en un CDN que rota (pixeldrain, ...). Se devuelve la dirección de
// doramas.org y deja que el reproductor siga la redirección: eso lo cubre
// "streamHosts": "any" (kino.fetch no puede seguir a un host no declarado).
async function resolverKmp4(src, referer) {
  const html = await bajarPagina(src, { Referer: referer });
  const archivo = primerMatch(html, /"file"\s*:\s*"([^"]+)"/);
  if (!archivo) return null;
  const url = absolutizar(archivo);
  if (!url) return null;
  return { url: url, mime: "video/mp4", headers: { Referer: HOST } };
}

// Maru: la página del embed trae la URL de metadatos con los MP4 en un CDN
// (cdn<N>.my.mail.ru; el número cambia). Se devuelve el MP4 tal cual: lo
// cubre "streamHosts": "any".
async function resolverMailru(src, referer) {
  const m = src.match(/video\/embed\/(\d+)/);
  if (!m) return null;
  const meta = await bajarTexto("https://my.mail.ru/+/video/meta/" + m[1], {
    headers: Object.assign(encabezadosBase(), { Referer: src }),
  });
  let data;
  try {
    data = JSON.parse(meta);
  } catch (e) {
    return null;
  }
  const videos = (data && data.videos) || [];
  let mejor = null;
  let mejorCal = -1;
  for (const v of videos) {
    const cal = parseInt(primerMatch(v.key || "", /(\d+)/), 10) || 0;
    if (v.url && cal > mejorCal) {
      mejorCal = cal;
      mejor = v;
    }
  }
  if (!mejor) return null;
  const url = mejor.url.charAt(0) === "/" ? "https:" + mejor.url : mejor.url;
  return { url: url, mime: "video/mp4", headers: { Referer: "https://my.mail.ru/" } };
}

// Servidores que arman la dirección con sus propios scripts: navegador oculto.
async function resolverNavegador(src, referer) {
  if (typeof kino.browser === "undefined" || typeof kino.browser.capture !== "function") return null;
  let cap;
  try {
    cap = await kino.browser.capture(src, { headers: { Referer: referer } });
  } catch (e) {
    return null;
  }
  const medio = cap && cap.media && cap.media[0];
  if (!medio || !medio.url) return null;
  return { url: medio.url, mime: medio.mime, headers: medio.headers || {} };
}

// Acortador (PDrive en películas): se pide sin seguir la redirección y se
// devuelve la siguiente dirección; el reproductor sigue el resto de la cadena
// (cubierto por "streamHosts": "any").
async function resolverRedir(src, referer) {
  let r;
  try {
    r = await kino.fetch(src, {
      headers: Object.assign(encabezadosBase(), { Referer: referer }),
      redirect: "manual",
    });
  } catch (e) {
    return null;
  }
  const tipo = (r.headers["content-type"] || "").split(";")[0].trim();
  const lugar = (r.headers["location"] || "").trim();
  if ([301, 302, 303, 307, 308].includes(r.status) && lugar) {
    const url = absolutizar(lugar);
    if (url) return { url: url, headers: { Referer: referer } };
  }
  if (r.ok && (tipo.indexOf("video/") === 0 || tipo === "application/octet-stream")) {
    return { url: r.url, mime: tipo === "application/octet-stream" ? undefined : tipo, headers: { Referer: referer } };
  }
  return null;
}

// Dominios de servidor que el plugin sabe resolver. Los servidores con
// un dominio fuera de esta lista se omiten (doramas.org los cambia
// según el título; si aparece uno nuevo, el plugin sigue funcionando
// con los demás en lugar de fallar).
const HOSTS_SOPORTADOS = {
  "www.doramas.org": true,
  "doramas.org": true,
  "my.mail.ru": true,
  "short.icu": true,
  "ok.ru": true,
  "kory.4meplayer.pro": true,
  "voe.sx": true,
  "vk.com": true,
  "playmogo.com": true,
};

async function resolverIframe(src, referer) {
  if (!src) return null;
  const host = hostDe(src);
  if (host === "www.doramas.org" || host === "doramas.org") return await resolverKmp4(src, referer);
  if (host === "my.mail.ru") return await resolverMailru(src, referer);
  if (host === "ok.ru" || host === "kory.4meplayer.pro" || host === "voe.sx" || host === "vk.com" || host === "playmogo.com") return await resolverNavegador(src, referer);
  if (host === "short.icu") return await resolverRedir(src, referer);
  return null;
}

function etiquetaDe(idioma, servidor) {
  const nombre = (idioma && idioma.nombre ? idioma.nombre + " · " : "") + servidor.nombre;
  return nombre.slice(0, 48);
}

// Resuelve un capítulo o una película: sondea los servidores del idioma activo
// y devuelve el mejor (directo primero), con los demás como copias perezosas.
async function resolverTitulo(url, hash, esPelicula) {
  const html = await bajarPagina(url);
  const { idioma, servidores } = idiomasYServidores(html);
  if (!servidores.length) {
    throw kino.error("not_found", "no se encontraron servidores", { userMessage: texto("sinServidores") });
  }

  // Una copia perezosa concreta: solo ese servidor.
  if (hash) {
    const elegido = servidores.find((s) => s.hash === hash);
    if (elegido) {
      let src = "";
      try {
        src = await iframeDeServidor(elegido.hash, esPelicula, url);
      } catch (e) {
        if (esKinoError(e)) throw e;
      }
      const stream = src ? await resolverIframe(src, url) : null;
      if (stream) {
        stream.label = etiquetaDe(idioma, elegido);
        return stream;
      }
      throw kino.error("unavailable", "el servidor no respondió", { userMessage: texto("servidorCaido") });
    }
  }

  // Sondeo: iframe de cada servidor (como máximo 8). Solo se guardan
  // los dominios que sabemos resolver; los directos van primero.
  const probados = [];
  const directos = [];
  const deNavegador = [];
  for (const s of servidores.slice(0, 8)) {
    let src = "";
    try {
      src = await iframeDeServidor(s.hash, esPelicula, url);
    } catch (e) {
      if (esKinoError(e)) throw e;
      continue;
    }
    if (!src) continue;
    const host = hostDe(src);
    if (!HOSTS_SOPORTADOS[host]) continue;
    const entrada = { s: s, src: src };
    probados.push(entrada);
    if (host === "www.doramas.org" || host === "doramas.org" || host === "my.mail.ru" || host === "short.icu") {
      directos.push(entrada);
    } else {
      deNavegador.push(entrada);
    }
  }

  const candidatos = directos.concat(deNavegador);
  if (!candidatos.length) {
    throw kino.error("not_found", "ningún servidor dio una dirección de video", { userMessage: texto("sinVideo") });
  }
  for (const candidato of candidatos) {
    let stream = null;
    try {
      stream = await resolverIframe(candidato.src, url);
    } catch (e) {
      if (esKinoError(e)) throw e;
      continue;
    }
    if (!stream) continue;
    stream.label = etiquetaDe(idioma, candidato.s);
    const alternativas = [];
    for (const otro of probados) {
      if (otro.s.hash === candidato.s.hash) continue;
      alternativas.push({
        label: etiquetaDe(idioma, otro.s),
        ref: (esPelicula ? "m:" : "e:") + url + "|" + otro.s.hash,
      });
      if (alternativas.length >= 8) break;
    }
    if (alternativas.length) stream.alternatives = alternativas;
    return stream;
  }
  throw kino.error("unavailable", "ningún servidor respondió", { userMessage: texto("sinVideo") });
}

export async function resolve(ref) {
  await null;
  const corte = ref.indexOf("|");
  const base = corte === -1 ? ref : ref.slice(0, corte);
  const hash = corte === -1 ? "" : ref.slice(corte + 1);
  if (base.startsWith("e:")) return await resolverTitulo(base.slice(2), hash, false);
  if (base.startsWith("m:")) return await resolverTitulo(base.slice(2), hash, true);
  throw kino.error("not_found", "referencia desconocida");
}
