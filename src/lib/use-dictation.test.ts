import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useDictation, appendDictation, MAX_RECORDING_SECONDS } from "./use-dictation";

const transcribe = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: { transcribe: (...args: unknown[]) => transcribe(...args) },
}));

const error = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => error(...args), warning: vi.fn(), success: vi.fn() },
}));

/**
 * A microphone that behaves, and a recorder that only does what the hook asks
 * of it. `MediaRecorder` is not in jsdom at all, so there is nothing to spy on —
 * the fake is the only way to drive a recording from a test.
 */
class FakeMediaRecorder {
  static last: FakeMediaRecorder | null = null;
  static supported = ["audio/webm"];
  static isTypeSupported = (type: string) => FakeMediaRecorder.supported.includes(type);

  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(
    readonly stream: MediaStream,
    readonly options?: { mimeType?: string; audioBitsPerSecond?: number },
  ) {
    FakeMediaRecorder.last = this;
  }

  get mimeType() {
    return this.options?.mimeType ?? "audio/webm";
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio"], { type: this.mimeType }) });
    this.onstop?.();
  }
}

const track = { stop: vi.fn() };
const getUserMedia = vi.fn();

/**
 * Ending the track ends the recording. A real `MediaRecorder` whose stream runs
 * out of live tracks does not go quiet — it finishes the recording and fires
 * `dataavailable` and `stop` on the way out. A fake that stayed silent here
 * would let a hook that releases the microphone without stopping the recorder
 * pass, which is the one thing these tests exist to catch.
 */
const endTrack = () => {
  const recorder = FakeMediaRecorder.last;
  if (recorder?.state === "recording") recorder.stop();
};

