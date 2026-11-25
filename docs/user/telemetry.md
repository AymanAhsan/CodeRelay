# Telemetry

CodeRelay has removed product usage reporting and relay trace export. To use this change, update
your clients and the CodeRelay server they connect to. If you operate a relay, update its Worker
as well.

Local diagnostics and usage history are available in the app. Server operators can configure
[OpenTelemetry export](../operations/observability.md) to a collector of their choice.
