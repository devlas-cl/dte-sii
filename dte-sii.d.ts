/**
 * @devlas/dte-sii - Type Definitions
 *
 * TypeScript declarations for @devlas/dte-sii
 *
 * @version 2.5.3
 */

// ============================================
// COMMON TYPES
// ============================================

export interface Resolucion {
  fch_resol: string;
  nro_resol: number;
}

export interface RutParts {
  numero: string;
  dv: string;
}

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
  error?: string;
}

export interface RutValidation {
  valid: boolean;
  rut: string | null;
  error?: string;
}

// ============================================
// DTE TYPES
// ============================================

export interface Emisor {
  RUTEmisor: string;
  RznSoc?: string;
  RznSocEmisor?: string;
  GiroEmis?: string;
  GiroEmisor?: string;
  Acteco?: number | string;
  Telefono?: string;
  CorreoEmisor?: string;
  DirOrigen: string;
  CmnaOrigen: string;
  CiudadOrigen?: string;
}

export interface Receptor {
  RUTRecep: string;
  RznSocRecep: string;
  GiroRecep?: string;
  DirRecep: string;
  CmnaRecep: string;
  CiudadRecep?: string;
  CorreoRecep?: string;
}

export interface DetalleItem {
  NroLinDet: number;
  IndExe?: number;
  NmbItem: string;
  QtyItem?: number;
  UnmdItem?: string;
  PrcItem?: number | string;
  DescuentoPct?: number;
  DescuentoMonto?: number;
  CodImpAdic?: number;
  MontoItem: number;
}

export interface Referencia {
  NroLinRef: number;
  TpoDocRef: string | number;
  FolioRef: number;
  FchRef: string;
  CodRef?: number;
  RazonRef?: string;
}

export interface Totales {
  MntNeto?: number;
  MntExe?: number;
  TasaIVA?: number;
  IVA?: number;
  ImptoReten?: ImpuestoRetencion[];
  MntTotal: number;
}

export interface ImpuestoRetencion {
  TipoImp: number;
  TasaImp: number;
  MontoImp: number;
}

export interface DscRcgGlobal {
  NroLinDR: number;
  TpoMov: 'D' | 'R';
  GlosaDR: string;
  TpoValor: '%' | '$';
  ValorDR: number;
}

// ============================================
// CONFIG TYPES
// ============================================

export interface EmisorConfig {
  rut: string;
  razonSocial: string;
  giro: string;
  direccion: string;
  comuna: string;
  ciudad?: string;
  telefono?: string;
  correo?: string;
  acteco?: number | string;
}

export interface ReceptorConfig {
  rut: string;
  razonSocial: string;
  giro?: string;
  direccion: string;
  comuna: string;
  ciudad?: string;
  correo?: string;
}

export interface ItemSimple {
  nombre: string;
  cantidad?: number;
  precio?: number;
  unidad?: string;
  exento?: boolean;
  descuentoPct?: number;
}

// ============================================
// CALCULO OPTIONS
// ============================================

export interface TotalesOptions {
  tasaIva?: number;
  descuentoGlobalPct?: number;
  preciosNetos?: boolean;
  soloExento?: boolean;
  conRetencion?: boolean;
  tipoImpRetencion?: number;
}

export interface TotalesDesdeDetalleOptions {
  tasaIva?: number;
  preciosNetos?: boolean;
  conRetencion?: boolean;
  sinValores?: boolean;
}

export interface BuildDetalleOptions {
  allowIndExe?: boolean;
  codImpAdic?: number | null;
  forcePriced?: boolean;
  includeUnidad?: boolean;
  sanitize?: (text: string) => string;
}

export interface TotalesResult {
  totales: Totales;
  descuentoGlobalMonto: number;
}

export interface MontoItemResult {
  base: number;
  descuentoMonto: number;
  montoItem: number;
}

// ============================================
// ERROR TYPES
// ============================================

export interface ErrorDetails {
  [key: string]: any;
}

