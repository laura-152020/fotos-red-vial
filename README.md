# VIP-C · Visor interactivo de puntos críticos

Gobernación de Antioquia. Página web para celular y computador que registra los puntos críticos de la red vial de dos formas:

1. **Carga manual de datos**, cuando no hay evidencias fotográficas. Se puede usar la ubicación actual del celular.
2. **Carga fotográfica y relleno automático**: se sube la foto y se leen de su sello la fecha, las coordenadas y la vía.

En los dos casos, el municipio se deduce de las coordenadas y la subregión del municipio.

```
Página (GitHub Pages)
  ├─ Lectura del sello en el navegador (OCR, sin servidor)      ← siempre disponible
  ├─ Descargar CSV                                               ← siempre disponible
  └─ Apps Script (opcional) ──▶ Gemini (lectura más precisa)
                             ├─▶ Google Drive  (Raíz / Subregión / Municipio / foto.jpg)
                             └─▶ Google Sheets (hoja Registro_VIPC, una fila por punto) ──▶ ArcGIS (CSV / GeoJSON)
```

## Estructura

```
index.html                       Página
css/style.css                    Estilos
img/logo-gobernacion-antioquia.png   Logo con fondo transparente
js/config.js                     ÚNICO archivo a editar al desplegar (URL y clave del Apps Script)
js/app.js                        Formulario, lista de registros, guardado y CSV
js/ocr.js                        Lectura del sello (fecha, coordenadas, tramo, código de vía)
js/municipios.js                 125 municipios con subregión y límites (DANE, MGN 2018)
backend/Code.gs                  Apps Script (un solo archivo)
backend/appsscript.json          Manifiesto del Apps Script
```

## Campos

| Campo | Cómo se llena |
|---|---|
| Fecha de la visita * | Del sello de la foto. Si no hay, del GPS interno o a mano |
| Latitud / Longitud | Del sello, del GPS de la foto, de «Usar mi ubicación actual» o a mano (acepta `6°10'42"N` o `6.178333`) |
| Código oficial de la vía | A mano (se lee del sello si aparece, ej. `60AN17`) |
| Nombre del tramo | Del sello («Vía Granada - Guatapé» → `Granada - Guatapé`) o a mano, ej. `Medellín - Turbo` |
| Subregión | Automática a partir del municipio |
| Municipio * | Automático a partir de las coordenadas, o se elige de la lista |
| Tipo de afectación * | Lista desplegable |
| Responsable de la visita * | Gobernación · Rental · Alcaldía · Ciudadanía |
| Estado * | Crítico · No crítico |
| Observaciones | Texto libre (sin relleno automático) |

\* Obligatorio. Además se exige el **código de la vía o el nombre del tramo**, al menos uno de los dos.

Las listas (tipos de afectación, responsables y estados) están al inicio de `js/app.js`. Si cambias responsables o estados, cámbialos también al inicio de `backend/Code.gs`.

## Sin backend (como queda al subirla)

- Lee las fotos en el navegador. La primera vez descarga el lector, unos 5 MB, y desde ahí cada foto tarda 1 o 2 segundos.
- El botón **Descargar CSV** baja todos los registros. El CSV se carga en ArcGIS Online o se abre en Excel.
- Las fotos **no se guardan** en ningún lado: el CSV solo trae el nombre del archivo. Para guardar fotos y tener una base compartida, conecta el Apps Script.

## Conectar el backend (Drive + Sheets)

### 1. Clave de Gemini
Entra a https://aistudio.google.com/apikey y crea una API key. La clave solo se guarda en el Apps Script, nunca en la página.

### 2. Drive y Sheets
1. Crea una carpeta en Drive y copia su ID: es lo que va después de `/folders/` en la URL.
2. Crea un Google Sheet vacío y copia su ID: es lo que va entre `/d/` y `/edit` en la URL.

La hoja `Registro_VIPC` se crea sola.

### 3. Apps Script
1. En https://script.google.com, crea un **Proyecto nuevo** y pega `backend/Code.gs`.
2. En **Configuración del proyecto**, activa «Mostrar el archivo de manifiesto» y pega `backend/appsscript.json`.
3. En **Propiedades del script**, agrega:

   | Propiedad | Valor |
   |---|---|
   | `GEMINI_API_KEY` | la clave del paso 1 |
   | `ROOT_FOLDER_ID` | ID de la carpeta |
   | `SPREADSHEET_ID` | ID del Sheet |
   | `APP_TOKEN` | una clave inventada, ej. `vipc-2026` |
   | `ADMIN_TOKEN` | otra clave, para anular registros |
   | `GEMINI_MODEL` | opcional; por defecto `gemini-3.8-flash` |

4. Ejecuta `probarConfiguracion` y acepta los permisos.
5. Ve a **Implementar → Nueva implementación → Aplicación web**, con «Ejecutar como: Yo» y acceso para «Cualquier usuario». Copia la URL `/exec`.

### 4. Página
En `js/config.js`, pon la URL `/exec` en `API_URL` y la clave de `APP_TOKEN` en `TOKEN`. Haz commit.

Aparece el botón **Guardar todos**, y la lectura pasa a usar Gemini. Si Gemini falla, la página usa automáticamente el lector del navegador.

> ¿Ya tenías la versión anterior conectada? Esta versión escribe en una hoja nueva, `Registro_VIPC`, con las columnas nuevas. La hoja anterior queda intacta. Después de pegar el nuevo `Code.gs`, haz **Implementar → Gestionar implementaciones → Editar → Versión nueva**.

## Llevar los datos a ArcGIS
- **Sin backend:** usa el CSV de **Descargar CSV**. En ArcGIS Online: **Contenido → Nuevo elemento**, arrastra el CSV, ubicación por **Coordenadas** (`Latitud`, `Longitud`).
- **Con backend:** usa `URL_EXEC?accion=listar&formato=csv&token=TU_TOKEN`, o `formato=geojson`.

## Notas
- Los límites municipales vienen del Marco Geoestadístico Nacional 2018 del DANE, simplificados. Cerca de un límite el municipio sugerido puede ser el vecino; siempre se puede corregir a mano.
- La lectura del sello está ajustada a Antioquia: latitud 5° a 9° N y longitud 73° a 77° W. Si un sello no se lee completo, la tarjeta queda en **Revisar** y dice qué falta.
- Anular un registro guardado (con backend): `POST {accion:"anular", token, adminToken, id, motivo}`. La fila queda como `ANULADO` y la foto va a la papelera de Drive.
