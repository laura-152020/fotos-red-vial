/* Fotos Red Vial Antioquia — v2
 * Flujo: seleccionar fotos → leer sello (Gemini vía Apps Script) → revisar → guardar (Drive + Sheets) → mapa
 */
(function () {
  "use strict";

  const TIPOS = ["Remoción de derrumbe", "Limpieza de cunetas", "Perfilado de vía", "Bacheo",
    "Obras de drenaje", "Muro / contención", "Señalización", "Inspección general", "Otro"];
  const MOMENTOS = ["Antes", "Durante", "Después"];
  const ANTIOQUIA = { latMin: 5.40, latMax: 8.90, lonMin: -77.15, lonMax: -73.85 };
  const DEMO = !CONFIG.API_URL;

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let items = [];
  let sec = 1;

  /* ======================= API ======================= */
  const Api = {
    async post(accion, datos) {
      if (DEMO) return Demo.post(accion, datos);
      try {
        const r = await fetch(CONFIG.API_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" }, // evita preflight CORS en Apps Script
          body: JSON.stringify(Object.assign({ accion, token: CONFIG.TOKEN }, datos)),
          redirect: "follow"
        });
        const t = await r.text();
        try { return JSON.parse(t); }
        catch (_) {
          if (/accounts\.google\.com|Sign in/i.test(t)) return { status: "error", message: "El Apps Script pide inicio de sesión. Revisa que la implementación tenga acceso para «Cualquier usuario»." };
          return { status: "error", message: "Respuesta inesperada del servidor." };
        }
      } catch (e) {
        return { status: "error", message: "Sin conexión con el servidor. Revisa internet e intenta de nuevo." };
      }
    },
    async listar() {
      if (DEMO) return Demo.listar();
      try {
        const u = CONFIG.API_URL + "?accion=listar&token=" + encodeURIComponent(CONFIG.TOKEN);
        const r = await fetch(u, { redirect: "follow" });
        return await r.json();
      } catch (e) {
        return { status: "error", message: "No se pudieron cargar los registros del mapa." };
      }
    }
  };

  /* ======================= Modo demo ======================= */
  const Demo = {
    guardados: [
      { ID: "F-000001", FechaFoto: "2026-09-09", Latitud: 6.178333, Longitud: -75.165833, Via: "Vía Granada - Guatapé", Municipio: "Granada", Contrato: "DEMO-001", TipoActividad: "Remoción de derrumbe", Momento: "Después", FileId: "" },
      { ID: "F-000002", FechaFoto: "2026-09-12", Latitud: 6.2335, Longitud: -75.1592, Via: "Vía Granada - Guatapé", Municipio: "Guatapé", Contrato: "DEMO-001", TipoActividad: "Limpieza de cunetas", Momento: "Durante", FileId: "" }
    ],
    async post(accion, d) {
      await new Promise((r) => setTimeout(r, 900 + Math.random() * 700));
      if (accion === "leer") {
        return { status: "success", fechaTexto: "9 de septiembre de 2026", fecha: "2026-09-09", latitudDMS: "6°10'42\"N", longitudDMS: "75°9'57\"W",
          latitud: 6.178333, longitud: -75.165833, via: "Vía Granada - Guatapé", municipio: "Granada", tipoActividad: "Remoción de derrumbe",
          observacion: "Lectura simulada (modo demo).", selloLegible: true, fueraDeAntioquia: false };
      }
      if (accion === "subir") {
        const id = "F-" + String(this.guardados.length + 1).padStart(6, "0");
        this.guardados.push({ ID: id, FechaFoto: d.fecha, Latitud: d.latitud, Longitud: d.longitud, Via: d.via, Municipio: d.municipio, Contrato: d.contrato, TipoActividad: d.tipoActividad, Momento: d.momento, FileId: "" });
        return { status: "success", id };
      }
      return { status: "error", message: "Acción no reconocida." };
    },
    async listar() { return { status: "success", registros: this.guardados.slice() }; }
  };

  /* ======================= Utilidades ======================= */
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
  const fuera = (la, lo) => la != null && lo != null && (la < ANTIOQUIA.latMin || la > ANTIOQUIA.latMax || lo < ANTIOQUIA.lonMin || lo > ANTIOQUIA.lonMax);
  const tieneCoord = (it) => it.latitud != null && it.longitud != null && !isNaN(it.latitud) && !isNaN(it.longitud);

  async function optimizar(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, mal) => { const i = new Image(); i.onload = () => ok(i); i.onerror = mal; i.src = url; });
      const f = Math.min(1, CONFIG.MAX_DIMENSION_PX / Math.max(img.width, img.height));
      const cv = document.createElement("canvas");
      cv.width = Math.round(img.width * f); cv.height = Math.round(img.height * f);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      const dataUrl = cv.toDataURL("image/jpeg", CONFIG.JPEG_QUALITY);
      const t = Math.min(1, 480 / Math.max(img.width, img.height));
      const cv2 = document.createElement("canvas");
      cv2.width = Math.round(img.width * t); cv2.height = Math.round(img.height * t);
      cv2.getContext("2d").drawImage(img, 0, 0, cv2.width, cv2.height);
      return { base64: dataUrl.split(",")[1], miniatura: cv2.toDataURL("image/jpeg", 0.7) };
    } finally { URL.revokeObjectURL(url); }
  }

  async function leerExif(file) {
    try {
      if (!window.exifr) return null;
      const d = await exifr.parse(file, { gps: true, pick: ["DateTimeOriginal", "latitude", "longitude"] });
      if (!d) return null;
      return {
        lat: typeof d.latitude === "number" ? Math.round(d.latitude * 1e6) / 1e6 : null,
        lon: typeof d.longitude === "number" ? Math.round(d.longitude * 1e6) / 1e6 : null,
        fecha: d.DateTimeOriginal instanceof Date ? d.DateTimeOriginal.toISOString().slice(0, 10) : ""
      };
    } catch (_) { return null; }
  }

  function aviso(texto, error) {
    const a = $("#aviso");
    a.textContent = texto || "";
    a.className = "aviso" + (error ? " is-error" : "");
    a.hidden = !texto;
  }

  /* ======================= Datos comunes ======================= */
  const COMUNES = ["contrato", "frente", "municipio", "inspector"];
  function comunes() { const o = {}; COMUNES.forEach((k) => { o[k] = $("#c-" + k).value.trim(); }); return o; }
  COMUNES.forEach((k) => {
    const el = $("#c-" + k);
    try { const v = localStorage.getItem("frv-" + k); if (v) el.value = v; } catch (_) {}
    el.addEventListener("input", () => { try { localStorage.setItem("frv-" + k, el.value); } catch (_) {} });
  });
  $("#aplicar-todas").addEventListener("click", () => {
    const c = comunes();
    const pend = items.filter((it) => it.estado !== "guardado");
    pend.forEach((it) => COMUNES.forEach((k) => { if (c[k]) it[k] = c[k]; }));
    render();
    aviso(pend.length ? "Datos comunes aplicados a " + pend.length + " foto(s)." : "Sube fotos primero; los datos comunes se aplican a cada foto nueva.");
  });

  /* ======================= Carga de archivos ======================= */
  async function agregar(files) {
    const validos = [];
    for (const f of files) {
      if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { aviso(f.name + " no es JPG, PNG ni WEBP.", true); continue; }
      if (f.size > CONFIG.MAX_FILE_SIZE_MB * 1048576) { aviso(f.name + " supera " + CONFIG.MAX_FILE_SIZE_MB + " MB.", true); continue; }
      validos.push(f);
    }
    const c = comunes();
    for (const f of validos) {
      let opt;
      try { opt = await optimizar(f); } catch (_) { aviso("No se pudo abrir " + f.name + ".", true); continue; }
      const exif = await leerExif(f);
      const it = {
        id: sec++, nombreArchivo: f.name, base64: opt.base64, miniatura: opt.miniatura, estado: "leyendo", mensaje: "",
        fecha: exif?.fecha || "", fechaTexto: "", latitudDMS: "", longitudDMS: "",
        latitud: exif?.lat ?? null, longitud: exif?.lon ?? null, origenUbicacion: exif?.lat != null ? "exif" : "manual",
        via: "", municipio: c.municipio, contrato: c.contrato, frente: c.frente, inspector: c.inspector,
        tipoActividad: "", momento: "", observacion: "", selloLegible: false
      };
      items.unshift(it);
      cola.push(it);
    }
    render();
    procesarCola();
  }

  const cola = [];
  let activos = 0;
  function procesarCola() {
    while (activos < CONFIG.LECTURAS_SIMULTANEAS && cola.length) {
      const it = cola.shift();
      activos++;
      leer(it).finally(() => { activos--; procesarCola(); });
    }
  }

  async function leer(it) {
    it.estado = "leyendo"; actualizar(it);
    const r = await Api.post("leer", { base64: it.base64, mimeType: "image/jpeg" });
    if (r.status !== "success") {
      it.estado = "revisar";
      it.mensaje = r.message || "No se pudo leer el sello.";
      actualizar(it);
      return;
    }
    it.fechaTexto = r.fechaTexto || "";
    if (r.fecha) it.fecha = r.fecha;
    if (r.latitud != null && r.longitud != null) {
      it.latitud = r.latitud; it.longitud = r.longitud;
      it.latitudDMS = r.latitudDMS || ""; it.longitudDMS = r.longitudDMS || "";
      it.origenUbicacion = "sello";
    }
    if (r.via) it.via = r.via;
    if (!it.municipio && r.municipio) it.municipio = r.municipio;
    if (!it.tipoActividad && r.tipoActividad) it.tipoActividad = r.tipoActividad;
    if (!it.observacion && r.observacion) it.observacion = r.observacion;
    it.selloLegible = !!r.selloLegible;
    it.estado = it.selloLegible ? "listo" : "revisar";
    it.mensaje = it.selloLegible ? "" : "El sello no se leyó completo. Revisa fecha, coordenadas y vía.";
    actualizar(it);
  }

  /* ======================= Render ======================= */
  const ETIQUETAS = { leyendo: "Leyendo sello…", listo: "Listo", revisar: "Revisar", guardando: "Guardando…", guardado: "Guardado", error: "Error al guardar" };

  function tarjeta(it) {
    const opciones = (arr, v) => '<option value="">Seleccionar…</option>' + arr.map((o) => `<option${o === v ? " selected" : ""}>${esc(o)}</option>`).join("");
    const bloqueado = it.estado === "guardado" || it.estado === "guardando" ? " disabled" : "";
    const coordTxt = tieneCoord(it)
      ? `${it.latitud.toFixed(6)}, ${it.longitud.toFixed(6)} · origen: ${it.origenUbicacion} <a href="https://www.google.com/maps?q=${it.latitud},${it.longitud}" target="_blank" rel="noopener">Ver ubicación</a>`
      : "Sin coordenadas";
    const alerta = fuera(it.latitud, it.longitud) ? '<div class="alerta">La ubicación cae fuera de Antioquia. Verifica las coordenadas.</div>' : "";
    const msg = it.mensaje ? `<div class="alerta">${esc(it.mensaje)}</div>` : "";
    return `<article class="card${it.estado === "guardado" ? " is-guardado" : ""}" data-id="${it.id}">
      <div class="card__foto"><img src="${it.miniatura}" alt="Foto ${esc(it.nombreArchivo)}"></div>
      <div class="card__cuerpo">
        <div class="card__top"><span class="card__nombre">${esc(it.nombreArchivo)}${it.idRegistro ? " · " + esc(it.idRegistro) : ""}</span><span class="chip chip--${it.estado}">${ETIQUETAS[it.estado]}</span></div>
        ${msg}
        <fieldset style="border:0;padding:0;margin:0;display:grid;gap:12px;min-width:0"${bloqueado}>
          <div class="grid">
            <label for="fe-${it.id}">Fecha<input id="fe-${it.id}" type="date" data-k="fecha" value="${esc(it.fecha)}"></label>
            <label for="la-${it.id}">Latitud<input id="la-${it.id}" class="mono" data-k="latitudDMS" value="${esc(it.latitudDMS || (it.latitud ?? ""))}" placeholder="6°10'42&quot;N"></label>
            <label for="lo-${it.id}">Longitud<input id="lo-${it.id}" class="mono" data-k="longitudDMS" value="${esc(it.longitudDMS || (it.longitud ?? ""))}" placeholder="75°9'57&quot;W"></label>
          </div>
          <div class="coord" data-coord>${coordTxt}</div>${alerta}
          <div class="grid">
            <label for="vi-${it.id}"><span>Vía <em>*</em></span><input id="vi-${it.id}" data-k="via" value="${esc(it.via)}"></label>
            <label for="mu-${it.id}">Municipio<input id="mu-${it.id}" data-k="municipio" value="${esc(it.municipio)}"></label>
            <label for="co-${it.id}"><span>Contrato <em>*</em></span><input id="co-${it.id}" data-k="contrato" value="${esc(it.contrato)}"></label>
            <label for="fr-${it.id}">Frente<input id="fr-${it.id}" data-k="frente" value="${esc(it.frente)}"></label>
            <label for="ti-${it.id}">Tipo de actividad<select id="ti-${it.id}" data-k="tipoActividad">${opciones(TIPOS, it.tipoActividad)}</select></label>
            <label for="mo-${it.id}">Momento<select id="mo-${it.id}" data-k="momento">${opciones(MOMENTOS, it.momento)}</select></label>
          </div>
          <label for="ob-${it.id}">Observaciones<textarea id="ob-${it.id}" data-k="observacion">${esc(it.observacion)}</textarea></label>
        </fieldset>
        <div class="actions">
          ${it.estado !== "guardado" && it.estado !== "leyendo" ? '<button type="button" class="btn btn--sm" data-act="releer">Volver a leer sello</button>' : ""}
          ${it.estado !== "guardando" ? '<button type="button" class="btn btn--sm" data-act="quitar">Quitar de la lista</button>' : ""}
        </div>
      </div>
    </article>`;
  }

  function render() {
    $("#tarjetas").innerHTML = items.length ? items.map(tarjeta).join("") : '<p class="vacio">Aún no hay fotos. Sube la primera arriba.</p>';
    contadores();
  }
  function actualizar(it) {
    const el = document.querySelector(`.card[data-id="${it.id}"]`);
    if (el) el.outerHTML = tarjeta(it);
    contadores();
  }
  function contadores() {
    const listas = items.filter((it) => it.estado === "listo" || it.estado === "revisar" || it.estado === "error").length;
    const leyendo = items.filter((it) => it.estado === "leyendo").length;
    const guardadas = items.filter((it) => it.estado === "guardado").length;
    $("#n-listas").textContent = listas;
    $("#n-leyendo").textContent = leyendo ? "· " + leyendo + " leyendo" : "";
    $("#resumen").textContent = items.length ? `${items.length} en la lista · ${guardadas} guardadas` : "";
    $("#guardar").disabled = !listas || guardandoTodo;
  }

  /* ======================= Edición ======================= */
  const buscar = (el) => items.find((x) => x.id == el.closest(".card")?.dataset.id);
  $("#tarjetas").addEventListener("input", (e) => {
    const k = e.target.dataset.k; if (!k) return;
    const it = buscar(e.target); if (!it) return;
    it[k] = e.target.value;
    e.target.classList.remove("is-invalid");
    if (k === "latitudDMS" || k === "longitudDMS") {
      it.latitud = dmsADecimal(it.latitudDMS);
      let lo = dmsADecimal(it.longitudDMS);
      if (lo != null && lo > 60) lo = -lo; // Antioquia: longitud Oeste
      it.longitud = lo;
      it.origenUbicacion = "manual";
      const c = e.target.closest(".card").querySelector("[data-coord]");
      if (c) c.textContent = tieneCoord(it) ? `${it.latitud.toFixed(6)}, ${it.longitud.toFixed(6)} · origen: manual` : "Coordenadas incompletas";
    }
  });
  $("#tarjetas").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]"); if (!b) return;
    const it = buscar(b); if (!it) return;
    if (b.dataset.act === "quitar") { items = items.filter((x) => x !== it); render(); }
    if (b.dataset.act === "releer") { cola.push(it); it.estado = "leyendo"; actualizar(it); procesarCola(); }
  });

  /* ======================= Guardar ======================= */
  let guardandoTodo = false;
  $("#guardar").addEventListener("click", async () => {
    const pend = items.filter((it) => it.estado === "listo" || it.estado === "revisar" || it.estado === "error");
    // Validación previa
    let faltan = 0;
    pend.forEach((it) => {
      ["contrato", "via"].forEach((k) => {
        if (!String(it[k] || "").trim()) {
          faltan++;
          const el = document.querySelector(`.card[data-id="${it.id}"] [data-k="${k}"]`);
          if (el) el.classList.add("is-invalid");
        }
      });
    });
    if (faltan) { aviso("Faltan contrato o vía en algunas fotos (marcadas en rojo). Complétalos para guardar.", true); return; }

    guardandoTodo = true; contadores();
    let ok = 0, mal = 0;
    for (const it of pend) {
      it.estado = "guardando"; actualizar(it);
      const r = await Api.post("subir", {
        base64: it.base64, mimeType: "image/jpeg", nombreArchivo: it.nombreArchivo,
        fecha: it.fecha, fechaTexto: it.fechaTexto, latitudDMS: it.latitudDMS, longitudDMS: it.longitudDMS,
        latitud: it.latitud, longitud: it.longitud, via: it.via, municipio: it.municipio, contrato: it.contrato,
        frente: it.frente, tipoActividad: it.tipoActividad, momento: it.momento, observacion: it.observacion,
        inspector: it.inspector, origenUbicacion: it.origenUbicacion, selloLegible: it.selloLegible
      });
      if (r.status === "success") { it.estado = "guardado"; it.idRegistro = r.id; it.mensaje = ""; ok++; }
      else { it.estado = "error"; it.mensaje = r.message || "No se pudo guardar."; mal++; }
      actualizar(it);
    }
    guardandoTodo = false; contadores();
    aviso(mal ? `${ok} guardadas, ${mal} con error. Revisa las marcadas y vuelve a intentar.` : DEMO ? `${ok} foto(s) guardadas (simulado, modo demo).` : `${ok} foto(s) guardadas en Drive y registradas.`, mal > 0);
    mapaDesactualizado = true;
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

  const drop = $("#drop");
  $("#archivos").addEventListener("change", (e) => { agregar([...e.target.files]); e.target.value = ""; });
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("is-over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("is-over"); }));
  drop.addEventListener("drop", (e) => { if (e.dataTransfer?.files?.length) agregar([...e.dataTransfer.files]); });

  /* ======================= Mapa ======================= */
  let mapa = null, grupo = null, registros = [], mapaDesactualizado = true;

  function iniciarMapa() {
    if (mapa || !window.L) return;
    mapa = L.map("mapa", { zoomControl: true }).setView(CONFIG.MAPA_CENTRO, CONFIG.MAPA_ZOOM);
    const satelite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Imágenes © Esri" });
    const calles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" });
    const etiquetas = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19 });
    satelite.addTo(mapa); etiquetas.addTo(mapa);
    L.control.layers({ "Satélite": satelite, "Calles": calles }, { "Nombres": etiquetas }).addTo(mapa);
    grupo = L.markerClusterGroup ? L.markerClusterGroup() : L.layerGroup();
    mapa.addLayer(grupo);
  }

  async function cargarMapa() {
    iniciarMapa();
    $("#mapa-conteo").textContent = "Cargando…";
    const r = await Api.listar();
    if (r.status !== "success") { $("#mapa-conteo").textContent = r.message || "Error al cargar."; return; }
    registros = (r.registros || []).filter((x) => x.Latitud !== "" && x.Longitud !== "" && !isNaN(Number(x.Latitud)));
    mapaDesactualizado = false;
    pintar();
  }

  function pintar() {
    if (!grupo) return;
    const q = $("#filtro").value.trim().toLowerCase();
    const vis = registros.filter((x) => !q || [x.Via, x.Contrato, x.Municipio, x.ID].join(" ").toLowerCase().includes(q));
    grupo.clearLayers();
    vis.forEach((x) => {
      const img = x.FileId ? `<img src="https://drive.google.com/thumbnail?id=${encodeURIComponent(x.FileId)}&sz=w480" alt="Foto ${esc(x.ID)}" loading="lazy">` : "";
      const enlace = x.URL ? `<a href="${esc(x.URL)}" target="_blank" rel="noopener">Abrir foto en Drive</a>` : "";
      L.marker([Number(x.Latitud), Number(x.Longitud)]).bindPopup(
        `<div class="pop">${img}<b>${esc(x.Via || "Sin vía")}</b><small>${esc(x.ID)} · ${esc(x.FechaFoto || "")} · ${esc(x.Municipio || "")}</small>` +
        `<small>Contrato ${esc(x.Contrato || "—")} · ${esc(x.TipoActividad || "")} ${x.Momento ? "(" + esc(x.Momento) + ")" : ""}</small>${enlace}</div>`,
        { maxWidth: 280 }
      ).addTo(grupo);
    });
    $("#mapa-conteo").textContent = `${vis.length} de ${registros.length} fotos`;
    if (vis.length) mapa.fitBounds(L.latLngBounds(vis.map((x) => [Number(x.Latitud), Number(x.Longitud)])).pad(0.2), { maxZoom: 15 });
  }
  $("#filtro").addEventListener("input", pintar);
  $("#recargar").addEventListener("click", cargarMapa);

  /* ======================= Pestañas ======================= */
  function mostrar(vista) {
    const esMapa = vista === "mapa";
    $("#vista-cargar").hidden = esMapa; $("#vista-mapa").hidden = !esMapa; $("#barra").hidden = esMapa;
    $("#tab-cargar").classList.toggle("is-active", !esMapa); $("#tab-mapa").classList.toggle("is-active", esMapa);
    $("#tab-cargar").setAttribute("aria-selected", String(!esMapa)); $("#tab-mapa").setAttribute("aria-selected", String(esMapa));
    if (esMapa) {
      if (mapaDesactualizado) cargarMapa();
      setTimeout(() => mapa && mapa.invalidateSize(), 50);
    }
  }
  $("#tab-cargar").addEventListener("click", () => mostrar("cargar"));
  $("#tab-mapa").addEventListener("click", () => mostrar("mapa"));

  /* ======================= Inicio ======================= */
  $("#demo-banner").hidden = !DEMO;
  render();
})();
