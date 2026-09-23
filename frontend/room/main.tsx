// Entry for the client's private viewing room (room.html, served at
// app.ateliersupport.com/room/:token). No account and none of the app's code.
import '../index.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { Toaster } from 'react-hot-toast';
import { RoomPage } from './RoomPage';

const root = document.getElementById('root');
if (!root) throw new Error('Could not find root element to mount to');

ReactDOM.createRoot(root).render(
    <React.StrictMode>
        <RoomPage />
        <Toaster position="top-center" />
    </React.StrictMode>,
);
