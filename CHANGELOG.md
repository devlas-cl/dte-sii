# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Versionado [SemVer](https://semver.org/lang/es/).

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
`el consumidor/docs/mediciones/2026-08-14-cupo-folios-maullin.md`.

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
