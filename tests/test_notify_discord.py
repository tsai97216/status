import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import update_status
import notify_discord
from notify_discord import (build_message, calculate_alert_changes, is_failed, is_recovered, normalize_active_failures)
from update_status import normalize_run_status, stale_fallback, inspect_page_content, format_unknown_health_detail


class DiscordAlertTests(unittest.TestCase):
    def test_malformed_alert_state_is_ignored_safely(self):
        self.assertEqual(normalize_active_failures(None), {})
        self.assertEqual(normalize_active_failures([]), {})
        self.assertEqual(normalize_active_failures({"active_failures": []}), {})
        self.assertEqual(
            normalize_active_failures({"active_failures": {
                "good": {"title": "Project"}, "bad": "not a record", 7: {"title": "invalid key"}
            }}),
            {"good": {"title": "Project"}},
        )

    def test_unknown_or_missing_project_does_not_clear_active_alert(self):
        previous = {"vps-01": {"name": "vps-01", "title": "VPS-01", "reason": "端點異常", "url": ""}}
        current = {
            "vps-01": {"name": "vps-01", "status": "unknown",
                       "business": {"business_status": "unknown", "business_label": "資料未知"}}
        }
        new, recovered, active = calculate_alert_changes(current, previous)
        self.assertEqual(new, [])
        self.assertEqual(recovered, [])
        self.assertIn("vps-01", active)

        new, recovered, active = calculate_alert_changes({}, previous)
        self.assertEqual(new, [])
        self.assertEqual(recovered, [])
        self.assertIn("vps-01", active)

    def test_explicit_success_clears_active_alert_once(self):
        previous = {"vps-01": {"name": "vps-01", "title": "VPS-01", "reason": "端點異常", "url": ""}}
        current = {
            "vps-01": {"name": "vps-01", "status": "success",
                       "business": {"business_status": "success", "business_label": "正常"}}
        }
        new, recovered, active = calculate_alert_changes(current, previous)
        self.assertEqual(new, [])
        self.assertEqual([item["name"] for item in recovered], ["vps-01"])
        self.assertEqual(active, {})

    def test_existing_failure_does_not_repeat_as_new_alert(self):
        item = {"name": "demo", "status": "failure", "business": {"business_status": "failure"}}
        previous = {"demo": {"name": "demo", "title": "demo", "reason": "failure", "url": ""}}
        new, recovered, active = calculate_alert_changes({"demo": item}, previous)
        self.assertEqual(new, [])
        self.assertEqual(recovered, [])
        self.assertIn("demo", active)

    def test_business_failure_is_detected_even_when_workflow_succeeded(self):
        item = {
            "name": "vps-01",
            "status": "success",
            "business": {"business_status": "failure", "business_label": "VPS-01 異常"},
        }
        self.assertTrue(is_failed(item))

    def test_workflow_failure_is_detected(self):
        self.assertTrue(is_failed({"name": "demo", "status": "failure", "business": {}}))

    def test_completed_workflow_uses_conclusion_not_literal_completed_status(self):
        self.assertEqual(normalize_run_status({"status": "completed", "conclusion": "success"}), "success")
        self.assertEqual(normalize_run_status({"status": "completed", "conclusion": "failure"}), "failure")
        self.assertEqual(normalize_run_status({"status": "completed", "conclusion": None}), "unknown")

    def test_live_workflow_keeps_live_status(self):
        self.assertEqual(normalize_run_status({"status": "in_progress", "conclusion": None}), "in_progress")
        self.assertEqual(normalize_run_status(None), "unknown")

    def test_health_check_accepts_normal_html_page(self):
        result = inspect_page_content(200, 'text/html', '<html><head><title>Chi Source</title></head><body>OK</body></html>', 'https://ipa.chi.qzz.io/')
        self.assertTrue(result['ok'])
        self.assertEqual(result['title'], 'Chi Source')

    def test_health_check_rejects_http_200_with_empty_body(self):
        result = inspect_page_content(200, 'text/html', '   ', 'https://example.com/')
        self.assertFalse(result['ok'])
        self.assertIn('空', result['reason'])

    def test_health_check_rejects_http_200_error_page(self):
        result = inspect_page_content(200, 'text/html', '<html><title>502 Bad Gateway</title><body>upstream error</body></html>', 'https://example.com/')
        self.assertFalse(result['ok'])
        self.assertIn('錯誤', result['reason'])

    def test_unknown_health_detail_avoids_repeating_status_phrase(self):
        detail = format_unknown_health_detail({"content_reason": "HTML 缺少 title，內容狀態未能確認", "status": 200})
        self.assertEqual(detail, "狀態未確認 · HTML 缺少 title · HTTP 200")

    def test_unknown_health_detail_has_fallback_reason(self):
        detail = format_unknown_health_detail({"status": 200})
        self.assertEqual(detail, "狀態未確認 · 回應內容不足以確認頁面健康 · HTTP 200")

    def test_unknown_health_detail_includes_safe_html_signals(self):
        detail = format_unknown_health_detail({
            "content_reason": "HTML 缺少 title，內容狀態未能確認",
            "content_signals": ["script", "app-root", "viewport"],
            "status": 200,
        })
        self.assertEqual(detail, "狀態未確認 · HTML 缺少 title（頁面包含 script、app/root 容器、viewport） · HTTP 200")

    def test_health_check_accepts_nonempty_titleless_html_with_http_200(self):
        result = inspect_page_content(200, 'text/html', '<html><head><meta name="viewport" content="width=device-width"><script src="/app.js"></script></head><body><div id="app"></div></body></html>', 'https://example.com/')
        self.assertTrue(result['ok'])
        self.assertFalse(result['protected'])
        self.assertIn('略過標題檢查', result['reason'])
        self.assertEqual(result['signals'], ["script", "app-root", "viewport"])

    def test_health_check_marks_protected_page_unknown(self):
        result = inspect_page_content(200, 'text/html', '<html><title>Protected</title><body>Access policy login</body></html>', 'https://example.com/cdn-cgi/access/login')
        self.assertIsNone(result['ok'])
        self.assertTrue(result['protected'])

    def test_api_error_preserves_card_but_marks_data_unknown(self):
        previous = {
            "name": "demo", "status": "success",
            "business": {"business_status": "success", "business_label": "正常", "metrics": [], "note": "原始說明"},
        }
        fallback = stale_fallback({"name": "demo"}, previous, "HTTP 502")
        self.assertEqual(fallback["status"], "unknown")
        self.assertEqual(fallback["business"]["business_status"], "unknown")
        self.assertIn("上次資料", fallback["business"]["business_label"])
        self.assertIn("HTTP 502", fallback["monitor_warning"])
        self.assertIsNone(stale_fallback({"name": "new"}, None, "HTTP 502"))

    def test_running_or_unknown_is_not_reported_as_recovered(self):
        self.assertFalse(is_recovered({"status": "in_progress", "business": {"business_status": "running"}}))
        self.assertFalse(is_recovered({"status": "unknown", "business": {"business_status": "unknown"}}))

    def test_success_is_recovery(self):
        self.assertTrue(is_recovered({"status": "success", "business": {"business_status": "success"}}))
        self.assertTrue(is_recovered({"status": "success", "business": {}}))

    def test_workflow_success_does_not_mask_unknown_business_state(self):
        self.assertFalse(is_recovered({"status": "success", "business": {"business_status": "unknown"}}))
        self.assertFalse(is_recovered({"status": "success", "business": {"business_status": "running"}}))

    def test_workflow_success_does_not_mask_business_failure(self):
        self.assertFalse(is_recovered({"status": "success", "business": {"business_status": "failure"}}))

    def test_message_includes_dashboard_and_does_not_ping_everyone(self):
        message = build_message(
            [{"title": "VPS-01", "reason": "端點異常", "url": "https://example.com"}],
            [{"title": "Chi Source"}],
        )
        self.assertIn("https://status.chi.qzz.io/", json.dumps(message, ensure_ascii=False))
        self.assertEqual(len(message["embeds"]), 2)
        self.assertIn("VPS-01", message["embeds"][0]["title"])
        self.assertEqual(message["embeds"][0]["color"], 15158332)
        self.assertIn("已恢復正常", message["embeds"][1]["title"])
        self.assertEqual(message["embeds"][1]["color"], 3066993)
        self.assertNotIn("@everyone", json.dumps(message, ensure_ascii=False))
        self.assertNotIn("@here", json.dumps(message, ensure_ascii=False))


    def test_more_than_ten_events_are_sent_in_batches(self):
        with tempfile.TemporaryDirectory() as directory:
            status_path = Path(directory) / "status.json"
            state_path = Path(directory) / "alert-state.json"
            items = [
                {"name": f"demo-{i}", "status": "failure",
                 "business": {"business_status": "failure", "business_label": "異常"}}
                for i in range(12)
            ]
            status_path.write_text(json.dumps({"repositories": items}), encoding="utf-8")
            state_path.write_text(json.dumps({"active_failures": {}}) + "\n", encoding="utf-8")

            with (
                patch.object(notify_discord, "STATUS_PATH", status_path),
                patch.object(notify_discord, "STATE_PATH", state_path),
                patch.dict(os.environ, {"DISCORD_WEBHOOK_URL": "https://discord.example/webhook"}),
                patch.object(notify_discord, "post_discord", return_value={"http_status": 200}) as post,
            ):
                self.assertEqual(notify_discord.main(), 0)

            self.assertEqual([len(call.args[1]["embeds"]) for call in post.call_args_list], [10, 2])
            saved = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertEqual(len(saved["active_failures"]), 12)

    def test_partial_batch_failure_does_not_advance_alert_state(self):
        with tempfile.TemporaryDirectory() as directory:
            status_path = Path(directory) / "status.json"
            state_path = Path(directory) / "alert-state.json"
            items = [
                {"name": f"demo-{i}", "status": "failure",
                 "business": {"business_status": "failure", "business_label": "異常"}}
                for i in range(12)
            ]
            status_path.write_text(json.dumps({"repositories": items}), encoding="utf-8")
            original_state = json.dumps({"active_failures": {}}) + "\n"
            state_path.write_text(original_state, encoding="utf-8")

            with (
                patch.object(notify_discord, "STATUS_PATH", status_path),
                patch.object(notify_discord, "STATE_PATH", state_path),
                patch.dict(os.environ, {"DISCORD_WEBHOOK_URL": "https://discord.example/webhook"}),
                patch.object(
                    notify_discord, "post_discord",
                    side_effect=[{"http_status": 200}, RuntimeError("temporary delivery error")],
                ) as post,
            ):
                self.assertEqual(notify_discord.main(), 1)

            self.assertEqual(post.call_count, 2)
            self.assertEqual(state_path.read_text(encoding="utf-8"), original_state)


