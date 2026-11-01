#encoding: utf-8
"""Local static server + LLM/TTS proxy.

Browser pages on 127.0.0.1 cannot call Aliyun/Xiaomi APIs (CORS).
POST /_proxy?u=<https url> forwards the JSON body and Authorization header.

  python scripts/serve.py
  # http://127.0.0.1:8765/
"""
from __future__ import annotations

import ipaddress
import json
import os
import sys
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
PROVIDERS = ROOT / "config" / "providers.json"
# 8765 is the documented dev port; RYZA_PORT exists so a test can bind a free
# one instead of fighting a dev server that is already running.
PORT = int(os.environ.get("RYZA_PORT") or 8765)
DATA_CONFIG = ROOT / "data-config"
STORAGE_FILE = DATA_CONFIG / "settings.json"
# Cloudflare (opencode.ai etc.) returns 1010 for the default Python-urllib UA.
UA = "RyzaChat/1.2.23"


def is_loopback_host(host: str) -> bool:
    """True for 127.0.0.0/8, ::1 and `localhost` — and nothing else."""
    h = (host or "").strip().strip("[]").lower()
    if not h:
        return False
    if h == "localhost":
        return True
    try:
        return ipaddress.ip_address(h).is_loopback
    except ValueError:
        return False


def proxy_target_allowed(target: str) -> bool:
    """https anywhere, http only on loopback.

    The https rule exists so an API key never crosses the network in clear.
    A loopback target never crosses the network: the operator is running the
    model on their own machine (Ollama on 127.0.0.1:11434, LM Studio,
    llama.cpp), so refusing it only broke the local-first setup this client is
    built around. Everything that is not loopback still has to be https.
    desktop/main.js and android/.../AssetServer.java carry the same rule.
    """
    parts = urlparse(target)
    if parts.scheme == "https":
        return True
    return parts.scheme == "http" and is_loopback_host(parts.hostname)


class Server(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/_proxy":
            self._proxy_get(parsed)
            return
        if path == "/api/storage":
            if STORAGE_FILE.is_file():
                raw = STORAGE_FILE.read_bytes()
            else:
                raw = b"{}"
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)
            return
        if path == "/config/providers.json" and PROVIDERS.is_file():
            raw = PROVIDERS.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)
            return
        return SimpleHTTPRequestHandler.do_GET(self)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        SimpleHTTPRequestHandler.end_headers(self)

    def _proxy_get(self, parsed):
        """GET /_proxy?u=<https url> — forwards a GET (Qwen TTS returns
        time-limited OSS audio URLs; the page pulls them through here so
        the blob is same-origin for the lip-sync analyser)."""
        target = (parse_qs(parsed.query).get("u") or [""])[0]
        if not proxy_target_allowed(target):
            self.send_error(400, "proxy target must be https (or http on loopback)")
            return
        try:
            headers = {"User-Agent": UA}
            auth = self.headers.get("Authorization")
            if auth:
                headers["Authorization"] = auth
            apikey = self.headers.get("api-key") or self.headers.get("Api-Key")
            if apikey:
                headers["api-key"] = apikey
            model = self.headers.get("model")
            if model:
                headers["model"] = model
            req = Request(target, headers=headers, method="GET")
            with urlopen(req, timeout=120) as resp:
                data = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type", resp.headers.get("Content-Type") or "application/octet-stream")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except HTTPError as e:
            data = e.read() if e.fp else str(e).encode("utf-8")
            self.send_response(e.code)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (URLError, TimeoutError, OSError) as e:
            msg = json.dumps({"error": {"message": str(e)}}).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, api-key, model")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/storage":
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n) if n else b"{}"
            try:
                json.loads(body.decode("utf-8"))
                DATA_CONFIG.mkdir(parents=True, exist_ok=True)
                tmp = STORAGE_FILE.with_suffix(".json.tmp")
                tmp.write_bytes(body)
                tmp.replace(STORAGE_FILE)
                resp = b'{"ok":true}'
                self.send_response(200)
            except Exception as e:
                resp = json.dumps({"error": str(e)}).encode("utf-8")
                self.send_response(400)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(resp)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(resp)
            return
        if parsed.path != "/_proxy":
            self.send_error(404, "not found")
            return
        target = (parse_qs(parsed.query).get("u") or [""])[0]
        if not proxy_target_allowed(target):
            self.send_error(400, "proxy target must be https (or http on loopback)")
            return
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        headers = {
            "Content-Type": self.headers.get("Content-Type") or "application/json",
            "User-Agent": UA,
        }
        auth = self.headers.get("Authorization")
        if auth:
            headers["Authorization"] = auth
        apikey = self.headers.get("api-key") or self.headers.get("Api-Key")
        if apikey:
            headers["api-key"] = apikey
        # The CURRENT Fish Audio API names its engine in a `model` HEADER (the
        # older surface named it in the body). A proxy that forwarded only
        # Authorization dropped it, so Fish fell back to a paid engine and
        # answered 402 "Insufficient API credit" — the whole reason TTS through
        # the packaged hosts could never work on that surface. Forward it.
        model = self.headers.get("model")
        if model:
            headers["model"] = model
        req = Request(target, data=body, headers=headers, method="POST")
        try:
            with urlopen(req, timeout=180) as resp:
                data = resp.read()
                self.send_response(resp.status)
                ctype = resp.headers.get("Content-Type") or "application/json"
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except HTTPError as e:
            data = e.read() if e.fp else (str(e).encode("utf-8"))
            self.send_response(e.code)
            self.send_header("Content-Type", e.headers.get("Content-Type") or "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (URLError, TimeoutError, OSError) as e:
            msg = json.dumps({"error": {"message": str(e)}}).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)


def main():
    os.chdir(WEB)
    httpd = Server(("127.0.0.1", PORT), partial(Handler, directory=str(WEB)))
    print("Ryza chat  http://127.0.0.1:%d/  (static + LLM proxy)" % PORT, flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
        httpd.shutdown()


if __name__ == "__main__":
    main()
