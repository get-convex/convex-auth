/**
 * SSRF host guard shared by the webhook-delivery path and the OIDC/SAML
 * metadata-fetch paths.
 *
 * Validation is scheme-, hostname-, and literal-IP level. It rejects IP literals
 * in loopback / private / link-local / CGNAT / cloud-metadata ranges, internal
 * name suffixes (`localhost`, `*.localhost`, `*.internal`, `*.local`),
 * single-label hosts (per policy), and — best-effort — IPv4 addresses embedded
 * in wildcard-DNS hostnames such as `169-254-169-254.nip.io` or `10.0.0.1.nip.io`
 * (nip.io / sslip.io style "IP-in-hostname" services).
 *
 * IMPORTANT — residual DNS-rebinding window: this guard does NOT resolve DNS, so
 * a public hostname whose A/AAAA record points at a private address *without*
 * encoding it in the label passes here and is only stopped (if at all) by the
 * network layer. Fully closing that window needs resolve-and-pin: resolve the
 * host, verify every returned address is public, then connect to that pinned IP.
 * That requires an async DNS lookup, but this guard is a *synchronous* function
 * reached from Convex queries/mutations/actions where node's `dns` module is not
 * reliably available (the default, non-`"use node"` Convex runtime has no node
 * built-ins) and where making it async would change every caller's signature.
 * Resolve-and-pin is therefore intentionally deferred; the literal-IP,
 * embedded-IP, and single-label checks below are the DNS-independent
 * defense-in-depth. Do NOT add a `dns` / `node:dns` import here — it will not
 * load in the Convex runtime.
 *
 * @module
 */

type Ipv4Kind = "public" | "private" | "loopback" | "linkLocal";

/**
 * Single canonical rejection reason for internal SSRF targets. Kept as one
 * constant so every branch returns byte-identical text (callers and tests match
 * on `/not allowed/`).
 */
const INTERNAL_TARGET_REASON =
  "URL host is not allowed (loopback, private, link-local, or internal target).";

function classifyIpv4(host: string): Ipv4Kind | null {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  const [a, b] = octets;
  if (a === 127 || a === 0) {
    return "loopback";
  }
  if (a === 169 && b === 254) {
    return "linkLocal";
  }
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) {
    return "private";
  }
  if (a === 192 && b === 168) {
    return "private";
  }
  // 100.64.0.0/10 — RFC 6598 carrier-grade NAT / shared address space.
  if (a === 100 && b >= 64 && b <= 127) {
    return "private";
  }
  return "public";
}

function ipv4KindFromMappedIpv6(inner: string): Ipv4Kind | null {
  if (inner.includes(".")) {
    return classifyIpv4(inner);
  }
  const hexGroups = inner.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hexGroups) {
    return null;
  }
  const high = parseInt(hexGroups[1], 16);
  const low = parseInt(hexGroups[2], 16);
  return classifyIpv4(`${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`);
}

/** True when an IPv4 classification is a blocked (non-public) SSRF target. */
function isBlockedIpv4Kind(kind: Ipv4Kind | null): boolean {
  return kind === "loopback" || kind === "linkLocal" || kind === "private";
}

/**
 * Best-effort detection of an IPv4 address embedded in a multi-label hostname,
 * as produced by wildcard-DNS "IP-in-hostname" services (nip.io / sslip.io) that
 * resolve a public-looking name to an operator-chosen A record — e.g.
 * `169-254-169-254.nip.io` → `169.254.169.254`, `10.0.0.1.nip.io` → `10.0.0.1`,
 * or the prefixed `www-10-0-0-1.sslip.io` form.
 *
 * This is a literal scan of the NAME, not DNS resolution. It matches only the
 * two encodings these services use: four consecutive purely-numeric dot-labels
 * (`10.0.0.1.nip.io`), or four consecutive purely-numeric dash-groups inside a
 * single label (`169-254-169-254.nip.io`, `www-10-0-0-1.sslip.io`). Requiring
 * purely-numeric, contiguous octets avoids false positives on public hostnames
 * whose separate labels merely contain digits (e.g. `v10.node0.pool0.dc1.example
 * .com`). Public-IP encodings (ordinary AWS/GCP public reverse DNS such as
 * `ec2-52-1-2-3.compute-1.amazonaws.com`) classify as public and are allowed;
 * only windows forming a private/loopback/link-local/CGNAT address are rejected
 * (fail-closed on the rare collision). A name that resolves to a private address
 * without encoding it in the label (ordinary DNS rebinding) is not detectable
 * here — see the module note. Hex-encoded (`0a000801.nip.io`) and IPv6 wildcard
 * forms are also out of scope.
 */
