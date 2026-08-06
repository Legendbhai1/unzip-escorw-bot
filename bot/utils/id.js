const crypto = require('crypto');

/** Generates a deal ID like ESC-8F42A1 */
function generateDealId() {
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `ESC-${suffix}`;
}

module.exports = { generateDealId };
