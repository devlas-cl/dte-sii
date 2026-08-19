# Respaldo de archivos MIPYME — descarga de DTE completos desde el portal

> Investigado el 18/08/2026 contra el portal real, con dos certificados distintos y captura HTTP.
> Estado: **implementado y probado contra el SII** en `SiiPortalAuth.descargarRespaldoMipyme()`
> (dte-sii 2.16.0).

## 1. Qué resuelve

Permite descargar el **XML firmado completo** de los DTE emitidos y recibidos de una empresa,
directamente del portal del SII, sin depender de que el emisor lo mande a la casilla de
intercambio.

Es distinto de todo lo que ya teníamos:

| vía | qué entrega | limitación |
|---|---|---|
| `obtenerDetalleDtes()` (`consemitidosinternetui`) | metadatos de DTE individuales | sin XML; no ve boletas ni vales |
| `obtenerResumenRegistro()` (`consdcvinternetui`) | totales mensuales por tipo | solo totales, sin detalle |
| Casilla de intercambio | XML completo | solo si el emisor lo envía |
| **Respaldo MIPYME (este)** | **XML completo firmado** | **máx. 20 documentos por descarga** |

## 1bis. 🔴 Existe SOLO en producción: no hay ambiente de certificación

Medido el 19/08/2026 sobre `/cgi-bin/Portal001/lista_documentos.cgi`:

| host | respuesta |
|---|---|
| `www1.sii.cl` | **200** — el que se usa |
| `maullin.sii.cl` | 302 → `custom_pages/Error404.html` |
| `www4c.sii.cl` | 404 |

Para contrastar, una ruta real de maullin (`/cvc_cgi/dte/of_solicita_folios_dcto`) redirige al
login de certificación, no a un 404. O sea que el Respaldo MIPYME **no tiene gemelo de
certificación**: es solo producción, por diseño del SII.

⚠️ **Consecuencia para cualquier consumidor.** Con el resto del sistema apuntando a maullin,
este método **igual lee documentos reales del contribuyente**. Es de solo lectura contra el SII,
pero escribe facturas reales en la base del entorno que lo llame. Un entorno de desarrollo
necesita una puerta explícita; no alcanza con mirar la variable de ambiente del DTE, porque esta
función no tiene ambientes.

## 2. ✅ Solo requiere certificado digital, NO certificación

Verificado: la sesión de `SiiPortalAuth` —la misma que ya usamos para el RCV— entra sin
problema. `resolverContextoSiiPortal` en la API tampoco exige `certificacion_completada`, solo
`sii_pfx_bytes` + `sii_pfx_pass`.

Implicancia de producto: un comercio que sube su certificado pero **todavía no certifica** ya
podría usar esto. Certificarse es requisito para *emitir*, no para *consultar*.

## 3. ✅ No hay captcha activo

El formulario incluye el campo pero **va vacío**:

```
recaptcha-response=&ORIGEN=RCP&...
```

Y el JS lo trata como opcional:

```js
function new_win_down(TpoDownLoad) {
  if (typeof llamaRecaptchaConCallback == 'function') {
    llamaRecaptchaConCallback('key_download', llamaDownload);
  } else
    llamaDownload()
}
// ...
var token = document.getElementById("recaptcha-response");
if (token && token.value.length>0) { urldata += "&recaptcha-response="+token.value; }
```

⚠️ El SII **puede encenderlo cuando quiera**, sin avisar. Cualquier implementación tiene que
detectar la respuesta de captcha y degradar con un mensaje claro, no reintentar en loop.

## 4. El contrato exacto

### Paso 1 — Listar (POST)

```
POST https://www1.sii.cl/cgi-bin/Portal001/lista_documentos.cgi
Content-Type: application/x-www-form-urlencoded
Origin:  https://www1.sii.cl
Referer: https://www1.sii.cl/cgi-bin/Portal001/lista_documentos.cgi

recaptcha-response=            (vacío)
ORIGEN=ENV                     ENV = emitidos | RCP = recibidos
TPO_DOC=                       vacío = todos
FEC_DESDE=2026-01-01
FEC_HASTA=2026-08-18
FOLIO=&FOLIOHASTA=&RUT_RECP=&RZN_SOC=&ESTADO=&ORDEN=
NUM_PAG=1                      paginación
RUT_EMP=77111222&DV_EMP=K
TPO_ARCHIVO=dte                dte | iecv
```

⚠️ **Es POST.** Con GET el SII devuelve siempre `<title>Error al contribuyente</title>` con un
código genérico, sin pistas. Se perdió tiempo ahí.

