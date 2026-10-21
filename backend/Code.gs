/**
 * VIP-C · Visor interactivo de puntos críticos — Backend v4.3 (Google Apps Script)
 * ----------------------------------------------------------
 * Un solo archivo. Guarda fotos en Drive, lee el sello de la foto con Gemini
 * y registra cada punto (con o sin foto) en Google Sheets. Expone los datos para ArcGIS.
 *
 * PROPIEDADES DEL SCRIPT (Configuración del proyecto → Propiedades del script):
 *   GEMINI_API_KEY   Clave de Google AI Studio (https://aistudio.google.com/apikey)
 *   GEMINI_MODEL     Opcional. Por defecto: gemini-3.8-flash
 *   ROOT_FOLDER_ID   ID de la carpeta raíz en Drive donde se guardan las fotos
 *   SPREADSHEET_ID   ID del Google Sheet que funciona como base de datos
 *   APP_TOKEN        Opcional. Clave compartida con la página (la misma de config.js)
 *   ADMIN_TOKEN      Clave de administrador: anular registros y exportar a ArcGIS
 *   SESSION_SECRET   Se crea sola la primera vez. Si la cambias o la borras, se cierran todas las sesiones.
 *   DOMINIO_INSTITUCIONAL  Opcional. Por defecto antioquia.gov.co (esos correos se activan con un código)
 *   ADMIN_EMAIL      Opcional. A dónde llegan los avisos de solicitudes. Por defecto, el dueño del script
 *
 * USUARIOS (hoja "Usuarios" del mismo Sheet; se crea sola)
 *   Para dar de alta: escribe Usuario, Nombre y una contraseña en "ContraseñaNueva", con Activo = SI.
 *   En el primer ingreso (o al ejecutar actualizarUsuarios) la contraseña se cifra y se borra de la hoja.
 *   Para dar de baja: Activo = NO (la sesión abierta deja de funcionar de inmediato).
 *   Para cambiar una contraseña: escribe la nueva en "ContraseñaNueva".
 *   Registro propio (botón «Crear cuenta»): correos @antioquia.gov.co o de un dominio de la hoja «EmpresasAutorizadas»
 *   → Activo = VERIFICAR hasta confirmar el código que llega al correo (luego SI, automático).
 *   Cualquier otro correo → Activo = PENDIENTE; el administrador escribe SI para aprobar o NO para rechazar.
 *
 * EMPRESAS AUTORIZADAS (hoja «EmpresasAutorizadas»; se crea sola)
 *   Dominio (ej. consorciovial.com) · Empresa · Activo (SI/NO) · Notas. Los correos personales (gmail, hotmail…) nunca se autorizan por dominio.
 *
 * ACCIONES (todas, salvo "login", exigen una sesión válida en el campo "sesion")
 *   POST {accion:"login", usuario, clave}                     → {token de sesión, nombre, expira}
 *   POST {accion:"registro", nombre, correo, entidad, usuario, clave} → institucional: envía código · otros: PENDIENTE
 *   POST {accion:"verificar", usuario, codigo} / {accion:"reenviar", usuario} → confirma el correo institucional
 *   POST {accion:"sesion", sesion}                            → confirma que la sesión sigue activa
 *   POST {accion:"leer",  sesion, base64, mimeType}           → datos del sello (no guarda nada)
 *   POST {accion:"subir", sesion, base64?, ...campos}         → guarda en Drive (si hay foto) + Sheets
 *   POST {accion:"anular", sesion, adminToken, id, motivo}    → marca el registro ANULADO y manda la foto a la papelera
 *   GET  ?accion=listar&admin=ADMIN_TOKEN&formato=json|geojson|csv → registros para ArcGIS
 *   GET  (sin parámetros)                                     → estado del servicio
 */

