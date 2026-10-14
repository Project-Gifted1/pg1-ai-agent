import sys

from pg1_sdk import PG1Client

pg1 = PG1Client()
r = pg1.preflight("pay", sys.argv[1] if len(sys.argv) > 1 else "0x" + "0" * 40, chain="base")
if "payment_required" in r:
    print("Free tier used up: set a payer (x402) or a licence key.")
else:
    print(r["result"]["decision"], [x["code"] for x in r["result"]["reasons"]], "signature:", r["verified"]["reason"])
    sys.exit(0 if r["result"]["decision"] == "no_flags" else 1)  # fail closed