⚠️ **`ORIGEN=ENV`, no `EMI`.** Los valores salen del `<select>` real:

```html
<select id="sel_origen" name="ORIGEN">
  <option value="ENV">Emitidos</option>
  <option value="RCP">Recibidos</option>
</select>
```

Respuesta: HTML, `<title>RESPALDO DE ARCHIVOS MIPYME</title>`, con el total parseable como
`Número total de documentos : N`.

### Paso 2 — Descargar (GET)

```
GET https://www1.sii.cl/cgi-bin/Portal001/download.cgi
    ?RUT_EMP=77111222&DV_EMP=K
    &ORIGEN=ENV
    &RUT_RECP=&FOLIO=&FOLIOHASTA=&RZN_SOC=
    &FEC_DESDE=2026-01-01&FEC_HASTA=2026-08-18
    &TPO_DOC=&ESTADO=&ORDEN=
    &DOWNLOAD=XML
Referer: https://www1.sii.cl/cgi-bin/Portal001/lista_documentos.cgi
```

⚠️ El paso 1 **es obligatorio antes** del 2: establece el contexto en la sesión. Llamar a
`download.cgi` directo devuelve la página de error.

Respuesta: `<?xml ... encoding="ISO-8859-1"?><SetDTE>` con un `<DTE>` por documento.

## 5. Resultado medido

Con el certificado de EMPRESA EJEMPLO SPA (77111222-3), rango 2026-01-01 a 2026-08-18:

```
LISTADO  status 200 | total documentos: 8
DESCARGA status 200 | 51.077 bytes | xml: SI | documentos: 8
```

## 6. Qué trae cada documento

**Todo.** No es un resumen: es el DTE firmado, idéntico al que genera el emisor.

- `Encabezado` completo: emisor con giro, Acteco, sucursal y dirección; receptor completo
- `Totales`: neto, exento, tasa IVA, IVA, total
- `Detalle` **línea por línea**: `NmbItem`, `DscItem`, `QtyItem`, `UnmdItem`, `PrcItem`,
  `MontoItem`
- **`CdgItem`** con `TpoCodigo`/`VlrCodigo` cuando el emisor lo informa — el código de producto
  del proveedor
- `Referencia` en las notas de crédito, apuntando al documento que corrigen
- `TED` completo con su `CAF` y `FRMT`, más la `Signature` XML-DSig

Ejemplo real de un recibido:

```xml
<Detalle>
  <NroLinDet>1</NroLinDet>
  <CdgItem><TpoCodigo>INT1</TpoCodigo><VlrCodigo>SISG0003</VlrCodigo></CdgItem>
  <NmbItem>Servicio color pantone Adicional</NmbItem>
  <QtyItem>50.0</QtyItem><PrcItem>420.15</PrcItem><MontoItem>21008</MontoItem>
</Detalle>
```

El `CdgItem` es lo más valioso: permite calzar productos al importar en vez de adivinar por
nombre.

## 7. El tope de 20: medido, y es del servidor

Texto literal del portal:

> *"seleccionar, de entre los documentos tributarios electrónicos emitidos o recibidos, un
> **máximo de 20 documentos** para respaldarlos en su computador."*

El botón se oculta por JS cuando se excede (`$("#btn_respaldar").hide()`), pero **el corte NO es
solo cosmético**. Medido contra el portal con EMPRESA EJEMPLO SPA (76543210-K), recibidos:

| documentos en el rango | `download.cgi` |
|---|---|
| 5 | XML con 5 |
| 17 | XML con 17 |
| **20** | **XML con 20** |
| **21** | **página de error** |
| 23, 24, 28, 36, 44 | página de error |

⚠️ **El umbral exacto es 20/21.** Y el modo de falla es traicionero: con 21 no devuelve un XML
recortado sino `<title>Error al contribuyente</title>`. Quien no valide que la respuesta empieza
con `<?xml` va a interpretar una página HTML como "sin documentos".

### El listado devuelve metadata completa, aunque el rango exceda 20

Medido el 18/08/2026. **El tope de 20 es solo para descargar, no para listar.** El listado
responde igual y trae:

- `<div id="cant_reg" value="389">` — el **total real** del rango, parseable sin ambigüedad
  (más confiable que el texto "Número total de documentos : N").
- Las filas **server-side en el HTML**, 10 por página, sin ajax ni JS de por medio:

