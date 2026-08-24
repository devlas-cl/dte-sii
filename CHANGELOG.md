# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Versionado [SemVer](https://semver.org/lang/es/).

## [2.18.1] - 2026-08-24

### Corregido (🔴 el timbre PDF417 salía con la firma inválida)

`bwip-js` 4.11.2 corrompía un byte al codificar el TED en modo binario: se le entregaba `0xCD`
(la `Í` de una razón social) en el offset 214 y el código de barras quedaba con `0x41`, la letra
`A`. Una diferencia en 752 bytes.

Ese byte cae dentro del bloque `<CAF>`, que va firmado por el SII, así que el timbre quedaba con
la firma rota y el SII rechazaba la revisión de muestras impresas completa:

```
Error en CAF: Ha habido alguna alteracion en el CAF entregado por el SII
Error Tecnico:  TED - Firma invalida
```

Verificado criptográficamente, sin el SII de por medio: se decodificó el PDF417 del PDF que
efectivamente se subió y se validó su `<FRMT>` con la llave pública que viene en el propio CAF
(`<RSAPK>`).

| | RS en el DD | Firma FRMT |
|---|---|---|
| barcode con 4.11.2 | `DAAZ QUERO Y COMPAÑÍA` | **inválida** |
| TED del XML firmado | `DÍAZ QUERO Y COMPAÑÍA` | válida |
| barcode con 4.11.4 | `DÍAZ QUERO Y COMPAÑÍA` | **válida** |

Dos lecturas independientes coincidieron en el byte corrupto: zxing sobre el PNG extraído del
PDF, y el propio SII en `leeImpresoDetById`.

⚠️ **Nunca había aparecido porque el byte que se corrompe es una vocal acentuada, y en el timbre
eso solo puede venir del `<RS>` del CAF** — la razón social tal como la emitió el SII, que no se
puede sanitizar porque va firmada. Los contribuyentes anteriores no tenían acentos ahí.

## [2.18.0] - 2026-08-24

### Corregido (🔴 regresión de 2.17.0: la reobtención reusaba folios ya emitidos)

En 2.17.0 el gate de reobtención pasó de "solo con el timbraje bloqueado" a "siempre que haya
folios disponibles", con el argumento de que pedir gasta cupo y reobtener no. **Eso rompió la
invariante más básica: un folio no se reutiliza nunca.**

El listado de reobtención del portal marca los rangos **anulados** y nada más: un folio que ya
viajó al SII dentro de un envío aparece como reobtenible. Medido el 24/08/2026 en una corrida
real: la etapa descartó los CAF de disco por tener folios ya emitidos y, tres líneas después, la
reobtención trajo esos mismos folios del portal. El SII rechazó los 7 documentos del tipo con
`(DTE-3-101) Folio para este Tipo de documento ya fue recibido en el SII`. Como daño colateral,
las notas de débito que referenciaban esos folios volvieron con reparo `(REF-2-780) Anulación
presenta diff. de monto con doc. referenciado`, porque el SII las comparó contra el documento
que él ya tenía con ese folio.

Dos arreglos, porque uno solo no alcanza:

- **`reobtenerCaf({ yaEmitido })`** — el llamador pasa el mismo registro con el que descarta los
  CAF de disco, y los rangos ya emitidos se descartan también acá. El SII no publica ese dato,
  así que la librería no puede saberlo sola.

- **Vuelve a exigirse que el cupo NO alcance** para reobtener: timbraje bloqueado, o `MAX_AUTOR`
  por debajo de lo necesario. Con cupo holgado se piden folios nuevos, que es la vía sin riesgo.
  Hace falta además del filtro porque el registro local puede estar incompleto: en esa misma
  corrida, de los rangos reobtenidos dos estaban registrados como emitidos y uno no, y el SII
  también lo tenía.

### Agregado (diagnóstico)

- **Cuando el portal responde "ENVIO CON ERRORES O REPAROS", ahora se le pregunta al SII por
  qué.** El portal de certificación solo da el titular: nombra el set y dice que tiene errores,
  sin un dato del documento culpable. El detalle vive en la consulta de estado del envío
  (`QueryEstUp.jws`), que se hace con el TrackId — y ese TrackId ya lo teníamos desde que se
  subió el set.

  Hasta acá nadie preguntaba. Caso real (24/08/2026): una corrida quedó trabada con dos sets
  marcados, y en las **105 respuestas HTTP** de la etapa los TrackIds de esos sets aparecían
  solo en el `DTEUpload` que los creó y en el formulario que los declaró. Ni el consumidor ni
  el contribuyente tenían forma de saber qué corregir.

  Ahora se imprime tipo de documento, folio, estado y la glosa del SII, más los contadores del
  envío, y la respuesta cruda queda en `{debugDir}/{prefijo}-estado-{set}-{trackId}.xml`.

  ⚠️ La consulta va por **SOAP**, no por el REST de `consultarEstado()`: ese apunta al servicio
  de **boletas** (`apicert.sii.cl/recursos/v1/boleta.electronica.envio/`), y pasarle el TrackId
  de un set de facturas devuelve un resultado que no corresponde.

  Se consultan **todos** los envíos declarados, no solo los marcados: el contraste es la mitad
  del diagnóstico. Si el que falló dice `RPR` y los demás `EPR`, el problema es de ese
  documento; si todos vuelven `RCT` o `RFR`, es de la carátula o de la firma y el portal solo
  alcanzó a marcar los que ya procesó.

  Es diagnóstico puro: corre cuando algo ya falló, así que un error suyo nunca tapa el error
  que se estaba investigando.

