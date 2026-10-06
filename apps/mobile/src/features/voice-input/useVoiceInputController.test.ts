import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { createElement, useEffect, useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";
import { resetVoiceInputGlobalsForTests } from "../../../../../packages/client-runtime/src/voice-input/controller";

const mocks = vi.hoisted(() => ({
  preferences: {} as { voiceInputSendImmediately?: boolean },
  screenFocused: true,
  transcribe: vi.fn(async () => "recognized text"),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => AsyncResult.success(mocks.preferences),
}));
vi.mock("../../state/preferences", () => ({ mobilePreferencesAtom: {} }));
vi.mock("expo-audio", () => ({
  AudioModule: {
    AudioRecorder: class {
      uri = "file:///recording.m4a";
      async prepareToRecordAsync() {}
      record() {}
      async stop() {}
      getStatus() {
        return { isRecording: false };
      }
      addListener() {
        return { remove() {} };
      }
      release() {}
    },
  },
  RecordingPresets: { HIGH_QUALITY: { ios: {}, android: {} } },
  requestRecordingPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
  setAudioModeAsync: async () => {},
  setIsAudioActiveAsync: async () => {},
}));
vi.mock("expo-file-system", () => ({
  File: class {
    delete() {}
  },
}));
vi.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: async () => {},
  deactivateKeepAwake: () => {},
}));
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return {
    useFocusEffect: (callback: () => void | (() => void)) => {
      const focused = mocks.screenFocused;
      useEffect(() => (focused ? callback() : undefined), [callback, focused]);
    },
  };
});
vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove() {} }) },
  Platform: { OS: "ios" },
}));
vi.mock("react-native-reanimated", async () => {
  const { useRef } = await import("react");
  return { useSharedValue: (value: unknown) => useRef({ value }).current };
});
vi.mock("../../native/voiceTranscription", () => ({
  getLocalVoiceTranscriber: () => ({
    prepare: async () => ({ locale: "en-US", transcribe: mocks.transcribe }),
  }),
}));
vi.mock("../showcase/nativeShowcaseScene", () => ({ getNativeShowcaseScene: () => null }));

import { useVoiceInputController } from "./useVoiceInputController";
import { VoiceInputProvider } from "./VoiceInputProvider";

const drafts = new Map<string, string>();
const draftListeners = new Set<() => void>();
function writeDraft(key: string, text: string) {
  drafts.set(key, text);
  for (const listener of draftListeners) listener();
}
function subscribeToDrafts(listener: () => void) {
  draftListeners.add(listener);
  return () => {
    draftListeners.delete(listener);
  };
}

type ComposerProps = {
  readonly owner?: string;
  readonly blocked?: boolean;
  /** Stands in for a composer that has not rendered the stored draft yet. */
  readonly renderedText?: string;
};

