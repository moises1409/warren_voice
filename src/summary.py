"""Totals computed from a dossier, in base currency."""

from __future__ import annotations

from dataclasses import dataclass

from fx import Settings
from models import Dossier


@dataclass(frozen=True)
class Totals:
    assets: float
    bankable: float
    non_bankable: float
    liabilities: float
    net_worth: float
    # Bankable assets booked at the house bank / at other banks.
    aum_bank: float
    aum_external: float
    pensions: float
    recurring_income: float
    recurring_expenses: float
    one_off_income: float
    one_off_expenses: float
    # Items left out of the totals because amount or currency is unknown.
    unvalued: int


def compute_totals(dossier: Dossier, settings: Settings) -> Totals:
    unvalued = 0

    def value(amount: float | None, currency: str | None) -> float:
        nonlocal unvalued
        converted = settings.to_base(amount, currency)
        if converted is None:
            unvalued += 1
            return 0.0
        return converted

    bankable = non_bankable = aum_bank = aum_external = 0.0
    for asset in dossier.assets:
        v = value(asset.amount, asset.currency)
        if asset.bankable:
            bankable += v
            if settings.is_house_bank(asset.bank):
                aum_bank += v
            elif asset.bank:
                aum_external += v
        else:
            non_bankable += v

    liabilities = sum(value(x.amount, x.currency) for x in dossier.liabilities)
    pensions = sum(value(x.amount, x.currency) for x in dossier.pensions)

    flows = {
        ("income", True): 0.0,
        ("income", False): 0.0,
        ("expense", True): 0.0,
        ("expense", False): 0.0,
    }
    for flow in dossier.cash_flows:
        flows[(flow.direction, flow.frequency != "one_off")] += value(
            flow.amount, flow.currency
        )

    assets = bankable + non_bankable
    return Totals(
        assets=assets,
        bankable=bankable,
        non_bankable=non_bankable,
        liabilities=liabilities,
        net_worth=assets - liabilities,
        aum_bank=aum_bank,
        aum_external=aum_external,
        pensions=pensions,
        recurring_income=flows[("income", True)],
        recurring_expenses=flows[("expense", True)],
        one_off_income=flows[("income", False)],
        one_off_expenses=flows[("expense", False)],
        unvalued=unvalued,
    )
