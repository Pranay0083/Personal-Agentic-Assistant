import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { ModelConfigError } from '../errors';

/**
 * Validation for user-configured model endpoints (`providers.config.baseUrl`). The hub
 * calls these URLs from its own network with the user's API key, so an unchecked URL is
 * an SSRF vector (cloud metadata, internal services, localhost admin ports).
 *
 * - Always: `https:` only, no credentials in the URL.
 * - Outside production: `http://localhost` / `http://127.0.0.1` / `http://[::1]` are allowed
 *   (Ollama, local gateways).
 * - Production: the host must not be, or resolve to, a private, loopback, link-local,
 *   CGNAT, multicast or otherwise reserved address. Checked when the provider is added
 *   (API) and again right before every call (adapter), since DNS can change.
 */

export type LookupFn = (hostname: string) => Promise<{ address: string; family: number }[]>;

export type BaseUrlPolicy = {
  production: boolean;
  /** DNS resolver; tests inject one. Default: node:dns lookup with `all: true`. */
  lookup?: LookupFn;
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv4');
}
// IPv4-mapped IPv6 (::ffff:a.b.c.d) is matched against the IPv4 rules by BlockList itself.
for (const [net, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv6');
}

/** True if `address` (an IP literal) is private, loopback, link-local or reserved. */
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '');
  const family = isIP(bare);
  if (family === 4) return BLOCKED.check(bare, 'ipv4');
  if (family === 6) return BLOCKED.check(bare, 'ipv6');
  return true; // not an IP: refuse rather than guess
}

/** Synchronous checks on a base URL. Throws ModelConfigError; returns the parsed URL. */
export function validateBaseUrl(raw: string, policy: BaseUrlPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ModelConfigError('baseUrl is not a valid URL');
  }
  if (url.username || url.password) {
    throw new ModelConfigError('baseUrl must not contain credentials');
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol === 'http:') {
    if (policy.production || !LOCAL_HOSTS.has(host)) {
      throw new ModelConfigError(
        policy.production
          ? 'baseUrl must use https'
          : 'baseUrl must use https (http is allowed only for localhost)',
      );
    }
    return url;
  }
  if (url.protocol !== 'https:') throw new ModelConfigError('baseUrl must use https');
  if (policy.production) {
    if (LOCAL_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.local')) {
      throw new ModelConfigError('baseUrl must be a public host');
    }
    if (isIP(host.replace(/^\[|\]$/g, '')) && isBlockedAddress(host)) {
      throw new ModelConfigError('baseUrl must be a public host');
    }
  }
  return url;
}

const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * Production only: resolves the host and refuses if any address is private or reserved.
 * Call right before each request. (A resolver could still answer differently to the SDK a
 * moment later; this closes the common cases: internal names, metadata IPs, rebinding
 * set up at configuration time.)
 */
export async function assertPublicBaseUrl(raw: string, policy: BaseUrlPolicy): Promise<void> {
  const url = validateBaseUrl(raw, policy);
  if (!policy.production) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return; // literal already checked by validateBaseUrl
  let addrs: { address: string }[];
  try {
    addrs = await (policy.lookup ?? defaultLookup)(host);
  } catch {
    throw new ModelConfigError('baseUrl host does not resolve');
  }
  if (addrs.length === 0) throw new ModelConfigError('baseUrl host does not resolve');
  if (addrs.some((a) => isBlockedAddress(a.address))) {
    throw new ModelConfigError('baseUrl resolves to a private or reserved address');
  }
}