let renderer: ReactTestRenderer;
let voice: ReturnType<typeof useVoiceInputController>;
const sent: string[] = [];
function Composer({ owner = "thread", blocked = false, renderedText }: ComposerProps) {
  const stored = useSyncExternalStore(subscribeToDrafts, () => drafts.get(owner) ?? "");
  const text = renderedText ?? stored;
  const controller = useVoiceInputController({
    ownerKey: owner,
    label: "Thread",
    readDraftMessage: () => drafts.get(owner) ?? null,
    subscribeToDraftChanges: subscribeToDrafts,
    selection: { start: text.length, end: text.length },
    submit: {
      draftMessage: text,
      send: () => {
        if (!blocked && !controller.blocksSubmission) sent.push(text);
      },
    },
    onChangeDraftMessage: (value) => writeDraft(owner, value),
    onChangeSelection: () => {},
  });
  useEffect(() => {
    voice = controller;
  });
  return null;
}
function tree(props: ComposerProps = {}) {
  return createElement(VoiceInputProvider, null, createElement(Composer, props));
}
async function render(props?: ComposerProps) {
  await act(async () => {
    if (renderer) renderer.update(tree(props));
    else renderer = create(tree(props));
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  resetVoiceInputGlobalsForTests();
  mocks.preferences = {};
  mocks.screenFocused = true;
  mocks.transcribe.mockReset().mockResolvedValue("recognized text");
  drafts.clear();
  drafts.set("thread", "Existing draft");
  sent.length = 0;
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  renderer = undefined as never;
});

async function record() {
  await act(async () => {
    voice.start();
  });
  await act(async () => {
    await voice.stop();
  });
}

/** Stops the recording and holds the transcript until the returned `finish` is called. */
async function stopWithPendingTranscript() {
  const result = Promise.withResolvers<string>();
  const entered = Promise.withResolvers<void>();
  mocks.transcribe.mockImplementation(() => {
    entered.resolve();
    return result.promise;
  });
  await act(async () => {
    voice.start();
  });
  let stopping: Promise<void>;
  await act(async () => {
    stopping = voice.stop();
    await entered.promise;
  });
  return async (transcript: string, beforeTranscript?: () => void) => {
    await act(async () => {
      beforeTranscript?.();
      result.resolve(transcript);
      await stopping;
    });
  };
}

describe("voice input submission", () => {
  it("inserts into the composer by default", async () => {
    await render();
    await record();
    expect(drafts.get("thread")).toBe("Existing draft recognized text");
    expect(sent).toEqual([]);
  });
  it("sends the committed full draft exactly once after unlocking submission", async () => {
    mocks.preferences = { voiceInputSendImmediately: true };
    await render();
    await record();
    await render();
    expect(sent).toEqual(["Existing draft recognized text"]);
  });
  it("waits until the composer shows the transcript", async () => {
    mocks.preferences = { voiceInputSendImmediately: true };
    await render({ renderedText: "Existing draft" });
    await record();
    expect(sent).toEqual([]);
    await render();
    expect(sent).toEqual(["Existing draft recognized text"]);
  });
  it("does not send a transcript that changed before the composer showed it", async () => {
    mocks.preferences = { voiceInputSendImmediately: true };
    await render({ renderedText: "Existing draft" });
    await record();
    await act(async () => writeDraft("thread", "Edited draft"));
    await render();
    await act(async () => writeDraft("thread", "Existing draft recognized text"));
    expect(sent).toEqual([]);
  });
  it("leaves a blocked send in the composer without sending later", async () => {
    mocks.preferences = { voiceInputSendImmediately: true };
    await render({ blocked: true });
    await record();
    await render();
    expect(drafts.get("thread")).toBe("Existing draft recognized text");
    expect(sent).toEqual([]);
  });
  it.each(["", "   "])("does not send an empty transcript (%j)", async (transcript) => {
    mocks.preferences = { voiceInputSendImmediately: true };
    mocks.transcribe.mockResolvedValue(transcript);
    await render();
    await record();
    expect(drafts.get("thread")).toBe("Existing draft");
    expect(sent).toEqual([]);
  });
  it("does not send after cancellation during transcription", async () => {
    mocks.preferences = { voiceInputSendImmediately: true };
    await render();
    const finish = await stopWithPendingTranscript();
    await finish("late text", () => voice.cancel());
    expect(drafts.get("thread")).toBe("Existing draft");
    expect(sent).toEqual([]);
  });
  it("does not send a failed transcription", async () => {
    mocks.preferences = { voiceInputSendImmediately: true };
    mocks.transcribe.mockRejectedValue(new Error("unavailable"));
    await render();
    await record();
    expect(drafts.get("thread")).toBe("Existing draft");
    expect(sent).toEqual([]);
  });
  it("keeps the setting captured when recording starts", async () => {
    await render();
    await act(async () => {
      voice.start();
    });
    mocks.preferences = { voiceInputSendImmediately: true };
    await render();
    await act(async () => {
      await voice.stop();
    });
    expect(drafts.get("thread")).toBe("Existing draft recognized text");
    expect(sent).toEqual([]);
  });
  it("keeps a transcript as a draft when its screen is not in front", async () => {
    mocks.preferences = { voiceInputSendImmediately: true };
    await render();
    const finish = await stopWithPendingTranscript();
    mocks.screenFocused = false;
    await render();
    await finish("late text");
    mocks.screenFocused = true;
    await render();
    expect(drafts.get("thread")).toBe("Existing draft late text");
    expect(sent).toEqual([]);
  });
  it("keeps a transcript as a draft when the composer moved to another draft", async () => {
    mocks.preferences = { voiceInputSendImmediately: true };
    drafts.set("other-thread", "Other draft");
    await render();
    const finish = await stopWithPendingTranscript();
    await render({ owner: "other-thread" });
    await finish("late text");
    expect(drafts.get("thread")).toBe("Existing draft late text");
    expect(drafts.get("other-thread")).toBe("Other draft");
    expect(sent).toEqual([]);
  });
});
