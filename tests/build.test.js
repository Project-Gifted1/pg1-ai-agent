const assert = require('assert');
const {
  createBuildManifest,
  generateSbom,
  calculateChecksum,
  verifyBuildManifest
} = require('../lib/build');

describe('Build Utility', () => {
  it('creates build manifest with target SHA ed9ae853 by default', () => {
    const manifest = createBuildManifest();
    assert.strictEqual(manifest.commitSha, 'ed9ae853');
    assert.strictEqual(manifest.status, 'success');
    assert.ok(manifest.checksum);
  });

  it('generates valid SBOM component list', () => {
    const deps = [{ name: 'lodash', version: '4.17.21' }];
    const sbom = generateSbom(deps);
    assert.strictEqual(sbom.format, 'CycloneDX-Lite');
    assert.strictEqual(sbom.components.length, 1);
    assert.strictEqual(sbom.components[0].name, 'lodash');
  });

  it('verifies intact build manifests', () => {
    const manifest = createBuildManifest({ commitSha: 'ed9ae853', version: '1.2.3' });
    assert.strictEqual(verifyBuildManifest(manifest), true);
  });

  it('rejects tampered build manifests', () => {
    const manifest = createBuildManifest({ commitSha: 'ed9ae853' });
    manifest.version = '9.9.9';
    assert.strictEqual(verifyBuildManifest(manifest), false);
  });
});