function embeddedInternalIpv4Reason(hostname: string): string | null {
  // Never scan IPv6 literals: their numeric groups would be misread as octets.
  if (hostname.includes(":")) {
    return null;
  }
  const isOctet = (part: string): boolean => /^[0-9]{1,3}$/.test(part);
  const labels = hostname.split(".");
  // Dotted form: four consecutive purely-numeric labels.
  for (let index = 0; index + 4 <= labels.length; index += 1) {
    const quad = labels.slice(index, index + 4);
    if (quad.every(isOctet) && isBlockedIpv4Kind(classifyIpv4(quad.join(".")))) {
      return INTERNAL_TARGET_REASON;
    }
  }
  // Dash form: four consecutive purely-numeric groups inside one label.
  for (const label of labels) {
    const groups = label.split("-");
    for (let index = 0; index + 4 <= groups.length; index += 1) {
      const quad = groups.slice(index, index + 4);
      if (quad.every(isOctet) && isBlockedIpv4Kind(classifyIpv4(quad.join(".")))) {
        return INTERNAL_TARGET_REASON;
      }
    }
  }
  return null;
}

type FetchUrlPolicy = {
  allowHttp: boolean;
  allowSingleLabelHosts: boolean;
};

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function unsafeHostValueReason(host: string): string | null {
  if (
    host.length === 0 ||
    host.trim() !== host ||
    hasAsciiControlCharacter(host) ||
    host.includes("/") ||
    host.includes("\\") ||
    host.includes("@") ||
    host.includes("://")
  ) {
    return "URL host must be a host value.";
  }
  let parsed: URL;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    return "URL host must be a host value.";
  }
  if (
    parsed.hostname.length === 0 ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return "URL host must be a host value.";
  }
  return null;
}

function unsafeHostReason(
  host: string,
  policy: Pick<FetchUrlPolicy, "allowSingleLabelHosts">,
): string | null {
  let hostname = host.toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  if (hostname.endsWith(".")) {
    hostname = hostname.slice(0, -1);
  }

  if (hostname.length === 0) {
    return "URL is missing a hostname.";
  }
  if (!policy.allowSingleLabelHosts && !hostname.includes(":") && !hostname.includes(".")) {
    return INTERNAL_TARGET_REASON;
  }

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return INTERNAL_TARGET_REASON;
  }
  if (hostname.endsWith(".internal") || hostname.endsWith(".local")) {
    return INTERNAL_TARGET_REASON;
  }

  // Bare IP literals rejected before any DNS: IPv4 (incl. CGNAT), its `::ffff:`
  // mapping, and the IPv6 loopback/unspecified/link-local/ULA ranges.
  if (isBlockedIpv4Kind(classifyIpv4(hostname))) {
    return INTERNAL_TARGET_REASON;
  }
  if (hostname === "::1" || hostname === "::" || hostname === "::0") {
    return INTERNAL_TARGET_REASON;
  }
  const mapped = hostname.match(/^::ffff:(.+)$/);
  if (mapped && isBlockedIpv4Kind(ipv4KindFromMappedIpv6(mapped[1]))) {
    return INTERNAL_TARGET_REASON;
  }
  if (/^fe[89ab][0-9a-f]:/.test(hostname)) {
    return INTERNAL_TARGET_REASON;
  }
  if (/^f[cd][0-9a-f]{2}:/.test(hostname)) {
    return INTERNAL_TARGET_REASON;
  }

  // Wildcard-DNS hostnames that embed a private IPv4 in the label (nip.io /
  // sslip.io). Best-effort literal scan only; see the module note on the
  // residual DNS-rebinding window a full resolve-and-pin would close.
  const embedded = embeddedInternalIpv4Reason(hostname);
  if (embedded !== null) {
    return embedded;
  }

  return null;
}

