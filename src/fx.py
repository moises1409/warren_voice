"""Settings shared with the frontend: house bank, base currency and FX rates."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


@dataclass(frozen=True)
class Settings:
    house_bank: str
    base_currency: str
    fx_to_base: dict[str, float]

    @classmethod
    def load(cls, data_dir: Path = DATA_DIR) -> Settings:
        raw = json.loads((data_dir / "settings.json").read_text(encoding="utf-8"))
        return cls(
            house_bank=raw["houseBank"],
            base_currency=raw["baseCurrency"],
            fx_to_base={k.upper(): float(v) for k, v in raw["fxToBase"].items()},
        )

    def to_base(self, amount: float | None, currency: str | None) -> float | None:
        """Convert to the base currency. None when the value cannot be determined."""
        if amount is None or not currency:
            return None
        rate = self.fx_to_base.get(currency.upper())
        return None if rate is None else amount * rate

    def is_house_bank(self, bank: str | None) -> bool:
        return bool(bank) and bank.strip().casefold() == self.house_bank.casefold()

    def format(self, amount: float) -> str:
        """Compact amount in base currency, e.g. 'CHF 4.2m' or 'CHF 850k'."""
        sign = "-" if amount < 0 else ""
        value = abs(amount)
        if value >= 1_000_000:
            text = f"{value / 1_000_000:.1f}m"
        elif value >= 1_000:
            text = f"{value / 1_000:.0f}k"
        else:
            text = f"{value:.0f}"
        return f"{sign}{self.base_currency} {text}"
