import { describe, it, expect, vi, beforeEach } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("openai", () => ({
  default: class {
    audio = { transcriptions: { create } };
  },
}));

const { transcribeAudio, TRANSCRIPTION_MODEL } = await import("./transcribe");

/** `bytes` seconds of nothing, named the way the composer names a recording. */
const recording = (bytes: number, name = "recording.webm") =>
  new File([new Uint8Array(bytes)], name, { type: "audio/webm" });

describe("transcribeAudio", () => {
  beforeEach(() => create.mockReset());

  it("returns what was said, without the padding around it", async () => {
    create.mockResolvedValue({ text: "  merhaba dünya \n" });

    await expect(transcribeAudio("sk-test", recording(4000))).resolves.toMatchObject({
      text: "merhaba dünya",
    });
  });

  it("sends the recording to the transcription model", async () => {
    create.mockResolvedValue({ text: "hello" });
    const file = recording(4000);

    await transcribeAudio("sk-test", file);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: TRANSCRIPTION_MODEL, file }),
    );
  });

  it("reports the audio OpenAI says it billed for", async () => {
    create.mockResolvedValue({
      text: "hello",
      usage: { type: "tokens", input_token_details: { audio_tokens: 2400, text_tokens: 14 } },
    });

    await expect(transcribeAudio("sk-test", recording(4000))).resolves.toMatchObject({
      audioTokens: 2400,
    });
  });

  // The SDK version pinned here does not type `usage`, so the field is read at
  // runtime and may simply not arrive. Falling back to zero would quietly make
  // dictation free — the one outcome metering exists to prevent — so the size of
  // the recording stands in for the duration instead.
  it("estimates from the recording when the API reports no usage", async () => {
    create.mockResolvedValue({ text: "hello" });

    // 32 kbps is what the composer records at: 4000 bytes is one second, and a
    // second of speech is ~40 audio tokens.
    await expect(transcribeAudio("sk-test", recording(4000))).resolves.toMatchObject({
      audioTokens: 40,
    });
    await expect(transcribeAudio("sk-test", recording(240_000))).resolves.toMatchObject({
      audioTokens: 2400,
    });
  });

  it("charges something for a recording too short to estimate", async () => {
    create.mockResolvedValue({ text: "hi" });

    const { audioTokens } = await transcribeAudio("sk-test", recording(10));

    expect(audioTokens).toBeGreaterThan(0);
  });
});
