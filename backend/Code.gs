/**
 * VIP-C · Visor interactivo de puntos críticos — Backend v3 (Google Apps Script)
 * ----------------------------------------------------------
 * Un solo archivo. Guarda fotos en Drive, lee el sello de la foto con Gemini
 * y registra cada punto (con o sin foto) en Google Sheets. Expone los datos para ArcGIS.
 *
 * PROPIEDADES DEL SCRIPT (Configuración del proyecto → Propiedades del script):
 *   GEMINI_API_KEY   Clave de Google AI Studio (https://aistudio.google.com/apikey)
 *   GEMINI_MODEL     Opcional. Por defecto: gemini-3.8-flash
 *   ROOT_FOLDER_ID   ID de la carpeta raíz en Drive donde se guardan las fotos
 *   SPREADSHEET_ID   ID del Google Sheet que funciona como base de datos
 *   APP_TOKEN        Clave compartida con la página (la misma de config.js)
 *   ADMIN_TOKEN      Clave de administrador, necesaria para borrar (anular) registros
 *
 * ACCIONES
 *   POST {accion:"leer",  token, base64, mimeType}            → datos del sello (no guarda nada)
 *   POST {accion:"subir", token, base64?, mimeType, ...campos} → guarda en Drive (si hay foto) + Sheets
 *   POST {accion:"anular", token, adminToken, id, motivo}   → marca el registro ANULADO y manda la foto a la papelera
 *   GET  ?accion=listar&token=...&formato=json|geojson|csv    → registros para ArcGIS
 *   GET  (sin parámetros)                                     → estado del servicio
 */

const HOJA = "Registro_VIPC";
const COLUMNAS = [
  "ID", "FechaRegistro", "FechaVisita", "FechaSello", "LatitudDMS", "LongitudDMS",
  "Latitud", "Longitud", "CodigoVia", "NombreTramo", "Subregion", "Municipio",
  "TipoAfectacion", "Responsable", "Estado", "Observaciones", "Origen",
  "Archivo", "FileId", "URL", "OrigenUbicacion", "SelloLegible", "FueraDeAntioquia",
  "EstadoRegistro", "FechaAnulacion", "MotivoAnulacion"
];
const RESPONSABLES = ["Gobernación", "Rental", "Alcaldía", "Ciudadanía"];
const ESTADOS = ["Crítico", "No crítico"];
const ANTIOQUIA = { latMin: 5.40, latMax: 8.90, lonMin: -77.15, lonMax: -73.85 };

/* ======================= Entradas HTTP ======================= */

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!p.accion) return json_({ status: "online", servicio: "Fotos Red Vial Antioquia", version: "2.0.0" });
  try {
    validarToken_(p.token);
    if (p.accion === "listar") {
      const registros = listarRegistros_();
      if (p.formato === "csv") return ContentService.createTextOutput(aCSV_(registros)).setMimeType(ContentService.MimeType.CSV);
      if (p.formato === "geojson") return json_(aGeoJSON_(registros));
      return json_({ status: "success", total: registros.length, registros: registros });
    }
    return json_({ status: "error", message: "Acción no reconocida." });
  } catch (err) {
    return json_({ status: "error", message: err.message || String(err) });
  }
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) throw new Error("Solicitud vacía.");
    const payload = JSON.parse(e.postData.contents);
    validarToken_(payload.token);
    if (payload.accion === "leer") return json_(leerSello_(payload));
    if (payload.accion === "subir") return json_(subirFoto_(payload));
    if (payload.accion === "anular") return json_(anularRegistro_(payload));
    throw new Error("Acción no reconocida.");
  } catch (err) {
    return json_({ status: "error", message: err.message || String(err) });
  }
}

/* ======================= Lectura del sello (Gemini) ======================= */

