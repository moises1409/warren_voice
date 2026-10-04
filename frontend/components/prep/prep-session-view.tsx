'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Track } from 'livekit-client';
import {
  VideoTrack,
  useAgent,
  useSessionContext,
  useSessionMessages,
  useTracks,
  useVoiceAssistant,
} from '@livekit/components-react';
import { ArrowLeftIcon, EarIcon, MicrophoneIcon, SparkleIcon } from '@phosphor-icons/react';
import { AgentAudioVisualizerBar } from '@/components/agents-ui/agent-audio-visualizer-bar';
import { AgentChatTranscript } from '@/components/agents-ui/agent-chat-transcript';
import { AgentControlBar } from '@/components/agents-ui/agent-control-bar';
import { useLocalTrackRef } from '@/components/agents-ui/blocks/agent-session-view-01/components/tile-view';
import { ActivityNotes } from '@/components/prep/activity-notes';
import { FamilyView } from '@/components/prep/family-view';
import { MeetingPoints } from '@/components/prep/meeting-points';
import { ReportView } from '@/components/prep/report-view';
import { NowCard, ReviewAgenda, SectionBanner, progress } from '@/components/prep/review';
import { WealthView } from '@/components/prep/wealth-view';
import { Button } from '@/components/ui/button';
import { usePrepState } from '@/hooks/usePrepState';
import { useSpokenFocus } from '@/hooks/useSpokenFocus';
import { cn } from '@/lib/shadcn/utils';
import type { Language, Mode, PrepState, Scenario, Settings, Stage } from '@/lib/types';
import { ageOn, countryName } from '@/lib/wealth';

const STAGES: { id: Stage; label: string }[] = [
  { id: 'wealth', label: 'Wealth' },
  { id: 'family', label: 'Family' },
  { id: 'report', label: 'Report' },
];

const AGENT_STATUS: Record<string, string> = {
  disconnected: 'Not connected',
  connecting: 'Connecting…',
  'pre-connect-buffering': 'Connecting…',
  initializing: 'Starting…',
  idle: 'Ready',
  listening: 'Listening',
  thinking: 'Thinking…',
  speaking: 'Speaking',
  failed: 'Unavailable',
};

type Panel = 'review' | 'points' | 'transcript';

/** What Warren can speak. The screen itself stays in English. */
const LANGUAGES: { id: Language; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'fr', label: 'Français' },
  { id: 'es', label: 'Español' },
];
const LANGUAGE_KEY = 'warren.language';

/** The banker's own camera or shared screen, so they can see what the agent sees. */
function LocalVideo() {
  const [screenShare] = useTracks([Track.Source.ScreenShare]);
  const camera = useLocalTrackRef(Track.Source.Camera);
  const track =
    screenShare && !screenShare.publication.isMuted
      ? screenShare
      : camera && !camera.publication.isMuted
        ? camera
        : undefined;
  if (!track) return null;
  return (
    <VideoTrack
      trackRef={track}
      className="bg-muted aspect-video w-full rounded-md border object-cover"
    />
  );
}

interface PrepSessionViewProps {
  /** The session as last saved, or as the previous conversation on this page left it. */
  initial: PrepState;
  settings: Settings;
  supportsVideoInput: boolean;
  /** The banker pressed a start button: connect as soon as this view mounts. */
  autoStart: boolean;
  /** Start a conversation with Warren leading or listening, optionally from scratch. */
  onLaunch: (mode: Mode, reset: boolean, language: Language) => void;
  onState: (state: PrepState) => void;
}

