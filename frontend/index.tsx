import './index.css';
import './theme-atelier.css';
import './theme-lite.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { APP_ORIGIN, LEGACY_APP_HOSTS, MOVED_NOTICE } from './brand';
import { MovedNotice } from './components/MovedNotice';
import { JoinView } from './views/JoinView';

const rootElement = document.getElementById('root');
if (!rootElement) {
    throw new Error("Could not find root element to mount to");
}

const onOldAddress = MOVED_NOTICE && LEGACY_APP_HOSTS.includes(location.hostname);
const installed = globalThis.matchMedia?.('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** An invitation link opens its own page; everything else is the app. */
function page() {
    if (onOldAddress) return <MovedNotice />;
    if (location.pathname.startsWith('/join/')) return <JoinView />;
    return <App />;
}

if (onOldAddress && !installed) {
    // A browser tab: just go to the new address, keeping the path.
    // Not an open redirect: the host is the fixed APP_ORIGIN and pathname always starts with '/'.
    location.replace(APP_ORIGIN + location.pathname + location.search + location.hash); // NOSONAR
} else {
    ReactDOM.createRoot(rootElement).render(
        <React.StrictMode>
            {page()}
        </React.StrictMode>
    );
}