## [2.17.0] - 2026-08-19

### Agregado

- **`FolioService.solicitarCafPorTandas()`** — cubre N folios en varios timbrajes cuando el SII
  no autoriza tantos de una vez, y devuelve la lista de CAF.

- **`FolioService.listarCafs(tipoDte)`** — todos los CAF de un tipo en disco, no solo el último
  (`findLatestCaf` pasa a ser un envoltorio de este).

### Corregido (racionamiento de folios del SII)

El formulario de timbraje publica dos números y hasta ahora se usaba solo uno. `MAX_AUTOR` es
cuánto autoriza el SII por solicitud; **`FOLIOS_DISP` es cuántos folios timbrados y sin utilizar
tiene la empresa**, textual: *"considerando el timbraje histórico de documentos y de los
documentos emitidos y/o anulados, la empresa posee folios disponibles o sin utilizar, por un
total de N"*.

Ese segundo número es la precondición de las dos operaciones de rescate, porque las dos trabajan
sobre ese mismo conjunto: anular solo acepta folios "que no han sido recepcionados por el SII", y
reobtener devuelve el CAF de folios ya autorizados para poder emitirlos.

- **Con `FOLIOS_DISP = 0` ya no se intenta anular ni reobtener.** No hay nada que anular ni que
  recuperar, pero se intentaba igual porque los candidatos no salen de ahí: salen del listado de
  **timbrajes** (`af_anular2`), que lista los rangos autorizados sin decir si se usaron.

  Medido el 19/08/2026: una corrida con `MAX_AUTOR=3` para un plan de 4 gastó **43 de sus 70
  requests** intentando anular folios ya emitidos, uno por uno, para terminar en `0 anulados`.

  ⚠️ El chequeo es `=== 0` estricto. Con el timbraje **bloqueado** el SII no publica el campo y
  queda `null`, y ese caso sí necesita intentarlo: es lo único que puede destrabarlo.

- **La reobtención se dispara con `FOLIOS_DISP > 0`, no solo con el timbraje bloqueado.** Con cupo
  corto sin bloqueo se saltaba derecho a pedir folios nuevos teniendo folios ya autorizados a mano.
  Pedir gasta cupo; reobtener no.

- **`Simulacion` acepta varios CAF por tipo.** Los sets ya lo hacían (`SetBase._tomarFolio`); la
  simulación recibía un objeto CAF por tipo y leía su rango directo, y era el único punto que
  impedía cubrir un plan con folios timbrados en tandas. Cada folio se timbra con la llave del CAF
  que lo contiene, no con la del primero de la lista.

- **El reuso de CAF previos suma rangos parciales.** Antes miraba solo el más reciente y devolvía
  "no alcanza" si por sí solo no cubría la cantidad, así que un timbraje repartido en 3+1 se
  descartaba entero y se pedían folios nuevos, dejando los anteriores sin usar (que es justo lo que
  el SII cuenta en contra del cupo). Ahora junta rangos distintos, deduplica las dos copias en
  disco del mismo CAF, y toma solo los que hagan falta.

- **Lo timbrado en un intento fallido se aprovecha en el siguiente.** Cuando el SII racionaba y
  quedaban folios en disco que no cubrían el plan, el reintento pedía el total otra vez: los
  anteriores se desperdiciaban Y subían `FOLIOS_DISP`, que es lo que aprieta el tope. Ahora cuentan
  como cubiertos y al SII se le pide solo la diferencia, así que cada intento acumula en vez de
  gastar. Los parciales van primero en la lista, que además es lo que baja `FOLIOS_DISP` más rápido.

- **El mensaje de error distingue las dos causas.** Con `FOLIOS_DISP > 0` el remedio es emitir o
  anular; con `0` no hay nada que hacer localmente. Antes las dos salían con el mismo texto, y en
  el segundo caso decía *"el SII tiene bloqueado el timbraje"* mientras el SII estaba autorizando
  folios.

## [2.16.0] - 2026-08-18

### Agregado (robustez)

- **`autenticar()` reintenta ante fallas de red/TLS** (3 intentos, espera 1s/2s/4s).

  ⚠️ Medido contra el SII: devuelve **`EPROTO` de forma intermitente** al abrir la conexión TLS
  con certificado (`rsa_pss ... last octet invalid`), y reintentando con el **mismo** certificado
  funciona. **No es señal de certificado vencido ni no habilitado**, aunque lo parezca: sin
  reintento, un error transitorio se lee como "el certificado del cliente está roto".

  🔴 El **límite de sesiones del SII no se reintenta** — ahora se marca con
  `err.code = 'SII_LIMITE_SESIONES'`. Cada intento empeora ese bloqueo.