const HOJA = "Registro_VIPC";
const COLUMNAS = [
  "ID", "FechaRegistro", "FechaVisita", "FechaSello", "LatitudDMS", "LongitudDMS",
  "Latitud", "Longitud", "CodigoVia", "NombreTramo", "Subregion", "Municipio",
  "TipoAfectacion", "Responsable", "Estado", "Observaciones", "Origen",
  "Archivo", "FileId", "URL", "OrigenUbicacion", "SelloLegible", "FueraDeAntioquia",
  "EstadoRegistro", "FechaAnulacion", "MotivoAnulacion", "RegistradoPor"
];
const HOJA_USUARIOS = "Usuarios";
const COLUMNAS_USUARIOS = ["Usuario", "Nombre", "Rol", "Activo", "ContraseñaNueva", "Hash", "Sal", "UltimoIngreso", "Correo", "Entidad", "Empresa", "FechaSolicitud"];
const ENTIDADES = ["Gobernación de Antioquia", "Empresa externa"];
const HOJA_EMPRESAS = "EmpresasAutorizadas";
const COLUMNAS_EMPRESAS = ["Dominio", "Empresa", "Activo", "Notas"];
const DOMINIOS_PERSONALES = ["gmail.com", "hotmail.com", "outlook.com", "live.com", "yahoo.com", "yahoo.es", "icloud.com", "msn.com", "hotmail.es", "outlook.es", "protonmail.com", "aol.com"];
const MINUTOS_CODIGO = 30;       // vigencia del código de verificación enviado al correo
const HORAS_SESION = 8;
const INTENTOS_MAX = 5;          // intentos fallidos antes de bloquear
const MINUTOS_BLOQUEO = 15;
const RESPONSABLES = ["Gobernación", "Rental", "Alcaldía", "Ciudadanía"];
const TIPOS_AFECTACION = ["Derrumbe", "Deslizamiento / movimiento en masa", "Pérdida de banca", "Hundimiento de la vía",
  "Socavación", "Caída de rocas", "Obstrucción de drenaje o alcantarilla", "Daño en puente o pontón",
  "Daño en muro de contención", "Deterioro de la calzada (baches)", "Inundación", "Árbol caído", "Otro"];
const ESTADOS = ["Crítico", "No crítico"];
const ANTIOQUIA = { latMin: 5.40, latMax: 8.90, lonMin: -77.15, lonMax: -73.85 };

/* ======================= Entradas HTTP ======================= */

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!p.accion) return json_({ status: "online", servicio: "VIP-C", version: "4.3.0" });
  try {
    // Exportación (ArcGIS): con la clave de administrador o con una sesión válida
    const admin = prop_("ADMIN_TOKEN", true);
    if (!(admin && p.admin === admin)) validarSesion_(p.sesion);
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
    if (payload.accion === "login") return json_(login_(payload));
    if (payload.accion === "registro") return json_(registro_(payload));
    if (payload.accion === "verificar") return json_(verificar_(payload));
    if (payload.accion === "reenviar") return json_(reenviarCodigo_(payload));
    const usuario = validarSesion_(payload.sesion);
    if (payload.accion === "sesion") return json_({ status: "success", usuario: usuario.usuario, nombre: usuario.nombre, rol: usuario.rol });
    if (payload.accion === "leer") return json_(leerSello_(payload));
    if (payload.accion === "subir") { payload.registradoPor = usuario.usuario; return json_(subirFoto_(payload)); }
    if (payload.accion === "anular") return json_(anularRegistro_(payload));
    throw new Error("Acción no reconocida.");
  } catch (err) {
    return json_({ status: err.sinSesion ? "sin_sesion" : "error", message: err.message || String(err) });
  }
}

/* ======================= Usuarios y sesiones ======================= */

function hojaUsuarios_() {
  const ss = SpreadsheetApp.openById(prop_("SPREADSHEET_ID"));
  let h = ss.getSheetByName(HOJA_USUARIOS);
  if (!h) h = ss.insertSheet(HOJA_USUARIOS);
  if (h.getLastRow() === 0) {
    h.appendRow(COLUMNAS_USUARIOS);
    h.getRange(1, 1, 1, COLUMNAS_USUARIOS.length).setFontWeight("bold");
    h.setFrozenRows(1);
  }
  return h;
}

