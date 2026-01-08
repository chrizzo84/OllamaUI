/**
 * Parse an Ollama version string into components
 * @example parseVersion("0.1.45") => { major: 0, minor: 1, patch: 45 }
 */
export function parseVersion(versionString: string): {
  major: number;
  minor: number;
  patch: number;
} {
  const match = versionString.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return { major: 0, minor: 0, patch: 0 };
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

/**
 * Compare two version objects
 * @returns negative if a < b, 0 if equal, positive if a > b
 */
export function compareVersions(
  a: { major: number; minor: number; patch: number },
  b: { major: number; minor: number; patch: number },
): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Check if the Ollama version supports the stop/unload feature
 * Requires Ollama v0.1.33 or later
 */
export function isStopSupported(versionString: string): boolean {
  const version = parseVersion(versionString);
  const minVersion = { major: 0, minor: 1, patch: 33 };
  return compareVersions(version, minVersion) >= 0;
}
