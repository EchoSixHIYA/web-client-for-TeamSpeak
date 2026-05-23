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

export interface ChannelInfo {
  id: string;
  parentID: string;
  name: string;
  members?: { id: number; nickname: string }[];
}

export function useVoiceWebSocket() {
  const ws = ref<WebSocket | null>(null);
  const state = reactive<VoiceState>({ connected: false, tsClientId: 0, error: "" });
  const members = reactive<ChannelMember[]>([]);
  const channels = reactive<ChannelInfo[]>([]);

  // Audio: capture PCM s16 via ScriptProcessorNode
  let audioCtx: AudioContext | null = null;
  let micStream: MediaStream | null = null;
  let scriptNode: ScriptProcessorNode | null = null;
  let micSource: MediaStreamAudioSourceNode | null = null;
  let pttPressed = false;
  const micMode = ref<"vox" | "ptt">("vox");
  let voxHold = 0;
  const VOX_HOLD = 15;
  const VOX_THRESHOLD = 0.008;
  // Pre-allocated buffers for hot audio path (avoid per-callback GC)
  let convBuf = new Int16Array(1024);
  let accumBuf = new Int16Array(2048);
  let accumLen = 0;

  // Playback — per-client state to avoid interleaving streams
  const remoteDecoders = new Map<number, AudioDecoder>();
  const remotePlayTimes = new Map<number, number>();

  function getAudioCtx(): AudioContext {
    if (!audioCtx) audioCtx = new AudioContext({ sampleRate: 48000 });
    return audioCtx;
  }

  function checkSupport(): string | null {
    if (typeof window === "undefined") return null;
    if (!window.isSecureContext) return "需要 HTTPS";
    if (typeof AudioDecoder === "undefined") return "AudioDecoder 不可用，请用 Chrome/Edge 94+";
    return null;
  }

  async function startMicrophone(): Promise<void> {
    const ctx = getAudioCtx();
    if (ctx.state === "suspended") await ctx.resume();
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: { ideal: 48000 }, channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    micSource = ctx.createMediaStreamSource(micStream);
    scriptNode = ctx.createScriptProcessor(1024, 1, 1);

    scriptNode.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const shouldSend = micMode.value === "ptt" ? pttPressed : voxGate(input);
      if (!shouldSend) { accumLen = 0; return; }
      // Float32 → Int16 via pre-allocated convBuf (avoids per-callback allocation)
      if (convBuf.length < input.length) convBuf = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        convBuf[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      // Append to pre-allocated accumBuf (grows if needed, max ~1984)
      const need = accumLen + input.length;
      if (accumBuf.length < need) accumBuf = new Int16Array(need);
      accumBuf.set(convBuf.subarray(0, input.length), accumLen);
      accumLen = need;
      // Send complete 960-sample frames
      let offset = 0;
      while (offset + 960 <= accumLen && ws.value?.readyState === WebSocket.OPEN) {
        ws.value.send(accumBuf.slice(offset, offset + 960).buffer);
        offset += 960;
      }
      // Compact: shift remaining to front
      accumLen -= offset;
      if (offset > 0) accumBuf.set(accumBuf.subarray(offset, offset + accumLen), 0);
    };

    micSource.connect(scriptNode);
    scriptNode.connect(ctx.destination);
  }

  function voxGate(samples: Float32Array): boolean {
    let sum = 0;
    for (let i = 0; i < Math.min(256, samples.length); i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / Math.min(256, samples.length));
    if (rms > VOX_THRESHOLD) { voxHold = VOX_HOLD; return true; }
    if (voxHold > 0) { voxHold--; return true; }
    return false;
  }

  function stopMicrophone(): void {
    accumLen = 0;
    scriptNode?.disconnect(); scriptNode = null;
    micSource?.disconnect(); micSource = null;
    micStream?.getTracks().forEach((t) => t.stop()); micStream = null;
    audioCtx?.close(); audioCtx = null;
  }

  // --- Playback ---
  function playAudioFrame(clientId: number, opusData: Uint8Array): void {
    if (opusData.length < 3) return;
    let decoder = remoteDecoders.get(clientId);
    if (!decoder) {
      const ctx = getAudioCtx();
      decoder = new AudioDecoder({
        output: (chunk: AudioData) => {
          try {
            const { sampleRate, numberOfChannels, numberOfFrames } = chunk;
            const buffer = ctx.createBuffer(numberOfChannels, numberOfFrames, sampleRate);
            for (let ch = 0; ch < numberOfChannels; ch++) {
              const data = new Float32Array(numberOfFrames);
              chunk.copyTo(data, { planeIndex: ch, format: "f32-planar" });
              buffer.copyToChannel(data, ch);
            }
            const source = ctx.createBufferSource();
            source.buffer = buffer; source.connect(ctx.destination);
            let pt = remotePlayTimes.get(clientId) ?? ctx.currentTime;
            if (pt < ctx.currentTime) pt = ctx.currentTime;
            source.start(pt);
            remotePlayTimes.set(clientId, pt + numberOfFrames / sampleRate);
          } catch { /* */ }
          chunk.close();
        },
        error: () => {},
      });
      decoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1 });
      remoteDecoders.set(clientId, decoder);
    }
    try { decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: 0, duration: 960, data: opusData })); } catch { /* */ }
  }

  // --- WebSocket ---
  function connect(token: string, channel: string, nickname: string): void {
    state.error = ""; members.length = 0; channels.length = 0;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams({ token, nickname });
    if (channel) params.set("channel", channel);
    ws.value = new WebSocket(`${proto}//${location.host}/ws/voice?${params.toString()}`);
    ws.value.binaryType = "arraybuffer";
    ws.value.onopen = () => { state.connected = true; startChannelPoll(); startMicrophone().catch(e => { state.error = "麦克风: " + e.message; }); };
    ws.value.onmessage = (event) => {
      if (typeof event.data === "string") { try { handleMessage(JSON.parse(event.data)); } catch { /* */ } }
      else handleAudioFrame(new Uint8Array(event.data));
    };
    ws.value.onclose = (e) => { state.connected = false; if (e.code !== 1000) state.error = "断开"; stopMicrophone(); };
    ws.value.onerror = () => { state.error = "连接失败"; };
  }

  function disconnect(): void {
    stopMicrophone();
    if (channelPollInterval) { clearInterval(channelPollInterval); channelPollInterval = null; }
    ws.value?.close(1000); ws.value = null;
    state.connected = false; state.tsClientId = 0; members.length = 0; channels.length = 0;
    for (const [, d] of remoteDecoders) d.close();
    remoteDecoders.clear(); remotePlayTimes.clear();
  }

  function handleMessage(msg: any): void {
    switch (msg.type) {
      case "connected":
        state.tsClientId = msg.tsClientId;
        if (msg.members) { members.length = 0; for (const m of msg.members) members.push(m); }
        requestChannels();
        startChannelPoll();
        break;
      case "memberEnter":
        if (!members.find((m) => m.id === msg.id)) members.push({ id: msg.id, nickname: msg.nickname, isSelf: msg.isSelf });
        break;
      case "memberLeave": { const idx = members.findIndex((m) => m.id === msg.id); if (idx >= 0) members.splice(idx, 1); break; }
      case "channelList": channels.length = 0; for (const ch of msg.channels) channels.push(ch); break;
      case "channelSwitched": requestChannels(); break;
      case "disconnected": state.connected = false; state.error = "TS 连接断开"; break;
      case "error": state.error = msg.message; break;
    }
  }

  function handleAudioFrame(data: Uint8Array): void {
    if (data.length < 4) return;
    const clientId = (data[1] << 8) | data[2];
    if (clientId === state.tsClientId) return;
    playAudioFrame(clientId, data.slice(3));
  }

  function sendCmd(cmd: Record<string, unknown>) {
    if (ws.value?.readyState === WebSocket.OPEN) ws.value.send(JSON.stringify(cmd));
  }
  let channelPollInterval: ReturnType<typeof setInterval> | null = null;
  function startChannelPoll() {
    if (channelPollInterval) return;
    channelPollInterval = setInterval(() => requestChannels(), 10000);
  }
  function requestChannels() { sendCmd({ type: "listChannels" }); }
  function switchChannel(channelId: string) { sendCmd({ type: "switchChannel", channelId }); }
  function setMicMode(m: "vox" | "ptt") { micMode.value = m; }
  function setPTT(p: boolean) { pttPressed = p; }
  function clearError() { state.error = ""; }

  return { ws, state, members, channels, micMode, connect, disconnect, requestChannels, switchChannel, setMicMode, setPTT, checkSupport, clearError };
}
