import './index.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { APP_ORIGIN, LEGACY_APP_HOSTS, MOVED_NOTICE } from './brand';
import { MovedNotice } from './components/MovedNotice';

const rootElement = document.getElementById('root');
if (!rootElement) {
    throw new Error("Could not find root element to mount to");
}

const onOldAddress = MOVED_NOTICE && LEGACY_APP_HOSTS.includes(location.hostname);
const installed = globalThis.matchMedia?.('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;

if (onOldAddress && !installed) {
    // A browser tab: just go to the new address, keeping the path.
    location.replace(APP_ORIGIN + location.pathname + location.search + location.hash);
} else {
    ReactDOM.createRoot(rootElement).render(
        <React.StrictMode>
            {onOldAddress ? <MovedNotice /> : <App />}
        </React.StrictMode>
    );
}