```html
<td>76888999</td><td>K</td><td>PROVEEDOR EJEMPLO SPA</td><td>33</td>
<td>22371</td><td>2024-12-31</td><td>84014</td><td>DTE Recibido Sin Reparos</td>
```

Columnas: RUT emisor, DV, razón social, tipo DTE, folio, **fecha (`YYYY-MM-DD`)**, monto, estado.

⚠️ La fecha va en **`YYYY-MM-DD`**, no `DD-MM-YYYY`. Buscar el formato chileno no encuentra nada
y hace creer que las filas no están en el HTML.

- Paginación por `NUM_PAG`, GET plano al mismo `lista_documentos.cgi`.

**Llevado al límite:** un rango de 7 años devolvió `cant_reg: 1474` en **148 páginas**, con la
respuesta pesando 21 KB. El portal no se ahoga con rangos grandes.

### Filtros: `TPO_DOC` sirve, `FOLIO`/`FOLIOHASTA` son una trampa

| filtro | resultado sobre el mismo rango (389 docs) |
|---|---|
| sin filtro | 389 |
| `TPO_DOC=33` | **355** ✅ filtra de verdad |
| `FOLIO=1&FOLIOHASTA=20000` | **541** 🔴 *más* que sin filtro |

🔴 **`FOLIO`/`FOLIOHASTA` borran silenciosamente `FEC_HASTA`.** En la respuesta el campo del
formulario vuelve vacío y las filas pasan a mostrar fechas de 2026 sobre una consulta de 2024. No
es un resultado más grande de la misma consulta: **es otra consulta**. Quien use el filtro de
folios para cortar por debajo de 20 se lleva un conjunto de documentos distinto del que pidió.

`TPO_DOC` en cambio es seguro y da un **eje de corte adicional** al de fechas.

### La solución: trocear por fechas

El rango se parte por la mitad hasta que cada tramo quepa. Validado bajando los 44 documentos
completos de WB:

```
total del rango: 44
tramos: 2026-01-01..2026-04-25 (16)   2026-04-26..2026-06-22 (8)   2026-06-23..2026-08-18 (20)
descargados: 44
```

⚠️ Caso límite: **un solo día con más de 20 documentos**. No se puede partir más por fecha y el
SII no ofrece paginar la descarga, así que el método lanza un error explícito en vez de bajar de
menos en silencio.

✅ **Pero sí tiene salida, medida el 18/08/2026: cortar por `TPO_DOC`.** Cada tipo de DTE es una
consulta aparte y la unión cubre el día completo. Solo hay que recorrer los tipos que aparezcan
en el listado de ese día (que el propio listado informa, ver arriba). **No usar `FOLIO`/
`FOLIOHASTA` para esto**: borran `FEC_HASTA` y devuelven otro conjunto.

## 7bis. 🔴 El portal responde por `alert()` de JavaScript, no por HTML

**Este es el hallazgo que más tiempo cuesta si no se sabe, y el que hizo fallar el primer
diagnóstico de esta misma investigación.**

Cuando el portal viejo rechaza algo, la respuesta HTTP es **200** y trae:

```html
<html><head><title>Seleccionar empresa</title></head>
<body><script language="JavaScript">
  alert('No existe información en MIPYME para el rut ingresado');
  history.back();
</script></body></html>
```

El motivo real está **dentro del `<script>`**. El `<title>` dice otra cosa completamente
distinta, y el HTML visible está vacío.

⚠️ Dos formas garantizadas de perder el mensaje, ambas cometidas acá:

1. **Clasificar por `<title>`.** Lleva a leer "Seleccionar empresa" y concluir que hay un
   selector de empresas. No lo hay.
2. **Limpiar el HTML con `.replace(/<script[\s\S]*?<\/script>/gi, '')` antes de leerlo.** Es el
   reflejo normal para extraer texto de una página, y acá borra exactamente lo único que
   importaba.

Con esos dos errores se afirmaron **tres causas equivocadas seguidas** (certificado
multi-empresa, empresa no adherida al sistema gratuito, titular no autorizado) sobre una página
que decía la respuesta en la primera línea. El portal nunca fue ambiguo; la lectura sí.

### ⚠️ Y el error inverso: hay un `alert` COMENTADO en la página normal

La página de resultados válida trae esto dentro del template:

```js
div.innerHTML += '. El numero maximo de documentos para respaldar es 20...';
//alert("Maximo numero de docmentos para respaldar: 20. Reduzca la cantidad usando el filtro.");
```

Está **comentado**. Un extractor ingenuo de `alert(...)` lo toma por bueno y convierte un
listado perfectamente válido en un error inventado — pasó al medir Comercio C y Comercio B, y llevó
a descartar por error una conclusión que estaba bien.