function leerSello_(payload) {
  if (!payload.base64) throw new Error("No llegó la imagen.");
  const key = prop_("GEMINI_API_KEY");
  const modelo = prop_("GEMINI_MODEL", true) || "gemini-3.8-flash";

  const prompt =
    "La imagen es una foto de inspección vial de la Gobernación de Antioquia (Colombia). " +
    "Suele tener un sello de texto superpuesto (normalmente en la esquina inferior derecha) con fecha, " +
    "coordenadas en grados-minutos-segundos y el nombre de la vía.\n" +
    "Lee ese sello EXACTAMENTE como aparece. No inventes: si algo no se lee, devuelve \"\".\n" +
    "Responde SOLO JSON con estas claves:\n" +
    "fecha_texto (tal cual), fecha_iso (AAAA-MM-DD; las fechas numéricas van en formato día/mes/año), " +
    "latitud (tal cual, ej 6°10'42\"N), longitud (tal cual, ej 75°9'57\"W), " +
    "tramo (nombre del tramo sin la palabra Vía, ej \"Granada - Guatapé\"), " +
    "codigo_via (código oficial de la vía si aparece, ej 60AN17; si no, \"\"), sello_legible (true/false).";

  const body = {
    contents: [{ parts: [
      { text: prompt },
      { inline_data: { mime_type: payload.mimeType || "image/jpeg", data: payload.base64 } }
    ] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0 }
  };

  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(modelo) + ":generateContent";
  const res = UrlFetchApp.fetch(url, {
    method: "post", contentType: "application/json", muteHttpExceptions: true,
    headers: { "x-goog-api-key": key },
    payload: JSON.stringify(body)
  });
  const code = res.getResponseCode();
  if (code === 429) return { status: "error", reintentar: true, message: "Gemini está limitando solicitudes. Intenta de nuevo en un minuto." };
  if (code !== 200) return { status: "error", message: "Gemini respondió " + code + ": " + res.getContentText().slice(0, 200) };

  const r = JSON.parse(res.getContentText());
  const texto = r && r.candidates && r.candidates[0] && r.candidates[0].content &&
    r.candidates[0].content.parts && r.candidates[0].content.parts[0] && r.candidates[0].content.parts[0].text;
  if (!texto) return { status: "error", message: "Gemini no devolvió texto para esta foto." };

  let d;
  try { d = JSON.parse(texto.replace(/^```json\s*|```$/g, "")); }
  catch (_) { return { status: "error", message: "No se pudo interpretar la respuesta de Gemini." }; }

  const lat = dmsADecimal_(d.latitud);
  let lon = dmsADecimal_(d.longitud);
  if (lon !== null && lon > 0 && lon > 60) lon = -lon; // Antioquia siempre es longitud Oeste

  return {
    status: "success",
    fechaTexto: d.fecha_texto || "",
    fecha: /^\d{4}-\d{2}-\d{2}$/.test(d.fecha_iso || "") ? d.fecha_iso : "",
    latitudDMS: d.latitud || "",
    longitudDMS: d.longitud || "",
    latitud: lat,
    longitud: lon,
    tramo: String(d.tramo || "").replace(/^\s*v[ií]a\s*/i, ""),
    codigoVia: String(d.codigo_via || "").toUpperCase().replace(/\s/g, ""),
    selloLegible: !!d.sello_legible && lat !== null && lon !== null,
    fueraDeAntioquia: fueraDeAntioquia_(lat, lon)
  };
}

/* ======================= Guardado (Drive + Sheets) ======================= */

function subirFoto_(p) {
  const faltan = [];
  if (!texto_(p.fecha)) faltan.push("fecha");
  if (!texto_(p.municipio)) faltan.push("municipio");
  if (!texto_(p.tipoAfectacion)) faltan.push("tipo de afectación");
  if (RESPONSABLES.indexOf(texto_(p.responsable)) < 0) faltan.push("responsable de la visita");
  if (ESTADOS.indexOf(texto_(p.estadoPunto)) < 0) faltan.push("estado");
  if (!texto_(p.codigoVia) && !texto_(p.nombreTramo)) faltan.push("código de la vía o nombre del tramo");
  if (faltan.length) throw new Error("Falta: " + faltan.join(", ") + ".");

  const lat = numero_(p.latitud), lon = numero_(p.longitud);
  if ((lat === null) !== (lon === null)) throw new Error("Faltan latitud o longitud.");
  if (lat !== null && (lat < -90 || lat > 90 || lon < -180 || lon > 180)) throw new Error("Coordenadas fuera de rango.");

  // Drive (solo si hay foto): Raíz / Subregion / Municipio / archivo
  let archivo = null;
  if (p.base64) {
    const raiz = DriveApp.getFolderById(prop_("ROOT_FOLDER_ID"));
    const cSub = carpeta_(raiz, limpiar_(p.subregion || "Sin subregion"));
    const cMun = carpeta_(cSub, limpiar_(p.municipio));
    const nombre = limpiar_((texto_(p.fecha) || "sin-fecha") + "_" + (texto_(p.codigoVia) || texto_(p.nombreTramo) || "via") + "_" + (p.nombreArchivo || "foto.jpg"));
    const blob = Utilities.newBlob(Utilities.base64Decode(p.base64), p.mimeType || "image/jpeg", nombre);
    archivo = cMun.createFile(blob);
    archivo.setDescription("VIP-C | " + texto_(p.codigoVia) + " " + texto_(p.nombreTramo) + " | " + texto_(p.municipio) + " | " + texto_(p.estadoPunto));
    try { archivo.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (_) { /* dominio restringido */ }
  }

  // Sheets con bloqueo para que el ID consecutivo no se repita
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const hoja = hoja_();
    const id = siguienteId_(hoja);
    const ahora = Utilities.formatDate(new Date(), "America/Bogota", "yyyy-MM-dd HH:mm:ss");
    hoja.appendRow([
      id, ahora, texto_(p.fecha), texto_(p.fechaTexto), texto_(p.latitudDMS), texto_(p.longitudDMS),
      lat === null ? "" : lat, lon === null ? "" : lon,
      texto_(p.codigoVia).toUpperCase(), texto_(p.nombreTramo), texto_(p.subregion), texto_(p.municipio),
      texto_(p.tipoAfectacion), texto_(p.responsable), texto_(p.estadoPunto), texto_(p.observaciones),
      archivo ? "foto" : "manual",
      archivo ? archivo.getName() : "", archivo ? archivo.getId() : "", archivo ? archivo.getUrl() : "",
      texto_(p.origenUbicacion) || "manual", p.selloLegible ? "SI" : "NO",
      fueraDeAntioquia_(lat, lon) ? "SI" : "NO",
      "ACTIVO", "", ""
    ]);
    return { status: "success", id: id, fileId: archivo ? archivo.getId() : "", url: archivo ? archivo.getUrl() : "" };
  } catch (err) {
    return { status: "partial_error", message: (archivo ? "La foto quedó en Drive pero falló" : "Falló") + " el registro en Sheets: " + err.message };
  } finally {
    lock.releaseLock();
  }
}

/* ======================= Borrado seguro (anulación) ======================= */

function anularRegistro_(p) {
  const admin = prop_("ADMIN_TOKEN", true);
  if (!admin) throw new Error("El borrado no está habilitado: falta la propiedad ADMIN_TOKEN.");
  if (p.adminToken !== admin) throw new Error("Clave de administrador incorrecta.");
  if (!texto_(p.id)) throw new Error("Falta el ID del registro.");

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const hoja = hoja_();
    const enc = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0];
    const col = function (n) { return enc.indexOf(n) + 1; };
    const ids = hoja.getRange(2, 1, Math.max(hoja.getLastRow() - 1, 1), 1).getValues();
    let fila = -1;
    for (let i = 0; i < ids.length; i++) { if (String(ids[i][0]) === String(p.id)) { fila = i + 2; break; } }
    if (fila < 0) throw new Error("No se encontró el registro " + p.id + ".");

    hoja.getRange(fila, col("EstadoRegistro")).setValue("ANULADO");
    hoja.getRange(fila, col("FechaAnulacion")).setValue(Utilities.formatDate(new Date(), "America/Bogota", "yyyy-MM-dd HH:mm:ss"));
    hoja.getRange(fila, col("MotivoAnulacion")).setValue(texto_(p.motivo) || "Sin motivo");

    const fileId = hoja.getRange(fila, col("FileId")).getValue();
    let papelera = false;
    if (fileId) { try { DriveApp.getFileById(String(fileId)).setTrashed(true); papelera = true; } catch (_) { /* ya no existe */ } }
    return { status: "success", id: p.id, fotoEnPapelera: papelera };
  } finally {
    lock.releaseLock();
  }
}

