import type { Dossier, Settings } from '@/lib/types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const COUNTRY_NAMES: Record<string, string> = {
  AT: 'Austria',
  CH: 'Switzerland',
  DE: 'Germany',
  ES: 'Spain',
  FR: 'France',
  GB: 'United Kingdom',
  IT: 'Italy',
  LI: 'Liechtenstein',
  LU: 'Luxembourg',
  SE: 'Sweden',
  US: 'United States',
};

export function countryName(code: string | null | undefined): string | null {
  if (!code) return null;
  return COUNTRY_NAMES[code.toUpperCase()] ?? code.toUpperCase();
}

/** "real_estate" -> "Real estate" */
export function humanize(value: string): string {
  const text = value.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function toBase(
  amount: number | null,
  currency: string | null,
  settings: Settings
): number | null {
  if (amount === null || !currency) return null;
  const rate = settings.fxToBase[currency.toUpperCase()];
  return rate === undefined ? null : amount * rate;
}

export function isHouseBank(bank: string | null, settings: Settings): boolean {
  return !!bank && bank.trim().toLowerCase() === settings.houseBank.toLowerCase();
}

/**
 * 4200000 -> "4’200’000" (Swiss grouping). Formatted by hand: Intl output differs between
 * Node and browsers, which breaks hydration.
 */
export function formatNumber(amount: number): string {
  const rounded = Math.round(amount);
  const digits = String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, '’');
  return rounded < 0 ? `−${digits}` : digits;
}

export function formatMoney(amount: number | null, currency: string | null): string {
  if (amount === null) return '—';
  return `${currency ?? '?'} ${formatNumber(amount)}`;
}

/** 4200000 -> "4.2m", 850000 -> "850k" */
export function formatCompact(amount: number): string {
  const sign = amount < 0 ? '−' : '';
  const value = Math.abs(amount);
  if (value >= 1_000_000) return `${sign}${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${sign}${Math.round(value / 1_000)}k`;
  return `${sign}${Math.round(value)}`;
}

export function ageOn(dateOfBirth: string, today: Date = new Date()): number {
  const born = new Date(dateOfBirth);
  const hadBirthday =
    today.getMonth() > born.getMonth() ||
    (today.getMonth() === born.getMonth() && today.getDate() >= born.getDate());
  return today.getFullYear() - born.getFullYear() - (hadBirthday ? 0 : 1);
}

/** "2026-08-21" -> "21 Aug 2026" */
export function formatDate(date: string | null): string {
  if (!date) return '—';
  const [year, month, day] = date.slice(0, 10).split('-');
  return `${day} ${MONTHS[Number(month) - 1]} ${year}`;
}

export interface Totals {
  assets: number;
  bankable: number;
  nonBankable: number;
  liabilities: number;
  netWorth: number;
  aumBank: number;
  aumExternal: number;
  pensions: number;
  recurringIncome: number;
  recurringExpenses: number;
  oneOffIncome: number;
  oneOffExpenses: number;
}

/** Totals in base currency. Items with no amount or currency count as zero. Mirrors src/summary.py. */
export function computeTotals(dossier: Dossier, settings: Settings): Totals {
  const value = (amount: number | null, currency: string | null) =>
    toBase(amount, currency, settings) ?? 0;

  let bankable = 0;
  let nonBankable = 0;
  let aumBank = 0;
  let aumExternal = 0;
  for (const asset of dossier.assets) {
    const v = value(asset.amount, asset.currency);
    if (asset.bankable) {
      bankable += v;
      if (isHouseBank(asset.bank, settings)) aumBank += v;
      else if (asset.bank) aumExternal += v;
    } else {
      nonBankable += v;
    }
  }

  const sum = (items: { amount: number | null; currency: string | null }[]) =>
    items.reduce((total, item) => total + value(item.amount, item.currency), 0);
  const flows = (direction: 'income' | 'expense', oneOff: boolean) =>
    sum(
      dossier.cashFlows.filter(
        (f) => f.direction === direction && (f.frequency === 'one_off') === oneOff
      )
    );

  const assets = bankable + nonBankable;
  const liabilities = sum(dossier.liabilities);
  return {
    assets,
    bankable,
    nonBankable,
    liabilities,
    netWorth: assets - liabilities,
    aumBank,
    aumExternal,
    pensions: sum(dossier.pensions),
    recurringIncome: flows('income', false),
    recurringExpenses: flows('expense', false),
    oneOffIncome: flows('income', true),
    oneOffExpenses: flows('expense', true),
  };
}
