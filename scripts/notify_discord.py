#!/usr/bin/env python3
"""Send deduplicated project-failure alerts to a Discord webhook."""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

STATUS_PATH = Path("status.json")
STATE_PATH = Path("alert-state.json")
FAILURE_STATUSES = {"failure", "timed_out", "action_required", "startup_failure"}


def is_failed(item):
    business = item.get("business") or {}
    return item.get("status") in FAILURE_STATUSES or business.get("business_status") in FAILURE_STATUSES


def is_recovered(item):
    """Require explicit success from the same source that can report business health."""
    business = item.get("business") or {}
    if is_failed(item):
        return False
    business_status = business.get("business_status")
    # A generic green Actions run must not hide an unknown or still-failing
    # business result (for example, a reachable workflow but unhealthy VPS).
    if business_status:
        return business_status == "success"
    return item.get("status") == "success"


def failure_record(item):
    business = item.get("business") or {}
    return {
        "name": item.get("name") or item.get("full_name") or "unknown",
        "title": business.get("title") or item.get("workflow") or item.get("name") or "未知專案",
        "reason": business.get("business_label") or item.get("status") or "狀態失敗",
        "url": item.get("run_url") or item.get("runs_url") or item.get("html_url") or "",
    }


def read_json(path, default):
    try:
        with path.open("r", encoding="utf-8") as stream:
            return json.load(stream)
    except (OSError, json.JSONDecodeError):
        return default


def post_discord(webhook_url, payload):
    payload = dict(payload)
    payload["allowed_mentions"] = {"parse": []}
    payload = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json", "User-Agent": "ChiStatus/1.0"}

    # Ask Discord to return the created message, including its channel ID.
    # This distinguishes an accepted message from an unknown destination.
    parts = urlsplit(webhook_url)
    query = [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True)
             if key != "wait"]
    query.append(("wait", "true"))
    verified_url = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))

    for attempt in range(3):
        request = urllib.request.Request(verified_url, data=payload, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                if 200 <= response.status < 300:
                    body = response.read().decode("utf-8", errors="replace").strip()
                    try:
                        result = json.loads(body) if body else {}
                    except json.JSONDecodeError:
                        result = {}
                    if not isinstance(result, dict):
                        result = {}
                    result["http_status"] = response.status
                    return result
                raise RuntimeError(f"Discord webhook returned HTTP {response.status}")
        except urllib.error.HTTPError as exc:
            # Retry rate limits and transient server errors, but fail fast for
            # invalid webhook URLs or other client errors.
            if exc.code != 429 and exc.code < 500:
                raise
            if attempt == 2:
                raise
            retry_after = exc.headers.get("Retry-After", "")
            try:
                delay = min(30, max(1, float(retry_after)))
            except (TypeError, ValueError):
                delay = 2 ** attempt
            time.sleep(delay)
        except (urllib.error.URLError, TimeoutError):
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)
def build_message(new_failures, recovered):
    """Build compact, color-coded Discord embeds for incident transitions."""
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    embeds = []

    for item in new_failures:
        embed = {
            "title": f"🔴 {item['title']}：偵測到異常"[:256],
            "description": f"**狀態：** 異常\n**原因：** {item['reason']}"[:4096],
            "color": 15158332,
            "timestamp": now,
            "footer": {"text": "Chi Status · 自動監控"},
            "fields": [{"name": "監控儀表板", "value": "[開啟狀態頁](https://status.chi.qzz.io/)", "inline": True}],
        }
        if item.get("url", "").startswith(("https://", "http://")):
            embed["url"] = item["url"]
        embeds.append(embed)

    for item in recovered:
        embed = {
            "title": f"🟢 {item.get('title') or item.get('name') or '專案'}：已恢復正常"[:256],
            "description": "**狀態：** 已恢復正常\n監控結果已重新回到成功狀態。",
            "color": 3066993,
            "timestamp": now,
            "footer": {"text": "Chi Status · 自動監控"},
            "fields": [{"name": "監控儀表板", "value": "[開啟狀態頁](https://status.chi.qzz.io/)", "inline": True}],
        }
        if item.get("url", "").startswith(("https://", "http://")):
            embed["url"] = item["url"]
        embeds.append(embed)

    payload = {
        "content": "Chi Status｜監控事件通知",
        "embeds": embeds,
    }
    if len(embeds) > 10:
        payload["content"] += f"（本次共 {len(embeds)} 件事件，將分批傳送）"
    return payload


