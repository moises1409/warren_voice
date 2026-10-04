'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReceivedMessage } from '@livekit/components-react';
import type { PrepState } from '@/lib/types';

// How much of the end of Warren's sentence is looked at, and how long a mention stays lit.
const TAIL_CHARS = 140;
const HOLD_MS = 4500;
// A word that points at more items than this is too vague to highlight anything.
const MAX_ITEMS_PER_WORD = 2;

// Words that appear in labels but do not single out an item.
const GENERIC = new Set([
  'account',
  'accounts',
  'apartment',
  'asset',
  'assets',
  'bank',
  'bond',
  'bonds',
  'cash',
  'costs',
  'current',
  'equities',
  'equity',
  'expected',
  'family',
  'from',
  'fund',
  'funds',
  'global',
  'home',
  'income',
  'living',
  'mandate',
  'plan',
  'planned',
  'portfolio',
  'savings',
  'stake',
  'swiss',
  'with',
]);

// The accents left over once a letter is split from them (U+0300 to U+036F).
const COMBINING_MARKS = new RegExp(
  '[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']',
  'g'
);

/** Lower-case, without accents, so "Küsnacht" matches a transcript's "Kusnacht". */
function normalize(text: string): string {
  return text.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();
}

function words(text: string | null | undefined): string[] {
  if (!text) return [];
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !GENERIC.has(word));
}

/** Which words, when Warren says them, point at which items on screen. */
function buildIndex(state: PrepState, houseBank: string): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  // The house bank's name is on half the screen and in Warren's own name: it singles out nothing.
  const house = new Set(words(houseBank));
  const add = (word: string, id: string) => {
    if (house.has(word)) return;
    const ids = index.get(word) ?? new Set<string>();
    ids.add(id);
    index.set(word, ids);
  };

  for (const item of [...state.assets, ...state.liabilities]) {
    for (const word of [...words(item.label), ...words(item.type)]) add(word, item.id);
    for (const word of words(item.bank)) add(word, item.id);
  }
  for (const item of state.pensions) {
    for (const word of [...words(item.provider), 'pension']) add(word, item.id);
  }
  for (const item of state.cashFlows) {
    for (const word of [...words(item.label), ...words(item.type)]) add(word, item.id);
  }
  for (const member of state.family.members) {
    // First names only: the surname is usually the client's too.
    const [first] = words(member.name);
    if (first) add(first, member.id);
  }

  for (const [word, ids] of index) {
    if (ids.size > MAX_ITEMS_PER_WORD) index.delete(word);
  }
  return index;
}

/**
 * The items Warren is talking about right now, worked out from what it is saying: the words of
 * its live transcript are matched against what is on screen. Costs the agent nothing and can
 * never slow down its speech.
 */
export function useSpokenFocus(
  messages: ReceivedMessage[],
  state: PrepState,
  houseBank: string
): Set<string> {
  const [focus, setFocus] = useState<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const index = useMemo(() => buildIndex(state, houseBank), [state, houseBank]);

  const last = messages.at(-1);
  const spoken = last && !last.from?.isLocal ? last.message : '';

  useEffect(() => {
    if (!spoken) return;
    const tail = new Set(words(spoken.slice(-TAIL_CHARS)));
    const ids = new Set<string>();
    for (const word of tail) for (const id of index.get(word) ?? []) ids.add(id);
    if (ids.size === 0) return;

    setFocus(ids);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setFocus(new Set()), HOLD_MS);
  }, [spoken, index]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  return focus;
}