// Encabezados tolerantes: sin importar mayúsculas, tildes, espacios o la forma de la ñ
function claveEncabezado_(c) {
  return String(c || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");
}
const ALIAS_USUARIOS = {
  usuario: "Usuario", user: "Usuario", nombre: "Nombre", rol: "Rol", activo: "Activo",
  contrasenanueva: "ContraseñaNueva", contrasena: "ContraseñaNueva", clave: "ContraseñaNueva", clavenueva: "ContraseñaNueva", password: "ContraseñaNueva",
  hash: "Hash", sal: "Sal", ultimoingreso: "UltimoIngreso",
  correo: "Correo", email: "Correo", correoelectronico: "Correo", entidad: "Entidad", fechasolicitud: "FechaSolicitud", empresa: "Empresa"
};

function leerUsuarios_() {
  const h = hojaUsuarios_();
  // Encabezados que falten (Hash, Sal, UltimoIngreso...) se agregan al final
  let enc = h.getRange(1, 1, 1, Math.max(h.getLastColumn(), 1)).getValues()[0];
  const tiene = {}; enc.forEach(function (c) { const k = ALIAS_USUARIOS[claveEncabezado_(c)]; if (k) tiene[k] = true; });
  COLUMNAS_USUARIOS.forEach(function (c) {
    if (!tiene[c]) { h.getRange(1, enc.length + 1).setValue(c).setFontWeight("bold"); enc.push(c); tiene[c] = true; }
  });
  const rango = h.getDataRange();
  const datos = rango.getValues();
  const texto = rango.getDisplayValues(); // la contraseña tal como se ve (sin que Sheets la convierta en número o fecha)
  const col = {};
  datos[0].forEach(function (c, i) { const k = ALIAS_USUARIOS[claveEncabezado_(c)]; if (k && col[k] === undefined) col[k] = i; });
  return { h: h, col: col, filas: datos.slice(1).map(function (f, i) { return { fila: i + 2, v: f, t: texto[i + 1] }; }) };
}

function cifrar_(clave, sal) {
  // SHA-256 con sal, 2000 rondas
  let d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, sal + "|" + clave, Utilities.Charset.UTF_8);
  for (let i = 0; i < 2000; i++) d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, d.concat(Utilities.newBlob(sal).getBytes()));
  return "h1$" + Utilities.base64Encode(d); // prefijo: evita que Sheets lo tome como fórmula (+, -, =)
}

// Escribe un texto literal en una celda (sin que Sheets lo interprete como fórmula, fecha o número)
function escribirTexto_(h, fila, col, valor) {
  h.getRange(fila, col).setNumberFormat("@").setValue(String(valor));
}

// Cifra las contraseñas escritas en "ContraseñaNueva" y las borra de la hoja.
function actualizarUsuarios() {
  const u = leerUsuarios_();
  let n = 0;
  u.filas.forEach(function (r) {
    const nueva = String(r.t[u.col["ContraseñaNueva"]] || "").trim();
    if (!nueva) return;
    const sal = Utilities.getUuid();
    escribirTexto_(u.h, r.fila, u.col["Hash"] + 1, cifrar_(nueva, sal));
    escribirTexto_(u.h, r.fila, u.col["Sal"] + 1, sal);
    u.h.getRange(r.fila, u.col["ContraseñaNueva"] + 1).setValue("");
    if (!texto_(r.v[u.col["Activo"]])) u.h.getRange(r.fila, u.col["Activo"] + 1).setValue("SI");
    n++;
  });
  Logger.log(n + " contraseña(s) cifradas.");
  return n;
}

const normUsuario_ = function (s) { return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim(); };

