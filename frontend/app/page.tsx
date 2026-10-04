import Link from 'next/link';
import { Badge } from '@/components/prep/badge';
import { Button } from '@/components/ui/button';
import { loadDossiers, loadSettings } from '@/lib/data';
import type { RiskScore } from '@/lib/types';
import { ageOn, computeTotals, countryName, formatDate, formatNumber } from '@/lib/wealth';

// The mock data can change between requests; never serve a cached list.
export const dynamic = 'force-dynamic';

const RISK_TONE: Record<RiskScore, 'danger' | 'warning' | 'success'> = {
  High: 'danger',
  Medium: 'warning',
  Low: 'success',
};

export default async function Page() {
  const [dossiers, settings] = await Promise.all([loadDossiers(), loadSettings()]);
  const currency = settings.baseCurrency;

  return (
    <main className="h-full overflow-auto">
      <div className="mx-auto max-w-[1400px] px-5 py-8">
        <h1 className="text-xl font-semibold tracking-tight">Clients</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {dossiers.length} clients · amounts in {currency}
        </p>

        <div className="mt-6 overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 text-muted-foreground border-b text-left text-xs">
                <th className="px-4 py-2.5 font-medium">Client</th>
                <th className="px-4 py-2.5 text-right font-medium">Age</th>
                <th className="px-4 py-2.5 font-medium">Domicile</th>
                <th className="px-4 py-2.5 font-medium">Segment</th>
                <th className="px-4 py-2.5 text-right font-medium">AuM at bank</th>
                <th className="px-4 py-2.5 text-right font-medium">AuM outside bank</th>
                <th className="px-4 py-2.5 text-right font-medium">Performance YTD</th>
                <th className="px-4 py-2.5 font-medium">Last contact</th>
                <th className="px-4 py-2.5 font-medium">Risk scoring</th>
                <th className="px-4 py-2.5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {dossiers.map((dossier) => {
                const { client } = dossier;
                const totals = computeTotals(dossier, settings);
                const performance = client.performanceYtdPct;
                return (
                  <tr key={client.id} className="hover:bg-muted/40">
                    <td className="px-4 py-3 font-medium whitespace-nowrap">{client.name}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {ageOn(client.dateOfBirth)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {client.domicile.city}
                      <span className="text-muted-foreground">
                        , {countryName(client.domicile.country)}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">{client.segment}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatNumber(totals.aumBank)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {totals.aumExternal > 0 ? (
                        formatNumber(totals.aumExternal)
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td
                      className={
                        'px-4 py-3 text-right tabular-nums ' +
                        (performance < 0 ? 'text-danger' : 'text-success')
                      }
                    >
                      {performance > 0 ? '+' : performance < 0 ? '−' : ''}
                      {Math.abs(performance).toFixed(1)}%
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap tabular-nums">
                      {formatDate(client.lastContact)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={RISK_TONE[client.riskScore]}>{client.riskScore}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button asChild size="sm">
                        <Link href={`/prepare/${client.id}`}>Prepare meeting</Link>
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
