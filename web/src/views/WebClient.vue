<template>
  <div class="web-client" @keydown="onKeyDown" @keyup="onKeyUp" tabindex="0" ref="rootEl">
    <header class="header">
      <div class="logo-icon">W</div>
      <h1>WebSpeak</h1>
      <span class="subtitle">TeamSpeak 网页网关</span>
    </header>

    <!-- Login Panel -->
    <div v-if="!voiceState.connected" class="login-card">
      <div class="login-icon">🎙️</div>
      <div class="panel-title">加入语音频道</div>
      <div v-if="noToken" class="error-box">
        <span class="err-icon">!</span> 缺少连接密钥，请使用完整链接
      </div>
      <div v-if="voiceState.error" class="error-box">
        <span class="err-icon">!</span> {{ voiceState.error }}
      </div>
      <div v-if="browserError" class="error-box">
        <span class="err-icon">!</span> {{ browserError }}
      </div>

      <div class="form-group">
        <label>昵称</label>
        <div class="input-wrap">
          <span class="input-icon">@</span>
          <input v-model="nickname" placeholder="输入你的昵称" maxlength="30" @keyup.enter="doConnect" />
        </div>
      </div>
      <div class="form-group">
        <label>目标频道 <em>(可选)</em></label>
        <div class="input-wrap">
          <span class="input-icon">#</span>
          <input v-model="channel" placeholder="留空进入默认频道" @keyup.enter="doConnect" />
        </div>
      </div>
      <button :disabled="!nickname.trim() || noToken" class="btn-connect" @click="doConnect">
        <span>连接服务器</span>
      </button>
    </div>

    <!-- Connected View -->
    <div v-else class="connected-layout">
      <div class="top-bar">
        <div class="status-group">
          <span class="status-dot"></span>
          <span class="status-text">在线</span>
        </div>
        <span class="top-nick">{{ nickname }}</span>
        <div class="top-actions">
          <div class="mic-toggle">
            <button :class="micMode === 'vox' ? 'active' : ''" @click="setMicMode('vox')">自由麦</button>
            <button :class="micMode === 'ptt' ? 'active' : ''" @click="setMicMode('ptt')">按键说话</button>
          </div>
          <button class="btn-icon share" @click="doShare" title="复制邀请链接">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
          </button>
          <button class="btn-icon disconnect" @click="doDisconnect" title="断开连接">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </button>
        </div>
      </div>

      <div class="channel-panel">
        <div class="section-title" @click="requestChannels()">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          频道与成员
          <span class="refresh-hint">点击刷新</span>
        </div>

        <template v-for="ch in channelTree" :key="ch.id">
          <div class="channel-item" :style="{ paddingLeft: (ch.depth * 16 + 12) + 'px' }" @click="doSwitchChannel(ch.id)">
            <svg class="ch-arrow" width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l8 7-8 7z"/></svg>
            <span class="ch-hash">#</span>
            <span class="ch-name">{{ ch.name }}</span>
          </div>
          <div v-for="m in ch.members" :key="m.id" class="member-item" :style="{ paddingLeft: (ch.depth * 16 + 36) + 'px' }">
            <span class="m-avatar" :class="{ self: m.isSelf }" :style="avatarStyle(m.nickname, m.isSelf)">{{ m.nickname[0] }}</span>
            <span class="m-name" :class="{ self: m.isSelf }">{{ m.nickname }}</span>
            <span v-if="m.isSelf" class="m-tag">你</span>
            <input v-if="!m.isSelf" type="range" min="0" max="400" :value="(volumes[m.id] ?? 1) * 100" @input="onVolInput(m.id, $event)" class="vol-slider" title="音量" />
          </div>
        </template>
        <div v-if="channelTree.length === 0" class="loading-state">
          <span class="spinner"></span>
          正在加载频道列表...
        </div>
      </div>

      <div v-if="micMode === 'ptt'" class="ptt-bar" :class="{ active: pttActive }">
        <span class="ptt-dot"></span>
        {{ pttActive ? '正在发送语音' : '按住 空格键 说话' }}
      </div>
      <div v-if="voiceState.error" class="error-box"><span class="err-icon">!</span> {{ voiceState.error }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from "vue";
import { useVoiceWebSocket } from "../composables/useVoiceWebSocket.js";

const { state: voiceState, members, channels, micMode, volumes, setVolume, connect, disconnect, requestChannels, switchChannel, setMicMode, setPTT, checkSupport, clearError } = useVoiceWebSocket();

const channelTree = computed(() => {
  const list = [...channels];
  const getPath = (ch: { id: string; parentID: string; name: string }): string => {
    if (ch.parentID === "0" || !ch.parentID) return "/" + ch.id;
    const p = channels.find(c => c.id === ch.parentID);
    return (p ? getPath(p) : "") + "/" + ch.id;
  };
  list.sort((a, b) => getPath(a).localeCompare(getPath(b)));
  return list.map(ch => ({ ...ch, depth: getPath(ch).split("/").length - 2 }));
});

const qs = new URLSearchParams(location.search);
const nickname = ref("");
const channel = ref(qs.get("channel") ?? "");
const token = qs.get("token") ?? "";
const noToken = !token;

const pttActive = ref(false);
const browserError = ref("");
const rootEl = ref<HTMLElement | null>(null);

onMounted(() => { const e = checkSupport(); if (e) browserError.value = e; });
onUnmounted(() => { disconnect(); });

function doConnect() {
  clearError();
  connect(token, channel.value.trim(), nickname.value.trim());
  nextTick(() => rootEl.value?.focus());
}
function doDisconnect() { disconnect(); }
function doSwitchChannel(chId: string) { switchChannel(chId); }
function onVolInput(clientId: number, e: Event) { setVolume(clientId, Number((e.target as HTMLInputElement).value) / 100); }

function doShare() {
  const url = new URL(location.href);
  if (channel.value) url.searchParams.set("channel", channel.value);
  navigator.clipboard.writeText(url.toString()).then(() => alert("链接已复制")).catch(() => prompt("复制:", url.toString()));
}

const avatarColors = ["#6366f1","#8b5cf6","#ec4899","#f43f5e","#f97316","#eab308","#22c55e","#14b8a6","#06b6d4","#3b82f6"];
function avatarStyle(name: string, isSelf?: boolean) {
  if (isSelf) return { background: "linear-gradient(135deg, #6366f1, #8b5cf6)" };
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const color = avatarColors[Math.abs(hash) % avatarColors.length];
  return { background: color };
}

function onKeyDown(e: KeyboardEvent) {
  if (e.code === "Space" && micMode.value === "ptt" && !pttActive.value) { e.preventDefault(); pttActive.value = true; setPTT(true); }
}
function onKeyUp(e: KeyboardEvent) {
  if (e.code === "Space" && micMode.value === "ptt") { pttActive.value = false; setPTT(false); }
}
</script>

<style scoped>
/* ===== Base & Layout ===== */
.web-client {
  max-width: 460px; margin: 0 auto; padding: 20px 16px; min-height: 100vh;
  outline: none; display: flex; flex-direction: column;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: linear-gradient(180deg, #0b0e1a 0%, #111627 100%);
}

/* ===== Header ===== */
.header { text-align: center; margin-bottom: 24px; }
.logo-icon {
  width: 44px; height: 44px; border-radius: 14px;
  background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
  color: #fff; font-size: 22px; font-weight: 800; line-height: 44px;
  margin: 0 auto 12px; box-shadow: 0 4px 20px rgba(99,102,241,0.35);
}
.header h1 { font-size: 26px; font-weight: 700; color: #f1f5f9; margin: 0; letter-spacing: -0.5px; }
.subtitle { font-size: 12px; color: #64748b; margin-top: 4px; display: block; }

/* ===== Login Card ===== */
.login-card {
  background: linear-gradient(145deg, #1a1f35 0%, #151a2e 100%);
  border: 1px solid #1e2745; border-radius: 16px; padding: 28px 24px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.4);
}
.login-icon { text-align: center; font-size: 36px; margin-bottom: 8px; }
.panel-title { text-align: center; font-size: 18px; font-weight: 600; color: #e2e8f0; margin-bottom: 20px; }

/* ===== Form ===== */
.form-group { margin-bottom: 14px; }
.form-group label { display: block; font-size: 11px; color: #94a3b8; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 500; }
.form-group label em { text-transform: none; color: #64748b; font-style: normal; }
.input-wrap { position: relative; display: flex; align-items: center; }
.input-icon {
  position: absolute; left: 12px; color: #4a5568; font-size: 14px; font-weight: 600;
  pointer-events: none; z-index: 1;
}
.input-wrap input {
  width: 100%; padding: 11px 12px 11px 30px; border: 1px solid #1e2745;
  border-radius: 10px; background: #0f1425; color: #e2e8f0; font-size: 14px;
  outline: none; transition: border-color 0.2s, box-shadow 0.2s;
}
.input-wrap input:focus {
  border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,0.15);
}
.input-wrap input::placeholder { color: #475569; }

.btn-connect {
  width: 100%; padding: 13px; border: none; border-radius: 10px;
  font-size: 15px; font-weight: 600; cursor: pointer; margin-top: 6px; color: #fff;
  background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
  box-shadow: 0 4px 16px rgba(99,102,241,0.3);
  transition: transform 0.15s, box-shadow 0.15s, opacity 0.2s;
}
.btn-connect:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 24px rgba(99,102,241,0.45); }
.btn-connect:active:not(:disabled) { transform: translateY(0); }
.btn-connect:disabled { opacity: 0.35; cursor: not-allowed; }

/* ===== Connected Layout ===== */
.connected-layout { flex: 1; display: flex; flex-direction: column; gap: 10px; }

/* ===== Top Bar ===== */
.top-bar {
  display: flex; align-items: center; gap: 10px;
  background: #151a2e; border: 1px solid #1e2745; border-radius: 12px;
  padding: 10px 14px; font-size: 13px;
}
.status-group { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.status-dot {
  width: 8px; height: 8px; border-radius: 50%; background: #22c55e;
  box-shadow: 0 0 8px rgba(34,197,94,0.5); flex-shrink: 0;
}
.status-text { color: #a1a1aa; font-size: 12px; font-weight: 500; }
.top-nick { color: #e2e8f0; font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.top-actions { margin-left: auto; display: flex; align-items: center; gap: 6px; flex-shrink: 0; }

.mic-toggle { display: flex; background: #0f1425; border-radius: 6px; padding: 2px; }
.mic-toggle button {
  padding: 4px 10px; border: none; border-radius: 5px; background: transparent;
  color: #64748b; font-size: 11px; font-weight: 500; cursor: pointer;
  transition: all 0.15s;
}
.mic-toggle button.active { background: #6366f1; color: #fff; }

.btn-icon {
  width: 30px; height: 30px; border-radius: 7px; border: 1px solid #1e2745;
  background: #0f1425; color: #94a3b8; display: flex; align-items: center;
  justify-content: center; cursor: pointer; transition: all 0.15s;
}
.btn-icon:hover { background: #1e2745; color: #e2e8f0; }
.btn-icon.disconnect:hover { background: #3b1a1a; border-color: #7f1d1d; color: #fca5a5; }
.btn-icon.share:hover { background: #052e16; border-color: #166534; color: #6ee7b7; }

/* ===== Channel Panel ===== */
.channel-panel {
  flex: 1; background: #151a2e; border: 1px solid #1e2745;
  border-radius: 12px; padding: 14px; overflow-y: auto;
}

.section-title {
  display: flex; align-items: center; gap: 6px;
  font-size: 11px; color: #64748b; text-transform: uppercase;
  letter-spacing: 0.5px; font-weight: 600; margin-bottom: 10px;
  cursor: pointer; user-select: none; transition: color 0.15s;
}
.section-title:hover { color: #94a3b8; }
.refresh-hint { margin-left: auto; font-size: 10px; text-transform: none; color: #475569; opacity: 0; transition: opacity 0.15s; }
.section-title:hover .refresh-hint { opacity: 1; }

/* ===== Channel Items ===== */
.channel-item {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px; font-size: 13px; color: #cbd5e1;
  cursor: pointer; border-radius: 6px; white-space: nowrap;
  transition: background 0.1s;
}
.channel-item:hover { background: rgba(99,102,241,0.1); }
.ch-arrow { color: #475569; flex-shrink: 0; transition: transform 0.15s; }
.channel-item:hover .ch-arrow { transform: translateX(2px); color: #6366f1; }
.ch-hash { color: #6366f1; font-weight: 700; flex-shrink: 0; }
.ch-name { overflow: hidden; text-overflow: ellipsis; }

/* ===== Member Items ===== */
.member-item {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 10px; font-size: 13px; color: #94a3b8;
  border-radius: 6px; transition: background 0.1s;
}
.member-item:hover { background: rgba(255,255,255,0.02); }

.m-avatar {
  width: 24px; height: 24px; border-radius: 7px; flex-shrink: 0;
  color: #fff; font-size: 11px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  text-transform: uppercase;
}
.m-avatar.self { box-shadow: 0 0 10px rgba(99,102,241,0.4); }

.m-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.m-name.self { color: #c7d2fe; font-weight: 500; }

.m-tag {
  font-size: 10px; padding: 1px 6px; border-radius: 4px;
  background: rgba(99,102,241,0.2); color: #818cf8; font-weight: 600;
}

/* ===== Volume Slider ===== */
.vol-slider {
  width: 64px; height: 4px; -webkit-appearance: none; appearance: none;
  background: #1e2745; border-radius: 2px; outline: none; cursor: pointer;
  flex-shrink: 0; transition: background 0.15s;
}
.vol-slider:hover { background: #2a3565; }
.vol-slider::-webkit-slider-thumb {
  -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%;
  background: #818cf8; cursor: pointer; box-shadow: 0 1px 4px rgba(0,0,0,0.4);
  transition: transform 0.1s, background 0.1s;
}
.vol-slider::-webkit-slider-thumb:hover { transform: scale(1.2); background: #a5b4fc; }
.vol-slider::-moz-range-thumb {
  width: 12px; height: 12px; border-radius: 50%; border: none;
  background: #818cf8; cursor: pointer;
}

/* ===== Loading State ===== */
.loading-state {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  padding: 24px; color: #475569; font-size: 13px;
}
.spinner {
  width: 18px; height: 18px; border: 2px solid #1e2745; border-top-color: #6366f1;
  border-radius: 50%; animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ===== PTT Bar ===== */
.ptt-bar {
  text-align: center; padding: 10px; border-radius: 10px;
  background: #151a2e; border: 1px solid #1e2745;
  font-size: 13px; color: #64748b; display: flex; align-items: center;
  justify-content: center; gap: 8px; transition: all 0.2s;
}
.ptt-bar.active { border-color: #6366f1; color: #c7d2fe; background: rgba(99,102,241,0.08); }
.ptt-dot {
  width: 8px; height: 8px; border-radius: 50%; background: #475569; transition: background 0.2s;
}
.ptt-bar.active .ptt-dot { background: #22c55e; box-shadow: 0 0 6px rgba(34,197,94,0.5); }

/* ===== Error ===== */
.error-box {
  background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.25);
  color: #fca5a5; padding: 10px 14px; border-radius: 10px;
  font-size: 13px; display: flex; align-items: flex-start; gap: 8px;
}
.err-icon {
  width: 18px; height: 18px; border-radius: 50%; background: #ef4444;
  color: #fff; font-size: 11px; font-weight: 700; text-align: center;
  line-height: 18px; flex-shrink: 0;
}

/* ===== Scrollbar ===== */
.channel-panel::-webkit-scrollbar { width: 4px; }
.channel-panel::-webkit-scrollbar-track { background: transparent; }
.channel-panel::-webkit-scrollbar-thumb { background: #1e2745; border-radius: 2px; }
.channel-panel::-webkit-scrollbar-thumb:hover { background: #2a3565; }
</style>