- **`descargarRespaldoMipyme(..., { onTramo })`** — modo streaming. Se invoca por cada tramo
  descargado y el XML **no** se acumula en el resultado.

  Necesario para históricos grandes: sin esto todos los XML quedan en memoria hasta el final,
  ~6,4 KB por documento (unos 7 MB para 1.100 documentos, y crece lineal).

  ```js
  await auth.descargarRespaldoMipyme(rut, dv, {
    origen: 'RCP', desde, hasta,
    onTramo: async (t) => { await guardar(t.xml); },   // se persiste y se suelta
  });
  ```

- **Los tramos se entregan del MÁS RECIENTE al más viejo.** El troceo por bisección los dejaba
  en orden cronológico, así que el consumidor recibía primero lo más antiguo del rango y tenía
  que esperar todas las descargas para ver lo último — justo lo que el usuario está mirando.

  Verificado contra el portal con un mes de 52 documentos: 3 tramos (19, 19, 14), ninguno
  excede el tope, los 52 llegan completos, y el primero es el de la quincena más reciente.

### Cambiado

- **El cache de sesión del portal pasa a ser un mapa por `certHash`.** Antes guardaba **una
  sola sesión** y comparaba el hash: en un servidor multi-tenant cada certificado pisaba al
  anterior, así que todos re-autenticaban en cada pasada. Un login contra `zeusr.sii.cl` es un
  handshake con certificado, caro y contado por el SII, que bloquea por *"máximo de sesiones
  autenticadas"*. El costo crecía lineal con la base de clientes.

  Verificado contra producción con dos certificados reales: ambas sesiones conviven y ambas se
  reutilizan, sin logins nuevos.

  - **El formato v1 se migra, no se descarta**: al desplegar esta versión la sesión vigente
    sobrevive en vez de forzar un re-login.
  - **Poda automática**: se descartan las expiradas y, si aún se pasa de 200 entradas, las más
    viejas. El archivo no crece con la base de clientes.
  - **Escritura atómica** (archivo temporal + `rename`) y **relectura antes de escribir**, para
    que dos réplicas escribiendo el mismo volumen no se borren las sesiones entre sí.
  - `limpiarSesionCache(certHash)` ahora borra **una**; sin argumento sigue borrando todas.

### Agregado

- **`SiiPortalAuth.descargarRespaldoMipyme(rut, dv, opciones)`** — descarga el **XML firmado
  completo** de los DTE emitidos o recibidos desde el "Respaldo de archivos MIPYME" del portal
  (`www1.sii.cl/cgi-bin/Portal001`).

  Es la única vía que entrega el **documento completo**: detalle línea por línea, `CdgItem` del
  proveedor, referencias y TED. `obtenerDetalleDtes()` solo trae metadatos y
  `obtenerResumenRegistro()` solo totales mensuales.

  ```js
  const { total, tramos } = await auth.descargarRespaldoMipyme('76543210', '6', {
    origen: 'RCP', desde: '2026-01-01', hasta: '2026-08-18',
  });
  ```

  **Solo requiere el certificado digital, no estar certificado como emisor.** Consultar el
  portal nunca exigió certificación; es requisito para emitir.

  Habilita importar facturas de proveedor sin depender de que el emisor mande el XML a la
  casilla de intercambio.

### ⚠️ Comportamiento del SII que hay que conocer

- **Tope duro de 20 documentos por descarga**, medido contra el portal: 20 devuelve XML, 21
  devuelve `<title>Error al contribuyente</title>`. **No es un XML recortado**: quien no valide
  que la respuesta empieza con `<?xml` va a leer una página HTML como "sin documentos". El
  método trocea el rango por mitades hasta que cada tramo quepa (validado bajando 44 documentos
  en 3 tramos).

- **Un solo día con más de 20 documentos** no se puede partir más por fecha, y el método lanza
  error explícito en vez de bajar de menos en silencio.

  ✅ Pero sí tiene salida, medida contra el portal: **cortar por `TPO_DOC`**. Cada tipo de DTE
  es una consulta aparte y la unión cubre el día completo. ⚠️ **No usar `FOLIO`/`FOLIOHASTA`
  para esto**: borran silenciosamente `FEC_HASTA` y devuelven otro conjunto de documentos (con
  filtro de folios un rango de 389 devolvió 541). Ver esta sección §7.

- **El captcha existe pero hoy va vacío.** Si el SII lo enciende, se lanza `RESPALDO_CAPTCHA` y
  **no se reintenta**: no se resuelve solo.

