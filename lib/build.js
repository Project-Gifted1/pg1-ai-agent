const crypto = require('crypto');

/**
 * Generates a Software Bill of Materials (SBOM) structure for dependencies.
 * @param {Array<Object>} dependencies
 * @returns {Object} SBOM structure
 */
function generateSbom(dependencies = []) {
  return {
    format: 'CycloneDX-Lite',
    specVersion: '1.4',
    components: dependencies.map((dep) => ({
      name: dep.name || 'unknown',
      version: dep.version || '0.0.0',
      purl: dep.purl || `pkg:npm/${dep.name}@${dep.version || '0.0.0'}`
    }))
  };
}

/**
 * Calculates a deterministic checksum for build payload integrity.
 * @param {Object} data
 * @returns {string} SHA-256 hash
 */
function calculateChecksum(data) {
  const payload = JSON.stringify({
    commitSha: data.commitSha,
    version: data.version,
    env: data.env,
    sbom: data.sbom
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Creates a build manifest with metadata and integrity checksum.
 * @param {Object} options
 * @returns {Object} Build manifest
 */
function createBuildManifest(options = {}) {
  const commitSha = options.commitSha || 'ed9ae853';
  const version = options.version || '1.0.0';
  const env = options.env || 'production';
  const timestamp = options.timestamp || new Date().toISOString();
  const dependencies = Array.isArray(options.dependencies) ? options.dependencies : [];

  const manifest = {
    buildId: options.buildId || `build-${commitSha}-${Date.now()}`,
    commitSha,
    version,
    env,
    timestamp,
    sbom: generateSbom(dependencies),
    status: 'success'
  };

  manifest.checksum = calculateChecksum(manifest);
  return manifest;
}

/**
 * Verifies whether a build manifest's checksum matches its contents.
 * @param {Object} manifest
 * @returns {boolean}
 */
function verifyBuildManifest(manifest) {
  if (!manifest || !manifest.checksum || !manifest.commitSha) {
    return false;
  }
  const expected = calculateChecksum(manifest);
  return manifest.checksum === expected;
}

module.exports = {
  createBuildManifest,
  generateSbom,
  calculateChecksum,
  verifyBuildManifest
};
