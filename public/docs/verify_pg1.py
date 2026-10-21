import base64, json, urllib.request
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
def verify_pg1(result, sig, jwks_url="https://pg1-ai-agent.vercel.app/.well-known/pg1-signing-key"):
    clean = {k: v for k, v in result.items() if k != "signature"}
    jwk = next((k for k in json.load(urllib.request.urlopen(jwks_url))["keys"] if k["kid"] == sig["kid"]), None)
    if jwk is None or sig["alg"] != "EdDSA": return False
    signed = json.dumps({"request_hash": sig["request_hash"], "result": clean, "sources": sig["sources"], "timestamp": sig["timestamp"], "version": sig["version"]}, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    b64 = lambda s: base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
    try: Ed25519PublicKey.from_public_bytes(b64(jwk["x"])).verify(b64(sig["sig"]), signed.encode("utf-8")); return True
    except Exception: return False