export const ERROR_CODES: {
  CONFIG_INVALID: 'CONFIG_INVALID';
  CONFIG_MISSING: 'CONFIG_MISSING';
  CERT_NOT_FOUND: 'CERT_NOT_FOUND';
  CERT_INVALID: 'CERT_INVALID';
  CERT_EXPIRED: 'CERT_EXPIRED';
  CERT_PASSWORD_WRONG: 'CERT_PASSWORD_WRONG';
  CAF_NOT_FOUND: 'CAF_NOT_FOUND';
  CAF_INVALID: 'CAF_INVALID';
  CAF_EXPIRED: 'CAF_EXPIRED';
  CAF_NO_FOLIOS: 'CAF_NO_FOLIOS';
  FOLIO_OUT_OF_RANGE: 'FOLIO_OUT_OF_RANGE';
  DTE_INVALID: 'DTE_INVALID';
  DTE_MISSING_FIELDS: 'DTE_MISSING_FIELDS';
  DTE_VALIDATION_FAILED: 'DTE_VALIDATION_FAILED';
  SIGN_FAILED: 'SIGN_FAILED';
  SIGN_VERIFY_FAILED: 'SIGN_VERIFY_FAILED';
  SII_CONNECTION_FAILED: 'SII_CONNECTION_FAILED';
  SII_AUTH_FAILED: 'SII_AUTH_FAILED';
  SII_REJECTED: 'SII_REJECTED';
  SII_TIMEOUT: 'SII_TIMEOUT';
  SII_INVALID_RESPONSE: 'SII_INVALID_RESPONSE';
  XML_PARSE_FAILED: 'XML_PARSE_FAILED';
  XML_BUILD_FAILED: 'XML_BUILD_FAILED';
  UNKNOWN: 'UNKNOWN';
};

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

export class DteSiiError extends Error {
  code: ErrorCode;
  details: ErrorDetails;
  timestamp: string;

  constructor(message: string, code?: ErrorCode, details?: ErrorDetails);
  toJSON(): object;
  toString(): string;
  isSiiError(): boolean;
  isRetryable(): boolean;
}

// ============================================
// REFERENCE TYPES
// ============================================

export interface DocReferenciaParams {
  tipoDte: number;
  folio: number;
  fecha: string;
  codRef: number;
  razonRef: string;
  nroLinRef?: number;
}

export interface AnulacionReferenciaParams {
  tipoDte: number;
  folio: number;
  fecha: string;
  nroLinRef?: number;
}

export interface CorreccionReferenciaParams {
  tipoDte: number;
  folio: number;
  fecha: string;
  razonRef: string;
  nroLinRef?: number;
}

export const CODIGOS_REFERENCIA: {
  ANULA: 1;
  CORRIGE_TEXTO: 2;
  CORRIGE_MONTOS: 3;
};

// ============================================
// METADATA TYPES
// ============================================

export interface EnvioMetadata {
  rutEmisor: string | null;
  rutEnvia: string | null;
  setId: string | null;
  items: EnvioMetadataItem[];
  parseError?: string;
}

export interface EnvioMetadataItem {
  tipoDTE: string | null;
  folio: string | null;
  fchEmis: string | null;
}

export interface SaveEnvioArtifactsParams {
  xml: string;
  responseText?: string;
  responseOk?: boolean;
  responseStatus?: number;
  trackId?: string;
  ambiente?: string;
  tipoEnvio?: string;
  error?: string;
  baseDir?: string;
}

// ============================================
// PFX TYPES
// ============================================

export interface PfxData {
  privateKey: object;
  certificate: object;
  privateKeyPem: string;
  certificatePem: string;
  subject: Record<string, string>;
  rut: string;
  cn: string;
  notBefore: Date;
  notAfter: Date;
}

// ============================================
// TOKEN CACHE TYPES
// ============================================

export interface TokenCacheEntry {
  key: string;
  ambiente: string;
  tipo: string;
  rutEmisor: string;
  createdAt: string;
  expiresAt: string;
  isExpired: boolean;
  remainingMinutes: number;
}

export interface TokenCacheStats {
  total: number;
  active: number;
  expired: number;
  entries: TokenCacheEntry[];
}