- 🔴 **El portal viejo responde por `alert()` de JavaScript, no por HTML.** Ante un rechazo
  devuelve **HTTP 200** con el motivo real dentro de un `<script>`, mientras el `<title>` dice
  algo distinto y el HTML visible va vacío:

  ```html
  <title>Seleccionar empresa</title>
  <script>alert('No existe información en MIPYME para el rut ingresado');history.back();</script>
  ```

  ⚠️ Clasificar por `<title>`, o limpiar el HTML con `.replace(/<script...>/g,'')` antes de
  leerlo, borra exactamente lo único que trae la respuesta. Las dos cosas pasaron durante esta
  investigación y llevaron a afirmar **tres causas equivocadas seguidas** sobre una página que
  decía la respuesta en la primera línea.

  Ahora `extraerAlertasPortal()` lee esos mensajes y `errorDeRespuestaPortal()` los propaga
  intactos en **`err.mensajePortal`**. El total de documentos tiene prioridad: si está, la
  respuesta se toma como buena aunque la página traiga algún alert incidental.

  ⚠️ **Y el error inverso:** la página de resultados **válida** trae un
  `//alert("Maximo numero de docmentos para respaldar: 20...")` **comentado** en el template. Un
  extractor ingenuo lo toma por bueno y convierte un listado correcto en un error inventado.
  `extraerAlertasPortal()` descarta los alerts comentados en su línea.

  ⚠️ **Y un tercer caso: VARIOS alerts son el catálogo del template, no un veredicto.** Una
  respuesta trajo cinco mensajes encadenados y contradictorios entre sí ("no está autorizado",
  "debe hacerlo el representante legal", "no existe información en MIPYME"…). Tomarlo por
  veredicto marcó a un comercio como "sin datos" y **abortó un backfill que venía trayendo 24
  documentos correctamente**. La página realmente rechazada trae **un solo** alert, seguido de
  `history.back()`.

  | código | cuándo |
  |---|---|
  | `RESPALDO_SIN_DATOS` | el RUT no tiene información en MIPYME (nada que respaldar) |
  | `RESPALDO_CAPTCHA` | el SII encendió el captcha |
  | `RESPALDO_RECHAZADO` | rechazo con un texto que no conocemos; llega literal |
  | `RESPALDO_INDETERMINADO` | varios mensajes del template, sin veredicto único. Llega en `err.mensajesPortal` |
  | `RESPALDO_SIN_EMPRESA` | página de ingreso **sin** alert; causa no determinada |

  ⚠️ Para el consumidor la distinción importa: `RESPALDO_SIN_DATOS` es un veredicto definitivo
  y cierra el período; `RESPALDO_INDETERMINADO` y `RESPALDO_CAPTCHA` significan "no se pudo
  concluir" y "no pudimos preguntar", y deben reintentarse.

  Ninguno se reintenta **dentro de la misma corrida**. **Mostrar `err.mensajePortal` en la UI**,
  no una traducción propia.

  Los **recibidos** incluyen documentos de cualquier emisor, no solo del sistema gratuito de
  facturación del SII.

- El XML viene en **ISO-8859-1**: leerlo con `latin1`.

Contrato completo, respuestas reales y los errores que cuestan tiempo (es POST no GET;
`ORIGEN=ENV` no `EMI`; el listado es obligatorio antes de la descarga) en
esta sección.

## [2.15.0] - 2026-08-18

### Agregado

- `CertRunner.precargarPlanDeCorrida(sets)`: arma el plan de timbraje desde los sets ya
  cargados y delega en `precargarCafsDeSets()`. Evita que cada consumidor duplique los
  `cafRequired` de cada set, que era la forma de quedar desincronizado si cambiaban en la lib.

  ```js
  await runner.obtenerSets();
  await runner.precargarPlanDeCorrida();              // corrida completa
  await runner.precargarPlanDeCorrida(['basico']);    // un set aislado
  ```

  ⚠️ **Hay que pasar los sets que realmente se van a ejecutar.** `_estructuras` puede traer los
  cuatro aunque la corrida ejecute uno solo, porque se rehidrata desde disco. Precargar todo en
  ese caso timbraría folios que nadie va a emitir, y quedarían autorizados sin usar: justo el
  gatillo del racionamiento del SII que este método viene a evitar. El default son los cuatro.

### Cambiado

- Los `cafRequired` de cada set salen de la constante `CAF_POR_SET`, única fuente de verdad
  para `ejecutarSet*` y `precargarPlanDeCorrida()`. Antes vivían inline en cada `ejecutarSet*`.

- **El fallback del set de guía pasa de 1 a 3.** Solo aplica cuando el set no trae
  `cafRequired`. El valor sale de tráfico real: en 17 corridas registradas el set vino siempre
  con `cafRequired: { 52: 3 }` y 3 casos, así que 1 timbraba de menos. Coincide con el fallback
  que ya usaba el consumidor, o sea que la divergencia lib/consumidor queda resuelta.

Propuesto por WB. La firma con `sets` se acordó tras detectar que la versión sin argumentos
rompía los modos de set aislado.

## [2.14.4] - 2026-08-18

### Corregido

- `BoletaCert`: la rama que maneja un `EnvioBOLETA` duplicado reasignaba una variable
  declarada `const`, lo que lanzaba `TypeError: Assignment to constant variable` justo en el
  camino que pretende recuperarse. Ahora es `let`.

  **Sin disparador confirmado.** Reportado por WB a partir de lectura estática del código, no
  de un caso observado. Se verificó contra tráfico real y no se pudo reproducir: reenviar un
  `EnvioBOLETA` ya aceptado a maullin devuelve **STATUS 99** (`"Archivo ya fue enviado N veces
  con Trackid X"`), no STATUS 7, y el 99 no setea `duplicado`, así que la rama no se entra.
  De 12 respuestas STATUS 7 capturadas en corridas reales, todas son de Libros con detalle
  `cvc-*`, que `EnviadorSII` rutea explícitamente a `duplicado: false`. En 319 logs de
  corridas la rama nunca se ejecutó.

  Se corrige igual porque el código es incorrecto y el costo es nulo, pero **no arregla una
  falla observada de certificación de boleta**.

  Punto ciego conocido: las capturas contra palena son solo navegación de portal, ningún
  `DTEUpload`. Si aparece un STATUS 7 sin `trackId` y sin `CHR-00001`/`SCH-00001`/`cvc-`, hay
  que revisar la clasificación de `EnviadorSII` antes que este parche.