// Busca por usuario o, si no hay coincidencia, por nombre completo
function buscarUsuario_(usuario) {
  const u = leerUsuarios_();
  const k = normUsuario_(usuario);
  if (!k) return null;
  const arma = function (r) {
    return {
      u: u, fila: r.fila, usuario: texto_(r.t[u.col["Usuario"]]), nombre: texto_(r.t[u.col["Nombre"]]),
      rol: texto_(r.t[u.col["Rol"]]) || "usuario", correo: texto_(r.t[u.col["Correo"]]),
      activo: ["SI", "SÍ", "S", "TRUE", "VERDADERO", "1", "X"].indexOf(normUsuario_(r.t[u.col["Activo"]]).toUpperCase()) >= 0,
      estado: normUsuario_(r.t[u.col["Activo"]]).toUpperCase(),
      nueva: String(r.t[u.col["ContraseñaNueva"]] || "").trim(), hash: texto_(r.t[u.col["Hash"]]), sal: texto_(r.t[u.col["Sal"]])
    };
  };
  for (let i = 0; i < u.filas.length; i++) if (normUsuario_(u.filas[i].t[u.col["Usuario"]]) === k) return arma(u.filas[i]);
  for (let i = 0; i < u.filas.length; i++) if (u.col["Correo"] !== undefined && normUsuario_(u.filas[i].t[u.col["Correo"]]) === k) return arma(u.filas[i]);
  for (let i = 0; i < u.filas.length; i++) if (normUsuario_(u.filas[i].t[u.col["Nombre"]]) === k) return arma(u.filas[i]);
  return null;
}

function login_(p) {
  const usuario = texto_(p.usuario), clave = String(p.clave || "").trim();
  if (!usuario || !clave) return { status: "error", message: "Escribe tu usuario y tu contraseña." };

  const cache = CacheService.getScriptCache();
  const kFallos = "fallos_" + normUsuario_(usuario);
  const fallos = Number(cache.get(kFallos) || 0);
  if (fallos >= INTENTOS_MAX) return { status: "error", message: "Demasiados intentos fallidos. Espera " + MINUTOS_BLOQUEO + " minutos e intenta de nuevo." };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let u;
  try {
    u = buscarUsuario_(usuario);
    if (u && u.nueva) { actualizarUsuarios(); u = buscarUsuario_(usuario); } // contraseña recién asignada
  } finally { lock.releaseLock(); }

  const claveOk = u && u.hash && u.sal && cifrar_(clave, u.sal) === u.hash;
  if (!claveOk) {
    cache.put(kFallos, String(fallos + 1), MINUTOS_BLOQUEO * 60);
    return { status: "error", message: "Usuario o contraseña incorrectos." };
  }
  cache.remove(kFallos);
  // La contraseña es correcta: ahora sí se puede decir en qué estado está la cuenta
  if (!u.activo) {
    if (u.estado === "VERIFICAR") return { status: "verificar", usuario: u.usuario, correo: ocultarCorreo_(u.correo), message: "Confirma tu correo con el código que te enviamos." };
    if (u.estado === "PENDIENTE") return { status: "error", message: "Tu solicitud está pendiente de aprobación. Podrás ingresar cuando un administrador la active." };
    return { status: "error", message: "Tu cuenta no está activa. Habla con el administrador." };
  }
  u.u.h.getRange(u.fila, u.u.col["UltimoIngreso"] + 1).setValue(Utilities.formatDate(new Date(), "America/Bogota", "yyyy-MM-dd HH:mm:ss"));
  const expira = Date.now() + HORAS_SESION * 3600 * 1000;
  return { status: "success", sesion: firmarSesion_({ u: u.usuario, exp: expira }), usuario: u.usuario, nombre: u.nombre || u.usuario, rol: u.rol, expira: expira };
}

/* ======================= Registro de usuarios ======================= */
// Correos de la Gobernación o de una empresa autorizada: se activan al confirmar un código enviado al correo.
// Cualquier otro correo (empresa no autorizada, correo personal): queda PENDIENTE hasta que un administrador escriba SI.

