# Kubernetes manifests

[`runhive-e2b-embed.yaml`](runhive-e2b-embed.yaml) is the Helm chart ([`deploy/helm/runhive`](../helm/runhive)) rendered with [`examples/e2b-embed-values.yaml`](../helm/runhive/examples/e2b-embed-values.yaml). Use it to install with plain `kubectl`, with sandboxes on a self-hosted E2B runtime (E2B Embed). Prefer the chart itself when you can (`helm install runhive deploy/helm/runhive -f <your values>`). It also handles bundled Postgres, KEDA autoscaling and upgrades.

| Resource | What it runs |
| --- | --- |
| `Deployment/runhive-gateway` + `Service` + HPA | REST API, SSE streams, router, `/metrics` (`runhive-server serve`) |
| `Deployment/runhive-worker` | runtime workers; they create sandboxes on Embed (`runhive-server worker`) |
| `Deployment/runhive-scheduler` | cron triggers, retries, idle reaper |
| `Deployment/runhive-dashboard` + `Service` | the web console, proxying to the gateway in-cluster |
| `Job/runhive-migrate` | database migrations (a Helm hook in the chart; a plain Job here) |
| `Ingress/runhive` | `runhive.example.com` → gateway, `console.runhive.example.com` → dashboard (ingress-nginx, streaming-friendly timeouts) |
| `ConfigMap/runhive`, `ServiceAccount/runhive` | non-secret settings (including `E2B_API_URL` / `E2B_SANDBOX_URL`) and the pod identity |

## Install

1. **E2B Embed on a KVM host.** Run `make e2b-embed-up`, or [`deploy/e2b-embed/up.sh`](../e2b-embed/README.md) for Embed plus the `runhive-base` template. The pods must reach that host on ports 3000 and 3002, so allow only the cluster's CIDR there.
2. **Edit the values.** Copy [`examples/e2b-embed-values.yaml`](../helm/runhive/examples/e2b-embed-values.yaml) and set:
   - the Embed host address;
   - the hostnames;
   - the S3 endpoint and bucket;
   - the image tags.

   Then regenerate with `make k8s-manifests`, or `helm template runhive deploy/helm/runhive -n runhive -f <your values>`.
3. **Namespace and Secret.** Every credential lives in one Secret named `runhive`:

   ```bash
   kubectl create namespace runhive
   kubectl -n runhive create secret generic runhive \
     --from-literal=DATABASE_URL='postgresql://runhive:...@postgres.db:5432/runhive' \
     --from-literal=RUNHIVE_MASTER_KEY="$(head -c 32 /dev/urandom | base64)" \
     --from-literal=E2B_API_KEY='e2b_...' \
     --from-literal=ANTHROPIC_API_KEY='sk-ant-...' \
     --from-literal=AWS_ACCESS_KEY_ID='...' --from-literal=AWS_SECRET_ACCESS_KEY='...' \
     --from-literal=RUNHIVE_BOOTSTRAP_KEY="ak_$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
   ```

   Read `E2B_API_KEY` on the Embed host: `docker compose -p e2b --project-directory deploy/e2b-embed/embed -f deploy/e2b-embed/embed/compose.yaml exec -T ready cat /run/e2b/sdk.env`.
4. **Apply.**

   ```bash
   kubectl apply -n runhive -f deploy/kubernetes/runhive-e2b-embed.yaml
   kubectl -n runhive wait --for=condition=complete job/runhive-migrate --timeout=5m
   kubectl -n runhive rollout status deploy/runhive-gateway deploy/runhive-worker deploy/runhive-dashboard
   kubectl -n runhive exec deploy/runhive-worker -- runhive e2b check    # sandboxes on Embed, end to end
   ```

**Upgrades:** Jobs are immutable, so delete the finished migration Job before re-applying: `kubectl -n runhive delete job runhive-migrate --ignore-not-found && kubectl apply -n runhive -f ...`.

## Images

| Image | Source |
| --- | --- |
| `ghcr.io/khushwant04/runhive-server:<version>` | [`Dockerfile`](../../Dockerfile): gateway, worker, scheduler, migrations and the `runhive` CLI |
| `ghcr.io/khushwant04/runhive-dashboard:<version>` | [`dashboard/Dockerfile`](../../dashboard/Dockerfile) |

The release workflow publishes both for `linux/amd64` and `linux/arm64` on a `v*` tag. Until a release exists, build and push them to your own registry, then set `image.repository` and `dashboard.image.repository`:

```bash
docker build -t <registry>/runhive-server:0.1.0 . && docker push <registry>/runhive-server:0.1.0
docker build -t <registry>/runhive-dashboard:0.1.0 dashboard && docker push <registry>/runhive-dashboard:0.1.0
```