## [2.14.3] - 2026-08-17

### Corregido

#### "Esperando el SOK" sobre empresas que ya habían declarado

`consultarEstadoBoletaPortal()` pregunta puntualmente por el estado **90**, así que una
lista vacía significa "no está en P90". Eso ocurre en dos situaciones opuestas:

- todavía no llegó (el SII no emitió el SOK del set), o
- **ya lo pasó**: declaró cumplimiento y avanzó a P91.

Se daban por la primera siempre. Resultado: después de una declaración exitosa, el flujo
seguía informando "esperando aprobación del SII (SOK)" y la pantalla le pedía al usuario
esperar una etapa ya superada. Visto el 17/08/2026 (RUT 79555666-7): declaró a las 14:01
con `DECLARACION EFECTUADA` y a las 14:5x seguía diciendo que faltaba el SOK.

Ahora, cuando la consulta por el 90 viene vacía, se desempata preguntando por el **91**,
que es el estado al que mueve `autorizarEmpresaBolProd`. Se agrega `yaDeclarada` al
resultado.

#### Reintentar la declaración sobre una empresa ya declarada quedaba en espera infinita

Con lo anterior, `completarDeclaracionBoletaPortal()` devolvía `pendingSok` para una
empresa en P91, y quien orquesta dejaba la etapa en `esperando` aguardando un SOK que ya
había llegado y ya se había usado. Ahora devuelve `success: true` con `yaDeclarada: true`:
la etapa está cumplida, no pendiente.

## [2.14.2] - 2026-08-17

### Corregido

#### "Boleta NO autorizada" sobre empresas que sí lo estaban

`verificarAutorizacionBoleta()` consultaba el timbraje de producción con un `GET` pelado a
`of_solicita_folios_dcto`. Ese endpoint es la **segunda** pantalla de un formulario de dos
pasos: sin el `POST` previo que lleva `RUT_EMP`/`DV_EMP`, el SII responde 200 con una
página de error genérica que no trae ningún `<select>`.

Como el parser buscaba `<option value="39">`, esa página vacía daba cero tipos y se
concluía **"no autorizada"**. Siempre. Para cualquier empresa.

Ahora hace los dos pasos, que es la misma secuencia que ya usaba
`CafSolicitor._processMultiStepFlow()` para pedir folios de verdad, y por eso ese camino sí
funcionaba. Medido contra palena (RUT 79555666-7, 17/08/2026):

```
antes:   página de error LIBRUD-OFSF-DTE-3-1-02, tipos []      -> "no autorizada"
después: tipos [33, 34, 46, 52, 56, 61]                        -> boleta 39: NO (dato real)
```

El resultado final coincide, pero por el motivo correcto: esa empresa tiene habilitados
factura y el resto, y le falta solo boleta. Antes decía lo mismo estando rota, que es peor
que equivocarse: la respuesta correcta por la razón equivocada, indistinguible del caso en
que sí está habilitada.

#### Ausencia de `<select>` ya no se interpreta como "no autorizada"

Complementa lo anterior para cualquier otra falla del portal. Si la respuesta no trae
formulario, se devuelve `consultaFallida: true` y `errorConsultaProduccion` con el código
del SII, en vez de afirmar algo sobre la autorización.

⚠️ Quien consuma esto tiene que distinguir **tres** estados, no dos: autorizada, no
autorizada, y no se pudo consultar. Tratar `consultaFallida` como "no autorizada" reproduce
el bug original.

## [2.14.1] - 2026-08-17

### Corregido

#### La consulta que decide "¿ya me habilitaron?" no dejaba rastro

`verificarAutorizacionBoleta()` era el único cliente HTTP de la librería sin captura: su
`fetchHtml()` resolvía el cuerpo y no llamaba a `registrarHttpDebug`. Es la consulta a
`of_solicita_folios_dcto` en palena que mira si el tipo 39 ya aparece en el select, o sea
la que contesta si el SII habilitó el timbraje.

Sin esa captura, un "todavía no" no se puede distinguir de una consulta que salió mal:
las dos terminan en `autorizadaProduccion: false`. Justo el caso en el que uno necesita
mirar la respuesta cruda (17/08/2026, RUT 79555666-7).

Auditados después los cinco archivos con clientes HTTP exigiendo un `registrarHttpDebug`
dentro de las 25 líneas de cada `https.request` / `https.get` / `fetch`: **0 sitios sin
registro**. Los clientes que pueden aparecer en el índice son ocho: `SiiPortalAuth`,
`SiiSession`, `EnviadorSII`, `BoletaCert`, `certBolElectDte`, `pdfdteInternet`,
`pfeInternet` y `verificarAutorizacionBoleta`.

