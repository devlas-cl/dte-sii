# @devlas/dte-sii

**Librería de facturación y boletas electrónicas para el SII de Chile.**

Genera, timbra, firma y envía facturas electrónicas, boletas electrónicas, libros contables y automatiza el proceso de certificación ante el SII.

> Desarrollada por [Devlas SpA](https://devlas.cl) · Licencia MIT · Node.js >= 18 · CommonJS

---

## Instalación

```bash
npm install @devlas/dte-sii
```

---

## Tabla de contenidos

- [Tipos de DTE soportados](#tipos-de-dte-soportados)
- [Uso rápido](#uso-rápido)
- [Flujo completo: Factura Electrónica (tipo 33)](#flujo-completo-factura-electrónica-tipo-33)
- [Boletas electrónicas](#boletas-electrónicas)
- [Libros electrónicos y RCOF](#libros-electrónicos-y-rcof)
- [Gestión de folios](#gestión-de-folios)
- [Sesión y autenticación con el SII](#sesión-y-autenticación-con-el-sii)
- [Aceptación y reclamo de DTE (WsReclamo)](#aceptación-y-reclamo-de-dte-wsreclamo)
- [Estados SII: Interpretación de respuestas](#estados-sii-interpretación-de-respuestas)
- [Manejo de errores](#manejo-de-errores)
- [Configuración global y reintentos](#configuración-global-y-reintentos)
- [Utilidades](#utilidades)
- [Uso desde proyectos ESM (interop)](#uso-desde-proyectos-esm-interop)
- [TypeScript](#typescript)
- [Referencia de clases](#referencia-de-clases)
- [Estructura de archivos](#estructura-de-archivos)
- [Certificación SII](#certificación-sii)
- [Licencia](#licencia)

---

## Tipos de DTE soportados

| Tipo | Documento |
|------|-----------|
| `33` | Factura Electrónica |
| `34` | Factura No Afecta o Exenta Electrónica |
| `39` | Boleta Electrónica Afecta |
| `41` | Boleta Electrónica Exenta |
| `43` | Liquidación Factura |
| `46` | Factura de Compra |
| `52` | Guía de Despacho |
| `56` | Nota de Débito |
| `61` | Nota de Crédito |

---

## Uso rápido

```javascript
const { Certificado, CAF, DTE, EnvioDTE, EnviadorSII } = require('@devlas/dte-sii')
const fs = require('fs')

const cert = new Certificado(fs.readFileSync('empresa.pfx'), 'contraseña')
const caf  = new CAF(fs.readFileSync('caf_33.xml', 'utf8'))

const dte = new DTE({
  Encabezado: {
    IdDoc:   { TipoDTE: 33, Folio: 1 },
    Emisor:  { RUTEmisor: '76354771-K', RznSoc: 'Mi Empresa SpA', GiroEmis: 'Software', DirOrigen: 'Av. Ejemplo 123', CmnaOrigen: 'Santiago', Acteco: 620200 },
    Receptor: { RUTRecep: '12345678-9', RznSocRecep: 'Cliente SA', GiroRecep: 'Comercio', DirRecep: 'Calle 456', CmnaRecep: 'Providencia' },
  },
  Detalle: [
    { NmbItem: 'Servicio de desarrollo', QtyItem: 1, PrcItem: 100000 },
  ],
})

dte.generarXML().timbrar(caf).firmar(cert)

const envio = new EnvioDTE({ certificado: cert })
envio.agregar(dte)
envio.setCaratula({ RutEmisor: '76354771-K', RutReceptor: '60803000-K', FchResol: '2024-01-15', NroResol: 123 })
envio.generar()

const enviador = new EnviadorSII(cert, 'produccion') // o 'certificacion'
const resultado = await enviador.enviarDteSoap(envio)
console.log('TrackID:', resultado.trackId)
```

---

## Flujo completo: Factura Electrónica (tipo 33)

### 1. Cargar certificado y CAF

```javascript
const { Certificado, CAF } = require('@devlas/dte-sii')
const fs = require('fs')

const cert = new Certificado(fs.readFileSync('empresa.pfx'), 'clave_pfx')
// cert.getPrivateKeyPem()   → PEM de la llave privada
// cert.getCertificatePem()  → PEM del certificado público

const caf = new CAF(fs.readFileSync('caf_33.xml', 'utf8'))
// caf.getRutEmisor()        → RUT del emisor
// caf.getTipoDTE()          → 33
// caf.getFolioDesde()       → primer folio autorizado
// caf.getFolioHasta()       → último folio autorizado
// caf.isFolioValido(folio)  → boolean
```

### 2. Crear el DTE

```javascript
const { DTE } = require('@devlas/dte-sii')

// Formato simplificado (calcula totales automáticamente)
const dte = new DTE({
  tipo: 33,
  folio: 1,
  emisor: {
    rut: '76354771-K', razonSocial: 'Mi Empresa SpA',
    giro: 'Desarrollo de software', direccion: 'Av. Ejemplo 123',
    comuna: 'Santiago', actividadEconomica: 620200,
  },
  receptor: {
    rut: '12345678-9', razonSocial: 'Cliente SA',
    giro: 'Comercio', direccion: 'Calle 456', comuna: 'Providencia',
  },
  items: [
    { nombre: 'Licencia anual', cantidad: 1, precio: 100000 },
    { nombre: 'Soporte técnico', cantidad: 3, precio: 15000 },
  ],
  resolucion: { fecha: '2024-01-15', numero: 123 },
})

// O bien formato estructurado con XML SII estándar
const dte = new DTE({
  Encabezado: { IdDoc: { TipoDTE: 33, Folio: 1 }, Emisor: { ... }, Receptor: { ... }, Totales: { ... } },
  Detalle: [ { NmbItem: 'Producto', QtyItem: 2, PrcItem: 50000 } ],
  Referencia: [ { TpoDocRef: 61, FolioRef: 5, RazonRef: 'Anula factura' } ], // opcional
})

// Generar XML → timbrar → firmar (chainable)
dte.generarXML().timbrar(caf).firmar(cert)

// Obtener el XML final
console.log(dte.getXML())
```

### 3. Crear sobre y enviar

```javascript
const { EnvioDTE, EnviadorSII } = require('@devlas/dte-sii')

const envio = new EnvioDTE({ certificado: cert })
envio.agregar(dte)
envio.setCaratula({
  RutEmisor:   '76354771-K',
  RutReceptor: '60803000-K', // RUT del SII para envíos propios
  FchResol:    '2024-01-15',
  NroResol:    123,
})
envio.generar()

const enviador = new EnviadorSII(cert, 'produccion')
const resultado = await enviador.enviarDteSoap(envio)
// resultado.trackId   → ID para consultar el estado
// resultado.estado    → 'EPR', 'REC', etc.
// resultado.glosa     → mensaje SII
```

### 4. Consultar estado del envío

```javascript
// Estado del sobre (EnvioDTE)
const estadoSobre = await enviador.consultarEstado({
  trackId: resultado.trackId,
  rutEmisor: '76354771-K',
})
// estadoSobre.esExitoso / esIntermedio / esRechazado
// estadoSobre.codigo   → 'EPR', 'RPR', 'RSC', etc.

// Estado de un DTE individual
const estadoDte = await enviador.consultarEstadoDte({
  rutEmisor:   '76354771-K',
  rutReceptor: '12345678-9',
  tipoDte:     33,
  folio:       1,
  fechaEmision: '2024-06-15',
  montoDte:    145000,
})
// estadoDte.codigo → 'DOK', 'DNK', 'FAU', etc.
```

---

## Boletas electrónicas

> **Diferencia crítica por ambiente**
>
> - **Producción** → usar la API **REST** del SII (`enviarBoleta`) con los datos reales de resolución de la empresa.
> - **Certificación** → la API REST **no funciona** para el proceso de certificación SII. Usar **SOAP** (`enviarDteSoap`) con resolución `NroResol: 0` y la fecha de resolución de certificación que entrega el SII.
>
> Usar los datos de empresa incorrectos para el ambiente (por ejemplo, datos de producción en certificación) provoca rechazo inmediato del SII.

---

### Datos de resolución por ambiente

| Campo | Certificación | Producción |
|-------|--------------|------------|
| `NroResol` | `0` (siempre cero en cert.) | Número real de resolución SII |
| `FchResol` | Fecha entregada por el SII al iniciar certificación | Fecha real de la resolución |
| Método de envío | `enviarDteSoap` (SOAP) | `enviarBoleta` (REST) |

Para obtener la fecha y número de resolución de producción automáticamente desde el portal SII, ver [`SiiPortalAuth`](#sesión-y-autenticación-con-el-sii).

---

### Certificación: SOAP (obligatorio)

```javascript
const { DTE, CAF, Certificado, EnvioBOLETA, EnviadorSII } = require('@devlas/dte-sii')
const fs = require('fs')

const cert = new Certificado(fs.readFileSync('empresa_cert.pfx'), 'clave')
const caf  = new CAF(fs.readFileSync('caf_39_cert.xml', 'utf8'))

const dte = new DTE({ tipo: 39, folio: 1, emisor: { rut: '76354771-K', ... }, items: [ ... ] })
dte.generarXML().timbrar(caf).firmar(cert)

const envio = new EnvioBOLETA({ certificado: cert })
envio.agregar(dte)
envio.setCaratula({
  RutEmisor: '76354771-K',
  FchResol:  '2019-10-18',  // fecha de resolución de certificación (entregada por el SII)
  NroResol:  0,             // siempre 0 en certificación
})
envio.generar()

// SOAP - único método que funciona para certificación de boletas
const enviador = new EnviadorSII(cert, 'certificacion')
const resultado = await enviador.enviarDteSoap(envio)
console.log('TrackID:', resultado.trackId)
```

### Producción: REST (recomendado)

```javascript
const { DTE, CAF, Certificado, EnvioBOLETA, EnviadorSII } = require('@devlas/dte-sii')
const fs = require('fs')

const cert = new Certificado(fs.readFileSync('empresa_prod.pfx'), 'clave')
const caf  = new CAF(fs.readFileSync('caf_39_prod.xml', 'utf8'))

const dte = new DTE({ tipo: 39, folio: 1, emisor: { rut: '76354771-K', ... }, items: [ ... ] })
dte.generarXML().timbrar(caf).firmar(cert)

const envio = new EnvioBOLETA({ certificado: cert })
envio.agregar(dte)
envio.setCaratula({
  RutEmisor: '76354771-K',
  FchResol:  '2024-01-15',  // fecha real de resolución SII de la empresa
  NroResol:  123,           // número real de resolución SII de la empresa
})
envio.generar()

// REST - método estándar para producción
const enviador = new EnviadorSII(cert, 'produccion')
const resultado = await enviador.enviarBoleta(envio)
console.log('TrackID:', resultado.trackId)
```

### Flujo con BoletaService

`BoletaService` simplifica la creación de boletas individuales. Aplica el mismo criterio de ambiente: usar `enviarDteSoap` para certificación y `enviarBoleta` para producción una vez que el servicio retorne el sobre.

```javascript
const { BoletaService } = require('@devlas/dte-sii')
const fs = require('fs')

const service = new BoletaService()
service.cargarCertificado(fs.readFileSync('empresa.pfx'), 'clave_pfx')
service.cargarCAF(fs.readFileSync('caf_39.xml', 'utf8'))

const boleta = await service.crearBoleta({
  folio:      1,
  emisor:     { rut: '76354771-K', razonSocial: 'Mi Empresa', giro: 'Software', ... },
  items:      [{ nombre: 'Producto', cantidad: 1, precioConIva: 10000 }],
  resolucion: {
    fecha:  process.env.SII_AMBIENTE === 'certificacion' ? '2019-10-18' : '2024-01-15',
    numero: process.env.SII_AMBIENTE === 'certificacion' ? 0           : 123,
  },
})
```

---

## Libros electrónicos y RCOF

### LibroCompraVenta

```javascript
const { LibroCompraVenta, Certificado } = require('@devlas/dte-sii')

const libro = new LibroCompraVenta()
libro.setCaratula({
  RutEmisorLibro: '76354771-K',
  RutEnvia:       '76354771-K',
  PeriodoTributario: '2024-06',
  FchResol: '2024-01-15', NroResol: 123,
  TipoOperacion: 'VENTA',  // o 'COMPRA'
  TipoLibro: 'MENSUAL',
  TipoEnvio: 'TOTAL',
  FolioNotificacion: 0,
})
libro.setResumen({ /* datos del resumen */ })
libro.setDetalle([ /* array de documentos */ ])
libro.generar().firmar(cert)

const enviador = new EnviadorSII(cert, 'produccion')
await enviador.enviarLibroSoap(libro)
```

### ConsumoFolio (RCOF)

El RCOF es obligatorio para boletas y debe enviarse **antes de las 08:00 del día siguiente**.

```javascript
const { ConsumoFolio, CAF, Certificado } = require('@devlas/dte-sii')

const rcof = new ConsumoFolio()
rcof.setCaratula({
  RutEmisor:  '76354771-K',
  FchResol:   '2024-01-15',
  NroResol:   0,
  FchInicio:  '2024-06-15',
  FchFinal:   '2024-06-15',
  SecEnvio:   1,
  TmstFirmaEnv: new Date().toISOString(),
})
rcof.agregar(dte, caf)
rcof.generar().firmar(cert)

const enviador = new EnviadorSII(cert, 'produccion')
await enviador.enviarRcofSoap(rcof)
```

---

## Gestión de folios

Los folios son el recurso más crítico del ciclo de facturación: sin folio válido no hay DTE. La librería provee tres capas que se complementan:

| Capa | Clase | Responsabilidad |
|------|-------|-----------------|
| **Local** | `FolioRegistry` | Asigna y persiste folios desde un CAF ya descargado |
| **SII** | `FolioService` | Consulta, solicita y anula rangos de folios ante el SII |
| **Automática** | `CafSolicitor` | Descarga el XML del CAF nuevo directamente desde el portal SII |

El flujo típico de producción combina las tres: `FolioRegistry` asigna folios del CAF activo; cuando el rango se agota, `CafSolicitor` solicita un CAF nuevo al SII sin intervención humana; si quedan folios sin usar de un CAF anterior, `FolioService` los anula para mantener la contabilidad en orden.

---

### FolioRegistry: registro local

`FolioRegistry` mantiene un JSON en disco que registra qué folios están reservados, usados o pendientes de confirmación. Previene la doble asignación incluso ante reinicios del proceso.

```javascript
const { FolioRegistry, CAF, createCafFingerprint } = require('@devlas/dte-sii')
const fs = require('fs')

const registry    = new FolioRegistry()                    // persiste en disco (JSON)
const cafXml      = fs.readFileSync('caf_33.xml', 'utf8')
const caf         = new CAF(cafXml)
const fingerprint = createCafFingerprint(cafXml)           // hash único del CAF

// Reservar el siguiente folio disponible del rango del CAF
const folio = registry.reserveNextFolio({
  rutEmisor:      '76354771-K',
  tipoDte:        caf.getTipoDTE(),
  folioDesde:     caf.getFolioDesde(),
  folioHasta:     caf.getFolioHasta(),
  ambiente:       'produccion',
  cafFingerprint: fingerprint,
})

// ... generar y enviar el DTE ...

// Marcar folio como enviado al recibir trackId del SII
registry.markFolioSent({
  rutEmisor: '76354771-K', tipoDte: 33, folio,
  folioDesde: caf.getFolioDesde(), folioHasta: caf.getFolioHasta(),
  ambiente: 'produccion', cafFingerprint: fingerprint,
  trackId: '0245283324',
})
```

`resolveCafPath` busca automáticamente el CAF más reciente disponible con folios libres, evitando la necesidad de hardcodear rutas:

```javascript
const { resolveCafPath } = require('@devlas/dte-sii')

const cafPath = resolveCafPath({
  tipoDte:       33,
  rutEmisor:     '76354771-K',
  requiredCount: 1,          // necesito al menos 1 folio disponible
  ambiente:      'produccion',
})
const cafXml = fs.readFileSync(cafPath, 'utf8')
```

---

### FolioService: consulta, solicitud y anulación ante el SII

`FolioService` se comunica directamente con el SII para operar sobre folios: consultar el estado actual, solicitar un nuevo rango o anular folios no utilizados.

```javascript
const { FolioService, Certificado } = require('@devlas/dte-sii')

const service = new FolioService({
  ambiente:    'produccion',
  rutEmisor:   '76354771-K',
  certificado: new Certificado(fs.readFileSync('empresa.pfx'), 'clave'),
})

// Consultar cuántos folios quedan y cuál fue el último emitido
const info = await service.consultarFolios({ tipoDte: 33 })
console.log('Último folio final:', info.ultimoFolioFinal)
console.log('Folios disponibles:', info.foliosDisponibles)

// Solicitar un nuevo rango de folios al SII
await service.solicitar({ tipoDte: 33, cantidad: 100 })

// Anular folios que nunca se usaron (evita descuadres en el SII)
await service.anularFolios({
  tipoDte:    33,
  folioDesde: 50,
  folioHasta: 60,
  motivo:     'Folios no utilizados por cambio de CAF',
})
```

---

### CafSolicitor: obtención automática de CAF

`CafSolicitor` automatiza la descarga del XML del CAF desde el portal SII usando el certificado PFX, sin intervención manual. Es la pieza que cierra el ciclo de reposición automática de folios.

```javascript
const { CafSolicitor, Certificado } = require('@devlas/dte-sii')

const solicitor = new CafSolicitor({
  certificado: new Certificado(fs.readFileSync('empresa.pfx'), 'clave'),
  ambiente:    'produccion',
})

const cafXml = await solicitor.solicitar({ tipoDte: 33, cantidad: 200 })
fs.writeFileSync('caf_33_nuevo.xml', cafXml)
```

---

### Ciclo completo automatizado

El siguiente patrón implementa reposición y limpieza de folios sin intervención humana. Se recomienda ejecutarlo como un job periódico o al detectar que el CAF activo está por agotarse.

```javascript
const {
  FolioRegistry, FolioService, CafSolicitor, CAF,
  Certificado, createCafFingerprint, resolveCafPath,
} = require('@devlas/dte-sii')
const fs   = require('fs')
const path = require('path')

const CAF_DIR    = path.join(__dirname, 'cafs')
const RUT        = '76354771-K'
const AMBIENTE   = 'produccion'
const TIPO_DTE   = 33
const UMBRAL     = 10   // solicitar nuevo CAF cuando queden menos de N folios
const CANTIDAD   = 200  // folios a solicitar

const cert      = new Certificado(fs.readFileSync('empresa.pfx'), 'clave')
const registry  = new FolioRegistry()
const service   = new FolioService({ ambiente: AMBIENTE, rutEmisor: RUT, certificado: cert })
const solicitor = new CafSolicitor({ certificado: cert, ambiente: AMBIENTE })

async function gestionarFolios() {
  // 1. Consultar estado actual en el SII
  const info = await service.consultarFolios({ tipoDte: TIPO_DTE })
  console.log(`Folios disponibles: ${info.foliosDisponibles}`)

  // 2. Solicitar nuevo CAF si quedan pocos folios
  if (info.foliosDisponibles < UMBRAL) {
    console.log('Solicitando nuevo CAF...')
    const cafXml  = await solicitor.solicitar({ tipoDte: TIPO_DTE, cantidad: CANTIDAD })
    const archivo = path.join(CAF_DIR, `caf_${TIPO_DTE}_${Date.now()}.xml`)
    fs.writeFileSync(archivo, cafXml)
    console.log(`Nuevo CAF guardado en: ${archivo}`)
  }

  // 3. Detectar folios reservados pero nunca enviados (caídos en error)
  //    y anularlos en el SII para mantener la contabilidad limpia
  const pendientes = registry.getFoliosPendientes({ rutEmisor: RUT, tipoDte: TIPO_DTE, ambiente: AMBIENTE })
  for (const rango of pendientes) {
    console.log(`Anulando folios caídos: ${rango.desde}-${rango.hasta}`)
    await service.anularFolios({
      tipoDte:    TIPO_DTE,
      folioDesde: rango.desde,
      folioHasta: rango.hasta,
      motivo:     'Folios reservados no emitidos por error de sistema',
    })
  }
}

// Ejecutar al inicio y luego cada hora
gestionarFolios().catch(console.error)
setInterval(() => gestionarFolios().catch(console.error), 60 * 60 * 1000)
```

**Puntos clave del ciclo automatizado:**

- `FolioRegistry` detecta folios que fueron reservados pero cuyo DTE nunca se envió exitosamente (por crash, timeout, etc.)
- `FolioService.anularFolios` limpia esos folios en el SII, previniendo descuadres en libros y RCOF
- `CafSolicitor` descarga el nuevo CAF directamente, sin necesidad de acceder al portal SII manualmente
- `resolveCafPath` hace que el código de emisión siempre use el CAF vigente, sin cambiar rutas hardcodeadas

---

## Sesión y autenticación con el SII

### SiiPortalAuth: autenticación al portal

Obtiene datos de empresa (nro_resol, fch_resol) directamente desde el portal SII usando el certificado PFX. Usa el patrón Singleton por certificado para evitar el límite de sesiones del SII.

```javascript
const { SiiPortalAuth, Certificado } = require('@devlas/dte-sii')

const cert  = new Certificado(fs.readFileSync('empresa.pfx'), 'clave')
const auth  = new SiiPortalAuth(cert)

await auth.autenticar()
const datos = await auth.obtenerDatosEmpresa()
// datos.nro_resol   → número de resolución
// datos.fch_resol   → fecha de resolución (AAAA-MM-DD)
// datos.razon_social, datos.giro, etc.

// Reutilizar sesión entre componentes (evita múltiples logins)
const cookies = await SiiPortalAuth.getCookieStringForPfx(cert)
```

### SiiSession: sesiones HTTP autenticadas

```javascript
const { SiiSession, Certificado } = require('@devlas/dte-sii')

const session = new SiiSession(new Certificado(fs.readFileSync('empresa.pfx'), 'clave'))
await session.loginWithCertificate()
const resp = await session.request('GET', 'https://herculesr.sii.cl/...')
```

---

## Aceptación y reclamo de DTE (WsReclamo)

`WsReclamo` implementa el web service `WSRECLAMO` del SII (v1.2) para registrar eventos de aceptación/rechazo de DTE por parte del receptor.

> `WsReclamo` no se re-exporta desde `index.js`. Importar directamente:

```javascript
const WsReclamo = require('@devlas/dte-sii/WsReclamo')
const { Certificado } = require('@devlas/dte-sii')

const ws = new WsReclamo(new Certificado(fs.readFileSync('empresa.pfx'), 'clave'), 'produccion')

// Consultar historial de eventos de un DTE
const eventos = await ws.listarEventosHistDoc({
  rutEmisor:   '76354771-K',
  tipoDTE:     33,
  folio:       1,
  rutReceptor: '12345678-9',
})

// Consultar estado desde la perspectiva del receptor
const estado = await ws.consultarEstadoReceptor({ ... })

// Registrar aceptación (ACD) o reclamo (RCD)
await ws.ingresarAceptacion({
  rutEmisor: '76354771-K', tipoDTE: 33, folio: 1,
  accion: 'ACD', // ACD=Aceptado, RCD=Reclamado, ERM=Otorga Mercaderías
})
```

---

## Estados SII: Interpretación de respuestas

`EnviadorSII` clasifica automáticamente cada código en `esExitoso`, `esIntermedio` o `esRechazado`.

### QueryEstUp - Estado del sobre de envío

| Código | Descripción | `esExitoso` | `esIntermedio` | `esRechazado` |
|--------|-------------|:-----------:|:--------------:|:-------------:|
| `EPR`  | Envío Procesado | ✓ | | |
| `RPR`  | Procesado con Reparos | ✓ | | |
| `REC` / `SOK` / `FOK` / `CRT` / `PRD` / `PDR` | En proceso de validación | | ✓ | |
| `RSC`  | Error en Schema XML | | | ✓ |
| `RFR`  | Error en Firma Digital | | | ✓ |
| `RCT`  | Error en Carátula | | | ✓ |

### QueryEstDte - Estado del DTE individual

| Código | Descripción | Clasificación |
|--------|-------------|---------------|
| `DOK`  | Datos coinciden | ✓ Exitoso |
| `DNK`  | Datos no coinciden | ~ Intermedio |
| `FAU`  | Folio no autorizado | ✗ Rechazado |
| `FNA`  | Emisor no habilitado | ✗ Rechazado |
| `FAN` / `AND` / `ANC` | Anulado | ✗ Rechazado |
| `EMP`  | Empresa sin autorización | ✗ Rechazado |

### Códigos de error de consulta (-1 a -14)

Los valores negativos son **errores del servidor de consulta del SII**, no rechazo del documento. Resultan en `esIntermedio = true` y pueden reintentarse.

---

## Manejo de errores

Todos los errores operacionales lanzan `DteSiiError` con las propiedades:

| Propiedad | Descripción |
|-----------|-------------|
| `code`    | Código de error (`CERT_ERROR`, `DTE_ERROR`, `SII_ERROR`, etc.) |
| `message` | Mensaje descriptivo |
| `cause`   | Error original (si aplica) |

```javascript
const { DteSiiError } = require('@devlas/dte-sii')

try {
  await enviador.enviarDteSoap(envio)
} catch (err) {
  if (err instanceof DteSiiError) {
    console.error(`[${err.code}] ${err.message}`)
  }
}
```

---

## Configuración global y reintentos

```javascript
const { configure, configureRetry } = require('@devlas/dte-sii')

// Configuración global (aplicar al inicio de la app)
configure({
  ambiente:          'produccion',  // 'produccion' | 'certificacion'
  defaultRutEmisor:  '76354771-K',
  tokenCacheTtlMs:   300_000,       // 5 minutos (default)
})

// Lógica de reintentos para llamadas al SII
configureRetry({
  maxAttempts:     3,
  initialDelayMs:  1_000,
  backoffFactor:   2,
  retryOn:         ['SII_TIMEOUT', 'SII_SERVER_ERROR'],
})
```

---

## Utilidades

Accesibles como named exports o mediante el namespace `utils`:

```javascript
const {
  // RUT
  formatRut, validarRut, calcularDV, splitRut,
  // Sanitización
  sanitizeSiiText, sanitizeRazonSocial, sanitizeNombreItem,
  // XML
  parseXml, parseXmlNoNs, buildXml, formatBase64InXml,
  // Cálculos monetarios
  calcularTotalesDesdeItems, calcularMontoItem, buildDetalle,
  // Construcción de entidades
  buildEmisor, normalizeEmisor, validarEmisor,
  buildReceptor, normalizeReceptor, RECEPTOR_CONSUMIDOR_FINAL,
  buildDocReferencia, buildReferenciasNcNd,
  createResolucion, createResolucionCertificacion,
  // Constantes
  TIPOS_DTE, TIPOS_BOLETA, NOMBRES_DTE, TASA_IVA,
  // Folios
  createCafFingerprint, findLatestCaf, resolveCafPath,
  // Endpoints SII
  SOAP_ENDPOINTS, REST_ENDPOINTS, getHost,
  // Token cache
  getCachedToken, setCachedToken, pruneExpiredTokens,
  // Logging
  logger, configureLogger, createScopedLogger,
} = require('@devlas/dte-sii')
```

### Tabla de referencia rápida

| Función / Constante | Descripción |
|---------------------|-------------|
| `formatRut(rut)` | Formatea RUT chileno con puntos y guion |
| `validarRut(rut)` | Valida dígito verificador |
| `calcularDV(rut)` | Calcula dígito verificador de un RUT |
| `sanitizeSiiText(str)` | Elimina caracteres no aceptados por el SII |
| `sanitizeRazonSocial(str)` | Sanitiza razones sociales |
| `sanitizeNombreItem(str)` | Sanitiza nombres de ítems |
| `calcularTotalesDesdeItems(items)` | Calcula MntNeto, IVA, MntTotal |
| `buildEmisor(data)` | Construye nodo `<Emisor>` |
| `buildReceptor(data)` | Construye nodo `<Receptor>` |
| `RECEPTOR_CONSUMIDOR_FINAL` | Objeto receptor para boletas sin RUT receptor |
| `TASA_IVA` | `0.19` (IVA Chile) |
| `TIPOS_DTE` | `{ FACTURA: 33, FACTURA_EXENTA: 34, ... }` |
| `NOMBRES_DTE` | Mapeo código → nombre legible |
| `createCafFingerprint(xml)` | Hash único de un CAF (para FolioRegistry) |
| `findLatestCaf(tipoDte, dir)` | Busca el CAF más reciente en un directorio |
| `resolveCafPath(opts)` | Resuelve ruta de CAF con validación de folios disponibles |
| `getHost(ambiente)` | URL base del host SII según ambiente |

---

## Uso desde proyectos ESM (interop)

Esta librería es **CommonJS**. Para usarla desde un proyecto ESM (Node.js nativo o `"type": "module"`):

```javascript
// Node.js ESM puro
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { Certificado, CAF, DTE, EnviadorSII } = require('@devlas/dte-sii')
```

**TypeScript con ESM** (patrón usado en `devlas-cloud-api-node`):

```typescript
import { createRequire } from 'module'
const _require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { Certificado, CAF, DTE } = _require('@devlas/dte-sii') as Record<string, new (...a: any[]) => any>

// WsReclamo se importa directamente (no está en index.js):
const WsReclamo = _require('@devlas/dte-sii/WsReclamo')
```

---

## TypeScript

La librería incluye tipos completos en `dte-sii.d.ts`. Interfaces principales:

```typescript
import type {
  // Entidades
  Emisor, Receptor, DetalleItem, Totales,
  // DTEs
  DteDatos, DteSimplificado,
  // Configuración
  GlobalConfig, RetryConfig, TokenCacheConfig,
  // Errores
  DteSiiError,
} from '@devlas/dte-sii'
```

---

## Referencia de clases

### Clases principales

| Clase | Archivo | Descripción |
|-------|---------|-------------|
| `Certificado` | `Certificado.js` | Carga y gestiona certificados digitales PFX/P12; valida expiración |
| `CAF` | `CAF.js` | Parsea CAF XML; valida rango de folios; firma TED |
| `DTE` | `DTE.js` | Genera, timbra y firma documentos tributarios (todos los tipos) |
| `Signer` | `Signer.js` | Firma XML-DSig compatible con SII (C14N + RSA-SHA1) |
| `EnvioDTE` | `Envio.js` | Sobre XML para facturas, guías y notas |
| `EnvioBOLETA` | `Envio.js` | Sobre XML para boletas electrónicas |
| `EnviadorSII` | `EnviadorSII.js` | Comunicación SOAP/REST con el SII; caché de tokens; reintentos |

### Servicios y gestión de folios

| Clase | Archivo | Descripción |
|-------|---------|-------------|
| `BoletaService` | `BoletaService.js` | Flujo simplificado para crear boletas electrónicas |
| `FolioRegistry` | `FolioRegistry.js` | Registro local JSON de folios reservados/enviados |
| `FolioService` | `FolioService.js` | Consulta, solicita y anula folios ante el SII |
| `CafSolicitor` | `CafSolicitor.js` | Solicitud automatizada de CAF al SII |
| `SiiSession` | `SiiSession.js` | Sesiones HTTP autenticadas con certificado (cookie jar) |
| `SiiPortalAuth` | `SiiPortalAuth.js` | Autenticación al portal SII; obtiene datos de empresa; Singleton por cert |

### Libros y reportes

| Clase | Archivo | Descripción |
|-------|---------|-------------|
| `ConsumoFolio` | `ConsumoFolio.js` | RCOF (Resumen Consumo de Folios) para boletas |
| `LibroCompraVenta` | `LibroCompraVenta.js` | Libro electrónico de compras/ventas |
| `LibroGuia` | `LibroGuia.js` | Libro electrónico de guías de despacho |

### Web services complementarios

| Clase | Archivo | Descripción |
|-------|---------|-------------|
| `WsReclamo` | `WsReclamo.js` | WS WSRECLAMO v1.2: aceptación, reclamo e historial de eventos de DTE |

---

## Estructura de archivos

```
dte-sii/
├── index.js              <- Punto de entrada; re-exporta todas las clases públicas
├── dte-sii.d.ts          <- Definiciones TypeScript (979 líneas)
│
├── Certificado.js        <- PFX/P12 loader
├── CAF.js                <- CAF parser
├── DTE.js                <- Document builder (XML, TED, firma)
├── Signer.js             <- XML-DSig
├── Envio.js              <- EnvioDTE + EnvioBOLETA
├── EnviadorSII.js        <- SOAP/REST con SII; caché tokens; reintentos
│
├── BoletaService.js      <- Flujo simplificado de boletas
├── SiiPortalAuth.js      <- Autenticación portal SII (Singleton)
├── SiiSession.js         <- Sesiones HTTP autenticadas
├── SiiSessionStore.js    <- Persistencia de sesiones
├── CafSolicitor.js       <- Solicitud automatizada de CAF
│
├── FolioRegistry.js      <- Registro local de folios (JSON)
├── FolioService.js       <- Gestión de folios ante el SII
│
├── LibroBase.js          <- Clase base para libros electrónicos
├── LibroCompraVenta.js   <- Libro compras/ventas
├── LibroGuia.js          <- Libro guías de despacho
├── ConsumoFolio.js       <- RCOF
│
├── WsReclamo.js          <- WS aceptación/reclamo de DTE
│
├── utils/                <- 20 módulos de utilidades (RUT, XML, cálculos, etc.)
├── cert/                 <- 19 módulos para automatización de certificación SII
└── docs/                 <- PDFs y XSDs oficiales del SII
```

---

## Certificación SII

El directorio `cert/` contiene los helpers necesarios para ejecutar el proceso de certificación ante el SII. Orquestado por `CertRunner`, incluye:

- Generación de sets básicos, de compra, exentos y guías
- Libros de compras, ventas y guías para certificación
- Envío de boletas de certificación
- Intercambio de DTE entre contribuyentes (simulación)
- Generación de muestras impresas

```javascript
// Uso desde devlas-cloud-api-node
const { CertFolioHelper } = require('@devlas/dte-sii')
```

---

## Ambientes

| Ambiente | Constante | Descripción |
|----------|-----------|-------------|
| `'certificacion'` | - | Apunta a `maullin.sii.cl` - para pruebas y certificación |
| `'produccion'` | - | Apunta a `palena.sii.cl` - producción real |

> Siempre verifica la variable de entorno `SII_AMBIENTE` (o el parámetro `ambiente`) antes de ejecutar código DTE para evitar envíos accidentales a producción.

---

## Licencia

MIT - Copyright (c) 2026 [Devlas SpA](https://devlas.cl)

Implementa el protocolo XML público del SII de Chile.
Inspirada conceptualmente en [LibreDTE de SASCO SpA](https://libredte.cl).
