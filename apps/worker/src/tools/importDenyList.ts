/**
 * B5 — Import deny-list for the GitHub repo importer.
 *
 * Provides a shared module (worker + browser) that tests whether a file path
 * should be blocked from import. Files matching the deny-list are silently
 * skipped and their path is recorded in `skippedReasons` under the key
 * `"denied_sensitive_file"` for audit purposes.
 *
 * The patterns here are intentionally conservative: we block any file whose
 * name or extension commonly carries secrets, private keys, or cloud
 * credentials. False-positives (e.g. `.env.example`) are expected — callers
 * who genuinely need those files must supply an explicit `allowPaths` override.
 */

/**
 * Default deny patterns.
 * Each entry is matched against the **basename** (not full path) of the file.
 * Patterns support one leading `*` glob (prefix wildcard) and one trailing
 * `*` glob (suffix wildcard). Mixed / regex patterns are not supported by
 * design — keep this deterministic and auditable.
 *
 * Covered categories:
 *  - dotenv files  (.env, .env.*, .dev.vars)
 *  - PEM / X.509 private key material  (*.pem, *.key, *.pfx, *.p12)
 *  - SSH private key files  (id_rsa, id_ecdsa, id_ed25519, id_dsa and their variants)
 *  - GCP service-account credential JSON  (gcp-*credentials*.json is covered via
 *    two entries: prefix "gcp-" + suffix "credentials*.json")
 *  - AWS IAM access-key CSV exports  (aws-*.csv)
 *  - npm auth tokens  (.npmrc)
 */
export const DEFAULT_DENY_PATTERNS: readonly string[] = [
  // dotenv family
  ".env",
  ".env.*",
  ".dev.vars",
  // PEM / private key / PKCS
  "*.pem",
  "*.key",
  "*.pfx",
  "*.p12",
  // SSH private keys (no extension — match by prefix)
  "id_rsa",
  "id_rsa.*",
  "id_ecdsa",
  "id_ecdsa.*",
  "id_ed25519",
  "id_ed25519.*",
  "id_dsa",
  "id_dsa.*",
  // GCP service-account credential JSON
  "gcp-*credentials*.json",
  // AWS IAM access-key CSV
  "aws-*.csv",
  // npm auth token file
  ".npmrc",
];

/**
 * Compile an array of glob patterns into a single matcher function.
 *
 * Supported glob syntax (basename only, no path separators):
 *   - Literal match                    e.g. `.env`
 *   - Suffix wildcard (prefix match)   e.g. `.env.*`  → any filename starting with `.env.`
 *   - Prefix wildcard (suffix match)   e.g. `*.pem`   → any filename ending with `.pem`
 *   - Both wildcards                   e.g. `gcp-*credentials*.json`
 *
 * The matcher is intentionally simple — no recursive globs, no character
 * classes — so the logic remains easy to audit.
 */
export function compileDenyMatcher(patterns: readonly string[]): (basename: string) => boolean {
  // Pre-compile each pattern into a fast predicate.
  const predicates = patterns.map((pat) => patternToPredicate(pat));
  return (basename: string): boolean => predicates.some((p) => p(basename));
}

/**
 * Convert a single glob pattern (basename-only) into a predicate.
 *
 * Handles up to two `*` wildcards (e.g. `gcp-*credentials*.json`).
 * A `*` at position 0 means "any prefix"; a `*` at the last position
 * means "any suffix"; both together means "any substring(s) in the
 * middle section(s)".
 */
function patternToPredicate(pattern: string): (s: string) => boolean {
  // No wildcard — exact match (case-sensitive, as filesystem paths are).
  if (!pattern.includes("*")) {
    return (s) => s === pattern;
  }

  // Split on `*` and turn segments into an anchored subsequence test.
  // For example `gcp-*credentials*.json` splits into
  //   ["gcp-", "credentials", ".json"]
  // We then verify:
  //   s.startsWith("gcp-") && s contains "credentials" after that &&
  //   s.endsWith(".json")
  const parts = pattern.split("*");

  return (s: string): boolean => {
    let cursor = 0;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part === "") continue; // adjacent wildcards — skip empty segment

      if (i === 0) {
        // First segment must be an exact prefix.
        if (!s.startsWith(part)) return false;
        cursor = part.length;
      } else if (i === parts.length - 1) {
        // Last segment must be an exact suffix.
        if (!s.endsWith(part)) return false;
        // Also ensure the suffix doesn't overlap with what we already consumed.
        if (s.length - part.length < cursor) return false;
      } else {
        // Middle segment must appear somewhere at or after `cursor`.
        const idx = s.indexOf(part, cursor);
        if (idx === -1) return false;
        cursor = idx + part.length;
      }
    }
    return true;
  };
}

/**
 * Extract the basename from a forward-slash-separated path.
 * (GitHub tree paths always use `/`.)
 */
export function pathBasename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/**
 * Test whether a file path should be denied.
 *
 * @param filePath  Full tree path (e.g. `config/.env.local`).
 * @param matcher   The compiled deny matcher (from `compileDenyMatcher`).
 * @param allowPaths  Optional set of exact full paths that are explicitly
 *                    allowed even if the basename matches the deny-list.
 *                    Intended for tests or power-user overrides.
 */
export function isDenied(
  filePath: string,
  matcher: (basename: string) => boolean,
  allowPaths?: ReadonlySet<string>
): boolean {
  if (allowPaths?.has(filePath)) return false;
  return matcher(pathBasename(filePath));
}

/** Singleton matcher built from the default patterns (lazy). */
let _defaultMatcher: ((basename: string) => boolean) | undefined;

/** Return the pre-compiled default deny matcher (cached). */
export function defaultDenyMatcher(): (basename: string) => boolean {
  if (!_defaultMatcher) {
    _defaultMatcher = compileDenyMatcher(DEFAULT_DENY_PATTERNS);
  }
  return _defaultMatcher;
}
