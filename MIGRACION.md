# Guia de salida: de @devlas/dte-sii a SII SDK

Esta guia es para quien usa hoy `@devlas/dte-sii` (2.x, CommonJS) y debe decidir que hacer ahora que la libreria esta deprecada. Las equivalencias vienen de la documentacion de SII SDK (`@devlas-cl/*`) y se limitan a lo que esa documentacion confirma.

## 1. Por que se depreca y que significa

El trabajo de Devlas continua en SII SDK, una libreria TypeScript nueva con otro diseno (sin estado global, errores como valor, almacenamiento por puertos). Mantener dos motores en paralelo no es sostenible, asi que esta libreria queda cerrada.

Que significa en la practica:

- Sin soporte y sin cambios. No se aceptaran issues de soporte ni pull requests con funcionalidad.
- Las versiones 2.x (licencia MIT) siguen disponibles en npm. No se retiran y puedes seguir usandolas.
- SII SDK es privado y se entrega con licencia por GitHub Packages (ver seccion 6).

Lo que no se hara, dicho sin rodeos:

- No habra parches de seguridad. Si se descubre una vulnerabilidad en esta libreria o en sus dependencias, no se publicara correccion.
- No habra adaptacion a cambios del SII (formatos, esquemas, endpoints, reglas de folios, cadenas TLS, portal). El SII cambia sin aviso formal en varias de estas superficies. Quien siga usando esta libreria debe asumir que, tarde o temprano, algo dejara de funcionar sin que nadie lo corrija aqui.
- No habra compatibilidad con nuevas versiones de Node ni con cambios en las dependencias.

