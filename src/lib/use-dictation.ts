import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";

/**
 * How long one recording may run.
 *
 * A dictated minute costs about what a chat turn costs, so an open-ended
 * recording is an open-ended bill — a phone left face-down on a desk would
 * spend someone's month. Two minutes is longer than anyone speaks into a
 * composer in one breath, and the count is shown while recording so the
 * ceiling arrives as an expectation rather than an interruption.
 */
export const MAX_RECORDING_SECONDS = 120;

/**
 * What the recording is asked to be, best first. Chrome and Firefox give webm,
 * Safari gives mp4; both are formats the transcription API accepts.
 */
const FORMATS = ["audio/webm", "audio/mp4"];

/**
 * 32 kbps mono. Speech survives it comfortably, and it keeps two minutes under
 * half a megabyte — which is what lets the server express its own ceiling as a
 * size without decoding the audio.
 */
const BITRATE = 32000;

export type DictationState = "idle" | "recording" | "transcribing";

export type Dictation = {
  /** Whether this browser can record at all. False on an insecure origin. */
  supported: boolean;
  state: DictationState;
  /** Seconds recorded so far, against `MAX_RECORDING_SECONDS`. */
  seconds: number;
  start: () => Promise<void>;
  /** Stop and transcribe what was said. */
  stop: () => void;
  /** Stop and throw the recording away. */
  cancel: () => void;
};

/**
 * Where the transcript lands in the draft.
 *
 * Appended, never substituted: someone who starts typing and then reaches for
 * the microphone means to finish the sentence, not to lose it. Whitespace the
 * person typed on purpose — a line break in a list — is left as they left it,
 * and only a missing separator is supplied.
 */
export function appendDictation(draft: string, text: string): string {
  if (draft.trim().length === 0) return text;
  return /\s$/.test(draft) ? `${draft}${text}` : `${draft} ${text}`;
}

/** `audio/webm;codecs=opus` → `webm`, and whatever Safari calls its mp4. */
function extensionFor(mimeType: string): string {
  if (/mp4|m4a|aac/.test(mimeType)) return "mp4";
  if (/ogg/.test(mimeType)) return "ogg";
  return "webm";
}

function pickFormat(): string | undefined {
  return FORMATS.find((type) => MediaRecorder.isTypeSupported?.(type));
}

/**
 * Speaking into the composer: record, send the audio to be transcribed, hand the
 * text back to whoever is drawing the composer.
 *
 * The hook never touches the draft itself. It calls `onText` and stops there, so
 * the composer decides where the words land — appended to what is already typed,
 * and left for the person to read before they send it. A transcription is a
 * guess at what someone said, and a guess that sends itself is a guess nobody
 * gets to correct.
 */
export function useDictation(onText: (text: string) => void): Dictation {
  const [state, setState] = useState<DictationState>("idle");
  const [seconds, setSeconds] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardRef = useRef(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // The composer re-renders on every keystroke, so the callback it passes is a
  // new function each time. Held in a ref, the recorder's handlers can be set up
  // once and still call the current one.
  //
  // The assignment is in an effect rather than in the render body, where it used
  // to be. Writing a ref during render makes the render impure: React may run it
  // twice, or throw it away and run it again, and a ref written on a render that
  // was discarded is a value nothing put there. It is harmless here today — the
  // ref is only read from a MediaRecorder callback, long after any render has
  // settled — and it is still the sort of thing that is only harmless until the
  // hook is used somewhere else. `react-hooks/refs` reports it in v7.
  const onTextRef = useRef(onText);
  useEffect(() => {
    onTextRef.current = onText;
  }, [onText]);

  const release = useCallback(() => {
    if (tickRef.current !== null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    // Until every track is stopped the browser keeps telling the person their
    // microphone is live, whatever this hook believes.
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    setSeconds(0);
  }, []);

  const stop = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  // Closing the conversation abandons the recording rather than finishing it.
  // Releasing the microphone is not enough on its own: a recorder whose tracks
  // have ended still fires `stop`, so without the discard the audio would be
  // sent, billed, and handed to a composer that is no longer on screen.
  useEffect(
    () => () => {
      discardRef.current = true;
      stop();
      release();
    },
    [release, stop],
  );

  const cancel = useCallback(() => {
    discardRef.current = true;
    stop();
  }, [stop]);

  const start = useCallback(async () => {
    if (recorderRef.current) return;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      toast.error(
        name === "NotFoundError" || name === "DevicesNotFoundError"
          ? "No microphone found."
          : "Covan needs permission to use your microphone.",
      );
      return;
    }

    const mimeType = pickFormat();
    const recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: BITRATE,
    });

    streamRef.current = stream;
    recorderRef.current = recorder;
    chunksRef.current = [];
    discardRef.current = false;

    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = () => {
      const discarded = discardRef.current;
      const type = recorder.mimeType || mimeType || "audio/webm";
      const chunks = chunksRef.current;
      chunksRef.current = [];
      release();

      if (discarded || chunks.length === 0) {
        setState("idle");
        return;
      }

      setState("transcribing");
      const file = new File(chunks, `recording.${extensionFor(type)}`, { type });
      api
        .transcribe(file)
        .then((res) => onTextRef.current(res.text))
        .catch((e: unknown) => {
          // The server's sentence, not a status code: over-quota and heard-nothing
          // both arrive here already written for a person to read.
          toast.error(
            e instanceof Error && e.message ? e.message : "Couldn't turn that into text.",
          );
        })
        .finally(() => setState("idle"));
    };

    recorder.start();
    setSeconds(0);
    setState("recording");

    // One timer for both jobs: what the composer shows, and when to stop.
    let elapsed = 0;
    tickRef.current = setInterval(() => {
      elapsed += 1;
      setSeconds(elapsed);
      if (elapsed >= MAX_RECORDING_SECONDS) stop();
    }, 1000);
  }, [release, stop]);

  // Read at render rather than at module load: `mediaDevices` is absent on an
  // insecure origin, and the server render has neither.
  const supported =
    typeof MediaRecorder !== "undefined" &&
    typeof navigator?.mediaDevices?.getUserMedia === "function";

  return { supported, state, seconds, start, stop, cancel };
}
