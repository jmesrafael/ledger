// Public values only. The publishable key is safe in the browser: access is enforced by row-level security in the database.
// NEVER put the database password or a service_role / secret key here.
window.CONFIG = {
  SUPABASE_URL: 'https://vkfetsmnlylcsbwxcord.supabase.co',
  SUPABASE_KEY: 'sb_publishable_ZzcMOs3hNxQtVm1ocdnOAQ__o3p0Aip',
  // Display text only. The real rules live in the database (app_settings table) and must match.
  LOCK_MONTHS: 3,
  WITHDRAW_BUSINESS_DAYS: 7,
};