function unsafeFetchUrlReasonWithPolicy(url: string, policy: FetchUrlPolicy): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "URL is not a valid URL.";
  }

  if (parsed.protocol !== "https:" && !(policy.allowHttp && parsed.protocol === "http:")) {
    return policy.allowHttp
      ? "URL must use the http: or https: scheme."
      : "URL must use the https: scheme.";
  }

  return unsafeHostReason(parsed.hostname, policy);
}

/**
 * Reason an operator-supplied URL is rejected as an SSRF risk, or `null` when it
 * is safe to fetch server-side. Requires the `https:` scheme and rejects
 * single-label hosts plus hostnames that are obviously internal targets:
 * `localhost` and `*.localhost`, `*.internal`, `*.local`, IP literals in
 * loopback/private/link-local/CGNAT ranges (`127.0.0.0/8`, `0.0.0.0/8`, `10/8`,
 * `172.16/12`, `192.168/16`, `100.64/10`, `169.254/16` including the
 * `169.254.169.254` cloud-metadata address, `::1`, `fc00::/7`, `fe80::/10`, and
 * `::ffff:`-mapped IPv4), and IPv4 addresses embedded in wildcard-DNS hostnames
 * (e.g. `169-254-169-254.nip.io`).
 *
 * This is literal validation only; see the module note for the residual
 * DNS-rebinding window it cannot close. Reasons begin with `"URL "` so callers
 * can prefix a subject (e.g. `` `Webhook ${reason}` ``).
 */
export function unsafeFetchUrlReason(url: string): string | null {
  return unsafeFetchUrlReasonWithPolicy(url, {
    allowHttp: false,
    allowSingleLabelHosts: false,
  });
}

/**
 * Reason an IdP discovery/metadata URL is rejected, or `null` when it is safe
 * to fetch server-side.
 *
 * IdP metadata may be served over `http:` by self-hosted deployments, so the
 * `http:` scheme is permitted here (unlike {@link unsafeFetchUrlReason}). Every
 * internal-target host rule still applies, and — hardened for SSRF —
 * single-label hosts are now REJECTED by default (`allowSingleLabelHosts:
 * false`), matching the strict profile. They were previously allowed to support
 * referencing a Dockerized IdP by bare service name (e.g. `http://zitadel:8080`);
 * such deployments must now use a resolvable dotted hostname, because a bare
 * single-label name is an SSRF vector this guard cannot vet without DNS
 * resolution (it can point at internal infra, or via a search domain at a cloud
 * metadata endpoint). `http:` is intentionally kept: it is a transport concern
 * orthogonal to the host-based SSRF filtering above, and dropping it would break
 * legitimate self-hosted-over-http IdPs without closing an SSRF hole. A
 * deployment that wants to forbid `http:` should gate the scheme at its call
 * site.
 */
export function unsafeIdpFetchUrlReason(url: string): string | null {
  return unsafeFetchUrlReasonWithPolicy(url, {
    allowHttp: true,
    allowSingleLabelHosts: false,
  });
}

/**
 * Throw when `url` is an unsafe IdP discovery/metadata fetch target.
 */
export function assertSafeIdpFetchUrl(url: string): void {
  const reason = unsafeIdpFetchUrlReason(url);
  if (reason !== null) {
    throw new Error(`Refusing to fetch ${reason}`);
  }
}

/**
 * Throw when `host` is unsafe to send as a proxy-mode IdP `Host` header. This is
 * a header-value check (reject header injection / malformed values), not an SSRF
 * target check: the Host header is metadata on a request whose actual target
 * (the rewritten URL) is guarded separately by {@link assertSafeIdpFetchUrl}, so
 * loopback/private host values (e.g. a self-hosted IdP issuer on `127.0.0.1`) are
 * allowed — blocking them adds no SSRF protection and breaks self-hosted IdPs.
 */
export function assertSafeIdpHost(host: string): void {
  const reason = unsafeHostValueReason(host);
  if (reason !== null) {
    throw new Error(`Refusing to fetch ${reason}`);
  }
}

/**
 * Throw when `url` is an unsafe public server-side fetch target.
 */
export function assertSafeFetchUrl(url: string): void {
  const reason = unsafeFetchUrlReason(url);
  if (reason !== null) {
    throw new Error(`Refusing to fetch ${reason}`);
  }
}