Un ejemplo ya conocido: `pangal.sii.cl` y `rahue.sii.cl` (envio REST de boletas) no envian el certificado intermedio, y Node falla con `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. No es un defecto de esta libreria. Se resuelve por configuracion con `NODE_EXTRA_CA_CERTS` (intermedio "GeoTrust TLS RSA CA G1"). En SII SDK se resuelve en el adaptador `Http` con la opcion `certificadosAdicionalesPem`.

## 2. Equivalencias de capacidades

SII SDK expone funciones que reciben sus puertos y devuelven `Resultado<T, ErrorSii>`, en lugar de clases con estado.

| Capacidad | dte-sii 2.x | SII SDK |
|---|---|---|
| Armar, timbrar y firmar un DTE | `DTE`, `CAF` | `@devlas-cl/xml`: `prepararDte`, `leerCaf` |
| Emitir un documento completo | Se arma a mano: folio, `DTE`, sobre, `EnviadorSII` | `@devlas-cl/sii`: `emitir` (reserva el folio y lo devuelve si falla antes de poder salir) |
| Armar el sobre | `EnvioDTE`, `EnvioBOLETA` | `xml`: `prepararSobre`, `armarSobre` (XSD obligatorio antes de enviar) |
| Token y semilla | `EnviadorSII.getToken`, `getTokenSoap` | `sii`: `autenticar` con `AlmacenSesion` |
| Enviar facturas, notas y guias | `EnviadorSII.enviarDteSoap` | `sii`: `enviarDte` |
| Enviar boletas (REST) | `EnviadorSII.enviar` | `sii`: `enviarBoletas` |
| Estado de un envio | `consultarEstado`, `consultarEstadoSoap` | `sii`: `consultarEstadoEnvio`; `protocolo`: `veredictoFinalDeEnvio` |
| Envio incierto | `folioRecibido` | `sii`: `consultarEstadoDte`, `verificarFolioEnviado` |
| Estado de un documento de boleta | No existe | `sii`: `consultarEstadoDocumento` |
| Pedir folios | `CafSolicitor.solicitar` | `sii`: `pedirCaf` |
| Reobtener y anular folios | `FolioService.reobtenerCaf`, `anularFolios` | `sii`: `reobtenerCaf`, `anularFolios` |
| Mantener folios vigentes | Planificador propio | `soluciones`: `autoCaf`, `resumirFoliosCaf` |
| Vigencia del CAF | 180 dias en UTC o 6 meses, segun la pieza | `dominio`: `vigenciaCaf` |
| Intercambio (leer, verificar, responder) | `IntercambioCert` | `xml`: `leerEnvioRecibido`, `verificarEnvioRecibido`, `armarRespuestaRecepcion`, `armarRespuestaComercial`, `armarEnvioRecibos` |
| Aceptar o reclamar ante el SII | `WsReclamo` | `sii`: `registrarEventoReceptor`, `listarEventosDocumento`, `consultarEstadoReceptor` |
| RCV (resumen y detalle) | `SiiPortalAuth` | `sii`: `resumenRcv`, `detalleEmitidos`, `detalleRecibidos` |
| Libros de ventas, compras y guias | `LibroCompraVenta`, `LibroGuia` | `xml`: `armarLibro`; `sii`: `enviarLibro`, `consultarEstadoLibro` (solo certificacion) |
| RCOF | `ConsumoFolio` | `xml`: `armarConsumoFolios` (solo certificacion; eliminado en produccion por Res. Ex. SII 53/2022) |
| PDF, ticket y PDF417 | `cert/MuestrasImpresas` | `impresion`: `modeloImpresion`, `ticketTermico`, `pdf`, `timbrePng` |
| RUT y texto | `validarRut`, `formatRutSii`, `sanitizeSiiText`, `truncateText` | `dominio`: `parseRut`, `esRutValido`, `formatoSii`, `sanearTexto`, `recortarTexto` |
| Certificado `.pfx` | `Certificado`, `loadPfxFromBuffer` (node-forge) | `xml`: `inspeccionarCertificado`, `credencialTls` (sin node-forge) |
| Certificacion | `CertRunner`, `BoletaCert`, `SiiCertificacion` | `certificacion`: `avanzarCorrida`; `soluciones`: `habilitar` |

Sin equivalente, o con una diferencia que debes conocer:

| Capacidad | Situacion |
|---|---|
| Descarga del RCV con captcha | Los endpoints de exportacion del portal exigen reCAPTCHA y SII SDK no lo automatiza. El detalle por tipo y periodo (`detalleEmitidos`, `detalleRecibidos`) se pide sin ese paso. |
| Validez de boleta en el portal | Lleva captcha propio. Fuera de lo automatizable. |
| Pago, giro y cupon de pago del F29 | No se hara. Mueve dinero y queda fuera de la libreria. |
| Declaracion de renta (F22) | No existe. Hay diseno e investigacion, sin codigo. Presentarla requiere juicio profesional. |
| Boleta de honorarios electronica (BHE) | Fuera de alcance. No es un DTE, no tiene CAF y se emite en el portal. |
| Cola de envios, reintentos de la cola, correo al receptor, interfaz | No son parte de ninguna de las dos librerias. Siguen siendo tuyos. |
| Configuracion global, logger, cache de tokens y archivos | No se portan por diseno (ver seccion 3). |

## 3. Diferencias de diseno que importan

1. **Errores como valor.** SII SDK no lanza excepciones por datos tuyos ni del SII. Cada llamada devuelve `Resultado`; reemplaza los `try/catch` por la revision de `ok`.
2. **Sin recorte ni saneo silencioso.** `dte-sii` recortaba y saneaba texto por tu cuenta. SII SDK valida y rechaza (por ejemplo, un largo excedido es error). Llama a `sanearTexto` y `recortarTexto` donde antes era automatico.
3. **Estado local en JSON reemplazado por puertos.** No hay archivos de estado, cache global de tokens ni configuracion global. Tu aplicacion implementa y entrega los puertos `Http`, `AlmacenSesion`, `Bloqueos`, `AlmacenCaf` y `Registro`, y el SDK trae pruebas de contrato para validarlos. Si persistes cookies o CAF, cifralos en reposo.
4. **Captura de red.** La captura global por `SII_HTTP_DEBUG_DIR` no existe como tal: al no haber estado global, el punto de captura es el adaptador del puerto `Http` y el `Registro`, ambos tuyos. Planifica ese adaptador desde el inicio. Los cuerpos contienen documentos tributarios y material sensible.
5. **Una sesion del portal por RUT titular.** La clave de sesion es el RUT del titular, no la huella del certificado, porque el SII cuenta las sesiones por RUT. Si conviven ambas librerias, comparten ese limite.
6. **Folios: reobtener antes que anular.** Ante un bloqueo de timbraje, primero se reobtiene el CAF ya autorizado y luego se emite. Anular folios es el ultimo recurso: es irreversible y puede agravar el bloqueo. `autoCaf` aplica una politica por ambiente.
7. **Un envio nunca se reintenta solo.** Si el resultado es incierto, se consulta el estado con `verificarFolioEnviado` antes de decidir. Reenviar puede duplicar el documento y gastar otro folio.
8. **Veredicto por conteos.** Un estado `EPR` con documentos rechazados no es aceptado.
9. **Hora de Chile con reloj inyectado** en `TSTED` y `TmstFirmaEnv`. Espera diferencias de hora frente a UTC al comparar salidas.
10. **XSD obligatorio** antes de enviar: un documento que no valida no sale.
11. **Reglas nuevas que pueden romper flujos:** boleta exenta (41) con `exento: true` en cada linea; una venta toda exenta pedida como 33 o 39 es error (usa 34 o 41); la guia con `Transporte` lo exige desde 2026-11-01; la nota de credito con `CodRef` 3 no puede referenciar una nota de debito.
12. **Intercambio.** Las respuestas usan Canonical XML 1.0 y la aceptacion comercial es explicita por documento (se elimina el "aceptar todo").
13. **Solo ESM y TypeScript.** Debes adaptar los `require`.

La lista completa de cambios que rompen compatibilidad esta en la documentacion de SII SDK (`CHANGELOG-v1`).

## 4. Pasos de migracion sugeridos

No reemplaces `dte-sii` por llamadas sueltas. Pon una fachada con la forma que tu sistema ya usa, deja `dte-sii` detras y agrega SII SDK como segundo camino, elegido por una bandera que se lee en cada llamada.

1. Instalar SII SDK (seccion 6) y escribir los adaptadores de los puertos. Validarlos con las pruebas de contrato.
2. Migrar las piezas puras: RUT, montos, vigencia del CAF, mensajes de error, impresion. Comparar con la funcion vieja.
3. Validar con `validarXsd` los sobres que ya armas, en modo observacion.
4. Estado y veredicto sobre track id ya existentes (solo lectura).
5. Armar, timbrar y firmar boletas con el mismo folio y CAF sin enviar, y comparar con el XML real.
6. Lecturas del portal (ficha, tope de folios, RCV) con una sola sesion por RUT.
7. Folios: `resumirFoliosCaf` primero, despues `autoCaf`.
8. Emision real de boletas en un solo comercio, con la bandera encendida; el resto sigue en `dte-sii`.
9. Facturas, notas y guias, comercio a comercio. Despues, recibidos, RCV e intercambio. Libros, RCOF y certificacion son solo de certificacion.
10. Retirar `dte-sii` cuando el nuevo camino lleve un tiempo estable en todos los comercios.

Reglas para la bandera:

- Si no se puede leer la bandera, se usa el camino anterior.
- No hay vuelta atras automatica: si el camino nuevo falla cuando el sobre pudo salir, reintentar con el viejo enviaria un duplicado. Primero se consulta el estado y volver es una decision humana.
- Ambos caminos comparten el mismo almacen de folios. Con dos almacenes se repetirian folios.
- Para volver: apagar la bandera, revisar los envios inciertos de la ultima hora, no borrar ni renumerar folios y anotar el motivo.

Como verificar:

- Corre cada paso contra certificacion (maullin, pangal, palena) antes de tocar produccion.
- Compara las salidas con las de `dte-sii` sobre los mismos datos. Hay diferencias intencionales de bytes, como la hora de Chile y la validacion que antes no se hacia, y las encontraras de inmediato.
- Los documentos emitidos por un camino se consultan por el otro sin problema, porque el estado depende del track id del SII.

## 5. Si no quieres migrar

Puedes quedarte con 2.x. La licencia MIT te permite copiar, modificar y mantener tu propio fork, sin pedir permiso.

Advertencia: el SII cambia. Cambian esquemas, cadenas TLS, reglas de folios, el portal y los plazos, y estos cambios llegan sin aviso previo. Si haces un fork, alguien en tu equipo debe seguir esas novedades, probar contra certificacion de forma periodica, publicar correcciones y mantener las dependencias. Esta libreria no tendra quien lo haga por ti. Antes de decidir, estima ese costo frente al de migrar.

Recomendaciones minimas si te quedas:

- Fija la version exacta y no dependas de actualizaciones.
- Resuelve el intermedio TLS de boletas con `NODE_EXTRA_CA_CERTS`. El intermedio vence el 2027-11-02, renuevalo antes.
- Prueba tu flujo en certificacion con regularidad.
- Revisa tus dependencias por vulnerabilidades por tu cuenta.

## 6. Como obtener SII SDK

SII SDK es privado, con licencia, y se distribuye por GitHub Packages. Para conocerlo o pedir acceso, entra a [devlas.cl](https://devlas.cl). Quien obtiene acceso recibe las instrucciones de instalacion (token de lectura de paquetes y `.npmrc` para el registro de GitHub Packages) junto con la guia completa de migracion.
