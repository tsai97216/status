const ALLOWED_ORIGIN = "https://status.chi.qzz.io";
const DEFAULT_REPOSITORY = "tsai97216/status";
const DEFAULT_WORKFLOW = "update-status.yml";

// Keep this catalog aligned with the projects displayed in status.json.
// Only these workflows can be triggered by this Worker.
const WORKFLOWS = [
  { repository: "tsai97216/status", workflow: "update-status.yml", name: "Status 狀態資料更新", project: "status", group: "Status 維護", inputs: [] },
  { repository: "tsai97216/chi-source", workflow: "main.yml", name: "Chi Source 更新", project: "chi-source", group: "來源更新", inputs: [{ name: "app", label: "指定 App（all 代表全部）", type: "string", required: false, default: "all" }] },
  { repository: "tsai97216/chi-source-personal", workflow: "main.yml", name: "Chi Source Personal 更新", project: "chi-source-personal", group: "來源更新", inputs: [{ name: "app", label: "指定 App（all 代表全部）", type: "string", required: false, default: "all" }] },
  { repository: "tsai97216/free-game", workflow: "free-game.yml", name: "限免遊戲通知更新", project: "free-game", group: "內容更新", inputs: [] },
  { repository: "tsai97216/sc-auto-claim", workflow: "daily.yml", name: "荒野亂鬥自動領取", project: "sc-auto-claim", group: "自動化", inputs: [] },
  { repository: "tsai97216/bahasign", workflow: "actions.yml", name: "巴哈姆特自動簽到", project: "bahasign", group: "自動化", inputs: [] },
  { repository: "tsai97216/apktwsign", workflow: "checkin.yml", name: "APK.TW 自動簽到", project: "apktwsign", group: "自動化", inputs: [] },
  { repository: "tsai97216/h", workflow: "ci.yml", name: "H 工具箱 CI 驗證", project: "h", group: "驗證", inputs: [] },
  { repository: "tsai97216/h", workflow: "deploy-pages.yml", name: "H 工具箱 Pages 部署", project: "h", group: "部署", inputs: [], danger: "會部署正式網站。" },
  { repository: "tsai97216/h", workflow: "deploy-worker.yml", name: "H 工具箱 Worker 部署", project: "h", group: "部署", inputs: [], danger: "會部署 Cloudflare Worker。" },
  { repository: "tsai97216/merch", workflow: "verify.yml", name: "周邊收藏網驗證", project: "merch", group: "驗證", inputs: [] },
  { repository: "tsai97216/merch", workflow: "deploy.yml", name: "周邊收藏網部署", project: "merch", group: "部署", inputs: [], danger: "會部署正式網站。" },
  { repository: "tsai97216/nav", workflow: "", name: "Chi 的工具箱", project: "nav", group: "暫不可觸發", available: false, reason: "目前版本更新 workflow 只接受 push，並依賴真實 commit 訊息與 SHA；避免手動觸發產生錯誤版本紀錄，暫不開放。" },
  { repository: "VPS-01 · Oracle Cloud Infrastructure", workflow: "", name: "VPS-01 外部服務探測", project: "vps-01", group: "外部監控", available: false, reason: "這是外部服務健康檢查，不是 GitHub Actions workflow，無法從此處觸發。" },
];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Trigger-Key, Authorization",
      "Vary": "Origin",
    },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (origin !== ALLOWED_ORIGIN) return json({ ok: false, error: "Origin not allowed." }, 403);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Trigger-Key, Authorization",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin",
      }});
    }

    if (!["GET", "POST"].includes(request.method)) return json({ ok: false, error: "Method not allowed." }, 405);

    // Rate-limit requests by client IP before checking credentials to slow down key guessing.
    // Cloudflare's limiter is approximate and scoped to a Cloudflare location.
    const clientIp = request.headers.get("CF-Connecting-IP") || "missing-ip";
    const ipAllowed = await checkRateLimit(env.IP_RATE_LIMITER, clientIp);
    if (ipAllowed === null) return json({ ok: false, error: "Rate limiter is unavailable." }, 503);
    if (!ipAllowed) return json({ ok: false, error: "Too many requests. Please wait and try again." }, 429);

    if (!env.GITHUB_TOKEN) return json({ ok: false, error: "GitHub token is not configured." }, 503);

    // Prefer the shared Chi Auth Passkey session token. Keep the legacy trigger key
    // as a deliberate fallback until the central auth service is deployed and tested.
    const authorization = request.headers.get("Authorization") || "";
    let authenticated = false;
    if (authorization) {
      const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{40,80})$/);
      if (!match) return json({ ok: false, error: "Invalid Chi Auth access token." }, 401);
      if (!env.CHI_AUTH_STATUS_CLIENT_ID) return json({ ok: false, error: "Chi Auth Status client is not configured." }, 503);
      const authResult = await verifyChiAccessToken(match[1], env.CHI_AUTH_STATUS_CLIENT_ID);
      if (authResult === null) return json({ ok: false, error: "Chi Auth is temporarily unavailable. Please try again." }, 503);
      if (!authResult) return json({ ok: false, error: "Invalid or expired Chi Auth access token." }, 401);
      authenticated = true;
    } else {
      if (!env.TRIGGER_SECRET) return json({ ok: false, error: "Legacy trigger-key authentication is not configured." }, 503);
      const suppliedKey = request.headers.get("X-Trigger-Key") || "";
      authenticated = constantTimeEqual(suppliedKey, env.TRIGGER_SECRET);
      if (!authenticated) return json({ ok: false, error: "Invalid trigger key." }, 401);
    }

    if (request.method === "GET") {
      const url = new URL(request.url);
      if (url.searchParams.get("action") !== "catalog") return json({ ok: false, error: "Unknown action." }, 400);
      return json({ ok: true, workflows: WORKFLOWS });
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ ok: false, error: "Invalid JSON body." }, 400); }

    const repository = body?.repository || DEFAULT_REPOSITORY;
    const workflow = body?.workflow || DEFAULT_WORKFLOW;
    const ref = body?.ref || "main";
    if (ref !== "main") return json({ ok: false, error: "Only the main branch can be triggered." }, 400);

    const entry = WORKFLOWS.find(item => item.available !== false && item.repository === repository && item.workflow === workflow);
    if (!entry) return json({ ok: false, error: "This workflow is not in the approved status-project allowlist." }, 403);

    const suppliedInputs = body?.inputs ?? {};
    if (!suppliedInputs || typeof suppliedInputs !== "object" || Array.isArray(suppliedInputs)) {
      return json({ ok: false, error: "Inputs must be an object." }, 400);
    }
    const allowedInputNames = new Set(entry.inputs.map(input => input.name));
    for (const key of Object.keys(suppliedInputs)) {
      if (!allowedInputNames.has(key)) return json({ ok: false, error: `Unsupported input: ${key}` }, 400);
    }

    const inputs = {};
    for (const spec of entry.inputs) {
      const value = Object.prototype.hasOwnProperty.call(suppliedInputs, spec.name) ? suppliedInputs[spec.name] : spec.default;
      if (spec.required && (value === undefined || value === null || String(value).trim() === "")) {
        return json({ ok: false, error: `Missing required input: ${spec.name}` }, 400);
      }
      if (value === undefined || value === null || value === "") continue;
      if (spec.type === "boolean") {
        if (typeof value !== "boolean") return json({ ok: false, error: `Input ${spec.name} must be boolean.` }, 400);
      } else {
        if (typeof value !== "string") return json({ ok: false, error: `Input ${spec.name} must be text.` }, 400);
        if (spec.type === "choice" && !spec.options.includes(value)) return json({ ok: false, error: `Invalid option for ${spec.name}.` }, 400);
      }
      inputs[spec.name] = value;
    }

    // Charge the dispatch quota only after the request passes validation.
    const dispatchAllowed = await checkRateLimit(env.DISPATCH_RATE_LIMITER, "authenticated-workflow-dispatch");
    if (dispatchAllowed === null) return json({ ok: false, error: "Rate limiter is unavailable." }, 503);
    if (!dispatchAllowed) return json({ ok: false, error: "Workflow trigger limit reached. Wait one minute before trying again." }, 429);

    let response;
    try {
      response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/${workflow}/dispatches`, {
        method: "POST",
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Chi-Status-Trigger",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref, inputs }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      console.error("GitHub dispatch request failed", repository, workflow, error?.name || "unknown");
      return json({ ok: false, error: error?.name === "TimeoutError"
        ? "GitHub API request timed out. Please try again."
        : "Could not reach the GitHub API. Please try again." }, 502);
    }

    if (response.status !== 204) {
      let detail = "";
      try { detail = (await response.text()).slice(0, 500); } catch {}
      console.error("GitHub dispatch failed", repository, workflow, response.status, detail);
      return json({ ok: false, error: response.status === 401 || response.status === 403
        ? "GitHub rejected the token or repository permission. Check token repository access and Actions: Read and write."
        : `GitHub API returned HTTP ${response.status}.` }, 502);
    }

    return json({ ok: true, message: "Workflow dispatch accepted.", repository, workflow, ref }, 202);
  },
};

async function checkRateLimit(limiter, key) {
  try {
    const result = await limiter.limit({ key });
    return result?.success === true;
  } catch (error) {
    console.error("Rate limiter failed", error?.name || "unknown");
    return null;
  }
}

async function verifyChiAccessToken(token, expectedClientId) {
  try {
    const endpoint = "https://chi.qzz.io/auth/api/userinfo?client_id=" + encodeURIComponent(expectedClientId);
    const response = await fetch(endpoint, {
      method: "GET",
      headers: { "Accept": "application/json", "Authorization": `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;
    const data = await response.json();
    return data?.sub === "chi-owner" && data?.aud === expectedClientId;
  } catch (error) {
    console.error("Chi Auth validation failed", error?.name || "unknown");
    return null;
  }
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