`extraerAlertasPortal()` descarta los alerts que vengan comentados en su línea. Y el orden de
lectura protege el resto: **si la página trae el total, se usa el total y no se miran los
alerts**.

### Cómo se lee ahora

`extraerAlertasPortal(html)` saca el texto de todos los `alert(...)`, y
`errorDeRespuestaPortal()` lo convierte en un error que **propaga el texto del SII tal cual** en
`err.mensajePortal` y en `err.message`. El orden importa: primero se busca el total de
documentos (si está, la respuesta es buena), y solo si falta se investiga el motivo.

| código | cuándo | reintentable |
|---|---|---|
| `RESPALDO_SIN_DATOS` | el alert dice "No existe información…" — ese RUT no tiene datos en MIPYME | no |
| `RESPALDO_CAPTCHA` | el SII encendió el captcha | no |
| `RESPALDO_RECHAZADO` | hay alert pero con un texto que no conocemos; se reporta **literal** | no |
| `RESPALDO_SIN_EMPRESA` | página de ingreso **sin ningún alert**; causa no determinada | no |

⚠️ Regla para la UI: **mostrar `err.mensajePortal` cuando exista**. Es lo que el SII realmente
dijo. Cualquier traducción propia corre el riesgo de repetir el error de arriba.

### Medición sobre producción (18/08/2026, 6 certificados)

| resultado | n | lectura |
|---|---|---|
| OK | 3 | Devlas, Comercio B, Comercio C |
| `RESPALDO_SIN_DATOS` | 1 | Comercio D: el RUT no tiene información en MIPYME |
| `EPROTO` | 2 | certificado vencido y certificado no habilitado — **no miden elegibilidad**: fallan en el handshake TLS mutuo, antes de cualquier HTTP |

O sea: de los 4 certificados utilizables, **4 obtienen una respuesta válida del portal**. Uno de
ellos simplemente no tiene documentos que respaldar, que no es lo mismo que estar bloqueado.

### Qué sí incluye cuando la empresa califica

Para los **recibidos**, documentos de cualquier emisor, no solo del sistema gratuito. En una
prueba con 44 documentos aparecieron IDs `MiPE...`, `DTE_MP_33_...` (Mercado Pago) y `F5869T33`
(otro sistema). La restricción es sobre **quién consulta**, no sobre quién emitió.

## 8. Cómo se usa

```js
const { total, tramos } = await auth.descargarRespaldoMipyme('76543210', '6', {
  origen: 'RCP',            // 'ENV' emitidos | 'RCP' recibidos
  desde:  '2026-01-01',
  hasta:  '2026-08-18',
  tipoDoc: '',              // vacío = todos
  reintentos: 3,
});
// tramos: [{ desde, hasta, total, xml }, ...] — un XML por tramo
```

Lo que resuelve solo:

- **Trocea** el rango hasta que cada tramo quepa en 20.
- **Reintenta** con espera progresiva (1s, 2s, 4s): el portal es lento e intermitente.
- **No reintenta** ante captcha ni selección de empresa: no se arreglan solos.
- Valida que la respuesta sea XML de verdad antes de darla por buena.

Errores con código propio:

| código | qué pasó |
|---|---|
| `RESPALDO_CAPTCHA` | el SII encendió el captcha; no se puede automatizar mientras esté activo |
| `RESPALDO_SIN_DATOS` | el RUT no tiene información en MIPYME (nada que respaldar) |
| `RESPALDO_RECHAZADO` | el portal rechazó con un mensaje que no conocemos; llega literal en `err.mensajePortal` |
| `RESPALDO_SIN_EMPRESA` | página de ingreso sin ningún `alert`; causa no determinada (ver §7bis) |

Todos traen `err.mensajePortal` con el texto exacto del SII cuando el portal dijo algo. **Mostrar
ese texto, no una traducción propia** (§7bis).

⚠️ El XML viene en **ISO-8859-1**: leerlo con `latin1`, no con utf8, o los acentos se rompen.

## 9. Qué habilitaría

Hoy el import de facturas de proveedor depende del XML de la casilla de intercambio
(`compras.ts:304` → `parseItemsEnvioDTE(dte.xml_raw)`). Si el proveedor no lo manda, la factura
aparece listada pero **no se puede importar** (`tiene_xml: false`).

Con esta vía el XML se baja del portal cuando uno quiera, y el import pasaría de "funciona si
el proveedor colabora" a funcionar siempre.
