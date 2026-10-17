# Chi Auth

Chi Auth is the planned shared identity service for the Chi web ecosystem. Its WebAuthn relying-party ID is `chi.qzz.io`, so a Passkey enrolled here can be reused by eligible Chi subdomains after each application integrates with the central flow.

## Implemented in this branch

- Passkey registration and server-side WebAuthn verification with SimpleWebAuthn.
- First-use bootstrap protected by the high-entropy `CHI_AUTH_SETUP_SECRET`.
- Additional backup Passkeys can be enrolled after authenticating with an existing Passkey.
- Short-lived registration/authentication ceremonies bound to their initiating context.
- Random session tokens stored as hashes, issued in a host-only `Secure; HttpOnly; SameSite=Lax` cookie.
- Database-backed per-IP rate limits; IP addresses are hashed before being stored.
- OAuth-style authorization-code + PKCE (S256) flow, exact redirect URI matching, one-time expiring authorization codes, short-lived opaque access tokens, and a minimal userinfo endpoint that can enforce a client-specific audience.
- Authenticated client registry UI, with exact callback URL allowlists and app revocation.

This is not yet a complete production SSO rollout. Existing apps still need a callback handler and must exchange codes using PKCE, validate their own `state`, and establish their own local session. The Chi Status `TRIGGER_SECRET` is intentionally unchanged.

## Before deployment

1. Create a Cloudflare D1 database named `chi-auth` and replace the placeholder `database_id` in `wrangler.toml`.
2. Add a repository Actions secret named `CHI_AUTH_SETUP_SECRET`, generated as a high-entropy random value by a password manager. Never commit or paste it into source.
3. Confirm the Cloudflare zone for `qzz.io` and configure only the route `chi.qzz.io/auth/*`. Do not route the root site to this Worker.
4. After creating the D1 database, replace the placeholder `database_id` in `auth/wrangler.toml`.
5. Run **Actions → Deploy Chi Auth Worker → Run workflow**. The workflow refuses to deploy while the database ID or exact route is unconfigured, then applies the migrations, tests, deploys, and sets the setup secret.
6. Verify Passkey enrollment/login and OAuth PKCE using real browsers, and document a recovery procedure before production use.

## Client integration requirements

- Register each app only after its real callback URL exists. The redirect URI is compared exactly.
- Use Authorization Code + PKCE with `S256`; never use the implicit flow.
- Generate a fresh unpredictable `state` per sign-in and validate it in the callback.
- Keep access tokens in memory where possible; do not put bearer tokens in `localStorage`.
- Treat the short-lived access token as proof of identity only. Every app must still enforce its own authorization rules.
- The userinfo endpoint returns a stable owner subject (`chi-owner`) and display name, not personal account data.

The service is not production-ready until D1 and the route are configured, device tests pass, rate limits and recovery are verified, and each client integration has been reviewed. No production deployment is included in this PR.
