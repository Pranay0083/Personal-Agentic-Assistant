import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';

export const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

/** Pub/Sub push envelope (https://cloud.google.com/pubsub/docs/push). */
export const PubSubPush = z.object({
  message: z
    .object({
      data: z.string(),
      messageId: z.string().optional(),
      message_id: z.string().optional(),
      publishTime: z.string().optional(),
      attributes: z.record(z.string(), z.string()).optional(),
    })
    .refine((m) => !!(m.messageId ?? m.message_id), 'messageId required'),
  subscription: z.string().optional(),
});
export type PubSubPush = z.infer<typeof PubSubPush>;

/** What Gmail publishes: base64 JSON `{emailAddress, historyId}`. */
export const GmailNotification = z.object({
  emailAddress: z.string().min(3),
  historyId: z.union([z.string(), z.number()]).transform((v) => String(v)),
});

export type OidcClaims = {
  iss?: string;
  aud?: string;
  email?: string;
  email_verified?: boolean;
  exp?: number;
  sub?: string;
};

export type OidcVerifyResult = { ok: true; claims: OidcClaims } | { ok: false; reason: string };
export type OidcVerifier = (jwt: string) => Promise<OidcVerifyResult>;

export type PubSubVerifierOptions = {
  audience: string;
  serviceAccountEmail: string;
  /** PEM keys by `kid`. Defaults to Google's federated sign-on certs (cached). */
  getCerts?: () => Promise<Record<string, string>>;
};

/**
 * Verifies the OIDC bearer token Pub/Sub attaches to push requests: signature (Google
 * certs), issuer, audience, expiry, service-account email and email_verified.
 * Reasons are generic and never include the token.
 */
export function createPubSubVerifier(opts: PubSubVerifierOptions): OidcVerifier {
  const client = new OAuth2Client();
  const getCerts =
    opts.getCerts ??
    (async () => (await client.getFederatedSignonCertsAsync()).certs as Record<string, string>);
  return async (jwt) => {
    let claims: OidcClaims | undefined;
    try {
      const certs = await getCerts();
      const ticket = await client.verifySignedJwtWithCertsAsync(
        jwt,
        certs,
        opts.audience,
        GOOGLE_ISSUERS,
      );
      claims = ticket.getPayload() as OidcClaims | undefined;
    } catch {
      // The library's messages can echo the token; keep ours generic.
      return { ok: false, reason: 'invalid token' };
    }
    if (!claims) return { ok: false, reason: 'invalid token' };
    if (claims.email !== opts.serviceAccountEmail) return { ok: false, reason: 'wrong email' };
    if (claims.email_verified !== true) return { ok: false, reason: 'email not verified' };
    return { ok: true, claims };
  };
}

export function bearerToken(headers: Record<string, string | string[] | undefined>) {
  const raw = headers.authorization ?? headers.Authorization;
  const v = Array.isArray(raw) ? raw[0] : raw;
  const m = v ? /^Bearer\s+(.+)$/i.exec(v.trim()) : null;
  return m?.[1] ?? null;
}