function dominioInstitucional_() { return (prop_("DOMINIO_INSTITUCIONAL", true) || "antioquia.gov.co").toLowerCase().replace(/^@/, ""); }
function correoAdmin_() { return prop_("ADMIN_EMAIL", true) || Session.getEffectiveUser().getEmail(); }
function terminaEnDominio_(correo, d) {
  const c = String(correo).toLowerCase(); d = String(d || "").toLowerCase().trim().replace(/^@/, "");
  return !!d && (c.slice(-(d.length + 1)) === "@" + d || c.slice(-(d.length + 1)) === "." + d); // incluye subdominios
}
function esInstitucional_(correo) { return terminaEnDominio_(correo, dominioInstitucional_()); }
function esPersonal_(correo) { return DOMINIOS_PERSONALES.some(function (d) { return terminaEnDominio_(correo, d); }); }

function hojaEmpresas_() {
  const ss = SpreadsheetApp.openById(prop_("SPREADSHEET_ID"));
  let h = ss.getSheetByName(HOJA_EMPRESAS);
  if (!h) h = ss.insertSheet(HOJA_EMPRESAS);
  if (h.getLastRow() === 0) {
    h.appendRow(COLUMNAS_EMPRESAS);
    h.getRange(1, 1, 1, COLUMNAS_EMPRESAS.length).setFontWeight("bold");
    h.setFrozenRows(1);
  }
  return h;
}
// Devuelve el nombre de la empresa si el dominio del correo está autorizado (Activo = SI); si no, ""
function empresaAutorizada_(correo) {
  const datos = hojaEmpresas_().getDataRange().getDisplayValues();
  for (let i = 1; i < datos.length; i++) {
    const dom = texto_(datos[i][0]), emp = texto_(datos[i][1]), act = normUsuario_(datos[i][2]).toUpperCase();
    if (dom && ["SI", "SÍ", "S", "X", "1", "TRUE", "VERDADERO"].indexOf(act) >= 0 && !esPersonal_("x@" + dom.replace(/^@/, "")) && terminaEnDominio_(correo, dom)) return emp || dom;
  }
  return "";
}
// Quién puede activarse solo con el código del correo
function puedeAutoactivarse_(correo) { return esInstitucional_(correo) || !!empresaAutorizada_(correo); }
function ocultarCorreo_(c) { c = String(c || ""); const i = c.indexOf("@"); return i > 1 ? c[0] + "•••" + c.slice(i - 1) : c; }

