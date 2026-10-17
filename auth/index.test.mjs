import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./index.js";

test("health endpoint reports the shared Chi RP ID without requiring database access", async () => {
  const response = await worker.fetch(new Request("https://chi.qzz.io/auth/api/health"), {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "chi-auth",
    rpId: "chi.qzz.io",
    phase: "passkey-core+sso",
  });
});

test("serves the setup and login page with restrictive security headers", async () => {
  const response = await worker.fetch(new Request("https://chi.qzz.io/auth/"), {});
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Security-Policy") || "", /frame-ancestors 'none'/);
  assert.match(await response.text(), /Chi Auth/);
});

test("rejects cross-origin state-changing requests before touching the database", async () => {
  const response = await worker.fetch(new Request("https://chi.qzz.io/auth/api/register/options", {
    method: "POST",
    headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
    body: JSON.stringify({ setupSecret: "irrelevant" }),
  }), {});
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { ok: false, error: "Origin not allowed." });
});

test("does not allow public GET access to state-changing registration endpoints", async () => {
  const response = await worker.fetch(new Request("https://chi.qzz.io/auth/api/register/options"), {});
  assert.equal(response.status, 404);
});

test("rejects OAuth authorization requests without PKCE and state", async () => {
  const response = await worker.fetch(new Request("https://chi.qzz.io/auth/api/authorize"), {});
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Authorization Code \+ PKCE/);
});

test("userinfo requires a bearer token", async () => {
  const response = await worker.fetch(new Request("https://chi.qzz.io/auth/api/userinfo"), {});
  assert.equal(response.status, 401);
});
