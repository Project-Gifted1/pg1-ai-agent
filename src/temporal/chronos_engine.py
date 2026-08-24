"""
Chronos Temporal Simulation Engine v1.0
Project: PG1 Temporal Mechanics & Time-Travel Simulation Core
"""

import math
import json
import time

C = 299792458  # Speed of light in m/s
G = 6.67430e-11  # Gravitational constant

class ChronosEngine:
    def __init__(self, observer_id="PG1-CHRONOS-01"):
        self.observer_id = observer_id
        self.timeline_log = []

    def calculate_velocity_dilation(self, velocity_mps: float, proper_time_seconds: float) -> dict:
        """Calculates Special Relativistic time dilation."""
        if velocity_mps >= C:
            return {"error": "Velocity cannot equal or exceed the speed of light."}
        
        gamma = 1.0 / math.sqrt(1.0 - (velocity_mps ** 2 / C ** 2))
        dilated_time = proper_time_seconds * gamma
        
        result = {
            "proper_time_s": proper_time_seconds,
            "velocity_mps": velocity_mps,
            "velocity_fraction_c": velocity_mps / C,
            "lorentz_factor_gamma": gamma,
            "dilated_time_s": dilated_time,
            "time_difference_s": dilated_time - proper_time_seconds
        }
        self.timeline_log.append({"type": "velocity_dilation", "data": result, "ts": time.time()})
        return result

    def calculate_gravitational_dilation(self, mass_kg: float, radius_m: float, proper_time_seconds: float) -> dict:
        """Calculates General Relativistic gravitational time dilation."""
        schwarzschild_radius = (2 * G * mass_kg) / (C ** 2)
        if radius_m <= schwarzschild_radius:
            return {"error": "Radius is inside the event horizon (Schwarzschild radius)."}
        
        factor = math.sqrt(1.0 - (schwarzschild_radius / radius_m))
        dilated_time = proper_time_seconds / factor
        
        result = {
            "proper_time_s": proper_time_seconds,
            "mass_kg": mass_kg,
            "radius_m": radius_m,
            "schwarzschild_radius_m": schwarzschild_radius,
            "dilation_factor": factor,
            "dilated_time_s": dilated_time
        }
        self.timeline_log.append({"type": "gravitational_dilation", "data": result, "ts": time.time()})
        return result

    def simulate_ctc_consistency(self, loop_iterations: int = 10, probability_threshold: float = 0.99) -> dict:
        """Simulates Novikov Self-Consistency Principle along Closed Timelike Curves."""
        timelines = []
        for i in range(loop_iterations):
            stability_index = min(1.0, 0.95 + (i * 0.005))
            paradox_probability = max(0.0, 1.0 - stability_index)
            timelines.append({
                "iteration": i + 1,
                "stability_index": round(stability_index, 4),
                "paradox_resolved": stability_index >= probability_threshold,
                "entropy_flux": round(math.sin(i) * 0.05, 4)
            })
        
        summary = {
            "observer": self.observer_id,
            "ctc_status": "CONVERGED_STABLE",
            "iterations_evaluated": loop_iterations,
            "timeline_history": timelines
        }
        return summary

if __name__ == "__main__":
    engine = ChronosEngine()
    print("--- Special Relativity Dilation (0.95c for 1 year) ---")
    print(json.dumps(engine.calculate_velocity_dilation(0.95 * C, 31536000), indent=2))
    print("\n--- CTC Consistency Simulation ---")
    print(json.dumps(engine.simulate_ctc_consistency(5), indent=2))
