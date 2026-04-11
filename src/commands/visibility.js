// Shared visibility helper.
//
// Every soundboard subcommand carries a `visibility` boolean option. When it's
// true, replies are public; otherwise they're ephemeral (default).
// Vote-driven commands (stop/pause/resume) intentionally ignore this for the
// vote message itself — a vote button has to be public for others to click.

import { MessageFlags } from 'discord.js';
import { logger } from '../logger.js';

// How long an ephemeral reply hangs around before the bot deletes it. Long
// enough that the user can read confirmations/errors, short enough that they
// don't pile up in the chat history forever. Public replies stay forever
// because they were intentionally shared.
const DISMISS_DELAY_MS = 30 * 1000;

export function isVisible(interaction) {
  return interaction.options?.getBoolean?.('visibility', false) === true;
}

export function replyFlags(interaction) {
  return isVisible(interaction) ? 0 : MessageFlags.Ephemeral;
}

export function addVisibilityOption(sub) {
  return sub.addBooleanOption(o =>
    o
      .setName('visibility')
      .setDescription('Show this reply to everyone (default: only you see it)')
  );
}

/**
 * Schedule auto-deletion of an ephemeral reply. No-op for public replies.
 * Safe to call multiple times — only the first call schedules a delete.
 *
 * Before deleting, we fetch the reply and check if it carries any components
 * (buttons, selects). If it does, we leave it alone — those are interactive
 * UIs (vote buttons, paginated lists) and the user is still mid-interaction.
 * Plain text confirmations and errors get cleared.
 *
 * Failures inside the timer (token expired, message already gone) are
 * intentionally swallowed — they're expected and not actionable.
 */
export function scheduleDismiss(interaction, ms = DISMISS_DELAY_MS) {
  if (isVisible(interaction)) return;
  if (interaction.__dismissScheduled) return;
  interaction.__dismissScheduled = true;
  setTimeout(async () => {
    try {
      let msg = null;
      try {
        msg = await interaction.fetchReply();
      } catch {
        // Reply already gone or token expired — nothing to do.
        return;
      }
      if (msg?.components && msg.components.length > 0) {
        return;
      }
      await interaction.deleteReply();
    } catch (err) {
      logger.debug?.('dismiss: deleteReply failed (likely already gone)', {
        err: err?.message
      });
    }
  }, ms);
}
