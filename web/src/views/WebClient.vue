<template>
  <div class="web-client" @keydown="onKeyDown" @keyup="onKeyUp" tabindex="0" ref="rootEl">
    <header class="header">
      <h1>WebSpeak</h1>
      <span class="subtitle">TeamSpeak 网页客户端</span>
    </header>

    <!-- Connect form -->
    <div v-if="!voiceState.connected" class="panel">
      <div class="panel-title">加入服务器</div>
      <div v-if="voiceState.error" class="error-box">{{ voiceState.error }}</div>
      <div v-if="needsToken" class="error-box">
        缺少连接密钥。请使用完整链接: <br/>
        <code>{{ location.origin }}/?token=你的密钥</code>
      </div>
      <div v-if="browserError" class="error-box">{{ browserError }}</div>

      <template v-if="!needsToken">
        <div class="form-row">
          <div class="form-group" style="flex:3">
            <label>TeamSpeak 服务器 IP</label>
            <input v-model="tsHost" placeholder="127.0.0.1" />
          </div>
          <div class="form-group" style="flex:1">
            <label>端口</label>
            <input v-model="tsPort" placeholder="9987" />
          </div>
        </div>
        <div class="form-group">
          <label>昵称</label>
          <input v-model="nickname" placeholder="你的昵称" maxlength="30" />
        </div>
        <div class="form-group">
          <label>频道名（可选）</label>
          <input v-model="channel" placeholder="留空进入默认频道" />
        </div>
        <button :disabled="!tsHost.trim() || !nickname.trim()" class="btn btn-primary" @click="doConnect">
          连接
        </button>
      </template>
    </div>

    <!-- Connected -->
    <div v-else class="connected-layout">
      <div class="top-bar">
        <span class="status-dot"></span>
        <span>{{ tsHost }}</span>
        <span class="mode-switch">
          <button :class="{ active: micMode === 'vox' }" @click="setMicMode('vox')">自由麦</button>
          <button :class="{ active: micMode === 'ptt' }" @click="setMicMode('ptt')">按键说话</button>
        </span>
        <button class="btn-disconnect" @click="doDisconnect">断开</button>
      </div>

      <div class="main-content">
        <div class="channel-panel">
          <div class="section-title" @click="requestChannels()">频道 ↻</div>
          <div v-for="ch in channelTree" :key="ch.id" class="channel-item"
               :style="{ paddingLeft: (ch.depth * 14 + 8) + 'px' }"
               @click="doSwitchChannel(ch.id)">
            <span class="ch-icon">{{ ch.depth > 0 ? '└' : '#' }}</span> {{ ch.name }}
          </div>
        </div>
        <div class="member-panel">
          <div class="section-title">成员 ({{ members.length }})</div>
          <div v-for="m in members" :key="m.id" class="member-item" :class="{ self: m.isSelf }">
            <span class="m-dot"></span> {{ m.nickname }}
            <span v-if="m.isSelf" class="self-tag">我</span>
          </div>
        </div>
      </div>

      <div v-if="micMode === 'ptt'" class="ptt-bar">
        {{ pttActive ? '🔊 正在发送' : '按住 空格键 说话' }}
      </div>

      <div v-if="voiceState.error" class="error-box" style="margin:8px">{{ voiceState.error }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from "vue";
import { useVoiceWebSocket } from "../composables/useVoiceWebSocket.js";

const { state: voiceState, members, channels, micMode, connect, disconnect, requestChannels, switchChannel, setMicMode, setPTT, checkSupport, clearError } = useVoiceWebSocket();

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

// URL params
const qs = new URLSearchParams(location.search);
const tsHost = ref(qs.get("ts") ?? "127.0.0.1");
const tsPort = ref("9987");
const nickname = ref("");
const channel = ref(qs.get("channel") ?? "");
const token = qs.get("token") ?? "";

const pttActive = ref(false);
const browserError = ref("");
const rootEl = ref<HTMLElement | null>(null);
const needsToken = !token;

onMounted(() => { const e = checkSupport(); if (e) browserError.value = e; });
onUnmounted(() => { disconnect(); });

function doConnect() {
  clearError();
  connect(token, tsHost.value.trim(), tsPort.value.trim(), channel.value.trim(), nickname.value.trim());
  nextTick(() => rootEl.value?.focus());
}
function doDisconnect() { disconnect(); }
function doSwitchChannel(chId: string) { switchChannel(chId); }

function onKeyDown(e: KeyboardEvent) {
  if (e.code === "Space" && micMode.value === "ptt" && !pttActive.value) {
    e.preventDefault(); pttActive.value = true; setPTT(true);
  }
}
function onKeyUp(e: KeyboardEvent) {
  if (e.code === "Space" && micMode.value === "ptt") {
    pttActive.value = false; setPTT(false);
  }
}
</script>

<style scoped>
.web-client { max-width: 440px; margin: 0 auto; padding: 16px; min-height: 100vh; outline: none; display: flex; flex-direction: column; }
.header { text-align: center; margin-bottom: 16px; }
.header h1 { font-size: 24px; color: #e8e8e8; }
.subtitle { font-size: 12px; color: #888; }
.panel { background: #16213e; border-radius: 12px; padding: 24px; }
.panel-title { font-size: 16px; font-weight: 600; margin-bottom: 16px; color: #ccc; }
.form-group { margin-bottom: 12px; }
.form-group label { display: block; font-size: 11px; color: #888; margin-bottom: 4px; text-transform: uppercase; }
.form-group input { width: 100%; padding: 10px 12px; border: 1px solid #2a3a5c; border-radius: 8px; background: #0f3460; color: #e0e0e0; font-size: 14px; outline: none; }
.form-group input:focus { border-color: #4a90d9; }
.form-row { display: flex; gap: 10px; }
.btn { width: 100%; padding: 12px; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; margin-top: 4px; }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-primary { background: #2563eb; color: #fff; }
.connected-layout { flex: 1; display: flex; flex-direction: column; gap: 8px; }
.top-bar { display: flex; align-items: center; gap: 10px; background: #16213e; border-radius: 8px; padding: 10px 16px; font-size: 13px; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; flex-shrink: 0; }
.mode-switch { margin-left: auto; display: flex; gap: 4px; }
.mode-switch button { padding: 4px 10px; border: 1px solid #2a3a5c; border-radius: 4px; background: transparent; color: #888; font-size: 12px; cursor: pointer; }
.mode-switch button.active { background: #2563eb; color: #fff; border-color: #2563eb; }
.btn-disconnect { padding: 4px 10px; background: #374151; border: none; border-radius: 4px; color: #ccc; font-size: 12px; cursor: pointer; }
.main-content { display: flex; gap: 8px; flex: 1; min-height: 0; }
.channel-panel { flex: 1; background: #16213e; border-radius: 8px; padding: 12px; overflow-y: auto; }
.channel-item { padding: 4px 8px; font-size: 13px; color: #ccc; cursor: pointer; border-radius: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.channel-item:hover { background: #1a3a6a; }
.ch-icon { color: #666; margin-right: 4px; }
.member-panel { flex: 1; background: #16213e; border-radius: 8px; padding: 12px; overflow-y: auto; }
.section-title { font-size: 11px; color: #888; text-transform: uppercase; margin-bottom: 8px; cursor: pointer; }
.member-item { display: flex; align-items: center; gap: 6px; padding: 4px 8px; font-size: 13px; color: #ccc; }
.member-item.self { color: #fff; }
.m-dot { width: 6px; height: 6px; border-radius: 50%; background: #4ade80; flex-shrink: 0; }
.self-tag { font-size: 10px; background: #2563eb; color: #fff; padding: 1px 4px; border-radius: 3px; }
.ptt-bar { text-align: center; padding: 8px; background: #16213e; border-radius: 8px; font-size: 13px; color: #aaa; }
.error-box { background: #3b1a1a; color: #fca5a5; padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 12px; }
</style>
