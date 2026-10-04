'use client';

import { useMemo, useRef, useState } from 'react';
import { TokenSource } from 'livekit-client';
import { useSession } from '@livekit/components-react';
import { WarningIcon } from '@phosphor-icons/react/dist/ssr';
import { AgentSessionProvider } from '@/components/agents-ui/agent-session-provider';
import { StartAudioButton } from '@/components/agents-ui/start-audio-button';
import { PrepSessionView } from '@/components/prep/prep-session-view';
import { Toaster } from '@/components/ui/sonner';
import { useAgentErrors } from '@/hooks/useAgentErrors';
import { useDebugMode } from '@/hooks/useDebug';
import { blankState } from '@/hooks/usePrepState';
import type { Dossier, Language, Mode, PrepState, Settings } from '@/lib/types';

const IN_DEVELOPMENT = process.env.NODE_ENV !== 'production';

function AppSetup() {
  useDebugMode({ enabled: IN_DEVELOPMENT });
  useAgentErrors();

  return null;
}

/** How the banker asked to start: who leads, and whether to discard the saved session. */
interface Launch {
  mode: Mode;
  reset: boolean;
  language: Language;
  /** Changes with every start, so each conversation gets a session of its own. */
  nonce: number;
}

interface AppProps {
  tokenServerId?: string;
  tokenEndpoint: string;
  agentName?: string;
  isVideoInputSupported: boolean;
  dossier: Dossier;
  /** The session as the agent last saved it, if any. */
  saved: PrepState | null;
  settings: Settings;
}

export function App({ dossier, saved, ...props }: AppProps) {
  const [launch, setLaunch] = useState<Launch | null>(null);
  // The latest state seen, so that starting another conversation does not flash back to
  // what the page loaded with.
  const latest = useRef<PrepState>(saved ?? blankState(dossier));

  return (
    <SessionHost
      key={launch?.nonce ?? 0}
      {...props}
      clientId={dossier.client.id}
      launch={launch}
      initial={latest.current}
      onState={(state) => {
        latest.current = state;
      }}
      onLaunch={(mode, reset, language) => {
        if (reset) latest.current = blankState(dossier);
        setLaunch({ mode, reset, language, nonce: (launch?.nonce ?? 0) + 1 });
      }}
    />
  );
}

interface SessionHostProps extends Omit<AppProps, 'dossier' | 'saved'> {
  clientId: string;
  launch: Launch | null;
  initial: PrepState;
  onState: (state: PrepState) => void;
  onLaunch: (mode: Mode, reset: boolean, language: Language) => void;
}

/** One conversation: its session is created with what the banker asked for at the start. */
function SessionHost({
  tokenServerId,
  tokenEndpoint,
  agentName,
  isVideoInputSupported,
  clientId,
  launch,
  initial,
  onState,
  onLaunch,
  settings,
}: SessionHostProps) {
  const tokenSource = useMemo(
    () =>
      tokenServerId
        ? TokenSource.developmentTokenServer(tokenServerId)
        : TokenSource.endpoint(tokenEndpoint),
    [tokenServerId, tokenEndpoint]
  );

  // The agent learns which client to prepare, and how, from the dispatch metadata.
  const sessionOptions = useMemo(
    () =>
      agentName
        ? {
            agentName,
            agentMetadata: JSON.stringify({
              clientId,
              ...(launch
                ? { mode: launch.mode, reset: launch.reset, language: launch.language }
                : {}),
            }),
          }
        : undefined,
    [agentName, clientId, launch]
  );
  const session = useSession(tokenSource, sessionOptions);

  return (
    <AgentSessionProvider session={session}>
      <AppSetup />
      <PrepSessionView
        initial={initial}
        settings={settings}
        supportsVideoInput={isVideoInputSupported}
        autoStart={launch !== null}
        onLaunch={onLaunch}
        onState={onState}
      />
      <StartAudioButton
        label="Start audio"
        className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2"
      />
      <Toaster
        icons={{
          warning: <WarningIcon weight="bold" />,
        }}
        position="top-center"
        className="toaster group"
        style={
          {
            '--normal-bg': 'var(--popover)',
            '--normal-text': 'var(--popover-foreground)',
            '--normal-border': 'var(--border)',
          } as React.CSSProperties
        }
      />
    </AgentSessionProvider>
  );
}
