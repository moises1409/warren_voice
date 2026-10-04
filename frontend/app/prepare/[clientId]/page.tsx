import { notFound } from 'next/navigation';
import { App } from '@/components/app/app';
import { loadDossier, loadSession, loadSettings } from '@/lib/data';

export const dynamic = 'force-dynamic';

// Token source, in order of precedence: the LiveKit Cloud development token server
// (LIVEKIT_TOKEN_SERVER_ID) or the included token endpoint (LIVEKIT_URL, LIVEKIT_API_KEY,
// LIVEKIT_API_SECRET).
const tokenServerId = process.env.LIVEKIT_TOKEN_SERVER_ID;

interface PageProps {
  params: Promise<{ clientId: string }>;
}

export default async function Page({ params }: PageProps) {
  const { clientId } = await params;
  const [dossier, settings, saved] = await Promise.all([
    loadDossier(clientId),
    loadSettings(),
    loadSession(clientId),
  ]);
  if (!dossier) notFound();

  return (
    <App
      // A different client is a different session.
      key={dossier.client.id}
      tokenServerId={tokenServerId}
      tokenEndpoint="/api/token"
      agentName={process.env.AGENT_NAME}
      isVideoInputSupported
      dossier={dossier}
      saved={saved}
      settings={settings}
    />
  );
}