// ============================================
// CONFIG TYPES (global)
// ============================================

export interface RetryConfig {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
  retryableStatusCodes?: number[];
  retryableErrors?: string[];
}

export interface TokenCacheConfig {
  enabled?: boolean;
  ttlMinutes?: number;
}

export interface TimeoutConfig {
  soap?: number;
  rest?: number;
  upload?: number;
}

export interface DebugConfig {
  saveArtifacts?: boolean;
  logLevel?: string;
}

export interface GlobalConfig {
  retry?: RetryConfig;
  tokenCache?: TokenCacheConfig;
  timeout?: TimeoutConfig;
  debug?: DebugConfig;
}

export const DEFAULT_CONFIG: Required<GlobalConfig>;

// ============================================
// LOGGER TYPES
// ============================================

export const LOG_LEVELS: {
  SILENT: 0;
  ERROR: 1;
  WARN: 2;
  INFO: 3;
  DEBUG: 4;
  TRACE: 5;
};

export type LogLevel = keyof typeof LOG_LEVELS;

export interface LoggerConfig {
  level?: LogLevel | number;
  prefix?: string;
  timestamps?: boolean;
  colors?: boolean;
}

export interface Logger {
  error(...args: any[]): void;
  warn(...args: any[]): void;
  info(...args: any[]): void;
  debug(...args: any[]): void;
  trace(...args: any[]): void;
  log(...args: any[]): void;
}

export interface ScopedLogger extends Logger {
  scope: string;
}

// ============================================
// ENDPOINTS TYPES
// ============================================

export const HOSTS: {
  certificacion: string;
  produccion: string;
};

export const SOAP_ENDPOINTS: {
  certificacion: { seed: string; token: string; upload: string; estado: string; estadoDte: string };
  produccion: { seed: string; token: string; upload: string; estado: string; estadoDte: string };
};

export const REST_ENDPOINTS: {
  certificacion: { semilla: string; token: string; envio: string; estado: string };
  produccion: { semilla: string; token: string; envio: string; estado: string };
};

export const CERT_ENDPOINTS: Record<string, string>;

// ============================================
// CONSTANTS TYPES
// ============================================

export const TIPOS_DTE: {
  FACTURA: 33;
  FACTURA_ELECTRONICA: 33;
  FACTURA_EXENTA: 34;
  FACTURA_EXENTA_ELECTRONICA: 34;
  BOLETA: 39;
  BOLETA_ELECTRONICA: 39;
  BOLETA_EXENTA: 41;
  BOLETA_EXENTA_ELECTRONICA: 41;
  LIQUIDACION_FACTURA: 43;
  FACTURA_COMPRA: 46;
  FACTURA_COMPRA_ELECTRONICA: 46;
  GUIA_DESPACHO: 52;
  GUIA_DESPACHO_ELECTRONICA: 52;
  NOTA_DEBITO: 56;
  NOTA_DEBITO_ELECTRONICA: 56;
  NOTA_CREDITO: 61;
  NOTA_CREDITO_ELECTRONICA: 61;
};

export const TIPOS_BOLETA: number[];
export const TIPOS_EXENTOS: number[];
export const NOMBRES_DTE: Record<number, string>;
export const TASA_IVA: number;
export const IDK_CERTIFICACION: number;

// ============================================
// CORE CLASSES
// ============================================

export class Certificado {
  rut: string;
  nombre: string;
  cert: object;
  privateKey: object;

  constructor(pfxBuffer: Buffer, password: string);

  getPrivateKeyPem(): string;
  getCertificatePem(): string;
  getPrivateKeyPEM(): string;
  getCertificatePEM(): string;
  getCertificateBase64(): string;
  getModulus(): string;
  getExponent(): string;
  sign(data: string, encoding?: string): string;
}

export class CAF {
  tipo: number;
  folioDesde: number;
  folioHasta: number;
  rutEmisor: string;
  privateKeyPem: string;
  privateKey: object;
  data: object;

  constructor(xmlContent: string);