function registro_(p) {
  const nombre = texto_(p.nombre), correo = texto_(p.correo).toLowerCase(), entidad = texto_(p.entidad), empresa = texto_(p.empresa);
  const usuario = texto_(p.usuario).toLowerCase(), clave = String(p.clave || "");
  const faltan = [];
  if (nombre.length < 5) faltan.push("tu nombre completo");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo)) faltan.push("un correo válido");
  const esGob = esInstitucional_(correo); // con correo institucional no importa lo que marque
  if (!esGob && ENTIDADES.indexOf(entidad) < 0) faltan.push("si eres de la Gobernación o de una empresa externa");
  if (!esGob && entidad === "Empresa externa" && empresa.length < 2) faltan.push("el nombre de tu empresa");
  if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) faltan.push("un usuario de 3 a 30 caracteres (letras, números, punto o guion, sin espacios)");
  if (clave.length < 8 || !/[a-zA-Z]/.test(clave) || !/\d/.test(clave)) faltan.push("una contraseña de al menos 8 caracteres con letras y números");
  if (faltan.length) return { status: "error", message: "Revisa: " + faltan.join("; ") + "." };

  // Freno contra registros masivos: máximo 30 por hora
  const cache = CacheService.getScriptCache();
  const n = Number(cache.get("registros_hora") || 0);
  if (n >= 30) return { status: "error", message: "Hay muchas solicitudes en este momento. Intenta de nuevo en una hora." };

  const institucional = esInstitucional_(correo);
  const empresaOk = !institucional && entidad === "Empresa externa" ? empresaAutorizada_(correo) : "";
  const autoactiva = institucional || !!empresaOk;
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const u = leerUsuarios_();
    const existe = u.filas.some(function (r) {
      return normUsuario_(r.t[u.col["Usuario"]]) === usuario || (correo && normUsuario_(r.t[u.col["Correo"]]) === correo);
    });
    if (existe) return { status: "error", message: "Ese usuario o ese correo ya están registrados. Si es tuyo, ingresa o pide ayuda al administrador." };

    const sal = Utilities.getUuid();
    const fila = u.h.getLastRow() + 1;
    const valores = {
      Usuario: usuario, Nombre: nombre, Rol: "usuario", Activo: autoactiva ? "VERIFICAR" : "PENDIENTE",
      Hash: cifrar_(clave, sal), Sal: sal, Correo: correo, Entidad: institucional ? "Gobernación de Antioquia" : entidad,
      Empresa: institucional ? "" : (empresaOk || empresa),
      FechaSolicitud: Utilities.formatDate(new Date(), "America/Bogota", "yyyy-MM-dd HH:mm:ss")
    };
    Object.keys(valores).forEach(function (k) { if (u.col[k] !== undefined) escribirTexto_(u.h, fila, u.col[k] + 1, valores[k]); });
  } finally { lock.releaseLock(); }
  cache.put("registros_hora", String(n + 1), 3600);

  if (autoactiva) {
    enviarCodigo_(usuario, correo, nombre);
    return { status: "verificar", usuario: usuario, correo: ocultarCorreo_(correo), message: "Te enviamos un código a tu correo." };
  }
  avisarAdmin_(nombre, correo, entidad, usuario, empresa);
  return { status: "pendiente", message: "Solicitud enviada. Un administrador debe aprobarla; podrás ingresar cuando la active." };
}

function enviarCodigo_(usuario, correo, nombre) {
  const codigo = String(Math.floor(100000 + Math.random() * 900000));
  CacheService.getScriptCache().put("verif_" + usuario, JSON.stringify({ c: cifrar_(codigo, usuario), n: 0 }), MINUTOS_CODIGO * 60);
  MailApp.sendEmail({
    to: correo,
    subject: "VIP-C · Código de verificación: " + codigo,
    body: "Hola " + nombre + ",\n\nTu código para activar tu cuenta en VIP-C (Visor interactivo de puntos críticos) es:\n\n    " + codigo +
      "\n\nVence en " + MINUTOS_CODIGO + " minutos. Si no solicitaste esta cuenta, ignora este mensaje.\n\nGobernación de Antioquia · Secretaría de Infraestructura Física"
  });
}

function avisarAdmin_(nombre, correo, entidad, usuario, empresa) {
  let url = "";
  try { url = SpreadsheetApp.openById(prop_("SPREADSHEET_ID")).getUrl(); } catch (_) { /* sin link, el aviso igual sale */ }
  try {
    MailApp.sendEmail({
      to: correoAdmin_(),
      subject: "VIP-C · Nueva solicitud de acceso: " + nombre,
      body: "Hay una nueva solicitud de acceso a VIP-C:\n\n" +
        "Nombre: " + nombre + "\nCorreo: " + correo + "\nDice ser de: " + entidad + (empresa ? " · " + empresa : "") + "\nUsuario: " + usuario +
        (esPersonal_(correo) ? "\n\n⚠ Es un correo PERSONAL (no institucional ni de empresa). Verifica la identidad antes de aprobar." :
          entidad === "Gobernación de Antioquia" ? "\n\n⚠ Dice ser de la Gobernación pero no usa un correo @" + dominioInstitucional_() + "." :
          "\n\nLa empresa no está en la hoja «" + HOJA_EMPRESAS + "». Si la autorizas, agrega su dominio (" + correo.split("@")[1] + ") y sus empleados podrán entrar solos con código.") +
        "\n\nPara aprobar esta solicitud, abre la hoja «Usuarios» y cambia PENDIENTE por SI en la columna Activo. Para rechazarla, escribe NO.\n\n" + url
    });
  } catch (_) { /* si falla el correo, la solicitud igual queda en la hoja */ }
}

