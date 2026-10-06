import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useRef } from "react";
import {
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { mobilePreferencesAtom } from "../../state/preferences";
import { useGlobalVoiceInput } from "./VoiceInputProvider";
import { createVoiceInputTarget } from "./voiceInputSession";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

export function useVoiceInputController(input: {
  readonly ownerKey: string | null;
  /** Shown by the global dictation pill when this composer is off screen. */
  readonly label: string;
  readonly readDraftMessage: () => string | null;
  readonly subscribeToDraftChanges: (onChange: () => void) => () => void;
  readonly selection: ComposerEditorSelection;
  readonly disabled?: boolean;
  /**
   * Lets "Send immediately" send a dictated draft. `draftMessage` is the text this composer
   * has rendered, so the send waits until the transcript shows there. Omit where dictated
   * text has nothing to send.
   */
  readonly submit?: { readonly draftMessage: string; readonly send: () => void };
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onChangeSelection: (selection: ComposerEditorSelection) => void;
}) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const sendImmediately =
    AsyncResult.isSuccess(preferences) && preferences.value.voiceInputSendImmediately === true;
  const pendingSubmission = useRef<{ ownerKey: string; text: string } | null>(null);
  const global = useGlobalVoiceInput();
  const { setOwnerFocused, session } = global;
  const latestInput = useRef(input);
  latestInput.current = input;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      const ownerKey = input.ownerKey;
      if (!ownerKey) return;
      setOwnerFocused(ownerKey, true);
      return () => setOwnerFocused(ownerKey, false);
    }, [input.ownerKey, setOwnerFocused]),
  );

  // Dictation outlives this screen, but only a composer the user is looking at sends by
  // itself. A transcript that lands elsewhere stays a draft.
  const screenFocused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      screenFocused.current = true;
      return () => {
        screenFocused.current = false;
        pendingSubmission.current = null;
      };
    }, []),
  );

  const start = useCallback(() => {
    const captured = latestInput.current;
    const ownerKey = captured.ownerKey;
    if (!ownerKey || captured.disabled) return;
    pendingSubmission.current = null;
    void session.start({
      ...createVoiceInputTarget(
        ownerKey,
        captured.readDraftMessage,
        (text, selection) => {
          captured.onChangeDraftMessage(text);
          if (mounted.current && latestInput.current.ownerKey === ownerKey) {
            latestInput.current.onChangeSelection(selection);
            // The setting applies as it was when recording started.
            if (sendImmediately && screenFocused.current) {
              pendingSubmission.current = { ownerKey, text };
            }
          }
        },
        captured.selection,
        captured.subscribeToDraftChanges,
      ),
      label: captured.label,
    });
  }, [sendImmediately, session]);
  const state = global.ownerKey === input.ownerKey ? global.state : IDLE_STATE;
  // Send once the voice lock is released and the composer shows the transcript. The pending
  // send is consumed there: a send that is blocked at that point stays a draft.
  useEffect(() => {
    const pending = pendingSubmission.current;
    if (!pending || state.phase !== "idle") return;
    const submit = input.submit;
    if (
      !submit ||
      pending.ownerKey !== input.ownerKey ||
      input.readDraftMessage() !== pending.text
    ) {
      pendingSubmission.current = null;
      return;
    }
    if (submit.draftMessage !== pending.text) return;
    pendingSubmission.current = null;
    if (!input.disabled) submit.send();
  }, [input, state.phase]);
  const isBusy = voiceInputBlocksSubmission(state);
  return {
    isAvailable: global.isAvailable && (!global.isBusy || global.ownerKey === input.ownerKey),
    state,
    audioLevels: global.audioLevels,
    elapsedSeconds: global.elapsedSeconds,
    isBusy,
    freezesEditor: isBusy,
    blocksSubmission: isBusy,
    start,
    stop: global.stop,
    cancel: global.cancel,
  };
}
