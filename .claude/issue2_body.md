## Problem

In `server/src/db.ts`, when a user enables SSL the pool is created with:

```ts
ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
```

`rejectUnauthorized: false` disables TLS certificate verification entirely. This means:

- The connection is encrypted in transit, but the server's identity is never checked.
- A man-in-the-middle attacker can present any certificate and the client will accept it.
- Users who enable SSL expecting a secure connection are silently getting a weaker guarantee than they assume.

The same pattern appears in `testConnection` (line 71).

## Why this happens

The current approach is a common workaround for self-signed certificates (e.g. local dev MySQL, RDS with a custom CA). However, silently disabling verification for all SSL connections conflates two separate concerns:
- "encrypt the wire" (always desirable)
- "verify the server is who it claims to be" (also desirable, but requires a trusted CA cert)

## Expected fix

Add a separate `sslMode` option to `ConnectionForm` / `ConnectionConfig` with at least two values:

| Mode | Behaviour |
|---|---|
| `require` | Encrypt; skip certificate verification (current behaviour — useful for self-signed certs) |
| `verify-ca` / `verify-full` | Encrypt + verify the server certificate against the system CA store or a user-supplied CA cert |

At minimum, the UI should make it clear that the current SSL option does **not** verify the server certificate, so users can make an informed choice.

## Files

- `server/src/db.ts` lines 29, 71
- `src/components/ConnectionManager.tsx` (SSL checkbox in the form)