function verificar_(p) {
  const usuario = texto_(p.usuario).toLowerCase(), codigo = texto_(p.codigo).replace(/\D/g, "");
  const cache = CacheService.getScriptCache();
  const dato = cache.get("verif_" + usuario);
  if (!dato) return { status: "error", vencido: true, message: "El código venció o no existe. Pide uno nuevo." };
  const d = JSON.parse(dato);
  if (d.n >= 5) return { status: "error", vencido: true, message: "Demasiados intentos con el código. Pide uno nuevo." };
  if (cifrar_(codigo, usuario) !== d.c) {
    d.n++; cache.put("verif_" + usuario, JSON.stringify(d), MINUTOS_CODIGO * 60);
    return { status: "error", message: "Código incorrecto. Revisa el correo e intenta de nuevo." };
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const u = buscarUsuario_(usuario);
    if (!u || u.estado !== "VERIFICAR") return { status: "error", message: "Esta cuenta no está esperando verificación." };
    u.u.h.getRange(u.fila, u.u.col["Activo"] + 1).setValue("SI");
  } finally { lock.releaseLock(); }
  cache.remove("verif_" + usuario);
  return { status: "success", message: "Correo confirmado. Ya puedes ingresar." };
}

function reenviarCodigo_(p) {
  const usuario = texto_(p.usuario).toLowerCase();
  const cache = CacheService.getScriptCache();
  if (cache.get("reenvio_" + usuario)) return { status: "error", message: "Espera un minuto antes de pedir otro código." };
  const u = buscarUsuario_(usuario);
  if (!u || u.estado !== "VERIFICAR" || !u.correo) return { status: "error", message: "Esta cuenta no está esperando verificación." };
  cache.put("reenvio_" + usuario, "1", 60);
  enviarCodigo_(u.usuario, u.correo, u.nombre);
  return { status: "success", correo: ocultarCorreo_(u.correo), message: "Te enviamos un código nuevo." };
}

function secreto_() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty("SESSION_SECRET");
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty("SESSION_SECRET", s); }
  return s;
}

function b64url_(bytesOrText) {
  const b = typeof bytesOrText === "string" ? Utilities.base64EncodeWebSafe(bytesOrText, Utilities.Charset.UTF_8) : Utilities.base64EncodeWebSafe(bytesOrText);
  return b.replace(/=+$/, "");
}

function firmarSesion_(datos) {
  const cuerpo = b64url_(JSON.stringify(datos));
  const firma = b64url_(Utilities.computeHmacSha256Signature(cuerpo, secreto_()));
  return cuerpo + "." + firma;
}

function errorSesion_(msg) { const e = new Error(msg); e.sinSesion = true; return e; }