class VpsAggregationTests(unittest.TestCase):
    @patch("update_status.health_check")
    def test_two_http_200_endpoints_are_enough_for_vps_success(self, mock_health_check):
        mock_health_check.side_effect = [
            {"ok": True, "protected": False, "status": 200, "url": "https://alist.chi.qzz.io/", "latency_ms": 100},
            {"ok": False, "protected": False, "status": 502, "url": "https://bili.chi.qzz.io/", "latency_ms": 200},
            {"ok": None, "protected": True, "status": 200, "url": "https://twitch.chi.qzz.io/", "latency_ms": 150},
        ]
        result = update_status.business_data("vps-01", {"name": "vps-01"})
        self.assertEqual(result["business_status"], "success")
        self.assertIn("至少 2/3 個端點 HTTP 200", result["business_label"])
        details = {item["label"]: item for item in result["details"]}
        self.assertEqual(details["BiliTool"]["tone"], "bad")
        self.assertEqual(details["Twitch Drops Miner"]["tone"], "good")

    @patch("update_status.health_check")
    def test_fewer_than_two_http_200_endpoints_marks_vps_failed(self, mock_health_check):
        mock_health_check.side_effect = [
            {"ok": True, "protected": False, "status": 200, "url": "https://alist.chi.qzz.io/", "latency_ms": 100},
            {"ok": False, "protected": False, "status": 502, "url": "https://bili.chi.qzz.io/", "latency_ms": 200},
            {"ok": False, "protected": False, "status": 503, "url": "https://twitch.chi.qzz.io/", "latency_ms": 150},
        ]
        result = update_status.business_data("vps-01", {"name": "vps-01"})
        self.assertEqual(result["business_status"], "failure")
        self.assertIn("1/3 個端點 HTTP 200", result["business_label"])


