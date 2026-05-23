<template>
  <div class="web-client">
    <header class="header">
      <h1>WebSpeak</h1>
      <span class="subtitle">TeamSpeak 网页语音客户端</span>
    </header>

    <!-- Connection form -->
    <div v-if="!voiceState.connected" class="panel connect-panel">
      <div class="panel-title">连接到 TeamSpeak</div>

      <div v-if="browserError" class="error-box">
        {{ browserError }}
      </div>

      <div class="form-group">
        <label>服务器地址</label>
        <input v-model="serverUrl" placeholder="wss://your-server:3040" />
      </div>
      <div class="form-group">
        <label>昵称</label>
        <input v-model="nickname" placeholder="你的昵称" maxlength="30" />
      </div>
      <div class="form-group">
        <label>频道名（可选）</label>
        <input v-model="channel" placeholder="留空进入默认频道" />
      </div>
      <div class="form-group">
        <label>连接密钥</label>
        <input v-model="token" type="password" placeholder="服务器预设的 voiceToken" />
      </div>

      <div v-if="voiceState.error" class="error-box">{{ voiceState.error }}</div>

      <button
        :disabled="!nickname.trim() || !token.trim()"
        class="btn btn-primary"
        @click="doConnect"
      >
        连接
      </button>
    </div>

    <!-- Voice panel (connected) -->
    <div v-else class="panel voice-panel">
      <div class="status-bar">
        <span class="status-dot"></span>
        已连接
        <span class="client-id">#{{ voiceState.tsClientId }}</span>
      </div>

      <!-- Channel members -->
      <div class="members-section" v-if="members.length > 0">
        <div class="section-label">频道成员 ({{ members.length }})</div>
        <div class="member-list">
          <div
            v-for="m in members"
            :key="m.id"
            class="member-item"
            :class="{ self: m.isSelf }"
          >
            <span class="member-dot"></span>
            {{ m.nickname }}
            <span v-if="m.isSelf" class="self-tag">我</span>
            <span class="member-id">#{{ m.id }}</span>
          </div>
        </div>
      </div>

      <div v-if="!micActive" class="mic-prompt">
        <button class="btn btn-primary" @click="doStartMic">
          开启麦克风
        </button>
        <p class="hint">需要麦克风权限才能说话</p>
      </div>

      <div v-else class="ptt-area">
        <div class="ptt-status">{{ isTalking ? '正在说话...' : '按住按钮说话' }}</div>
        <button
          class="ptt-button"
          :class="{ active: isTalking }"
          @mousedown="startTalking"
          @mouseup="stopTalking"
          @mouseleave="stopTalking"
          @touchstart.prevent="startTalking"
          @touchend.prevent="stopTalking"
        >
          {{ isTalking ? '松开发送' : '按住说话' }}
        </button>
      </div>

      <div v-if="voiceState.error" class="error-box">{{ voiceState.error }}</div>

      <button class="btn btn-secondary" @click="doDisconnect">
        断开连接
      </button>
    </div>

    <footer class="footer">
      <span>Opus 全链路 · Chrome/Edge 94+ · HTTPS 必需</span>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { useVoiceWebSocket } from "../composables/useVoiceWebSocket.js";

const { state: voiceState, members, connect, disconnect, startMicrophone, stopMicrophone, checkSupport, clearError } = useVoiceWebSocket();

const serverUrl = ref("wss://" + location.host);
const nickname = ref("");
const channel = ref("");
const token = ref("");
const micActive = ref(false);
const isTalking = ref(false);
const browserError = ref("");

onMounted(() => {
  const err = checkSupport();
  if (err) browserError.value = err;
});

onUnmounted(() => {
  disconnect();
});

async function doConnect() {
  clearError();
  connect(serverUrl.value, token.value, channel.value, nickname.value.trim());
}

async function doStartMic() {
  try {
    await startMicrophone();
    micActive.value = true;
  } catch (e: any) {
    voiceState.error = "麦克风启动失败: " + (e.message || e);
  }
}

function startTalking() { isTalking.value = true; }
function stopTalking() { isTalking.value = false; }

function doDisconnect() {
  micActive.value = false;
  isTalking.value = false;
  disconnect();
}
</script>

<style scoped>
.web-client {
  max-width: 440px;
  margin: 0 auto;
  padding: 24px 16px;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
.header { text-align: center; margin-bottom: 24px; }
.header h1 { font-size: 28px; color: #e8e8e8; letter-spacing: 1px; }
.subtitle { font-size: 13px; color: #888; }
.panel { background: #16213e; border-radius: 12px; padding: 24px; flex: 1; }
.panel-title { font-size: 16px; font-weight: 600; margin-bottom: 20px; color: #ccc; }
.form-group { margin-bottom: 14px; }
.form-group label { display: block; font-size: 12px; color: #888; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
.form-group input {
  width: 100%; padding: 10px 12px; border: 1px solid #2a3a5c; border-radius: 8px;
  background: #0f3460; color: #e0e0e0; font-size: 14px; outline: none; transition: border-color 0.2s;
}
.form-group input:focus { border-color: #4a90d9; }
.btn {
  width: 100%; padding: 12px; border: none; border-radius: 8px; font-size: 15px;
  font-weight: 600; cursor: pointer; transition: background 0.2s, transform 0.1s; margin-top: 8px;
}
.btn:active { transform: scale(0.98); }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-primary { background: #2563eb; color: #fff; }
.btn-primary:hover:not(:disabled) { background: #1d4ed8; }
.btn-secondary { background: #374151; color: #ccc; margin-top: 16px; }
.btn-secondary:hover { background: #4b5563; }

.status-bar { display: flex; align-items: center; gap: 8px; font-size: 14px; margin-bottom: 16px; color: #4ade80; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; animation: pulse 2s infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
.client-id { margin-left: auto; font-size: 12px; color: #888; }

.members-section { margin-bottom: 20px; }
.section-label { font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
.member-list { display: flex; flex-direction: column; gap: 4px; }
.member-item {
  display: flex; align-items: center; gap: 6px; padding: 6px 10px;
  background: #0f3460; border-radius: 6px; font-size: 13px; color: #ccc;
}
.member-item.self { background: #1a3a6a; color: #fff; }
.member-dot { width: 6px; height: 6px; border-radius: 50%; background: #4ade80; flex-shrink: 0; }
.self-tag { font-size: 10px; background: #2563eb; color: #fff; padding: 1px 5px; border-radius: 3px; }
.member-id { margin-left: auto; font-size: 11px; color: #666; }

.mic-prompt { text-align: center; margin: 24px 0; }
.hint { font-size: 12px; color: #666; margin-top: 8px; }
.ptt-area { text-align: center; margin: 20px 0 30px; }
.ptt-status { font-size: 14px; color: #aaa; margin-bottom: 16px; }
.ptt-button {
  width: 140px; height: 140px; border-radius: 50%; border: 3px solid #4a5568;
  background: #1a2744; color: #ccc; font-size: 16px; cursor: pointer;
  user-select: none; touch-action: manipulation; transition: all 0.15s;
}
.ptt-button.active { border-color: #ef4444; background: #3b1a1a; color: #fca5a5; transform: scale(1.05); }

.error-box { background: #3b1a1a; color: #fca5a5; padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 14px; border: 1px solid #5c2020; }
.footer { text-align: center; margin-top: 24px; font-size: 11px; color: #555; }
</style>