def normalize_active_failures(state):
    """Ignore malformed persisted alert state instead of crashing notification runs."""
    if not isinstance(state, dict):
        return {}
    active = state.get("active_failures", {})
    if not isinstance(active, dict):
        return {}
    return {name: record for name, record in active.items()
            if isinstance(name, str) and isinstance(record, dict)}


def calculate_alert_changes(current, previous):
    """Compute alert transitions without treating missing/unknown data as recovery."""
    current_failures = {
        name: failure_record(item)
        for name, item in current.items()
        if is_failed(item)
    }
    new_failures = [
        record for name, record in current_failures.items()
        if name not in previous
    ]
    recovered = [
        previous[name] for name in previous
        if name in current
        and name not in current_failures
        and is_recovered(current[name])
    ]

    # Missing, unknown, or running results do not prove a prior incident recovered.
    next_active = dict(current_failures)
    for name, record in previous.items():
        if name not in current or (
            name not in current_failures and not is_recovered(current[name])
        ):
            next_active[name] = record
    return new_failures, recovered, next_active


def main():
    webhook_url = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()
    if not webhook_url:
        print("DISCORD_WEBHOOK_URL 未設定；無法傳送告警。", file=sys.stderr)
        return 1

    payload = read_json(STATUS_PATH, {})
    if not isinstance(payload, dict):
        print("status.json 根資料格式錯誤；無法判斷告警，保留告警狀態。", file=sys.stderr)
        return 1
    items = payload.get("repositories", [])
    if not isinstance(items, list):
        print("status.json 的 repositories 格式錯誤；無法判斷告警，保留告警狀態。", file=sys.stderr)
        return 1

    current = {str(item.get("name") or item.get("full_name")): item for item in items
               if isinstance(item, dict) and (item.get("name") or item.get("full_name"))}
    previous_state = read_json(STATE_PATH, {"active_failures": {}})
    previous = normalize_active_failures(previous_state)
    new_failures, recovered, next_active = calculate_alert_changes(current, previous)

    if not new_failures and not recovered:
        print(f"沒有新的異常或恢復事件；目前追蹤 {len(next_active)} 個異常。")
        STATE_PATH.write_text(json.dumps({"active_failures": next_active}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return 0

    message = build_message(new_failures, recovered)
    embeds = message.get("embeds", [])
    batches = [
        {**message, "embeds": embeds[offset:offset + 10]}
        for offset in range(0, len(embeds), 10)
    ]
    deliveries = []
    try:
        for index, batch in enumerate(batches, start=1):
            delivery = post_discord(webhook_url, batch)
            deliveries.append(delivery if isinstance(delivery, dict) else {})
            print(f"Discord 通知批次已送達：{index}/{len(batches)}。")
    except Exception as exc:
        # Keep the old state until every batch succeeds. If a later batch fails,
        # an earlier batch may be repeated on retry, but no incident is silently dropped.
        print(f"Discord 通知傳送失敗，保留告警狀態供下次重試：{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    STATE_PATH.write_text(json.dumps({"active_failures": next_active}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    last_delivery = deliveries[-1] if deliveries else {}
    print(
        f"Discord Webhook 已接受全部 {len(deliveries)} 批訊息；"
        f"最後一批 HTTP {last_delivery.get('http_status', '2xx')}；"
        f"message_id={last_delivery.get('id', '未回傳')}；"
        f"channel_id={last_delivery.get('channel_id', '未回傳')}。"
    )
    print(f"Discord 通知已送出：新異常 {len(new_failures)}，恢復 {len(recovered)}。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