⚠️ La captura sigue dependiendo de que el consumidor defina `SII_HTTP_DEBUG_DIR`, y de que
esa ruta esté en almacenamiento persistente. Apuntarla al disco de un contenedor efímero
deja la instrumentación sin efecto: se escribe y se pierde en el siguiente deploy.

## [2.14.0] - 2026-08-14

Dos frentes, los dos medidos contra maullin: la firma de los envíos (un apóstrofe en el
nombre de un ítem hacía que el SII rechazara el envío completo) y el timbraje (dejar de
agravar el bloqueo del SII, y aprender a recuperar folios ya autorizados).

Con esto una certificación llegó de punta a punta por primera vez: las diez etapas, los
cuatro sets en `EPR` y las muestras impresas aceptadas por el validador del SII
(RUT 77111222-3, 14/08/2026). El timbraje se midió con el RUT 76543210-K.

### Agregado

#### Reobtención de folios ya autorizados

Cuando el SII bloquea el timbraje lo hace porque el contribuyente ya tiene folios sin
usar, y su propio mensaje da la salida: *"debe emitir y enviar documentos electrónicos al
SII o anular folios"*. Las dos salidas no son equivalentes: emitir baja el contador de
folios disponibles, mientras que anular suma un **factor de anulación** que el SII aplica
cuando se anularon folios y no se emitieron DTE entre timbrajes. Pero para emitir hace falta el
CAF, y si se perdió no había forma de recuperarlo.

`CafSolicitor.listarReobtenibles()` y `.reobtenerCaf()` implementan el flujo del portal,
que resultó ser de **cinco** pasos y no de tres:

```
rf_reobtencion1 → rf_reobtencion2 → rf_reobtencion3 → rf_genera_folio → rf_genera_archivo
                    (lista)          (¿anulado?)        (resolución)       (XML del CAF)
```

`rf_genera_folio` no devuelve el XML: emite la resolución de autorización y recién ahí
ofrece el enlace de descarga, igual que el timbraje normal (`of_genera_folio` →
`of_genera_archivo`).

⚠️ **El listado incluye rangos anulados sin distinguirlos.** Solo al abrir cada uno el
portal avisa *"ha sido anulado completamente... los documentos que el Servicio reciba con
dichos folios serán rechazados"*. Por eso hay un request por rango. En el RUT de prueba,
4 de 6 rangos del tipo 56 estaban anulados.

`FolioService.reobtenerCaf({ tipoDte, cantidad })` junta tantos rangos como haga falta y
descarta los anulados.

#### Varios CAF por tipo de documento

`SetBase._tomarFolio()` acepta una ruta o una lista, y devuelve el par **folio + CAF**
junto.

Hacía falta porque el SII entrega los folios reobtenidos de a uno (folios 1-1 y 3-3 como
CAF separados). Y no alcanza con concatenar numeraciones: **cada CAF trae su propia llave
RSA** (`CAF.js` → `RSASK`) y el timbre se firma con la del CAF que contiene ESE folio
(`DTE.js` → `caf.sign(...)`). Firmar el folio 3 con la llave del CAF del folio 1 produce
un timbre inválido y el SII rechaza el envío completo con `RFR - Rechazado por Error en
Firma`.

De paso unifica el método: estaba duplicado —idéntico, mismo hash— en `SetBasico`,
`SetGuia`, `SetExenta` y `SetCompra`. Ahora la lógica de qué llave firma qué documento
vive en un solo lugar.

### Corregido

#### Un apóstrofe en el nombre de un ítem tumbaba el envío completo

La canonicalización pasaba por un `fixEntities()` que convertía `'` en `&apos;` y `"` en
`&quot;` dentro del contenido. Canonical XML (REC-xml-c14n-20010315) escapa en nodos de
texto **solo** `&`, `<`, `>` y el retorno de carro; el apóstrofe y la comilla doble quedan
literales, que es justo lo que ya hacía `escapeText()`.

Con ese paso de más, la forma canónica que se firmaba dejaba de ser la que el SII recalcula
al recibir el documento. El `DigestValue` no coincidía y el SII rechazaba el **envío
entero** con `RFR - Rechazado por Error en Firma`, sin decir qué documento ni por qué.

Lo que lo hacía difícil de ver es que dependía del **contenido**, no del código: el mismo
flujo pasaba o fallaba según lo que trajera el set. Medido el 14/08/2026 (RUT 77111222-3,
maullin), contando documentos cuyo digest el SII calcula distinto:

```
Set Básico   → EPR   0        Set Exenta   → RFR   1  ← "CAPACITACION USO PLC'S CNC"
Set Guía     → EPR   0        Set Compra   → EPR   0
```

Un carácter, en un ítem, en un documento de veintidós. Tras el arreglo la divergencia es 0
en los cuatro sets, y los documentos sin apóstrofes ni comillas producen exactamente el
mismo digest de antes — así que no cambia nada de lo que el SII ya aceptaba.

Regresión cubierta en `test/c14n-apostrofe.test.js`.

