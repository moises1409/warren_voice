import {
  BankIcon,
  BriefcaseIcon,
  ChartLineUpIcon,
  ChartPieSliceIcon,
  CoinsIcon,
  CurrencyBtcIcon,
  FactoryIcon,
  GraduationCapIcon,
  HandCoinsIcon,
  HouseIcon,
  type Icon,
  MedalIcon,
  MoneyIcon,
  PaletteIcon,
  PiggyBankIcon,
  ScrollIcon,
  ShoppingCartIcon,
  StackIcon,
  TrendDownIcon,
  UsersIcon,
} from '@phosphor-icons/react';

/** One icon per type of asset, debt and cash flow; anything else is coins. */
const ICONS: Record<string, Icon> = {
  // assets
  cash: MoneyIcon,
  equities: ChartLineUpIcon,
  funds: ChartPieSliceIcon,
  bonds: ScrollIcon,
  structured_products: StackIcon,
  real_estate: HouseIcon,
  business_stake: FactoryIcon,
  art_collectibles: PaletteIcon,
  crypto: CurrencyBtcIcon,
  // debts
  mortgage: HandCoinsIcon,
  lombard_loan: HandCoinsIcon,
  personal_loan: HandCoinsIcon,
  // income
  salary: BriefcaseIcon,
  bonus: MedalIcon,
  dividend: FactoryIcon,
  business_income: FactoryIcon,
  rental: HouseIcon,
  pension: BankIcon,
  foreign_pension: BankIcon,
  // expenses
  living_costs: ShoppingCartIcon,
  taxes: BankIcon,
  education: GraduationCapIcon,
  alimony: UsersIcon,
  // what the year leaves over, or lacks
  surplus: PiggyBankIcon,
  shortfall: TrendDownIcon,
};

interface WealthIconProps {
  type: string;
  className?: string;
  style?: React.CSSProperties;
}

export function WealthIcon({ type, className, style }: WealthIconProps) {
  const Glyph = ICONS[type] ?? CoinsIcon;
  return <Glyph aria-hidden weight="duotone" className={className} style={style} />;
}
