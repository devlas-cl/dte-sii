// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Smoke test de extractRutFromCertificate (utils/pfx.js) sin dependencias
 * de un test runner — se ejecuta con `node test/pfx.test.js`.
 *
 * Cubre el orden de extracción documentado en
 * docs/EXTRACCION_RUT_CERTIFICADO.md: SAN OID 1.3.6.1.4.1.8321.1 primero,
 * luego serialNumber -> OU -> CN como fallback.
 */

const assert = require('assert');
const forge = require('node-forge');
const { extractRutFromCertificate } = require('../utils/pfx');

const RUT_OID = '1.3.6.1.4.1.8321.1';

function buildSanExtension(rut) {
  const rutString = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL, forge.asn1.Type.UTF8, false, rut
  );
  const explicitValue = forge.asn1.create(
    forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [rutString]
  );
  const oidAsn1 = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false,
    forge.asn1.oidToDer(RUT_OID).getBytes()
  );
  const otherName = forge.asn1.create(
    forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [oidAsn1, explicitValue]
  );
  const generalNames = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [otherName]
  );
  return { id: '2.5.29.17', name: 'subjectAltName', critical: false, value: generalNames };
}

function buildCert({ subjectAttrs, sanRut }) {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  cert.setSubject(subjectAttrs);
  cert.setIssuer(subjectAttrs);

  const extensions = [{ name: 'basicConstraints', cA: false }];
  if (sanRut) extensions.push(buildSanExtension(sanRut));
  cert.setExtensions(extensions);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  // Round-trip por DER: un cert armado en memoria no tiene sus extensiones
  // parseadas (altNames, etc). extractRutFromCertificate opera sobre certs
  // ya parseados desde el PFX real, así que replicamos ese camino acá.
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return forge.pki.certificateFromAsn1(forge.asn1.fromDer(der));
}

function run() {
  let passed = 0;

  // Caso Acepta/IDOK: serialNumber presente, coincide con el SAN
  const certSerial = buildCert({
    subjectAttrs: [
      { shortName: 'CN', value: 'Juan Perez' },
      { type: '2.5.4.5', value: '12345678-9' }, // serialNumber (sin shortName en forge)
    ],
    sanRut: '12345678-9',
  });
  assert.strictEqual(extractRutFromCertificate(certSerial), '12345678-9');
  passed++;

  // Caso Signapis histórico: sin SAN, RUT solo en OU, CN sin dígitos
  const certOuOnly = buildCert({
    subjectAttrs: [
      { shortName: 'CN', value: 'Maria Gonzalez' },
      { shortName: 'OU', value: '9876543-2' },
    ],
  });
  assert.strictEqual(extractRutFromCertificate(certOuOnly), '9876543-2');
  passed++;

  // Caso worst-case (el bug original): sin SAN, sin serialNumber, sin OU,
  // CN sin dígitos -> debe devolver null (no reventar)
  const certNoRut = buildCert({
    subjectAttrs: [{ shortName: 'CN', value: 'Pedro Soto' }],
  });
  assert.strictEqual(extractRutFromCertificate(certNoRut), null);
  passed++;

  // SAN presente pero inconsistente con serialNumber -> SAN gana (fuente primaria)
  const certSanWins = buildCert({
    subjectAttrs: [
      { shortName: 'CN', value: 'Ana Diaz' },
      { type: '2.5.4.5', value: '11111111-1' },
    ],
    sanRut: '22222222-2',
  });
  assert.strictEqual(extractRutFromCertificate(certSanWins), '22222222-2');
  passed++;

  console.log(`OK — ${passed} casos pasaron`);
}

run();