#### Un CAF reusado se volvía a gastar en la etapa siguiente

El reuso de CAF de más abajo tenía un límite que no estaba puesto: valía para
**reintentos de la misma etapa** (un intento que falló no emitió nada), pero se aplicaba
también entre etapas distintas. `ENVIAR_SETS` no falló — terminó bien y gastó sus folios;
`SIMULACION`, al arrancar en otro proceso con el contador de folios en cero, tomó el
mismo CAF y reemitió los mismos números.

Medido en maullin (RUT 77111222-3, 14/08/2026), consultando los dos envíos por SOAP:

```
0254369292  Set Básico   → EPR  Envío Procesado                 (folios 33: 4519-4522)
0254369570  Simulación   → RFR  Rechazado por Error en Firma    (folios 33: 4519-4522)
```

El SII rechaza el envío **entero**, no el documento repetido.

`CertRunner._marcarCafsConsumidos()` registra los folios emitidos y `_cafReusable()` los
salta. Se marca en un `finally`, apenas se intentó el envío y sin mirar si salió bien: si
el envío viajó, el SII ya vio esos folios aunque después lo rechace. Quemar un folio de
más es barato; repetirlo cuesta la etapa completa.

⚠️ **El registro va por rango, no por archivo**, y esa distinción es el arreglo de verdad.
El mismo CAF se guarda en DOS árboles con el mismo contenido:

```
debug/auto-caf/{rut}/{ts}/{tipo}/archivo.xml
debug/caf/{ambiente}/{rut}/{tipo}/{ts}/caf-{tipo}-{desde}-{hasta}.xml
```

`findLatestCaf` puede devolver cualquiera de las dos, así que marcar la copia usada deja
la otra intacta y la etapa siguiente la encuentra "sin usar". Pasó exactamente eso: la
primera versión de este arreglo marcaba solo el archivo, y la simulación volvió a repetir
los folios desde la otra copia. Lo que identifica a un folio es (RUT, tipo, número), no
dónde quedó el archivo, así que los rangos consumidos van a
`{stateDir}/folios-usados-{rut}.json`.

#### El polling de simulación reportaba un rechazo como "todavía en revisión"

`esperarSimulacionAprobada()` decide mirando el avance de la postulación, y ahí un envío
rechazado se ve idéntico a uno que el SII aún no revisa: en los dos casos la etapa no se
mueve. Al agotar los intentos devolvía `Timeout esperando aprobación`, que quien llamaba
leía como "sigue en curso".

Ahora, antes de rendirse, consulta el estado del envío por su trackId — la única fuente
de verdad — y si está rechazado lo devuelve como tal (`rechazado: true`, con el estado y
la glosa del SII). Nuevo método público `CertRunner.consultarEstadoEnvio(trackId)`.

#### El reintento volvía a timbrar folios que ya tenía

Cuando una etapa fallaba después de timbrar algunos tipos, el reintento pedía todo de
cero. Los folios del intento anterior quedaban sin usar, y el SII cuenta exactamente eso
para negar el timbraje: **cada reintento agravaba el bloqueo que intentaba superar**.
Medido: 6 reintentos de `ENVIAR_SETS` quemaron **66 folios** sin emitir un solo documento.

`CertRunner._cafReusable()` busca el CAF previo en disco antes de pedir. Es seguro porque
los sets se envían recién cuando todos los CAF están en mano, así que un intento fallido
no emitió nada.

#### `findLatestCaf` devolvía CAF de otros contribuyentes

Buscaba recursivamente en `debug/auto-caf` —carpeta compartida por todos los comercios—
y solo comparaba el tipo de DTE, ignorando el RUT que recibe en el constructor. Los tipos
56 y 61 del RUT 76543210-K resolvieron a CAF de 77111222-3 y el SII rechazó el envío
entero por firma. Ahora valida el `<RE>` del propio CAF.

#### El sondeo confundía "sin tope" con "bloqueado"

La ausencia de `MAX_AUTOR` tiene dos causas opuestas: el SII no limita ese tipo, o no
autoriza nada. En ambos casos la página viene sin los campos, así que `consultarTope()`
informaba "no está racionando" con el timbraje cerrado, y la limpieza previa nunca corría.
Ahora devuelve `bloqueado` por separado.

La detección se hace en `_esRechazoDuroYMarca()`, que marca **donde detecta**: el corte
por rechazo duro está en cuatro puntos del flujo y cada uno retorna apenas lo ve, así que
marcarlo en un punto elegido a mano quedaba inalcanzable según por dónde saliera.

#### La limpieza se abandonaba por rechazos que no eran negativas

El corte por rechazos consecutivos contaba `ya-anulado` y `recepcionado`, que son
resultados esperados y aparecen mezclados con anulaciones exitosas. Medido en el tipo 33:
tras dos anulaciones OK venían dos "ya anulado" y la pasada se abandonaba con 8 rangos
todavía anulables sin intentar. Ahora solo cuentan las negativas reales.

#### `FolioService` ignoraba `pfxBuffer`

Solo creaba el `CafSolicitor` con `pfxPath`, aunque la clase acepta buffer para la sesión
y `CafSolicitor` lo soporta. Un consumidor con el certificado en memoria (leído de la BD,
sin escribirlo a disco) quedaba con todo el timbraje muerto: `"CafSolicitor no
inicializado"`.

