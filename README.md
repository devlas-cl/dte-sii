# @devlas/dte-sii

**Librería de facturación y boletas electrónicas para el SII de Chile.**

Genera, timbra, firma y envía facturas electrónicas, boletas electrónicas, libros contables y automatiza el proceso de certificación ante el SII.

> Desarrollada por [Devlas SpA](https://devlas.cl) y publicada bajo licencia MIT para la comunidad de desarrolladores chilenos.

---

## Instalación

```bash
npm install @devlas/dte-sii
```

## Uso básico

```javascript
const {
  Certificado, CAF, DTE, EnvioDTE, EnvioBOLETA, EnviadorSII,
  ConsumoFolio, LibroCompraVenta, LibroGuia,
} = require('@devlas/dte-sii')

// Cargar certificado digital (.pfx)
const cert = new Certificado(fs.readFileSync('certificado.pfx'), 'contraseña')

// Cargar CAF (folios autorizados)
const caf = new CAF(fs.readFileSync('caf.xml', 'utf8'))

// Crear y timbrar una Factura Electrónica (tipo 33)
const dte = new DTE({ Encabezado: { ... }, Detalle: [ ... ] })
dte.generarXML().timbrar(caf).firmar(cert)

// Enviar al SII
const envio = new EnvioDTE({ certificado: cert })
envio.agregar(dte)
envio.setCaratula({ RutEmisor: '76354771-K', ... })
envio.generar()

const enviador = new EnviadorSII(cert, 'produccion') // o 'certificacion'
const resultado = await enviador.enviarDteSoap(envio)
console.log(resultado.trackId)
```

## Módulos

| Clase | Descripción |
|---|---|
| `Certificado` | Carga y maneja certificados digitales PFX/P12 |
| `CAF` | Código de Autorización de Folios del SII |
| `DTE` | Genera, timbra y firma documentos tributarios |
| `EnvioDTE` | Sobre XML para facturas, guías y notas |
| `EnvioBOLETA` | Sobre XML para boletas electrónicas |
| `EnviadorSII` | Comunicación SOAP/HTTP con el SII |
| `ConsumoFolio` | Genera RCOF (Resumen Consumo de Folios) |
| `LibroCompraVenta` | Libro electrónico de Compra/Venta |
| `LibroGuia` | Libro electrónico de Guías de Despacho |
| `FolioService` | Gestión y solicitud de folios (CAF) |
| `SiiSession` | Sesión autenticada con el portal SII |
| `SiiCertificacion` | Automatización del proceso de certificación |

## Tipos de DTE soportados

| Tipo | Documento |
|---|---|
| 33 | Factura Electrónica |
| 34 | Factura No Afecta o Exenta |
| 39 | Boleta Electrónica Afecta |
| 41 | Boleta Electrónica Exenta |
| 43 | Liquidación Factura |
| 46 | Factura de Compra |
| 52 | Guía de Despacho |
| 56 | Nota de Débito |
| 61 | Nota de Crédito |

## Ambientes

Soporta `'certificacion'` y `'produccion'`. Pasarlo al instanciar `EnviadorSII`.

## Licencia

MIT — Copyright (c) 2026 [Devlas SpA](https://devlas.cl)

Inspirada conceptualmente en [LibreDTE de SASCO SpA](https://libredte.cl).
Implementa el protocolo XML público del SII de Chile.

---

## Estructura de Archivos

```
dte-sii/
├── index.js          # Punto de entrada principal
├── utils.js          # Utilidades y helpers
├── Certificado.js    # Manejo de certificados PFX/P12
├── CAF.js            # Código de Autorización de Folios
├── DTE.js            # Documento Tributario Electrónico
├── Signer.js         # Firma XML-DSig
├── Envio.js          # EnvioBOLETA y EnvioDTE
├── EnviadorSII.js    # Comunicación con servicios SII
├── BoletaService.js  # Servicio simplificado para boletas
├── LibroBase.js      # Clase base para libros
├── ConsumoFolio.js   # RCOF (Resumen Consumo Folios)
├── LibroCompraVenta.js # Libro Compra/Venta
├── LibroGuia.js      # Libro Guías de Despacho
├── FolioService.js   # Gestión integral de folios (solicitar, consultar, anular)
├── FolioRegistry.js  # Registro local de folios usados + helpers
└── SiiSession.js     # Sesiones HTTP autenticadas con el SII
```

## Uso

```javascript
const { 
  DTE, CAF, Certificado, EnvioDTE, EnviadorSII,
  FolioRegistry, createCafFingerprint, resolveCafPath
} = require('@devlas/dte-sii');

// Instancia de registro de folios
const folioRegistry = new FolioRegistry();
```

## Clases Principales

| Clase | Responsabilidad |
|-------|-----------------|
| `Certificado` | Carga y manejo de certificados digitales (.pfx/.p12) |
| `CAF` | Parseado y uso de Códigos de Autorización de Folios |
| `DTE` | Generación, timbraje y firma de documentos |
| `Signer` | Firma XML-DSig compatible con SII |
| `EnvioBOLETA` | Sobre para boletas electrónicas |
| `EnvioDTE` | Sobre para facturas y otros DTEs |
| `EnviadorSII` | Autenticación y envío al SII (REST + SOAP) |
| `BoletaService` | Servicio simplificado para crear boletas |
| `ConsumoFolio` | RCOF - Resumen Consumo de Folios |
| `LibroCompraVenta` | Libro electrónico de compras/ventas |
| `LibroGuia` | Libro electrónico de guías de despacho |

## Gestión de Folios

| Clase/Función | Responsabilidad |
|---------------|-----------------|
| `FolioService` | Servicio para solicitar, consultar y anular folios en el SII |
| `FolioRegistry` | Registro local de folios usados, reservados y enviados |
| `SiiSession` | Sesiones HTTP autenticadas con certificado digital |
| `createCafFingerprint(xml)` | Genera hash único de un CAF |
| `findLatestCaf(tipoDte, dir)` | Busca el CAF más reciente para un tipo de DTE |
| `resolveCafPath(opts)` | Resuelve ruta de CAF con validación de folios |

### Ejemplo de uso de FolioRegistry

```javascript
const { 
  FolioRegistry, CAF, createCafFingerprint, resolveCafPath 
} = require('@devlas/dte-sii');

// Instancia de registro
const folioRegistry = new FolioRegistry();

// Resolver CAF automáticamente
const cafPath = resolveCafPath({
  tipoDte: 33,
  rutEmisor: '78206276-K',
  requiredCount: 1,
  ambiente: 'certificacion',
});

// Cargar CAF
const cafXml = fs.readFileSync(cafPath, 'utf8');
const caf = new CAF(cafXml);
const cafFingerprint = createCafFingerprint(cafXml);

// Reservar próximo folio
const folio = folioRegistry.reserveNextFolio({
  rutEmisor: '78206276-K',
  tipoDte: caf.getTipoDTE(),
  folioDesde: caf.getFolioDesde(),
  folioHasta: caf.getFolioHasta(),
  ambiente: 'certificacion',
  cafFingerprint,
});

// Marcar folio como enviado (después de envío exitoso)
folioRegistry.markFolioSent({
  rutEmisor: '78206276-K',
  tipoDte: caf.getTipoDTE(),
  folio,
  folioDesde: caf.getFolioDesde(),
  folioHasta: caf.getFolioHasta(),
  ambiente: 'certificacion',
  cafFingerprint,
  trackId: '0245283324',
});
```

### Ejemplo de uso de FolioService (avanzado)

```javascript
const { FolioService, Certificado } = require('@devlas/dte-sii');

const certificado = new Certificado('certificado.pfx', 'password');
const folioService = new FolioService({
  ambiente: 'certificacion',
  rutEmisor: '78206276-K',
  certificado: certificado,
});

// Consultar folios en el SII
const consulta = await folioService.consultarFolios({ tipoDte: 33 });
console.log('Último folio:', consulta.ultimoFolioFinal);

// Anular folios no usados
const resultado = await folioService.anularFolios({
  tipoDte: 33,
  folioDesde: 50,
  folioHasta: 60,
  motivo: 'Folios no utilizados',
});
```

## Utilidades

| Función | Descripción |
|---------|-------------|
| `sanitizeSiiText()` | Elimina caracteres problemáticos (apóstrofes, comillas) |
| `formatRut()` | Formatea RUT chileno |
| `calcularDV()` | Calcula dígito verificador |
| `formatBase64InXml()` | Formatea base64 con saltos de línea |

## Filosofía

`@devlas/dte-sii` actúa como **facilitador transparente** entre el usuario y el SII:

1. **Sanitización automática**: El usuario no se preocupa por caracteres especiales
2. **Formatos flexibles**: Acepta datos simplificados o estructurados
3. **Encoding interno**: Maneja UTF-8/ISO-8859-1 automáticamente
4. **Firma automática**: Genera firmas XML-DSig compatibles con SII
5. **Gestión de folios**: Control automático de CAFs, folios y anulaciones
