import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "./index.js";

const allowRateLimit = { async limit() { return { success: true }; } };
const env = {
  GITHUB_TOKEN: "test-token",
  TRIGGER_SECRET: "test-secret",
  CHI_AUTH_STATUS_CLIENT_ID: "test-status-client-id",
  IP_RATE_LIMITER: allowRateLimit,
  DISPATCH_RATE_LIMITER: allowRateLimit,
};
const origin = "https://status.chi.qzz.io";

function request(body, { method = "POST", key = "test-secret", bearer = "", requestOrigin = origin, url = "https://worker.example/" } = {}) {
  const headers = new Headers({ Origin: requestOrigin, "CF-Connecting-IP": "203.0.113.10" });
  if (key !== null) headers.set("X-Trigger-Key", key);
  if (bearer) headers.set("Authorization", "Bearer " + bearer);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function jsonResponse(response) {
  return { status: response.status, body: await response.json() };
}


test("blocks requests when the client IP rate limit is exceeded", async () => {
  const blockedEnv = {
    ...env,
    IP_RATE_LIMITER: { async limit() { return { success: false }; } },
  };
  const response = await worker.fetch(request({}), blockedEnv);
  const result = await jsonResponse(response);
  assert.equal(response.status, 429);
  assert.match(result.body.error, /Too many requests/);
});

test("blocks authenticated workflow dispatches over the dispatch quota", async () => {
  const blockedEnv = {
    ...env,
    DISPATCH_RATE_LIMITER: { async limit() { return { success: false }; } },
  };
  const response = await worker.fetch(request({}), blockedEnv);
  const result = await jsonResponse(response);
  assert.equal(response.status, 429);
  assert.match(result.body.error, /Workflow trigger limit/);
});

test("fails closed if the rate limiter is unavailable", async () => {
  const brokenEnv = {
    ...env,
    IP_RATE_LIMITER: { async limit() { throw new Error("private infrastructure detail"); } },
  };
  const response = await worker.fetch(request({}), brokenEnv);
  const result = await jsonResponse(response);
  assert.equal(response.status, 503);
  assert.doesNotMatch(JSON.stringify(result.body), /private infrastructure detail/);
});

test("rejects requests with an unapproved Origin", async () => {
  const response = await worker.fetch(request({}, { requestOrigin: "https://evil.example" }), env);
  assert.equal(response.status, 403);
});

test("rejects a missing or incorrect trigger key", async () => {
  const missing = await worker.fetch(request({}, { key: null }), env);
  const incorrect = await worker.fetch(request({}, { key: "wrong" }), env);
  assert.equal(missing.status, 401);
  assert.equal(incorrect.status, 401);
});

test("rejects dispatch to a workflow outside the allowlist", async () => {
  const response = await worker.fetch(request({ repository: "attacker/repo", workflow: "deploy.yml" }), env);
  assert.equal(response.status, 403);
});

test("rejects non-main refs and unsupported inputs", async () => {
  const wrongRef = await worker.fetch(request({ ref: "feature" }), env);
  const wrongInput = await worker.fetch(request({ repository: "tsai97216/status", workflow: "update-status.yml", inputs: { arbitrary: "value" } }), env);
  assert.equal(wrongRef.status, 400);
  assert.equal(wrongInput.status, 400);
});

test("dispatches an approved workflow with only validated inputs", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return new Response(null, { status: 204 });
  };
  try {
    const response = await worker.fetch(request({
      repository: "tsai97216/chi-source",
      workflow: "main.yml",
      ref: "main",
      inputs: { app: "all" },
    }), env);
    const result = await jsonResponse(response);
    assert.equal(response.status, 202);
    assert.equal(result.body.ok, true);
    assert.match(captured.url, /tsai97216\/chi-source\/actions\/workflows\/main\.yml\/dispatches$/);
    assert.equal(captured.options.headers.Authorization, "Bearer test-token");
    assert.deepEqual(JSON.parse(captured.options.body), { ref: "main", inputs: { app: "all" } });
    assert.ok(captured.options.signal instanceof AbortSignal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns a generic gateway error when GitHub API cannot be reached", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("simulated network failure"); };
  try {
    const response = await worker.fetch(request({}), env);
    const result = await jsonResponse(response);
    assert.equal(response.status, 502);
    assert.equal(result.body.ok, false);
    assert.match(result.body.error, /Could not reach/);
    assert.doesNotMatch(JSON.stringify(result.body), /test-token|test-secret/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handles CORS preflight without requiring credentials or consuming rate limits", async () => {
  let ipLimitCalls = 0;
  let dispatchLimitCalls = 0;
  const testEnv = {
    ...env,
    IP_RATE_LIMITER: { async limit() { ipLimitCalls++; return { success: true }; } },
    DISPATCH_RATE_LIMITER: { async limit() { dispatchLimitCalls++; return { success: true }; } },
  };
  const response = await worker.fetch(request(undefined, { method: "OPTIONS", key: null }), testEnv);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
  assert.match(response.headers.get("Access-Control-Allow-Headers") || "", /X-Trigger-Key/);
  assert.match(response.headers.get("Access-Control-Allow-Headers") || "", /Authorization/);
  assert.equal(ipLimitCalls, 0);
  assert.equal(dispatchLimitCalls, 0);
});

test("catalog GET does not consume the workflow-dispatch quota", async () => {
  let dispatchLimitCalls = 0;
  const testEnv = {
    ...env,
    DISPATCH_RATE_LIMITER: { async limit() { dispatchLimitCalls++; return { success: true }; } },
  };
  const response = await worker.fetch(request(undefined, {
    method: "GET",
    url: "https://worker.example/?action=catalog",
  }), testEnv);
  const result = await jsonResponse(response);
  assert.equal(response.status, 200);
  assert.equal(result.body.ok, true);
  assert.ok(Array.isArray(result.body.workflows));
  assert.equal(dispatchLimitCalls, 0);
});

test("invalid authenticated POST requests do not consume the workflow-dispatch quota", async () => {
  let dispatchLimitCalls = 0;
  const testEnv = {
    ...env,
    DISPATCH_RATE_LIMITER: { async limit() { dispatchLimitCalls++; return { success: true }; } },
  };
  const response = await worker.fetch(request({
    repository: "attacker/repo",
    workflow: "deploy.yml",
    ref: "main",
  }), testEnv);
  assert.equal(response.status, 403);
  assert.equal(dispatchLimitCalls, 0);
});

test("returns a specific safe error when the GitHub API request times out", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new DOMException("simulated timeout", "TimeoutError"); };
  try {
    const response = await worker.fetch(request({}), env);
    const result = await jsonResponse(response);
    assert.equal(response.status, 502);
    assert.equal(result.body.ok, false);
    assert.match(result.body.error, /timed out/i);
    assert.doesNotMatch(JSON.stringify(result.body), /simulated timeout|test-token|test-secret/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("accepts a valid Chi Auth token without requiring the legacy trigger secret", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(String(url), "https://chi.qzz.io/auth/api/userinfo?client_id=test-status-client-id");
    return Response.json({ sub: "chi-owner", name: "Chi Owner", aud: "test-status-client-id" });
  };
  try {
    const response = await worker.fetch(request(undefined, {
      method: "GET",
      key: null,
      bearer: "a".repeat(43),
      url: "https://worker.example/?action=catalog",
    }), { ...env, TRIGGER_SECRET: undefined, CHI_AUTH_STATUS_CLIENT_ID: "test-status-client-id" });
    const result = await jsonResponse(response);
    assert.equal(response.status, 200);
    assert.equal(result.body.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not fall back to the legacy key when a supplied Chi Auth token is invalid", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "invalid" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
  try {
    const response = await worker.fetch(request(undefined, {
      method: "GET",
      bearer: "a".repeat(43),
      url: "https://worker.example/?action=catalog",
    }), env);
    const result = await jsonResponse(response);
    assert.equal(response.status, 401);
    assert.match(result.body.error, /invalid or expired/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails closed when Chi Auth cannot be reached", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("simulated auth outage"); };
  try {
    const response = await worker.fetch(request(undefined, {
      method: "GET",
      bearer: "a".repeat(43),
      url: "https://worker.example/?action=catalog",
    }), env);
    const result = await jsonResponse(response);
    assert.equal(response.status, 503);
    assert.match(result.body.error, /Chi Auth is temporarily unavailable/);
    assert.doesNotMatch(JSON.stringify(result.body), /simulated auth outage/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Actions console inline JavaScript parses", () => {
  const html = readFileSync(new URL("../actions.html", import.meta.url), "utf8");
  const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(inlineScript, "expected an inline application script");
  assert.doesNotThrow(() => new Function(inlineScript[1]));
});
