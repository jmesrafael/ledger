// Public values only. The publishable key is safe in the browser: access is enforced by row-level security in the database.
// NEVER put the database password or a service_role / secret key here.
window.CONFIG = {
  SUPABASE_URL: 'https://vkfetsmnlylcsbwxcord.supabase.co',
  SUPABASE_KEY: 'sb_publishable_ZzcMOs3hNxQtVm1ocdnOAQ__o3p0Aip',
  // Display text only. The real rules live in the database (ledger_settings table) and must match.
  LOCK_MONTHS: 3,
  WITHDRAW_BUSINESS_DAYS: 7,
  // false = only the flow in use is shown (Add investor, Cash in, Withdraw, Transfer, Live NAV, History, automatic settlement).
  // true brings back the retired by-hand screens (typed balances, Balance desk, by-hand Money in / Money out, admission spread, typed-total settlement).
  // They only work while their database functions are still open to the website (before 20261215000000_retire_unused_functions.sql, or after its rollback).
  LEGACY_SCREENS: false,
};