// Devuelve el usuario de una sesión válida o lanza error "sin_sesion"
function validarSesion_(token) {
  const partes = String(token || "").split(".");
  if (partes.length !== 2) throw errorSesion_("Inicia sesión para continuar.");
  const esperada = b64url_(Utilities.computeHmacSha256Signature(partes[0], secreto_()));
  if (esperada !== partes[1]) throw errorSesion_("Sesión no válida. Inicia sesión de nuevo.");
  let datos;
  try { datos = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(partes[0] + "===".slice((partes[0].length + 3) % 4))).getDataAsString()); }
  catch (_) { throw errorSesion_("Sesión no válida. Inicia sesión de nuevo."); }
  if (!datos.exp || Date.now() > datos.exp) throw errorSesion_("Tu sesión venció. Inicia sesión de nuevo.");
  const u = buscarUsuario_(datos.u);
  if (!u || !u.activo) throw errorSesion_("Tu usuario no está activo. Habla con el administrador.");
  return u;
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
    "codigo_via (código oficial de la vía si aparece, ej 60AN17; si no, \"\"), " +
    "municipio (municipio de Antioquia escrito en el sello, si aparece; si no, \"\"), " +
    "tipo_afectacion (lo que se VE en la foto, exactamente uno de: " + TIPOS_AFECTACION.join(" | ") + "), " +
    "sello_legible (true/false). Las coordenadas pueden venir en grados decimales, ej +6,1694N -75,1630W.";

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
    municipio: String(d.municipio || ""),
    tipoAfectacion: TIPOS_AFECTACION.indexOf(d.tipo_afectacion) >= 0 ? d.tipo_afectacion : "",
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
      "ACTIVO", "", "", texto_(p.registradoPor)
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

/* ======================= Ayudas para el administrador ======================= */
/** Ejecuta en el editor para ver por qué un usuario no puede entrar. Cambia "laura" por el usuario. */
function diagnosticarUsuario() {
  const USUARIO = "laura";
  const u = leerUsuarios_();
  Logger.log("Columnas encontradas: " + JSON.stringify(u.col));
  const r = buscarUsuario_(USUARIO);
  if (!r) { Logger.log("No existe el usuario «" + USUARIO + "». Usuarios en la hoja: " + u.filas.map(function (f) { return "«" + f.t[u.col["Usuario"]] + "»"; }).join(", ")); return; }
  Logger.log("Usuario: «" + r.usuario + "» · Nombre: «" + r.nombre + "» · Activo: " + (r.activo ? "SÍ" : "NO (escribe SI en la columna Activo)"));
  Logger.log("ContraseñaNueva pendiente: " + (r.nueva ? "sí (" + r.nueva.length + " caracteres, se cifra en el próximo ingreso)" : "no"));
  Logger.log("Clave cifrada guardada: " + (r.hash ? (r.hash.indexOf("h1$") === 0 ? "sí" : "sí, pero en formato antiguo o dañado: escribe una ContraseñaNueva") : "no (escribe una ContraseñaNueva)"));
  const bloqueo = CacheService.getScriptCache().get("fallos_" + normUsuario_(USUARIO));
  Logger.log("Intentos fallidos recientes: " + (bloqueo || 0) + (Number(bloqueo) >= INTENTOS_MAX ? " → BLOQUEADO (ejecuta desbloquearUsuario)" : ""));
}

/** Quita el bloqueo por intentos fallidos. Cambia "laura" por el usuario. */
function desbloquearUsuario() {
  const USUARIO = "laura";
  CacheService.getScriptCache().remove("fallos_" + normUsuario_(USUARIO));
  const r = buscarUsuario_(USUARIO);
  if (r) { CacheService.getScriptCache().remove("fallos_" + normUsuario_(r.usuario)); CacheService.getScriptCache().remove("fallos_" + normUsuario_(r.nombre)); }
  Logger.log("Desbloqueado: " + USUARIO);
}

/* ======================= Prueba manual ======================= */
/** Ejecuta esta función desde el editor para verificar la configuración. */
function probarConfiguracion() {
  ["GEMINI_API_KEY", "ROOT_FOLDER_ID", "SPREADSHEET_ID"].forEach(function (k) { prop_(k); });
  DriveApp.getFolderById(prop_("ROOT_FOLDER_ID")).getName();
  hoja_();
  hojaUsuarios_();
  hojaEmpresas_();
  secreto_();
  Logger.log("Configuración correcta. Modelo: " + (prop_("GEMINI_MODEL", true) || "gemini-3.8-flash") +
    ". Ahora agrega usuarios en la hoja «Usuarios» del Sheet.");
}
