---
name: runbooks
description: Incident runbooks for service-api and its dependencies, plus an error-budget calculator.
---

# Runbooks

## service-api 5xx spike

service-api is a thin gateway: most 5xx responses come from an upstream. Check in this order:

1. **When did it start?** Query service-api metrics for the last 30 minutes and find the first interval
   where the error rate rose above 2%.
2. **What changed?** List deploys for *all* services in the hour before the start. A deploy to an upstream
   (checkout-api, search, payments) is as likely as one to service-api itself.
3. **What failed?** Search ERROR logs. service-api logs `upstream <service> returned 500`; follow the
   `trace_id` to the upstream's own error.
4. **Mitigate:** roll back the deploy that introduced the failing code path. Owners: checkout-api →
   #team-checkout, search → #team-search, service-api → #team-edge.

## Error budget

service-api has a 99.5% availability SLO over 30 days (budget: 0.5% of requests). Estimate the budget
burned by an incident with:

    python3 /workspace/skills/runbooks/scripts/error_budget.py --error-rate 8.2 --minutes 28 --rps 1200