  getRutEmisor(): string;
  getTipoDTE(): number;
  getFolioDesde(): number;
  getFolioHasta(): number;
  getIDK(): number;
  esCertificacion(): boolean;
  getNombreTipoDTE(corto?: boolean): string;
  getCafXml(): string;
  sign(data: string): string;
  isFolioValido(folio: number): boolean;
  validarFolio(folio: number): void;
  getFoliosDisponibles(): number;
}

export interface DteDatos {
  Encabezado: {
    IdDoc: {
      TipoDTE: number;
      Folio: number;
      FchEmis: string;
      [key: string]: any;
    };
    Emisor: Emisor;
    Receptor: Receptor;
    Totales: Totales;
  };
  Detalle?: DetalleItem[];
  DscRcgGlobal?: DscRcgGlobal[];
  Referencia?: Referencia[];
}

export interface DteSimplificado {
  tipo: number;
  folio: number;
  fechaEmision?: string;
  emisor: EmisorConfig;
  receptor?: ReceptorConfig;
  items: ItemSimple[];
  referencias?: Referencia[];
  certificado?: Certificado;
  caf?: CAF;
  [key: string]: any;
}

export class DTE {
  datos: DteDatos;
  montoTotal: number;
  fechaEmision: string | undefined;
  xml: string | null;
  tedXml: string | null;
  tmstFirma: string | null;

  constructor(datos: DteDatos | DteSimplificado);

  generarXML(): string;
  timbrar(caf: CAF): string;
  firmar(certificado: Certificado): string;
  getXML(): string;
  getTipoDTE(): number;
  getFolio(): number;
}

export class Signer {
  certificado: Certificado;

  constructor(certificado: Certificado);

  firmarSetDTE(xmlSinFirma: string, setId: string, rootTag: string): string;
  firmarDocumento(xmlSinFirma: string, docId: string): string;
}

export interface EnvioConfig {
  certificado: Certificado;
  rutEmisor: string;
  rutEnvia: string;
  fchResol: string;
  nroResol: number;
  ambiente?: 'certificacion' | 'produccion';
}

export class EnvioDTE {
  constructor(config: EnvioConfig);
  agregar(dte: DTE): this;
  generar(): string;
  getXML(): string;
}

export class EnvioBOLETA {
  constructor(config: EnvioConfig);
  agregar(dte: DTE): this;
  generar(): string;
  getXML(): string;
}

// ============================================
// SERVICES
// ============================================

export class BoletaService {
  constructor(config: object);
  emitir(datos: object): Promise<object>;
}

export interface EnviadorSIIConfig {
  certificado: Certificado;
  rutEmisor: string;
  ambiente?: 'certificacion' | 'produccion';
}

export class EnviadorSII {
  constructor(config: EnviadorSIIConfig);
  enviar(envio: EnvioDTE | EnvioBOLETA): Promise<object>;
  consultarEstado(trackId: string): Promise<object>;
  consultarEstadoDte(params: object): Promise<object>;
}

// ============================================
// FOLIO MANAGEMENT
// ============================================

export interface FolioServiceConfig {
  baseDir?: string;
  cafDir?: string;
}

export class FolioService {
  constructor(config?: FolioServiceConfig);
  getNextFolio(tipoDte: number, rutEmisor: string, caf: CAF): Promise<number>;
  markFolioUsed(tipoDte: number, folio: number, rutEmisor: string): Promise<void>;
}

export interface FolioRegistryOptions {
  registryPath?: string;
  baseDir?: string;
}

export interface FolioRegistryEntry {
  folio: number;
  tipoDte: number;
  rutEmisor: string;
  cafFingerprint: string;
  estado: string;
  timestamp: string;
}

export class FolioRegistry {
  registryPath: string;

  constructor(options?: FolioRegistryOptions);

  load(): { version: number; entries: Record<string, FolioRegistryEntry> };
  save(registry: object): void;
  static createCafFingerprint(cafXml: string): string | undefined;
  static findLatestCaf(dir: string, tipoDte: number): string | null;
  static resolveCafPath(baseDir: string, tipoDte: number): string | null;
}

