"""Estimate the share of a 30-day error budget burned by an incident."""

import argparse

SLO = 0.995
MONTH_MINUTES = 30 * 24 * 60

parser = argparse.ArgumentParser()
parser.add_argument("--error-rate", type=float, required=True, help="average error rate during the incident, in percent")
parser.add_argument("--minutes", type=float, required=True, help="incident duration")
parser.add_argument("--rps", type=float, required=True, help="average requests per second")
args = parser.parse_args()

failed = args.rps * 60 * args.minutes * args.error_rate / 100
budget = args.rps * 60 * MONTH_MINUTES * (1 - SLO)
print(f"failed requests: {failed:,.0f}")
print(f"30-day budget:   {budget:,.0f}")
print(f"budget burned:   {failed / budget:.1%}")
