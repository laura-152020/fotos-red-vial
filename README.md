# VIP-C · Visor interactivo de puntos críticos

Gobernación de Antioquia. Página web para celular y computador que registra los puntos críticos de la red vial de dos formas:

1. **Carga manual de datos**, cuando no hay evidencias fotográficas. Se puede usar la ubicación actual del celular.
2. **Carga fotográfica y relleno automático**: se sube la foto y se leen de su sello la fecha, las coordenadas y la vía.

En los dos casos, el municipio se deduce de las coordenadas y la subregión del municipio.

```
Página (GitHub Pages)
  ├─ Lectura del sello en el navegador (OCR, sin servidor)      ← siempre disponible
  ├─ Guardar datos en el navegador del dispositivo               ← sin servidor
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
js/app.js                        Formulario, lista de registros y guardado
js/ocr.js                        Lectura del sello (fecha, coordenadas, tramo, código de vía)
js/municipios.js                 125 municipios con subregión y límites (DANE, MGN 2018)
backend/Code.gs                  Apps Script (un solo archivo)
backend/appsscript.json          Manifiesto del Apps Script
```

## Campos

| Campo | Cómo se llena |
|---|---|
| Fecha de la visita * | Del sello de la foto. Si no hay, del GPS interno o a mano |
| Latitud / Longitud | Del sello (`6°10'42"N 75°9'57"W` o `+6,1694N -75,1630W`), del GPS de la foto, de «Usar mi ubicación actual» o a mano |
| Código oficial de la vía | A mano (se lee del sello si aparece, ej. `60AN17`) |
| Nombre del tramo | Del sello («Vía Granada - Guatapé» → `Granada - Guatapé`; si no dice «Vía», la última línea, ej. `Grada el peñol`) o a mano |
| Subregión | Automática a partir del municipio |
| Municipio * | Automático: por coordenadas; si la foto no trae coordenadas, por el nombre escrito en el sello (ej. «Grada el peñol» → El Peñol) |
| Tipo de afectación * | Lista desplegable. Con el backend conectado, Gemini lo sugiere mirando la foto |
| Responsable de la visita * | Gobernación · Rental · Alcaldía · Ciudadanía |
| Estado * | Crítico · No crítico |
| Observaciones | Texto libre (sin relleno automático) |

\* Obligatorio. Además se exige el **código de la vía o el nombre del tramo**, al menos uno de los dos.

Las listas (tipos de afectación, responsables y estados) están al inicio de `js/app.js`. Si cambias responsables o estados, cámbialos también al inicio de `backend/Code.gs`.

## Acceso con usuario y contraseña

La página abre con una pantalla de **Ingreso**. Solo entran las personas registradas en la hoja **Usuarios** del Google Sheet. **Sin el Apps Script conectado nadie puede entrar**: la pantalla dice que el acceso no está configurado.

**Dar de alta a una persona** (en la hoja `Usuarios`, que se crea sola):

| Usuario | Nombre | Rol | Activo | ContraseñaNueva | Hash | Sal | UltimoIngreso |
|---|---|---|---|---|---|---|---|
| `jperez` | Juan Pérez | usuario | SI | `Clave-Segura-2026` | *(automático)* | *(automático)* | *(automático)* |

- Escribe la contraseña en **ContraseñaNueva**. En el primer ingreso se cifra y **se borra de la hoja**, así que nadie la vuelve a ver. Para cifrarla de inmediato, ejecuta `actualizarUsuarios` en el editor del Apps Script.
- **Dar de baja:** pon `NO` en **Activo**. Si esa persona tenía la sesión abierta, pierde el acceso en su siguiente acción.
- **Cambiar contraseña** (o si alguien la olvidó): escribe una nueva en **ContraseñaNueva**.
- La sesión dura **8 horas**. Después de **5 intentos fallidos**, el usuario queda bloqueado 15 minutos.
- Cada registro guardado queda con el usuario que lo cargó (columna `RegistradoPor`).
- **Cerrar todas las sesiones de una vez:** borra la propiedad `SESSION_SECRET` del Apps Script; se crea otra sola.

**Registro propio (botón «Crear cuenta»):** cada persona crea su usuario y contraseña y confirma su correo con un código. **El administrador no interviene:**

| Correo | Resultado |
|---|---|
| `@antioquia.gov.co` | Código al correo → entra. |
| Empresa ya autorizada y vigente | Código al correo → entra. |
| Empresa nueva | La persona escribe el correo de **su supervisor en la Gobernación**. Tras confirmar su código, al supervisor le llega un correo donde elige con un clic **a quién** (solo esa persona o toda la empresa) y **por cuánto tiempo** (1 día, 30 días o 12 meses), o **Rechazar**. La persona recibe un correo con la respuesta y la fecha de vencimiento. |
| Correo personal (gmail, hotmail, outlook…) | **Rechazado** siempre. |

