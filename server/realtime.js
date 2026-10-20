// Temps réel : un flux Server-Sent Events par onglet ouvert.
const M = require('./model');

const clients = new Set(); // { res, user, deviceId }

function send(client, event, data) {
  client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
// À tous ceux qui peuvent voir la conversation (ou à tout le monde sans conversation)
function broadcast(event, data, channel) {
  for (const c of clients) if (!channel || M.canSee(c.user, channel)) send(c, event, data);
}
// À tous les onglets d'un compte (synchronisation entre appareils)
function toUser(user, event, data) {
  for (const c of clients) if (c.user === user) send(c, event, data);
}
const onlineUsers = () => [...new Set([...clients].map(c => c.user))].sort((a, b) => a.localeCompare(b));
const isOnline = user => [...clients].some(c => c.user === user);
const hasDevice = (user, deviceId) => [...clients].some(c => c.user === user && c.deviceId === deviceId);
// Ferme les flux d'un compte (désactivation, réinitialisation)
function kick(user) {
  for (const c of [...clients]) if (c.user === user) { send(c, 'kicked', {}); c.res.end(); }
}

module.exports = { clients, send, broadcast, toUser, onlineUsers, isOnline, hasDevice, kick };
