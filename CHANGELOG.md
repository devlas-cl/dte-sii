# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Versionado [SemVer](https://semver.org/lang/es/).

## [2.13.1] - 2026-08-12

Depurando por qué un cliente real (RUT 79555666-7) no obtenía folios en palena aparecieron
tres fallas encadenadas en la detección de rechazos del SII. El síntoma era siempre el mismo
y no decía nada: `UNKNOWN: No se obtuvo CAF en la respuesta`.

### Corregido

#### Los detectores de rechazo no podían funcionar con el HTML real

Los patrones se evaluaban sobre el HTML **crudo**, pero el SII manda **entidades**:
`no est&aacute; autorizado`. El regex esperaba `no está autorizado` y su `.` cubre un
carácter, no los ocho de `&aacute;`.

`esNoAutorizadoIngresarOpcion()` **nunca pudo matchear** un rechazo real, pese a estar
escrita para este caso exacto (su comentario dice "Verificado 2026-07-24 contra
79555666-7"). Se había escrito contra texto ya decodificado.

Todos los detectores evalúan ahora el **texto visible** —sin markup, sin entidades, sin
saltos de línea— vía `CafSolicitor.textoVisible()`. Robusto a las tres cosas de una vez.

#### El chequeo no se aplicaba donde ocurre el rechazo

El SII rechaza en **cualquier** paso del flujo multi-paso, no solo en el último. Este caso
llegó en el paso 2 (`of_solicita_folios_dcto`), donde solo se miraba `esBloqueoTimbraje`:
el flujo siguió de largo y terminó en el genérico.

Ahora hay un único `esRechazoDuro()` con todos los patrones, aplicado en **los cuatro
pasos**. Agregar un patrón nuevo ya no obliga a acordarse de replicarlo en cada punto.

#### `UNKNOWN` dejó de ser opaco

Cuando ningún patrón reconoce la página, el error **incluye lo que dijo el SII** en vez de
`No se obtuvo CAF en la respuesta` a secas. Sin esto hay que reproducir el fallo con el
debug encendido, que es justo lo que no se puede hacer cuando el problema es de un cliente
en producción.

### Agregado

#### `esEmpresaNoAutorizada()` — "la empresa no está autorizada para operar en esta modalidad"

Distinto de `esUsuarioSinPermiso`: ahí el sujeto es el **usuario** del certificado, acá es
la **empresa**. El SII lo devuelve en palena cuando el contribuyente todavía no fue
autorizado como emisor electrónico, y entonces el portal no deja ni enrolar usuarios ni
pedir folios.

Detectarlo importa porque el flujo de enrolamiento seguía de largo con páginas vacías
—sin formulario ni hidden `key`— hasta reventar con un **500** en `eu_graba_usuario`. El
500 era el síntoma; esta frase, presente ya en el primer paso, la causa.

---

## [2.13.0] - 2026-08-12

Depuración de una certificación real de punta a punta (RUT 77111222-3, maullin). Casi todo
lo que sigue salió de fallas observadas contra el SII, no de revisión de escritorio.

### Agregado

#### `utils/httpDebug.js` — captura de todas las llamadas HTTP al SII *(nuevo)*

Nace de un problema concreto: durante una certificación hubo **cinco minutos de pantalla
congelada** sin forma de saber qué pasaba. La causa era `consultarAvance()`, que dispara
cuatro requests secuenciales, ninguno de los cuales dejaba rastro. De las 26 llamadas de
`SiiCertificacion` solo 5 se guardaban, y de las 14 de `SiiPortalAuth`, ninguna.

```js
const { registrarHttpDebug, fetchRegistrado } = require('@devlas/dte-sii/utils/httpDebug');
```

- **Apagado por defecto.** Solo actúa si el consumidor define `SII_HTTP_DEBUG_DIR`. Sin esa
  variable el costo es una comparación por request y nada más — verificado ejecutando
  `getSemilla()` contra maullin con y sin la variable: con ella escribe el `.html` y el
  `index.jsonl`; sin ella, **cero archivos**.
- **Redacta secretos**, que antes se escribían en claro: `set-cookie` / `cookie` /
  `authorization` (la sesión del SII dura ~90 min y quedaba usable en disco) y `<RSASK>`,
  la llave privada RSA que el SII entrega dentro del CAF.
- **Salida:** `NNN-METODO-recurso-STATUS.html` por llamada (el contador da el orden
  cronológico) más un `index.jsonl` con una línea por request, para revisar una corrida
  entera con `jq`/`grep` sin abrir cada archivo.
- **El cuerpo enviado va a un archivo aparte** (`-request.txt`) cuando supera los 2000
  caracteres. Antes se recortaba dentro de un comentario HTML, largo que en un `multipart`
  no alcanza ni para pasar el boundary — justo el caso del `DTEUpload`, donde el XML
  enviado es lo que explica un rechazo.
- Tope de 512 KB por archivo.

Cobertura tras enganchar los clientes HTTP (son independientes entre sí, no hay capa común):

| Archivo | Llamadas | Qué cubre |
|---|---|---|
| `SiiSession.js` | todas | `SiiCertificacion`, `CertRunner`, `CafSolicitor`, `FolioService`, `SetsProvider` |
| `SiiPortalAuth.js` | 14 | Flujo "Verificar en SII" |
| `EnviadorSII.js` | 6 | Semilla, token, `DTEUpload`, `QueryEstUp` |
| `cert/CertRunner.js` | 7 | Portales GWT de certificación |
| `cert/BoletaCert.js` | 2 | Portal de certificación de boleta |
| `WsReclamo.js` | 3 | Semilla, token, `_llamar` |

> `EnviadorSII` era el hueco grave: es la clase que **sube el DTE al SII**, y no tenía
> ningún hook. Una corrida completa de boleta dejaba 13 llamadas capturadas, ninguna del
> envío real. Cuando el SII rechazaba, no quedaba registro ni del XML enviado ni de la
> respuesta con el motivo.

#### `utils/paths.js` — resolución de rutas *(nuevo)*

Centraliza las rutas de trabajo de la librería. Corrige 9 defaults que estaban adivinados
en distintos archivos y hacían que el consumidor no pudiera decidir dónde se escribe.

#### `sanitizeTedText()` en `utils/sanitize.js`

Ver *Corregido → TED con acentos*. `sanitizeSiiText` queda **sin cambios**.

#### `SiiPortalAuth.obtenerEmisor()`

Movido a la librería desde el proyecto consumidor (antes `getEmisorFromPortal.js`), donde
no correspondía: la librería es la que sabe hablar con el portal.

#### `FolioService.consultarTope()`

Consulta el tope de folios autorizados sin solicitar ninguno. Permite decidir *antes* si
hace falta anular folios, en vez de anular a ciegas.

#### `CafSolicitor`: modo `soloConsultarTope`

Sondeo sin efectos secundarios.

#### `CertRunner`: opción `stateDir`

Deja que el consumidor elija dónde se persiste el estado de la corrida, en vez de un
directorio fijo dentro de la librería.

### Corregido

#### TED con acentos: el SII los leía mal

El lector de PDF417 del SII **pierde los bytes ≥ 128**. Un `<IT1>` con `Cajón` llegaba como
`Cajnn`, y el timbre no validaba. Se verificó que `bwip-js` codifica bien: el problema es
del lector del SII, así que la única salida es no ponerle esos bytes.

`DTE.js` ahora pasa `RznSocRecep` y `NmbItem` por `sanitizeTedText()` **antes de firmar el
TED** (NFD → quita diacríticos → ligaduras → red de seguridad ASCII).

> **El cuerpo del DTE conserva las tildes.** Solo se normaliza lo que entra al timbre.
> Verificado: `<NmbItem>Cajón de Piñón Ñandú Café</NmbItem>` en el XML, `Cajon de Pinon
> Nandu Cafe` dentro del `<TED>`, y **0 bytes no-ASCII** en el timbre.

El SII aceptó los tipos 33, 34, 46, 52, 56 y 61 con TED normalizado.

#### Fecha equivocada cuando el proceso corre en UTC

`CertRunner._getFechaHoy()` usaba la hora del proceso. Con el contenedor en UTC, entre las
~20:00 y medianoche de Chile generaba la fecha del **día siguiente**: un envío registrado
el 11 se declaraba como del 12 y el SII respondía *"FECHA NO CORRESPONDE AL ENVIO"*,
dejando el flujo en un poll infinito.

> Es responsabilidad del consumidor definir `TZ=America/Santiago`. Está documentado en el
> README. Ojo al verificar: `date` dentro de un contenedor sin `tzdata` **miente**; hay que
> comprobarlo con `node -e "console.log(new Date().toString())"`.

#### Mensajes de error del SII que se perdían

- Tres filtros de error GWT demasiado estrechos tapaban el mensaje real del SII. Ahora hay
  un único `_mensajeErrorGwt()` compartido.
- `SiiCertificacion.declararAvance()` distingue errores **definitivos** de "aún no", y
  marca `datoInconsistente` cuando el SII dice que lo declarado no coincide con lo
  registrado. Sin esa distinción, un error definitivo se reintentaba para siempre.

#### Anulación innecesaria de folios

Antes se anulaban folios "por las dudas" antes de timbrar. Ahora se consulta el tope
(`consultarTope()`) y solo se anula si de verdad no alcanzan, con un margen de 3×. Anular
sin necesidad es tiempo perdido y ensucia la numeración.

`FolioService` además registra los rechazos definitivos (`ya-anulado`, `recepcionado`) en
ambos caminos, para no reintentar algo que nunca va a cambiar.

#### `EnviadorSII`: relectura del estado tras enviar

Se relee el estado después del submit en vez de asumir el resultado del POST.

### Cambiado

- `EnviadorSII` usa `fetchRegistrado()` para semilla, token y consulta de estado. El helper
  lee el cuerpo **una sola vez** y lo devuelve junto a la respuesta: el `body` de un
  `Response` se consume una vez, y si el debug lo leyera por su cuenta el llamador se
  quedaría sin cuerpo.
- `fetchRegistrado` sale **antes de tocar la respuesta** cuando el debug está apagado. Estas
  llamadas están en el camino de emisión real: recorrer los headers para después
  descartarlos era trabajo y superficie de fallo en producción a cambio de nada.
- `WsReclamo` usa el mismo helper en sus tres llamadas.

### Sin cambios (para quien audite el impacto en emisión)

`EnvioDTE`, `EnvioBOLETA`, `CAF`, `Certificado`, `BoletaService`, `ConsumoFolio`, `Signer`.
Toda la maquinaria de armado de sobres, firma y folios quedó igual.

Verificación del camino de venta con esta versión:

- **Generación y firma**: DTE tipo 39 con tildes y ñ → TED con 0 bytes no-ASCII, `<FRMT>`
  presente, cuerpo con acentos intactos.
- **Envío**: `DTEUpload` respondió `STATUS 0` en una certificación de boleta real.
- **WsReclamo**: semilla, token y `_llamar` responden SOAP válido contra maullin.
