"""pg1-sdk: a small client for PG1.

    from pg1_sdk import PG1Client
    pg1 = PG1Client()                       # optional: api_key=..., payer=...
    r = pg1.preflight("pay", "0x...", chain="base")
    if not r["verified"]["valid"] or r["result"]["decision"] != "no_flags":
        stop()

Every result is checked against PG1's Ed25519 keys at
/.well-known/pg1-signing-key unless verify=False. Payment: the free tier
first; when a tool asks for payment, the `payer` callable you supply turns
PG1's x402 PaymentRequired into a PaymentPayload and the call is retried
once. Without a payer you get {"payment_required": ...}.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import urllib.request
from decimal import Decimal
from typing import Any, Callable, Optional

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

__all__ = ["PG1Client", "PG1Error", "canonical_json", "request_hash", "verify_result", "verify_webhook"]
__version__ = "0.1.0"

DEFAULT_BASE_URL = "https://pg1-ai-agent.vercel.app"
SIGNATURE_META = "pg1/signature"


def canonical_json(value: Any) -> str:
    """Sorted keys, no whitespace, the same bytes PG1 signs."""
    if isinstance(value, dict):
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canonical_json(value[k]) for k in sorted(value)) + "}"
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    return _scalar(value)


def _scalar(v: Any) -> str:
    if isinstance(v, bool) or v is None:
        return json.dumps(v)
    if isinstance(v, float):
        return _js_number(v)
    return json.dumps(v, ensure_ascii=False)


def _js_number(f: float) -> str:
    """A float the way JavaScript's JSON.stringify writes it."""
    if f != f or f in (float("inf"), float("-inf")):
        return "null"
    if f.is_integer() and abs(f) < 1e21:
        return str(int(f))
    r = repr(f)
    if "e" not in r:
        return r
    mantissa, exp = r.split("e")
    e = int(exp)
    if -7 < e < 21:
        return format(Decimal(r), "f")
    return f"{mantissa}e{'+' if e > 0 else '-'}{abs(e)}"


def request_hash(tool: str, args: Optional[dict]) -> str:
    return hashlib.sha256(canonical_json({"tool": str(tool or ""), "arguments": args or {}}).encode()).hexdigest()


def _b64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _sources(result: dict) -> list:
    out: list = []
    for c in result.get("checks") or []:
        src = c.get("source") if isinstance(c, dict) else None
        if src and str(src) not in out:
            out.append(str(src))
    return out


def verify_result(result: dict, signature: dict, jwks: dict, tool: Optional[str] = None, args: Optional[dict] = None) -> dict:
    if not isinstance(signature, dict):
        return {"valid": False, "reason": "missing_signature"}
    if signature.get("alg") != "EdDSA":
        return {"valid": False, "reason": "unsupported_alg"}
    key = next((k for k in jwks.get("keys", []) if k.get("kid") == signature.get("kid") and k.get("kty") == "OKP" and k.get("crv") == "Ed25519"), None)
    if not key:
        return {"valid": False, "reason": "unknown_key", "kid": signature.get("kid")}
    if tool is not None and request_hash(tool, args or {}) != signature.get("request_hash"):
        return {"valid": False, "reason": "request_mismatch", "kid": key["kid"]}
    if not isinstance(result, dict):
        return {"valid": False, "reason": "missing_result", "kid": key["kid"]}
    clean = {k: v for k, v in result.items() if k != "signature"}
    if canonical_json(_sources(clean)) != canonical_json(signature.get("sources") or []):
        return {"valid": False, "reason": "sources_mismatch", "kid": key["kid"]}
    payload = canonical_json({"request_hash": signature.get("request_hash"), "result": clean, "sources": signature.get("sources"), "timestamp": signature.get("timestamp"), "version": signature.get("version")})
    try:
        Ed25519PublicKey.from_public_bytes(_b64u(key["x"])).verify(_b64u(signature.get("sig", "")), payload.encode())
        return {"valid": True, "reason": "ok", "kid": key["kid"]}
    except (InvalidSignature, ValueError):
        return {"valid": False, "reason": "bad_signature", "kid": key["kid"]}


