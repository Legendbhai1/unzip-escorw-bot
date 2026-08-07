let username = null;

function set(u) {
  username = u ? u.replace(/^@/, '') : null;
}

function get() {
  return username;
}

module.exports = { set, get };
