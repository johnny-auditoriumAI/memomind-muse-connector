/**
 * One listening turn per WebSocket connection (the plugin reconnects per
 * turn; conversation memory lives in llm/history.js, keyed by the plugin's
 * conversationId):
 *
 *   start          -> Opus decoder + STT stream; state "listening"
 *   audio chunks   -> split -> decode -> stt.write (30 s cap, then auto-finish)
 *   stop           -> state "transcribing"; transcript{final:true}
 *                     -> state "thinking"; reply{final:false}... reply{final:true}
 *                     -> state "idle"
 *                  Assistant-route reply still pending after its timeout:
 *                     -> reply{final:false, "Still asking <assistant name>..."}; state "waiting"
 *                     (socket stays open; the late reply arrives as reply{final:true})
 *   socket close   -> abort whatever is in flight
 *
 * Downstream message shapes are documented in ../plugin/audio-protocol.js.
 */
import { createOpusDecoder } from './audio/opus.js';
import { pcmDurationMs } from './audio/wav.js';
import { describeClaudeError } from './llm/claude.js';

export const EMPTY_TRANSCRIPT_REPLY = "I didn't catch that. Try again?";

export function createAssistantSession({ send, log, config, createStt, assistant, takeQueuedReplies = () => [] }) {
  /** idle | listening | processing | closed */
  let phase = 'idle';
  let decoder;
  let stt;
  let conversationId;
  let audioBytes = 0;
  let chunkErrors = 0;
  let turnAbort;
  let turnStartedAt;
  let waitingForLateReply = false;

  function cleanupAudio() {
    decoder?.close();
    decoder = undefined;
  }

  async function finishTurn(reason) {
    if (phase !== 'listening') return;
    phase = 'processing';
    const sttStream = stt;
    stt = undefined;
    const audioMs = decoder ? Math.round(pcmDurationMs(audioBytes, decoder.sampleRate, decoder.channels)) : 0;
    cleanupAudio();
    turnAbort = new AbortController();
    const signal = turnAbort.signal;
    const timing = { stop: Date.now() };
    log('turn.finish', { reason, audioMs, chunkErrors });

    try {
      send({ type: 'state', value: 'transcribing' });
      const transcript = await sttStream.finish();
      timing.transcript = Date.now();
      if (signal.aborted) return;
      send({ type: 'transcript', text: transcript, final: true });
      log('stt.done', { ms: timing.transcript - timing.stop, transcript });

      if (!transcript) {
        send({ type: 'reply', text: EMPTY_TRANSCRIPT_REPLY, final: true });
        return;
      }

      send({ type: 'state', value: 'thinking' });
      let partial = '';
      let lastSentAt = 0;
      let pendingTimer;
      const flushPartial = () => {
        pendingTimer = undefined;
        lastSentAt = Date.now();
        if (!signal.aborted) send({ type: 'reply', text: partial, final: false });
      };
      const result = await assistant.reply({
        conversationId,
        text: transcript,
        signal,
        send,
        onDelta(delta) {
          timing.firstDelta ??= Date.now();
          partial += delta;
          if (pendingTimer) return;
          const wait = config.replyThrottleMs - (Date.now() - lastSentAt);
          if (wait <= 0) flushPartial();
          else pendingTimer = setTimeout(flushPartial, wait);
        },
      });
      clearTimeout(pendingTimer);
      if (signal.aborted) return;
      timing.done = Date.now();
      if (result.pending) {
        // The assistant route is still working on it: show the holding
        // text, keep the socket open, and let the late reply arrive as the
        // final one.
        send({ type: 'reply', text: result.text, final: false });
        send({ type: 'state', value: 'waiting' });
        waitingForLateReply = true;
      } else {
        send({ type: 'reply', text: result.text || EMPTY_TRANSCRIPT_REPLY, final: true });
      }
      log('turn.timing', {
        sttMs: timing.transcript - timing.stop,
        firstReplyMs: timing.firstDelta ? timing.firstDelta - timing.stop : null,
        totalMs: timing.done - timing.stop,
        stopReason: result.stopReason,
      });
    } catch (error) {
      if (signal.aborted) return;
      const message = describeTurnError(error);
      log('turn.error', { message, error: error.message, name: error.name });
      send({ type: 'error', message });
    } finally {
      sttStream.close();
      turnAbort = undefined;
      if (phase === 'processing') {
        phase = 'idle';
        // "idle" after "waiting" would tell the plugin the turn is over.
        if (!waitingForLateReply) send({ type: 'state', value: 'idle' });
      }
    }
  }

  return {
    onStart(startMessage) {
      if (phase === 'listening' || phase === 'processing') {
        send({ type: 'error', message: 'A turn is already in progress' });
        return;
      }
      const sampleRate = Number(startMessage.sampleRate) || 16000;
      const channels = Number(startMessage.channels) || 1;
      if (startMessage.codec && startMessage.codec !== 'opus') {
        send({ type: 'error', message: `Unsupported codec ${startMessage.codec}` });
        return;
      }
      try {
        decoder = createOpusDecoder({ sampleRate, channels });
      } catch (error) {
        send({ type: 'error', message: error.message });
        return;
      }
      conversationId = typeof startMessage.conversationId === 'string' && startMessage.conversationId.length <= 64
        ? startMessage.conversationId
        : `connection-${Date.now()}`;
      stt = createStt({ sampleRate, channels });
      audioBytes = 0;
      chunkErrors = 0;
      turnStartedAt = Date.now();
      waitingForLateReply = false;
      phase = 'listening';
      log('turn.start', { conversationId, sampleRate, channels });
      send({ type: 'state', value: 'listening' });
      // Assistant-route replies that arrived after an earlier turn's socket closed.
      for (const queued of takeQueuedReplies(conversationId)) {
        log('assistant-route.queued-shown', { conversationId });
        send({ ...queued, text: `${config.assistantName} replied: ${queued.text}`, final: false });
      }
    },

    onAudioChunk(meta, bytes) {
      if (phase !== 'listening') return;
      let pcm;
      try {
        pcm = decoder.decodeChunk(meta, bytes);
      } catch (error) {
        chunkErrors += 1;
        if (chunkErrors === 1) log('audio.chunk-error', { sequence: meta.sequence, message: error.message });
        return;
      }
      if (meta.discontinuity) log('audio.discontinuity', { sequence: meta.sequence });
      audioBytes += pcm.length;
      stt.write(pcm);
      if (pcmDurationMs(audioBytes, decoder.sampleRate, decoder.channels) >= config.maxUtteranceMs) {
        void finishTurn('max-duration');
      }
    },

    onStop() {
      void finishTurn('stop');
    },

    onClose() {
      if (phase === 'listening') log('turn.abandoned', { afterMs: Date.now() - turnStartedAt });
      phase = 'closed';
      turnAbort?.abort();
      stt?.close();
      stt = undefined;
      cleanupAudio();
    },
  };
}

function describeTurnError(error) {
  if (error.name === 'TimeoutError') return 'Speech recognition timed out';
  if (error.cause?.code === 'ECONNREFUSED' || /whisper/i.test(error.message)) {
    return 'Speech recognition is not running';
  }
  return describeClaudeError(error) ?? 'Request cancelled';
}