#### Ventana de limpieza según ambiente

Era de 1 día en todos lados. En producción está bien —el historial son documentos reales
y anular es destructivo—, pero en maullin dejaba un callejón sin salida: los folios que
bloquean suelen ser de semanas atrás, el filtro los descartaba antes de intentarlos y la
corrida reintentaba para siempre. Ahora 1 día en producción, 180 en certificación.

### Orden de resolución de folios

```
1. reusar el CAF que ya está en disco     gratis, sin tocar el SII
2. reobtener del portal                   sin gastar cupo
3. pedir folios nuevos                    el camino normal
4. anular                                 último recurso
```

Anular pasó de ser el primer remedio al último: es el único con costo (activa el factor de
anulación del SII) y el único que puede empeorar la situación que intenta arreglar. Medido
el 14/08/2026 con 72 documentos emitidos en maullin — ver
las mediciones internas del consumidor.

## [2.13.3] - 2026-08-13

Guardar la sesión fallaba si su carpeta no existía todavía. Encontrado auditando el resto
de la librería tras un ENOENT equivalente en el orquestador de certificación.

### Corregido

#### `saveSession()` no creaba el directorio contenedor

`SiiSession.saveSession(filePath)` hacía `writeFileSync` directo. Si la carpeta de
`filePath` no existía, lanzaba `ENOENT` — el caso normal en el **primer arranque** sobre
un volumen persistente recién creado, o sobre una carpeta de debug aún vacía.

El síntoma no era el error en sí, sino lo que provocaba según quién llamara:

| Llamador | Consecuencia |
|---|---|
| `FolioService` | Lo tragaba con `catch (_) {}`: la sesión **nunca** se persistía, en silencio |
| `CafSolicitor` | Sin `catch` propio: abortaba la **solicitud de folios** en curso |
| `SiiCertificacion` | Sin `catch` propio, y en un hook que corre en **cada** establecimiento de sesión: tumbaba cualquier operación contra el SII |

Lo grave del primer caso es que no se nota: sin cache de sesión hay un login nuevo por
operación, y ese es el camino directo al bloqueo por "máximo de sesiones autenticadas"
del RUT.

Ahora `saveSession()` crea el directorio con `mkdirSync(recursive)` antes de escribir,
igual que ya hacía `SiiPortalAuth` con su propio cache. `SetsProvider` venía parchando
esto por su cuenta con `_ensureDir()` en tres sitios distintos, lo que confirmaba que
faltaba en la raíz.

#### Persistir la sesión ya no puede abortar una operación real

Los dos auto-guardados que corrían sin protección (`SiiCertificacion`, `CafSolicitor`)
pasan a ser best-effort, con `console.warn` en vez de excepción. Guardar la sesión es una
optimización de reuso: la operación en curso ya tiene la sesión viva en memoria, así que
un disco lleno o un volumen no montado no tienen por qué hacerla fallar.

## [2.13.2] - 2026-08-13

Dos fallas en el plegado del TED, encontradas revisando el código de 2.13.0.

### Corregido

#### El truncado a 40 iba antes del plegado, y el plegado alarga

`DTE.js` hacía `sanitizeTedText(texto.substring(0, 40))`. El problema es el orden: plegar
**puede alargar** el texto, porque varios caracteres se expanden de 1 a 2 (`ß`→`ss`,
`Æ`→`AE`, `Þ`→`TH`, `ﬁ`→`fi`). Si el corte de 40 caía justo en uno de esos, el resultado
quedaba en 41-42 caracteres y **desbordaba el límite de `<RSR>` e `<IT1>`**, con riesgo de
que el SII rechazara el timbre.

Reproducido: `"Cerveza Weissbier Especial Importada AßX"` (40 caracteres) daba **41**
después de plegar. Ahora se trunca al final y da 40 exactos.

Solo se dispara si el texto llega a 40 caracteres **y** el borde cae en un carácter
germánico o nórdico, así que en nombres chilenos es prácticamente inexistente. Se corrige
igual: el límite del SII es duro y el TED va firmado.

#### Las ligaduras se borraban en vez de expandirse

`sanitizeTedText` mapeaba `ﬀ ﬁ ﬂ` a `ff fi fl`, pero ese `replace` era **código muerto**:
corría después de `sanitizeSiiText`, que ya había descartado esos caracteres por no
reconocerlos. El resultado era que desaparecían del timbre.

Ahora el plegado va **antes** y las reglas del SII después, sobre texto ya ASCII. De paso
se agregaron `ﬃ ﬄ Œ œ`, que tampoco estaban.

```
antes:  'ﬁ' → ''     'Œ' → ''
ahora:  'ﬁ' → 'fi'   'Œ' → 'OE'
```

Verificado con un DTE tipo 39 firmado: `<IT1>` de 40 caracteres exactos, 0 bytes no-ASCII
en el TED y `<FRMT>` presente. Los acentos del cuerpo siguen intactos.

---

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

Movido a la librería desde el consumidor (antes `getEmisorFromPortal.js`), donde
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