class HealthCheckClassificationTests(unittest.TestCase):
    def test_nonempty_titleless_html_200_is_healthy(self):
        result = inspect_page_content(200, "text/html", "<main>App ready</main>", "https://example.com/")
        self.assertIs(result["ok"], True)

    def test_titleless_http_200_nginx_error_page_is_failure(self):
        body = "<html><body><h1>502 Bad Gateway</h1><center>nginx</center></body></html>"
        result = inspect_page_content(200, "text/html", body, "https://example.com/")
        self.assertIs(result["ok"], False)
        self.assertIn("伺服器錯誤頁", result["reason"])

    def test_ordinary_page_text_mentioning_not_found_is_not_rejected(self):
        body = "<html><body><h1>Help</h1><p>If a page is not found, contact support.</p></body></html>"
        result = inspect_page_content(200, "text/html", body, "https://example.com/")
        self.assertIs(result["ok"], True)

    def test_cloudflare_access_login_is_protected_not_failure(self):
        body = "<html><title>Cloudflare Access</title><p>Email address</p><p>One-time PIN</p></html>"
        result = inspect_page_content(200, "text/html", body, "https://example.com/cdn-cgi/access/login")
        self.assertIsNone(result["ok"])
        self.assertIs(result["protected"], True)


    def test_failure_then_recovery_notifies_once(self):
        failure = {
            "name": "demo", "status": "failure",
            "business": {"business_status": "failure", "business_label": "服務異常"},
        }
        success = {
            "name": "demo", "status": "success",
            "business": {"business_status": "success", "business_label": "正常"},
        }
        new, recovered, active = calculate_alert_changes({"demo": failure}, {})
        self.assertEqual([item["name"] for item in new], ["demo"])
        self.assertEqual(recovered, [])
        self.assertIn("demo", active)

        new, recovered, active = calculate_alert_changes({"demo": success}, active)
        self.assertEqual(new, [])
        self.assertEqual([item["name"] for item in recovered], ["demo"])
        self.assertNotIn("demo", active)

        new, recovered, active = calculate_alert_changes({"demo": success}, active)
        self.assertEqual(new, [])
        self.assertEqual(recovered, [])
        self.assertEqual(active, {})

    def test_failed_discord_delivery_does_not_clear_recovery_state(self):
        with tempfile.TemporaryDirectory() as directory:
            status_path = Path(directory) / "status.json"
            state_path = Path(directory) / "alert-state.json"
            previous = {
                "active_failures": {
                    "demo": {"name": "demo", "title": "Demo", "reason": "之前異常", "url": ""}
                }
            }
            status_path.write_text(json.dumps({
                "repositories": [{
                    "name": "demo", "status": "success",
                    "business": {"business_status": "success", "business_label": "正常"}
                }]
            }), encoding="utf-8")
            original_state = json.dumps(previous, ensure_ascii=False, indent=2) + "\n"
            state_path.write_text(original_state, encoding="utf-8")

            with patch.object(notify_discord, "STATUS_PATH", status_path), \
                 patch.object(notify_discord, "STATE_PATH", state_path), \
                 patch.dict(os.environ, {"DISCORD_WEBHOOK_URL": "https://discord.example/webhook"}), \
                 patch.object(notify_discord, "post_discord", side_effect=RuntimeError("temporary delivery error")):
                self.assertEqual(notify_discord.main(), 1)
            self.assertEqual(state_path.read_text(encoding="utf-8"), original_state)

            with patch.object(notify_discord, "STATUS_PATH", status_path), \
                 patch.object(notify_discord, "STATE_PATH", state_path), \
                 patch.dict(os.environ, {"DISCORD_WEBHOOK_URL": "https://discord.example/webhook"}), \
                 patch.object(notify_discord, "post_discord") as post:
                self.assertEqual(notify_discord.main(), 0)
                post.assert_called_once()
            self.assertEqual(json.loads(state_path.read_text(encoding="utf-8")), {"active_failures": {}})


if __name__ == "__main__":
    unittest.main()
