import { ref, reactive } from "vue";

export interface VoiceState {
  connected: boolean;
  tsClientId: number;
  error: string;
}

export function useVoiceWebSocket() {
  const ws = ref<WebSocket | null>(null);
  const state = reactive<VoiceState>({
    connected: false,
    tsClientId: 0,
    error: "",
  });

  // Audio context (created on first user interaction)
  let audioCtx: AudioContext | null = null;
  let audioEncoder: AudioEncoder | null = null;
  let micStream: MediaStream | null = null;
  let micTrack: MediaStreamTrack | null = null;
  let micProcessor: MediaStreamTrackProcessor<AudioData> | null = null;
  let micReader: ReadableStreamDefaultReader<AudioData> | null = null;
  let isPumping = false;

  // Per-user decoders and playback
  const remoteDecoders = new Map<number, AudioDecoder>();
  let nextPlayTime = 0;

  function getAudioCtx(): AudioContext {
    if (!audioCtx) {
      audioCtx = new AudioContext({ sampleRate: 48000 });
    }
    return audioCtx;
  }

  // --- Check browser support ---
  function checkSupport(): string | null {
    if (typeof AudioEncoder === "undefined" || typeof AudioDecoder === "undefined") {
      return "WebCodecs API (AudioEncoder/AudioDecoder) 不可用，请使用 Chrome 94+ 或 Edge 94+";
    }
    if (typeof MediaStreamTrackProcessor === "undefined") {
      return "MediaStreamTrackProcessor 不可用，请使用 Chrome 94+";
    }
    return null;
  }

  // --- Microphone capture & Opus encoding ---
  async function startMicrophone(): Promise<void> {
    const supportErr = checkSupport();
    if (supportErr) throw new Error(supportErr);

    const ctx = getAudioCtx();

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 48000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    micTrack = micStream.getAudioTracks()[0];

    // Use MediaStreamTrackProcessor to get raw audio frames
    micProcessor = new MediaStreamTrackProcessor({ track: micTrack });
    const readable = micProcessor.readable;
    micReader = readable.getReader();

    audioEncoder = new AudioEncoder({
      output: (chunk) => {
        if (ws.value?.readyState === WebSocket.OPEN) {
          ws.value.send(chunk.data);
        }
      },
      error: (e) => {
        console.error("AudioEncoder error:", e);
      },
    });

    audioEncoder.configure({
      codec: "opus",
      sampleRate: 48000,
      numberOfChannels: 1,
      bitrate: 32000,
    });

    // Pump audio frames from mic → encoder
    isPumping = true;
    (async function pump() {
      while (isPumping && micReader) {
        try {
          const { done, value } = await micReader.read();
          if (done) break;
          if (value && audioEncoder?.state === "configured") {
            const frame = new VideoFrame(value, {
              timestamp: value.timestamp,
              duration: value.duration,
            });
            audioEncoder.encode(value);
            value.close();
          } else if (value) {
            value.close();
          }
        } catch {
          // stream ended
          break;
        }
      }
    })();
  }

  function stopMicrophone(): void {
    isPumping = false;
    micReader?.cancel().catch(() => {});
    micReader = null;
    audioEncoder?.close();
    audioEncoder = null;
    micTrack?.stop();
    micTrack = null;
    micStream?.getTracks().forEach((t) => t.stop());
    micStream = null;
  }

  // --- Playback: decode Opus → speakers ---
  function playAudioFrame(clientId: number, opusData: Uint8Array): void {
    if (opusData.length < 2) return; // skip empty/stub frames

    let decoder = remoteDecoders.get(clientId);
    if (!decoder) {
      const ctx = getAudioCtx();
      decoder = new AudioDecoder({
        output: (chunk: AudioData) => {
          // Schedule this AudioData for playback on the AudioContext
          try {
            const { sampleRate, numberOfChannels, numberOfFrames } = chunk;
            const buffer = ctx.createBuffer(numberOfChannels, numberOfFrames, sampleRate);

            // Copy planar float data
            for (let ch = 0; ch < numberOfChannels; ch++) {
              const channelData = new Float32Array(numberOfFrames);
              chunk.copyTo(channelData, { planeIndex: ch, format: "f32-planar" });
              buffer.copyToChannel(channelData, ch);
            }

            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(ctx.destination);

            const now = ctx.currentTime;
            if (nextPlayTime < now) nextPlayTime = now;
            source.start(nextPlayTime);
            nextPlayTime += numberOfFrames / sampleRate;

            source.onended = () => {
              buffer; // keep ref
            };
          } catch (e) {
            console.error("Playback error:", e);
          }
          chunk.close();
        },
        error: (e) => console.error("AudioDecoder error:", e),
      });
      decoder.configure({
        codec: "opus",
        sampleRate: 48000,
        numberOfChannels: 1,
      });
      remoteDecoders.set(clientId, decoder);
    }

    // Feed Opus frame to decoder
    try {
      const chunk = new EncodedAudioChunk({
        type: "key",
        timestamp: 0,
        duration: 960, // 20ms at 48kHz
        data: opusData,
      });
      decoder.decode(chunk);
    } catch (e) {
      console.error("Decode error:", e);
    }
  }

  // --- WebSocket connection ---
  function connect(serverUrl: string, token: string, channel: string, nickname: string): void {
    state.error = "";

    const params = new URLSearchParams({ token, nickname });
    if (channel) params.set("channel", channel);

    const url = `${serverUrl}/ws/voice?${params.toString()}`;
    ws.value = new WebSocket(url);
    ws.value.binaryType = "arraybuffer";

    ws.value.onopen = () => {
      state.connected = true;
    };

    ws.value.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const msg = JSON.parse(event.data);
          handleControlMessage(msg);
        } catch {
          // ignore malformed JSON
        }
      } else {
        // Binary audio frame: [1B codec][2B clientId BE][N bytes Opus]
        handleAudioFrame(new Uint8Array(event.data));
      }
    };

    ws.value.onclose = (e) => {
      state.connected = false;
      if (e.code !== 1000) {
        state.error = `连接断开 (code: ${e.code})`;
      }
      stopMicrophone();
    };

    ws.value.onerror = () => {
      state.error = "WebSocket 连接失败";
    };
  }

  function disconnect(): void {
    stopMicrophone();
    ws.value?.close(1000);
    ws.value = null;
    state.connected = false;
    state.tsClientId = 0;

    // Clean up decoders
    for (const [, decoder] of remoteDecoders) {
      decoder.close();
    }
    remoteDecoders.clear();
    nextPlayTime = 0;
  }

  function handleControlMessage(msg: any): void {
    switch (msg.type) {
      case "connected":
        state.tsClientId = msg.tsClientId;
        break;
      case "disconnected":
        state.connected = false;
        state.error = "与 TeamSpeak 服务器的连接已断开";
        break;
      case "chatMessage":
        // Could push to a chat store
        break;
      case "clientEnter":
        break;
      case "clientLeave":
        break;
    }
  }

  function handleAudioFrame(data: Uint8Array): void {
    if (data.length < 4) return;
    const codec = data[0];
    const clientId = (data[1] << 8) | data[2];
    const opusFrame = data.slice(3);

    // Ignore self-voice (the server sends back our own voice too)
    if (clientId === state.tsClientId || clientId === 0) return;

    playAudioFrame(clientId, opusFrame);
  }

  function clearError(): void {
    state.error = "";
  }

  return {
    ws,
    state,
    connect,
    disconnect,
    startMicrophone,
    stopMicrophone,
    checkSupport,
    clearError,
  };
}
