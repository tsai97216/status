import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";

const RP_ID = "chi.qzz.io";
const RP_NAME = "Chi";
const ORIGIN = "https://chi.qzz.io";
const SESSION_TTL_SECONDS = 60 * 60 * 12;
const CEREMONY_TTL_SECONDS = 5 * 60;

const PAGE = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Chi Auth</title>
<style>
:root{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:Canvas;color:CanvasText}
main{width:min(100%,440px);border:1px solid color-mix(in srgb,CanvasText 15%,transparent);border-radius:22px;padding:28px;box-shadow:0 18px 60px #00000012}
.mark{font-size:13px;letter-spacing:.14em;text-transform:uppercase;opacity:.65}h1{margin:10px 0 6px;font-size:30px}p{line-height:1.6;opacity:.78}.field{display:grid;gap:7px;margin:20px 0}label{font-size:14px}input{width:100%;padding:12px 13px;border:1px solid color-mix(in srgb,CanvasText 22%,transparent);border-radius:11px;background:Canvas;color:CanvasText;font:inherit}
button{width:100%;padding:12px 14px;border:0;border-radius:11px;background:#356ae6;color:white;font:inherit;font-weight:650;cursor:pointer;margin-top:10px}button.secondary{background:color-mix(in srgb,CanvasText 9%,Canvas);color:CanvasText}button:disabled{opacity:.55;cursor:wait}
#status{margin-top:18px;padding:12px;border-radius:10px;background:color-mix(in srgb,CanvasText 6%,Canvas);font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere}.muted{font-size:13px;opacity:.62;margin-top:20px}
</style>
</head>
<body><main>
<div class="mark">C◆ / Identity</div><h1>Chi Auth</h1>
<p>Chi 專案共用的身分驗證中心。使用 Passkey 登入，不會把私鑰交給網站。</p>
<div id="setup" class="field" hidden><label for="setupSecret">首次設定碼</label><input id="setupSecret" type="password" autocomplete="current-password" placeholder="輸入一次性設定碼"></div>
<button id="register" hidden>建立第一把 Passkey</button>
<button id="login">使用 Passkey 登入</button>
<button id="logout" class="secondary" hidden>登出</button>
<section id="clientAdmin" hidden>
<h2 style="font-size:18px;margin:26px 0 4px">已授權的 Chi 應用</h2>
<p>新增應用時請填入該網站實際接收登入回呼的完整 HTTPS 網址。回呼網址會逐字比對。</p>
<div class="field"><label for="clientName">應用名稱</label><input id="clientName" maxlength="60" placeholder="例如 Chi Status"></div>
<div class="field"><label for="clientRedirectUris">允許的回呼網址，每行一個</label><textarea id="clientRedirectUris" rows="3" style="width:100%;padding:12px;border:1px solid color-mix(in srgb,CanvasText 22%,transparent);border-radius:11px;background:Canvas;color:CanvasText;font:inherit;resize:vertical" placeholder="https://status.chi.qzz.io/auth/callback"></textarea></div>
<button id="addClient">註冊應用</button>
<div id="clients" style="display:grid;gap:10px;margin-top:14px"></div>
</section>
<div id="status" role="status" aria-live="polite">正在檢查驗證服務…</div>
<p class="muted">目前為驗證核心初版，尚未開放其他 Chi 專案的單一登入。請勿把此頁視為已完成的正式 SSO。</p>
</main>
<script type="module">
const $ = (id) => document.getElementById(id);
const status = $("status");
function say(message){status.textContent=message}
function decode(value){const s=value.replace(/-/g,"+").replace(/_/g,"/");const padded=s+"=".repeat((4-s.length%4)%4);return Uint8Array.from(atob(padded),c=>c.charCodeAt(0))}
function encode(value){return btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"")}
async function api(path,body){const response=await fetch("/auth/api/"+path,{method:body===undefined?"GET":"POST",headers:body===undefined?{}:{"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),credentials:"same-origin",cache:"no-store"});const data=await response.json().catch(()=>({error:"伺服器回應格式錯誤"}));if(!response.ok)throw new Error(data.error||"請求失敗");return data}
function registrationJSON(credential){return {id:credential.id,rawId:encode(credential.rawId),type:credential.type,authenticatorAttachment:credential.authenticatorAttachment,response:{clientDataJSON:encode(credential.response.clientDataJSON),attestationObject:encode(credential.response.attestationObject),transports:credential.response.getTransports?.()||[]},clientExtensionResults:credential.getClientExtensionResults()}}
function authenticationJSON(credential){return {id:credential.id,rawId:encode(credential.rawId),type:credential.type,authenticatorAttachment:credential.authenticatorAttachment,response:{clientDataJSON:encode(credential.response.clientDataJSON),authenticatorData:encode(credential.response.authenticatorData),signature:encode(credential.response.signature),userHandle:credential.response.userHandle?encode(credential.response.userHandle):null},clientExtensionResults:credential.getClientExtensionResults()}}
async function loadClients(){const data=await api("clients");const list=$("clients");list.replaceChildren();if(!data.clients.length){const empty=document.createElement("p");empty.textContent="目前尚未註冊應用。";list.append(empty);return}for(const client of data.clients){const card=document.createElement("div");card.style.cssText="border:1px solid color-mix(in srgb,CanvasText 15%,transparent);border-radius:12px;padding:12px";const title=document.createElement("strong");title.textContent=client.name;const id=document.createElement("p");id.textContent="Client ID: "+client.client_id;id.style.overflowWrap="anywhere";const uris=document.createElement("p");uris.textContent=client.redirect_uris.join("\\n");uris.style.cssText="white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px";const remove=document.createElement("button");remove.className="secondary";remove.textContent="移除此應用";remove.addEventListener("click",async()=>{if(!confirm("確定移除此應用並撤銷它的授權？"))return;try{await api("clients/"+encodeURIComponent(client.client_id),{});await loadClients();say("已移除應用。")}catch(e){say(e.message)}});card.append(title,id,uris,remove);list.append(card)}}
async function refresh(){try{const s=await api("session");$("setup").hidden=s.initialized;$("register").hidden=s.initialized&&!s.authenticated;$("register").textContent=s.initialized?"新增備用 Passkey":"建立第一把 Passkey";$("login").hidden=!s.initialized||s.authenticated;$("logout").hidden=!s.authenticated;$("clientAdmin").hidden=!s.authenticated;say(s.authenticated?"已登入 Chi Auth。此登入目前只限驗證中心本身。":s.initialized?"尚未登入，請使用已註冊的 Passkey。":"尚未設定 Passkey，請先輸入首次設定碼。");if(s.authenticated){await loadClients();const returnTo=new URL(location.href).searchParams.get("return_to");if(returnTo&&returnTo.startsWith("/auth/api/authorize?"))location.replace(returnTo)}}catch(e){say(e.message)}}
$("addClient").addEventListener("click",async()=>{const button=$("addClient");button.disabled=true;try{const redirectUris=$("clientRedirectUris").value.split("\\n").map(s=>s.trim()).filter(Boolean);const result=await api("clients",{name:$("clientName").value.trim(),redirectUris});$("clientName").value="";$("clientRedirectUris").value="";await loadClients();say("已註冊應用。Client ID: "+result.client_id)}catch(e){say(e.message)}finally{button.disabled=false}});
$("register").addEventListener("click",async()=>{const button=$("register");button.disabled=true;try{if(!window.PublicKeyCredential)throw new Error("此瀏覽器不支援 WebAuthn");const setupSecret=$("setupSecret").value;const start=await api("register/options",setupSecret?{setupSecret}:{});const options={...start.options,challenge:decode(start.options.challenge),user:{...start.options.user,id:decode(start.options.user.id)},excludeCredentials:(start.options.excludeCredentials||[]).map(c=>({...c,id:decode(c.id)}))};const credential=await navigator.credentials.create({publicKey:options});if(!credential)throw new Error("Passkey 建立已取消");await api("register/verify",{ceremonyId:start.ceremonyId,credential:registrationJSON(credential)});$("setupSecret").value="";say("Passkey 已建立。");await refresh()}catch(e){say(e.message||"建立 Passkey 失敗")}finally{button.disabled=false}});
$("login").addEventListener("click",async()=>{const button=$("login");button.disabled=true;try{if(!window.PublicKeyCredential)throw new Error("此瀏覽器不支援 WebAuthn");const start=await api("login/options",{});const options={...start.options,challenge:decode(start.options.challenge),allowCredentials:(start.options.allowCredentials||[]).map(c=>({...c,id:decode(c.id)}))};const credential=await navigator.credentials.get({publicKey:options});if(!credential)throw new Error("Passkey 登入已取消");await api("login/verify",{ceremonyId:start.ceremonyId,credential:authenticationJSON(credential)});say("登入成功。");await refresh()}catch(e){say(e.message||"Passkey 登入失敗")}finally{button.disabled=false}});
$("logout").addEventListener("click",async()=>{try{await api("logout",{});await refresh()}catch(e){say(e.message)}});
refresh();
</script>
</body></html>`;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...extraHeaders,
    },
  });
}

function noStoreHtml() {
  return new Response(PAGE, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "Permissions-Policy": "publickey-credentials-get=(self), publickey-credentials-create=(self)",
    },
  });
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

function randomToken(bytes = 32) {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return base64url(value);
}

function base64url(value) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(value) {
  return base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !a.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

async function countPasskeys(db) {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM passkeys").first();
  return Number(row?.count || 0);
}

async function saveCeremony(db, type, challenge, { bootstrap = false, sessionTokenHash = null } = {}) {
  const ceremonyId = randomToken(24);
  const now = Math.floor(Date.now() / 1000);
  await db.prepare("DELETE FROM ceremonies WHERE expires_at <= ?").bind(now).run();
  await db.prepare("INSERT INTO ceremonies (ceremony_id, ceremony_type, challenge, expires_at, created_at, bootstrap, session_token_hash) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(ceremonyId, type, challenge, now + CEREMONY_TTL_SECONDS, now, bootstrap ? 1 : 0, sessionTokenHash).run();
  return ceremonyId;
}

async function takeCeremony(db, ceremonyId, type) {
  if (typeof ceremonyId !== "string" || ceremonyId.length > 128) return null;
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare("SELECT ceremony_id, challenge, expires_at, bootstrap, session_token_hash FROM ceremonies WHERE ceremony_id = ? AND ceremony_type = ?")
    .bind(ceremonyId, type).first();
  await db.prepare("DELETE FROM ceremonies WHERE ceremony_id = ?").bind(ceremonyId).run();
  if (!row || Number(row.expires_at) <= now) return null;
  return row;
}

async function createSession(db) {
  const token = randomToken();
  const now = Math.floor(Date.now() / 1000);
  const tokenHash = await sha256(token);
  await db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now).run();
  await db.prepare("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)")
    .bind(tokenHash, now, now + SESSION_TTL_SECONDS).run();
  return token;
}

async function sessionIsValid(request, db) {
  const token = getCookie(request, "__Host-chi_auth_session");
  if (!token) return false;
  const tokenHash = await sha256(token);
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare("SELECT token_hash FROM sessions WHERE token_hash = ? AND expires_at > ?")
    .bind(tokenHash, now).first();
  return Boolean(row);
}

function sessionCookie(token, maxAge = SESSION_TTL_SECONDS) {
  return `__Host-chi_auth_session=${token}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

async function requireSameOrigin(request) {
  const origin = request.headers.get("Origin");
  return origin === ORIGIN;
}

function validRedirectUri(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const uri = new URL(value);
    if (uri.username || uri.password || uri.hash) return false;
    return uri.protocol === "https:" || (uri.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(uri.hostname));
  } catch { return false; }
}

async function getClient(db, clientId) {
  if (typeof clientId !== "string" || !/^[A-Za-z0-9_-]{20,80}$/.test(clientId)) return null;
  const client = await db.prepare("SELECT client_id, name, redirect_uris_json, active FROM oauth_clients WHERE client_id = ?")
    .bind(clientId).first();
  if (!client || Number(client.active) !== 1) return null;
  return { ...client, redirectUris: JSON.parse(client.redirect_uris_json || "[]") };
}

function clientAllowsOrigin(client, origin) {
  if (!client || typeof origin !== "string") return false;
  try {
    return client.redirectUris.some(uri => new URL(uri).origin === origin);
  } catch { return false; }
}

async function anyClientAllowsOrigin(db, origin) {
  if (typeof origin !== "string" || origin.length > 512) return false;
  const rows = await db.prepare("SELECT redirect_uris_json FROM oauth_clients WHERE active = 1").all();
  return (rows.results || []).some(row => {
    try { return JSON.parse(row.redirect_uris_json || "[]").some(uri => new URL(uri).origin === origin); }
    catch { return false; }
  });
}

function withCors(headers, origin) {
  return { ...headers, "Access-Control-Allow-Origin": origin, "Vary": "Origin" };
}

async function enforceRateLimit(request, env, route, limit, windowSeconds = 60) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipHash = await sha256(ip);
  const now = Math.floor(Date.now() / 1000);
  const bucketStart = Math.floor(now / windowSeconds) * windowSeconds;
  const result = await env.DB.prepare(
    "INSERT INTO rate_limits (ip_hash, route, bucket_start, count) VALUES (?, ?, ?, 1) " +
    "ON CONFLICT(ip_hash, route) DO UPDATE SET " +
    "bucket_start = excluded.bucket_start, " +
    "count = CASE WHEN rate_limits.bucket_start = excluded.bucket_start THEN rate_limits.count + 1 ELSE 1 END " +
    "RETURNING count"
  ).bind(ipHash, route, bucketStart).first();
  await env.DB.prepare("DELETE FROM rate_limits WHERE bucket_start < ?").bind(now - 3600).run();
  return Number(result?.count || 0) <= limit;
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/auth(?=\/|$)/, "") || "/";
  if (request.method === "GET" && (path === "/" || path === "")) return noStoreHtml();
  if (request.method === "GET" && path === "/api/health") return json({ ok: true, service: "chi-auth", rpId: RP_ID, phase: "passkey-core+sso" });

  if (request.method === "OPTIONS" && path === "/api/token") {
    const origin = request.headers.get("Origin");
    const client = await getClient(env.DB, url.searchParams.get("client_id") || "");
    if (!client || !clientAllowsOrigin(client, origin)) return json({ ok: false, error: "Origin not allowed." }, 403);
    return new Response(null, { status: 204, headers: withCors({
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600",
      "Cache-Control": "no-store",
    }, origin) });
  }
  if (request.method === "OPTIONS" && path === "/api/userinfo") {
    const origin = request.headers.get("Origin");
    if (!(await anyClientAllowsOrigin(env.DB, origin))) return json({ ok: false, error: "Origin not allowed." }, 403);
    return new Response(null, { status: 204, headers: withCors({
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization",
      "Access-Control-Max-Age": "600",
      "Cache-Control": "no-store",
    }, origin) });
  }

  if (path.startsWith("/api/") && request.method !== "GET" && request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed." }, 405);
  }

  if (request.method === "POST" && path.startsWith("/api/") && path !== "/api/token" && !(await requireSameOrigin(request))) {
    return json({ ok: false, error: "Origin not allowed." }, 403);
  }

  if (request.method === "GET" && path === "/api/session") {
    const initialized = await countPasskeys(env.DB) > 0;
    const authenticated = initialized && await sessionIsValid(request, env.DB);
    return json({ ok: true, initialized, authenticated });
  }

  if (request.method === "GET" && path === "/api/authorize") {
    const params = url.searchParams;
    const clientId = params.get("client_id") || "";
    const redirectUri = params.get("redirect_uri") || "";
    const challenge = params.get("code_challenge") || "";
    const state = params.get("state") || "";
    if (params.get("response_type") !== "code" || params.get("code_challenge_method") !== "S256" ||
        !/^[A-Za-z0-9_-]{20,80}$/.test(clientId) || !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
        state.length < 16 || state.length > 512 || !validRedirectUri(redirectUri)) {
      return json({ ok: false, error: "授權請求格式不正確，必須使用 Authorization Code + PKCE (S256)。" }, 400);
    }
    if (!(await enforceRateLimit(request, env, path, 30, 60))) {
      return json({ ok: false, error: "授權請求太頻繁，請稍後再試。" }, 429, { "Retry-After": "60" });
    }
    const client = await getClient(env.DB, clientId);
    if (!client || !client.redirectUris.includes(redirectUri)) return json({ ok: false, error: "未知的應用或未登記的回呼網址。" }, 400);
    if (!(await sessionIsValid(request, env.DB))) {
      return new Response(null, { status: 302, headers: {
        "Location": "/auth/?return_to=" + encodeURIComponent(url.pathname + url.search),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      }});
    }
    const code = randomToken(32);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("DELETE FROM authorization_codes WHERE expires_at <= ?").bind(now).run();
    await env.DB.prepare("INSERT INTO authorization_codes (code_hash, client_id, redirect_uri, code_challenge, state, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(await sha256(code), clientId, redirectUri, challenge, state, now, now + 120).run();
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", state);
    return new Response(null, { status: 302, headers: { "Location": callback.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }});
  }

  if (request.method === "GET" && path === "/api/clients") {
    if (!(await sessionIsValid(request, env.DB))) return json({ ok: false, error: "需要先登入。" }, 401);
    const rows = await env.DB.prepare("SELECT client_id, name, redirect_uris_json, created_at FROM oauth_clients WHERE active = 1 ORDER BY created_at DESC").all();
    return json({ ok: true, clients: (rows.results || []).map(row => ({
      client_id: row.client_id, name: row.name, redirect_uris: JSON.parse(row.redirect_uris_json || "[]"), created_at: row.created_at
    })) });
  }

  if (request.method === "POST" && path === "/api/clients") {
    if (!(await enforceRateLimit(request, env, path, 10, 60))) return json({ ok: false, error: "操作太頻繁，請稍後再試。" }, 429, { "Retry-After": "60" });
    if (!(await sessionIsValid(request, env.DB))) return json({ ok: false, error: "需要先登入。" }, 401);
    const body = await request.json().catch(() => null);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const redirectUris = Array.isArray(body?.redirectUris) ? [...new Set(body.redirectUris)] : [];
    if (!name || name.length > 60 || redirectUris.length < 1 || redirectUris.length > 10 ||
        redirectUris.some(uri => !validRedirectUri(uri))) {
      return json({ ok: false, error: "請提供應用名稱，以及 1 到 10 個有效的 HTTPS 回呼網址。" }, 400);
    }
    const clientId = randomToken(24);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO oauth_clients (client_id, name, redirect_uris_json, created_at, active) VALUES (?, ?, ?, ?, 1)")
      .bind(clientId, name, JSON.stringify(redirectUris), now).run();
    return json({ ok: true, client_id: clientId, name, redirect_uris: redirectUris }, 201);
  }

  if (request.method === "POST" && path.startsWith("/api/clients/")) {
    if (!(await enforceRateLimit(request, env, path, 10, 60))) return json({ ok: false, error: "操作太頻繁，請稍後再試。" }, 429, { "Retry-After": "60" });
    if (!(await sessionIsValid(request, env.DB))) return json({ ok: false, error: "需要先登入。" }, 401);
    const clientId = path.slice("/api/clients/".length);
    if (!/^[A-Za-z0-9_-]{20,80}$/.test(clientId)) return json({ ok: false, error: "應用 ID 格式不正確。" }, 400);
    await env.DB.prepare("DELETE FROM oauth_clients WHERE client_id = ?").bind(clientId).run();
    await env.DB.prepare("DELETE FROM authorization_codes WHERE client_id = ?").bind(clientId).run();
    await env.DB.prepare("DELETE FROM access_tokens WHERE client_id = ?").bind(clientId).run();
    return json({ ok: true });
  }

  if (request.method === "POST" && path === "/api/token") {
    if (!(await enforceRateLimit(request, env, path, 30, 60))) return json({ ok: false, error: "授權碼交換太頻繁，請稍後再試。" }, 429, { "Retry-After": "60" });
    const body = await request.json().catch(() => null);
    const client = await getClient(env.DB, body?.client_id || "");
    const origin = request.headers.get("Origin");
    if (!client || typeof body?.code !== "string" || body.code.length > 256 ||
        typeof body.redirect_uri !== "string" || !client.redirectUris.includes(body.redirect_uri) ||
        typeof body.code_verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier)) {
      return json({ ok: false, error: "授權碼交換請求無效。" }, 400);
    }
    if (origin && !clientAllowsOrigin(client, origin)) return json({ ok: false, error: "Origin not allowed." }, 403);
    const challenge = await sha256(body.code_verifier);
    const now = Math.floor(Date.now() / 1000);
    const codeRow = await env.DB.prepare(
      "DELETE FROM authorization_codes WHERE code_hash = ? AND client_id = ? AND redirect_uri = ? AND code_challenge = ? AND expires_at > ? RETURNING code_hash"
    ).bind(await sha256(body.code), client.client_id, body.redirect_uri, challenge, now).first();
    if (!codeRow) return json({ ok: false, error: "授權碼已失效、已使用或 PKCE 驗證不符。" }, 400);
    const token = randomToken(32);
    const expiresIn = 600;
    await env.DB.prepare("DELETE FROM access_tokens WHERE expires_at <= ?").bind(now).run();
    await env.DB.prepare("INSERT INTO access_tokens (token_hash, client_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256(token), client.client_id, now, now + expiresIn).run();
    const headers = origin ? withCors({}, origin) : {};
    return json({ access_token: token, token_type: "Bearer", expires_in: expiresIn, scope: "chi:identity" }, 200, headers);
  }

  if (request.method === "GET" && path === "/api/userinfo") {
    const origin = request.headers.get("Origin");
    const authorization = request.headers.get("Authorization") || "";
    const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{40,80})$/);
    if (!match) return json({ ok: false, error: "Missing bearer token." }, 401);
    if (!(await enforceRateLimit(request, env, path, 60, 60))) return json({ ok: false, error: "請求太頻繁，請稍後再試。" }, 429, { "Retry-After": "60" });
    const tokenHash = await sha256(match[1]);
    const now = Math.floor(Date.now() / 1000);
    const row = await env.DB.prepare(
      "SELECT access_tokens.client_id FROM access_tokens JOIN oauth_clients ON oauth_clients.client_id = access_tokens.client_id WHERE access_tokens.token_hash = ? AND access_tokens.expires_at > ? AND oauth_clients.active = 1"
    ).bind(tokenHash, now).first();
    if (!row) return json({ ok: false, error: "Token expired or invalid." }, 401);
    const client = await getClient(env.DB, row.client_id);
    const expectedClientId = url.searchParams.get("client_id");
    if (expectedClientId && expectedClientId !== row.client_id) return json({ ok: false, error: "Token audience mismatch." }, 403);
    if (origin && !clientAllowsOrigin(client, origin)) return json({ ok: false, error: "Origin not allowed." }, 403);
    const headers = origin ? withCors({}, origin) : {};
    return json({ sub: "chi-owner", name: "Chi Owner", aud: row.client_id }, 200, headers);
  }


  const protectedPostRoutes = new Set([
    "/api/register/options", "/api/register/verify",
    "/api/login/options", "/api/login/verify", "/api/logout",
  ]);
  if (request.method === "POST" && protectedPostRoutes.has(path)) {
    const limit = path.startsWith("/api/register") ? 8 : path === "/api/token" ? 30 : 15;
    const windowSeconds = path === "/api/register/options" ? 300 : 60;
    if (!(await enforceRateLimit(request, env, path, limit, windowSeconds))) {
      return json({ ok: false, error: "操作太頻繁，請稍後再試。" }, 429, { "Retry-After": String(windowSeconds) });
    }
  }

  if (request.method === "POST" && path === "/api/register/options") {
    const body = await request.json().catch(() => null);
    const initialized = await countPasskeys(env.DB) > 0;
    let bootstrap = false;
    let sessionTokenHash = null;
    if (!initialized) {
      if (!body || typeof body.setupSecret !== "string" || !safeEqual(body.setupSecret, env.CHI_AUTH_SETUP_SECRET || "")) {
        return json({ ok: false, error: "首次設定碼不正確。" }, 401);
      }
      bootstrap = true;
    } else {
      const sessionToken = getCookie(request, "__Host-chi_auth_session");
      if (!(await sessionIsValid(request, env.DB))) {
        return json({ ok: false, error: "請先使用 Passkey 登入，才能新增備用 Passkey。" }, 401);
      }
      sessionTokenHash = await sha256(sessionToken);
    }
    const existingRows = await env.DB.prepare("SELECT credential_id, transports_json FROM passkeys").all();
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: "chi-owner",
      userDisplayName: "Chi Owner",
      attestationType: "none",
      excludeCredentials: (existingRows.results || []).map(row => ({ id: row.credential_id, transports: JSON.parse(row.transports_json || "[]") })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      supportedAlgorithmIDs: [-7, -257],
    });
    const ceremonyId = await saveCeremony(env.DB, "registration", options.challenge, { bootstrap, sessionTokenHash });
    return json({ ok: true, options, ceremonyId });
  }

  if (request.method === "POST" && path === "/api/register/verify") {
    const body = await request.json().catch(() => null);
    if (!body?.credential || typeof body.ceremonyId !== "string") return json({ ok: false, error: "Invalid request." }, 400);
    const ceremony = await takeCeremony(env.DB, body.ceremonyId, "registration");
    if (!ceremony) return json({ ok: false, error: "設定程序已逾時，請重新開始。" }, 400);
    const initialized = await countPasskeys(env.DB) > 0;
    if (Number(ceremony.bootstrap) === 1) {
      if (initialized) return json({ ok: false, error: "初始設定已完成，請登入後新增備用 Passkey。" }, 409);
    } else {
      const sessionToken = getCookie(request, "__Host-chi_auth_session");
      const currentHash = sessionToken ? await sha256(sessionToken) : null;
      if (!initialized || !currentHash || !safeEqual(currentHash, ceremony.session_token_hash || "") || !(await sessionIsValid(request, env.DB))) {
        return json({ ok: false, error: "登入狀態已變更，請重新登入後再試。" }, 401);
      }
    }
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.credential,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: true,
      });
    } catch {
      return json({ ok: false, error: "Passkey 驗證失敗，請重新嘗試。" }, 400);
    }
    if (!verification.verified || !verification.registrationInfo) return json({ ok: false, error: "Passkey 驗證未通過。" }, 400);
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    const now = Math.floor(Date.now() / 1000);
    try {
      let saveResult;
      if (Number(ceremony.bootstrap) === 1) {
        saveResult = await env.DB.prepare(
          "INSERT INTO passkeys (credential_id, public_key, counter, transports_json, device_type, backed_up, created_at) " +
          "SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM passkeys)"
        ).bind(credential.id, credential.publicKey, credential.counter, JSON.stringify(credential.transports || []), credentialDeviceType, credentialBackedUp ? 1 : 0, now).run();
        if (Number(saveResult.meta?.changes || 0) !== 1) return json({ ok: false, error: "初始 Passkey 已由另一個設定程序完成，請重新整理頁面。" }, 409);
      } else {
        saveResult = await env.DB.prepare("INSERT INTO passkeys (credential_id, public_key, counter, transports_json, device_type, backed_up, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(credential.id, credential.publicKey, credential.counter, JSON.stringify(credential.transports || []), credentialDeviceType, credentialBackedUp ? 1 : 0, now).run();
      }
    } catch {
      return json({ ok: false, error: "無法儲存 Passkey，請確認資料庫設定。" }, 500);
    }
    const token = await createSession(env.DB);
    return json({ ok: true, verified: true }, 201, { "Set-Cookie": sessionCookie(token) });
  }

  if (request.method === "POST" && path === "/api/login/options") {
    const rows = await env.DB.prepare("SELECT credential_id, transports_json FROM passkeys").all();
    if (!rows.results?.length) return json({ ok: false, error: "尚未設定 Passkey。" }, 409);
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials: rows.results.map(row => ({ id: row.credential_id, transports: JSON.parse(row.transports_json || "[]") })),
      userVerification: "required",
    });
    const ceremonyId = await saveCeremony(env.DB, "authentication", options.challenge);
    return json({ ok: true, options, ceremonyId });
  }

  if (request.method === "POST" && path === "/api/login/verify") {
    const body = await request.json().catch(() => null);
    if (!body?.credential || typeof body.ceremonyId !== "string" || typeof body.credential.id !== "string") {
      return json({ ok: false, error: "Invalid request." }, 400);
    }
    const ceremony = await takeCeremony(env.DB, body.ceremonyId, "authentication");
    if (!ceremony) return json({ ok: false, error: "登入程序已逾時，請重新開始。" }, 400);
    const passkey = await env.DB.prepare("SELECT credential_id, public_key, counter, transports_json FROM passkeys WHERE credential_id = ?")
      .bind(body.credential.id).first();
    if (!passkey) return json({ ok: false, error: "找不到這把 Passkey。" }, 401);
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.credential,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: true,
        credential: {
          id: passkey.credential_id,
          publicKey: new Uint8Array(passkey.public_key),
          counter: Number(passkey.counter),
          transports: JSON.parse(passkey.transports_json || "[]"),
        },
      });
    } catch {
      return json({ ok: false, error: "Passkey 驗證失敗，請重新嘗試。" }, 401);
    }
    if (!verification.verified) return json({ ok: false, error: "Passkey 驗證未通過。" }, 401);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ?")
      .bind(verification.authenticationInfo.newCounter, now, passkey.credential_id).run();
    const token = await createSession(env.DB);
    return json({ ok: true, verified: true }, 200, { "Set-Cookie": sessionCookie(token) });
  }

  if (request.method === "POST" && path === "/api/logout") {
    const token = getCookie(request, "__Host-chi_auth_session");
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }

  return json({ ok: false, error: "Not found." }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (error) {
      console.error("Chi Auth request failed", error?.name || "unknown");
      return json({ ok: false, error: "驗證服務暫時無法處理請求。" }, 500);
    }
  },
};
