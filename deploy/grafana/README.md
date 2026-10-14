# Grafana dashboard

`managed-agents-dashboard.json` charts the Prometheus metrics the gateway (`:8080/metrics`) and workers
(`:9090/metrics`, set with `AGENTS_METRICS_PORT`) export: queue depth, runs by stop reason, run latency,
time to first token, tokens, prompt cache hit ratio, tool error rate, model API errors, runs resumed after
a worker failure, and gateway traffic. Import it in Grafana (Dashboards → New → Import) and pick your
Prometheus data source. The Helm chart annotates gateway and worker pods for Prometheus scraping.

Cost per run is not a metric: token counts by model are, so multiply by your prices in a recording rule
or use `GET /v1/usage`.

Traces: set `OTEL_EXPORTER_OTLP_ENDPOINT` and install the server's `otel` extra to export spans (one per run,
model call and tool call, following the OpenTelemetry GenAI conventions) to any OTLP backend.
