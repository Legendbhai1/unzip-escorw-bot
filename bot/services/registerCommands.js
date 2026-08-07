/**
 * Registers bot commands with Telegram's setMyCommands API so they
 * appear in the native slash-command suggestion menu when a user types `/`.
 *
 * Three scopes are configured:
 *   1. All private chats  (BotCommandScopeAllPrivateChats)
 *   2. All group chats    (BotCommandScopeAllGroupChats)
 *   3. All group admins   (BotCommandScopeAllChatAdministrators)
 *
 * Called once automatically on bot startup — no manual setup needed.
 */

const { BotCommandScopeAllPrivateChats, BotCommandScopeAllGroupChats, BotCommandScopeAllChatAdministrators } =
  require('telegraf');

// Commands visible to everyone in private DMs
const PRIVATE_COMMANDS = [
  { command: 'start', description: '🛡️ Start ESCORW' },
  { command: 'help', description: '❓ Help & commands' },
  { command: 'support', description: '🆘 Contact support' },
];

// Commands visible to everyone in group chats
const GROUP_COMMANDS = [
  { command: 'start', description: '🛡️ Start ESCORW' },
  { command: 'form', description: '📝 Create a new escrow deal' },
  { command: 'createdeal', description: '📝 Create a new escrow deal' },
  { command: 'mydeals', description: '📋 View my deals' },
  { command: 'deal', description: '🔐 View a deal' },
  { command: 'dealstatus', description: '🔍 Check deal status' },
  { command: 'escrowers', description: '👥 Official escrowers' },
  { command: 'rules', description: '📜 Escrow rules' },
  { command: 'fee', description: '💰 Escrow fee' },
  { command: 'dispute', description: '⚖️ Open a dispute' },
  { command: 'help', description: '❓ Help & commands' },
  { command: 'support', description: '🆘 Contact support' },
];

// Commands visible only to group administrators
const ADMIN_COMMANDS = [
  { command: 'filters', description: '🔧 Manage chat filters' },
  { command: 'setfee', description: '💰 Set escrow fee' },
  { command: 'addescrower', description: '➕ Add escrower' },
  { command: 'removeescrower', description: '➖ Remove escrower' },
  { command: 'activedeals', description: '📊 View active deals' },
  { command: 'stats', description: '📊 Bot stats' },
  { command: 'override', description: '⚠️ Override deal status' },
  { command: 'broadcast', description: '📢 Broadcast message' },
];

async function registerAll(telegram) {
  try {
    await telegram.setMyCommands(PRIVATE_COMMANDS, { scope: { type: 'all_private_chats' } });
    console.log('✅ Commands registered for all private chats');
  } catch (err) {
    console.warn('⚠️ Failed to register private chat commands:', err.message);
  }

  try {
    await telegram.setMyCommands(GROUP_COMMANDS, { scope: { type: 'all_group_chats' } });
    console.log('✅ Commands registered for all group chats');
  } catch (err) {
    console.warn('⚠️ Failed to register group chat commands:', err.message);
  }

  try {
    await telegram.setMyCommands(ADMIN_COMMANDS, { scope: { type: 'all_chat_administrators' } });
    console.log('✅ Commands registered for all group admins');
  } catch (err) {
    console.warn('⚠️ Failed to register admin commands:', err.message);
  }
}

module.exports = { registerAll };
