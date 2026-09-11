import uuid
import hashlib
from datetime import datetime, timezone

class WorkerIdentity:
    """Generates and manages cryptographic identities for swarm workers."""
    
    @staticmethod
    def generate_identity(node_seed: str = None) -> dict:
        worker_uuid = str(uuid.uuid4())
        raw_seed = node_seed if node_seed else worker_uuid
        
        # Generate a distinct cryptographic hash for the worker's operational signature
        op_hash = hashlib.sha256(f"sovereign_worker_{raw_seed}_{datetime.now(timezone.utc).timestamp()}".encode()).hexdigest()
        
        identity = {
            "worker_id": f"wrk_{worker_uuid[:8]}",
            "full_uuid": worker_uuid,
            "operational_hash": op_hash,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "status": "READY"
        }
        print(f"[WorkerIdentity] Identity generated for node: {identity['worker_id']}")
        return identity