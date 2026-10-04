'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Room } from 'livekit-client';
import { useVoiceAssistant } from '@livekit/components-react';
import type { Dossier, Mode, PrepState, Scenario, Stage, StepOutcome } from '@/lib/types';

// Topic of the text stream on which the agent sends the full session state.
const STATE_TOPIC = 'warren.state';

type Identified = { id: string };

function collectItems(state: PrepState): Identified[] {
  return [
    ...state.assets,
    ...state.liabilities,
    ...state.pensions,
    ...state.cashFlows,
    ...state.family.members,
    ...state.meetingPoints,
  ];
}

/** Ids of the items that are new or different in `next`. */
function changedIds(previous: PrepState | null, next: PrepState): Set<string> {
  if (!previous) return new Set();
  const before = new Map(collectItems(previous).map((item) => [item.id, JSON.stringify(item)]));
  const changed = new Set<string>();
  for (const item of collectItems(next)) {
    if (before.get(item.id) !== JSON.stringify(item)) changed.add(item.id);
  }
  return changed;
}

export interface UsePrepState {
  /** The agent's latest snapshot, or the dossier as loaded from the server until one arrives. */
  state: PrepState;
  /** True once the agent has sent at least one snapshot. */
  live: boolean;
  /** Ids of the items changed by the latest snapshot, for highlighting. */
  changed: Set<string>;
  /** The changed items that did not exist before: they are animated in. */
  added: Set<string>;
  /** Ask the agent to move to another stage. Resolves to false if the agent is not reachable. */
  setStage: (stage: Stage) => Promise<boolean>;
  /** Close the current step of the guided review and move on. */
  finishStep: (outcome: StepOutcome) => Promise<boolean>;
  /** Jump to a step of the review, or to the previous one. */
  goToStep: (step: { stepId: string } | { previous: true }) => Promise<boolean>;
  setMode: (mode: Mode) => Promise<boolean>;
  /** Ask the agent to show a simulation, or to go back to today. */
  setScenario: (scenario: Scenario | null) => Promise<boolean>;
}

/**
 * Keeps the session state in sync with the agent, which owns it: every change the agent makes
 * arrives as a full snapshot, and the newest revision wins.
 */
/** The client file alone, as a state: nothing computed by the agent yet. */
export function blankState(dossier: Dossier): PrepState {
  return {
    ...dossier,
    rev: -1,
    stage: 'wealth',
    meetingPoints: [],
    report: null,
    succession: null,
    scenario: null,
    mode: 'guided',
    language: 'en',
    agenda: [],
    currentStepId: null,
  };
}

export function usePrepState(room: Room, initial: PrepState): UsePrepState {
  const [state, setState] = useState<PrepState>(initial);
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Set<string>>(new Set());
  const latest = useRef<PrepState | null>(null);
  const { agent } = useVoiceAssistant();
  const agentIdentity = agent?.identity;

  useEffect(() => {
    room.registerTextStreamHandler(STATE_TOPIC, async (reader) => {
      try {
        const next = JSON.parse(await reader.readAll()) as PrepState;
        if (latest.current && next.rev <= latest.current.rev) return;
        const previous = latest.current;
        const known = new Set(previous ? collectItems(previous).map((item) => item.id) : []);
        const changedNow = changedIds(previous, next);
        setChanged(changedNow);
        setAdded(new Set([...changedNow].filter((id) => !known.has(id))));
        latest.current = next;
        setState(next);
      } catch (error) {
        console.error('Could not read the session state', error);
      }
    });
    return () => {
      room.unregisterTextStreamHandler(STATE_TOPIC);
      latest.current = null;
    };
  }, [room]);

  // Streams are not replayed: ask for the state whenever the agent (re)appears.
  useEffect(() => {
    if (!agentIdentity) return;
    // A new agent starts counting revisions again.
    latest.current = null;
    let cancelled = false;
    const request = async (attempt: number) => {
      try {
        await room.localParticipant.performRpc({
          destinationIdentity: agentIdentity,
          method: 'warren.request_state',
          payload: '',
        });
      } catch {
        // The agent registers its methods a moment after joining.
        if (!cancelled && attempt < 5) setTimeout(() => request(attempt + 1), 500);
      }
    };
    request(0);
    return () => {
      cancelled = true;
    };
  }, [room, agentIdentity]);

  const setStage = useCallback(
    async (stage: Stage) => {
      if (!agentIdentity) return false;
      try {
        await room.localParticipant.performRpc({
          destinationIdentity: agentIdentity,
          method: 'warren.set_stage',
          payload: JSON.stringify({ stage }),
        });
        return true;
      } catch (error) {
        console.error('Could not change stage', error);
        return false;
      }
    },
    [room, agentIdentity]
  );

  const setScenario = useCallback(
    async (scenario: Scenario | null) => {
      if (!agentIdentity) return false;
      try {
        await room.localParticipant.performRpc({
          destinationIdentity: agentIdentity,
          method: 'warren.set_scenario',
          payload: JSON.stringify({ scenario }),
        });
        return true;
      } catch (error) {
        console.error('Could not change the simulation', error);
        return false;
      }
    },
    [room, agentIdentity]
  );

  const call = useCallback(
    async (method: string, payload: unknown) => {
      if (!agentIdentity) return false;
      try {
        await room.localParticipant.performRpc({
          destinationIdentity: agentIdentity,
          method,
          payload: JSON.stringify(payload),
        });
        return true;
      } catch (error) {
        console.error(`${method} failed`, error);
        return false;
      }
    },
    [room, agentIdentity]
  );
  const finishStep = useCallback(
    (outcome: StepOutcome) => call('warren.finish_step', { outcome }),
    [call]
  );
  const goToStep = useCallback(
    (step: { stepId: string } | { previous: true }) => call('warren.go_to_step', step),
    [call]
  );
  const setMode = useCallback((mode: Mode) => call('warren.set_mode', { mode }), [call]);

  return {
    state,
    live: state.rev >= 0,
    changed,
    added,
    setStage,
    setScenario,
    finishStep,
    goToStep,
    setMode,
  };
}
