#!/usr/bin/env node
import crypto from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yazl from 'yazl';

const architecture = () => ({ x64: 'amd64', arm64: 'arm64' })[process.arch] ?? 'amd64';

const writeZip = (archive, destination) => new Promise((resolve, reject) => {
  const chunks = [];
  archive.outputStream.on('data', (chunk) => chunks.push(chunk));
  archive.outputStream.on('error', reject);
  archive.outputStream.on('end', async () => {
    try {
      await writeFile(destination, Buffer.concat(chunks), { mode: 0o600 });
      resolve();
    } catch (error) {
      reject(error);
    }
  });
  archive.end();
});

export const buildTestUpdate = async (outputDirectory, {
  version = '0.3.1',
  keyId = 'dev-local',
  tamperArtifact = false,
  extraEntries = [],
  manifestTextTransform = (value) => value,
  includeHomeApk = false,
  serverArtifactKind = 'oci-images',
  includeSupplyChain = false,
  invalidSbom = false,
  sourceRepository = 'example/roomframe',
  sourceRevision = 'a'.repeat(40),
} = {}) => {
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKeyPath = path.join(outputDirectory, `${keyId}.pem`);
  const privateKeyPath = path.join(outputDirectory, `${keyId}-private.pem`);
  const bundlePath = path.join(outputDirectory, `roomframe-test-${version}.rfupdate`);
  await writeFile(publicKeyPath, publicPem, { mode: 0o644 });
  await writeFile(privateKeyPath, privatePem, { mode: 0o600 });
  await chmod(privateKeyPath, 0o600);

  const artifactPath = 'server/test-release.txt';
  const artifact = Buffer.from('RoomFrame signed local test update\n', 'utf8');
  const artifacts = [{
    path: artifactPath,
    sha256: crypto.createHash('sha256').update(artifact).digest('hex'),
    size: artifact.length,
    kind: serverArtifactKind,
  }];
  let sbom = null;
  const sbomPath = `metadata/roomframe-${version}.spdx.json`;
  if (includeSupplyChain) {
    if (serverArtifactKind !== 'server-archive') {
      throw new Error('includeSupplyChain exige serverArtifactKind=server-archive');
    }
    const sbomDocument = {
      spdxVersion: 'SPDX-2.3',
      dataLicense: 'CC0-1.0',
      SPDXID: 'SPDXRef-DOCUMENT',
      name: `RoomFrame TV test ${version}`,
      documentNamespace: `https://roomframe.example/spdx/test/${crypto.randomUUID()}`,
      creationInfo: {
        created: new Date().toISOString(),
        creators: ['Tool: RoomFrame SBOM Generator/test'],
      },
      documentDescribes: ['SPDXRef-Package-RoomFrame'],
      packages: [{
        name: 'roomframe-tv',
        SPDXID: 'SPDXRef-Package-RoomFrame',
        versionInfo: invalidSbom ? '9.9.9' : version,
        downloadLocation: `git+https://github.com/${sourceRepository}.git@${sourceRevision}`,
        filesAnalyzed: false,
        licenseConcluded: 'Apache-2.0',
        licenseDeclared: 'Apache-2.0',
        copyrightText: 'NOASSERTION',
        checksums: [{
          algorithm: 'SHA256',
          checksumValue: crypto.createHash('sha256').update(artifact).digest('hex'),
        }],
      }],
      relationships: [{
        spdxElementId: 'SPDXRef-DOCUMENT',
        relationshipType: 'DESCRIBES',
        relatedSpdxElement: 'SPDXRef-Package-RoomFrame',
      }],
    };
    sbom = Buffer.from(`${JSON.stringify(sbomDocument, null, 2)}\n`, 'utf8');
    artifacts.push({
      path: sbomPath,
      sha256: crypto.createHash('sha256').update(sbom).digest('hex'),
      size: sbom.length,
      kind: 'sbom-spdx',
    });
  }
  const homeApkPath = 'android/roomframe-home-test.apk';
  const homeApk = Buffer.from('RoomFrame local test APK placeholder\n', 'utf8');
  if (includeHomeApk) {
    artifacts.push({
      path: homeApkPath,
      sha256: crypto.createHash('sha256').update(homeApk).digest('hex'),
      size: homeApk.length,
      kind: 'home-apk',
      packageName: 'org.roomframe.tv',
      versionCode: 4,
      signingCertificateSha256: '1'.repeat(64),
    });
  }
  const manifest = {
    formatVersion: 1,
    releaseId: crypto.randomUUID(),
    version,
    createdAt: new Date().toISOString(),
    minimumServerVersion: '0.3.0',
    preservesInstanceData: true,
    architectures: [architecture()],
    signature: {
      algorithm: 'Ed25519',
      keyId,
    },
    migrations: [],
    artifacts,
  };
  if (includeSupplyChain) {
    manifest.source = {
      provider: 'github',
      repository: sourceRepository,
      revision: sourceRevision,
      ref: `refs/tags/v${version}`,
    };
  }
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestBytes = Buffer.from(manifestTextTransform(manifestText), 'utf8');
  const signature = crypto.sign(null, manifestBytes, privateKey);
  const archive = new yazl.ZipFile();
  archive.addBuffer(manifestBytes, 'manifest.json', { compress: false });
  archive.addBuffer(signature, 'manifest.sig', { compress: false });
  archive.addBuffer(
    tamperArtifact ? Buffer.concat([artifact, Buffer.from('tampered\n')]) : artifact,
    artifactPath,
    { compress: true },
  );
  if (includeHomeApk) {
    archive.addBuffer(homeApk, homeApkPath, { compress: true });
  }
  if (sbom) {
    archive.addBuffer(sbom, sbomPath, { compress: true });
  }
  for (const entry of extraEntries) {
    archive.addBuffer(Buffer.from(entry.content ?? ''), entry.path, { compress: true });
  }
  await writeZip(archive, bundlePath);
  return {
    bundlePath,
    publicKeyPath,
    privateKeyPath,
    manifest,
  };
};

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const outputIndex = process.argv.indexOf('--output');
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
  if (!output) {
    throw new Error('usage: node build-test-update.mjs --output /dossier/hors-depot');
  }
  const result = await buildTestUpdate(path.resolve(output));
  console.log(`Bundle de test : ${result.bundlePath}`);
  console.log(`Clé publique   : ${result.publicKeyPath}`);
  console.log(`Clé privée dev : ${result.privateKeyPath} (ne jamais copier dans le dépôt)`);
}
