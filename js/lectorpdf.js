/* VIP-C · Lectura de actas de visita técnica en PDF (en el navegador, sin servidor)
 * Extrae el texto con pdf.js y busca: fecha de la visita, código de la vía, nombre de la vía,
 * municipio y cada punto con coordenadas (un registro por punto), con su tipo de afectación y descripción. */
const LectorPDF = (function () {
  "use strict";
  const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
  let carga = null;

  function cargarLib() {
    if (typeof window !== "undefined" && window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (carga) return carga;
    carga = new Promise((ok, mal) => {
      const s = document.createElement("script");
      s.src = PDFJS + "pdf.min.js";
      s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.js"; ok(window.pdfjsLib); };
      s.onerror = () => { carga = null; mal(new Error("No se pudo cargar el lector de PDF. Revisa la conexión a internet.")); };
      document.head.appendChild(s);
    });
    return carga;
  }

  // Abre el PDF y devuelve el texto de cada página
  async function abrir(bytes) {
    const lib = await cargarLib();
    const doc = await lib.getDocument({ data: bytes }).promise;
    const paginas = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      let t = "";
      for (const it of tc.items) { t += it.str; if (it.hasEOL) t += "\n"; }
      paginas.push(t);
    }
    return { doc, paginas };
  }

  // Dibuja una página como imagen JPEG (para la miniatura y la vista ampliada)
  async function dibujarPagina(doc, n, ancho) {
    const pag = await doc.getPage(n);
    const v0 = pag.getViewport({ scale: 1 });
    const vp = pag.getViewport({ scale: ancho / v0.width });
    const cv = document.createElement("canvas");
    cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
    const cx = cv.getContext("2d");
    cx.fillStyle = "#fff"; cx.fillRect(0, 0, cv.width, cv.height);
    await pag.render({ canvasContext: cx, viewport: vp }).promise;
    return cv.toDataURL("image/jpeg", 0.8);
  }

  /* ---------------- Interpretación del texto ---------------- */
  const MESES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
  const iso = (a, m, d) => (a > 1990 && a < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31) ? `${a}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : "";

  // Palabras clave → tipo de afectación (deben coincidir con la lista de app.js)
  const CLAVES = [
    ["Pérdida de banca", /p[eé]rdida\s+(?:parcial\s+|total\s+)?(?:de\s+)?(?:la\s+)?banca|banca\s+perdida/],
    ["Deslizamiento / movimiento en masa", /deslizamiento|movimiento\s+en\s+masa|remoci[oó]n\s+en\s+masa/],
    ["Hundimiento de la vía", /hundimiento|asentamiento\s+de\s+la\s+(?:v[ií]a|banca|calzada)/],
    ["Caída de rocas", /ca[ií]da\s+de\s+rocas|desprendimiento\s+de\s+rocas/],
    ["Daño en puente o pontón", /puente|pont[oó]n/],
    ["Daño en muro de contención", /muro\s+de\s+contenci[oó]n\s+(?:colapsad|fallad|da[nñ]ad)|falla\s+del?\s+muro/],
    ["Socavación", /socavaci[oó]n/],
    ["Obstrucción de drenaje o alcantarilla", /obstrucci[oó]n|alcantarilla|obras?\s+de\s+drenaje|sumidero/],
    ["Deterioro de la calzada (baches)", /baches?|deterioro\s+de\s+la\s+calzada|piel\s+de\s+cocodrilo/],
    ["Inundación", /inundaci[oó]n/],
    ["Árbol caído", /[aá]rbol(?:es)?\s+ca[ií]do/]
  ];
  function tipoDe(texto) {
    const t = String(texto || "").toLowerCase();
    let mejor = "", pos = Infinity, cuenta = 0;
    CLAVES.forEach(([tipo, re]) => {
      const g = new RegExp(re.source, "g"); let m, n = 0, p = Infinity;
      while ((m = g.exec(t))) { n++; if (m.index < p) p = m.index; }
      if (n > cuenta || (n === cuenta && n > 0 && p < pos)) { mejor = tipo; cuenta = n; pos = p; }
    });
    return mejor;
  }

  // Normaliza símbolos de grados, minutos y segundos
  function normalizar(t) {
    return String(t || "")
      .replace(/[º˚]/g, "°").replace(/[′’‘´`]/g, "'").replace(/[″”“]/g, '"').replace(/''/g, '"')
      .replace(/\r/g, "");
  }

  // Busca todas las coordenadas del texto (grados-minutos-segundos o decimales)
  function buscarCoordenadas(t) {
    const S = "\\s*";
    const num = "(\\d{1,3}(?:[.,]\\d+)?)";
    const dms = (h) => `${h ? "([NSWO])" + S : ""}(\\d{1,3})${S}°${S}(?:(\\d{1,2}(?:[.,]\\d+)?)${S}'${S})?(?:(\\d{1,2}(?:[.,]\\d+)?)${S}"?)?${h ? "" : S + "([NSWO])"}`;
    const res = [];
    const sep = "[\\s,;y–\\-]{0,12}";
    const aDec = (g, m, s, h) => {
      let v = Number(g) + Number(String(m || 0).replace(",", ".")) / 60 + Number(String(s || 0).replace(",", ".")) / 3600;
      if (/[SWO]/i.test(h)) v = -v;
      return Math.round(v * 1e6) / 1e6;
    };
    // N 6° 22' 10", W 75° 42' 28"
    let re = new RegExp(dms(true) + sep + dms(true), "gi"), m;
    while ((m = re.exec(t))) {
      const a = [m[1], m[2], m[3], m[4]], b = [m[5], m[6], m[7], m[8]];
      const lat = /[NS]/i.test(a[0]) ? a : b, lon = lat === a ? b : a;
      if (!/[NS]/i.test(lat[0]) || !/[WO]/i.test(lon[0])) continue;
      res.push({ i: m.index, f: m.index + m[0].length, lat: aDec(lat[1], lat[2], lat[3], lat[0]), lon: aDec(lon[1], lon[2], lon[3], lon[0]) });
    }
    // 6° 22' 10" N, 75° 42' 28" W
    re = new RegExp(dms(false) + sep + dms(false), "gi");
    while ((m = re.exec(t))) {
      if (res.some((r) => m.index < r.f && m.index + m[0].length > r.i)) continue;
      const a = [m[4], m[1], m[2], m[3]], b = [m[8], m[5], m[6], m[7]];
      const lat = /[NS]/i.test(a[0]) ? a : b, lon = lat === a ? b : a;
      if (!/[NS]/i.test(lat[0]) || !/[WO]/i.test(lon[0])) continue;
      res.push({ i: m.index, f: m.index + m[0].length, lat: aDec(lat[1], lat[2], lat[3], lat[0]), lon: aDec(lon[1], lon[2], lon[3], lon[0]) });
    }
    // Decimales: 6.369444, -75.707778
    re = new RegExp(`(?<![\\d.])([5-9][.,]\\d{3,})${S}[,;]?${S}(-${S}7[3-7][.,]\\d{3,})`, "g");
    while ((m = re.exec(t))) {
      if (res.some((r) => m.index < r.f && m.index + m[0].length > r.i)) continue;
      res.push({ i: m.index, f: m.index + m[0].length, lat: Number(m[1].replace(",", ".")), lon: Number(m[2].replace(/\s/g, "").replace(",", ".")) });
    }
    void num;
    // Solo Antioquia y alrededores
    return res.filter((r) => r.lat > 4.5 && r.lat < 9.5 && r.lon < -72.5 && r.lon > -78).sort((x, y) => x.i - y.i);
  }

  function buscarFecha(plano) {
    const re = /(\d{1,2})\s*(?:de\s+)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s*(?:de[l]?\s+)?(\d{4})/gi;
    let m, primera = "";
    while ((m = re.exec(plano))) {
      const f = iso(Number(m[3]), MESES[m[2].toLowerCase()], Number(m[1]));
      if (!f) continue;
      const antes = plano.slice(Math.max(0, m.index - 80), m.index).toLowerCase();
      if (/aprobaci/.test(antes)) continue;
      if (/visita|d[ií]a|realiz|inspecci/.test(antes)) return { fecha: f, texto: m[0] };
      if (!primera) primera = { fecha: f, texto: m[0] };
    }
    if (primera) return primera;
    const rn = /(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/g;
    while ((m = rn.exec(plano))) {
      const antes = plano.slice(Math.max(0, m.index - 40), m.index).toLowerCase();
      if (/aprobaci/.test(antes)) continue;
      const f = iso(Number(m[3]), Number(m[2]), Number(m[1]));
      if (f) return { fecha: f, texto: m[0] };
    }
    return { fecha: "", texto: "" };
  }

  function buscarCodigo(plano) {
    const cod = "(\\d{2,5}[A-Z]{1,3}\\d{1,4}(?:-\\d+)?)";
    let m = plano.match(new RegExp("c[oó]digo(?:\\s+de\\s+(?:la\\s+)?v[ií]a)?[^A-Z0-9]{0,40}?" + cod, "i"));
    if (m) return m[1].toUpperCase();
    m = plano.match(new RegExp("(?:^|[^A-Z0-9-])" + cod + "(?![A-Z0-9])"));
    return m ? m[1].toUpperCase() : "";
  }

  function buscarVia(plano) {
    const m = plano.match(/en\s+la\s+v[ií]a\s+(?!de\s|a\s|que\s)(.{4,140}?)(?=\s*,|\s*\.\s|\s+identificad|\s+en\s+atenci|\s+del\s+municipio|\s+solicitad|\s+ubicad)/i);
    if (!m) return "";
    return m[1].replace(/\s+/g, " ").replace(/^["«“]|["»”]$/g, "").trim();
  }

  // Quita encabezados y pies de página repetidos y pies de foto
  function limpiar(t) {
    return String(t || "")
      .split("\n")
      .filter((l) => !/^\s*(P[aá]gina\s+\d+\s+de\s+\d+|ACTA DE VISITA T[EÉ]CNICA|y\/o INFORME T[EÉ]CNICO|SECRETAR[IÍ]A DE INFRAESTRUCTURA F[IÍ]SICA|C[oó]digo:\s*FO-|Versi[oó]n:\s*\d|Fecha de aprobaci[oó]n:?|\d{2}\/\d{2}\/\d{4}\s*$|Registro fotogr[aá]fico:?\s*$)/i.test(l))
      .map((l) => l.replace(/Imagen\s+\d+\s*\.[^\n]*?(?=Imagen\s+\d+|$)/gi, ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }
  function recortar(t, max) {
    if (t.length <= max) return t;
    const c = t.slice(0, max), p = c.lastIndexOf(". ");
    return (p > max * 0.5 ? c.slice(0, p + 1) : c + "…").trim();
  }

  /* paginas: textos por página. Devuelve los datos generales y un punto por cada coordenada distinta. */
  function interpretar(paginas) {
    const offs = []; let texto = "";
    paginas.forEach((p) => { offs.push(texto.length); texto += normalizar(p) + "\n"; });
    const paginaDe = (i) => { let n = 0; offs.forEach((o, k) => { if (i >= o) n = k; }); return n + 1; };
    const plano = texto.replace(/\s+/g, " ");

    const fecha = buscarFecha(plano);
    const general = {
      fecha: fecha.fecha, fechaTexto: fecha.texto,
      codigoVia: buscarCodigo(plano),
      via: buscarVia(plano),
      esGobernacion: /secretar[ií]a de infraestructura f[ií]sica|gobernaci[oó]n de antioquia/i.test(plano),
      tipoGeneral: tipoDe(plano.slice(0, 4000))
    };

    // Fin del cuerpo descriptivo (conclusiones)
    const mFin = texto.search(/\n\s*\d*\.?\s*CONCLUSIONES/i);
    const fin = mFin > 0 ? mFin : texto.length;

    const occ = buscarCoordenadas(texto);
    const puntos = [];
    const mismo = (a, b) => Math.abs(a.lat - b.lat) < 0.00006 && Math.abs(a.lon - b.lon) < 0.00006;
    occ.forEach((o) => { let p = puntos.find((x) => mismo(x, o)); if (!p) { p = { lat: o.lat, lon: o.lon, occ: [] }; puntos.push(p); } p.occ.push(o); });

    puntos.forEach((p, k) => {
      // El tramo detallado es la aparición seguida del texto más largo antes de otra coordenada distinta
      let mejor = null;
      p.occ.forEach((o) => {
        const sig = occ.find((x) => x.i > o.i && !mismo(x, p));
        let hasta = sig ? sig.i : texto.length;
        if (o.i < fin) hasta = Math.min(hasta, fin);
        if (sig) { const ini = texto.lastIndexOf("\n", sig.i); if (ini > o.f) hasta = Math.min(hasta, ini); }
        const linea = texto.slice(texto.lastIndexOf("\n", o.i) + 1, o.i);
        // Prioridad: encabezado tipo «Tramo 1.», luego la descripción más larga
        const titulo = /^\s*(?:tramo|punto|sitio|pk)\s*\d+/i.test(linea) ? 1 : 0;
        const largo = hasta - o.i;
        if (!mejor || titulo > mejor.titulo || (titulo === mejor.titulo && largo > mejor.largo)) mejor = { o, hasta, largo, titulo };
      });
      const iniLinea = texto.lastIndexOf("\n", mejor.o.i) + 1;
      const encabezado = texto.slice(iniLinea, texto.indexOf("\n", mejor.o.f) > 0 ? texto.indexOf("\n", mejor.o.f) : mejor.o.f);
      const tramo = texto.slice(iniLinea, mejor.hasta);
      const mNombre = encabezado.match(/^\s*((?:tramo|punto|sitio|pk)\s*\d+)/i);
      p.nombre = mNombre ? mNombre[1].replace(/\s+/g, " ").replace(/^./, (c) => c.toUpperCase()) : "Punto " + (k + 1);
      p.tipo = tipoDe(encabezado) || tipoDe(tramo) || general.tipoGeneral;
      p.descripcion = recortar(limpiar(tramo), 1500);
      p.pagina = paginaDe(mejor.o.i);
      p.latitudDMS = texto.slice(mejor.o.i, mejor.o.f);
      delete p.occ;
    });

    const r = Object.assign(general, { puntos, texto: plano });
    r.resumen = resumir(r);
    return r;
  }


  /* Resumen de todo el acta (sin servidor): motivo de la visita, lo encontrado y medido en cada tramo
     y las recomendaciones. Con el servidor conectado, Gemini lo reemplaza por uno redactado. */
  function frases(t) { return String(t || "").replace(/\s+/g, " ").split(/(?<=[.;])\s+(?=[A-ZÁÉÍÓÚÑ])/).map((x) => x.trim()).filter(Boolean); }
  const corta = (t, n) => (t.length > n ? t.slice(0, n).replace(/\s+\S*$/, "") + "…" : t);
  function resumir(d) {
    const partes = [];
    const motivo = frases(d.texto).find((f) => /se\s+realiz[oó]\s+(?:una\s+)?visita|tuvo\s+como\s+objeto/i.test(f));
    if (motivo) {
      let m = motivo.slice(motivo.search(/se\s+realiz[oó]|la\s+visita\s+tuvo/i));
      const fin = m.search(/\.\s/); if (fin > 40) m = m.slice(0, fin + 1);
      partes.push(corta(m, 380));
    }
    const recs = [];
    (d.puntos || []).forEach((p) => {
      const fs = frases(p.descripcion).filter((f) => !/^(tramo|punto|sitio|pk)\s*\d+\s*[.:]/i.test(f) || /se\s+(evidenci|identific|observ)/i.test(f));
      const hallazgo = fs.find((f) => /se\s+(evidenci|identific|observ)/i.test(f));
      const medida = fs.find((f) => /se\s+estima|longitud|ancho\s+efectivo|altura/i.test(f) && f !== hallazgo);
      const rec = fs.find((f) => /se\s+recomienda|se\s+requiere/i.test(f));
      const txt = [hallazgo && corta(hallazgo.replace(/^.*?(se\s+(evidenci|identific|observ))/i, (m, a) => a.charAt(0).toUpperCase() + a.slice(1)), 260), medida && corta(medida, 200)].filter(Boolean).join(" ");
      if (txt) partes.push(p.nombre + ": " + txt);
      const recT = rec ? rec.slice(Math.max(0, rec.search(/se\s+recomienda|se\s+requiere/i))).replace(/\s*Se recomienda\s+([A-ZÁÉÍÓÚ])/, (m, c) => "Se recomiendan " + c.toLowerCase()) : "";
      if (recT && !recs.some((r) => r.slice(0, 40) === recT.slice(0, 40))) recs.push(p.nombre + ": " + corta(recT, 240));
    });
    if (recs.length) partes.push("Recomendaciones: " + recs.join(" "));
    return partes.join("\n").slice(0, 2000);
  }

  return { cargarLib, abrir, dibujarPagina, interpretar, tipoDe, resumir };
})();
if (typeof module !== "undefined") module.exports = LectorPDF;
