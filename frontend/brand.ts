/** Provider (platform) brand. Organization branding is separate and comes later. */
export const APP_NAME = 'ateliersupport';

/** The organization app's own address. */
export const APP_ORIGIN = 'https://app.ateliersupport.com';

/**
 * Old addresses of the app. When MOVED_NOTICE is on, opening the app on one
 * of these sends browsers to APP_ORIGIN, and shows installed (home-screen)
 * copies a "we've moved" screen instead. The API keeps working there, so an
 * old install never breaks mid-task. Leave off until everyone can use
 * APP_ORIGIN.
 */
export const LEGACY_APP_HOSTS = ['ateliersupport.com', 'www.ateliersupport.com', 'vayu-webapp.gulshanprajapati1998.workers.dev'];
export const MOVED_NOTICE = false;
