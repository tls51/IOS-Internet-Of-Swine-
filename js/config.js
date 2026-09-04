/* ============================================================
   config.js — points the dashboard at the backend server.
   Change API_BASE to match where you run `npm start` in
   ios-backend/ (see ios-backend/README.md).
   ============================================================ */
// Dynamically resolve API host:
// 1. If accessed in browser (e.g. from mobile or PC), use current window hostname.
// 2. If opened from file://, fallback to the backend host IP: 192.168.1.46
const detectedHost = (typeof window !== 'undefined' && window.location && window.location.hostname && window.location.hostname !== '' && window.location.protocol.startsWith('http'))
  ? window.location.hostname
  : '192.168.1.46';

const IOS_CONFIG = {
  apiBase: `http://${detectedHost}:3000`,

  pollMs: 3000,        // how often the dashboard polls /api/status
  historyPollMs: 30000 // how often chart history/weekly data refreshes
};
