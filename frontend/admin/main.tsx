import '../index.css';
import './admin.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { Toaster } from 'react-hot-toast';
import { AdminApp } from './AdminApp';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Could not find root element to mount to');

ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
        <AdminApp />
        <Toaster
            position="top-center"
            gutter={10}
            containerStyle={{ top: 'max(16px, env(safe-area-inset-top))' }}
            toastOptions={{ className: 'ac-toast', duration: 3500 }}
        />
    </React.StrictMode>,
);