/* ======================= Lectura de registros ======================= */

function listarRegistros_() {
  const hoja = hoja_();
  const datos = hoja.getDataRange().getValues();
  if (datos.length < 2) return [];
  const enc = datos[0];
  return datos.slice(1).map(function (fila) {
    const o = {};
    enc.forEach(function (c, i) { o[c] = fila[i] instanceof Date ? Utilities.formatDate(fila[i], "America/Bogota", "yyyy-MM-dd") : fila[i]; });
    return o;
  }).filter(function (o) { return o.EstadoRegistro !== "ANULADO"; });
}

function aGeoJSON_(registros) {
  return {
    type: "FeatureCollection",
    features: registros.filter(function (r) { return r.Latitud !== "" && r.Longitud !== ""; }).map(function (r) {
      return { type: "Feature", geometry: { type: "Point", coordinates: [Number(r.Longitud), Number(r.Latitud)] }, properties: r };
    })
  };
}

function aCSV_(registros) {
  const q = function (v) { v = v === null || v === undefined ? "" : String(v); return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  return [COLUMNAS.join(",")].concat(registros.map(function (r) { return COLUMNAS.map(function (c) { return q(r[c]); }).join(","); })).join("\n");
}

/* ======================= Utilidades ======================= */

function dmsADecimal_(s) {
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

function fueraDeAntioquia_(lat, lon) {
  if (lat === null || lon === null) return false;
  return lat < ANTIOQUIA.latMin || lat > ANTIOQUIA.latMax || lon < ANTIOQUIA.lonMin || lon > ANTIOQUIA.lonMax;
}

function hoja_() {
  const ss = SpreadsheetApp.openById(prop_("SPREADSHEET_ID"));
  let h = ss.getSheetByName(HOJA);
  if (!h) h = ss.insertSheet(HOJA);
  if (h.getLastRow() === 0) {
    h.appendRow(COLUMNAS);
    h.getRange(1, 1, 1, COLUMNAS.length).setFontWeight("bold");
    h.setFrozenRows(1);
  } else if (h.getLastColumn() < COLUMNAS.length) {
    // Hoja creada con una versión anterior: agrega los encabezados nuevos
    h.getRange(1, 1, 1, COLUMNAS.length).setValues([COLUMNAS]).setFontWeight("bold");
  }
  return h;
}

function siguienteId_(hoja) {
  const ultima = hoja.getLastRow();
  if (ultima <= 1) return "F-000001";
  const m = String(hoja.getRange(ultima, 1).getValue()).match(/F-(\d+)/);
  const n = m ? Number(m[1]) + 1 : ultima;
  return "F-" + String(n).padStart(6, "0");
}

function carpeta_(padre, nombre) {
  const it = padre.getFoldersByName(nombre);
  return it.hasNext() ? it.next() : padre.createFolder(nombre);
}

function validarToken_(t) {
  const esperado = prop_("APP_TOKEN", true);
  if (esperado && t !== esperado) throw new Error("Clave de acceso inválida.");
}

function prop_(nombre, opcional) {
  const v = PropertiesService.getScriptProperties().getProperty(nombre);
  if (!v && !opcional) throw new Error("Falta configurar la propiedad del script " + nombre + ".");
  return v;
}

function limpiar_(s) { return String(s || "").trim().replace(/[\/\\:*?"<>|]/g, "_").slice(0, 120) || "SIN_NOMBRE"; }
function texto_(v) { return v === null || v === undefined ? "" : String(v).trim(); }
function numero_(v) { if (v === null || v === undefined || v === "") return null; const n = Number(v); return isNaN(n) ? null : n; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/* ======================= Prueba manual ======================= */
/** Ejecuta esta función desde el editor para verificar la configuración. */
function probarConfiguracion() {
  ["GEMINI_API_KEY", "ROOT_FOLDER_ID", "SPREADSHEET_ID"].forEach(function (k) { prop_(k); });
  DriveApp.getFolderById(prop_("ROOT_FOLDER_ID")).getName();
  hoja_();
  Logger.log("Configuración correcta. Modelo: " + (prop_("GEMINI_MODEL", true) || "gemini-3.8-flash"));
}