def verify_webhook(secret: str, body: str, header: str, tolerance_sec: int = 300, now_sec: Optional[int] = None) -> bool:
    """Checks a watchlist webhook's X-PG1-Signature header."""
    try:
        parts = dict(p.split("=", 1) for p in (header or "").split(","))
        t, v1 = int(parts["t"]), parts["v1"]
    except (KeyError, ValueError):
        return False
    if abs((now_sec if now_sec is not None else int(time.time())) - t) > tolerance_sec:
        return False
    expected = hmac.new(secret.encode(), f"{t}.{body}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, v1)


class PG1Error(Exception):
    def __init__(self, message: str, code: Any = None, data: Any = None):
        super().__init__(message)
        self.code = code
        self.data = data


class PG1Client:
    def __init__(self, base_url: str = DEFAULT_BASE_URL, api_key: Optional[str] = None, payer: Optional[Callable[[dict, dict], dict]] = None, verify: bool = True, timeout: float = 20.0, opener: Optional[Callable[..., Any]] = None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.payer = payer
        self.verify = verify
        self.timeout = timeout
        self._open = opener or urllib.request.urlopen
        self._jwks: Optional[tuple] = None
        self._id = 0

    def _get_json(self, url: str) -> Any:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with self._open(req, timeout=self.timeout) as res:
            return json.loads(res.read().decode())

    def jwks(self, refresh: bool = False) -> dict:
        if not refresh and self._jwks and self._jwks[1] > time.time():
            return self._jwks[0]
        value = self._get_json(f"{self.base_url}/.well-known/pg1-signing-key")
        self._jwks = (value, time.time() + 3600)
        return value

    def _rpc(self, method: str, params: dict) -> Any:
        self._id += 1
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if self.api_key:
            headers["x-api-key"] = self.api_key
        data = json.dumps({"jsonrpc": "2.0", "id": self._id, "method": method, "params": params}).encode()
        req = urllib.request.Request(f"{self.base_url}/api/mcp", data=data, headers=headers, method="POST")
        with self._open(req, timeout=self.timeout) as res:
            body = json.loads(res.read().decode())
        if body.get("error"):
            raise PG1Error(body["error"].get("message", "error"), body["error"].get("code"), body["error"].get("data"))
        return body["result"]

    def list_tools(self) -> list:
        return self._rpc("tools/list", {})["tools"]

    def call(self, name: str, args: Optional[dict] = None, payment: Optional[dict] = None) -> dict:
        args = args or {}
        params: dict = {"name": name, "arguments": args}
        if payment:
            params["_meta"] = {"x402/payment": payment}
        r = self._rpc("tools/call", params)
        text = (r.get("content") or [{}])[0].get("text")
        try:
            parsed = json.loads(text) if text else None
        except ValueError:
            parsed = None
        if r.get("isError"):
            pr = r.get("structuredContent") if isinstance(r.get("structuredContent"), dict) and "accepts" in r["structuredContent"] else (parsed if isinstance(parsed, dict) and "accepts" in parsed else None)
            if pr is not None:
                if payment or not self.payer:
                    return {"payment_required": pr}
                return self.call(name, args, payment=self.payer(pr, {"tool": name, "args": args}))
            raise PG1Error(str((parsed or {}).get("error") or text or "tool error"), (parsed or {}).get("code"), parsed)
        signature = (r.get("_meta") or {}).get(SIGNATURE_META)
        out = {"result": parsed, "signature": signature, "paid": bool(payment), "verified": None}
        if self.verify:
            out["verified"] = verify_result(parsed, signature, self.jwks(), name, args) if signature else {"valid": False, "reason": "missing_signature"}
        return out

    def preflight(self, action: str, target: str, chain: Optional[str] = None, ecosystem: Optional[str] = None) -> dict:
        args: dict = {"action": action, "target": target}
        if chain:
            args["chain"] = chain
        if ecosystem:
            args["ecosystem"] = ecosystem
        return self.call("preflight_check", args)

    def check_wallet_sanctions(self, address: str) -> dict:
        return self.call("check_wallet_sanctions", {"address": address})

    def check_wallet_age(self, address: str, chain: str = "base") -> dict:
        return self.call("check_wallet_age", {"address": address, "chain": chain})

    def check_domain_age(self, domain: str) -> dict:
        return self.call("check_domain_age", {"domain": domain})

    def check_hostname_reputation(self, hostname: str) -> dict:
        return self.call("check_hostname_reputation", {"hostname": hostname})

    def check_package(self, ecosystem: str, name: str, version: Optional[str] = None) -> dict:
        return self.call("check_package", {"ecosystem": ecosystem, "name": name, **({"version": version} if version else {})})

    def check_x402_endpoint(self, url: str) -> dict:
        return self.call("check_x402_endpoint", {"url": url})

    def check_agent_card(self, url_or_domain: str) -> dict:
        return self.call("check_agent_card", {"url": url_or_domain} if url_or_domain.startswith("https://") else {"domain": url_or_domain})

    def get_cve_details(self, cve_id: str) -> dict:
        return self.call("get_cve_details", {"cve_id": cve_id})

    def get_usage_status(self) -> dict:
        return self.call("get_usage_status", {})
