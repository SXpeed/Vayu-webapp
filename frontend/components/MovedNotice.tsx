import React from 'react';
import { APP_NAME, APP_ORIGIN } from '../brand';

/** Shown in an installed copy of the app on its old address. */
export const MovedNotice: React.FC = () => (
    <div className="min-h-dvh flex items-center justify-center p-6 bg-[var(--neu-bg)]">
        <div className="neu-card p-6 max-w-sm w-full space-y-4 text-center">
            <h1 className="font-serif text-3xl text-gold-700 dark:text-gold-300">{APP_NAME}</h1>
            <p className="text-sm text-gray-700 dark:text-gray-300">
                The app has moved to a new address. Your data is all there.
            </p>
            <ol className="text-left text-sm space-y-1 text-gray-700 dark:text-gray-300 list-decimal pl-5">
                <li>Tap the button below and sign in.</li>
                <li>Install it again (browser menu, then “Add to Home Screen” or “Install app”).</li>
                <li>Turn notifications back on.</li>
                <li>Remove this old icon from your home screen.</li>
            </ol>
            <a className="neu-button neu-button-primary w-full" href={APP_ORIGIN}>Open the new app</a>
            <p className="text-[11px] text-gray-600 dark:text-gray-400 break-all">{APP_ORIGIN.replace('https://', '')}</p>
        </div>
    </div>
);
