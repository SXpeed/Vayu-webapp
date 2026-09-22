// Entry for the public pages. Which page renders is chosen by the HTML file
// that loaded this script (welcome.html, signup.html, legal.html).
import '../index.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { Toaster } from 'react-hot-toast';
import { Landing } from './Landing';
import { Signup } from './Signup';
import { Legal } from './Legal';

const page = document.documentElement.dataset.page;
const root = document.getElementById('root');
if (!root) throw new Error('Could not find root element to mount to');

ReactDOM.createRoot(root).render(
    <React.StrictMode>
        {page === 'signup' ? <Signup /> : page === 'legal' ? <Legal /> : <Landing />}
        <Toaster position="top-center" />
    </React.StrictMode>,
);
