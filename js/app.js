/* VIP-C — Visor interactivo de puntos críticos · Gobernación de Antioquia
 * 1) Carga manual de datos  ·  2) Carga fotográfica con relleno automático (lectura del sello)
 * Guardado: Apps Script (Drive + Sheets) si hay API_URL configurada; si no, en el navegador del dispositivo.
 */
(function () {
  "use strict";

  /* ======================= Catálogos ======================= */
  const TIPOS_AFECTACION = [
    "Deslizamiento / movimiento en masa", "Pérdida de banca", "Hundimiento de la vía",
    "Socavación", "Caída de rocas", "Obstrucción de drenaje o alcantarilla", "Daño en puente o pontón",
    "Daño en muro de contención", "Deterioro de la calzada (baches)", "Inundación", "Árbol caído", "Otro"
  ];
  const RESPONSABLES = ["Gobernación", "Rental", "Alcaldía", "Ciudadanía"];
  const ESTADOS = ["Crítico", "No crítico"];
  const ANTIOQUIA = { latMin: 5.40, latMax: 8.90, lonMin: -77.15, lonMax: -73.85 };
  const HAY_BACKEND = typeof CONFIG !== "undefined" && !!CONFIG.API_URL;

  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  const hoy = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

  let items = [];
  let sec = 1;

  /* ======================= Municipios ======================= */
  const MUN_POR_NOMBRE = {};
  MUNICIPIOS.forEach((m) => { MUN_POR_NOMBRE[norm(m.n)] = m; });
  // Alias comunes
  [["santa fe de antioquia", "santafe de antioquia"], ["carolina del principe", "carolina"], ["el penol", "penol"], ["el retiro", "retiro"],
   ["san vicente ferrer", "san vicente"], ["el santuario", "santuario"], ["donmatias", "don matias"], ["entrerrios", "entre rios"]]
    .forEach(([a, b]) => { if (MUN_POR_NOMBRE[a]) MUN_POR_NOMBRE[b] = MUN_POR_NOMBRE[a]; });
  $("#lista-municipios").innerHTML = MUNICIPIOS.map((m) => `<option value="${esc(m.n)}">`).join("");

  function enAnillo(x, y, r) {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  }
  function municipioEn(lat, lon) {
    if (lat == null || lon == null) return null;
    for (const m of MUNICIPIOS) for (const p of m.p) {
      if (enAnillo(lon, lat, p[0]) && !p.slice(1).some((h) => enAnillo(lon, lat, h))) return m;
    }
    return null;
  }

  /* ======================= Coordenadas ======================= */
  function dmsADecimal(s) {
    if (s === null || s === undefined || s === "") return null;
    s = String(s).replace(/,/g, ".").trim();
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    const m = s.match(/(-?\d+(?:\.\d+)?)\s*[°º]?\s*(?:(\d+(?:\.\d+)?)\s*['′’]?)?\s*(?:(\d+(?:\.\d+)?)\s*["″”]?)?\s*([NSEWOnsewo])?/);
    if (!m) return null;
    let v = Math.abs(Number(m[1])) + Number(m[2] || 0) / 60 + Number(m[3] || 0) / 3600;
    const h = (m[4] || "").toUpperCase();
    if (h === "S" || h === "W" || h === "O" || Number(m[1]) < 0) v = -v;
    return Math.round(v * 1e6) / 1e6;
  }
  function decimalADMS(v, esLat) {
    if (v == null || isNaN(v)) return "";
    const a = Math.abs(v), g = Math.floor(a), mf = (a - g) * 60, m = Math.floor(mf), s = Math.round((mf - m) * 60 * 10) / 10;
    return `${g}°${m}'${s}"${esLat ? (v < 0 ? "S" : "N") : (v < 0 ? "W" : "E")}`;
  }
  const tieneCoord = (r) => r.latitud != null && r.longitud != null && !isNaN(r.latitud) && !isNaN(r.longitud);
  const fuera = (r) => tieneCoord(r) && (r.latitud < ANTIOQUIA.latMin || r.latitud > ANTIOQUIA.latMax || r.longitud < ANTIOQUIA.lonMin || r.longitud > ANTIOQUIA.lonMax);

  function nuevoRegistro(extra) {
    return Object.assign({
      id: sec++, origen: "manual", estado: "manual", mensaje: "",
      fecha: "", fechaTexto: "", latitudDMS: "", longitudDMS: "", latitud: null, longitud: null, origenUbicacion: "",
      codigoVia: "", nombreTramo: "", subregion: "", municipio: "", municipioAuto: false,
      tipoAfectacion: "", responsable: "", estadoPunto: "", observaciones: "", selloLegible: false
    }, extra || {});
  }

  // Al tener coordenadas, sugiere municipio y subregión (si el usuario no los escribió a mano)
  function completarDesdeCoordenadas(r) {
    if (!tieneCoord(r)) return;
    if (r.municipio && !r.municipioAuto) return;
    const m = municipioEn(r.latitud, r.longitud);
    if (m) { r.municipio = m.n; r.subregion = m.s; r.municipioAuto = true; }
  }
  function completarSubregion(r) {
    const m = MUN_POR_NOMBRE[norm(r.municipio)];
    if (m) { r.municipio = m.n; r.subregion = m.s; }
  }

  /* ======================= Campos (compartidos: manual y tarjetas) ======================= */
  function opciones(arr, v) {
    return '<option value="">Seleccionar…</option>' + arr.map((o) => `<option${o === v ? " selected" : ""}>${esc(o)}</option>`).join("");
  }
  function lineaCoord(r) {
    if (!tieneCoord(r)) return "Sin coordenadas";
    const origen = { pdf: "leídas del PDF", sello: "leídas del sello", gps: "GPS de la foto", dispositivo: "ubicación del dispositivo", manual: "escritas a mano", servidor: "leídas del sello" }[r.origenUbicacion] || "";
    return `${r.latitud.toFixed(6)}, ${r.longitud.toFixed(6)}${origen ? " · " + origen : ""} <a href="https://www.google.com/maps?q=${r.latitud},${r.longitud}" target="_blank" rel="noopener">Ver ubicación</a>`;
  }
  function campos(r, p) {
    const alerta = fuera(r) ? '<div class="alerta">La ubicación cae fuera de Antioquia. Verifica las coordenadas.</div>' : "";
    return `
      <div class="grid">
        <label for="${p}fe"><span>Fecha de la visita <em>*</em></span><input id="${p}fe" type="date" data-k="fecha" value="${esc(r.fecha)}"></label>
        <label for="${p}la"><span>Latitud</span><input id="${p}la" class="mono" data-k="latitudDMS" value="${esc(r.latitudDMS)}" placeholder="6°10'42&quot;N" inputmode="text"></label>
        <label for="${p}lo"><span>Longitud</span><input id="${p}lo" class="mono" data-k="longitudDMS" value="${esc(r.longitudDMS)}" placeholder="75°9'57&quot;W" inputmode="text"></label>
      </div>
      <div class="coord" data-coord>${lineaCoord(r)}</div>${alerta}
      <div class="grid grid--2">
        <label for="${p}cv"><span>Código oficial de la vía</span><input id="${p}cv" class="mono" data-k="codigoVia" value="${esc(r.codigoVia)}" placeholder="Ej. 60AN17" autocomplete="off"></label>
        <label for="${p}nt"><span>Nombre del tramo</span><input id="${p}nt" data-k="nombreTramo" value="${esc(r.nombreTramo)}" placeholder="Ej. Medellín - Turbo" autocomplete="off"></label>
      </div>
      <div class="grid grid--2">
        <label for="${p}sr"><span>Subregión ${r.municipioAuto ? '<span class="auto">· automática</span>' : ""}</span><select id="${p}sr" data-k="subregion">${opciones(SUBREGIONES, r.subregion)}</select></label>
        <label for="${p}mu"><span>Municipio <em>*</em> ${r.municipioAuto ? '<span class="auto">· automático</span>' : ""}</span><input id="${p}mu" data-k="municipio" value="${esc(r.municipio)}" list="lista-municipios" placeholder="Escribe el municipio" autocomplete="off" autocapitalize="words"></label>
      </div>
      <div class="grid grid--2">
        <label for="${p}ta"><span>Tipo de afectación <em>*</em></span><select id="${p}ta" data-k="tipoAfectacion">${opciones(TIPOS_AFECTACION, r.tipoAfectacion)}</select></label>
        <label for="${p}re"><span>Responsable de la visita <em>*</em></span><select id="${p}re" data-k="responsable">${opciones(RESPONSABLES, r.responsable)}</select></label>
      </div>
      <label for="${p}ob"><span>Observaciones</span><textarea id="${p}ob" data-k="observaciones">${esc(r.observaciones)}</textarea></label>`;
  }

  // Edición genérica: aplica a la carga manual y a cada tarjeta
  function alEditar(r, el, contenedor, rerender) {
    const k = el.dataset.k; if (!k) return;
    r[k] = el.value;
    el.classList.remove("is-invalid");
    if (k === "estadoPunto") el.dataset.v = el.value;
    if (k === "latitudDMS" || k === "longitudDMS") {
      r.latitud = dmsADecimal(r.latitudDMS);
      let lo = dmsADecimal(r.longitudDMS);
      if (lo != null && lo > 60) lo = -lo; // Antioquia: longitud Oeste
      r.longitud = lo;
      r.origenUbicacion = "manual";
      const c = $("[data-coord]", contenedor); if (c) c.innerHTML = lineaCoord(r);
    }
    if (k === "municipio") { r.municipioAuto = false; const m = MUN_POR_NOMBRE[norm(r.municipio)]; if (m) { r.subregion = m.s; const s = $('[data-k="subregion"]', contenedor); if (s) s.value = m.s; } }
  }
  function alCambiar(r, el, rerender) {
    const k = el.dataset.k; if (!k) return;
    if (k === "municipio") { completarSubregion(r); rerender(); }
    if ((k === "latitudDMS" || k === "longitudDMS") && tieneCoord(r)) {
      if (!r.latitudDMS.includes("°") && !/[NS]/i.test(r.latitudDMS)) r.latitudDMS = decimalADMS(r.latitud, true);
      if (!r.longitudDMS.includes("°") && !/[WOE]/i.test(r.longitudDMS)) r.longitudDMS = decimalADMS(r.longitud, false);
      completarDesdeCoordenadas(r); rerender();
    }
  }

  /* ======================= Validación ======================= */
  function faltantes(r) {
    const f = [];
    if (!r.fecha) f.push("fecha");
    if (!String(r.municipio).trim()) f.push("municipio");
    if (!r.tipoAfectacion) f.push("tipoAfectacion");
    if (!r.responsable) f.push("responsable");
    if (!String(r.codigoVia).trim() && !String(r.nombreTramo).trim()) f.push("codigoVia", "nombreTramo");
    return f;
  }
  const NOMBRES = { fecha: "fecha", municipio: "municipio", tipoAfectacion: "tipo de afectación", responsable: "responsable", estadoPunto: "estado", codigoVia: "código de la vía o nombre del tramo" };
  function marcar(contenedor, f) {
    f.forEach((k) => { const el = $(`[data-k="${k}"]`, contenedor); if (el) el.classList.add("is-invalid"); });
  }
  function textoFaltantes(f) { return [...new Set(f.filter((k) => k !== "nombreTramo").map((k) => NOMBRES[k]))].join(", "); }

  /* ======================= 1. Carga manual ======================= */
  let manual = nuevoRegistro({ fecha: hoy() });
  const formManual = $("#form-manual");
  function pintarManual() { formManual.innerHTML = campos(manual, "m-"); }
  formManual.addEventListener("input", (e) => alEditar(manual, e.target, formManual, pintarManual));
  formManual.addEventListener("change", (e) => alCambiar(manual, e.target, pintarManual));

  function msgManual(t, error) { const m = $("#m-msg"); m.textContent = t; m.style.color = error ? "var(--err)" : ""; }

  $("#m-ubicacion").addEventListener("click", () => {
    if (!navigator.geolocation) { msgManual("Este navegador no permite obtener la ubicación.", true); return; }
    msgManual("Obteniendo ubicación…");
    navigator.geolocation.getCurrentPosition((pos) => {
      manual.latitud = Math.round(pos.coords.latitude * 1e6) / 1e6;
      manual.longitud = Math.round(pos.coords.longitude * 1e6) / 1e6;
      manual.latitudDMS = decimalADMS(manual.latitud, true);
      manual.longitudDMS = decimalADMS(manual.longitud, false);
      manual.origenUbicacion = "dispositivo";
      completarDesdeCoordenadas(manual);
      pintarManual();
      msgManual(`Ubicación tomada (precisión aprox. ${Math.round(pos.coords.accuracy)} m).`);
    }, (err) => {
      msgManual(err.code === 1 ? "Permiso de ubicación denegado. Escribe las coordenadas a mano." : "No se pudo obtener la ubicación. Escribe las coordenadas a mano.", true);
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });

  $("#m-agregar").addEventListener("click", () => {
    const f = faltantes(manual);
    if (f.length) { marcar(formManual, f); msgManual("Falta: " + textoFaltantes(f) + ".", true); return; }
    items.unshift(Object.assign(manual, { estado: "listo", origen: "manual" }));
    manual = nuevoRegistro({ fecha: hoy(), responsable: items[0].responsable });
    pintarManual(); render();
    msgManual("Registro agregado a la lista.");
    $("#h-registros").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("#m-limpiar").addEventListener("click", () => { manual = nuevoRegistro({ fecha: hoy() }); pintarManual(); msgManual(""); });

  /* ======================= 2. Carga fotográfica ======================= */
  async function optimizar(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, mal) => { const i = new Image(); i.onload = () => ok(i); i.onerror = mal; i.src = url; });
      const f = Math.min(1, (CONFIG.MAX_DIMENSION_PX || 2048) / Math.max(img.width, img.height));
      const cv = document.createElement("canvas");
      cv.width = Math.round(img.width * f); cv.height = Math.round(img.height * f);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      const dataUrl = cv.toDataURL("image/jpeg", CONFIG.JPEG_QUALITY || 0.85);
      const t = Math.min(1, 520 / Math.max(img.width, img.height));
      const c2 = document.createElement("canvas");
      c2.width = Math.round(img.width * t); c2.height = Math.round(img.height * t);
      c2.getContext("2d").drawImage(img, 0, 0, c2.width, c2.height);
      return { dataUrl, base64: dataUrl.split(",")[1], miniatura: c2.toDataURL("image/jpeg", 0.75) };
    } finally { URL.revokeObjectURL(url); }
  }

  async function leerExif(file) {
    try {
      if (!window.exifr) return null;
      const d = await exifr.parse(file, { gps: true, pick: ["DateTimeOriginal", "latitude", "longitude"] });
      if (!d) return null;
      const f = d.DateTimeOriginal instanceof Date ? d.DateTimeOriginal : null;
      return {
        lat: typeof d.latitude === "number" ? Math.round(d.latitude * 1e6) / 1e6 : null,
        lon: typeof d.longitude === "number" ? Math.round(d.longitude * 1e6) / 1e6 : null,
        fecha: f ? `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, "0")}-${String(f.getDate()).padStart(2, "0")}` : ""
      };
    } catch (_) { return null; }
  }

  async function agregarFotos(files) {
    const maxMB = CONFIG.MAX_FILE_SIZE_MB || 20;
    for (const f of files) {
      if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { aviso(f.name + " no es JPG, PNG ni WEBP.", true); continue; }
      if (f.size > maxMB * 1048576) { aviso(f.name + " supera " + maxMB + " MB.", true); continue; }
      let opt;
      try { opt = await optimizar(f); } catch (_) { aviso("No se pudo abrir " + f.name + ".", true); continue; }
      const r = nuevoRegistro({ origen: "foto", estado: "leyendo", nombreArchivo: f.name, dataUrl: opt.dataUrl, base64: opt.base64, miniatura: opt.miniatura,
        responsable: manual.responsable || "" });
      r.exif = await leerExif(f);
      items.unshift(r);
      cola.push(r);
    }
    render();
    procesarCola();
  }

  const cola = [];
  let ocupado = false;
  async function procesarCola() {
    if (ocupado) return;
    ocupado = true;
    while (cola.length) await leer(cola.shift());
    ocupado = false;
  }

  let avisoPrimeraVez = true;
  async function leer(r) {
    r.estado = "leyendo"; actualizar(r);
    let d = null, error = "";
    if (HAY_BACKEND) {
      const s = await Api.post("leer", { base64: r.base64, mimeType: "image/jpeg" });
      if (s.status === "success") d = { fecha: s.fecha, fechaTexto: s.fechaTexto, latitud: s.latitud, longitud: s.longitud, latitudDMS: s.latitudDMS, longitudDMS: s.longitudDMS, tramo: s.tramo, codigoVia: s.codigoVia, municipioTexto: s.municipio, tipoAfectacion: s.tipoAfectacion };
    }
    if (!d || d.latitud == null || !d.fecha) {
      try {
        if (avisoPrimeraVez) { aviso("Preparando el lector de fotos. La primera vez tarda unos segundos."); avisoPrimeraVez = false; }
        const o = await LectorSello.leer(r.dataUrl);
        d = d ? Object.assign({}, o, Object.fromEntries(Object.entries(d).filter(([, v]) => v !== null && v !== ""))) : o;
        aviso("");
      } catch (e) { error = e.message || "No se pudo leer la foto."; }
    }
    d = d || {};
    if (d.fecha) { r.fecha = d.fecha; r.fechaTexto = d.fechaTexto || ""; }
    if (d.latitud != null && d.longitud != null) {
      r.latitud = d.latitud; r.longitud = d.longitud;
      r.latitudDMS = d.latitudDMS && /[°NS]/.test(d.latitudDMS) ? d.latitudDMS : decimalADMS(d.latitud, true);
      r.longitudDMS = d.longitudDMS && /[°WOE]/.test(d.longitudDMS) ? d.longitudDMS : decimalADMS(d.longitud, false);
      r.origenUbicacion = "sello";
    } else if (r.exif && r.exif.lat != null) {
      r.latitud = r.exif.lat; r.longitud = r.exif.lon;
      r.latitudDMS = decimalADMS(r.latitud, true); r.longitudDMS = decimalADMS(r.longitud, false);
      r.origenUbicacion = "gps";
    }
    if (!r.fecha && r.exif && r.exif.fecha) r.fecha = r.exif.fecha;
    if (d.tramo && !r.nombreTramo) r.nombreTramo = d.tramo;
    if (d.codigoVia && !r.codigoVia) r.codigoVia = d.codigoVia;
    if (d.tipoAfectacion && !r.tipoAfectacion && TIPOS_AFECTACION.includes(d.tipoAfectacion)) r.tipoAfectacion = d.tipoAfectacion;
    completarDesdeCoordenadas(r);
    // Sin coordenadas: municipio por el nombre escrito en el sello (ej. "Grada el peñol" → El Peñol)
    if ((!r.municipio || r.municipioAuto) && !tieneCoord(r) && d.municipioTexto) {
      const m = MUN_POR_NOMBRE[norm(d.municipioTexto)];
      if (m) { r.municipio = m.n; r.subregion = m.s; r.municipioAuto = true; }
    }

    const dudosa = !!d.coordDudosa && r.origenUbicacion === "sello";
    // El sello nombra un municipio distinto al de las coordenadas: se avisa (los límites usados son aproximados)
    const otroMun = d.municipioTexto && r.municipio && norm(d.municipioTexto) !== norm(r.municipio) && r.municipioAuto ? d.municipioTexto : "";
    const leido = r.fecha && tieneCoord(r) && !dudosa;
    r.selloLegible = !!(d.fecha && d.latitud != null);
    r.estado = leido ? "listo" : "revisar";
    r.mensaje = error ? error + " Completa los datos a mano."
      : dudosa ? "Verifica las coordenadas: el sello se leyó con dudas. Compáralas con la foto (toca «Ampliar»)."
      : leido ? (otroMun ? `El sello menciona «${otroMun}» y las coordenadas caen en ${r.municipio}. Revisa el municipio.` : "") : (!tieneCoord(r) && r.fecha && r.municipio
        ? "La foto no trae coordenadas. El municipio se tomó del texto del sello; agrega las coordenadas si las tienes."
        : "No se leyó todo el sello. Completa " + [!r.fecha && "la fecha", !tieneCoord(r) && "las coordenadas"].filter(Boolean).join(" y ") + ".");
    actualizar(r);
  }

  function aviso(texto, error) {
    const a = $("#aviso");
    a.textContent = texto || "";
    a.className = "aviso" + (error ? " is-error" : "");
    a.hidden = !texto;
  }


  /* ======================= 3. Carga desde PDF (acta de visita técnica) ======================= */
  function aBase64(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  // Municipio escrito en el acta (ej. «MUNICIPIO Medellín/San Jerónimo VÍA …»)
  function municipiosDelTexto(plano) {
    const m = String(plano || "").match(/MUNICIPIO\s+(.{3,70}?)\s+(?:V[IÍ]A\b|C[OÓ]DIGO)/i);
    if (!m) return [];
    return m[1].split(/\s*(?:\/|,|;|\sy\s|\s-\s)\s*/).map((x) => MUN_POR_NOMBRE[norm(x)]).filter(Boolean);
  }

  // Sección 3: igual a la carga manual, pero los campos se llenan desde el PDF.
  // Un acta puede traer varios tramos (uno por coordenada): se elige cada uno con los botones de tramo.
  const formPdf = $("#form-pdf");
  let pdfActual = null;           // { nombre, base64, fileId, doc, d }
  let tramosPdf = [];             // un registro por tramo
  let selPdf = 0;
  let vacioPdf = nuevoRegistro({ origen: "pdf" });
  const regPdf = () => tramosPdf[selPdf] || vacioPdf;

  function msgPdf(t, error) { const m = $("#p-msg"); m.textContent = t || ""; m.style.color = error ? "var(--err)" : ""; }
  function pintarPdf() {
    const r = regPdf();
    formPdf.innerHTML = (r.mensaje ? `<div class="alerta">${esc(r.mensaje)}</div>` : "") + campos(r, "p-");
    const t = $("#p-tramos");
    t.hidden = tramosPdf.length < 2;
    t.innerHTML = tramosPdf.map((x, i) => `<button type="button" class="tramo${i === selPdf ? " is-sel" : ""}${x.agregado ? " is-ok" : ""}" data-i="${i}"${x.agregado ? " disabled" : ""}>${x.agregado ? "✓ " : ""}${esc(x.punto)}</button>`).join("");
    const quedan = tramosPdf.filter((x) => !x.agregado).length;
    $("#p-todos").hidden = quedan < 2;
    $("#p-todos").textContent = `Agregar los ${quedan} tramos`;
    $("#p-ver").hidden = !r.dataUrl;
  }
  formPdf.addEventListener("input", (e) => alEditar(regPdf(), e.target, formPdf, pintarPdf));
  formPdf.addEventListener("change", (e) => alCambiar(regPdf(), e.target, pintarPdf));
  $("#p-tramos").addEventListener("click", (e) => { const b = e.target.closest("[data-i]"); if (!b) return; selPdf = Number(b.dataset.i); pintarPdf(); });
  $("#p-ver").addEventListener("click", () => { const r = regPdf(); abrirVisor(r.dataUrl, r.nombreArchivo + " · " + r.punto + " (página " + r.pagina + ")"); });

  function limpiarPdf() { pdfActual = null; tramosPdf = []; selPdf = 0; vacioPdf = nuevoRegistro({ origen: "pdf" }); $("#p-archivo").textContent = "Ningún archivo seleccionado"; pintarPdf(); msgPdf(""); }
  $("#p-limpiar").addEventListener("click", limpiarPdf);

  function pasarALista(lista) {
    lista.forEach((r) => { r.agregado = true; items.unshift(Object.assign({}, r, { estado: "listo", mensaje: "" })); });
    render();
    const sig = tramosPdf.findIndex((x) => !x.agregado);
    if (sig < 0) { limpiarPdf(); msgPdf(lista.length > 1 ? `${lista.length} tramos agregados a la lista.` : "Registro agregado a la lista."); }
    else { selPdf = sig; pintarPdf(); msgPdf(`${lista.map((x) => x.punto).join(", ")} agregado. Sigue con ${tramosPdf[sig].punto}.`); }
  }
  $("#p-agregar").addEventListener("click", () => {
    if (!pdfActual) { msgPdf("Primero elige un PDF.", true); return; }
    const r = regPdf(), f = faltantes(r);
    if (f.length) { marcar(formPdf, f); msgPdf("Falta: " + textoFaltantes(f) + ".", true); return; }
    pasarALista([r]);
  });
  $("#p-todos").addEventListener("click", () => {
    const quedan = tramosPdf.filter((x) => !x.agregado);
    const malo = quedan.find((x) => faltantes(x).length);
    if (malo) { selPdf = tramosPdf.indexOf(malo); pintarPdf(); const f = faltantes(malo); marcar(formPdf, f); msgPdf(`${malo.punto}: falta ${textoFaltantes(f)}.`, true); return; }
    pasarALista(quedan);
  });

  async function cargarPDF(f) {
    if (!f) return;
    if (f.type !== "application/pdf" && !/\.pdf$/i.test(f.name)) { msgPdf(f.name + " no es un PDF.", true); return; }
    if (f.size > 20 * 1048576) { msgPdf(f.name + " supera 20 MB.", true); return; }
    $("#p-archivo").textContent = f.name;
    msgPdf("Leyendo el PDF…");
    let bytes, lectura, d;
    try {
      bytes = new Uint8Array(await f.arrayBuffer());
      lectura = await LectorPDF.abrir(bytes.slice());
      d = LectorPDF.interpretar(lectura.paginas);
    } catch (e) { msgPdf("No se pudo leer " + f.name + ": " + (e.message || "PDF dañado o protegido") + ".", true); return; }
    const sinTexto = !lectura.paginas.join("").trim();
    pdfActual = { nombre: f.name, base64: aBase64(bytes), fileId: null, doc: lectura.doc, d };
    const pdf = pdfActual;
    await armarTramos(pdf, d);
    msgPdf(sinTexto ? "El PDF no tiene texto (parece escaneado)." : `${d.puntos.length ? d.puntos.length + " tramo(s) encontrados" : "No se encontraron coordenadas"}. Revisa los datos y toca «Agregar a la lista».`, sinTexto);

    // Con el servidor: Gemini redacta el resumen de todo el acta y completa lo que falte
    if (!HAY_BACKEND) return;
    $("#p-ia").hidden = false;
    const g = await Api.post("leerPdf", { base64: pdf.base64 });
    $("#p-ia").hidden = true;
    if (pdfActual !== pdf || g.status !== "success") return;
    const habiaPuntos = d.puntos.length;
    d.fecha = d.fecha || g.fecha || ""; d.codigoVia = d.codigoVia || g.codigoVia || ""; d.via = d.via || g.via || ""; d.municipioTexto = g.municipio || "";
    if (!habiaPuntos && Array.isArray(g.puntos)) {
      d.puntos = g.puntos.filter((p) => p.latitud != null && p.longitud != null)
        .map((p, k) => ({ lat: p.latitud, lon: p.longitud, nombre: p.nombre || "Punto " + (k + 1), tipo: p.tipoAfectacion || "", descripcion: p.descripcion || "", pagina: p.pagina || 1 }));
    }
    const resumenAnterior = d.resumen;
    if (g.resumen) d.resumen = g.resumen;
    if (!habiaPuntos && d.puntos.length) { await armarTramos(pdf, d); }
    else tramosPdf.forEach((r) => {
      if (!r.agregado && (!r.observaciones || r.observaciones === resumenAnterior)) r.observaciones = d.resumen;
      if (!r.fecha) r.fecha = d.fecha; if (!r.codigoVia) r.codigoVia = d.codigoVia; if (!r.nombreTramo) r.nombreTramo = d.via;
    });
    pintarPdf();
    if (g.resumen) msgPdf("Resumen del acta redactado con Gemini. Revisa los datos y toca «Agregar a la lista».");
  }

  async function armarTramos(pdf, d) {
    const enTexto = municipiosDelTexto(d.texto);
    const responsable = d.esGobernacion ? "Gobernación" : (manual.responsable || "");
    const puntos = d.puntos.length ? d.puntos : [{ lat: null, lon: null, nombre: "Acta", tipo: d.tipoGeneral, descripcion: "", pagina: 1 }];
    const imagenes = {};
    tramosPdf = [];
    for (const p of puntos) {
      const pag = Math.min(Math.max(1, p.pagina || 1), pdf.doc.numPages);
      if (!imagenes[pag]) {
        try {
          const grande = await LectorPDF.dibujarPagina(pdf.doc, pag, 1100);
          imagenes[pag] = { grande, mini: await LectorPDF.dibujarPagina(pdf.doc, pag, 360) };
        } catch (_) { imagenes[pag] = { grande: "", mini: "" }; }
      }
      const r = nuevoRegistro({
        origen: "pdf", estado: "listo", nombreArchivo: pdf.nombre, punto: p.nombre, pagina: pag, pdf,
        dataUrl: imagenes[pag].grande, miniatura: imagenes[pag].mini,
        fecha: d.fecha || "", fechaTexto: d.fechaTexto || "", codigoVia: d.codigoVia || "", nombreTramo: d.via || "",
        tipoAfectacion: TIPOS_AFECTACION.includes(p.tipo) ? p.tipo : "", responsable,
        observaciones: d.resumen || p.descripcion || ""
      });
      if (p.lat != null && p.lon != null) {
        r.latitud = p.lat; r.longitud = p.lon;
        r.latitudDMS = decimalADMS(p.lat, true); r.longitudDMS = decimalADMS(p.lon, false);
        r.origenUbicacion = "pdf";
        completarDesdeCoordenadas(r);
      }
      if (!r.municipio) {
        const m = enTexto[0] || MUN_POR_NOMBRE[norm(d.municipioTexto)];
        if (m) { r.municipio = m.n; r.subregion = m.s; r.municipioAuto = true; }
      }
      const falta = [!r.fecha && "la fecha", !tieneCoord(r) && "las coordenadas", !r.tipoAfectacion && "el tipo de afectación"].filter(Boolean);
      const otroMun = tieneCoord(r) && enTexto.length && !enTexto.some((m) => m.n === r.municipio)
        ? `El acta menciona ${enTexto.map((m) => m.n).join(" / ")} y las coordenadas caen en ${r.municipio || "otro municipio"}. Revisa el municipio.` : "";
      r.mensaje = falta.length ? "No se encontró en el PDF " + falta.join(", ") + ". Complétalo a mano." : otroMun;
      tramosPdf.push(r);
    }
    selPdf = 0;
    pintarPdf();
  }
  pintarPdf();

  /* ======================= Tarjetas ======================= */
  const ETIQUETAS = { leyendo: "Leyendo…", listo: "Listo", revisar: "Revisar", guardando: "Guardando…", guardado: "Guardado", error: "Error al guardar", manual: "Carga manual" };

  function tarjeta(r) {
    const esFoto = r.origen === "foto", esPdf = r.origen === "pdf", conImagen = !!r.miniatura;
    const bloqueado = r.estado === "guardado" || r.estado === "guardando" || r.estado === "leyendo";
    const cls = ["card", conImagen ? "" : "is-manual", r.estado === "guardado" ? "is-guardado" : "", r.estadoPunto === "Crítico" ? "is-critico" : ""].join(" ");
    const etiqueta = r.estado === "listo" && !esFoto && !esPdf ? "Carga manual" : (r.estado === "listo" && esPdf ? "Listo · PDF" : ETIQUETAS[r.estado]);
    const nombre = esFoto ? r.nombreArchivo : esPdf ? r.nombreArchivo + (r.punto ? " · " + r.punto : "") : "Registro sin foto";
    return `<article class="${cls}" data-id="${r.id}">
      ${conImagen ? `<button type="button" class="card__foto" data-act="ver" aria-label="${esPdf ? "Ver página del PDF" : "Ver foto completa"}"><img src="${r.miniatura}" alt="${esPdf ? "Página" : "Foto"} ${esc(r.nombreArchivo)}"><span>Ampliar</span></button>` : ""}
      <div class="card__cuerpo">
        <div class="card__top"><span class="card__nombre">${esc(nombre)}${r.idRegistro ? " · " + esc(r.idRegistro) : ""}</span><span class="chip chip--${r.estado === "listo" && !esFoto && !esPdf ? "manual" : r.estado}">${etiqueta}</span></div>
        ${r.mensaje ? `<div class="alerta">${esc(r.mensaje)}</div>` : ""}
        <fieldset style="border:0;padding:0;margin:0;display:grid;gap:12px;min-width:0"${bloqueado ? " disabled" : ""}>${campos(r, "c" + r.id + "-")}</fieldset>
        <div class="actions">
          ${esFoto && r.estado !== "guardado" && r.estado !== "leyendo" ? '<button type="button" class="btn btn--sm" data-act="releer">Volver a leer la foto</button>' : ""}
          ${r.estado !== "guardando" ? '<button type="button" class="btn btn--sm" data-act="quitar">Quitar de la lista</button>' : ""}
        </div>
      </div>
    </article>`;
  }

  function render() {
    $("#tarjetas").innerHTML = items.length ? items.map(tarjeta).join("")
      : '<p class="vacio">Aún no hay registros. Agrega uno con la carga manual, sube fotos o un acta en PDF.</p>';
    contadores();
  }
  function actualizar(r) {
    const el = document.querySelector(`.card[data-id="${r.id}"]`);
    if (el) el.outerHTML = tarjeta(r);
    contadores();
  }
  const pendientes = () => items.filter((r) => ["listo", "revisar", "error", "manual"].includes(r.estado));
  function contadores() {
    const p = pendientes().length, leyendo = items.filter((r) => r.estado === "leyendo").length;
    const guardados = items.filter((r) => r.estado === "guardado").length;
    $("#n-listas").textContent = p;
    $("#n-texto").textContent = p === 1 ? "pendiente" : "pendientes";
    $("#n-leyendo").textContent = leyendo ? "· " + leyendo + " leyendo" : "";
    $("#resumen").textContent = items.length ? `${items.length} en la lista${HAY_BACKEND ? " · " + guardados + " guardados" : ""}` : "";
    $("#guardar").disabled = !p || guardando;
  }

  const buscar = (el) => items.find((x) => x.id == el.closest(".card")?.dataset.id);
  $("#tarjetas").addEventListener("input", (e) => {
    const r = buscar(e.target); if (!r) return;
    const card = e.target.closest(".card");
    alEditar(r, e.target, card, () => actualizar(r));
    if (e.target.dataset.k === "estadoPunto") card.classList.toggle("is-critico", r.estadoPunto === "Crítico");
  });
  $("#tarjetas").addEventListener("change", (e) => { const r = buscar(e.target); if (r) alCambiar(r, e.target, () => actualizar(r)); });
  $("#tarjetas").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]"); if (!b) return;
    const r = buscar(b); if (!r) return;
    if (b.dataset.act === "quitar") { items = items.filter((x) => x !== r); render(); if (!HAY_BACKEND) { try { escribirLocal(); } catch (_) {} } }
    if (b.dataset.act === "releer") { cola.push(r); r.estado = "leyendo"; actualizar(r); procesarCola(); }
    if (b.dataset.act === "ver") abrirVisor(r.dataUrl || r.miniatura, r.nombreArchivo + (r.punto ? " · " + r.punto + (r.pagina ? " (página " + r.pagina + ")" : "") : ""));
  });

  /* ======================= Visor ======================= */
  const visor = $("#visor");
  function abrirVisor(src, nombre) {
    $("#visor-img").src = src; $("#visor-img").alt = nombre || "Foto";
    $("#visor-nombre").textContent = nombre || "";
    if (visor.showModal) visor.showModal();
  }
  $("#visor-cerrar").addEventListener("click", () => visor.close());
  visor.addEventListener("click", (e) => { if (e.target === visor) visor.close(); });

  /* ======================= Guardar / Descargar ======================= */
  const Api = {
    async post(accion, datos) {
      try {
        const r = await fetch(CONFIG.API_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" }, // evita preflight CORS en Apps Script
          body: JSON.stringify(Object.assign({ accion, token: CONFIG.TOKEN, sesion: Sesion.token() }, datos)),
          redirect: "follow"
        });
        const t = await r.text();
        let res;
        try { res = JSON.parse(t); } catch (_) { res = null; }
        if (res) { if (res.status === "sin_sesion" && accion !== "login") Sesion.vencida(res.message); return res; }
        try { return JSON.parse(t); }
        catch (_) { return { status: "error", message: /accounts\.google\.com|Sign in/i.test(t) ? "El servidor pide inicio de sesión. Revisa que la implementación tenga acceso para «Cualquier usuario»." : "Respuesta inesperada del servidor." }; }
      } catch (e) { return { status: "error", message: "Sin conexión con el servidor. Revisa internet e intenta de nuevo." }; }
    }
  };

  function validarTodos(lista) {
    let malos = 0;
    lista.forEach((r) => {
      const f = faltantes(r);
      if (f.length) { malos++; const c = document.querySelector(`.card[data-id="${r.id}"]`); if (c) marcar(c, f); }
    });
    return malos;
  }

  let guardando = false;
  $("#guardar").addEventListener("click", async () => {
    const lista = pendientes();
    const malos = validarTodos(lista);
    if (malos) { aviso(`${malos} registro(s) con datos obligatorios vacíos (marcados en rojo). Complétalos para guardar.`, true); return; }
    if (!HAY_BACKEND) { guardarEnDispositivo(lista); return; }
    guardando = true; contadores();
    let ok = 0, mal = 0;
    for (const r of lista) {
      r.estado = "guardando"; actualizar(r);
      const pdf = r.pdf; // los puntos de un mismo PDF comparten un solo archivo en Drive
      const res = await Api.post("subir", {
        base64: pdf ? (pdf.fileId ? "" : pdf.base64) : (r.base64 || ""), archivoId: pdf && pdf.fileId ? pdf.fileId : "",
        mimeType: pdf ? "application/pdf" : "image/jpeg", nombreArchivo: r.nombreArchivo || "", origen: r.origen,
        fecha: r.fecha, fechaTexto: r.fechaTexto, latitudDMS: r.latitudDMS, longitudDMS: r.longitudDMS,
        latitud: r.latitud, longitud: r.longitud, codigoVia: r.codigoVia, nombreTramo: r.nombreTramo,
        subregion: r.subregion, municipio: r.municipio, tipoAfectacion: r.tipoAfectacion, responsable: r.responsable,
        estadoPunto: r.estadoPunto, observaciones: r.observaciones, origenUbicacion: r.origenUbicacion, selloLegible: r.selloLegible
      });
      if (res.status === "success") { r.estado = "guardado"; r.idRegistro = res.id; r.mensaje = ""; ok++; if (pdf && res.fileId) pdf.fileId = res.fileId; }
      else { r.estado = "error"; r.mensaje = res.message || "No se pudo guardar."; mal++; }
      actualizar(r);
    }
    guardando = false; contadores();
    aviso(mal ? `${ok} guardados, ${mal} con error. Revisa los marcados y vuelve a intentar.` : `${ok} registro(s) guardados.`, mal > 0);
  });

  /* Sin servidor: los registros se guardan en este navegador y se recuperan al volver a abrir la página */
  const CLAVE_LOCAL = "vipc-registros-v1";
  const CAMPOS_LOCALES = ["id", "origen", "estado", "idRegistro", "nombreArchivo", "miniatura", "fecha", "fechaTexto", "latitudDMS", "longitudDMS",
    "latitud", "longitud", "origenUbicacion", "codigoVia", "nombreTramo", "subregion", "municipio", "municipioAuto",
    "tipoAfectacion", "responsable", "estadoPunto", "observaciones", "selloLegible", "punto", "pagina"];
  function escribirLocal() {
    const datos = items.filter((r) => r.estado === "guardado").map((r) => Object.fromEntries(CAMPOS_LOCALES.map((k) => [k, r[k]])));
    localStorage.setItem(CLAVE_LOCAL, JSON.stringify(datos));
  }
  function guardarEnDispositivo(lista) {
    const previos = lista.map((r) => [r, r.estado, r.idRegistro]);
    let n = items.filter((r) => r.estado === "guardado").length;
    lista.forEach((r) => { r.estado = "guardado"; r.idRegistro = r.idRegistro || "L-" + String(++n).padStart(4, "0"); r.mensaje = ""; });
    try {
      escribirLocal();
      lista.forEach(actualizar); contadores();
      aviso(`${lista.length} registro(s) guardados en este dispositivo. Siguen aquí aunque cierres la página.`);
    } catch (e) {
      previos.forEach(([r, est, id]) => { r.estado = est; r.idRegistro = id; });
      aviso("No hay espacio en este navegador para guardar más registros. Vacía la lista o conecta el servidor.", true);
    }
  }
  function leerLocal() {
    try {
      const datos = JSON.parse(localStorage.getItem(CLAVE_LOCAL) || "[]");
      if (!Array.isArray(datos)) return;
      datos.forEach((d) => { items.push(Object.assign(nuevoRegistro(), d, { id: sec++, estado: "guardado", mensaje: "" })); });
    } catch (_) { /* almacenamiento no disponible */ }
  }

  const COLS = [["Fecha", "fecha"], ["Latitud", "latitud"], ["Longitud", "longitud"], ["LatitudDMS", "latitudDMS"], ["LongitudDMS", "longitudDMS"],
    ["CodigoVia", "codigoVia"], ["NombreTramo", "nombreTramo"], ["Subregion", "subregion"], ["Municipio", "municipio"],
    ["TipoAfectacion", "tipoAfectacion"], ["Responsable", "responsable"], ["Estado", "estadoPunto"], ["Observaciones", "observaciones"],
    ["Origen", "origen"], ["Foto", "nombreArchivo"], ["FechaSello", "fechaTexto"], ["OrigenUbicacion", "origenUbicacion"]];
  const vaciar = $("#vaciar");
  vaciar.addEventListener("click", () => {
    if (vaciar.dataset.confirmar) {
      items = []; cola.length = 0; render(); aviso("");
      try { localStorage.removeItem(CLAVE_LOCAL); } catch (_) {}
      vaciar.textContent = "Vaciar"; delete vaciar.dataset.confirmar; return;
    }
    vaciar.dataset.confirmar = "1"; vaciar.textContent = "Confirmar vaciar";
    setTimeout(() => { if (vaciar.dataset.confirmar) { delete vaciar.dataset.confirmar; vaciar.textContent = "Vaciar"; } }, 4000);
  });

  window.addEventListener("beforeunload", (e) => {
    if (pendientes().length && HAY_BACKEND) { e.preventDefault(); e.returnValue = ""; }
  });

  /* ======================= Carga de archivos ======================= */
  const drop = $("#fotos");
  $("#archivos").addEventListener("change", (e) => { agregarFotos([...e.target.files]); e.target.value = ""; });
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("is-over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("is-over"); }));
  drop.addEventListener("drop", (e) => { if (e.dataTransfer?.files?.length) agregarFotos([...e.dataTransfer.files]); });
  const panelPdf = $("#pdfs");
  $("#archivos-pdf").addEventListener("change", (e) => { cargarPDF(e.target.files[0]); e.target.value = ""; });
  ["dragenter", "dragover"].forEach((t) => panelPdf.addEventListener(t, (e) => { if ([...(e.dataTransfer?.types || [])].includes("Files")) { e.preventDefault(); panelPdf.classList.add("is-over"); } }));
  ["dragleave", "drop"].forEach((t) => panelPdf.addEventListener(t, (e) => { panelPdf.classList.remove("is-over"); if (t === "drop" && e.dataTransfer?.files?.length) { e.preventDefault(); cargarPDF(e.dataTransfer.files[0]); } }));

  /* ======================= Acceso (usuario y contraseña) ======================= */
  const Sesion = (function () {
    const CLAVE = "vipc-sesion";
    let actual = null;
    try { actual = JSON.parse(localStorage.getItem(CLAVE) || "null"); } catch (_) { actual = null; }
    if (actual && !(actual.expira > Date.now())) actual = null;
    return {
      token: () => (actual ? actual.sesion : ""),
      datos: () => actual,
      guardar(d) { actual = d; try { localStorage.setItem(CLAVE, JSON.stringify(d)); } catch (_) {} },
      borrar() { actual = null; try { localStorage.removeItem(CLAVE); } catch (_) {} },
      vencida(msg) { this.borrar(); mostrarAcceso(msg || "Tu sesión venció. Inicia sesión de nuevo."); }
    };
  })();

  const VISTAS_ACCESO = { ingreso: "#form-acceso", registro: "#form-registro", verificar: "#form-verificar", pendiente: "#caja-pendiente" };
  function verAcceso(cual) {
    Object.entries(VISTAS_ACCESO).forEach(([k, sel]) => { $(sel).hidden = k !== cual; });
    const primero = $(VISTAS_ACCESO[cual] + " input"); if (primero) setTimeout(() => { try { primero.focus(); } catch (_) {} }, 50);
  }
  function mostrarAcceso(msg) {
    $("#app").hidden = true; $("#barra").hidden = true; $("#usuario").hidden = true;
    $("#acceso").hidden = false;
    verAcceso("ingreso");
    $("#acc-msg").textContent = msg || "";
    $("#acc-entrar").disabled = !HAY_BACKEND;
    setTimeout(() => { try { $("#acc-usuario").focus(); } catch (_) {} }, 50);
  }
  let appIniciada = false;
  function mostrarApp() {
    const d = Sesion.datos();
    $("#acceso").hidden = true; $("#app").hidden = false; $("#barra").hidden = false;
    $("#usuario").hidden = false; $("#usuario-nombre").textContent = d ? d.nombre : "";
    if (!appIniciada) {
      appIniciada = true;
      pintarManual();
      render();
      // Precarga el lector en segundo plano para que la primera foto sea más rápida
      setTimeout(() => { try { LectorSello.iniciar().catch(() => {}); } catch (_) {} }, 1500);
    }
  }

  $("#form-acceso").addEventListener("submit", async (e) => {
    e.preventDefault();
    const usuario = $("#acc-usuario").value.trim(), clave = $("#acc-clave").value;
    $("#acc-msg").classList.remove("is-ok");
    if (!usuario || !clave) { $("#acc-msg").textContent = "Escribe tu usuario y tu contraseña."; return; }
    const b = $("#acc-entrar"); b.disabled = true; b.textContent = "Verificando…"; $("#acc-msg").textContent = "";
    const r = await Api.post("login", { usuario, clave });
    b.disabled = false; b.textContent = "Ingresar";
    if (r.status === "verificar") { pedirCodigo(r.usuario, r.correo, r.message); return; }
    if (r.status === "codigo") { $("#acc-clave").value = ""; pedirCodigo(r.usuario, r.correo, "", "ingreso"); return; }
    if (r.status !== "success") { $("#acc-msg").textContent = r.message || "No se pudo iniciar sesión."; $("#acc-clave").select(); return; }
    Sesion.guardar({ sesion: r.sesion, usuario: r.usuario, nombre: r.nombre, rol: r.rol, expira: r.expira });
    $("#acc-clave").value = "";
    mostrarApp();
  });

  /* ---------- Crear cuenta y verificar correo ---------- */
  let usuarioPorVerificar = "", modoCodigo = "registro"; // "registro": confirmar correo · "ingreso": código de cada ingreso
  function pedirCodigo(usuario, correo, msg, modo) {
    usuarioPorVerificar = usuario; modoCodigo = modo || "registro";
    $("#ver-titulo").textContent = modoCodigo === "ingreso" ? "Código de ingreso" : "Confirma tu correo";
    $("#ver-enviar").textContent = modoCodigo === "ingreso" ? "Ingresar" : "Confirmar";
    $("#ver-texto").textContent = `Te enviamos un código de 6 dígitos a ${correo || "tu correo"}. Revisa también la carpeta de spam.`;
    $("#ver-msg").textContent = msg && !/enviamos/i.test(msg) ? msg : ""; $("#ver-msg").className = "acceso__msg";
    $("#ver-codigo").value = "";
    verAcceso("verificar");
  }
  $("#ir-registro").addEventListener("click", () => { $("#reg-msg").textContent = ""; verAcceso("registro"); });
  document.querySelectorAll("[data-ir]").forEach((b) => b.addEventListener("click", () => { $("#acc-msg").textContent = ""; verAcceso(b.dataset.ir); }));
  $("#reg-entidad").addEventListener("change", () => { $("#bloque-empresa").hidden = $("#reg-entidad").value !== "Empresa externa"; });
  $("#reg-supervisor").addEventListener("input", (e) => e.target.classList.remove("is-invalid"));
  // Sugerir usuario a partir del correo
  $("#reg-correo").addEventListener("change", () => {
    const u = $("#reg-usuario");
    if (!u.value) u.value = $("#reg-correo").value.split("@")[0].toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 30);
  });

  $("#form-registro").addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = { nombre: $("#reg-nombre").value.trim(), correo: $("#reg-correo").value.trim(), entidad: $("#reg-entidad").value, empresa: $("#reg-empresa").value.trim(), supervisor: $("#reg-supervisor").value.trim().toLowerCase(),
      usuario: $("#reg-usuario").value.trim().toLowerCase(), clave: $("#reg-clave").value };
    const msg = $("#reg-msg");
    if (!d.nombre || !d.correo || !d.entidad || !d.usuario || !d.clave || (d.entidad === "Empresa externa" && !d.empresa)) { msg.textContent = "Completa todos los campos."; return; }
    if (d.clave !== $("#reg-clave2").value) { msg.textContent = "Las contraseñas no coinciden."; return; }
    if (d.clave.length < 8 || !/[a-zA-Z]/.test(d.clave) || !/\d/.test(d.clave)) { msg.textContent = "La contraseña debe tener al menos 8 caracteres, con letras y números."; return; }
    const b = $("#reg-enviar"); b.disabled = true; b.textContent = "Enviando…"; msg.textContent = "";
    const r = await Api.post("registro", d);
    b.disabled = false; b.textContent = "Crear cuenta";
    if (r.status === "verificar") { $("#acc-usuario").value = r.usuario; pedirCodigo(r.usuario, r.correo); }
    else if (r.status === "pendiente") { $("#acc-usuario").value = d.usuario; $("#pendiente-texto").textContent = r.message; verAcceso("pendiente"); }
    else {
      msg.textContent = r.message || "No se pudo crear la cuenta.";
      if (r.necesitaSupervisor) { $("#reg-entidad").value = "Empresa externa"; $("#bloque-empresa").hidden = false; $("#reg-supervisor").classList.add("is-invalid"); $("#reg-supervisor").focus(); }
    }
    if (r.status === "verificar" || r.status === "pendiente") ["#reg-clave", "#reg-clave2"].forEach((id) => { $(id).value = ""; });
  });

  $("#form-verificar").addEventListener("submit", async (e) => {
    e.preventDefault();
    const codigo = $("#ver-codigo").value.replace(/\D/g, "");
    const msg = $("#ver-msg"); msg.className = "acceso__msg";
    if (codigo.length !== 6) { msg.textContent = "Escribe los 6 dígitos del código."; return; }
    const b = $("#ver-enviar"); const etiqueta = b.textContent; b.disabled = true; b.textContent = "Verificando…";
    if (modoCodigo === "ingreso") {
      const r = await Api.post("ingresoCodigo", { usuario: usuarioPorVerificar, codigo });
      b.disabled = false; b.textContent = etiqueta;
      if (r.status === "success") {
        Sesion.guardar({ sesion: r.sesion, usuario: r.usuario, nombre: r.nombre, rol: r.rol, expira: r.expira });
        mostrarApp(); return;
      }
      if (r.vencido) { mostrarAcceso(r.message); $("#acc-usuario").value = usuarioPorVerificar; return; }
      msg.textContent = r.message || "No se pudo verificar."; return;
    }
    const r = await Api.post("verificar", { usuario: usuarioPorVerificar, codigo });
    b.disabled = false; b.textContent = etiqueta;
    if (r.status === "pendiente_supervisor" || r.status === "pendiente") {
      $("#pendiente-texto").textContent = r.message; verAcceso("pendiente"); return;
    }
    if (r.status !== "success") { msg.textContent = r.message || "No se pudo verificar."; return; }
    verAcceso("ingreso");
    $("#acc-usuario").value = usuarioPorVerificar;
    $("#acc-msg").textContent = "Correo confirmado. Ingresa con tu contraseña."; $("#acc-msg").classList.add("is-ok");
    setTimeout(() => { try { $("#acc-clave").focus(); } catch (_) {} }, 60);
  });
  $("#ver-reenviar").addEventListener("click", async () => {
    const msg = $("#ver-msg");
    const r = await Api.post(modoCodigo === "ingreso" ? "reenviarIngreso" : "reenviar", { usuario: usuarioPorVerificar });
    msg.className = "acceso__msg" + (r.status === "success" ? " is-ok" : "");
    msg.textContent = r.message || "";
  });

  const salir = $("#salir");
  salir.addEventListener("click", () => {
    if (pendientes().length && !salir.dataset.confirmar) {
      salir.dataset.confirmar = "1"; salir.textContent = "Hay registros sin guardar. ¿Salir?";
      setTimeout(() => { delete salir.dataset.confirmar; salir.textContent = "Cerrar sesión"; }, 4000);
      return;
    }
    Sesion.borrar();
    location.reload();
  });

  /* ======================= Inicio ======================= */
  (async function iniciar() {
    if (!HAY_BACKEND) { mostrarAcceso("El acceso todavía no está configurado: falta conectar el servidor (ver README)."); return; }
    if (!Sesion.token()) { mostrarAcceso(""); return; }
    // Confirma con el servidor que la sesión guardada sigue activa
    $("#acc-msg").textContent = "Verificando sesión…";
    const r = await Api.post("sesion", {});
    if (r.status === "success") mostrarApp();
    else if (r.status !== "sin_sesion") mostrarAcceso(r.message || "No se pudo verificar la sesión.");
  })();
})();
