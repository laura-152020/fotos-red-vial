/**
 * Configuración de la página. Es lo único que hay que editar al desplegar.
 */
const CONFIG = {
  // URL de la implementación de Apps Script (termina en /exec).
  // Si se deja vacía, la página funciona en MODO DEMO con datos simulados.
  API_URL: "",

  // Debe coincidir con la propiedad APP_TOKEN del Apps Script.
  TOKEN: "",

  // Optimización de imágenes antes de enviarlas
  MAX_DIMENSION_PX: 2048,
  JPEG_QUALITY: 0.85,
  MAX_FILE_SIZE_MB: 20,

  // Fotos leídas en paralelo (Gemini gratuito limita solicitudes por minuto)
  LECTURAS_SIMULTANEAS: 2,

  // Centro inicial del mapa (Antioquia)
  MAPA_CENTRO: [6.55, -75.55],
  MAPA_ZOOM: 8
};
