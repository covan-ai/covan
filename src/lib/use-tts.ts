import { useState, useCallback, useEffect } from "react";

/**
 * Text-to-speech using the Web Speech API.
 *
 * Browser support is good (Chrome/Edge/Safari), and it's a zero-dependency
 * built-in. Firefox has partial support. Falls back gracefully when unavailable.
 */

export type TTSState = {
  speaking: boolean;
  supported: boolean;
};

export type TTSControls = {
  speak: (text: string) => void;
  stop: () => void;
};

export function useTTS(): TTSState & TTSControls {
  const [speaking, setSpeaking] = useState(false);
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;

  useEffect(() => {
    if (!supported) return;

    const synthesis = window.speechSynthesis;
    const handleEnd = () => setSpeaking(false);

    // speechSynthesis fires 'end' on the utterance, but we need to poll
    // speaking state because there's no direct event on the synthesis object
    let interval: ReturnType<typeof setInterval> | null = null;
    if (speaking) {
      interval = setInterval(() => {
        if (!synthesis.speaking) setSpeaking(false);
      }, 100);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [speaking, supported]);

  const speak = useCallback(
    (text: string) => {
      if (!supported) return;

      const synthesis = window.speechSynthesis;
      synthesis.cancel(); // Stop any ongoing speech

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;

      utterance.onstart = () => setSpeaking(true);
      utterance.onend = () => setSpeaking(false);
      utterance.onerror = () => setSpeaking(false);

      synthesis.speak(utterance);
      setSpeaking(true);
    },
    [supported],
  );

  const stop = useCallback(() => {
    if (!supported) return;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [supported]);

  return {
    speaking,
    supported,
    speak,
    stop,
  };
}
