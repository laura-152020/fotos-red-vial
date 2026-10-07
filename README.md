# Fotos Red Vial Antioquia — v2

Página web (celular y computador) para cargar fotos de inspección vial. Lee el sello de cada foto (fecha, coordenadas y vía), guarda la foto en Google Drive, registra los datos en Google Sheets y muestra los puntos en un mapa.

```
Página (GitHub Pages) ──POST──▶ Apps Script ──▶ Gemini (lee el sello)
                                    │
                                    ├──▶ Google Drive  (Raíz / Contrato_X / Via_Y / foto.jpg)
                                    └──▶ Google Sheets (una fila por foto)
                                           │
                                           └──▶ Mapa de la página  ·  ArcGIS (CSV / GeoJSON)
```

## Estructura

```
backend/Code.gs           Apps Script completo (un solo archivo)
backend/appsscript.json   Manifiesto con permisos y zona horaria
web/index.html            Página
web/css/style.css         Estilos
web/js/config.js          ÚNICO archivo a editar al desplegar (URL y clave)
web/js/app.js             Lógica: carga, lectura del sello, guardado y mapa
```

Si `API_URL` en `config.js` está vacío, la página corre en **modo demo**: las lecturas son simuladas y no guarda nada. Sirve para mostrarla antes de conectar el backend.

## Instalación (una sola vez, unos 20 minutos)

### 1. Clave de Gemini
1. Entra a https://aistudio.google.com/apikey con la cuenta de Google del proyecto.
2. Crea una API key y guárdala. Se usa solo dentro del Apps Script; nunca va en la página.

### 2. Drive y Sheets
1. Crea una carpeta en Drive para las fotos. Copia su ID: es la parte de la URL después de `/folders/`.
2. Crea un Google Sheet vacío. Copia su ID: es la parte de la URL entre `/d/` y `/edit`.
   La hoja `Registro_Fotografico` y sus encabezados se crean solos.

### 3. Apps Script
1. Ve a https://script.google.com y crea un **Proyecto nuevo**.
2. Borra el contenido de `Código.gs` y pega todo `backend/Code.gs`.
3. En **Configuración del proyecto**, activa «Mostrar el archivo de manifiesto appsscript.json». Luego reemplaza su contenido con `backend/appsscript.json`.
4. En **Configuración del proyecto → Propiedades del script**, agrega:

   | Propiedad | Valor |
   |---|---|
   | `GEMINI_API_KEY` | la clave del paso 1 |
   | `ROOT_FOLDER_ID` | ID de la carpeta |
   | `SPREADSHEET_ID` | ID del Sheet |
   | `APP_TOKEN` | una clave inventada, ej. `antioquia-vias-2026` |
   | `GEMINI_MODEL` | opcional; por defecto `gemini-3.8-flash` |

5. En el editor, selecciona la función `probarConfiguracion` y dale **Ejecutar**. Acepta los permisos. Si el registro dice «Configuración correcta», sigue.
6. Ve a **Implementar → Nueva implementación → Aplicación web**:
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **Cualquier usuario**
7. Copia la URL que termina en `/exec`.

> Cada vez que cambies `Code.gs`: **Implementar → Gestionar implementaciones → Editar → Versión nueva**. Así la URL no cambia.

### 4. Página
1. En `web/js/config.js`, pon la URL `/exec` en `API_URL` y la misma clave de `APP_TOKEN` en `TOKEN`.
2. Sube el contenido de la carpeta `web/` al repositorio de GitHub. `index.html` debe quedar en la raíz.
3. En el repositorio, ve a **Settings → Pages → Deploy from branch → main / (root)**.

## Uso
1. Llena **Datos comunes** (contrato es obligatorio).
2. Selecciona las fotos. Cada una se lee en segundos y muestra **Listo** o **Revisar**.
3. Corrige lo que haga falta y toca **Guardar todas**.
4. La pestaña **Mapa** muestra todas las fotos guardadas, con miniatura y enlace a Drive.

Orden de prioridad para la ubicación: **sello de la foto → GPS interno (EXIF) → manual**. Las fotos reenviadas por WhatsApp no traen GPS interno, por eso se lee el sello.

## Llevar los datos a ArcGIS

**Opción A — CSV (la más simple)**
1. Abre en el navegador: `URL_EXEC?accion=listar&formato=csv&token=TU_TOKEN`. Se descarga el CSV.
2. En ArcGIS Online, ve a **Contenido → Nuevo elemento**, arrastra el CSV y elige **Crear capa de entidades alojada**. Ubicación: **Coordenadas** (`Latitud`, `Longitud`).
3. Para registros nuevos, usa **Actualizar datos → Agregar o reemplazar** en la misma capa.

**Opción B — GeoJSON**
- `URL_EXEC?accion=listar&formato=geojson&token=TU_TOKEN` devuelve los puntos en GeoJSON.
- Se puede cargar en ArcGIS Pro o QGIS. Las fotos se ven desde el campo `URL` (enlace a Drive).

## Seguridad y límites
- La clave `APP_TOKEN` está visible en `config.js`. Evita envíos de bots y accesos casuales, pero no reemplaza un login. Si se filtra, cámbiala en las dos partes.
- La API key de Gemini **no** está en la página; vive solo en las Propiedades del script.
- La capa gratuita de Gemini limita solicitudes por minuto. Por eso la página lee 2 fotos a la vez (`LECTURAS_SIMULTANEAS` en `config.js`).
- Apps Script tiene cuotas diarias de ejecución. Para una secretaría alcanzan de sobra; si se carga en lotes de cientos de fotos, hazlo por partes.
- Las fotos quedan compartidas «cualquiera con el enlace puede ver», para que el mapa muestre miniaturas. Si la organización lo bloquea, el mapa muestra los datos sin miniatura.