export function createCafFingerprint(cafXml: string): string | undefined;
export function findLatestCaf(dir: string, tipoDte: number): string | null;
export function resolveCafPath(baseDir: string, tipoDte: number): string | null;

export class SiiSession {
  constructor(config: object);
  getToken(tipo?: 'soap' | 'rest'): Promise<string>;
}

export class CafSolicitor {
  constructor(config: object);
  solicitar(tipoDte: number, cantidad?: number): Promise<string>;
}

// ============================================
// BOOKS & REPORTS
// ============================================

export class ConsumoFolio {
  constructor(config: object);
  agregar(dte: object): void;
  generar(): string;
}

export class LibroCompraVenta {
  constructor(config: object);
  agregar(dte: object): void;
  generar(): string;
}

export class LibroGuia {
  constructor(config: object);
  agregar(dte: object): void;
  generar(): string;
}

// ============================================
// CERT HELPERS
// ============================================

export class CertFolioHelper {
  constructor(config: object);
  prepararFolios(tipoDte: number, cantidad: number): Promise<CAF>;
}

// ============================================
// FUNCTION DECLARATIONS
// ============================================

// Sanitizacion
export function sanitizeSiiText(text: string): string;
export function truncateText(text: string, maxLen: number, preserveWords?: boolean): string;
export function sanitizeGiroRecep(giro: string): string;
export function sanitizeRazonSocial(razonSocial: string): string;
export function sanitizeNombreItem(nombre: string): string;
export function sanitizeDescripcionItem(descripcion: string): string;
export function safeSegment(value: any, fallback?: string): string;

// RUT
export function formatRut(rut: string): string;
export function cleanRut(rut: string): string;
export function splitRut(rut: string): RutParts;
export function formatRutWithDots(rut: string): string;
export function formatRutSii(rut: string): string;
export function calcularDV(rutSinDV: string | number): string;
export function validarRut(rut: string): boolean;
export function validateAndFormatRut(rut: string): RutValidation;

// XML
export function formatBase64InXml(xml: string): string;
export function expandSelfClosingTags(xml: string): string;
export function normalizeArray<T>(value: T | T[] | null | undefined): T[];
export function extractEnvioMetadata(xml: string): EnvioMetadata;
export function saveEnvioArtifacts(params: SaveEnvioArtifactsParams): void;
export function parseXml(xml: string): object;
export function parseXmlNoNs(xml: string): object;
export function buildXml(obj: object, pretty?: boolean): string;
export function decodeXmlEntities(xml: string): string;
export function extractTagContent(xml: string, tagName: string): string | null;
export function extractAttribute(xml: string, tagName: string, attrName: string): string | null;

// Resolucion SII
export function normalizeFechaResolucion(value: string): string;
export function createResolucion(fecha: string, numero?: number): Resolucion;
export function createResolucionCertificacion(fecha: string): Resolucion;
export function createResolucionProduccion(fecha: string, numero: number): Resolucion;
export function validarResolucion(resolucion: Resolucion, requireNumero?: boolean): ValidationResult;

// Calculo
export const TASA_IVA_DEFAULT: number;
export function formatDecimal(value: number, decimals?: number): string;
export function calcularMontoItem(cantidad: number, precio: number, descuentoPct?: number): MontoItemResult;
export function calcularTotalesDesdeItems(items: ItemSimple[], options?: TotalesOptions | number): TotalesResult;
export function calcularTotalesDesdeDetalle(detalle: DetalleItem[], options?: TotalesDesdeDetalleOptions): Totales;
export function buildDetalle(items: ItemSimple[], options?: BuildDetalleOptions): DetalleItem[];
export function buildDetalleGuia(items: ItemSimple[], options?: { sanitize?: (v: string) => string }): DetalleItem[];
export function buildDetalleCompra(items: ItemSimple[], options?: BuildDetalleOptions): DetalleItem[];
export function buildDescuentoGlobal(descuentoPct: number, glosa?: string): DscRcgGlobal[] | null;

