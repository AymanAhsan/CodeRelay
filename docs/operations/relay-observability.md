# Relay observability

The relay writes operational logs through Cloudflare. Use the Worker logs to check failed
requests and scheduled cleanup runs.

The deployment stack still manages the legacy Axiom resources to preserve historical data.
CodeRelay builds and relay deployments no longer export traces to Axiom. Existing installations
and deployed relay Workers need to be updated for the change to take effect.
