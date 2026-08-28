# pg1-ai-agent
Private local multimodal AI client⁠.

## Sovereign threat pipeline integration
- The app reads high-level telemetry from `Project-Gifted1/sovereign-threat-pipeline` through `/api/pipeline-status`.
- Pipeline logic remains isolated in its own repository; this UI only renders status signals and guarded operator controls.
- Write actions are confirmation-gated and policy-controlled through `/api/pipeline-control`.
 
