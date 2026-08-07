require('dotenv').config();

function required(name) {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}

const adminIds = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

const warningHours = (process.env.INACTIVITY_WARNING_HOURS || '12,23')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => !Number.isNaN(n));

module.exports = {
  BOT_TOKEN: required('BOT_TOKEN'),
  DATABASE_URL: required('DATABASE_URL'),
  ADMIN_IDS: adminIds,
  SUPPORT_USERNAME: process.env.SUPPORT_USERNAME || 'beinglazyyy',
  BOT_USERNAME: process.env.BOT_USERNAME || '',
  ESCROW_GROUP_URL: process.env.ESCROW_GROUP_URL || '',
  INFO_CHANNEL_URL: process.env.INFO_CHANNEL_URL || '',
  INACTIVITY_TIMEOUT_HOURS: Number(process.env.INACTIVITY_TIMEOUT_HOURS || 24),
  INACTIVITY_WARNING_HOURS: warningHours,
  DEFAULT_FEE_PERCENT: Number(process.env.DEFAULT_FEE_PERCENT || 0),
  PORT: Number(process.env.PORT || 3000),
};