beforeEach(() => {
  transcribe.mockReset().mockResolvedValue({ text: "merhaba dünya" });
  error.mockReset();
  track.stop.mockReset().mockImplementation(endTrack);
  getUserMedia
    .mockReset()
    .mockResolvedValue({ getTracks: () => [track] } as unknown as MediaStream);
  FakeMediaRecorder.last = null;
  FakeMediaRecorder.supported = ["audio/webm"];
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia },
    configurable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Start a recording and wait for the hook to say it is running. */
async function startRecording(result: { current: ReturnType<typeof useDictation> }) {
  await act(async () => {
    await result.current.start();
  });
  expect(result.current.state).toBe("recording");
}

describe("appendDictation", () => {
  it("is the whole draft when there was nothing typed", () => {
    expect(appendDictation("", "merhaba dünya")).toBe("merhaba dünya");
    expect(appendDictation("   ", "merhaba dünya")).toBe("merhaba dünya");
  });

  // Dictation adds to what someone was typing rather than replacing it: the
  // half-sentence in the box is the reason they reached for the microphone.
  it("carries on from what was already typed", () => {
    expect(appendDictation("bir de", "şunu ekle")).toBe("bir de şunu ekle");
  });

  it("does not double the space someone already typed", () => {
    expect(appendDictation("bir de ", "şunu ekle")).toBe("bir de şunu ekle");
  });

  it("keeps a deliberate line break instead of flattening it", () => {
    expect(appendDictation("başlık\n", "ikinci satır")).toBe("başlık\nikinci satır");
  });
});

describe("useDictation", () => {
  it("hands what was said to the composer", async () => {
    const onText = vi.fn();
    const { result } = renderHook(() => useDictation(onText));

    await startRecording(result);
    await act(async () => {
      result.current.stop();
    });

    await waitFor(() => expect(onText).toHaveBeenCalledWith("merhaba dünya"));
    expect(result.current.state).toBe("idle");
  });

  it("asks for the microphone when recording starts, not before", () => {
    renderHook(() => useDictation(vi.fn()));

    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("says so, in a sentence, when the microphone is refused", async () => {
    getUserMedia.mockRejectedValue(
      Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }),
    );
    const { result } = renderHook(() => useDictation(vi.fn()));

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.state).toBe("idle");
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/microphone/i));
  });

  // The tab keeps showing a recording indicator until every track is stopped,
  // so a hook that transcribes correctly and never releases the microphone
  // still looks like it is listening.
  it("releases the microphone once the recording is over", async () => {
    const { result } = renderHook(() => useDictation(vi.fn()));

    await startRecording(result);
    await act(async () => {
      result.current.stop();
    });

    await waitFor(() => expect(track.stop).toHaveBeenCalled());
  });

  it("throws away a cancelled recording rather than paying to transcribe it", async () => {
    const onText = vi.fn();
    const { result } = renderHook(() => useDictation(onText));

    await startRecording(result);
    await act(async () => {
      result.current.cancel();
    });

    await waitFor(() => expect(result.current.state).toBe("idle"));
    expect(transcribe).not.toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
  });

  // Closing the conversation while recording is a way of abandoning it. Stopping
  // the microphone but still sending the audio would bill someone for a
  // sentence, and put it in a composer that is no longer on screen.
  it("abandons a recording the person navigated away from", async () => {
    const { result, unmount } = renderHook(() => useDictation(vi.fn()));

    await startRecording(result);
    await act(async () => {
      unmount();
    });

    expect(transcribe).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
  });

  // Transcribing what was said is better than discarding it, so the ceiling
  // ends the recording the same way the button does.
  it("stops itself at the ceiling and keeps what it heard", async () => {
    vi.useFakeTimers();
    const onText = vi.fn();
    const { result } = renderHook(() => useDictation(onText));

    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_RECORDING_SECONDS * 1000 + 100);
    });

    expect(transcribe).toHaveBeenCalled();
    expect(onText).toHaveBeenCalledWith("merhaba dünya");
  });

  it("counts the seconds so the ceiling is not a surprise", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useDictation(vi.fn()));

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.seconds).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(result.current.seconds).toBe(3);
  });

  it("explains a transcription that failed, and gives the composer nothing", async () => {
    transcribe.mockRejectedValue(new Error("could not transcribe the recording"));
    const onText = vi.fn();
    const { result } = renderHook(() => useDictation(onText));

    await startRecording(result);
    await act(async () => {
      result.current.stop();
    });

    await waitFor(() => expect(error).toHaveBeenCalledWith("could not transcribe the recording"));
    expect(onText).not.toHaveBeenCalled();
    expect(result.current.state).toBe("idle");
  });

  // The server decides what it can transcribe by the file's extension, so a
  // Safari recording named .webm is refused for being the wrong format.
  it("names the recording after what the browser actually recorded", async () => {
    FakeMediaRecorder.supported = ["audio/mp4"];
    const { result } = renderHook(() => useDictation(vi.fn()));

    await startRecording(result);
    await act(async () => {
      result.current.stop();
    });

    await waitFor(() => expect(transcribe).toHaveBeenCalled());
    const sent = transcribe.mock.calls[0][0] as File;
    expect(sent.name).toBe("recording.mp4");
  });

  // Not every browser records, and an insecure origin has no `mediaDevices` at
  // all. The control asks first rather than offering a button that can only
  // apologise — failure mode 5 in DESIGN.md, arrived at from the other side.
  it("says whether this browser can record at all", () => {
    const { result } = renderHook(() => useDictation(vi.fn()));
    expect(result.current.supported).toBe(true);

    vi.stubGlobal("MediaRecorder", undefined);
    const { result: without } = renderHook(() => useDictation(vi.fn()));
    expect(without.current.supported).toBe(false);
  });

  it("is unsupported where the page cannot reach a microphone", () => {
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });

    const { result } = renderHook(() => useDictation(vi.fn()));

    expect(result.current.supported).toBe(false);
  });

  it("records webm where webm is available", async () => {
    const { result } = renderHook(() => useDictation(vi.fn()));

    await startRecording(result);
    await act(async () => {
      result.current.stop();
    });

    await waitFor(() => expect(transcribe).toHaveBeenCalled());
    expect((transcribe.mock.calls[0][0] as File).name).toBe("recording.webm");
  });
});
