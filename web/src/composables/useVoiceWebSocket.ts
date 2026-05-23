import { ref, reactive } from "vue";

export interface VoiceState {
  connected: boolean;
  tsClientId: number;
  error: string;
}

export interface ChannelMember {
  id: number;
  nickname: string;
  isSelf?: boolean;
}

export function useVoiceWebSocket() {
  const ws = ref<WebSocket | null>(null);
  const state = reactive<VoiceState>({
    connected: false,
    tsClientId: 0,
    error: "",
  });
  const members = reactive<ChannelMember[]>([]);

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

  function checkSupport(): string | null {
    // WebCodecs requires secure context (HTTPS or localhost)
    if (typeof window === "undefined") return null;
    const isSecure = window.isSecureContext;
    if (!isSecure) {
      return "此页面需要安全上下文 (HTTPS)。WebCodecs API 在 HTTP 下不可用。";
    }
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

    isPumping = true;
    (async function pump() {
      while (isPumping && micReader) {
        try {
          const { done, value } = await micReader.read();
          if (done) break;
          if (value && audioEncoder?.state === "configured") {
            audioEncoder.encode(value);
            value.close();
          } else if (value) {
            value.close();
          }
        } catch {
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
    if (opusData.length < 2) return;

    let decoder = remoteDecoders.get(clientId);
    if (!decoder) {
      const ctx = getAudioCtx();
      decoder = new AudioDecoder({
        output: (chunk: AudioData) => {
          try {
            const { sampleRate, numberOfChannels, numberOfFrames } = chunk;
            const buffer = ctx.createBuffer(numberOfChannels, numberOfFrames, sampleRate);

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

    try {
      const chunk = new EncodedAudioChunk({
        type: "key",
        timestamp: 0,
        duration: 960,
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
    members.length = 0;

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
        } catch { /* ignore */ }
      } else {
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
    members.length = 0;

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
        if (msg.members) {
          members.length = 0;
          for (const m of msg.members) {
            members.push(m);
          }
        }
        break;
      case "memberEnter":
        if (!members.find((m) => m.id === msg.id)) {
          members.push({ id: msg.id, nickname: msg.nickname, isSelf: msg.isSelf });
        }
        break;
      case "memberLeave":
        {
          const idx = members.findIndex((m) => m.id === msg.id);
          if (idx >= 0) members.splice(idx, 1);
        }
        break;
      case "disconnected":
        state.connected = false;
        state.error = "与 TeamSpeak 服务器的连接已断开";
        break;
    }
  }

  function handleAudioFrame(data: Uint8Array): void {
    if (data.length < 4) return;
    const codec = data[0];
    const clientId = (data[1] << 8) | data[2];
    const opusFrame = data.slice(3);
    playAudioFrame(clientId, opusFrame);
  }

  function clearError(): void {
    state.error = "";
  }

  return {
    ws,
    state,
    members,
    connect,
    disconnect,
    startMicrophone,
    stopMicrophone,
    checkSupport,
    clearError,
  };
}
