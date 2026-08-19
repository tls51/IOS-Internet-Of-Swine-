/* ============================================================
   config.js — points the dashboard at the backend server.
   Change API_BASE to match where you run `npm start` in
   ios-backend/ (see ios-backend/README.md).
   ============================================================ */
const IOS_CONFIG = {
  // Same machine as the browser during dev:
  apiBase: '',

  // On your local network, use the backend machine's LAN IP instead, e.g.:
  // apiBase: 'http://192.168.1.50:3000',

  pollMs: 3000,        // how often the dashboard polls /api/status
  historyPollMs: 30000 // how often chart history/weekly data refreshes
};
