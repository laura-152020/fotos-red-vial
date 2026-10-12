/* VIP-C — Visor interactivo de puntos críticos · Gobernación de Antioquia
 * 1) Carga manual de datos  ·  2) Carga fotográfica con relleno automático (lectura del sello)
 * Guardado: Apps Script (Drive + Sheets) si hay API_URL configurada; siempre se puede descargar CSV.
 */
(function () {
  "use strict";

  /* ======================= Catálogos ======================= */
  const TIPOS_AFECTACION = [
    "Derrumbe", "Deslizamiento / movimiento en masa", "Pérdida de banca", "Hundimiento de la vía",
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
    const origen = { sello: "leídas del sello", gps: "GPS de la foto", dispositivo: "ubicación del dispositivo", manual: "escritas a mano", servidor: "leídas del sello" }[r.origenUbicacion] || "";
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
      <div class="grid">
        <label for="${p}cv"><span>Código oficial de la vía</span><input id="${p}cv" class="mono" data-k="codigoVia" value="${esc(r.codigoVia)}" placeholder="Ej. 60AN17" autocomplete="off"></label>
        <label for="${p}sr"><span>Subregión ${r.municipioAuto ? '<span class="auto">· automática</span>' : ""}</span><select id="${p}sr" data-k="subregion">${opciones(SUBREGIONES, r.subregion)}</select></label>
        <label for="${p}nt"><span>Nombre del tramo</span><input id="${p}nt" data-k="nombreTramo" value="${esc(r.nombreTramo)}" placeholder="Ej. Medellín - Turbo" autocomplete="off"></label>
        <label for="${p}mu"><span>Municipio <em>*</em> ${r.municipioAuto ? '<span class="auto">· por coordenadas</span>' : ""}</span><input id="${p}mu" data-k="municipio" value="${esc(r.municipio)}" list="lista-municipios" placeholder="Escribe o elige" autocomplete="off"></label>
        <label for="${p}ta"><span>Tipo de afectación <em>*</em></span><select id="${p}ta" data-k="tipoAfectacion">${opciones(TIPOS_AFECTACION, r.tipoAfectacion)}</select></label>
        <label for="${p}re"><span>Responsable de la visita <em>*</em></span><select id="${p}re" data-k="responsable">${opciones(RESPONSABLES, r.responsable)}</select></label>
        <label for="${p}es"><span>Estado <em>*</em></span><select id="${p}es" class="sel-estado" data-v="${esc(r.estadoPunto)}" data-k="estadoPunto">${opciones(ESTADOS, r.estadoPunto)}</select></label>
      </div>
      <label for="${p}ob"><span>Observaciones</span><textarea id="${p}ob" data-k="observaciones" placeholder="Describe lo observado en la visita">${esc(r.observaciones)}</textarea></label>`;
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
    if (!r.estadoPunto) f.push("estadoPunto");
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
      if (s.status === "success") d = { fecha: s.fecha, fechaTexto: s.fechaTexto, latitud: s.latitud, longitud: s.longitud, latitudDMS: s.latitudDMS, longitudDMS: s.longitudDMS, tramo: s.tramo, codigoVia: s.codigoVia };
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
    completarDesdeCoordenadas(r);

    const leido = r.fecha && tieneCoord(r);
    r.selloLegible = !!(d.fecha && d.latitud != null);
    r.estado = leido ? "listo" : "revisar";
    r.mensaje = error ? error + " Completa los datos a mano."
      : leido ? "" : "No se leyó todo el sello. Completa " + [!r.fecha && "la fecha", !tieneCoord(r) && "las coordenadas"].filter(Boolean).join(" y ") + ".";
    actualizar(r);
  }

  function aviso(texto, error) {
    const a = $("#aviso");
    a.textContent = texto || "";
    a.className = "aviso" + (error ? " is-error" : "");
    a.hidden = !texto;
  }

  /* ======================= Tarjetas ======================= */
  const ETIQUETAS = { leyendo: "Leyendo foto…", listo: "Listo", revisar: "Revisar", guardando: "Guardando…", guardado: "Guardado", error: "Error al guardar", manual: "Carga manual" };

  function tarjeta(r) {
    const esFoto = r.origen === "foto";
    const bloqueado = r.estado === "guardado" || r.estado === "guardando" || r.estado === "leyendo";
    const cls = ["card", esFoto ? "" : "is-manual", r.estado === "guardado" ? "is-guardado" : "", r.estadoPunto === "Crítico" ? "is-critico" : ""].join(" ");
    const etiqueta = r.estado === "listo" && !esFoto ? "Carga manual" : ETIQUETAS[r.estado];
    return `<article class="${cls}" data-id="${r.id}">
      ${esFoto ? `<button type="button" class="card__foto" data-act="ver" aria-label="Ver foto completa"><img src="${r.miniatura}" alt="Foto ${esc(r.nombreArchivo)}"><span>Ampliar</span></button>` : ""}
      <div class="card__cuerpo">
        <div class="card__top"><span class="card__nombre">${esc(esFoto ? r.nombreArchivo : "Registro sin foto")}${r.idRegistro ? " · " + esc(r.idRegistro) : ""}</span><span class="chip chip--${r.estado === "listo" && !esFoto ? "manual" : r.estado}">${etiqueta}</span></div>
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
      : '<p class="vacio">Aún no hay registros. Agrega uno con la carga manual o sube fotos.</p>';
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
    $("#descargar").disabled = !items.length;
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
    if (b.dataset.act === "quitar") { items = items.filter((x) => x !== r); render(); }
    if (b.dataset.act === "releer") { cola.push(r); r.estado = "leyendo"; actualizar(r); procesarCola(); }
    if (b.dataset.act === "ver") abrirVisor(r.dataUrl, r.nombreArchivo);
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
          body: JSON.stringify(Object.assign({ accion, token: CONFIG.TOKEN }, datos)),
          redirect: "follow"
        });
        const t = await r.text();
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
    guardando = true; contadores();
    let ok = 0, mal = 0;
    for (const r of lista) {
      r.estado = "guardando"; actualizar(r);
      const res = await Api.post("subir", {
        base64: r.base64 || "", mimeType: "image/jpeg", nombreArchivo: r.nombreArchivo || "", origen: r.origen,
        fecha: r.fecha, fechaTexto: r.fechaTexto, latitudDMS: r.latitudDMS, longitudDMS: r.longitudDMS,
        latitud: r.latitud, longitud: r.longitud, codigoVia: r.codigoVia, nombreTramo: r.nombreTramo,
        subregion: r.subregion, municipio: r.municipio, tipoAfectacion: r.tipoAfectacion, responsable: r.responsable,
        estadoPunto: r.estadoPunto, observaciones: r.observaciones, origenUbicacion: r.origenUbicacion, selloLegible: r.selloLegible
      });
      if (res.status === "success") { r.estado = "guardado"; r.idRegistro = res.id; r.mensaje = ""; ok++; }
      else { r.estado = "error"; r.mensaje = res.message || "No se pudo guardar."; mal++; }
      actualizar(r);
    }
    guardando = false; contadores();
    aviso(mal ? `${ok} guardados, ${mal} con error. Revisa los marcados y vuelve a intentar.` : `${ok} registro(s) guardados.`, mal > 0);
  });

  const COLS = [["Fecha", "fecha"], ["Latitud", "latitud"], ["Longitud", "longitud"], ["LatitudDMS", "latitudDMS"], ["LongitudDMS", "longitudDMS"],
    ["CodigoVia", "codigoVia"], ["NombreTramo", "nombreTramo"], ["Subregion", "subregion"], ["Municipio", "municipio"],
    ["TipoAfectacion", "tipoAfectacion"], ["Responsable", "responsable"], ["Estado", "estadoPunto"], ["Observaciones", "observaciones"],
    ["Origen", "origen"], ["Foto", "nombreArchivo"], ["FechaSello", "fechaTexto"], ["OrigenUbicacion", "origenUbicacion"]];
  $("#descargar").addEventListener("click", () => {
    const lista = items.filter((r) => r.estado !== "leyendo");
    if (!lista.length) { aviso("No hay registros para descargar.", true); return; }
    const malos = validarTodos(lista);
    const q = (v) => { v = v == null ? "" : String(v); return /[",;\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const csv = "﻿" + COLS.map((c) => c[0]).join(",") + "\n" + lista.map((r) => COLS.map(([, k]) => q(r[k])).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = "VIP-C_puntos_criticos_" + hoy() + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    aviso(`CSV descargado con ${lista.length} registro(s).` + (malos ? ` Atención: ${malos} tienen datos obligatorios vacíos (marcados en rojo).` : ""), malos > 0);
  });

  const vaciar = $("#vaciar");
  vaciar.addEventListener("click", () => {
    if (vaciar.dataset.confirmar) {
      items = []; cola.length = 0; render(); aviso("");
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

  /* ======================= Inicio ======================= */
  $("#guardar").hidden = !HAY_BACKEND;
  pintarManual();
  render();
  // Precarga el lector en segundo plano para que la primera foto sea más rápida
  setTimeout(() => { try { LectorSello.iniciar().catch(() => {}); } catch (_) {} }, 1500);
})();
