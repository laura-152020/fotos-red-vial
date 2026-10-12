/* VIP-C — Lectura del sello de la foto en el navegador (sin servidor).
 * 1) Recorta la franja inferior de la foto (donde va el sello), la amplía y aísla el texto blanco.
 * 2) Lee el texto con Tesseract (español).
 * 3) Interpreta fecha, coordenadas, nombre del tramo y código de vía con reglas tolerantes a errores de OCR.
 */
const LectorSello = (function () {
  "use strict";

  const RUTAS = {
    workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js",
    corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0",
    langPath: "https://cdn.jsdelivr.net/npm/@tesseract.js-data/spa@1.0.0/4.0.0_best_int"
  };
  let trabajador = null;

  async function iniciar() {
    if (trabajador) return trabajador;
    if (!window.Tesseract) throw new Error("No cargó el lector de texto. Revisa la conexión y recarga la página.");
    trabajador = Tesseract.createWorker("spa", 1, RUTAS).then(async (w) => {
      await w.setParameters({ tessedit_pageseg_mode: "6", preserve_interword_spaces: "1" });
      return w;
    }).catch((e) => { trabajador = null; throw e; });
    return trabajador;
  }

  /* ---------- Preprocesamiento ---------- */
  function cargarImagen(src) {
    return new Promise((ok, mal) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => mal(new Error("No se pudo abrir la imagen.")); i.src = src; });
  }

  // modo "blanco": texto blanco → negro sobre blanco.
  // modo "sombra": igual, pero solo conserva blancos que tienen una sombra oscura cerca (descarta cielo y fondos claros).
  // modo "gris": escala de grises invertida con contraste.
  function franja(img, desdeY, hastaY, modo) {
    const sw = img.naturalWidth || img.width, sh = img.naturalHeight || img.height;
    const y0 = Math.round(sh * desdeY), alto = Math.round(sh * (hastaY - desdeY));
    const escala = Math.min(3, Math.max(1, 2200 / sw));
    const c = document.createElement("canvas");
    c.width = Math.round(sw * escala); c.height = Math.round(alto * escala);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, y0, sw, alto, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height), p = d.data;
    for (let i = 0; i < p.length; i += 4) {
      const r = p[i], g = p[i + 1], b = p[i + 2];
      const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
      let v;
      if (modo === "blanco" || modo === "sombra") v = (mn > 185 && mx - mn < 60) ? 0 : 255;
      else { const l = 0.299 * r + 0.587 * g + 0.114 * b; v = Math.max(0, Math.min(255, (255 - l - 60) * 1.6 + 128)); }
      p[i] = p[i + 1] = p[i + 2] = v; p[i + 3] = 255;
    }
    if (modo === "sombra") filtrarPorSombra(d, c.width, c.height, Math.max(4, Math.round(c.height * 0.012)), img, y0, escala);
    ctx.putImageData(d, 0, 0);
    return c;
  }

  // Mínimo de luminancia en una ventana (2 pasadas separables) para saber si cada píxel tiene sombra cerca.
  function filtrarPorSombra(d, w, h, r, img, y0, escala) {
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const cx = cv.getContext("2d", { willReadFrequently: true });
    cx.drawImage(img, 0, y0, img.naturalWidth || img.width, h / escala, 0, 0, w, h);
    const o = cx.getImageData(0, 0, w, h).data;
    const lum = new Uint8Array(w * h);
    for (let i = 0, j = 0; j < lum.length; i += 4, j++) lum[j] = (o[i] * 299 + o[i + 1] * 587 + o[i + 2] * 114) / 1000;
    const tmp = new Uint8Array(w * h), mn = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let m = 255; for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) { const v = lum[y * w + k]; if (v < m) m = v; }
      tmp[y * w + x] = m;
    }
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
      let m = 255; for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) { const v = tmp[k * w + x]; if (v < m) m = v; }
      mn[y * w + x] = m;
    }
    const p = d.data;
    for (let j = 0, i = 0; j < mn.length; j++, i += 4) if (p[i] === 0 && mn[j] > 120) p[i] = p[i + 1] = p[i + 2] = 255;
  }

  /* ---------- Interpretación ---------- */
  const MESES = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12,
    jan: 1, apr: 4, aug: 8, dec: 12 };
  const ANT = { latMin: 5.3, latMax: 9.0, lonMin: 73.7, lonMax: 77.3 }; // lon en valor absoluto

  function sinTildes(s) { return s.normalize("NFD").replace(/[̀-ͯ]/g, ""); }

  function normalizar(t) {
    return String(t || "")
      .replace(/[“”″〃]/g, '"').replace(/[‘’′´`]/g, "'").replace(/''/g, '"')
      .replace(/[º˚°]/g, "°")
      .replace(/\r/g, "");
  }

  function fechaISO(a, m, d) {
    a = Number(a); m = Number(m); d = Number(d);
    if (a < 100) a += 2000;
    if (a < 2010 || a > 2040 || m < 1 || m > 12 || d < 1 || d > 31) return "";
    const f = new Date(Date.UTC(a, m - 1, d));
    if (f.getUTCMonth() !== m - 1) return "";
    return `${a}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  function buscarFecha(texto) {
    const t = sinTildes(texto).toLowerCase().replace(/[|]/g, "1");
    // 9 de septiembre de 2026 · 9 sept. 2026 · 09-sep-2026
    let m = t.match(/(\d{1,2})\s*(?:de\s*|[-./\s])?\s*(ene|feb|mar|abr|may|jun|jul|ago|sep|set|oct|nov|dic|jan|apr|aug|dec)[a-z]*\.?\s*(?:de\s*|del\s*|[-./,\s])?\s*(\d{4})/);
    if (m) { const f = fechaISO(m[3], MESES[m[2]], m[1]); if (f) return { iso: f, texto: m[0] }; }
    // sept 9, 2026
    m = t.match(/(ene|feb|mar|abr|may|jun|jul|ago|sep|set|oct|nov|dic|jan|apr|aug|dec)[a-z]*\.?\s*(\d{1,2}),?\s*(\d{4})/);
    if (m) { const f = fechaISO(m[3], MESES[m[1]], m[2]); if (f) return { iso: f, texto: m[0] }; }
    // 2026-09-09 · 2026/09/09
    m = t.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) { const f = fechaISO(m[1], m[2], m[3]); if (f) return { iso: f, texto: m[0] }; }
    // 09/09/2026 · 9-9-26 (día/mes/año, formato Colombia)
    m = t.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
    if (m) { const f = fechaISO(m[3], m[2], m[1]); if (f) return { iso: f, texto: m[0] }; }
    return null;
  }

  function enRango(lat, lon) {
    return lat != null && lon != null && Math.abs(lat) >= ANT.latMin && Math.abs(lat) <= ANT.latMax && Math.abs(lon) >= ANT.lonMin && Math.abs(lon) <= ANT.lonMax;
  }

  function dms(g, m, s) {
    g = Number(g); m = Number(m || 0); s = Number(String(s || 0).replace(",", "."));
    if (m >= 60 || s >= 60) return null;
    return g + m / 60 + s / 3600;
  }

  /* Coordenadas. El OCR suele perder o cambiar el símbolo de grados (6°10' → 610' · 75°9' → 75%9').
   * Se interpreta cada bloque numérico con las reglas de Antioquia: latitud 5–8° (1 dígito), longitud 73–77° (2 dígitos). */
  function resolverDMS(partes, gLen) {
    const out = [];
    const add = (g, m, s) => {
      if (g === "" || m === "" || s === "" || g == null || m == null || s == null) return;
      const v = dms(g, m, s); if (v != null) out.push({ v, g: Number(g), m: Number(m), s: String(Number(s)) });
    };
    const sep = (x) => { const [a, b] = String(x).split("."); return [a, b ? "." + b : ""]; };
    if (partes.length >= 3) {
      add(partes[0], partes[1], partes[2]);
      if (partes[0].length > gLen) add(partes[0].slice(0, gLen), partes[1], partes[2]);
    }
    if (partes.length === 2) {
      const [a, b] = partes;
      if (a.length > gLen) { let m = a.slice(gLen); if (m.length > 2) m = m.slice(-2); add(a.slice(0, gLen), m, b); }
      else {
        const [ib, dec] = sep(b);
        if (ib.length === 4) add(a, ib.slice(0, 2), ib.slice(2) + dec);
        if (ib.length === 3) { add(a, ib.slice(0, 1), ib.slice(1) + dec); add(a, ib.slice(0, 2), ib.slice(2) + dec); }
        if (ib.length <= 2) add(a, dec ? ib + dec : ib, "0"); // grados y minutos decimales
      }
    }
    if (partes.length === 1) {
      const [ib, dec] = sep(partes[0]);
      const g = ib.slice(0, gLen), r = ib.slice(gLen);
      for (const rr of (r.length === 5 ? [r, r.slice(1)] : [r])) {
        if (rr.length === 4) add(g, rr.slice(0, 2), rr.slice(2) + dec);
        if (rr.length === 3) add(g, rr.slice(0, 1), rr.slice(1) + dec);
      }
    }
    return out;
  }

  function leerBloque(bloque, tipo) {
    const partes = bloque.replace(/,/g, ".").split(/[^0-9.]+/).map((p) => p.replace(/^\.+|\.+$/g, "")).filter((p) => /\d/.test(p));
    if (!partes.length) return null;
    const cands = resolverDMS(partes, tipo === "lat" ? 1 : 2);
    for (const c of cands) {
      const ok = tipo === "lat" ? (c.v >= ANT.latMin && c.v <= ANT.latMax) : (c.v >= ANT.lonMin && c.v <= ANT.lonMax);
      if (ok) return { v: c.v, txt: `${c.g}°${c.m}'${c.s}"${tipo === "lat" ? "N" : "W"}` };
    }
    return null;
  }

  function buscarCoordenadas(texto) {
    const r6 = (v) => Math.round(v * 1e6) / 1e6;
    const lineas = normalizar(texto).toUpperCase()
      .replace(/[%º˚*]/g, "°").replace(/\bV\s?W\b|\bVV\b|\bWV\b/g, "W")
      .split("\n");

    // 1) Grados-minutos-segundos con hemisferio
    let lat = null, lon = null;
    for (const l of lineas) {
      const re = /([0-9][0-9°'". ,]{1,24}?)\s*([NSWO])(?![A-ZÁÉÍÓÚÑ])/g;
      let m;
      while ((m = re.exec(l))) {
        const tipo = (m[2] === "N" || m[2] === "S") ? "lat" : "lon";
        if ((tipo === "lat" && lat) || (tipo === "lon" && lon)) continue;
        const r = leerBloque(m[1], tipo);
        if (r) { if (tipo === "lat") lat = r; else lon = r; }
      }
      // Hemisferio perdido: busca el bloque que falta en la misma línea
      if (lat && !lon) { const b = l.match(/(7[3-7][0-9°'". ]{3,20})/); if (b) lon = leerBloque(b[1], "lon"); }
      if (lon && !lat) { const b = l.match(/(?:^|[^0-9])([5-8][0-9°'". ]{3,14})/); if (b) lat = leerBloque(b[1], "lat"); }
      if (lat && lon) return { lat: r6(lat.v), lon: r6(-lon.v), latTxt: lat.txt, lonTxt: lon.txt };
    }

    // 2) Grados y minutos decimales: 6°10.700'N 75°9.950'W
    const t = lineas.join("\n");
    let m = t.match(/([5-8])\s*°\s*(\d{1,2}[.]\d+)'?\s*N[\s,;]+(7[3-7])\s*°\s*(\d{1,2}[.]\d+)'?\s*[WO]/);
    if (m) {
      const la = Number(m[1]) + Number(m[2]) / 60, lo = Number(m[3]) + Number(m[4]) / 60;
      if (Number(m[2]) < 60 && Number(m[4]) < 60) return { lat: r6(la), lon: r6(-lo), latTxt: m[1] + "°" + m[2] + "'N", lonTxt: m[3] + "°" + m[4] + "'W" };
    }

    // 3) Decimales: 6.178333, -75.165833 · LAT 6,1783 LON -75,1658 (el OCR a veces cambia el punto por guion)
    const reDec = /(-?[5-8])[.,](\d{3,8})[^0-9]{1,12}?(-?\s?7[3-7])[.,\-](\d{3,8})/g;
    while ((m = reDec.exec(t))) {
      const la = Number(m[1].replace(/\s/g, "") + "." + m[2]), lo = -Math.abs(Number(m[3].replace(/\s/g, "") + "." + m[4]));
      if (enRango(la, lo)) return { lat: r6(la), lon: r6(lo), latTxt: String(r6(la)), lonTxt: String(r6(lo)) };
    }
    return null;
  }

  const RE_CODIGO = /\b(\d[0-9O]\s?[A-Z]{2}\s?[0-9O]{2})\b/i; // código de vía departamental, ej. 60AN17 (el OCR puede leer 0 como O)
  const limpiarCodigo = (c) => { const x = c.toUpperCase().replace(/\s/g, ""); return x.slice(0, 2).replace(/O/g, "0") + x.slice(2, 4) + x.slice(4).replace(/O/g, "0"); };
  function buscarTramo(texto) {
    const lineas = normalizar(texto).split("\n").map((l) => l.trim()).filter(Boolean);
    let codigo = "";
    for (const l of lineas) { const c = l.match(RE_CODIGO); if (c) { codigo = limpiarCodigo(c[1]); break; } }
    for (const l of lineas) {
      const m = l.match(/^\W*v[ií1l]a[s]?\b\s*[:.\-]?\s*(.+)$/i);
      if (m && /[a-záéíóúñ]{3}/i.test(m[1])) return { tramo: limpiarTramo(m[1].replace(RE_CODIGO, "")), codigo };
    }
    for (const l of lineas) {
      if (/\d/.test(l)) continue;
      const m = l.match(/([A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ .]{2,})\s*[-–—]\s*([A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ .]{2,})/);
      if (m) return { tramo: limpiarTramo(m[0]), codigo };
    }
    return { tramo: "", codigo };
  }
  function limpiarTramo(s) {
    return s.replace(/[|_~«»"]/g, "")
      .replace(/[.,;:]+\s*(?=[-–—])/g, " ")
      .replace(/\s*[-–—]+\s*/g, " - ")
      .replace(/(\s+[^\s]{1})+\s*$/, "")      // basura de 1 carácter al final (OCR)
      .replace(/\s{2,}/g, " ").replace(/[\s.,;:-]+$/, "").trim();
  }

  function interpretar(texto) {
    const f = buscarFecha(texto), c = buscarCoordenadas(texto), v = buscarTramo(texto);
    return {
      fecha: f ? f.iso : "", fechaTexto: f ? f.texto : "",
      latitud: c ? c.lat : null, longitud: c ? c.lon : null,
      latitudDMS: c ? c.latTxt : "", longitudDMS: c ? c.lonTxt : "",
      tramo: v.tramo, codigoVia: v.codigo
    };
  }

  function puntaje(r) { return (r.latitud != null ? 4 : 0) + (r.fecha ? 2 : 0) + (r.tramo ? 1 : 0); }

  /* ---------- Lectura completa ---------- */
  async function leer(src) {
    const img = await cargarImagen(src);
    const w = await iniciar();
    const intentos = [[0.55, 1, "blanco"], [0.55, 1, "sombra"], [0.35, 1, "blanco"], [0.55, 1, "gris"], [0, 0.4, "blanco"]];
    let mejor = null, textos = [];
    for (const [a, b, modo] of intentos) {
      const { data } = await w.recognize(franja(img, a, b, modo));
      textos.push(data.text);
      const r = interpretar(data.text);
      // Combina lo mejor de cada intento
      if (!mejor) mejor = r;
      else {
        if (mejor.latitud == null && r.latitud != null) Object.assign(mejor, { latitud: r.latitud, longitud: r.longitud, latitudDMS: r.latitudDMS, longitudDMS: r.longitudDMS });
        if (!mejor.fecha && r.fecha) Object.assign(mejor, { fecha: r.fecha, fechaTexto: r.fechaTexto });
        if (!mejor.tramo && r.tramo) mejor.tramo = r.tramo;
        if (!mejor.codigoVia && r.codigoVia) mejor.codigoVia = r.codigoVia;
      }
      if (puntaje(mejor) >= 7) break;
    }
    mejor.textoLeido = textos.join("\n---\n");
    mejor.selloLegible = mejor.latitud != null && !!mejor.fecha;
    return mejor;
  }

  return { leer, interpretar, iniciar, _franja: franja };
})();
