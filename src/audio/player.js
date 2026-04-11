import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  VoiceConnectionStatus,
  entersState,
  NoSubscriberBehavior
} from '@discordjs/voice';
import { ActivityType } from 'discord.js';
import { Mixer } from './mixer.js';
import { logger } from '../logger.js';

/**
 * guildId -> session
 * session = {
 *   connection, player, mixer, channelId,
 *   playing: Map<sourceId, { name, userId, startedAt }>,
 *   cleanupScheduled,
 *   pausedAt: number|null,
 *   pausedBy: string|null,
 *   pauseTimer: NodeJS.Timeout|null,
 *   client: Client
 * }
 */
const sessions = new Map();

function updateActivity(client) {
  if (!client || !client.user) return;

  let latestSound = null;
  let latestTime = 0;
  let activeChannelId = null;

  for (const session of sessions.values()) {
    if (session.pausedAt) continue;
    for (const entry of session.playing.values()) {
      if (entry.startedAt > latestTime) {
        latestTime = entry.startedAt;
        latestSound = entry.name;
        activeChannelId = session.channelId;
      }
    }
  }

  if (latestSound && activeChannelId) {
    const channel = client.channels.cache.get(activeChannelId);
    const channelName = channel ? channel.name : 'Unknown';
    client.user.setActivity({
      name: 'Custom Status',
      state: `🔊 Playing ${latestSound} in ${channelName}`,
      type: ActivityType.Custom
    });
  } else {
    client.user.setActivity({
      name: 'Custom Status',
      state: '💤 Playing nothing',
      type: ActivityType.Custom
    });
  }
}

// Idle disconnect after this long while paused.
const PAUSE_IDLE_MS = 2 * 60 * 1000;

export function getSession(guildId) {
  return sessions.get(guildId);
}

/**
 * Play a sound in the given voice channel. Creates a session if none exists.
 * If a session exists in a different channel, the caller is expected to have
 * already validated that (either same channel, or admin override). Admin
 * override should call stopSession(guildId) first, then call playSound again.
 */
export async function playSound(guild, voiceChannel, soundFilePath, soundName, userId) {
  let session = sessions.get(guild.id);

  if (!session) {
    session = await createSession(guild, voiceChannel);
  }

  return new Promise((resolve, reject) => {
    const sourceId = session.mixer.addSource(soundFilePath, () => {
      session.playing.delete(sourceId);
      logger.ok('sound finished', { guildId: guild.id, sound: soundName, userId });
      updateActivity(guild.client);
    });

    if (sourceId === null) {
      return reject(new Error('Mixer is destroyed'));
    }

    session.playing.set(sourceId, {
      name: soundName,
      userId,
      startedAt: Date.now()
    });

    logger.ok('sound playing', {
      guildId: guild.id,
      sound: soundName,
      userId,
      overlapping: session.playing.size
    });

    updateActivity(guild.client);

    resolve({ sourceId, overlapping: session.playing.size });
  });
}

async function createSession(guild, voiceChannel) {
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
  } catch (err) {
    try { connection.destroy(); } catch {}
    logger.error('voice connection failed', { guildId: guild.id, err: err.message });
    throw new Error('Could not connect to voice channel');
  }

  const mixer = new Mixer();
  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Pause
    }
  });

  const resource = createAudioResource(mixer, {
    inputType: StreamType.Raw,
    inlineVolume: false
  });

  player.play(resource);
  connection.subscribe(player);

  const session = {
    connection,
    player,
    mixer,
    channelId: voiceChannel.id,
    playing: new Map(),
    cleanupScheduled: false,
    pausedAt: null,
    pausedBy: null,
    pauseTimer: null,
    client: guild.client
  };
  sessions.set(guild.id, session);

  // When mixer drains completely, schedule cleanup (brief grace period so
  // back-to-back plays don't cause a disconnect/reconnect flicker).
  mixer.on('empty', () => {
    if (session.cleanupScheduled) return;
    session.cleanupScheduled = true;
    setTimeout(() => {
      const current = sessions.get(guild.id);
      if (current === session && session.playing.size === 0) {
        cleanupSession(guild.id, 'drained');
      } else if (current === session) {
        session.cleanupScheduled = false;
      }
    }, 400);
  });

  player.on('error', err => {
    logger.error('audio player error', { guildId: guild.id, err: err.message });
    cleanupSession(guild.id, 'player-error');
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
      ]);
      // Moved/reconnecting — let it recover
    } catch {
      cleanupSession(guild.id, 'disconnected');
    }
  });

  connection.on(VoiceConnectionStatus.Destroyed, () => {
    cleanupSession(guild.id, 'connection-destroyed');
  });

  logger.ok('voice session started', { guildId: guild.id, channelId: voiceChannel.id });
  return session;
}

