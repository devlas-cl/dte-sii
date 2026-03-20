/**
 * @devlas/dte-sii - Type Definitions
 * 
 * TypeScript declarations for @devlas/dte-sii
 * 
 * @version 2.3.0
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
// FUNCTION DECLARATIONS
// ============================================

// Sanitización
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

// Resolución SII
export function normalizeFechaResolucion(value: string): string;
export function createResolucion(fecha: string, numero?: number): Resolucion;
export function createResolucionCertificacion(fecha: string): Resolucion;
export function createResolucionProduccion(fecha: string, numero: number): Resolucion;
export function validarResolucion(resolucion: Resolucion, requireNumero?: boolean): ValidationResult;

// Cálculo
export const TASA_IVA_DEFAULT: number;
export function formatDecimal(value: number, decimals?: number): string;
export function calcularMontoItem(cantidad: number, precio: number, descuentoPct?: number): MontoItemResult;
export function calcularTotalesDesdeItems(items: ItemSimple[], options?: TotalesOptions | number): TotalesResult;
export function calcularTotalesDesdeDetalle(detalle: DetalleItem[], options?: TotalesDesdeDetalleOptions): Totales;
export function buildDetalle(items: ItemSimple[], options?: BuildDetalleOptions): DetalleItem[];
export function buildDetalleGuia(items: ItemSimple[], options?: { sanitize?: (v: string) => string }): DetalleItem[];
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

// Errores
export function configError(message: string, details?: ErrorDetails): DteSiiError;
export function certError(message: string, code?: ErrorCode, details?: ErrorDetails): DteSiiError;
export function cafError(message: string, code?: ErrorCode, details?: ErrorDetails): DteSiiError;
export function dteError(message: string, details?: ErrorDetails): DteSiiError;
export function siiError(message: string, code?: ErrorCode, details?: ErrorDetails): DteSiiError;
export function xmlError(message: string, details?: ErrorDetails): DteSiiError;
export function wrapError(error: Error, code?: ErrorCode, details?: ErrorDetails): DteSiiError;

// ============================================
// UTILS NAMESPACE
// ============================================

export const utils: {
  // Sanitización
  sanitizeSiiText: typeof sanitizeSiiText;
  truncateText: typeof truncateText;
  sanitizeGiroRecep: typeof sanitizeGiroRecep;
  sanitizeRazonSocial: typeof sanitizeRazonSocial;
  sanitizeNombreItem: typeof sanitizeNombreItem;
  sanitizeDescripcionItem: typeof sanitizeDescripcionItem;
  safeSegment: typeof safeSegment;
  
  // RUT
  formatRut: typeof formatRut;
  cleanRut: typeof cleanRut;
  splitRut: typeof splitRut;
  formatRutWithDots: typeof formatRutWithDots;
  formatRutSii: typeof formatRutSii;
  calcularDV: typeof calcularDV;
  validarRut: typeof validarRut;
  validateAndFormatRut: typeof validateAndFormatRut;
  
  // XML
  formatBase64InXml: typeof formatBase64InXml;
  expandSelfClosingTags: typeof expandSelfClosingTags;
  normalizeArray: typeof normalizeArray;
  extractEnvioMetadata: typeof extractEnvioMetadata;
  saveEnvioArtifacts: typeof saveEnvioArtifacts;
  
  // Resolución
  normalizeFechaResolucion: typeof normalizeFechaResolucion;
  createResolucion: typeof createResolucion;
  createResolucionCertificacion: typeof createResolucionCertificacion;
  createResolucionProduccion: typeof createResolucionProduccion;
  validarResolucion: typeof validarResolucion;
  
  // Cálculo
  TASA_IVA_DEFAULT: typeof TASA_IVA_DEFAULT;
  formatDecimal: typeof formatDecimal;
  calcularMontoItem: typeof calcularMontoItem;
  calcularTotalesDesdeItems: typeof calcularTotalesDesdeItems;
  calcularTotalesDesdeDetalle: typeof calcularTotalesDesdeDetalle;
  buildDetalle: typeof buildDetalle;
  buildDetalleGuia: typeof buildDetalleGuia;
  buildDescuentoGlobal: typeof buildDescuentoGlobal;
  
  // Referencia
  buildSetReferencia: typeof buildSetReferencia;
  buildDocReferencia: typeof buildDocReferencia;
  buildAnulacionReferencia: typeof buildAnulacionReferencia;
  buildCorreccionTextoReferencia: typeof buildCorreccionTextoReferencia;
  buildCorreccionMontosReferencia: typeof buildCorreccionMontosReferencia;
  buildReferenciasNcNd: typeof buildReferenciasNcNd;
  CODIGOS_REFERENCIA: typeof CODIGOS_REFERENCIA;
  
  // Emisor
  buildEmisor: typeof buildEmisor;
  buildEmisorBoleta: typeof buildEmisorBoleta;
  normalizeEmisor: typeof normalizeEmisor;
  validarEmisor: typeof validarEmisor;
  
  // Receptor
  RUT_CONSUMIDOR_FINAL: typeof RUT_CONSUMIDOR_FINAL;
  RECEPTOR_CONSUMIDOR_FINAL: typeof RECEPTOR_CONSUMIDOR_FINAL;
  buildReceptor: typeof buildReceptor;
  buildReceptorBoleta: typeof buildReceptorBoleta;
  buildReceptorConsumidorFinal: typeof buildReceptorConsumidorFinal;
  normalizeReceptor: typeof normalizeReceptor;
  validarReceptor: typeof validarReceptor;
  esConsumidorFinal: typeof esConsumidorFinal;
  
  // Errores
  DteSiiError: typeof DteSiiError;
  ERROR_CODES: typeof ERROR_CODES;
  configError: typeof configError;
  certError: typeof certError;
  cafError: typeof cafError;
  dteError: typeof dteError;
  siiError: typeof siiError;
  xmlError: typeof xmlError;
  wrapError: typeof wrapError;
};
