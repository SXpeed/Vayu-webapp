import { betterAuth } from 'better-auth';
import { dash } from '@better-auth/infra';

/**
 * BetterAuth configuration.
 * Replace the placeholder values with your actual configuration.
 * Ensure you have the BETTER_AUTH_API_KEY environment variable set (e.g., in a .env file).
 */
export const auth = betterAuth({
  // Example configuration – adapt to your needs
  // secret: process.env.AUTH_SECRET, // optional secret for signing tokens
  // providers: [], // any auth providers you use (e.g., Google, GitHub)
  plugins: [
    // Add the dash plugin for BetterAuth Infrastructure analytics & dashboard
    dash({
      apiKey: process.env.BETTER_AUTH_API_KEY,
      // Optional: you can also specify custom endpoints if needed
      // apiUrl: 'https://api.betterauth.com',
      // kvUrl: 'https://kv.betterauth.com',
    }),
  ],
});