// Referencia
export function buildSetReferencia(casoId: string, fecha: string, nroLinRef?: number): Referencia;
export function buildDocReferencia(params: DocReferenciaParams): Referencia;
export function buildAnulacionReferencia(params: AnulacionReferenciaParams): Referencia;
export function buildCorreccionTextoReferencia(params: CorreccionReferenciaParams): Referencia;
export function buildCorreccionMontosReferencia(params: CorreccionReferenciaParams): Referencia;
export function buildReferenciasNcNd(casoId: string, fechaEmision: string, docRef: Omit<Referencia, 'NroLinRef'>): Referencia[];

// Emisor
export function buildEmisor(config: EmisorConfig): Emisor;
export function buildEmisorBoleta(config: EmisorConfig): Emisor;
export function normalizeEmisor(emisor: Partial<Emisor>, esBoleta?: boolean): Emisor;
export function validarEmisor(emisor: Partial<Emisor>): ValidationResult;

// Receptor
export const RUT_CONSUMIDOR_FINAL: string;
export const RECEPTOR_CONSUMIDOR_FINAL: Receptor;
export function buildReceptor(config: ReceptorConfig): Receptor;
export function buildReceptorBoleta(config?: Partial<ReceptorConfig>): Receptor;
export function buildReceptorConsumidorFinal(overrides?: Partial<Receptor>): Receptor;
export function normalizeReceptor(receptor: Partial<Receptor> | null, esBoleta?: boolean): Receptor;
export function validarReceptor(receptor: Partial<Receptor>, options?: { requireGiro?: boolean; allowConsumidorFinal?: boolean }): ValidationResult;
export function esConsumidorFinal(receptor: Partial<Receptor>): boolean;

// Constantes DTE
export function esBoleta(tipoDte: number): boolean;
export function esExento(tipoDte: number): boolean;
export function esNota(tipoDte: number): boolean;
export function getNombreDte(tipoDte: number, corto?: boolean): string;
export function esTipoValido(tipoDte: number): boolean;

// Endpoints SII
export function getHost(ambiente: 'certificacion' | 'produccion'): string;
export function getSoapUrl(ambiente: 'certificacion' | 'produccion', endpoint: string): string;
export function getRestUrl(ambiente: 'certificacion' | 'produccion', endpoint: string): string;
export function getCertUrl(endpoint: string): string;
export function validateAmbiente(ambiente: string): void;

// Errores
export function configError(message: string, details?: ErrorDetails): DteSiiError;
export function certError(message: string, code?: ErrorCode, details?: ErrorDetails): DteSiiError;
export function cafError(message: string, code?: ErrorCode, details?: ErrorDetails): DteSiiError;
export function dteError(message: string, details?: ErrorDetails): DteSiiError;
export function siiError(message: string, code?: ErrorCode, details?: ErrorDetails): DteSiiError;
export function xmlError(message: string, details?: ErrorDetails): DteSiiError;
export function wrapError(error: Error, code?: ErrorCode, details?: ErrorDetails): DteSiiError;

// Logger
export const logger: Logger;
export function configureLogger(config: LoggerConfig): void;
export function silenceLogger(): void;
export function enableLogger(): void;
export function getLoggerConfig(): LoggerConfig;
export function createScopedLogger(scope: string): ScopedLogger;

// Configuracion Global
export function getConfig(): Required<GlobalConfig>;
export function getConfigSection<K extends keyof GlobalConfig>(section: K): Required<GlobalConfig>[K];
export function configure(options: GlobalConfig): Required<GlobalConfig>;
export function configureRetry(options: RetryConfig): RetryConfig;
export function configureTokenCache(options: TokenCacheConfig): TokenCacheConfig;
export function configureTimeout(options: TimeoutConfig): TimeoutConfig;
export function resetConfig(): Required<GlobalConfig>;
export function configureForProduction(): Required<GlobalConfig>;
export function configureForDevelopment(): Required<GlobalConfig>;
export function calculateRetryDelay(attempt: number): number;
export function isRetryableError(error: Error): boolean;
export function isRetryableStatus(status: number): boolean;
export function withRetry<T>(fn: () => Promise<T>, options?: RetryConfig): Promise<T>;

