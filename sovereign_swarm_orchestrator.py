import os
import sys
from datetime import datetime, timezone
from supabase import create_client, Client

# Force the runner's workspace root into the Python path to resolve adjacent modules
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))
sys.path.insert(0, os.getcwd())

# Pipeline version configuration
PIPELINE_VERSION = "1.0"

# Import internal swarm modules directly using absolute paths 
from swarm_registry import SwarmRegistry
from worker_identity import WorkerIdentityManager
from swarm_dispatcher import SwarmTaskDispatcher
from swarm_auditor import SwarmConsensusAuditor

def main():
    print(f"=== [ Sovereign Multi-Agent Swarm Orchestrator v{PIPELINE_VERSION} ] ===")

    # Step 1: Initialize Swarm Registry
    registry = SwarmRegistry()

    # Step 2: Provision Cryptographic Worker Identities
    worker_1 = WorkerIdentityManager.generate_worker_did("Alpha-IOC-Analyzer", "IOC_ANALYSIS")
    worker_2 = WorkerIdentityManager.generate_worker_did("Beta-IOC-Analyzer", "IOC_ANALYSIS")
    worker_3 = WorkerIdentityManager.generate_worker_did("Gamma-STIX-Inspector", "STIX_VERIFICATION")

    registry.register_worker(worker_1)
    registry.register_worker(worker_2)
    registry.register_worker(worker_3)

    # Step 3: Dispatch Work to Swarm Queue
    dispatcher = SwarmTaskDispatcher(registry)
    
    t1 = dispatcher.submit_task("IOC_ANALYSIS", {"ip": "185.220.101.5"}, required_consensus=2)
    t2 = dispatcher.submit_task("STIX_VERIFICATION", {"bundle_id": "bundle--abc1234"}, required_consensus=1)

    # Step 4: Execute Asynchronous Queue Processing
    print("\n[Processing Swarm Queue...]")
    dispatcher.process_queue()

    # Step 5: Verify Consensus Audit
    print("\n[Auditing Consensus and Cryptographic Proofs...]")
    res1 = dispatcher.results.get(t1)
    audit_ok, audit_details = SwarmConsensusAuditor.audit_task_consensus(res1)

    print(f" -> Task ID: {t1}")
    print(f" -> Consensus Status: {audit_details['status']}")
    print(f" -> Consensus Action: {audit_details.get('agreed_action')}")
    print(f" -> Nodes Participated: {audit_details['participating_nodes']}")

    # Step 6: Connect and Persist to Supabase
    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")

    if not supabase_url or not supabase_key:
        print("[!] Error: Supabase environment variables missing from runner.")
        sys.exit(1)

    supabase: Client = create_client(supabase_url, supabase_key)

    payload = {
        "task_id": t1,
        "task_type": res1.get("task_type"),
        "consensus_status": audit_details.get("status"),
        "agreed_action": audit_details.get("agreed_action"),
        "participating_nodes": audit_details.get("participating_nodes"),
        "audit_data": audit_details,
        "task_result": res1,
        "registered_workers": [data["identity"] for data in registry.workers.values()],
        "logged_at": datetime.now(timezone.utc).isoformat()
    }

    try:
        response = supabase.table("swarm_telemetry").insert(payload).execute()
        print("[✔] Swarm consensus and worker identities successfully written to Supabase.")
    except Exception as e:
        print(f"[!] Supabase insertion failed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