export function PrepSessionView({
  initial,
  settings,
  supportsVideoInput,
  autoStart,
  onLaunch,
  onState,
}: PrepSessionViewProps) {
  const session = useSessionContext();
  const { isConnected, start, end } = session;
  // From the press of a start button until Warren is there. Once a conversation has taken
  // place and ended, the start card is offered again.
  const [wasConnected, setWasConnected] = useState(false);
  useEffect(() => {
    if (isConnected) setWasConnected(true);
  }, [isConnected]);
  const connecting =
    !isConnected && (session.connectionState !== 'disconnected' || (autoStart && !wasConnected));
  const { messages } = useSessionMessages(session);
  const { state: agentState } = useAgent();
  const { audioTrack } = useVoiceAssistant();
  const { state, live, changed, added, setStage, setScenario, finishStep, goToStep, setMode } =
    usePrepState(session.room, initial);
  useEffect(() => onState(state), [state, onState]);

  // Warren leads only in a guided conversation; otherwise the banker reads on their own.
  const guided = isConnected && state.mode === 'guided';
  const step = state.agenda.find((s) => s.id === state.currentStepId) ?? null;

  // The item under the pointer, shared by the workspace and the meeting points so that an item
  // and the points about it light up together.
  const [hoverId, setHoverId] = useState<string | null>(null);

  // The stage on screen follows the agent, but the banker can also browse on their own.
  const [stage, setViewStage] = useState<Stage>(initial.stage);
  useEffect(() => setViewStage(state.stage), [state.stage]);
  const selectStage = useCallback(
    (next: Stage) => {
      // In a guided review the screen is Warren's: it moves when the review does, so that
      // what is shown and what is said stay together.
      if (!guided) setViewStage(next);
      void setStage(next);
    },
    [guided, setStage]
  );

  // The simulation on screen follows the agent too, and the banker can switch it by hand.
  const [scenario, setViewScenario] = useState<Scenario | null>(initial.scenario);
  useEffect(() => setViewScenario(state.scenario), [state.scenario]);
  const selectScenario = useCallback(
    (next: Scenario | null) => {
      setViewScenario(next);
      void setScenario(next);
    },
    [setScenario]
  );
  const simulation = scenario === 'death' ? state.succession : null;

  // In a guided review the panel shows the steps; otherwise the plain list of points.
  const [panel, setPanel] = useState<Panel>('points');
  useEffect(() => {
    setPanel((current) => (guided ? 'review' : current === 'review' ? 'points' : current));
  }, [guided]);
  const [ended, setEnded] = useState(false);

  // The language Warren speaks: the banker's last choice, else the one of the saved session.
  const [language, setLanguage] = useState<Language>(initial.language ?? 'en');
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(LANGUAGE_KEY);
      if (LANGUAGES.some((l) => l.id === stored)) setLanguage(stored as Language);
    } catch {
      // Storage is unavailable: the saved session's language stands.
    }
  }, []);
  const chooseLanguage = (next: Language) => {
    setLanguage(next);
    try {
      window.localStorage.setItem(LANGUAGE_KEY, next);
    } catch {
      // Kept for this page only.
    }
  };

  // The banker decides when to start talking to Warren; leaving the page ends the conversation.
  // The timeout tells a real unmount from the unmount-and-remount React performs in development.
  const mounted = useRef(false);
  const started = useRef(false);
  useEffect(() => {
    mounted.current = true;
    if (autoStart && !started.current) {
      started.current = true;
      void start();
    }
    return () => {
      mounted.current = false;
      setTimeout(() => {
        if (!mounted.current) void end();
      }, 0);
    };
  }, [autoStart, start, end]);

  // What Warren is talking about right now, lit up on screen.
  const spoken = useSpokenFocus(messages, state, settings.houseBank);
  // In a guided review, what the current step is about stays lit for as long as the step lasts.
  const targets = guided ? (step?.targetIds ?? []) : [];
  const targetKey = targets.join(',');
  const focus = useMemo(
    () => (targetKey ? new Set([...spoken, ...targetKey.split(',')]) : spoken),
    [spoken, targetKey]
  );

  // The screen goes to what the step is about: its first item, or the top when it has none.
  // Waits a moment, for the view to have changed and the sections to have folded.
  const workspace = useRef<HTMLDivElement>(null);
  const stepId = guided ? state.currentStepId : null;
  useEffect(() => {
    if (!stepId) return;
    const timer = setTimeout(() => {
      const first = targetKey.split(',')[0];
      const target = first
        ? workspace.current?.querySelector(`[data-item-id="${CSS.escape(first)}"]`)
        : null;
      if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      else workspace.current?.scrollTo({ top: 0, behavior: 'smooth' });
    }, 350);
    return () => clearTimeout(timer);
  }, [stepId, targetKey, stage]);

  const { client } = state;
  const firstName = client.name.split(' ')[0];
  const openCount = state.meetingPoints.filter((p) => p.status === 'open').length;
  const { number, total } = progress(state);
  // A review someone started and did not finish can be picked up where it was left.
  const underway = state.agenda.some((s) => s.status === 'done');
  const inProgress = underway && state.currentStepId !== null;
  const complete = underway && state.currentStepId === null;

  // Nothing is listed before the banker has talked to Warren: the points come up in the
  // conversation, and stay once it has taken place or the review is complete.
  const listed = isConnected || wasConnected || complete;

  const tabs: [Panel, string][] = [
    ...(guided ? [['review', `Review · ${number} of ${total}`] as [Panel, string]] : []),
    ['points', `Meeting points${live ? ` · ${openCount}` : ''}`],
    ['transcript', 'Transcript'],
  ];

  return (
    <div className="flex h-full flex-col lg:flex-row">
      {/* Workspace */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="no-print shrink-0 border-b px-5 py-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button asChild variant="ghost" size="sm" className="-ml-2">
              <Link href="/">
                <ArrowLeftIcon />
                Clients
              </Link>
            </Button>
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold tracking-tight">{client.name}</h1>
              <p className="text-muted-foreground truncate text-xs">
                {ageOn(client.dateOfBirth)} · {client.domicile.city},{' '}
                {countryName(client.domicile.country)} · {client.segment} · {client.riskScore} risk
              </p>
            </div>
            <nav aria-label="Stages" className="ml-auto flex items-center">
              {STAGES.map(({ id, label }, index) => (
                <div key={id} className="flex items-center">
                  {index > 0 && <div aria-hidden className="bg-border mx-1 h-px w-6" />}
                  <button
                    type="button"
                    onClick={() => selectStage(id)}
                    key={stage === id ? `${id}-here` : id}
                    aria-current={stage === id ? 'step' : undefined}
                    className={cn(
                      stage === id && 'stage-arrive',
                      'flex cursor-pointer items-center gap-2 rounded-full py-1 pr-3 pl-1 text-sm transition-colors',
                      stage === id
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-muted'
                    )}
                  >
                    <span
                      className={cn(
                        'flex size-5 items-center justify-center rounded-full text-xs tabular-nums',
                        stage === id ? 'bg-primary-foreground/20' : 'bg-muted'
                      )}
                    >
                      {index + 1}
                    </span>
                    {label}
                    {state.stage === id && stage !== id && (
                      <span className="sr-only">(Warren is here)</span>
                    )}
                  </button>
                </div>
              ))}
            </nav>
          </div>
        </div>

        {guided && <SectionBanner state={state} />}
        {/* No sideways scroll: a view sliding in must not show a scrollbar. */}
        <div
          ref={workspace}
          className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-5"
        >
          <div className="mx-auto max-w-5xl">
            {guided && (
              <NowCard
                state={state}
                onFinish={(outcome) => void finishStep(outcome)}
                onBack={() => void goToStep({ previous: true })}
              />
            )}
            {stage !== 'report' && (
              <div className="no-print mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
                <div
                  role="tablist"
                  aria-label="Scenario"
                  className="bg-muted flex rounded-lg p-0.5"
                >
                  {(
                    [
                      [null, 'Today'],
                      ['death', 'If the client died today'],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={label}
                      role="tab"
                      type="button"
                      aria-selected={scenario === id}
                      disabled={!state.succession}
                      onClick={() => selectScenario(id)}
                      className={cn(
                        'cursor-pointer rounded-md px-3 py-1 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                        scenario === id
                          ? id === 'death'
                            ? 'bg-danger font-medium text-white shadow-xs'
                            : 'bg-background font-medium shadow-xs'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <span className="text-muted-foreground text-xs">
                  {!state.succession
                    ? 'The simulation is available once Warren has prepared this client.'
                    : simulation
                      ? 'Simulation: taxes on death and who would receive what.'
                      : 'See the cost of inaction and how the estate would be split.'}
                </span>
              </div>
            )}
            {/* Keyed by stage: a new view slides in, so a change of screen is seen. */}
            <div key={stage} className="view-enter">
              {stage === 'wealth' && (
                <WealthView
                  state={state}
                  settings={settings}
                  changed={changed}
                  focus={focus}
                  hoverId={hoverId}
                  onHover={setHoverId}
                  simulation={simulation}
                  // The rest of the view folds around what the current step is about.
                  focusSection={guided && step?.stage === 'wealth' ? step.focus : null}
                />
              )}
              {stage === 'family' && (
                <FamilyView
                  state={state}
                  changed={changed}
                  added={added}
                  focus={focus}
                  hoverId={hoverId}
                  onHover={setHoverId}
                  simulation={simulation}
                  settings={settings}
                />
              )}
              {stage === 'report' && <ReportView state={state} settings={settings} />}
              {stage !== 'report' && (
                <ActivityNotes state={state} hoverId={hoverId} focus={focus} onHover={setHoverId} />
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Agent */}
      <aside className="no-print bg-background flex h-[45svh] shrink-0 flex-col border-t lg:h-auto lg:w-[380px] lg:border-t-0 lg:border-l">
        <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
          <AgentAudioVisualizerBar
            size="icon"
            barCount={3}
            state={agentState}
            audioTrack={audioTrack}
            className="text-primary w-8"
          />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">
              Warren <span className="text-muted-foreground font-normal">· AI assistant</span>
            </div>
            <div className="text-muted-foreground text-xs" aria-live="polite">
              {isConnected || connecting
                ? (AGENT_STATUS[agentState] ?? agentState)
                : ended
                  ? 'Conversation ended'
                  : 'Not started'}
            </div>
          </div>
          {isConnected && (
            <div
              role="tablist"
              aria-label="Who leads"
              className="bg-muted flex shrink-0 rounded-lg p-0.5"
            >
              {(
                [
                  ['guided', 'Guide me'],
                  ['listening', "I'll look"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  role="tab"
                  type="button"
                  aria-selected={state.mode === id}
                  onClick={() => void setMode(id)}
                  className={cn(
                    'cursor-pointer rounded-md px-2.5 py-1 text-xs transition-colors',
                    state.mode === id
                      ? 'bg-background font-medium shadow-xs'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="shrink-0 px-4 pt-3 empty:hidden">
          <LocalVideo />
        </div>

        <div
          role="tablist"
          className={cn('flex shrink-0 gap-4 border-b px-4 pt-2 text-sm', !listed && 'hidden')}
        >
          {tabs.map(([id, label]) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={panel === id}
              onClick={() => setPanel(id)}
              className={cn(
                '-mb-px cursor-pointer border-b-2 pb-2 whitespace-nowrap',
                panel === id
                  ? 'border-primary font-medium'
                  : 'text-muted-foreground border-transparent'
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="relative min-h-0 flex-1 overflow-auto">
          {!listed ? (
            <div className="text-muted-foreground flex h-full items-center justify-center p-8 text-center text-sm">
              The points to raise with {firstName} come up as you go through the review with Warren.
            </div>
          ) : panel === 'review' && guided ? (
            <ReviewAgenda state={state} onSelect={(stepId) => void goToStep({ stepId })} />
          ) : panel === 'transcript' ? (
            <AgentChatTranscript
              agentState={agentState}
              messages={messages}
              className="h-full **:data-[slot=message-scroller-content]:p-4"
            />
          ) : (
            <MeetingPoints
              experts={state.succession?.experts ?? {}}
              points={state.meetingPoints}
              changed={changed}
              rev={state.rev}
              live={live}
              hoverId={hoverId}
              focus={focus}
              onHover={setHoverId}
              onSelect={(point) => {
                // In a guided review a point is a step: go there, Warren included. Otherwise
                // only the banker's view moves.
                const target = state.agenda.find((s) => s.pointIds.includes(point.id));
                if (guided && target) void goToStep({ stepId: target.id });
                else if (point.section !== 'general') setViewStage(point.section);
              }}
            />
          )}
        </div>

        <div className="shrink-0 p-3">
          {isConnected ? (
            <AgentControlBar
              variant="livekit"
              controls={{
                leave: true,
                microphone: true,
                chat: true,
                camera: supportsVideoInput,
                screenShare: supportsVideoInput,
              }}
              isChatOpen={panel === 'transcript'}
              isConnected={isConnected}
              onDisconnect={() => {
                setEnded(true);
                void end();
              }}
              onIsChatOpenChange={(open) =>
                setPanel(open ? 'transcript' : guided ? 'review' : 'points')
              }
            />
          ) : (
            <div className="bg-muted/50 rounded-xl border p-4">
              <div className="flex items-start gap-3">
                <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-full">
                  <SparkleIcon weight="fill" className="size-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {inProgress
                      ? `Review in progress · point ${number} of ${total}`
                      : complete
                        ? 'Review complete'
                        : `Prepare ${firstName}'s meeting with Warren`}
                  </p>
                  <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                    {inProgress
                      ? 'Warren picks up where you left off. What was recorded is on screen.'
                      : complete
                        ? 'Everything was gone through. Warren can still change things or answer questions.'
                        : 'Warren is an AI voice assistant. It can walk you through the points one at a time, or stay quiet while you read and act when you ask.'}
                  </p>
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="text-muted-foreground text-xs">Warren speaks</span>
                <div
                  role="radiogroup"
                  aria-label="Language of the conversation"
                  className="bg-muted flex rounded-lg p-0.5"
                >
                  {LANGUAGES.map(({ id, label }) => (
                    <button
                      key={id}
                      role="radio"
                      type="button"
                      aria-checked={language === id}
                      disabled={connecting}
                      onClick={() => chooseLanguage(id)}
                      className={cn(
                        'cursor-pointer rounded-md px-2.5 py-1 text-xs transition-colors',
                        language === id
                          ? 'bg-background font-medium shadow-xs'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {!complete && (
                <Button
                  className="mt-3 w-full"
                  size="lg"
                  disabled={connecting}
                  onClick={() => onLaunch('guided', false, language)}
                >
                  <MicrophoneIcon weight="fill" />
                  {connecting
                    ? 'Connecting to Warren…'
                    : inProgress
                      ? `Resume — point ${number} of ${total}`
                      : 'Walk me through it'}
                </Button>
              )}
              <Button
                className="mt-2 w-full"
                variant={complete ? 'default' : 'outline'}
                disabled={connecting}
                onClick={() => onLaunch('listening', false, language)}
              >
                <EarIcon />
                {complete && connecting
                  ? 'Connecting to Warren…'
                  : "I'll look myself — just listen"}
              </Button>
              <div className="text-muted-foreground mt-2 flex items-center justify-between gap-3 text-[11px]">
                <span>Live voice conversation with an AI · uses your microphone</span>
                {underway && (
                  <button
                    type="button"
                    disabled={connecting}
                    onClick={() => onLaunch('guided', true, language)}
                    className="hover:text-foreground shrink-0 cursor-pointer underline underline-offset-2"
                  >
                    Start over
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