// Token Cache
export function getCachedToken(ambiente: string, tipo: string, rutEmisor: string): string | null;
export function setCachedToken(ambiente: string, tipo: string, rutEmisor: string, token: string, ttlMinutes?: number): void;
export function invalidateToken(ambiente: string, tipo: string, rutEmisor: string): void;
export function invalidateAmbiente(ambiente: string): void;
export function invalidateEmisor(rutEmisor: string): void;
export function clearTokenCache(): void;
export function getTokenCacheStats(): TokenCacheStats;
export function pruneExpiredTokens(): number;

// PFX Utils
export function loadPfxFromBuffer(pfxBuffer: Buffer, password: string): PfxData;
export function loadPfxFromFile(filePath: string, password: string): PfxData;
export function extractSubjectFields(certificate: object): Record<string, string>;
export function extractRutFromCertificate(certificate: object): string;
export function isCertificateExpired(notAfter: Date): boolean;
export function getDaysUntilExpiry(notAfter: Date): number;
export function createTlsOptions(certificado: Certificado): object;

// ============================================
// UTILS NAMESPACE
// ============================================

export const utils: {
  sanitizeSiiText: typeof sanitizeSiiText;
  truncateText: typeof truncateText;
  sanitizeGiroRecep: typeof sanitizeGiroRecep;
  sanitizeRazonSocial: typeof sanitizeRazonSocial;
  sanitizeNombreItem: typeof sanitizeNombreItem;
  sanitizeDescripcionItem: typeof sanitizeDescripcionItem;
  safeSegment: typeof safeSegment;

  formatRut: typeof formatRut;
  cleanRut: typeof cleanRut;
  splitRut: typeof splitRut;
  formatRutWithDots: typeof formatRutWithDots;
  formatRutSii: typeof formatRutSii;
  calcularDV: typeof calcularDV;
  validarRut: typeof validarRut;
  validateAndFormatRut: typeof validateAndFormatRut;

  formatBase64InXml: typeof formatBase64InXml;
  expandSelfClosingTags: typeof expandSelfClosingTags;
  normalizeArray: typeof normalizeArray;
  extractEnvioMetadata: typeof extractEnvioMetadata;
  saveEnvioArtifacts: typeof saveEnvioArtifacts;
  parseXml: typeof parseXml;
  parseXmlNoNs: typeof parseXmlNoNs;
  buildXml: typeof buildXml;
  decodeXmlEntities: typeof decodeXmlEntities;
  extractTagContent: typeof extractTagContent;
  extractAttribute: typeof extractAttribute;

  normalizeFechaResolucion: typeof normalizeFechaResolucion;
  createResolucion: typeof createResolucion;
  createResolucionCertificacion: typeof createResolucionCertificacion;
  createResolucionProduccion: typeof createResolucionProduccion;
  validarResolucion: typeof validarResolucion;

  TASA_IVA_DEFAULT: typeof TASA_IVA_DEFAULT;
  formatDecimal: typeof formatDecimal;
  calcularMontoItem: typeof calcularMontoItem;
  calcularTotalesDesdeItems: typeof calcularTotalesDesdeItems;
  calcularTotalesDesdeDetalle: typeof calcularTotalesDesdeDetalle;
  buildDetalle: typeof buildDetalle;
  buildDetalleGuia: typeof buildDetalleGuia;
  buildDetalleCompra: typeof buildDetalleCompra;
  buildDescuentoGlobal: typeof buildDescuentoGlobal;

  buildSetReferencia: typeof buildSetReferencia;
  buildDocReferencia: typeof buildDocReferencia;
  buildAnulacionReferencia: typeof buildAnulacionReferencia;
  buildCorreccionTextoReferencia: typeof buildCorreccionTextoReferencia;
  buildCorreccionMontosReferencia: typeof buildCorreccionMontosReferencia;
  buildReferenciasNcNd: typeof buildReferenciasNcNd;
  CODIGOS_REFERENCIA: typeof CODIGOS_REFERENCIA;

  buildEmisor: typeof buildEmisor;
  buildEmisorBoleta: typeof buildEmisorBoleta;
  normalizeEmisor: typeof normalizeEmisor;
  validarEmisor: typeof validarEmisor;

  RUT_CONSUMIDOR_FINAL: typeof RUT_CONSUMIDOR_FINAL;
  RECEPTOR_CONSUMIDOR_FINAL: typeof RECEPTOR_CONSUMIDOR_FINAL;
  buildReceptor: typeof buildReceptor;
  buildReceptorBoleta: typeof buildReceptorBoleta;
  buildReceptorConsumidorFinal: typeof buildReceptorConsumidorFinal;
  normalizeReceptor: typeof normalizeReceptor;
  validarReceptor: typeof validarReceptor;
  esConsumidorFinal: typeof esConsumidorFinal;

  esBoleta: typeof esBoleta;
  esExento: typeof esExento;
  esNota: typeof esNota;
  getNombreDte: typeof getNombreDte;
  esTipoValido: typeof esTipoValido;

  TIPOS_DTE: typeof TIPOS_DTE;
  TIPOS_BOLETA: typeof TIPOS_BOLETA;
  TIPOS_EXENTOS: typeof TIPOS_EXENTOS;
  NOMBRES_DTE: typeof NOMBRES_DTE;
  TASA_IVA: typeof TASA_IVA;
  IDK_CERTIFICACION: typeof IDK_CERTIFICACION;

  HOSTS: typeof HOSTS;
  SOAP_ENDPOINTS: typeof SOAP_ENDPOINTS;
  REST_ENDPOINTS: typeof REST_ENDPOINTS;
  CERT_ENDPOINTS: typeof CERT_ENDPOINTS;
  getHost: typeof getHost;
  getSoapUrl: typeof getSoapUrl;
  getRestUrl: typeof getRestUrl;
  getCertUrl: typeof getCertUrl;
  validateAmbiente: typeof validateAmbiente;

  DteSiiError: typeof DteSiiError;
  ERROR_CODES: typeof ERROR_CODES;
  configError: typeof configError;
  certError: typeof certError;
  cafError: typeof cafError;
  dteError: typeof dteError;
  siiError: typeof siiError;
  xmlError: typeof xmlError;
  wrapError: typeof wrapError;

  logger: typeof logger;
  LOG_LEVELS: typeof LOG_LEVELS;
  configureLogger: typeof configureLogger;
  silenceLogger: typeof silenceLogger;
  enableLogger: typeof enableLogger;
  getLoggerConfig: typeof getLoggerConfig;
  createScopedLogger: typeof createScopedLogger;

  getConfig: typeof getConfig;
  getConfigSection: typeof getConfigSection;
  configure: typeof configure;
  configureRetry: typeof configureRetry;
  configureTokenCache: typeof configureTokenCache;
  configureTimeout: typeof configureTimeout;
  resetConfig: typeof resetConfig;
  configureForProduction: typeof configureForProduction;
  configureForDevelopment: typeof configureForDevelopment;
  calculateRetryDelay: typeof calculateRetryDelay;
  isRetryableError: typeof isRetryableError;
  isRetryableStatus: typeof isRetryableStatus;
  withRetry: typeof withRetry;
  DEFAULT_CONFIG: typeof DEFAULT_CONFIG;

  getCachedToken: typeof getCachedToken;
  setCachedToken: typeof setCachedToken;
  invalidateToken: typeof invalidateToken;
  invalidateAmbiente: typeof invalidateAmbiente;
  invalidateEmisor: typeof invalidateEmisor;
  clearTokenCache: typeof clearTokenCache;
  getTokenCacheStats: typeof getTokenCacheStats;
  pruneExpiredTokens: typeof pruneExpiredTokens;

  loadPfxFromBuffer: typeof loadPfxFromBuffer;
  loadPfxFromFile: typeof loadPfxFromFile;
  extractSubjectFields: typeof extractSubjectFields;
  extractRutFromCertificate: typeof extractRutFromCertificate;
  isCertificateExpired: typeof isCertificateExpired;
  getDaysUntilExpiry: typeof getDaysUntilExpiry;
  createTlsOptions: typeof createTlsOptions;
};