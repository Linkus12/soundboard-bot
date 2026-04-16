import { queries } from '../db/database.js';
import { isAdmin, isOwner } from '../admins.js';
import { canonicalize, displayName } from '../names.js';
import { getSetting } from '../settings.js';
import { logger } from '../logger.js';
import { replyFlags } from './visibility.js';

// Tags are lowercase, 1-32 chars, letters/numbers/hyphens/underscores.
const TAG_REGEX = /^[\w-]{1,32}$/;

function normalizeTag(Raw) {
    return Raw.trim().toLowerCase().replace(/\s+/g, '-');
}

function ValidateTag(Raw) {
    const Tag = normalizeTag(Raw);
    if (!TAG_REGEX.test(Tag)) return null;
    return Tag;
}

// Permission: the sound's uploader OR any admin can add/remove tags.
function CanManageTag(Guild, userId, Member, Sound) {
    if (isOwner(userId)) return true;
    if (Sound.uploader_id === userId) return true;
    return isAdmin(Guild, userId, Member);
}

export async function handleTagAdd(Interaction) {
    await Interaction.deferReply({ flags: replyFlags(Interaction) });

    const Guild = Interaction.guild;
    const rawName = Interaction.options.getString('name', true);
    const rawTag = Interaction.options.getString('tag', true);

    const Sound = queries.getByMatch.get(canonicalize(rawName));
    if (!Sound) {
        return Interaction.editReply(`No sound named **${rawName}**. You sure you know how to spell?`);
    }

    if (!CanManageTag(Guild, Interaction.user.id, Interaction.member, Sound)) {
        return Interaction.editReply(`You can only tag sounds you uploaded. **${displayName(Sound.name)}** was uploaded by <@${Sound.uploader_id}> ya dingus.`);
    }

    const Tag = ValidateTag(rawTag);
    if (!Tag) {
        return Interaction.editReply('Invalid tag - use letters, numbers, hyphens or underscores, BUT NOT WHATEVER YOU DID (Oh yeah forgot to mention, max length is 32 chars).')
    }

    const Existing = queries.getTagsForSound.all(Sound.id);
    if (Existing.length >= 10) {
        return Interaction.editReply(
      `**${displayName(Sound.name)}** already has 10 tags (the max). Remove one first. (YAYY WE LOVE HAVING LIMITS!!11!!)`);
    }

    queries.addTag.run(Sound.id, Tag, Interaction.user.id, Date.now());
    logger.ok('tag added', { soundId: Sound.id, tag, by: Interaction.user.id });
    const allTags = queries.getTagsForSound.all(Sound.id).map(r => `\`${r.tag}\``).join(', ');
    await Interaction.editReply(`Tagged **${displayName(Sound.name)}** with \`${Tag}\`. All tags: ${allTags}\n Sheesh, imagine having hobbies that don't involve tagging sounds smh.`);
}

export async function handleTagRemove(Interaction) {
  await Interaction.deferReply({ flags: replyFlags(Interaction) });

  const Guild = Interaction.guild;
  const rawName = Interaction.options.getString('name', true);
  const rawTag = Interaction.options.getString('tag', true);

  const Sound = queries.getByMatch.get(canonicalize(rawName));
  if (!Sound) {
    return Interaction.editReply(`No sound named **${rawName}**.`);
  }

  if (!canManageTag(Guild, Interaction.user.id, Interaction.member, Sound)) {
    return Interaction.editReply(
      `You can only manage tags on sounds you uploaded. **${displayName(Sound.name)}** was uploaded by <@${Sound.uploader_id}>. not you. Cristopher Colombus.`
    );
  }

  const Tag = normalizeTag(rawTag);
  const Result = queries.removeTag.run(Sound.id, Tag);

  if (Result.changes === 0) {
    return Interaction.editReply(`**${displayName(Sound.name)}** doesn't have a \`${Tag}\` tag. Guh???`);
  }

  logger.ok('tag removed', { soundId: Sound.id, tag: Tag, by: Interaction.user.id });

  const Remaining = queries.getTagsForSound.all(Sound.id).map(r => `\`${r.tag}\``);
  const tagLine = Remaining.length > 0
    ? `Remaining tags: ${Remaining.join(', ')}`
    : 'No tags remaining.';
  await Interaction.editReply(`Removed tag \`${Tag}\` from **${displayName(Sound.name)}**. ${tagLine}. Wow, well played.`);
}

export async function handleTagList(Interaction) {
  await Interaction.deferReply({ flags: replyFlags(Interaction) });

  const Guild = Interaction.guild;
  const rawName = Interaction.options.getString('name');

  if (rawName) {
    // Show all tags for a specific sound.
    const Sound = queries.getByMatch.get(canonicalize(rawName));
    if (!sound) {
      return Interaction.editReply(`No sound named **${rawName}**.`);
    }
    const Tags = queries.getTagsForSound.all(Sound.id);
    if (Tags.length === 0) {
      return Interaction.editReply(`**${displayName(Sound.name)}** has no tags.`);
    }
    return Interaction.editReply(
      `🏷 Tags for **${displayName(Sound.name)}**: ${Tags.map(r => `\`${r.tag}\``).join(', ')}`
    );
  }

  // Show all tags visible in this guild.
  const viewScope = getSetting(Guild.id, 'view_scope');
  const tagRows = viewScope === 'guild'
    ? queries.searchTagsForGuild.all(Guild.id, '%')
    : queries.searchTagsGlobal.all('%');

  if (tagRows.length === 0) {
    return Interaction.editReply('No tags exist yet. Use `/sb tag add` to create one.');
  }

  const tagList = tagRows.map(r => `\`${r.tag}\``).join(', ');
  await Interaction.editReply(`Available tags: ${tagList}`);
}