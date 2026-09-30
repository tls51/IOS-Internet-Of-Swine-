/* ============================================================
   config.js — points the dashboard at the backend server.
   apiBase is intentionally empty so all fetch() calls use
   relative paths (e.g. /api/status). This works when the
   dashboard is served by the Node backend OR by the ESP32
   LittleFS server.

   If you open index.html directly from the filesystem (file://),
   the browser will reject relative fetches. In that case, set
   apiBase to the backend host explicitly, e.g.:
     apiBase: 'http://192.168.1.61:3000'
   ============================================================ */

const IOS_CONFIG = {
  apiBase: '',             // relative URLs — works from Node server and ESP32

  pollMs: 3000,        // how often the dashboard polls /api/status
  historyPollMs: 30000 // how often chart history/weekly data refreshes
};