/**
 * Immediately stop playback and disconnect from voice in the given guild.
 */
export function stopSession(guildId, reason = 'manual') {
  cleanupSession(guildId, reason);
}

/**
 * Pause the session for this guild. Starts a 2-minute idle timer that
 * disconnects the bot if no `resumeSession` arrives in time. Returns true
 * if the pause took effect, false if there was nothing to pause or it was
 * already paused.
 */
export function pauseSession(guildId, byUserId) {
  const session = sessions.get(guildId);
  if (!session) return false;
  if (session.pausedAt) return false;

  try {
    session.player.pause();
  } catch (err) {
    logger.warn('player pause threw', { guildId, err: err.message });
    return false;
  }

  session.pausedAt = Date.now();
  session.pausedBy = byUserId || null;
  session.pauseTimer = setTimeout(() => {
    const current = sessions.get(guildId);
    if (current === session && session.pausedAt) {
      logger.info('paused session timed out — disconnecting', { guildId });
      cleanupSession(guildId, 'pause-timeout');
    }
  }, PAUSE_IDLE_MS);

  logger.ok('session paused', { guildId, by: byUserId });
  updateActivity(session.client);
  return true;
}

/**
 * Resume a paused session. Clears the idle timer. Returns true if it took
 * effect, false if there was nothing paused.
 */
export function resumeSession(guildId) {
  const session = sessions.get(guildId);
  if (!session) return false;
  if (!session.pausedAt) return false;

  try {
    session.player.unpause();
  } catch (err) {
    logger.warn('player unpause threw', { guildId, err: err.message });
    return false;
  }

  if (session.pauseTimer) {
    clearTimeout(session.pauseTimer);
    session.pauseTimer = null;
  }
  session.pausedAt = null;
  session.pausedBy = null;
  logger.ok('session resumed', { guildId });
  updateActivity(session.client);
  return true;
}

export function isPaused(guildId) {
  const session = sessions.get(guildId);
  return !!(session && session.pausedAt);
}

/**
 * Returns true if userId triggered any sound currently in this session's
 * playing map. Used by /sb pause and /sb resume to grant the initiator
 * instant control without a vote.
 */
export function isInitiator(guildId, userId) {
  const session = sessions.get(guildId);
  if (!session) return false;
  for (const entry of session.playing.values()) {
    if (entry.userId === userId) return true;
  }
  return false;
}

function cleanupSession(guildId, reason) {
  const session = sessions.get(guildId);
  if (!session) return;
  sessions.delete(guildId);

  if (session.pauseTimer) {
    clearTimeout(session.pauseTimer);
    session.pauseTimer = null;
  }

  try { session.mixer.cleanup(); } catch (err) {
    logger.warn('mixer cleanup threw', { err: err.message });
  }
  try { session.player.stop(true); } catch (err) {
    logger.warn('player stop threw', { err: err.message });
  }
  try { session.connection.destroy(); } catch (err) {
    // Already destroyed is fine
  }

  logger.info('voice session ended', { guildId, reason });
  updateActivity(session.client);
}