- «Solo esta persona» guarda su fecha en la columna **Vence** de `Usuarios`; al vencer, al supervisor le llegan botones para renovar (1 día, 30 días, 12 meses).
- «Toda la empresa» agrega su dominio a la hoja `EmpresasAutorizadas` con la fecha **Vence** elegida y **AutorizadaPor**; sus demás empleados entran solos con código, y las solicitudes pendientes de esa empresa quedan aprobadas.
- Al vencer, sus usuarios no pueden entrar y al supervisor le llega un botón **Renovar** (máximo un correo al día por empresa).
- Los botones del correo funcionan 7 días y están firmados: no se pueden falsificar ni reutilizar para otra persona.
- La hoja `EmpresasAutorizadas` se llena sola; solo la tocas si quieres corregir algo (por ejemplo, `NO` en Activo corta el acceso de una empresa al instante).
- **Duración de la autorización de una empresa:** propiedad `DURACION_EMPRESA` (`12 meses` por defecto; acepta `90 dias`, `1 hora`, `30 minutos`). Con minutos u horas, el vencimiento es a la hora exacta. Usa tiempos cortos solo para probar.
- **Código en cada ingreso (verificación en dos pasos):** activado por defecto. Al ingresar con usuario y contraseña llega un código de 6 dígitos al correo (vence en 10 minutos). Las cuentas creadas a mano sin correo entran solo con contraseña. Para desactivarlo: propiedad `CODIGO_EN_CADA_INGRESO = NO`.
- **Modo prueba:** propiedad `MODO_PRUEBA = SI` permite probar con un solo Gmail: `tucorreo+gob@gmail.com` = Gobernación; `tucorreo+empnorte1@gmail.com` = empleado de la empresa «empnorte». Bórrala al terminar.
- Propiedad recomendada: `WEBAPP_URL` = la URL `/exec` del Apps Script (asegura que los botones del correo apunten bien).
- Cuota de Google: una cuenta Gmail gratuita envía hasta ~100 correos al día (cada registro usa 1–3). Con Google Workspace el límite es mucho mayor.

**Qué protege y qué no:** los datos, el guardado y la lectura con Gemini exigen sesión válida, y eso lo controla el servidor. El diseño de la página (HTML y JS) sigue siendo público en GitHub Pages, aunque sin sesión no muestra el formulario ni permite usarlo.

La lectura de fotos en el navegador tarda 1 o 2 segundos por foto. La primera vez descarga el lector, unos 5 MB.

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
   | `ADMIN_TOKEN` | una clave larga inventada: para anular registros y exportar a ArcGIS |
   | `APP_TOKEN` | opcional (el acceso ya lo controlan los usuarios) |
   | `GEMINI_MODEL` | opcional; por defecto `gemini-3.8-flash` |

4. Ejecuta `probarConfiguracion` y acepta los permisos. Esto crea las hojas `Registro_VIPC` y `Usuarios`.
5. En la hoja `Usuarios`, da de alta al menos tu propio usuario (ver «Acceso con usuario y contraseña»).
6. Ve a **Implementar → Nueva implementación → Aplicación web**, con «Ejecutar como: Yo» y acceso para «Cualquier usuario». Copia la URL `/exec`.

### 4. Página
En `js/config.js`, pon la URL `/exec` en `API_URL` (y en `TOKEN` la clave de `APP_TOKEN`, solo si la configuraste). Haz commit.

Desde ese momento la página pide usuario y contraseña. **Guardar datos** guarda en Drive y Sheets, y la lectura usa Gemini; si Gemini falla, se usa el lector del navegador.

> ¿Ya tenías la versión anterior conectada? Esta versión escribe en una hoja nueva, `Registro_VIPC`, con las columnas nuevas. La hoja anterior queda intacta. Después de pegar el nuevo `Code.gs`, haz **Implementar → Gestionar implementaciones → Editar → Versión nueva**.

## Llevar los datos a ArcGIS
- Usa `URL_EXEC?accion=listar&formato=csv&admin=TU_ADMIN_TOKEN`, o `formato=geojson`. Comparte ese enlace solo con quien administre ArcGIS: da acceso a todos los datos.

## Notas
- Los límites municipales vienen del Marco Geoestadístico Nacional 2018 del DANE, simplificados. Cerca de un límite el municipio sugerido puede ser el vecino; siempre se puede corregir a mano.
- La lectura del sello está ajustada a Antioquia: latitud 5° a 9° N y longitud 73° a 77° W. Si un sello no se lee completo, la tarjeta queda en **Revisar** y dice qué falta.
- Anular un registro guardado (con backend): `POST {accion:"anular", sesion, adminToken, id, motivo}`. La fila queda como `ANULADO` y la foto va a la papelera de Drive.
