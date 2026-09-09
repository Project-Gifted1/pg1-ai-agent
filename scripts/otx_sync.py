import os
import sys
import requests

OTX_API_KEY = os.getenv("OTX_API")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
BATCH_LIMIT = int(os.getenv("BATCH_LIMIT", "1000"))

if not all([OTX_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY]):
    print("[-] Missing critical environment variables. Check OTX_API, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY.")
    sys.exit(1)

print(f"[*] Fetching up to {BATCH_LIMIT} recent indicators from Supabase...")
supabase_headers = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    "Content-Type": "application/json"
}

supabase_endpoint = f"{SUPABASE_URL}/rest/v1/stix_indicators?select=type,indicator_value,confidence,stix_pattern&limit={BATCH_LIMIT}"
response = requests.get(supabase_endpoint, headers=supabase_headers)

if response.status_code != 200:
    print(f"[-] Failed to query Supabase: {response.status_code} - {response.text}")
    sys.exit(1)

raw_indicators = response.json()
if not raw_indicators:
    print("[!] No new indicators found in Supabase to sync.")
    sys.exit(0)

print(f"[+] Retrieved {len(raw_indicators)} indicators from database.")

otx_indicators = []
for ind in raw_indicators:
    stix_type = ind.get("type", "").lower()
    val = ind.get("indicator_value")
    
    otx_type = None
    if "ipv4" in stix_type or "ipv4-addr" in stix_type:
        otx_type = "IPv4"
    elif "ipv6" in stix_type or "ipv6-addr" in stix_type:
        otx_type = "IPv6"
    elif "domain" in stix_type:
        otx_type = "domain"
    elif "cve" in stix_type:
        otx_type = "CVE"
    elif "url" in stix_type:
        otx_type = "URL"
    
    if otx_type and val:
        otx_indicators.append({
            "indicator": val,
            "type": otx_type,
            "description": f"Sovereign Pipeline Auto-Ingest (Confidence: {ind.get('confidence', 100)}%)"
        })

if not otx_indicators:
    print("[-] No indicators matched valid OTX types after mapping. Aborting pulse creation.")
    sys.exit(0)

print(f"[*] Compiling OTX Pulse with {len(otx_indicators)} mapped indicators...")
otx_headers = {
    "X-OTX-API-KEY": OTX_API_KEY,
    "Content-Type": "application/json"
}

pulse_payload = {
    "name": "Sovereign Threat Pipeline - Auto-Ingested Crypto Threats",
    "description": "Automated threat intelligence telemetry harvested from decentralized node monitoring and crypto-threat-signals endpoints.",
    "public": True,
    "indicators": otx_indicators[:1000],
    "tags": ["crypto", "threat-intel", "automated-pipeline", "sovereign"]
}

otx_endpoint = "https://otx.alienvault.com/api/v1/pulses/create"
otx_response = requests.post(otx_endpoint, json=pulse_payload, headers=otx_headers)

if otx_response.status_code in [200, 201]:
    pulse_data = otx_response.json()
    print(f"[+] OTX Pulse created successfully! Pulse ID: {pulse_data.get('id')}")
    print(f"[+] View Pulse: https://otx.alienvault.com/pulse/{pulse_data.get('id')}")
else:
    print(f"[-] OTX API Error: {otx_response.status_code} - {otx_response.text}")
    sys.exit(1)
