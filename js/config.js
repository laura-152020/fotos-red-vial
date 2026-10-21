/**
 * VIP-C — Configuración de la página. Es lo único que hay que editar al desplegar.
 */
const CONFIG = {
  // URL de la implementación de Apps Script (termina en /exec).
  // Vacía: la página lee las fotos en el navegador y permite descargar CSV, pero no guarda en Drive/Sheets.
  // Con URL: aparece el botón «Guardar todos» (Drive + Sheets) y la lectura usa Gemini (más precisa).
  API_URL: "https://script.google.com/macros/s/AKfycbzZ3BzAx1A7Z_W99y5JzwUmN2V6MKmf_rUz_3jL-ecaOcatdlJVCyAYOROAALga19raOw/exec",

  // Debe coincidir con la propiedad APP_TOKEN del Apps Script.
  TOKEN: "",

  // Optimización de imágenes antes de leerlas y enviarlas
  MAX_DIMENSION_PX: 2048,
  JPEG_QUALITY: 0.85,
  MAX_FILE_SIZE_MB: 20
};
