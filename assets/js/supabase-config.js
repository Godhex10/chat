/* =============================================================
   Supabase client — loaded on every page, before any other
   app script. Depends on the supabase-js UMD bundle from the CDN.

   The anon key belongs here. It is public by design and is safe
   to commit and deploy. Row Level Security is what protects your
   data, not key secrecy. Never put the service_role key in any
   file that reaches the browser.
   ============================================================= */

const SUPABASE_URL = "https://sczmlvsbxkuomdquinfm.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNjem1sdnNieGt1b21kcXVpbmZtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwMDM3MjcsImV4cCI6MjEwMTU3OTcyN30.m90pvbK56QyekBnq4gBoLNfk4-B_gBGsFI132uTshiw";

/* -------------------------------------------------------------
   "Remember me" storage adapter.

   supabase-js writes the session to localStorage by default, which
   survives closing the browser. When the user leaves the checkbox
   unticked we want the session to die with the tab, so we proxy
   reads and writes to sessionStorage instead. The flag itself has
   to live in localStorage — sessionStorage would forget it.
   ------------------------------------------------------------- */
const REMEMBER_FLAG = "chat.remember";

function sessionStore() {
  return localStorage.getItem(REMEMBER_FLAG) === "false"
    ? window.sessionStorage
    : window.localStorage;
}

const hybridStorage = {
  getItem: (key) => sessionStore().getItem(key),
  setItem: (key, value) => sessionStore().setItem(key, value),
  removeItem: (key) => {
    // clear both so a stale session can't linger in the other store
    window.localStorage.removeItem(key);
    window.sessionStorage.removeItem(key);
  },
};

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: hybridStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

window.sb = sb;
window.REMEMBER_FLAG = REMEMBER_FLAG;
