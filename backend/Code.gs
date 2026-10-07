/**
 * Fotos Red Vial Antioquia — Backend v2 (Google Apps Script)
 * ----------------------------------------------------------
 * Un solo archivo. Guarda fotos en Drive, lee el sello de la foto con Gemini
 * y registra cada foto en Google Sheets. Expone los datos para el mapa y ArcGIS.
 *
 * PROPIEDADES DEL SCRIPT (Configuración del proyecto → Propiedades del script):
 *   GEMINI_API_KEY   Clave de Google AI Studio (https://aistudio.google.com/apikey)
 *   GEMINI_MODEL     Opcional. Por defecto: gemini-3.8-flash
 *   ROOT_FOLDER_ID   ID de la carpeta raíz en Drive donde se guardan las fotos
 *   SPREADSHEET_ID   ID del Google Sheet que funciona como base de datos
 *   APP_TOKEN        Clave compartida con la página (la misma de config.js)
 *
 * ACCIONES
 *   POST {accion:"leer",  token, base64, mimeType}            → datos del sello (no guarda nada)
 *   POST {accion:"subir", token, base64, mimeType, ...campos} → guarda en Drive + Sheets
 *   GET  ?accion=listar&token=...&formato=json|geojson|csv    → registros para mapa / ArcGIS
 *   GET  (sin parámetros)                                     → estado del servicio
 */

const HOJA = "Registro_Fotografico";
const COLUMNAS = [
  "ID", "FechaRegistro", "FechaFoto", "FechaSello", "LatitudDMS", "LongitudDMS",
  "Latitud", "Longitud", "Via", "Municipio", "Contrato", "Frente",
  "TipoActividad", "Momento", "Observaciones", "Inspector",
  "Archivo", "FileId", "URL", "OrigenUbicacion", "SelloLegible", "FueraDeAntioquia"
];
const ANTIOQUIA = { latMin: 5.40, latMax: 8.90, lonMin: -77.15, lonMax: -73.85 };
const TIPOS = ["Remoción de derrumbe", "Limpieza de cunetas", "Perfilado de vía", "Bacheo",
  "Obras de drenaje", "Muro / contención", "Señalización", "Inspección general", "Otro"];

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
    "fecha_texto (tal cual), fecha_iso (AAAA-MM-DD), latitud (tal cual, ej 6°10'42\"N), " +
    "longitud (tal cual, ej 75°9'57\"W), via (tal cual), municipio_sugerido (municipio de Antioquia más probable), " +
    "tipo_actividad (uno de: " + TIPOS.join(", ") + "), observacion (máximo 25 palabras sobre el estado de la vía), " +
    "sello_legible (true/false).";

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
    via: d.via || "",
    municipio: d.municipio_sugerido || "",
    tipoActividad: TIPOS.indexOf(d.tipo_actividad) >= 0 ? d.tipo_actividad : "",
    observacion: d.observacion || "",
    selloLegible: !!d.sello_legible && lat !== null && lon !== null,
    fueraDeAntioquia: fueraDeAntioquia_(lat, lon)
  };
}

/* ======================= Guardado (Drive + Sheets) ======================= */

function subirFoto_(p) {
  if (!p.base64) throw new Error("No llegó la imagen.");
  if (!texto_(p.contrato)) throw new Error("El contrato es obligatorio.");
  if (!texto_(p.via)) throw new Error("La vía es obligatoria.");

  const lat = numero_(p.latitud), lon = numero_(p.longitud);
  if ((lat === null) !== (lon === null)) throw new Error("Faltan latitud o longitud.");
  if (lat !== null && (lat < -90 || lat > 90 || lon < -180 || lon > 180)) throw new Error("Coordenadas fuera de rango.");

  // Drive: Raíz / Contrato_X / Via_Y / archivo
  const raiz = DriveApp.getFolderById(prop_("ROOT_FOLDER_ID"));
  const cContrato = carpeta_(raiz, "Contrato_" + limpiar_(p.contrato));
  const cVia = carpeta_(cContrato, "Via_" + limpiar_(p.via));
  const nombre = limpiar_(p.nombreArchivo || "foto_inspeccion.jpg");
  const blob = Utilities.newBlob(Utilities.base64Decode(p.base64), p.mimeType || "image/jpeg", nombre);
  const archivo = cVia.createFile(blob);
  archivo.setDescription("Contrato: " + p.contrato + " | Vía: " + p.via + " | " + (lat !== null ? lat + ", " + lon : "sin coordenadas"));
  try { archivo.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (_) { /* dominio restringido */ }

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
      texto_(p.via), texto_(p.municipio), texto_(p.contrato), texto_(p.frente),
      texto_(p.tipoActividad), texto_(p.momento), texto_(p.observacion), texto_(p.inspector),
      archivo.getName(), archivo.getId(), archivo.getUrl(),
      texto_(p.origenUbicacion) || "manual", p.selloLegible ? "SI" : "NO",
      fueraDeAntioquia_(lat, lon) ? "SI" : "NO"
    ]);
    return { status: "success", id: id, fileId: archivo.getId(), url: archivo.getUrl() };
  } catch (err) {
    return { status: "partial_error", message: "La foto quedó en Drive pero falló el registro en Sheets: " + err.message, fileId: archivo.getId(), url: archivo.getUrl() };
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
  });
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
