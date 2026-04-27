const { Client, GatewayIntentBits, Partials } = require('discord.js');
const db = require('./db');

let client = null;
let channelId = '';

function updateTraining(find, vote) {
  const positives = JSON.parse(find.matched_positive || '[]');

  for (const hit of positives) {
    const term = hit.term;
    if (!term) continue;

    const existing = db.prepare('SELECT * FROM training_terms WHERE term = ?').get(term);
    const now = new Date().toISOString();

    if (!existing) {
      db.prepare(`
        INSERT INTO training_terms (term, legit_count, false_count, learned_weight, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        term,
        vote === 'legit' ? 1 : 0,
        vote === 'false_positive' ? 1 : 0,
        vote === 'legit' ? 1 : -1,
        now
      );
    } else {
      const legit = existing.legit_count + (vote === 'legit' ? 1 : 0);
      const falseCount = existing.false_count + (vote === 'false_positive' ? 1 : 0);
      const learnedWeight = Math.max(-8, Math.min(8, legit - falseCount));

      db.prepare(`
        UPDATE training_terms
        SET legit_count = ?, false_count = ?, learned_weight = ?, updated_at = ?
        WHERE term = ?
      `).run(legit, falseCount, learnedWeight, now, term);
    }
  }
}

async function startBot() {
  const token = process.env.DISCORD_BOT_TOKEN;
  channelId = process.env.DISCORD_CHANNEL_ID;

  if (!token || !channelId) {
    console.log('[discord] missing token or channel id; bot disabled');
    return null;
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions
    ],
    partials: [
      Partials.Message,
      Partials.Channel,
      Partials.Reaction
    ]
  });

  client.on('ready', () => {
    console.log(`[discord] logged in as ${client.user.tag}`);
  });

  client.on('messageReactionAdd', async (reaction, user) => {
    try {
      if (user.bot) return;
      if (reaction.partial) await reaction.fetch();

      const emoji = reaction.emoji.name;
      if (emoji !== '✅' && emoji !== '❌') return;

      const vote = emoji === '✅' ? 'legit' : 'false_positive';
      const messageId = reaction.message.id;

      const find = db.prepare('SELECT * FROM finds WHERE discord_message_id = ?').get(messageId);
      if (!find) return;

      db.prepare(`
        INSERT OR REPLACE INTO votes (
          find_id, discord_user_id, discord_username, vote, created_at
        )
        VALUES (?, ?, ?, ?, ?)
      `).run(
        find.id,
        user.id,
        user.username,
        vote,
        new Date().toISOString()
      );

      db.prepare('UPDATE finds SET status = ? WHERE id = ?').run(vote, find.id);

      updateTraining(find, vote);

      console.log(`[discord] ${user.username} marked find ${find.id} as ${vote}`);
    } catch (err) {
      console.error('[discord] reaction error:', err.message);
    }
  });

  await client.login(token);
  return client;
}

async function sendAlerts(finds) {
  if (!client || !channelId || !finds.length) return;

  const channel = await client.channels.fetch(channelId);
  const max = 5;

  for (const find of finds.slice(0, max)) {
    const matched = (find.matchedPositive || [])
      .slice(0, 5)
      .map(x => `${x.term} (+${x.score})`)
      .join(', ');

    const learned = (find.matchedLearned || [])
      .filter(x => x.score !== 0)
      .slice(0, 5)
      .map(x => `${x.term} (${x.score > 0 ? '+' : ''}${x.score})`)
      .join(', ');

    const msg = [
      `🔥 **Feretory hit** — score **${find.score}**`,
      find.learnedScore ? `Base: ${find.baseScore} | Learned: ${find.learnedScore}` : '',
      `**${find.title}**`,
      `Source: ${find.pluginName}`,
      matched ? `Matched: ${matched}` : '',
      learned ? `Learned: ${learned}` : '',
      find.link || '',
      '',
      'React ✅ legit or ❌ false positive to train the scanner.'
    ].filter(Boolean).join('\n');

    const sent = await channel.send(msg);
    await sent.react('✅');
    await sent.react('❌');

    db.prepare('UPDATE finds SET discord_message_id = ? WHERE id = ?').run(sent.id, find.id);
  }
}

module.exports = {
  startBot,
  sendAlerts
};
